/**
 * OCR 后处理：把识别器的 Word[] 转为 ContentBlock[]。
 *
 * 流程：
 * 1. 把「更小且更偏上/偏下」的词按几何绑到它的基字上（上下标的**判定必须在分桶之前**，
 *    否则上下标与基字的中心 y 天然差一截，必然被拆成两行）；
 * 2. 按 y 坐标聚类为行（容差 5px），绑定了基字的上下标跟着基字入行；
 * 3. 同一纵向区域内的多行构件（跨行大括号 / 堆叠分数）合并为一行，保住阅读顺序；
 * 4. 行内把绑定的上下标包成 `^{...}` / `_{...}`；
 * 5. 按行间距离分割段落（自适应中位数阈值）；
 * 6. 字号启发式标题检测（大于中位数 1.3 倍、文本较短、**且文本本身像标题**
 *    → heading；见 `looksLikeHeading` 上方的说明：字号只能证明「它被排得很大」，
 *    证明不了「它是标题」——扫描件里公式的检测框会把字号抬得很高）。
 */
import type { ContentBlock } from '@/types/content';
import type { OcrChar, OcrWord, OcrPageResult } from '@/lib/ocrTypes';
import { buildOcrStructure, type OcrStructure } from '@/lib/ocrStructure';
import {
  detectColumns,
  furnitureRegionOfLine,
  readingOrderKeys,
  type LayoutRegion,
} from '@/lib/layoutAnalysis';
import {
  classifyCharsByGeometry,
  getAttachedChars,
  groupScriptFragments,
  type CharScript,
} from '@/lib/ocrCharBoxes';

interface OcrLine {
  words: OcrWord[];
  text: string;
  y: number;
  fontSize: number;
  avgConfidence: number;
  /** 该行文本里是否真的包进了几何判定的上下标（供诊断与测试观察） */
  hasScripts?: boolean;
  /**
   * 排序用的桶中心 y。
   *
   * `y` 会被构件合并改成「词框上沿」（见 combineCluster），
   * 而段落切分、行距统计一直用桶中心 y —— 两类行混在一起排序时
   * 必须有同一个口径，否则正文行的先后顺序会漂移。
   * 纯桶行由 `groupWordsIntoLines` 填，合并出来的行不填（沿用 y）。
   */
  sortKey?: number;
  /**
   * 该行被判为页眉/页脚（页面家具）。
   *
   * 为什么不直接把它从行列表里删掉，而是留一个标记：
   * 「这一行为什么没进正文」是排查页眉页脚时最常问的问题，
   * 有标记才能把判断依据一并说清楚（见 `filterHeaderFooter`）。
   */
  isPageFurniture?: boolean;
}

const SAME_LINE_TOLERANCE = 5;
const PARAGRAPH_BREAK_RATIO = 1.2;
/** 段间距的绝对下限（字号倍数）：与字号相比明显拉开的行距就算换段 */
const PARAGRAPH_BREAK_FONT_RATIO = 1.8;
const HEADING_FONT_RATIO = 1.3;
const HEADING_MAX_CHARS = 80;
const HEADER_FOOTER_MARGIN_RATIO = 0.05;
const HEADER_FOOTER_FONT_RATIO = 0.85;
/**
 * 页眉页脚判据（二）：与同侧相邻行的纵向隔离度（按**正文字号**归一）。
 *
 * 实测数据（用户那份习题 PDF 第 1 页，画布高 2223、正文字号 42）：
 *   · 页眉 y=[62,98]、字号 36，与页面上最上面那行正文 y0=212 的空隙 **114px**
 *     = **2.7 倍字号**；
 *   · 页脚 y=2170、字号 42，与正文最低一行 y=1992 的空隙 **178px**
 *     = **4.2 倍字号**。
 * 而正常行距（真实页量到的行距中位数）只有 30–40px。
 * 门槛取 1.4 倍**参考字号**（正文字号与该行自身字号取大者）：
 *   · 页眉 36px 行：门槛 50.4，实测空隙 114px → 判为页面家具；
 *   · 页脚 42px 行：门槛 58.8，实测空隙 178px → 判为页面家具；
 *   · 版面顶部的章节标题（字号 78.7）：门槛 110.2，实测与下一行的空隙
 *     只有 45px（大标题后面本来就留白）→ **不**判为页面家具。
 * 若只按正文字号 42 归一（门槛 58.8），那个 45px 空隙的大标题就会被误删
 * ——「按行自身字号取大者」正是为了挡住这一类误伤。
 */
const FURNITURE_GAP_FONT_RATIO = 1.4;
/** 页眉页脚判据（三）：宽度不到**版心宽度**（页内最宽那行）的这个比例 */
const FURNITURE_COLUMN_WIDTH_RATIO = 0.85;

/**
 * 上下标判定阈值 —— 默认全部取「保守」方向：**不确定就不动**。
 *
 * 误判的代价远大于漏判：把一个正常词塞进 `^{...}`，
 * 用户看到的是「明明不是公式的地方变成了公式」；
 * 而漏判只是维持现状（本来就没处理过几何上下标）。
 */
const SCRIPT_MAX_FONT_RATIO = 0.9;
const SCRIPT_SUPER_SHIFT = 0.25;
const SCRIPT_SUB_SHIFT = 0.18;
/** 判定上下标归属时的最小词数：一两个词时「哪个是正常字」无从谈起 */
const SCRIPT_MIN_LINE_WORDS = 3;
/**
 * 上下标中心与基字中心的纵向距离上限（参考字号倍数），上标/下标分开取。
 *
 * 为什么上标给得更宽：上标天然要抬到基字上沿之上，字号又更小，
 * 中心距离因此比下标大得多。实测数据里 `e`（20px，中心 98）与指数
 * `-(x+y)`（13px，中心 76.5）相差 21.5px —— 若按 0.9 倍（18px）卡，
 * 这个真正的指数会被判成「另一行的小字」而弃掉，上下标功能再次失效。
 * 二者的共同上限都是 1.5 倍参考字号，足以把隔了一行的注脚挡在外面。
 */
const SCRIPT_SUPER_BAND = 1.5;
const SCRIPT_SUB_BAND = 1.2;
/** 归入同一段上下标的相邻词：水平间隙上限（按较小字高归一） */
const SCRIPT_FRAGMENT_GAP = 0.6;
/** 同一个上下标被切成多个词时，兄弟词之间的纵向错位上限（较小字高倍数） */
const SCRIPT_FRAGMENT_DY = 0.5;
/**
 * 孤立成行的上下标候选，文本长度上限（字符）。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么「孤立的上下标」还要有一条长度判据
 * ═══════════════════════════════════════════════════════════════
 *
 * `attachDetachedScriptLines` 是「上下标被拆到另一行」时的最后补救，
 * 它的几何判据本身**极弱**（方向对 + 行间距离 ≤ 0.9 倍参考字号 +
 * 水平间隙 ≤ 0.6 倍较小字高），弱到能把**下一行的正文**整行吸上来：
 *   · 参考字号 40 时上限是 36 —— 而正文行高 36 是常事（实测回归 C 的词 16
 *     正是 36 高），「更小」这道闸对它形同虚设；
 *   · 行间距离 17px ≤ 36px —— 普通行距本来就落在这个范围内；
 *   · 水平间隙算出来是**负数**（225 − 778 = −553），因为两行横向重叠 ——
 *     `负数 > 上限` 恒为假，「水平紧邻」这道闸同样形同虚设。
 * 三条判据全部形同虚设，于是实测里
 * `验证随机变量 Z = √X2 + Y 的概率密度为`（22 字符、框宽 611px）
 * 被当成词 15 的下标挂了上去，**两行正文并成一行**。
 *
 * 真正的上下标是**小片段**：实测合法形态是 `-(x+y)`（6 字符，见文件顶部）、
 * `i`、`2`、`-`。取值 12 与 `looksLikeMathBranch` 的上限同口径 ——
 * 同一个「多长还算片段」的定义不该有两套。
 */
const SCRIPT_MAX_FRAGMENT_CHARS = 12;
/** 跨行构件合并：分支被主机包住时允许的外溢比例 */
const CLUSTER_BRANCH_SLACK = 0.2;
/** 跨行构件合并：分支宽度最多是主机的这个比例（更宽的就不是「分支」） */
const CLUSTER_BRANCH_MAX_WIDTH_RATIO = 0.75;
/**
 * 跨行构件合并：候选横跨主机跨度的比例上限。
 *
 * 超过它就不是「分支」而是**并列的另一行**（见 canMergeAsBranch 的说明）。
 */
const CLUSTER_PEER_COVER_RATIO = 0.85;
/** 跨行构件合并：较小行至少要有多大比例的宽度压在主机跨度上 */
const CLUSTER_CONTAINMENT_RATIO = 0.6;
/** 跨行构件合并（按分支判据 3）：纵向间隙上限（**主机**字高的倍数） */
const CLUSTER_BRANCH_GAP_RATIO = 1.4;
const CLUSTER_MAX_GAP_LINES = 1.5;
/** 主行（含 `=` 或本身词数最多的那行）在合并后应当排在最前 */
const ASSIGNMENT_RE = /[=＝]/;

/**
 * 把 tesseract 的纯文本输出转成内容块。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么必须做这件事
 * ═══════════════════════════════════════════════════════════════
 *
 * 真实故障：10 页 OCR 跑完，报"未能从任何页面中提取出文字"，
 * 但诊断信息里赫然写着 **"纯文本长度合计：7058 字符"**。
 *
 * 也就是说：**tesseract 明明识别出了七千多字，我们却把它丢了** ——
 * 只因为拿不到词级坐标（`data.words` 与 `data.blocks` 都为空）。
 *
 * 这是最不该发生的一类缺陷：把"能用的结果"当成"没有结果"。
 * 坐标的价值是让段落切分更准、便于定位原页；拿不到坐标时，
 * 退化成按换行切分也远好于什么都不给。
 *
 * 因此这里做纯文本兜底：
 * - 空行分段（tesseract 用换行表达段落，用空行表达段间距）
 * - 单行且短、且不像正文的，按启发式判为标题（与纯文本解析器同一套思路）
 * - 合并过短的碎行，避免把一句话拆成多段
 */
export function ocrTextToBlocks(pageText: string): Omit<ContentBlock, 'id'>[] {
  const normalized = pageText.replace(/\r\n?/g, '\n').trim();
  if (!normalized) return [];

  // 先按空行分段；tesseract 对段落间距的表达在不同语言/版式下不一致，
  // 因此若空行分段结果只有一块，退化为按单行分段。
  let chunks = normalized
    .split(/\n\s*\n+/)
    .map((c) => c.replace(/\n/g, ' ').replace(/\s{2,}/g, ' ').trim())
    .filter(Boolean);

  if (chunks.length <= 1) {
    chunks = normalized
      .split('\n')
      .map((l) => l.replace(/\s{2,}/g, ' ').trim())
      .filter(Boolean);
  }

  const merged = mergeShortChunks(chunks);

  return merged.map((text) => ({
    type: looksLikeHeading(text) ? ('heading' as const) : ('paragraph' as const),
    content: text,
    translations: {},
    metadata: {},
  }));
}

/**
 * 合并过短的碎片。
 *
 * tesseract 在拿不到版式信息时，常把一个句子按视觉行拆成多段；
 * 过短的块会让阅读体验碎片化，也会让翻译按碎片送 API 导致语义断裂。
 *
 * 注意：**看起来像标题的块不参与合并**。
 * 标题天然很短（"第一章 计算机系统漫游" 只有 11 字），
 * 若不加这条判断，它会被当作"短碎片"并进正文，章节结构就此丢失
 * —— 这个问题是被单元测试抓出来的。
 */
function mergeShortChunks(chunks: string[], minLength = 20, maxMerged = 400): string[] {
  const out: string[] = [];

  for (const chunk of chunks) {
    const prev = out[out.length - 1];
    const shouldMerge =
      prev !== undefined &&
      !looksLikeHeading(prev) &&
      !looksLikeHeading(chunk) &&
      (prev.length < minLength || chunk.length < minLength) &&
      prev.length + chunk.length <= maxMerged &&
      // 上一块已经以句末标点收尾时不再合并，那更像是真的段落结束
      !/[。！？!?.;；:：]$/.test(prev);

    if (shouldMerge) {
      // 中文之间不加空格，英文之间加空格
      const joiner = /[\u4e00-\u9fff]$/.test(prev) ? '' : ' ';
      out[out.length - 1] = `${prev}${joiner}${chunk}`;
    } else {
      out.push(chunk);
    }
  }

  return out;
}

/**
 * 标题启发式：短、单行、以编号或章节词开头。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么「字号大」不足以判标题（用户实测的第二个故障）
 * ═══════════════════════════════════════════════════════════════
 *
 * 词坐标路径原先的判据是「行字号 > 中位字号 × 1.3 且文本不超过 80 字」。
 * 在扫描版数学材料上这条会稳定误判，因为**识别器给公式区域的检测框又高又怪**：
 * 跨行大括号、分式、堆叠上下标的检测框会把"行字号"抬得很高，
 * 而那一行根本不是被排版放大的标题。
 *
 * 实测（同一页，中位字号 42、门槛 54.6）这三行被判成了标题：
 *   · `Z= 当X>Y 其中λ>0，μ>0是常数.引入随机变量=10, 当X>Y`（字号 78.7）
 *   · `fz(e)= 0 0, 其他`（字号 87.5）
 *   · `P).`（字号 58）
 * 三行的共同点是**文本本身明摆着不是标题**：前两行含数学符号（`=`），
 * 第三行只剩一堆标点。字号只能证明"它被排得很大"，证明不了"它是标题"
 * —— 所以这条判据再要一份**文本证据**。
 *
 * 这条启发式对**两条路径**（纯文本兜底 / 词坐标）同时生效，
 * 口径一致才能保证同一份内容走哪条路都一样。
 *
 * 代价是刻意接受的：没编号、又不以章节词开头的普通大字号行（居中书名等）
 * 会退化成段落。宁可漏判标题（只是少一层视觉层级），
 * 也不能把公式渲染成二级标题（视觉上完全错误，还会污染大纲）。
 */
function looksLikeHeading(text: string): boolean {
  if (text.length > 40) return false;
  if (/[。！？!?]$/.test(text)) return false;

  return (
    /^#{1,6}\s/.test(text) ||
    /^(第[一二三四五六七八九十百千\d]+[章节回卷篇部]|Chapter\s+\d+|序章|后记|尾声)/i.test(text) ||
    /^\d+(\.\d+)*[\s、.]/.test(text) ||
    // 全大写英文短行（书名、章节名常见）
    (/^[A-Z][A-Z\s\d\-:]{3,}$/.test(text) && text.length <= 30)
  );
}

/**
 * 识别结果转内容块。
 *
 * @param onStructure 可选的「导出识别结构」回调（见 `lib/ocrStructure.ts`）。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么把导出挂在回调上，而不是让调用方自己再算一遍
 * ═══════════════════════════════════════════════════════════════
 *
 * 上下标判据此前只在**手工合成的坐标**上验证过，真实扫描件上是否成立
 * 一直无从判断 —— 而那台机器上跑不了浏览器里的推理。
 * 于是需要一个出口，把**这一页真实的词框与成行结果**交给用户复制出来。
 *
 * 关键点：成行结果（`lines`）只有本模块内部知道，而且**必须在上下标
 * 绑定之后、文本拼装之后**才有意义。让调用方在外面重新分组一次，
 * 等于把同一套判据实现两遍 —— 两份一定会漂移，导出的数据也就不可信了。
 * 所以这里在**同一次计算**里顺手把结构交出去。
 *
 * 不传回调时**一个额外对象都不构造**：导出是诊断能力，不该给正常识别
 * 增加任何开销（一页上千个词，多构造一份词表就是实打实的成本）。
 *
 * @param layoutRegions 版面模型给出的区域（见 `lib/layoutAnalysis.ts`）。
 *   **不传 / 传空数组时，本函数的输出与接入前完全一致** —— 这是本方案的
 *   硬性不变量，由 `applyLayoutToLines` 的三条闸门保证。
 *   放在 `onStructure` **之后**：回调在前、可选增强在后，
 *   既有的三参数调用点一个都不用改。
 */
export function ocrResultToBlocks(
  result: OcrPageResult,
  pageHeight?: number,
  onStructure?: (structure: OcrStructure) => void,
  layoutRegions?: readonly LayoutRegion[],
): Omit<ContentBlock, 'id'>[] {
  // 关键兜底：拿不到词级坐标时，用纯文本也要产出内容。
  // 否则就会出现"识别出 7058 字却报告什么都没识别到"这种荒唐结果。
  if (!result.words.length) {
    const fallback = ocrTextToBlocks(result.pageText ?? '');
    if (fallback.length) {
      console.info(
        `[ocrPostProcess] 第 ${result.pageNum} 页无词级坐标，已按纯文本切分为 ${fallback.length} 块` +
          `（${result.pageText?.length ?? 0} 字符）`,
      );
    }
    return fallback;
  }

  const heuristicLines = groupWordsIntoLines(result.words, pageHeight);
  if (!heuristicLines.length) return ocrTextToBlocks(result.pageText ?? '');

  // ── 版面分析（渐进增强）────────────────────────────────────────
  //
  // ⚠️ 这一行是**可选**的：`layoutRegions` 为空（模型没取到 / 推理失败 /
  // 用户设了 VITE_OCR_LAYOUT=0）时 `applyLayoutToLines` 原样返回 `lines`，
  // 下面的每一步都与接入前逐字节相同 —— 版面分析绝不参与「识别是否成功」。
  const lines = applyLayoutToLines(heuristicLines, layoutRegions, pageHeight);

  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    gaps.push(Math.abs((lines[i - 1]?.y ?? 0) - (lines[i]?.y ?? 0)));
  }
  const medianGap = median(gaps) || 0;
  const medianFontSize = median(lines.map((l) => l.fontSize)) || 12;

  const blocks: Omit<ContentBlock, 'id'>[] = [];
  let currentText = '';
  let currentConfSum = 0;
  let currentConfCount = 0;
  let currentFontSize = 0;
  let currentScripts = 0;
  /**
   * 本块**第一行**的原文。
   *
   * 标题是单行的东西，判它必须看这一行，而不是看整块拼出来的文本：
   * 一个块里可能第一行是公式、后面跟着正文，拿整段判就会两头都错。
   */
  let currentFirstText = '';
  let prevY: number | null = null;

  for (const line of lines) {
    const gap = prevY === null ? 0 : Math.abs(prevY - line.y);
    // 段间距阈值：取「中位行距的 1.2 倍」与「字号的 1.8 倍」中**较小**的那个。
    //
    // 两个约束各管一种情况，缺一个都会出错：
    //  · 只看中位行距有个死角 —— **页面只有两行时中位数就是那个间距本身**，
    //    于是 `gap > medianGap * 1.35` 永远不成立，两段相隔很远的正文被并成
    //    一个段落（实测那对相隔 120px 的两行就是这样被并掉的）；
    //  · 只看字号则会在行距很松的版面上把同一段切成许多段。
    // 取较小者既给「与字号相比明显拉开」的两行留了绝对下限，
    // 又不会在密排版面上乱切。
    const breakGap = Math.min(
      Math.max(medianGap, line.fontSize) * PARAGRAPH_BREAK_RATIO,
      line.fontSize * PARAGRAPH_BREAK_FONT_RATIO,
    );
    const endsSentence = currentText && /[。！？!?.;；]$/.test(currentText);

    /**
     * 以「题号」开头的行**一律另起一段**。
     *
     * ═══════════════════════════════════════════════════════════════
     * 为什么必须有这条规则
     * ═══════════════════════════════════════════════════════════════
     *
     * 用户实测：整份习题的题目**全部被并成了一段**，「17. …」「20. …」
     * 「24. …」连成一整块，完全读不了。
     *
     * 原因是纯几何判据在这类版面上不够用：习题集的**题目之间与行之间
     * 间距是一样的**，靠 `gap > breakGap` 区分不出来。
     * 但有个几何之外的强信号一直被浪费了 —— **每一题都以编号开头**。
     *
     * 编号是排版意图的显式声明，比任何间距阈值都可靠：
     * `17.` `20.` `24.` 这种形式在中文教材/习题集里没有歧义
     * （它们不会出现在句子中间，也不像小数那样被误用）。
     *
     * 所以这里补上「结构信号优先于几何信号」这一层 ——
     * 几何判不出来的时候，让文档自身的结构说话。
     */
    const NUMBERED_ITEM_RE = /^\s*\d{1,3}\s*[.、)）]\s*\S/;
    const startsNumberedItem = NUMBERED_ITEM_RE.test(line.text);

    const isNewParagraph =
      !currentText ||
      startsNumberedItem ||
      gap > breakGap ||
      Math.abs(line.fontSize - currentFontSize) > 2 ||
      (endsSentence && gap > line.fontSize * 0.95);

    if (isNewParagraph) {
      if (currentText.trim()) {
        const avgConf = currentConfCount > 0 ? currentConfSum / currentConfCount : 0;
        // ⚠️ 这里用 currentFirstText（**本块第一行**）而不是 currentText：
        // 标题是**单行**的东西，而拼到现在的整段文本可能已经把后面几行
        // 并了进来。拿整段去判就会两头都错。
        const isHeading =
          currentFontSize > medianFontSize * HEADING_FONT_RATIO &&
          currentFirstText.trim().length <= HEADING_MAX_CHARS &&
          looksLikeHeading(currentFirstText);

        blocks.push({
          type: isHeading ? 'heading' : 'paragraph',
          content: currentText.trim(),
          translations: {},
          metadata: {
            pageNumber: result.pageNum,
            ocrConfidence: Math.round(avgConf),
            // 行内公式标记交给渲染层：`BlockRow.tsx` 会据此把 `$...$`
            // 交给 KaTeX（与 Markdown 链路 `remark-math` 的标记语义一致）
            ...(currentScripts > 0 ? { hasInlineMath: true } : {}),
            ...(isHeading ? { level: 2 } : {}),
          },
        });
      }
      currentText = line.text;
      currentFirstText = line.text;
      currentConfSum = line.avgConfidence * line.words.length;
      currentConfCount = line.words.length;
      currentFontSize = line.fontSize;
      currentScripts = line.hasScripts ? 1 : 0;
    } else {
      const joiner = /[\u4e00-\u9fff]$/.test(currentText) ? '' : ' ';
      currentText = `${currentText}${joiner}${line.text}`;
      currentConfSum += line.avgConfidence * line.words.length;
      currentConfCount += line.words.length;
      if (line.hasScripts) currentScripts++;
    }
    prevY = line.y;
  }

  if (currentText.trim()) {
    const avgConf = currentConfCount > 0 ? currentConfSum / currentConfCount : 0;
    const isHeading =
      currentFontSize > medianFontSize * HEADING_FONT_RATIO &&
      currentFirstText.trim().length <= HEADING_MAX_CHARS &&
      looksLikeHeading(currentFirstText);

    blocks.push({
      type: isHeading ? 'heading' : 'paragraph',
      content: currentText.trim(),
      translations: {},
      metadata: {
        pageNumber: result.pageNum,
        ocrConfidence: Math.round(avgConf),
        ...(currentScripts > 0 ? { hasInlineMath: true } : {}),
        ...(isHeading ? { level: 2 } : {}),
      },
    });
  }

  // ── 导出识别结构（只在调用方要的时候才构造）────────────────────
  //
  // 放在最后：`lines` 是真正参与拼装的行（页眉页脚已经滤掉），
  // `blocks` 是最终产物。两者与原始 `words` 一起交出去，
  // 收到的人才能拿真实词框去核对「这一行到底为什么没变成上下标」。
  if (onStructure) {
    const indexOfWord = new Map<OcrWord, number>();
    result.words.forEach((word, i) => indexOfWord.set(word, i));

    onStructure(
      buildOcrStructure({
        pageNum: result.pageNum,
        canvasHeight: pageHeight,
        dominantFontSize: medianFontSize,
        words: result.words,
        // 页面家具已经在 `groupWordsIntoLines` 里摘掉了，因此这里直接用
        // `lines`：导出要如实反映「哪些行真的参与了拼装」
        lines: lines
          // 没有词的「行」在导出里没有意义（它的 wordIndices 会是空的）
          .filter((line) => line.words.length > 0)
          .map((line) => ({
            text: line.text,
            y: line.y,
            fontSize: line.fontSize,
            avgConfidence: line.avgConfidence,
            wordIndices: line.words
              .map((word) => indexOfWord.get(word))
              .filter((i): i is number => i !== undefined),
            hasScripts: line.hasScripts === true,
          })),
        blocks,
        // 把**真实生效的阈值**写进导出：JSON 自己就能说明「按什么标准判的」
        thresholds: {
          scriptMaxFontRatio: SCRIPT_MAX_FONT_RATIO,
          scriptSuperShift: SCRIPT_SUPER_SHIFT,
          scriptSubShift: SCRIPT_SUB_SHIFT,
          scriptFragmentGap: SCRIPT_FRAGMENT_GAP,
          scriptSuperBand: SCRIPT_SUPER_BAND,
          scriptSubBand: SCRIPT_SUB_BAND,
        },
      }),
    );
  }

  return blocks;
}

/**
 * Filter out header/footer lines based on position and font size.
 *
 * Headers/footers typically sit in the top/bottom 5% of the page
 * and use smaller font than body text. Both conditions must be met
 * to avoid stripping legitimate short content near page edges.
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么「字号更小」这一条不够（用户实测的故障）
 * ═══════════════════════════════════════════════════════════════
 *
 * 用户那份扫描版习题 PDF（画布高 2223、正文字号 42）上：
 *   · 页眉「概率论与数理统计习题5」y=[62,98]、字号 **36** ——
 *     门槛是 `42 × 0.85 = 35.7`，**36 > 35.7**，于是它躲过了过滤，
 *     作为正文第一段出现在阅读器里；
 *   · 页脚「单周周一下午2点前交作业」y=2170、字号 **42** —— 与正文同字号，
 *     「更小」这条判据**永远不可能**成立，它一直留在正文末尾。
 *
 * 根因是把「页眉页脚」与「小字号」当成了一回事。正文用 42px 的版面上，
 * 页眉页脚同样是 36–42px —— 在扫描件里这不是异常，而是常态
 * （渲染 DPI 一高，页眉页脚的字面高度就上来了，页脚还常被识别成与正文同高）。
 * 而**小字号从来不是页眉页脚的本质**，本质是「它是页面家具，不属于正文流」：
 *   · 它被排在页边距里（判据一，原有的位置判据）；
 *   · 它与同侧的正文行之间有一道**明显大于行距的空档**（页面家具是孤立的）；
 *   · 它的宽度**明显不到版心宽度**（正文行铺满版心，页眉页脚是居中的一小段）。
 *
 * 后两条是**结构**判据，与字号无关，因此同字号页脚也能被认出来。
 * 三条判据是「或」的关系：小字号仍然照旧单独成立（保住既有行为），
 * 结构判据补上「同字号但孤立且窄」这一大类。
 *
 * ⚠️ 两条防误伤的闸门（都会让判据放弃，宁可漏判）：
 *   · 看起来像标题的行（编号 / 章节词开头、全大写短行）**不当作页面家具** ——
 *     页面顶部/底部完全可能出现真正的标题（实测项目里就有
 *     `第1章 计算机系统漫游` 这类居中大标题）；
 *   · 找不到同侧邻居时（整页只有一行等）不判。
 *
 * ⚠️ 为什么留标记而不是就地删掉：判断依据要能被追问（见 `OcrLine`）。
 */
function filterHeaderFooter(
  lines: OcrLine[],
  pageHeight: number | undefined,
  medianFontSize: number,
): OcrLine[] {
  // 复制成新对象再标记：`OcrLine` 后面会被 `combineCluster` 等复制，
  // 就地改会让「谁被标过」变得难以追踪。
  const marked = lines.map((line) => ({ ...line }));
  if (!pageHeight || pageHeight <= 0 || marked.length < 3) return marked;

  const topThreshold = pageHeight * HEADER_FOOTER_MARGIN_RATIO;
  const bottomThreshold = pageHeight * (1 - HEADER_FOOTER_MARGIN_RATIO);
  const smallFontThreshold = medianFontSize * HEADER_FOOTER_FONT_RATIO;
  const columnWidth = maxLineWidth(marked);

  for (const line of marked) {
    const inMargin = line.y < topThreshold || line.y > bottomThreshold;
    if (!inMargin) continue;

    const smallFont = line.fontSize < smallFontThreshold;
    if (smallFont || isIsolatedFurniture(marked, line, medianFontSize, columnWidth)) {
      line.isPageFurniture = true;
    }
  }

  return marked.filter((line) => line.isPageFurniture !== true);
}

/**
 * 用**版面模型的区域**取代几何启发式：页眉页脚判定 + 阅读顺序。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么这一步是**纯函数**，而且与 `groupWordsIntoLines` 分开
 * ═══════════════════════════════════════════════════════════════
 *
 * 「用区域判页眉页脚」「按栏排阅读顺序」这两件事的全部逻辑都是
 * 「区域 + 行 → 行」的纯计算，**与 ONNX 推理无关**。把它从推理里剥出来，
 * 就能在跑不了推理的机器上用合成区域把边界情况全部钉死
 * （本机正是这种情况：`npx vitest run` 会死在 vite 的 `spawn EPERM`）。
 *
 * ═══════════════════════════════════════════════════════════════
 * 渐进增强：**没有版面信息时，返回的必须与输入逐字节相同**
 * ═══════════════════════════════════════════════════════════════
 *
 * 这是本次接入的硬性不变量。三条闸门保证它：
 *
 *  1. `regions` 为空 / 未定义 → 原样返回（连数组都不重建）；
 *  2. 只有**区域真的判为家具**的行才会被摘掉 —— 摘掉的行数由模型决定，
 *     而不是由本函数的任何阈值决定；
 *  3. **只有 `detectColumns` 确证多栏时**才重排行序。单栏文档一律
 *     保持既有行序 —— 分错栏会把两栏文字交错拼接，比不排更糟，
 *     而单栏排序对单栏文档毫无收益、只会引入差异。
 *
 * 与既有 `filterHeaderFooter` 的关系是**或**：启发式已经摘掉的行不会再回来，
 * 本函数只能**补充**摘掉启发式漏掉的（用户实测那两个页眉页脚正是这种），
 * 因此方向上只会「少留页面家具」，不会「多删正文」。
 *
 * @param lines    已成形的行（`groupWordsIntoLines` 的输出）
 * @param regions  版面模型给出的区域；空数组/undefined 表示不可用
 * @param pageWidth 页面画布宽度（像素），用于判栏
 */
export function applyLayoutToLines(
  lines: OcrLine[],
  regions: readonly LayoutRegion[] | undefined,
  pageWidth: number | undefined,
): OcrLine[] {
  if (!regions?.length || !lines.length) return lines;

  // ── 1. 页眉页脚：由**区域类别**决定，不再看字号与宽度 ──────────
  const kept: OcrLine[] = [];
  const removedByLabel = new Map<string, number>();
  for (const line of lines) {
    const region = furnitureRegionOfLine(line, regions);
    if (region) {
      removedByLabel.set(region.label, (removedByLabel.get(region.label) ?? 0) + 1);
      continue;
    }
    kept.push(line);
  }
  if (removedByLabel.size) {
    console.info(
      `[ocrPostProcess] 版面模型额外判定 ${[...removedByLabel.values()].reduce((a, b) => a + b, 0)}` +
        ` 行为页面家具（启发式漏掉的）：` +
        [...removedByLabel.entries()].map(([label, n]) => `${label}×${n}`).join('、'),
    );
  }

  // ── 2. 阅读顺序：**只有确证多栏**时才重排 ───────────────────────
  const width = pageWidth ?? 0;
  if (!(width > 0)) return kept;

  const columns = detectColumns(regions, width);
  if (!columns) return kept;

  const keys = readingOrderKeys(regions, width);
  const spanOf = (line: OcrLine) => {
    const x0 = Math.min(...line.words.map((w) => w.bbox.x0));
    const x1 = Math.max(...line.words.map((w) => w.bbox.x1));
    const y0 = Math.min(...line.words.map((w) => w.bbox.y0));
    const y1 = Math.max(...line.words.map((w) => w.bbox.y1));
    return { x0, x1, y0, y1 };
  };

  // 行 → 所属区域：取**覆盖该行最多**的区域（按行框面积算覆盖率）。
  // 用行框而不是逐词投票：阅读顺序是「行属于哪一栏」的问题，
  // 一行整体落在哪一栏比它某个词落在哪更稳定。
  const regionOfLine = (line: OcrLine): LayoutRegion | undefined => {
    const span = spanOf(line);
    const area = (span.x1 - span.x0) * (span.y1 - span.y0);
    if (!(area > 0)) return undefined;
    let best: LayoutRegion | undefined;
    let bestCoverage = 0;
    for (const region of regions) {
      const w = Math.min(span.x1, region.x1) - Math.max(span.x0, region.x0);
      const h = Math.min(span.y1, region.y1) - Math.max(span.y0, region.y0);
      if (w <= 0 || h <= 0) continue;
      const coverage = (w * h) / area;
      if (coverage > bestCoverage) {
        bestCoverage = coverage;
        best = region;
      }
    }
    return best;
  };

  // 闸门：**每一行都能定位到区域**时才重排。
  // 有行落在所有区域之外（模型没框住它）就说明这一页的版面结构没被
  // 完整覆盖，此时重排的依据不完整 —— 宁可维持既有顺序。
  const located: { line: OcrLine; key: number[] }[] = [];
  let hasUnlocated = false;
  for (const line of kept) {
    const region = regionOfLine(line);
    const index = region ? regions.indexOf(region) : -1;
    const key = index >= 0 ? keys[index] : undefined;
    // 两个条件缺一不可：区域找不到，或区域找到了但没有排序键
    // （`readingOrderKeys` 与 `regions` 理论上等长，这里只是不信任返回值）。
    if (!key) {
      hasUnlocated = true;
      break;
    }
    located.push({ line, key });
  }

  if (hasUnlocated) {
    // 提前返回：`located` 此时可能只装了一半，绝不能拿去重排 ——
    // 那会把「未被覆盖的行」挤到任意位置上去。
    console.warn(
      '[ocrPostProcess] 有行未被任何版面区域覆盖，本页不重排阅读顺序（保持既有顺序）',
    );
    return kept;
  }

  return located
    .sort((a, b) => a.key[0]! - b.key[0]! || a.key[1]! - b.key[1]! || a.key[2]! - b.key[2]!)
    .map((entry) => entry.line);
}

/**
 * 页眉页脚的**结构**判据：孤立在页边距里、且明显窄于版心。
 *
 * 与字号无关，因此「页脚与正文同字号」（用户实测那一页正是如此）也能认出来。
 *
 * 邻居只跟**同一侧**的行比（上边距的邻居取自己下方、下边距取自己上方）：
 * 页眉与页脚之间本来就隔着整页正文，那个距离没有任何判据价值。
 * 走到这里时页眉页脚已经在前面被摘掉了，因此「隔着整页」这层顾虑
 * 其实已经不存在，但留着这条可以让判据本身自洽、便于单测。
 */
function isIsolatedFurniture(
  allLines: OcrLine[],
  line: OcrLine,
  medianFontSize: number,
  columnWidth: number,
): boolean {
  // 闸门一：像标题的行一律不判 —— 排得大、又带编号/章节词，
  // 那是内容而不是页面家具。
  if (looksLikeHeading(line.words.map((word) => word.text).join(''))) return false;

  // 判据三：正文行铺满版心，页面家具是居中的一小段。
  // 版心宽度取页内最宽的那一行（实测本页 1379px）：
  // 页眉量到 344px（25%）、页脚量到 401px（29%），都远在门槛（1172px）之下。
  const span = horizontalSpanOf(line);
  const width = span.x1 - span.x0;
  if (!(columnWidth > 0) || width >= columnWidth * FURNITURE_COLUMN_WIDTH_RATIO) return false;

  // 判据二：与同侧相邻行的纵向空档。
  // 门槛按**参考字号**算 —— 正文字号与该行自身字号取**大者**：
  //   · 取下限（正文字号）是因为页面家具的字号可能偏小，只用它自己的
  //     字号会把门槛压得太低；
  //   · 取上限（本行字号）是因为大标题后面本来就留白 —— 实测版面上那个
  //     78.7px 的章节标题与下一行只隔 45px，若按正文字号 42 归一
  //     （门槛 58.8），它会被当成页面家具删掉。
  const lineFontSize = line.words.reduce((max, word) => Math.max(max, word.fontSize), 0);
  const referenceFontSize = Math.max(medianFontSize, lineFontSize);
  const lineV = verticalSpanOf(line);
  let neighbourGap = Infinity;
  for (const other of allLines) {
    if (other === line || other.isPageFurniture) continue;
    const otherV = verticalSpanOf(other);
    const otherIsBelow = otherV.y0 >= lineV.y1;
    const otherIsAbove = otherV.y1 <= lineV.y0;
    if (!otherIsBelow && !otherIsAbove) continue;
    neighbourGap = Math.min(neighbourGap, verticalGapOf(lineV, otherV));
  }
  // 闸门二：连一个同侧邻居都没有时不判（没有比较对象就没有依据）
  if (!Number.isFinite(neighbourGap)) return false;

  return neighbourGap >= referenceFontSize * FURNITURE_GAP_FONT_RATIO;
}

/** 页内最宽的那一行的宽度 —— 用来估「版心宽度」 */
function maxLineWidth(lines: OcrLine[]): number {
  let max = 0;
  for (const line of lines) {
    const span = horizontalSpanOf(line);
    max = Math.max(max, span.x1 - span.x0);
  }
  return max;
}

/**
 * 把词聚成「行」。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么不再只按「中心 y 分桶」
 * ═══════════════════════════════════════════════════════════════
 *
 * 用户实测的扫描版数学题页面上有这么一块：
 *
 *     ⎧ 1/2 (x+y) e^{-(x+y)},  x>0, y>0
 *     ⎨
 *     ⎩ 0,                      其他
 *
 * 原始实现只按**词中心 y** 分桶。跨行大括号、堆叠分数的检测框又高又怪，
 * 它的中心 y 与两侧分支都不在同一容差内 → 被拆成**不同的「行」**，
 * 再按 y 排序拼接时上下文就会交错。
 *
 * 注意这里说的是**阅读顺序**（能确证的那部分），不是「内容整块消失」：
 * 消失的那块经核对是识别器根本没返回（见 `ocrEngine.ts` 的
 * `if (!text) continue`），本函数不丢任何词的文字。
 *
 * 现在的做法分三层：
 *  1. **纵向分桶**：仍按中心 y，但先把词按 y 排好序，让分桶结果稳定
 *     （原来按识别器返回顺序分桶，同一页两次跑可能得到不同结果）；
 *  2. **构件合并**：把「水平被包含、纵向紧邻」的桶并成一个构件，
 *     构件内按 y 保持分支相对顺序，主行（含 `=` 的那行）排最前；
 *  3. **行内上下标**：按几何把更小更偏上/偏下的词包成 `^{...}` / `_{...}`。
 *
 * 合并条件刻意收紧（水平包含度 + 纵向间隙双重约束），
 * 因为**把两行无关文字并成一行**比不合并更糟。
 */
function groupWordsIntoLines(words: OcrWord[], pageHeight?: number): OcrLine[] {
  if (!words.length) return [];

  // 参考字号：整页「正常文字」的字高，取**出现次数最多**的那个字高（众数）。
  //
  // 不能用「所有词字高的中位数」：一页里小字（指数、下标、分子分母、
  // 页眉页脚、图注）的数量常常不比正文少，中位数会被整体拉低。
  // 实测一个只有四个词的数学行：字高 20/20/20/13 的中位数是 16.5，
  // 而那个 13px 的指数是按 20px 正文排的 —— 基准一旦被拉低，
  // 「不超过基准 0.9 倍」这道门（14.85）就会把真正的上下标判成普通文字，
  // 上下标功能为此整个失效（单元测试抓到过这一批失败）。
  // 众数稳定落在正文上，因为它就是页面上重复次数最多的那个字号。
  const pageMainFontSize = dominantFontSize(words);

  // ── 第 0 层：先把上下标绑到它的基字上 ─────────────────────────
  //
  // 这一步必须在**分桶之前**，原因见 `findScriptAnchors` 的说明：
  // 上下标的中心 y 天然与基字差一截，先分桶就一定被拆成两行，
  // 拆开之后「行内」判上下标的逻辑再也看不到它们是一对。
  const anchors = findScriptAnchors(words, pageMainFontSize);

  // ── 第 1 层：纵向分桶 ─────────────────────────────────────────
  // 绑定了基字的上下标按**基字**的中心 y 入桶，因此必然与基字同桶；
  // 先排序是为了让「哪个词先占住桶」与识别器返回顺序无关。
  const orderKey = (word: OcrWord): number => {
    const index = words.indexOf(word);
    const anchor = words[anchors.get(index) ?? index];
    return centerY(anchor ?? word);
  };

  const ordered = [...words].sort((a, b) => orderKey(a) - orderKey(b) || a.bbox.x0 - b.bbox.x0);

  const buckets: OcrWord[][] = [];
  const bucketKeys: number[] = [];

  for (const word of ordered) {
    const y = orderKey(word);
    let matched = -1;
    for (let i = 0; i < bucketKeys.length; i++) {
      if (Math.abs((bucketKeys[i] ?? 0) - y) <= SAME_LINE_TOLERANCE) {
        matched = i;
        break;
      }
    }
    if (matched >= 0) {
      buckets[matched]?.push(word);
    } else {
      bucketKeys.push(y);
      buckets.push([word]);
    }
  }

  // ── 第 2 层：行内词序 → 构件合并 → 组装文本 ───────────────────
  const rawLines: OcrLine[] = buckets.map((group, i) => ({
    words: orderLineWords(group, words, anchors),
    text: '',
    y: bucketKeys[i] ?? 0,
    // 排序键 = 桶中心 y。构件合并会把 y 改成词框上沿，
    // 两类行必须留一个同口径的量才能稳定排序。
    sortKey: bucketKeys[i] ?? 0,
    fontSize: group.reduce((sum, w) => sum + w.fontSize, 0) / group.length,
    avgConfidence: group.reduce((sum, w) => sum + w.confidence, 0) / group.length,
  }));

  // ⚠️ 顺序不能反：**先滤页面家具，再做构件合并**。
  //  1) 构件合并会把额外的行并进来，先滤才不会把页眉页脚的文字
  //     混进正文构件里；
  //  2) 构件合并会把行的纵向跨度撑大（实测撑出过 1416px 的巨行），
  //     拿撑大的跨度去算「与相邻行的隔离度」会得到偏小的空隙，
  //     页眉页脚反而认不出来；
  //  3) 版心宽度也必须按**合并没有参与**的原始行来量。
  const contentLines = filterHeaderFooter(rawLines, pageHeight, pageMainFontSize);

  const merged = mergeContainedBranches(contentLines, pageMainFontSize)
    .map((line) => ({ ...line, words: [...line.words] }));
  attachDetachedScriptLines(merged, pageMainFontSize, words, anchors);

  return merged
    .map((line) => {
      const assembled = assembleLineText(line.words, anchors, words);
      return { ...line, text: assembled.text, hasScripts: assembled.scriptCount > 0 };
    })
    .filter((l) => l.text.length > 0)
    // ⚠️ 排序键必须与段落切分、行距统计同口径（桶中心 y）：
    // 合并出来的行 y 是「词框上沿」（见 combineCluster），
    // 两类行混在一起排会让正文先后顺序整体漂移。
    .sort((a, b) => (a.sortKey ?? a.y) - (b.sortKey ?? b.y));
}

/**
 * 把「孤立的上下标」并回它的**基字所在行**。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么构件合并救不了它
 * ═══════════════════════════════════════════════════════════════
 *
 * 上一层的构件合并要求「分支被主机在水平上包住」。而指数常在最右侧：
 * 实测 `已知 函数 e^{-(x+y)}` 里指数框是 x154–214，主机跨度只到 152 ——
 * 指数**整体探出**主机右边界，因此不构成「被包住的分支」，合并不了。
 *
 * 于是它单独成行，而判上下标时看到的又只有一个词（它的基字在另一行里），
 * 走 `findScriptAnchors` 也找不到归属。上下标功能就是这样再次失效的
 * —— 这是接线之后仍然失败的第二个原因。
 *
 * 这里做最后一步补救，判据与 `findScriptAnchors` 同源、同样保守：
 *  1. 候选行必须是**单词行**且字高不超过参考字号的 0.9 倍；
 *  2. 它的中心相对基字行有明确纵向错位（上标 ≥0.25、下标 ≥0.18 倍参考字号）；
 *  3. 它与基字行的水平间隙不超过较小字高的 0.6 倍；
 *  4. **纵向不脱节**：中心与基字的纵向距离不超过 0.9 倍参考字号。
 *
 * 合并方式刻意选「**追加到基字所在行**」：指数在阅读顺序上就排在基字之后。
 * 这样既保住了相对顺序，也不必去动已经定好的段间距。
 */
function attachDetachedScriptLines(
  lines: OcrLine[],
  pageMainFontSize: number,
  words: OcrWord[],
  anchors: Map<number, number>,
): void {
  if (!(pageMainFontSize > 0) || lines.length < 2) return;

  const maxScriptHeight = pageMainFontSize * SCRIPT_MAX_FONT_RATIO;
  const candidates: OcrLine[] = [];

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || line.words.length !== 1) continue;
    const only = line.words[0];
    if (!only || !only.text.trim()) continue;
    if (!(only.fontSize > 0) || only.fontSize > maxScriptHeight) continue;

    /**
     * 判据 0：孤立成行的上下标必须是个**小片段**（说明见 `SCRIPT_MAX_FRAGMENT_CHARS`）。
     *
     * 两条都要求：
     *  · 文本够短（≤12 字符）—— 一整行正文（实测 22 字符）不是上下标；
     *  · 含**实义字符**（字母/数字/汉字）—— 上下标是内容（指数、下标），
     *    孤立的 `）`、`、` 这类标点不是。
     *    （实义字符沿用 `WORD_CHAR_RE` 的定义，见文件下方「按字符类别决定
     *    两段文本之间要不要插空格」一节 —— 同一个概念不该有两套写法。）
     *
     * ⚠️ 这里只**收紧**候选范围，不改动任何既有阈值：
     * 过了这一关的候选，后面仍旧逐条走原来的方向 / 距离 / 水平间隙判据。
     * 因此真正的孤立指数（`-(x+y)` 这种）行为完全不变。
     */
    const fragment = only.text.trim();
    if (fragment.length > SCRIPT_MAX_FRAGMENT_CHARS) continue;
    if (!WORD_CHAR_RE.test(fragment)) continue;

    candidates.push(line);
  }

  for (const line of candidates) {
    const only = line.words[0];
    if (!only) continue;

    const candCenter = centerY(only);

    // 优先用已经记下的基字（最可靠）；没有记录时退回「找最近的那一行」，
    // 这样全行只有两三个词、`findScriptAnchors` 因词数不足而放弃时，
    // 孤立的指数仍然能被并回去。
    const index = words.indexOf(only);
    const anchorIndex = anchors.get(index);
    const recordedBase = anchorIndex === undefined ? undefined : words[anchorIndex];

    let best: OcrLine | undefined;
    let bestGap = Infinity;

    for (const other of lines) {
      if (other === line || !other.words.length) continue;

      // 该行的「代表字」：优先用记录下来的基字，否则用行内字最大的词
      const base =
        recordedBase && other.words.includes(recordedBase)
          ? recordedBase
          : other.words.reduce((a, b) => (b.fontSize > a.fontSize ? b : a));
      if (base.fontSize < only.fontSize) continue;

      const baseCenter = centerY(base);

      // 判据 2：纵向错位（上标 / 下标），按基字判而不是整行的平均
      const isSuper = baseCenter - candCenter >= pageMainFontSize * SCRIPT_SUPER_SHIFT;
      const isSub = candCenter - baseCenter >= pageMainFontSize * SCRIPT_SUB_SHIFT;
      if (!isSuper && !isSub) continue;

      // 判据 4：真的贴在基字行边上。
      //
      // 这里刻意比 `findScriptAnchors` 更严：走到这一步说明这一行**已经**
      // 与主机分开了，多半是因为离得远。只按「中心距离在 1.5 倍字号内」
      // 会把 30px 开外的一整行小字并进来（实测那对「长正文 + 短行」就是这样
      // 被并成一行、`blocks.length` 从 2 变 1）。用**行间距离**限制之后，
      // 真正的孤立指数（紧贴基字，间隙 2px）仍能并回，而隔了一段的另一行不会。
      //
      // ⚠️ 距离必须取绝对值：上标在基字**上方**，直接相减会得到负数，
      // 而 `负数 > 上限` 恒为假 —— 判据会形同虚设，把所有小字行都并进来。
      //
      // 上限用 `maxScriptHeight`（而不是基字字号）：合格候选本来就小，
      // 允许的间隙也该按小字尺度算，否则一行 20px 的正文会把 30px 外的小字吸过来。
      const lineGap = verticalGapOf(only.bbox, verticalSpanOf(other));
      if (lineGap > maxScriptHeight) continue;

      // 判据 3：水平紧邻（与基字本身比，不用整行跨度 —— 跨度可能被别的分支撑得很远）
      const gap =
        only.bbox.x0 >= base.bbox.x1 ? only.bbox.x0 - base.bbox.x1 : base.bbox.x0 - only.bbox.x1;
      if (gap > Math.min(only.fontSize, base.fontSize) * SCRIPT_FRAGMENT_GAP) continue;

      if (gap < bestGap) {
        bestGap = gap;
        best = other;
      }
    }

    if (!best) continue;
    best.words = [...best.words, only];
    best.y = Math.min(best.y, only.bbox.y0);
    // 从行列表里摘掉这一行（它的词已经被搬走了）
    const lineIndex = lines.indexOf(line);
    if (lineIndex >= 0) lines.splice(lineIndex, 1);
  }
}

/**
 * 行内词序：基字在前，它带的上下标紧随其后。
 *
 * 上下标在几何上可能落在基字**左边**一点点（`-` 这种前缀），
 * 若直接按 x 排序，输出会变成 `-x` 跑到基字前面。这里用复合键解决：
 * 基字用自己的 x，上下标一律用**基字的 x** 作主键，于是它们稳定地跟在基字后面。
 */
function orderLineWords(
  group: OcrWord[],
  allWords: OcrWord[],
  anchors: Map<number, number>,
): OcrWord[] {
  const keyOf = (word: OcrWord): [number, number] => {
    const index = allWords.indexOf(word);
    const anchorIndex = anchors.get(index);
    const anchor = anchorIndex === undefined ? undefined : allWords[anchorIndex];
    return anchor ? [anchor.bbox.x0, 1] : [word.bbox.x0, 0];
  };

  return [...group].sort((a, b) => {
    const [ax, aRank] = keyOf(a);
    const [bx, bRank] = keyOf(b);
    return ax - bx || aRank - bRank || a.bbox.x0 - b.bbox.x0;
  });
}

/**
 * 找出「哪些词是上下标、它的基字是哪个」。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么必须在分桶之前做
 * ═══════════════════════════════════════════════════════════════
 *
 * 原实现是「先按中心 y 分桶，再在桶内判上下标」。这在真实排版上**永远不成立**：
 *
 *     e      ← 中心 y = 98
 *     -(x+y) ← 中心 y = 76.5（更小、更靠上）
 *
 * 两者的中心 y 相差 21.5px，远超 5px 容差，于是各占一个桶。
 * 等到判上下标时，函数看到的已经是**两个只剩一个词的「行」**，
 * 单看任何一行都判断不出「这小字是旁边那个大字的指数」——
 * 上下标功能因此从未真正生效，这正是单元测试抓到的那一批失败。
 *
 * 所以先按几何把上下标认出来并记到基字上，再让它们跟着基字入桶。
 *
 * 判据五条，**全部满足**才算，方向一律保守：
 *  1. **更小**：字高不超过参考字号的 0.9 倍（同样大小的词一律不参与）；
 *  2. **有纵向错位**：中心相对基字上移 ≥ 0.25 倍参考字号（上标）
 *     或下移 ≥ 0.18 倍（下标）—— 同基线并排的小字错位为 0，判不出来；
 *  3. **水平紧邻**：与基字的水平间隙不超过较小字高的 0.6 倍。
 *     上下标总是紧贴基字左右，这条把隔得远的同带小字排除掉；
 *  4. **中间没有别的词**：基字与它之间不能夹着第三个词。
 *     这条专门对付「更左边那个同样紧邻的汉字」：`已知 函数 e^{-(x+y)}` 里
 *     `-(x+y)` 与 `函数` 的间隙是 24px（超过判据 3 的上限），
 *     但如果只按「取最近的那个」去归属，遇到长指数时反而会挑错对象；
 *     「中间没人」才是最贴近排版事实的判据 —— 上下标与基字之间不会有词；
 *  5. **纵向不脱节**：中心与基字中心的距离不超过 0.9 倍参考字号，
 *     把「另一行的小字」挡在外面。
 *
 * ⚠️ 判据 5 用的是**中心距离**而不是「纵向重叠必须为正」：
 * 上标整体骑在基字上方，两者的词框**本来就不重叠**（实测 `e` 的框是
 * y88–108、指数框是 y70–83，重叠为 0）。要求重叠为正会把所有真正的上标
 * 都拒之门外 —— 这是第一版接线后仍然不生效的原因。
 */
function findScriptAnchors(words: OcrWord[], pageMainFontSize: number): Map<number, number> {
  const anchors = new Map<number, number>();
  if (!(pageMainFontSize > 0)) return anchors;
  // 全行只有一两个词时，「哪个是正常字」本身就无从谈起，宁可不判
  if (words.length < SCRIPT_MIN_LINE_WORDS) return anchors;

  const maxScriptHeight = pageMainFontSize * SCRIPT_MAX_FONT_RATIO;
  const gapOf = (a: OcrWord, b: OcrWord): number =>
    a.bbox.x0 >= b.bbox.x1 ? a.bbox.x0 - b.bbox.x1 : b.bbox.x0 - a.bbox.x1;

  /** 两个词框之间的水平间隙是否被第三个词填上了 */
  const separatedBy = (a: OcrWord, b: OcrWord, others: OcrWord[]): boolean => {
    const lo = Math.min(a.bbox.x0, b.bbox.x0);
    const hi = Math.max(a.bbox.x1, b.bbox.x1);
    return others.some(
      (w) =>
        w !== a &&
        w !== b &&
        w.bbox.x0 >= lo &&
        w.bbox.x1 <= hi &&
        w.bbox.x0 > Math.min(a.bbox.x1, b.bbox.x1) - 1 &&
        w.bbox.x1 < Math.max(a.bbox.x0, b.bbox.x0) + 1,
    );
  };

  for (let i = 0; i < words.length; i++) {
    const cand = words[i];
    if (!cand || !cand.text.trim()) continue;
    // 判据 1
    if (!(cand.fontSize > 0) || cand.fontSize > maxScriptHeight) continue;

    const candCenter = centerY(cand);
    let best = -1;
    let bestGap = Infinity;

    for (let j = 0; j < words.length; j++) {
      if (j === i) continue;
      const base = words[j];
      if (!base || base.fontSize < cand.fontSize) continue;

      // 判据 2：纵向错位。同基线并排的小字错位为 0，在这里被排除
      const baseCenter = centerY(base);
      const isSuper = baseCenter - candCenter >= pageMainFontSize * SCRIPT_SUPER_SHIFT;
      const isSub = candCenter - baseCenter >= pageMainFontSize * SCRIPT_SUB_SHIFT;
      if (!isSuper && !isSub) continue;

      // 判据 3：水平紧邻
      const gap = gapOf(cand, base);
      if (gap > Math.min(cand.fontSize, base.fontSize) * SCRIPT_FRAGMENT_GAP) continue;

      // 判据 4：中间不能夹着别的词
      if (separatedBy(cand, base, words)) continue;

      // 判据 5：纵向不脱节（同样按上标/下标分开取上限）
      const band = isSuper ? SCRIPT_SUPER_BAND : SCRIPT_SUB_BAND;
      if (Math.abs(candCenter - baseCenter) > pageMainFontSize * band) continue;

      if (gap < bestGap) {
        bestGap = gap;
        best = j;
      }
    }

    if (best >= 0) anchors.set(i, best);
  }

  // ── 同一个上下标被切成多个词时，让兄弟词跟着走 ─────────────────
  //
  // 真实排版的指数经常被切成 `-`、`x` 两个词：`-` 紧贴基字能绑上，
  // 而 `x` 与基字之间已经隔了那个 `-`（间隙 12px > 上限 7.2px），
  // 于是它单独成行、指数被拆成 `e$^{-}$x`。
  //
  // 判据：与某个**已绑定**的兄弟词「纵向错位一致（同一行带）且水平相邻」。
  // 这两个条件同时要求，避免把行内另一处不相干的小字连过来。
  // 反复迭代是为了处理更长的链（`-`、`x`、`+`、`y` 被切成四个词）。
  for (let round = 0; round < words.length; round++) {
    let changed = false;

    for (let i = 0; i < words.length; i++) {
      if (anchors.has(i)) continue;
      const cand = words[i];
      if (!cand || !cand.text.trim()) continue;
      if (!(cand.fontSize > 0) || cand.fontSize > maxScriptHeight) continue;

      for (const [siblingIndex, anchorIndex] of anchors) {
        const sibling = words[siblingIndex];
        const base = words[anchorIndex];
        if (!sibling || !base) continue;

        const minHeight = Math.min(cand.fontSize, sibling.fontSize) || 1;
        if (Math.abs(centerY(cand) - centerY(sibling)) > minHeight * SCRIPT_FRAGMENT_DY) continue;
        if (gapOf(cand, sibling) > minHeight * SCRIPT_FRAGMENT_GAP) continue;

        anchors.set(i, anchorIndex);
        changed = true;
        break;
      }
    }

    if (!changed) break;
  }

  return anchors;
}

function centerY(word: OcrWord): number {
  return (word.bbox.y0 + word.bbox.y1) / 2;
}

// ───────────────────────────────────────────────────────────────
// 字符级上下标（渐进增强；拿不到字符框时这一整节都不参与）
// ───────────────────────────────────────────────────────────────

/**
 * 取一个词身上的字符框与判定结果。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么必须在**这一层**再对一次账
 * ═══════════════════════════════════════════════════════════════
 *
 * 字符框来自**第二次识别**（为了拿 CTC 的时间步，见 `lib/ocrCharBoxes.ts`），
 * 与产出 `OcrWord.text` 的那一次在空白、全角半角上可能有分歧。
 * `attachCharBoxes()` 里已经做过一轮对账，这里再查一次**最硬的那条**：
 * 把所有字符拼起来必须**逐字符等于** `word.text.trim()`。
 *
 * 不等就返回 null —— 宁可退回词级判据（可能判不出上下标），
 * 也绝不能让字符下标错位：错位会把 `x` 的上标判到 `y` 头上，
 * 输出的公式是**错的**，比不处理更糟。
 */
/**
 * ═══════════════════════════════════════════════════════════════
 * 字符级上下标判定的**总开关**（已按 Tesseract 的机制重写后打开）
 * ═══════════════════════════════════════════════════════════════
 *
 * ── 它此前为什么被关掉 ────────────────────────────────────────
 *
 * 用户真实导出（第 1 词）：
 *
 *   $^{17}$. 设 随机 变量 … 分 布律 $^{P}$ {X = x ,Y = y} …
 *   (1$^{)问}$ X 和 Y 是否相互独立？
 *   验证随机变量 Z = $^{√}$X2 + $^{Y}$ 的概率密度为
 *
 * 而真正该判出来的指数 `x+y−2` **反而没判出来**。
 *
 * 根因（已定位到具体的量）：这份文档混着**三种字体度量** —— 汉字 / 拉丁 / 数学符号。
 * 拉丁数字天生比汉字矮，而汉字字形会探到基线以下，于是
 * 「底边更高 + 更矮」对每个数字**恒成立**，与是否被抬高无关。
 * 用第 1 词的真实字符框复现过：旧判据给出的候选恰好是 `7` 与 `P`，
 * 真正的指数一个都没进 —— 症状完全对上。
 *
 * ── 参照实现 ─────────────────────────────────────────────────
 *
 * Tesseract 的 `ccmain/superscript.cpp`
 * （https://tesseract-ocr.github.io/tessapi/3.05.02/a00149_source.html#l00253 ，
 * David Eger, 2012, Apache-2.0）。它比旧实现多四个机制，旧实现**一个都没有**：
 *   1. 阈值锚在「基线 + 位移单位」上，不是「最高字」；
 *   2. **同时要求两个独立信号**：位置异常 **且** 识别置信度明显偏低
 *      （`unlikely_threshold = superscript_worse_certainty × avg_certainty`）；
 *   3. 拒绝标点（本实现另加一条：拒绝汉字）；
 *   4. 候选只取词**两端**的连续异常段。
 * 第 2 条是关键：`17`、`P`、`√` 都是被高置信度认出的普通字符，
 * 而真正的指数是小而模糊的块 —— **只看几何必然误判**。
 *
 * ── 打开的依据：不是「重写了」，而是「真实数据上判对了」 ────────
 *
 * 打开的前提是两条验收用例通过（它们是**重写后的验收标准**，断言未改）：
 *   · 指数 `x+y-2` 被包成一个 `$^{...}$`；
 *   · 指数结尾紧跟空格时，空格不能被吞进 `^{}`。
 * 两条都在 `ocrPostProcess.test.ts` 里；此外还有一组用**真实第 1 词**的
 * 字符框与置信度做的用例，两个方向都钉住：该判出的判出（`x+y−2`），
 * 不该判的必须拒掉（`17`、`P`、`√`、`Y`、`=`）。
 *
 * 拿不到字符框的词**完全不受影响**：`resolveCharScripts` 返回 null，
 * 走下面的原路径，输出与功能引入前逐字符一致（由既有测试守着）。
 *
 * ── 2026-10-08 再次关闭：真实数据否掉了「置信度门」的假设 ──────────
 *
 * 打开后的真实导出（`buildId 2026-10-08T09:15:51.188Z`）显示：
 *
 *   ✅ `N(0，σ$^{²}$)` —— **真正的上标第一次判对了**；
 *   ✅ `$^{17}$`、`$^{)问}$`、`$^{√}$` 三个误判消失；
 *   ❌ 但 `$^{P}$`、`{X $^{=}$ x ,Y $^{=}$ y} $^{=}$`、`Z $^{=}$`、
 *      `$^{+}$`、`$^{Y}$`、`X $^{∼}$` 仍然是误判；
 *   ❌ 而且指数被**打散**成 `p (1 − p )$^{x}$+$^{y}$−$^{2}$`，
 *      `+` 与 `−` 反而被排除 —— 比不判更坏。
 *
 * 根因是**构造测试数据时的假设错了**，不是实现抄错了：
 * 我假设「普通字符都是高置信度、只有指数是模糊小块」，于是那道门
 * `certainty < 0.8 × 平均` 能分开两者。**但真实数据里 `=`、`∼`、`+`
 * 这些孤立符号本身就是识别器没把握的字形**（一根小横杠能是什么？），
 * 逐字符置信度天然就低，轻松通过那道门；而指数里的 `+`/`−` 同因反被排除。
 *
 * 结论：**「低置信度」不是独立于「上下标」的信号** —— 对符号类字符，
 * 它和「矮且靠上」高度相关。**Tesseract 还有机制 5（按字符自身预期高度
 * 校验）**，正是用来排除 `=` 这类**天生就矮**的字形：
 * 它的 `height_fraction = 实测高 / 该字符预期高 ≈ 1`（没有被缩小）→ 拒绝。
 * 而真指数的 `2` 相对于正常 `2` 明显被缩小 → 接受。
 * 本实现拿不到 PP-OCR 的每字符度量表，**这一步没做**，所以门不严。
 *
 * 重新打开的前提：补上「相对该字符自身典型高度」的校验
 * （可用同页同类字符的实测高度作替代），并用**真实逐字符置信度分布**
 * 校准系数 —— 现在导出里还看不到逐字符置信度，那是下一个诊断缺口。
 */
export const CHAR_SCRIPT_ENABLED = false;

function resolveCharScripts(
  word: OcrWord,
): { chars: OcrChar[]; scripts: CharScript[] } | null {
  const attached = getAttachedChars(word);
  if (!attached) return null;

  const target = word.text.trim();
  if (!target) return null;
  const { chars, measurements, confidences } = attached;

  /**
   * ═══════════════════════════════════════════════════════════════
   * 这里必须与 `ocrCharBoxes.reconcileWithWordText` 的**同一套口径**
   * ═══════════════════════════════════════════════════════════════
   *
   * 对账产出的 `chars` 与 `word.text`（trim 后）**逐位对齐**，空位与
   * 「识别漏掉」的位置测量值为 `null` —— 这是 `emitWordWithCharScripts`
   * 按下标切片所依赖的契约。
   *
   * 所以这里必须比**同一套归一化**（全角转半角、大小写、Unicode 上下标），
   * 而不是逐字符完全相同：识别与正文在标点宽度上不一致是常态、不是错误。
   *
   * 原先这里要求完全相同，实测后果是 23 个词里只有**恰好走精确匹配**的
   * 第 14 词能通过（它的字符带着空格、长度刚好对上），其余全被挡在门外 ——
   * 上下标判定此前**根本没机会运行**，唯一跑成的一次还是错的
   * （等号被包成 `$^{=}$`）。
   *
   * ⚠️ 输出仍用 `word.text` 的原文切片，所以字符身份上的全角/半角差异
   * **不会**进入渲染结果 —— 它只决定「哪些位置有框」，而那正是需要的。
   */
  const strip = (s: string): string =>
    s
      .replace(/\s+/g, '')
      .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
      .replace(/[\u2070-\u2079\u2080-\u2089\u207A-\u207E\u208A-\u208E]/g, (ch) => {
        const code = ch.charCodeAt(0);
        if (code >= 0x2070 && code <= 0x2079) return String.fromCharCode(code - 0x2070 + 0x30);
        if (code >= 0x2080 && code <= 0x2089) return String.fromCharCode(code - 0x2080 + 0x30);
        const tail: Record<number, string> = {
          0x207a: '+', 0x207b: '-', 0x207c: '=', 0x207d: '(', 0x207e: ')',
          0x208a: '+', 0x208b: '-', 0x208c: '=', 0x208d: '(', 0x208e: ')',
        };
        return tail[code] ?? ch;
      })
      .toLowerCase();

  if (chars.length !== target.length) return null;
  if (strip(chars.map((c) => c.char).join('')) !== strip(target)) return null;

  /**
   * ⚠️ 三个参数**必须同一套下标对齐**：`classifyCharsByGeometry` 的机制 3（标点）
   * 要看 `chars`，机制 2（置信度）要看 `confidences`。任何一个错位，
   * 判出来的 `^{}` 就会落在别的字上 —— 那比没有更糟。
   *
   * `confidences` 可能是 undefined（这条路径上没拿到逐字符置信度）：
   * 那时判据**不启用**置信度门，退回纯几何（见 `classifyCharsByGeometry`）。
   * 这是显式的两条路径，不是「用 0 补齐」。
   */
  const scripts = classifyCharsByGeometry(measurements, chars, confidences);
  return scripts.length ? { chars, scripts } : null;
}

/**
 * 按字符级判据拼一个词：把连续同类的上下标字符包成 `$^{...}$` / `$_{...}$`。
 *
 * 与词级路径的关键差别：**切分点在词内部**。
 * 实测第 17 题的整行词里 `p (1 − p )x+y−2 ,0 < p < 1,…` 是一个词，
 * 词级判据看到的只是「一个框」，而这里能算出 `x+y−2` 五个字符整体
 * 更高、更小 —— 于是输出 `p(1−p)$^{x+y-2}$ ,0 < p < 1,…`。
 *
 * ═══════════════════════════════════════════════════════════════
 * 两条不变量（违反任何一条就退回原文）
 * ═══════════════════════════════════════════════════════════════
 *
 * 1. **不吞字**：输出的可见文字必须与原词逐字符相同，只是多了 `$` 包装。
 *    片段下标越界时跳过该片段，末尾剩下的字符一律原样补回。
 * 2. **间距按原样**：拼接**在原始文本串上做切片**，不重新拼词。
 *    理由是本函数必须与「拿不到字符框」的原路径**只在包装上有差别**：
 *    原路径对词内空格的处理（`appendWithJoin`、`word.text.trim()`）
 *    已经有一堆测试盯着，这里若自己拼一遍，同一份输入会因为
 *    「有没有字符框」而输出不同的空格 —— 那种差异没人能解释。
 */
function emitWordWithCharScripts(
  rawText: string,
  attached: { chars: OcrChar[] },
  scripts: CharScript[],
): { text: string; scriptCount: number } {
  const trimmed = rawText.trim();
  // 原始串里第一个非空白字符的位置：`OcrWord.text` 常常带前导空格
  const offset = rawText.indexOf(trimmed.charAt(0));
  const start = offset >= 0 ? offset : 0;
  const chars = attached.chars;
  const fragments = groupScriptFragments(chars, scripts);
  if (!fragments.length) return { text: trimmed, scriptCount: 0 };

  let text = '';
  let cursor = 0;
  let scriptCount = 0;

  for (const fragment of fragments) {
    if (fragment.from < cursor || fragment.to >= chars.length) continue;

    const headEnd = start + fragment.from;
    if (headEnd > start + cursor) text += rawText.slice(start + cursor, headEnd);

    const latex = fragmentToLatex(fragment.text);
    if (latex) {
      text += `$${fragment.kind === 'super' ? '^' : '_'}{${latex}}$`;
      scriptCount++;
    } else {
      // 转义后为空（理论上不会）：把原字符原样写回，保证不丢字
      text += fragment.text;
    }
    cursor = fragment.to + 1;
  }

  // 尾部原样补回（含词内的空格与标点）：`slice` 到串尾，不再裁剪
  text += rawText.slice(start + cursor);
  return { text, scriptCount };
}

/** 一个桶在纵向上的跨度（构件合并的纵向间隙判据要用真实边沿，不是中心） */
function verticalSpanOf(line: OcrLine): { y0: number; y1: number } {
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const w of line.words) {
    y0 = Math.min(y0, w.bbox.y0);
    y1 = Math.max(y1, w.bbox.y1);
  }
  return Number.isFinite(y0) ? { y0, y1 } : { y0: line.y, y1: line.y };
}

/** 一行的横向跨度（取词框的左右边沿，而不是首尾词的 x0/x1） */
function horizontalSpanOf(line: OcrLine): { x0: number; x1: number } {
  let x0 = Infinity;
  let x1 = -Infinity;
  for (const w of line.words) {
    x0 = Math.min(x0, w.bbox.x0);
    x1 = Math.max(x1, w.bbox.x1);
  }
  return Number.isFinite(x0) ? { x0, x1 } : { x0: 0, x1: 0 };
}

/**
 * 两个纵向跨度之间的距离，**取绝对值**。
 *
 * 必须取绝对值：上标位于基字上方时 `span.y0 - other.y1` 是负数，
 * 而「负数 > 上限」恒为假 —— 判据会形同虚设，把所有小字行都并进来
 * （实测「长正文 + 短行」那对就是这样被并成一行）。
 */
function verticalGapOf(
  a: { y0: number; y1: number },
  b: { y0: number; y1: number },
): number {
  if (a.y0 > b.y1) return a.y0 - b.y1;
  if (b.y0 > a.y1) return b.y0 - a.y1;
  return 0;
}

/**
 * 把「同一纵向区域内的分支」并成一行。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么不能只用「水平包含」
 * ═══════════════════════════════════════════════════════════════
 *
 * 第一版只用「较小行的跨度至少有 50% 落在较大行之内」来判分支。
 * 但**居中排版的短行天然落在长行的跨度之内** ——
 * 一句居中的 `短行` 会被并进上方的正文行，
 * 而合并的代价是把两段无关文字焊成一行（测试里抓到了两例：
 * 长正文 + 居中短行、以及上下两段正文）。
 *
 * 所以判据收紧成三条，**任一**成立才合并，且都要求
 * 「较小行整体落在较大行的水平跨度内」（真正被包住的分支）：
 *
 *  1. **纵向重叠**：两行的词框在纵向上有实质重叠。
 *     下标/堆叠分数的分支与主式就是这样（`0,` 与主式底部交叠）。
 *  2. **横向重叠充分**：分支有 60% 以上的宽度压在主机跨度上。
 *     跨行大括号的两侧分支属于这类。
 *  3. **数学分支**：分支里含数学记号，且纵向间隙很小（不超过 0.9 倍字高）。
 *     纯文字的短行**不含**数学记号，因此不会靠这条被并进来 ——
 *     这是把「公式的分支」与「居中的正文短行」区分开的关键。
 */
function mergeContainedBranches(lines: OcrLine[], pageMainFontSize: number): OcrLine[] {
  if (lines.length < 2) return lines;

  // ═══════════════════════════════════════════════════════════════
  // 先按「宽度从大到小」排，再做合并（**顺序决定结果**）
  // ═══════════════════════════════════════════════════════════════
  //
  // `canMergeAsBranch` 的判据是**方向性**的：分支必须比主机窄
  // （不超过主机跨度的 75%）。于是「谁先当上主机」直接决定能不能合并：
  // 拿一行 60px 宽的小字去当host，400px 宽的主式就永远合并不进来。
  //
  // 实测（用户数据第 5 行 `[5, 4, 6]` 的那三个词，centerY 588.5 / 661 / 684.5）：
  // 最上面那行只有 79px 高、跨度最小，却被先当成主机，
  // 结果**中间那行（被撑大的检测框）反而合并不进来、单独成行**。
  // 现在改成宽度大的先当主机：主式先吃掉它两侧的分支，这正是
  // 「跨行大括号 / 堆叠分数」的真实结构。
  //
  // 行序不在这里定：调用方 groupWordsIntoLines 末尾统一按**桶中心 y**
  // （sortKey）排一次 —— 排序键在合并前后必须同口径，否则正文行次序会漂移。
  const byWidth = lines
    .map((line, index) => ({ line, index }))
    .sort((a, b) => {
      const wa = horizontalSpanOf(a.line);
      const wb = horizontalSpanOf(b.line);
      return wb.x1 - wb.x0 - (wa.x1 - wa.x0) || a.index - b.index;
    })
    .map((entry) => entry.line);

  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    gaps.push(Math.abs((lines[i - 1]?.y ?? 0) - (lines[i]?.y ?? 0)));
  }
  const medianGap = median(gaps);

  const used = new Array<boolean>(byWidth.length).fill(false);
  const out: OcrLine[] = [];

  for (let i = 0; i < byWidth.length; i++) {
    if (used[i]) continue;
    const seed = byWidth[i];
    if (!seed) continue;

    used[i] = true;

    /**
     * ═══════════════════════════════════════════════════════════════
     * 成句的正文**不能当主机**（这是三个回归的共同根因）
     * ═══════════════════════════════════════════════════════════════
     *
     * 依据与实测数字见 `looksLikeBodyProse`：宽度优先之后，
     * 「页面上最宽的那行」通常就是正文行，它一旦当上主机，
     * 邻近的正文行/孤立符号就会以「更窄 + 更近」的几何条件被吸收，
     * 结果是**两个视觉行焊成一行**（实测 yRange 跨度从 62px 撑到 184px）。
     *
     * 判据放在这里（而不是逐条挪进 `canMergeAsBranch`）的原因：
     * 主机身份是**整簇**的性质 —— 一旦这个种子被判为正文，它就不该吸收任何行；
     * 而它自己仍然要作为一个独立的行留在结果里（下面照样 `out.push(seed)`），
     * 不能因为「它不能当主机」就把这一行丢掉。
     */
    const canHost = !looksLikeBodyProse(seed);
    const cluster: OcrLine[] = [seed];
    let mergedSpan = horizontalSpanOf(seed);
    let mergedV = verticalSpanOf(seed);
    let refFont = Math.max(seed.fontSize, pageMainFontSize);

    // 反复扫描直到不再有新的行被并进来（一条分支下方可能还有分支）
    let extended = canHost;
    while (extended) {
      extended = false;
      for (let j = 0; j < byWidth.length; j++) {
        if (used[j]) continue;
        const cand = byWidth[j];
        if (!cand) continue;
        if (!canMergeAsBranch(cand, mergedSpan, mergedV, refFont, medianGap)) continue;

        used[j] = true;
        cluster.push(cand);
        extended = true;

        const candSpan = horizontalSpanOf(cand);
        const candV = verticalSpanOf(cand);
        mergedSpan = {
          x0: Math.min(mergedSpan.x0, candSpan.x0),
          x1: Math.max(mergedSpan.x1, candSpan.x1),
        };
        mergedV = {
          y0: Math.min(mergedV.y0, candV.y0),
          y1: Math.max(mergedV.y1, candV.y1),
        };
        refFont = Math.max(refFont, cand.fontSize);
      }
    }

    out.push(cluster.length === 1 ? seed : combineCluster(cluster));
  }

  // ⚠️ 这里**不**排序：主循环是按宽度跑的，回来的顺序也就是按宽度。
  // 行序由调用方 `groupWordsIntoLines` 末尾那条 `sort((a, b) => a.y - b.y)`
  // 统一决定（排序键是桶中心 y，不能在这里就地按词框上沿排 —— 两者
  // 不是同一个量，会让正文行的先后顺序整体漂移）。
  return out;
}

/** 把一行的词拼成文本。构件合并之前 `line.text` 还没生成，只能按词拼。 */
function lineTextOf(line: OcrLine): string {
  return line.words.map((w) => w.text).join('').trim();
}

/**
 * ═══════════════════════════════════════════════════════════════
 * 这一行是不是「一整句正文」
 * ═══════════════════════════════════════════════════════════════
 *
 * 为什么必须有这条判据（用户真实数据的三个回归）
 * ───────────────────────────────────────────────────────────────
 *
 * 上一轮为了让「跨行大括号 / 堆叠分数」能合并，把构件合并改成了
 * **宽度大的行先当主机**（见 `mergeContainedBranches`）。而页面上最宽的行
 * 恰恰是**正文行**，于是它成了主机，邻近的正文行在几何上又完全满足
 * 「比主机窄 + 纵向间隔在 1.4 倍字号带内」—— 就被当成「分支」吸收了：
 *
 *  · **B（最严重）**：词 19 `我们称 Z 服从参数 为σ(σ > 0) 的瑞利(Rayleigh)
 *    分布.`（38 字符 / 13 个汉字，x166–918、宽 752、字号 37）当上主机后，
 *    把上方的公式检测框 `fz(e)= 0`（x255–739、宽 484、字号 121）并了进来 ——
 *    横向比值 **484 / 752 = 0.64 ≥ 0.60**，正好越过「横向压得实」那道闸
 *    （判据 2），纵向间隔只有 26px。两行于是焊成一行（yRange 跨度 184px）。
 *  · **A**：词 13 `(1)问 X 和 Y 是否相互独立？`（17 字符 / 8 个汉字）当上主机后，
 *    把上一行掉下来的孤立 `）`（x433–477、宽 44、字号 36）吸了进来，
 *    两者间隔只有 25px（1097→1122）—— 走的是判据 3。
 *  · **C**：词 15 `28. 设 X,Y…概率密度为`（61 字符 / 33 个汉字）成为主机后，
 *    `mergeContainedBranches` 判不进来（横向比值 553/956 = 0.58 < 0.60，
 *    且 22 字符的候选过不了 `looksLikeMathBranch` 的 12 字符上限），
 *    但下面的 `attachDetachedScriptLines` 把词 16
 *    `验证随机变量 Z = √X2 + Y 的概率密度为` 当成词 15 的**下标**挂了上去
 *    （见那里的判据）：它只查「方向 + 行间距离 + 水平间隙」，而两行横向重叠时
 *    水平间隙算出来是负数（225 − 778 = −553），判据形同虚设。
 *
 * 几何判据本身分不清这两种情况 —— 因为**它们的几何确实一样**：
 * 「跨行大括号的分支」与「同一段的下一行正文」都是「更窄、更近」。
 * 但文本不一样：**构件的主干是式子或短标签，不是一句成句的正文**。
 *
 * 判据：两条独立证据，满足**任一条**即认定为成句正文 ——
 *
 *  一. **以句末标点收尾，且句中有实义汉字**：一句话到这里说完了。
 *      实测 A 的主机 `(1)问 X 和 Y 是否相互独立？`（8 个汉字 + `？`）正属此类。
 *      要求「有实义汉字」是为了不误伤纯符号的式子（`X = Y.` 这类不该被拒）。
 *
 *  二. **够长（≥ 24 字符）且汉字够密（≥ 10 个）**。
 *      实测两条正文主机分别长 38 字符 / 13 个汉字、61 字符 / 33 个汉字；
 *      而同一份数据里真正当主机的式子都在 19 字符以内 ——
 *      尤其是 `其中λ>0，μ>0是常数.引入随机变量`（19 字符 / 11 个汉字），
 *      它是词 4/5/6 那一组的主机，**必须继续能当主机**（既有行为，不许弄坏）。
 *      门槛取 24 就落在 19 与 38 中间，两侧各留 5 / 14 个字符的余量。
 *      「汉字 ≥ 10」是防误伤的第二道：长**式子**（`f(x,y)=1/2(x+y)e^{-(x+y)}`
 *      这类 20+ 字符的纯公式）字符数不少但汉字为 0，不该被判成正文。
 *
 * 与已有的 `looksLikeMathBranch` 分工：那条判**分支**（短片段），
 * 这条判**主干**（成句正文）。两者都只看文本，不看几何 ——
 * 几何在这一层已经证明分不开了。
 *
 * ⚠️ 代价是刻意接受的：一句很长的中文**公式**（≥24 字符、≥10 个汉字）当主机时
 * 不再吸收下方的分支。按本文件一贯的取舍，宁可漏合并（少一层排版还原），
 * 也不能把两行无关文字焊成一行 —— 后者用户读到的内容是错的。
 */
const SENTENCE_END_RE = /[。！？!?.;；]$/;
/** 成句正文的长度门槛（字符）：19（必须放过的公式主机）< 24 < 38（实测的正文主机） */
const PROSE_MIN_LENGTH = 24;
/** 成句正文的汉字密度门槛：实测正文主机 13 / 33 个汉字，公式主机最多 11 个 */
const PROSE_MIN_CJK = 10;
/** 「以句末标点收尾」这条证据要求的最小汉字数（防纯符号式子被误判） */
const SENTENCE_MIN_CJK = 4;
/** 与文件下方的 `CJK_CHAR_RE` 是同一组区间，这里是**计数**用的全局版本 */
const CJK_COUNT_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;

function cjkCountOf(text: string): number {
  return text.match(CJK_COUNT_RE)?.length ?? 0;
}

function looksLikeBodyProse(line: OcrLine): boolean {
  const text = lineTextOf(line);
  if (!text) return false;

  const cjk = cjkCountOf(text);
  if (SENTENCE_END_RE.test(text) && cjk >= SENTENCE_MIN_CJK) return true;
  return text.length >= PROSE_MIN_LENGTH && cjk >= PROSE_MIN_CJK;
}

/**
 * 「像公式/数值的片段」而不是普通正文。
 *
 * 四类都算：
 *  1. **数学记号**（`= < > + - * / ^ ∑ ∫`）；
 *  2. **带数字的片段**（`0,`、`1/2,`、`(3.5)`）—— 跨行大括号的下分支
 *     常常只是 `0,` 这种数字加逗号，没有任何运算符；
 *  3. **纯 ASCII 短片段**（`f(x,y)`、`e^{-x}`）；
 *  4. **极短的非 ASCII 片段**（不超过 3 个字符，如跨行大括号里的 `其他`、
 *     `甲组`）—— 分支天然是短标签，而正文一句话不会只有三个字。
 *
 * 普通中文正文（`这一行文字明显长得多…`）四类都不满足，因此不会被并进来 ——
 * 这条是把「公式的分支」与「排在下方的正文」区分开的关键。
 */
const MATH_CHAR_RE = /[=<>+\-*/^±×÷∑∫√≤≥≠∞≈]/;
const NUMERIC_FRAGMENT_RE = /\d/;
const ASCII_FRAGMENT_RE = /^[\x20-\x7e]+$/;
const SHORT_FRAGMENT_MAX_CHARS = 3;

function looksLikeMathBranch(line: OcrLine, pageMainFontSize: number): boolean {
  const text = lineTextOf(line);
  if (!text) return false;
  // 太长的一段文字就不是「分支」了
  if (text.length > 12) return false;

  const looksFragment =
    MATH_CHAR_RE.test(text) ||
    NUMERIC_FRAGMENT_RE.test(text) ||
    ASCII_FRAGMENT_RE.test(text) ||
    text.length <= SHORT_FRAGMENT_MAX_CHARS;
  if (!looksFragment) return false;

  return pageMainFontSize <= 0 || line.fontSize <= pageMainFontSize;
}

function canMergeAsBranch(
  cand: OcrLine,
  merged: { x0: number; x1: number },
  mergedV: { y0: number; y1: number },
  refFont: number,
  medianGap: number,
): boolean {
  const span = horizontalSpanOf(cand);
  const spanWidth = span.x1 - span.x0;
  if (spanWidth <= 0) return false;

  // ── 前置判据：成句的正文**不是分支** ─────────────────────────
  //
  // 与主机那条判据（见 `looksLikeBodyProse`）同源、方向相反：
  // 主机不能是成句正文，分支也不能是成句正文 —— 「构件」这个概念本身就
  // 要求两侧都是式子/片段。缺了这条，判据 1（纵向重叠）与判据 2
  // （横向压得实）就成了**成句正文互相吞并**的通道：
  // 实测回归 B 里 `我们称 Z 服从参数 为σ(σ > 0) 的瑞利(Rayleigh) 分布.`
  // 与 `fz(e)= 0` 的横向比值是 0.64，正好从判据 2 进来。
  if (looksLikeBodyProse(cand)) return false;

  // 前提：分支被主机「包住」（允许 20% 的外溢，因为括线常探出主式一点）
  const slack = spanWidth * CLUSTER_BRANCH_SLACK;
  if (span.x0 < merged.x0 - slack || span.x1 > merged.x1 + slack) return false;

  const v = verticalSpanOf(cand);
  const verticalOverlap = Math.min(v.y1, mergedV.y1) - Math.max(v.y0, mergedV.y0);
  // 同样要用绝对值：分支在主机上方时相减为负，判据会失效
  const verticalGap = verticalGapOf(v, mergedV);

  const overlap = Math.min(span.x1, merged.x1) - Math.max(span.x0, merged.x0);
  const mergedWidth = merged.x1 - merged.x0;
  // 分支压在主机跨度上的比例，必须除以**主机宽度**。
  //
  // 除以分支自己的宽度是错的：分支只要落在主机跨度之内，这个比值恒等于 1，
  // 判据就退化成「主机够长就并」—— 实测那对「长正文 + 短行」的比值
  // 正是 1，于是被并成一行、`blocks.length` 从 2 变 1。
  const containmentRatio = overlap / mergedWidth;

  // 近满宽度的候选不算「分支」：它横向几乎把主机铺满，说明两者是
  // **并列的两行**，而不是主子关系。
  //
  // 实测（防「一刀切禁掉标题」的控制用例）：版面上那个 78.7px 的章节标题
  // 只有 116px 宽（真实的大标题就是这么短），它下面是一行 900px 宽的正文 ——
  // 只按「75%」那道闸，标题（占比 13%）确实会被并进正文，于是
  // **标题整行被吞掉、成为段落的一部分**，判标题的时机也一并丢了。
  // 真分支（0, 22px 对 130px、合计 56px 对 170px）的占比都在 33% 以下，
  // 与这条门槛（85%）隔着很远。
  const coveredRatio = overlap / mergedWidth;
  if (coveredRatio >= CLUSTER_PEER_COVER_RATIO) return false;

  // 分支必须比主机**明显窄**。这条是防误并的第一道闸：
  // 跨行大括号的两侧分支（`0, 其他`）是被主式包住的一小段；
  // 而两段宽度相近的正文（实测那对等宽的上下两段）绝不是「同一块构件」。
  if (spanWidth > mergedWidth * CLUSTER_BRANCH_MAX_WIDTH_RATIO) return false;

  // ── 纵向带：**所有**判据都必须先过这一关 ──────────────────────
  //
  // ═══════════════════════════════════════════════════════════════
  // 这一条是血的教训（用户真实数据）
  // ═══════════════════════════════════════════════════════════════
  //
  // 原先判据 1（纵向重叠）与判据 2（横向压得实）**都没有纵向距离上限**，
  // 于是「横向被主机跨度包住」就足以并入，**隔多远都能并**。
  // 而 host 的 `mergedSpan` 会随每次合并不断变宽 —— 形成**链式反应**：
  // 一旦跨度覆盖页宽，整页都被吞进同一行。
  //
  // 实测后果（用户那份习题 PDF，23 个词 / 画布高 2223）：
  //   第一行的 yRange 达到 [212, 1628] —— **跨度 1416 像素，含 18 个词**，
  //   整页几乎被合并成一行；题目自然也就全挤成一段。
  //
  // 所以纵向邻近是「分支」概念的前提，必须先于横纵判据成立：
  // 分支只可能紧贴主机，不可能隔着一整页还属于同一个构件。
  //
  // 上限只按**字号**算，**不**掺入 `medianGap * CLUSTER_MAX_GAP_LINES`：
  // 在密排页面上 medianGap 本身就很大，乘完动辄上千像素，
  // 等于没有上限 —— 那正是链式反应的放大器。
  const branchBandLimit = refFont * CLUSTER_BRANCH_GAP_RATIO;
  if (verticalGap > branchBandLimit) return false;

  // 判据 1：纵向重叠 —— 分支与主机真的占着同一条带（`0,` 与主式底部交叠）
  if (verticalOverlap > 0) return true;

  // 判据 2：横向压得实 —— 分支有 60% 以上的宽度落在主机跨度上
  if (containmentRatio >= CLUSTER_CONTAINMENT_RATIO) return true;

  // 判据 3：数学分支 + 纵向紧邻。
  //
  // 纵向上限按**主机字号**算：分支紧贴主机时，行间距离与主机字高同量级。
  // 实测（主机字号 20）三组数据说明 1.4 这个尺度刚好把两类分开：
  //   · 合法分支 `0,` / `合计`：间隙 28px = 1.4 倍 → 并入；
  //   · 排在下方的另一行正文：间隙 30–40px ≥ 1.5 倍 → 不并入。
  const gapLimit = Math.min(
    refFont * CLUSTER_BRANCH_GAP_RATIO,
    medianGap > 0 ? medianGap * CLUSTER_MAX_GAP_LINES : Infinity,
  );
  return verticalGap <= gapLimit && looksLikeMathBranch(cand, refFont);
}

/**
 * 把一个构件内的多行合成一行。
 *
 * 关键是**只重排词、不预先拼字符串**：文本统一由 `assembleLineText` 生成，
 * 否则这里的拼接会白做一次，还会与上下标的 `$...$` 包装互相打架。
 *
 * 主行排最前（含 `=` 的赋值式主体），其余按 y 保持从上到下的相对顺序。
 */
function combineCluster(cluster: OcrLine[]): OcrLine {
  // ═══════════════════════════════════════════════════════════════
  // 行序：**默认按上沿从上到下**；只有「有一行纵向跨住其余所有行」时才把它提到最前
  // ═══════════════════════════════════════════════════════════════
  //
  // ⚠️ 两个坑都是实测踩出来的：
  //  1. 排序键必须用**词框上沿**（topOf），不能直接用 y：构件合并是按上沿判的
  //     （见 mergeContainedBranches），而纯桶行的 y 是**桶中心** ——
  //     两个量混着排会把「合并进来的行」与「还没合并的行」次序颠倒。
  //     实测（全 ASCII 形状：上行 y=[300,320]、主行 y=[350,380]）：主行的桶中心
  //     是 365，比上行的桶中心 310 大，按桶中心排就把主行排到了后面。
  //  2. 原来是无条件把主行（含 `=` 的行）提到最前。那在**主行确实跨住同伴**时
  //     是对的（堆叠分数的分子分母、大括号两侧的分支本来就压在主机身上，主行先读），
  //     但主行与同伴根本没有交集时（同上那组坐标），把它提到最前就是把上面
  //     一整行挤到后面 —— 读出来是反的（`X = Y AB CD EF GH`）。
  //
  // 现在的判据只看**几何**，不看「哪一行含等号」：纵向跨住其余所有行的那一行
  // 才是构件的主机。`z = 当X>Y…` 与它两侧的分支、`f(x,y) = …` 与 `0, 其他`
  // 都是这种形状；而 `X = Y` 与 `AB CD EF GH` 各自成行、谁也不跨谁 ——
  // 那就老老实实按上沿排。
  const topOf = (line: OcrLine): number =>
    line.words.length ? Math.min(...line.words.map((word) => word.bbox.y0)) : line.y;
  const sorted = [...cluster].sort((a, b) => topOf(a) - topOf(b) || a.y - b.y);

  const hosts = (line: OcrLine): boolean => {
    const span = verticalSpanOf(line);
    return sorted.every((other) => {
      if (other === line) return true;
      const v = verticalSpanOf(other);
      const overlap = Math.min(span.y1, v.y1) - Math.max(span.y0, v.y0);
      return overlap > 0 && span.y0 <= v.y0 && span.y1 >= v.y1;
    });
  };
  /**
   * 挑出「主机」：纵向跨住其余所有行的那一行。
   *
   * 跨得住的行可能不止一条（多层嵌套），这时按原来的偏好定：**含 \`=\` 的行
   * 优先**（\`pickPrimaryLine\` 的评分口径），仍然并列就取最上面那条 ——
   * 保证结果与输入顺序无关、可重现。
   */
  function pickHost(): OcrLine | undefined {
    const candidates = sorted.length > 1 ? sorted.filter(hosts) : [];
    if (!candidates.length) return undefined;
    const preferred = pickPrimaryLine(candidates);
    const scored = candidates.filter((line) => line === preferred);
    const pool = scored.length ? scored : candidates;
    return pool.reduce((best, line) => (topOf(line) < topOf(best) ? line : best));
  }
  const host = pickHost();

  // ⚠️ 这里刻意用 if 而不是三元表达式：`cond ? a : [...b, ...c]` 会被解析成
  // `(cond ? a : [...b]), ...c` —— 会把主机强行放到最前，判据形同虚设。
  // 这个坑实测踩过一次（判据打印出来是 false、词序却仍然是反的）。
  const sequence: OcrLine[] = host ? [host, ...sorted.filter((l) => l !== host)] : sorted;

  const words = sequence.flatMap((l) => l.words);
  const wordCount = words.length || 1;

  return {
    words,
    text: '',
    // 用最上面那条词框的上沿作为「这块内容从哪开始」：
    // 主式上方的上标（`e^{-x}` 的指数）也属于这块内容
    y: Math.min(...words.map((w) => w.bbox.y0)),
    fontSize:
      sequence.reduce((sum, l) => sum + l.fontSize * Math.max(1, l.words.length), 0) / wordCount,
    avgConfidence: words.reduce((sum, w) => sum + w.confidence, 0) / wordCount,
    hasScripts: sequence.some((l) => l.hasScripts),
  };
}

/**
 * 挑出构件里的「主行」。
 *
 * 优先取含 `=` 的行（`f(x,y) = …` 这种赋值式的主体）；
 * 没有等号时取词数最多的行（跨行大括号常与主式同桶，因此这条是兜底）。
 * 注意这里只看**词**，不看拼接好的文本 —— 行文本在构件合并之后才生成。
 */
function pickPrimaryLine(lines: OcrLine[]): OcrLine | undefined {
  let best: OcrLine | undefined;
  let bestScore = -1;

  for (const line of lines) {
    const text = line.words.map((w) => w.text).join('');
    const score = (ASSIGNMENT_RE.test(text) ? 1000 : 0) + line.words.length;
    if (score > bestScore) {
      bestScore = score;
      best = line;
    }
  }

  return best;
}

/**
 * 按字符类别决定两段文本之间要不要插空格。
 *
 * ═══════════════════════════════════════════════════════════════
 * 中文之间**绝不插空格**（这是一条回归防线）
 * ═══════════════════════════════════════════════════════════════
 *
 * 识别器常把一个中文词切成单字词（`这`/`是`/`一`/`段`…）。
 * 若按「一个词一段、一律用空格连接」处理，正文会变成
 * `这 是 一 段 普 通 的 识 别 结 果` —— 逐字加空格，中文正文彻底不能读。
 * 这条不变量在 `ocrResultToBlocks` 的行拼接与 `mergeShortChunks` 的
 * 碎片合并里都已经明写（都用 `/[\u4e00-\u9fff]$/` 判中文），
 * 本函数是第三处，必须同一口径。
 *
 * 反过来，英文之间必须留空格（`The quick brown fox`），
 * 而括号、标点前不留空格（识别器常把 `(` 与 `x` 切成两个词，
 * 原来会给英文加空格，于是 `(x+y)` 变成 `( x+y )`）。
 */
const WORD_CHAR_RE = /[\p{L}\p{N}_]/u;
const CJK_CHAR_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;

function appendWithJoin(left: string, right: string): string {
  if (!left) return right;
  if (!right) return left;

  const a = left[left.length - 1] ?? '';
  const b = right[0] ?? '';

  // 中文与中文相接时不插空格（含「中文 + 中文标点」）
  if (CJK_CHAR_RE.test(a)) return `${left}${right}`;

  const join =
    WORD_CHAR_RE.test(a) &&
    (WORD_CHAR_RE.test(b) || b === '(' || b === '[' || b === '{');

  return join ? `${left} ${right}` : `${left}${right}`;
}

// ───────────────────────────────────────────────────────────────
// 上下标：基于几何的判定与还原
// ───────────────────────────────────────────────────────────────

/**
 * 上下标的几何判定。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么需要它：真实数学排版里指数是**独立的、更小的文本框**
 * ═══════════════════════════════════════════════════════════════
 *
 * `BlockRow.tsx` 里已有的 `normalizeSuperSub()` 只处理 **Unicode 上下标字符**
 * （`¹²³₀₁₂`）—— 那是「识别器把上标认成了 Unicode 字符」的情况。
 * 但真实排版里 `e^{-(x+y)}` 的指数是**字号更小、位置更高**的另一个文本块：
 * 识别器返回的是普通字符 `-(x+y)`，只是框更小更靠上。
 * Unicode 映射对这种形态完全无能为力，于是输出成 `e-(x+y)` 这种平铺文本。
 *
 * 判据三条，**全部满足**才认定为上下标：
 *  1. **更小**：字号（词框高度）不超过参考字号的 0.9 倍；
 *  2. **有纵向错位**：中心 y 相对参考中心上移 ≥ 0.25 倍参考字号（上标）
 *     或下移 ≥ 0.18 倍（下标）。同一基线上并排的小字**错位为 0**，
 *     因此不会被误判 —— 这是区分「上标」与「就是小一号的字」的关键；
 *  3. **不越出本行**：中心仍落在本行上下沿附近（允许 0.75 倍字高的外扩），
 *     防止把邻行的小字（页边注、下标行）并进来。
 *
 * 参考字号优先取「整页正常文字的字高」（页级中位数），
 * 它不会被本行的小字拖低；只有当页级估计明显偏小（本行全是正常字）
 * 时才退回本行中位数。
 */
type ScriptKind = 'super' | 'sub';

/**
 * 判断某个已绑定的词到底是上标还是下标。
 *
 * 与 `findScriptAnchors` 的分工：绑定管「它属于哪个基字」（用重叠最多），
 * 这里管「它是上还是下」（用中心错位的方向）。两者分开是因为
 * 一个被绑定的词总要先确定归属，再确定形态。
 */
function inferScriptKind(
  word: OcrWord,
  candidate: OcrWord,
  pageMainFontSize: number,
): ScriptKind | null {
  if (!candidate.text.trim()) return null;
  // 更小才算上下标：同样大小的词一律不碰
  if (candidate.fontSize > pageMainFontSize * SCRIPT_MAX_FONT_RATIO) return null;

  const candCenter = centerY(candidate);
  const baseCenter = centerY(word);

  // 上标：中心明显上移，且整体骑在基字中线之上（更严）
  if (
    baseCenter - candCenter >= pageMainFontSize * SCRIPT_SUPER_SHIFT &&
    candidate.bbox.y1 <= baseCenter
  ) {
    return 'super';
  }
  // 下标：中心明显下移（稍宽，因为排版里的下标常常只低一点点）
  if (candCenter - baseCenter >= pageMainFontSize * SCRIPT_SUB_SHIFT) return 'sub';

  return null;
}

/**
 * 把已经取出的上下标文本转成 LaTeX。
 *
 * 为什么要转义：LaTeX 里 `_` `%` `&` `#` 都是特殊字符，正文中却可能出现
 * （下划线、百分号）。不转义会让 KaTeX 渲染出莫名其妙的公式甚至报错。
 * 已经是 `$...$` 的词（例如公式增强产出的结果）直接原样嵌入，不重复转义。
 */
const LATEX_ESCAPE: [RegExp, string][] = [
  [/\\/g, '\\backslash '],
  [/([%&#{}])/g, '\\$&'],
  [/_/g, '\\_'],
  [/\$/g, '\\$'],
];

function escapeLatex(text: string): string {
  let out = text;
  for (const [re, to] of LATEX_ESCAPE) out = out.replace(re, to);
  return out;
}

function fragmentToLatex(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  // 已是公式（`$...$`）时不再转义：里面的转义由产出方负责
  if (/^\$[\s\S]*\$$/.test(trimmed)) return trimmed;
  return escapeLatex(trimmed);
}

/**
 * 把一段普通的识别文本放进**已经含公式**的行里，保证 `$` 仍然成对。
 *
 * 用在「上下标没判出来、只能按普通字补回」那条兜底上：这一行里可能
 * 刚生成过 `$^{...}$`，若补回的文本里含未转义的 `$` 或 `_`，
 * 渲染层（`BlockRow.tsx`）按 `$` 成对切分时就会错位，
 * 把本该显示的整段文字吃掉 —— 那正是本文件顶部反复强调的
 * 「把能用的结果弄丢」。所以这里统一按行内公式包一层。
 */
function plainInline(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const latex = fragmentToLatex(trimmed);
  if (/^\$[\s\S]*\$$/.test(latex)) return latex;
  return `$${latex}$`;
}

/**
 * 组装一行文本，并把绑定了基字的上下标包成 `^{...}` / `_{...}`。
 *
 * 输出形态是 `e$^{-(x+y)}$` —— `$...$` 会被 `BlockRow.tsx` 的 KaTeX 渲染成
 * 真正的行内公式（Markdown 链路走 `remark-math`，OCR 链路直接由渲染层处理）。
 *
 * 词序由 `orderLineWords` 决定（基字在前、它的上下标紧随），因此这里只按
 * 顺序输出：遇到基字就写它自己，再把它带的上下标拼成 `$^{...}$`；
 * 未被判为上下标的词照常按字符类别拼接。
 *
/**
 * 拼装行文本。
 *
 * ═══════════════════════════════════════════════════════════════
 * 一条不能违反的不变量：**这一行里的每个词都要出现在结果里**
 * ═══════════════════════════════════════════════════════════════
 *
 * 主循环对「绑定了基字的词」是跳过的（它应该由基字带出来）。
 * 但「基字带出来」这条路并不总是成立，实测踩到过一次真实的丢字：
 *
 *     e 后面跟一个被切成 `-` 和 `2` 的小字指数
 *     → 输出 `e$^{-}$`，**`2` 整个消失**
 *
 * 原因是归属链中间断了一环：主循环看到 `2` 绑定了基字（`2 → -`）而跳过它，
 * 而拼装时 `-` 名下有没有 `2`、形态判不判得出来是另一回事 ——
 * 只要那一环不成立，`2` 就两边都不管。所以下面每条「跳过」都必须
 * **先确认它真的会被别人吐出来**，否则补回文字（见循环里的兜底）。
 *
 * 返回 `scriptCount` 是为了让调用方能观察「这一行到底改没改」，
 * 也便于诊断输出区分「没检测到」与「检测到但没敢改」。
 */
function assembleLineText(
  words: OcrWord[],
  anchors: Map<number, number>,
  allWords: OcrWord[],
): { text: string; scriptCount: number } {
  if (!words.length) return { text: '', scriptCount: 0 };

  // 这一行里的词在 `allWords`（词序号空间）里的下标 —— 上下标绑定关系是按它记的
  const indexOf = new Map<OcrWord, number>();
  for (let i = 0; i < allWords.length; i++) {
    const w = allWords[i];
    if (w) indexOf.set(w, i);
  }

  /** 本行里出现的词序号集合。判断「基字是否在本行」必须按**序号**比，
   *  不能按对象身份：`orderLineWords` 会返回词的新数组，而 `allWords` 里
   *  是另一个词对象时 `words.includes(...)` 会为假，于是那个被跳过的词
   *  谁也吐不出来（见下面的兜底说明）。 */
  const indicesInLine = new Set<number>();
  for (const word of words) {
    const index = indexOf.get(word);
    if (index !== undefined) indicesInLine.add(index);
  }

  // 基字 → 它带的上下标词
  const scripts = new Map<OcrWord, OcrWord[]>();
  for (const word of words) {
    const index = indexOf.get(word);
    const anchorIndex = index === undefined ? undefined : anchors.get(index);
    const anchor = anchorIndex === undefined ? undefined : allWords[anchorIndex];
    if (!anchor || anchor === word || !words.includes(anchor)) continue;
    const list = scripts.get(anchor);
    if (list) list.push(word);
    else scripts.set(anchor, [word]);
  }

  const pageMainFontSize = dominantFontSize(allWords);
  let text = '';
  let scriptCount = 0;

  /**
   * 一个词会不会被**别人**吐出来。
   *
   * ═══════════════════════════════════════════════════════════════
   * 为什么不能只看「它绑没绑基字」
   * ═══════════════════════════════════════════════════════════════
   *
   * 实测复现的真实丢字：`e` 后面跟一个被切成 `-` 和 `2` 的小字指数，
   * 输出变成 `AB CD e$^{-}$` —— **`2` 整个消失**。
   *
   * 因为「绑定」是一条**可能断掉的链**：
   *  · 主循环看到 `2` 绑定了基字就跳过它，认定「基字会带它出来」；
   *  · 可它的基字是 `-`，而 `-` 自己也是个绑定了 `e` 的上下标 ——
   *    `-` 那一轮只拿**挂在 `e` 名下**的词拼公式（`e` 名下只有 `-`），
   *    根本不会碰挂在 `-` 名下的 `2`。于是 `2` 谁也不管。
   *
   * 所以判据必须是「**链的下一环会不会真的输出它**」，而不是
   * 「它有没有绑上基字」。下面按拼装时的真实条件逐条对齐：
   *  · 基字在本行（否则它自己都轮不到）；
   *  · 基字自己不会被跳过（它没绑基字）—— 会的话它同样吐不出东西；
   *  · 基字名下确实挂着这个词；
   *  · 基字名下**至少有一个**词判得出形态（否则那一轮
   *    `if (!kind) continue` 会把整串丢掉，正是上面那个丢字场景的最后一环）。
   *
   * ⚠️ 这里**不放宽任何上下标阈值**：该不该判成上下标仍由原判据决定。
   * 这条兜底只保证「输出里不丢字」—— 识别出来的文字一个都不能少，
   * 用户宁可看到一个没排好的字符，也不能让它凭空消失。
   */
  const willBeEmittedByAnchor = (word: OcrWord): boolean => {
    const index = indexOf.get(word);
    const anchorIndex = index === undefined ? undefined : anchors.get(index);
    if (anchorIndex === undefined) return false;

    const anchor = allWords[anchorIndex];
    if (!anchor || !indicesInLine.has(anchorIndex)) return false;

    const anchorOfAnchor = anchors.get(anchorIndex);
    if (anchorOfAnchor !== undefined && indicesInLine.has(anchorOfAnchor)) return false;

    const attached = scripts.get(anchor);
    if (!attached?.includes(word)) return false;
    return attached.some((s) => inferScriptKind(anchor, s, pageMainFontSize) !== null);
  };

  for (const word of words) {
    // 绑定了基字的词由它的基字带出来，轮到它自己时跳过 ——
    // 但**只有确认它真的会被带出来**才跳过，否则补回文字（见上面的说明）
    const index = indexOf.get(word);
    if (index !== undefined && anchors.has(index)) {
      if (!willBeEmittedByAnchor(word)) {
        /*
         * 补回时走 `plainInline()` 而不是直接拼原文：这一行里可能已经有
         * `$...$`（基字那一轮刚生成的公式），若这里塞进一个未转义的 `$`
         * 或 `_`，渲染层按 `$` 切分就会错位，把整段文字吃掉 ——
         * `BlockRow.tsx` 的 `$...$` 是成对解析的。
         */
        text = appendWithJoin(text, plainInline(word.text));
      }
      continue;
    }

    /*
     * ═══════════════════════════════════════════════════════════
     * 先看这个词有没有**字符级**坐标（渐进增强的第一优先生效点）
     * ═══════════════════════════════════════════════════════════
     *
     * 词级判据（`findScriptAnchors`）只能看到「两个词框」，而真实扫描件里
     * 指数常常与整行**同框**：实测第 17 题 `p (1 − p )x+y−2` 的 `x+y−2`
     * 就在 bbox [225,212,1604,255] 这一个词里，任何词级几何都判不出来。
     *
     * `lib/ocrCharBoxes.ts` 给出的逐字符框能直接量出「x 比主字小、
     * 而且底边高出基线」，于是这里优先按字符切分。
     * **拿不到字符框的词走下面的原路径，输出与改动前逐字符一致。**
     */
    const charScripts = CHAR_SCRIPT_ENABLED ? resolveCharScripts(word) : null;
    if (charScripts) {
      const emitted = emitWordWithCharScripts(word.text, charScripts, charScripts.scripts);
      text = appendWithJoin(text, emitted.text);
      scriptCount += emitted.scriptCount;
      continue;
    }

    text = appendWithJoin(text, word.text.trim());

    const attached = scripts.get(word);
    if (!attached || !attached.length) continue;

    // 指数被切成 `-`、`x` 两个词时，要合成**一个** `$^{-x}$`
    // （而不是 `$^{-}$$^{x}$`：后者在 KaTeX 里是两个并列公式，语义不对）
    const sorted = [...attached].sort((a, b) => a.bbox.x0 - b.bbox.x0);
    const kind =
      sorted
        .map((s) => inferScriptKind(word, s, pageMainFontSize))
        .find((k): k is ScriptKind => k !== null) ?? null;
    if (!kind) continue;

    const latex = fragmentToLatex(
      sorted
        .map((s) => s.text.trim())
        .filter(Boolean)
        .reduce(appendWithJoin, ''),
    );
    if (!latex) continue;

    // 上下标与基字之间不加空格：`e$^{-(x+y)}$`
    text = appendWithJoin(text, '$');
    text = appendWithJoin(text, `${kind === 'super' ? '^' : '_'}{${latex}}`);
    text = appendWithJoin(text, '$');
    scriptCount++;
  }

  return { text, scriptCount };
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0);
}

/**
 * 页面的「正文字号」：出现次数最多、且占比足够高的那个字高。
 *
 * 为什么不用中位数：小字（指数、下标、分子/分母、页眉页脚、图注）在一页里
 * 数量可观，会把中位数整体拉低，而上下标判定要的正是「正常字有多大」。
 * 众数是「重复最多的字号」，与版式无关，天然落在正文上。
 *
 * 还要加一条「占比」判断，否则在**公式为主的页面**上会选错：
 * 实测 `e^{-x}` 这类行只有 2 个 12px 的小字与 3 个 20px 的正文词，
 * 若只按次数会得到 20（正确）；但换成 `a_{i}b_{j}c_{k}` 这种下标更多的行，
 * 次数最多的反而是小字，基准就塌了。
 *
 * 因此：先取次数最多的那个；若**更大**的字号占据了至少
 * `DOMINANT_MIN_SHARE` 的词数比例，则改用那个更大的 ——
 * 较大的字号更可能是正文，较小的只可能是上下标，方向永远偏保守。
 * 字高为 0 或非有限值的词不参与（识别器偶尔会给出空框）。
 */
const DOMINANT_MIN_SHARE = 0.4;

function dominantFontSize(words: OcrWord[]): number {
  const counts = new Map<number, number>();
  let total = 0;
  for (const word of words) {
    if (!Number.isFinite(word.fontSize) || word.fontSize <= 0) continue;
    const height = Math.round(word.fontSize * 2) / 2;
    counts.set(height, (counts.get(height) ?? 0) + 1);
    total++;
  }
  if (!total) return 0;

  let best = 0;
  let bestCount = 0;
  for (const [height, count] of counts) {
    if (count > bestCount || (count === bestCount && height < best)) {
      best = height;
      bestCount = count;
    }
  }

  // 更大的字号如果足够常见，那才是正文
  const minShare = total * DOMINANT_MIN_SHARE;
  let larger = 0;
  for (const [height, count] of counts) {
    if (height > best && count >= minShare && height > larger) larger = height;
  }

  return larger > 0 ? larger : best;
}
