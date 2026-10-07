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
 * 6. 字号启发式标题检测（大于中位数 1.3 倍且文本较短 → heading）。
 */
import type { ContentBlock } from '@/types/content';
import type { OcrWord, OcrPageResult } from '@/lib/ocrTypes';
import { buildOcrStructure, type OcrStructure } from '@/lib/ocrStructure';

interface OcrLine {
  words: OcrWord[];
  text: string;
  y: number;
  fontSize: number;
  avgConfidence: number;
  /** 该行文本里是否真的包进了几何判定的上下标（供诊断与测试观察） */
  hasScripts?: boolean;
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
/** 跨行构件合并：分支被主机包住时允许的外溢比例 */
const CLUSTER_BRANCH_SLACK = 0.2;
/** 跨行构件合并：分支宽度最多是主机的这个比例（更宽的就不是「分支」） */
const CLUSTER_BRANCH_MAX_WIDTH_RATIO = 0.75;
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

/** 标题启发式：短、单行、以编号或章节词开头 */
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
 */
export function ocrResultToBlocks(
  result: OcrPageResult,
  pageHeight?: number,
  onStructure?: (structure: OcrStructure) => void,
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

  const lines = groupWordsIntoLines(result.words);
  if (!lines.length) return ocrTextToBlocks(result.pageText ?? '');

  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    gaps.push(Math.abs((lines[i - 1]?.y ?? 0) - (lines[i]?.y ?? 0)));
  }
  const medianGap = median(gaps) || 0;
  const medianFontSize = median(lines.map((l) => l.fontSize)) || 12;

  // Filter out header/footer lines: in top/bottom margin with small font
  const filteredLines = filterHeaderFooter(lines, pageHeight, medianFontSize);

  const blocks: Omit<ContentBlock, 'id'>[] = [];
  let currentText = '';
  let currentConfSum = 0;
  let currentConfCount = 0;
  let currentFontSize = 0;
  let currentScripts = 0;
  let prevY: number | null = null;

  for (const line of filteredLines) {
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
        const isHeading =
          currentFontSize > medianFontSize * HEADING_FONT_RATIO &&
          currentText.trim().length <= HEADING_MAX_CHARS;

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
      currentText.trim().length <= HEADING_MAX_CHARS;

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
  // 放在最后：`filteredLines` 是真正参与拼装的行（页眉页脚已经滤掉），
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
        lines: filteredLines
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
 */
function filterHeaderFooter(
  lines: OcrLine[],
  pageHeight: number | undefined,
  medianFontSize: number,
): OcrLine[] {
  if (!pageHeight || pageHeight <= 0 || lines.length < 3) return lines;

  const topThreshold = pageHeight * HEADER_FOOTER_MARGIN_RATIO;
  const bottomThreshold = pageHeight * (1 - HEADER_FOOTER_MARGIN_RATIO);
  const smallFontThreshold = medianFontSize * HEADER_FOOTER_FONT_RATIO;

  return lines.filter((line) => {
    const inMargin = line.y < topThreshold || line.y > bottomThreshold;
    const smallFont = line.fontSize < smallFontThreshold;
    return !(inMargin && smallFont);
  });
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
function groupWordsIntoLines(words: OcrWord[]): OcrLine[] {
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
    fontSize: group.reduce((sum, w) => sum + w.fontSize, 0) / group.length,
    avgConfidence: group.reduce((sum, w) => sum + w.confidence, 0) / group.length,
  }));

  const merged = mergeContainedBranches(rawLines, pageMainFontSize)
    .map((line) => ({ ...line, words: [...line.words] }));
  attachDetachedScriptLines(merged, pageMainFontSize, words, anchors);

  return merged
    .map((line) => {
      const assembled = assembleLineText(line.words, anchors, words);
      return { ...line, text: assembled.text, hasScripts: assembled.scriptCount > 0 };
    })
    .filter((l) => l.text.length > 0)
    .sort((a, b) => a.y - b.y);
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

  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    gaps.push(Math.abs((lines[i - 1]?.y ?? 0) - (lines[i]?.y ?? 0)));
  }
  const medianGap = median(gaps);

  const used = new Array<boolean>(lines.length).fill(false);
  const out: OcrLine[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (used[i]) continue;
    const seed = lines[i];
    if (!seed) continue;

    used[i] = true;
    const cluster: OcrLine[] = [seed];
    let mergedSpan = horizontalSpanOf(seed);
    let mergedV = verticalSpanOf(seed);
    let refFont = Math.max(seed.fontSize, pageMainFontSize);

    // 反复扫描直到不再有新的行被并进来（一条分支下方可能还有分支）
    let extended = true;
    while (extended) {
      extended = false;
      for (let j = 0; j < lines.length; j++) {
        if (used[j]) continue;
        const cand = lines[j];
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

  return out;
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
  const text = line.words.map((w) => w.text).join('').trim();
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

  // 分支必须比主机**明显窄**。这条是防误并的第一道闸：
  // 跨行大括号的两侧分支（`0, 其他`）是被主式包住的一小段；
  // 而两段宽度相近的正文（实测那对等宽的上下两段）绝不是「同一块构件」。
  if (spanWidth > mergedWidth * CLUSTER_BRANCH_MAX_WIDTH_RATIO) return false;

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
  const sorted = [...cluster].sort((a, b) => a.y - b.y);
  const primary = pickPrimaryLine(sorted);
  const sequence = [...(primary ? [primary] : []), ...sorted.filter((l) => l !== primary)];

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
