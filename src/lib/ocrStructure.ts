/**
 * 「识别结构」导出：把一页 OCR 的**原始几何**整理成可复制的 JSON。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么必须有这个出口
 * ═══════════════════════════════════════════════════════════════
 *
 * 上下标（指数、下标）的判据是**纯几何**的：更小、更偏上/偏下、水平紧邻。
 * 而这些阈值此前只在**手工合成的坐标**上验证过 —— 合成词框是我们自己
 * 想象的形状，真实识别器的输出完全可能不一样（高度偏大、位置偏移、
 * 与基字之间有别的词……）。用户的实测结果正是如此：
 * **同一套判据在合成坐标上全绿，在真实扫描件上却完全不生效。**
 *
 * 问题在于那台机器上跑不了浏览器里的推理，所以没法自己造出真实数据 ——
 * 只能让用户把**这一页的真实结构**复制出来。本文件负责把它整理成
 * 「人能看懂、也能直接量」的形状，并**控制体积**（见 `buildOcrStructure`）。
 *
 * ⚠️ 纯本地：这里只做数据整理，不发起任何网络请求，也不写入 IndexedDB。
 */
import type { ContentBlock } from '@/types/content';
import type { OcrWord } from '@/lib/ocrTypes';
// 字符框不在 `OcrWord` 上 —— 由 `ocrCharBoxes` 用 WeakMap 旁挂，必须显式取。
// 这条例外值得写出来：看上去像"少了一个字段"，其实是刻意的设计。
//
// `buildCharSizeTable` / `charSizeKey` 是**机制 5 那条判据自己用的函数**
// （不是本文件另写一份）：导出里的「页内同字符最大高度」必须与判据同源，
// 否则两边会各自漂移（见 `buildOcrStructure` 里 `sizeTable` 的注释）。
import {
  buildCharSizeTable,
  charSizeKey,
  getAttachedChars,
  getCharBoxSkips,
  type AttachedChars,
  type CharSizeTable,
} from '@/lib/ocrCharBoxes';

/** 一个词在页面上的原始形态（字段名刻意取短，便于阅读与对比） */
export interface OcrStructureWord {
  /** 词在 `words` 里的下标，供 `lines[].wordIndices` 引用 */
  i: number;
  text: string;
  confidence: number;
  /** [x0, y0, x1, y1]，像素坐标 */
  bbox: [number, number, number, number];
  /** 识别器给的字高（本项目里等于检测框高度） */
  fontSize: number;
  /** 由 bbox 直接算出的高度 —— 与 `fontSize` 不一致时说明识别器另有口径 */
  height: number;
  /** 中心 y，判上下标时用的就是这个量 */
  centerY: number;
  /**
   * 字符级框。**只有真的拿到时才存在**（见下面 `wordEntries` 里的长注释）。
   * 缺这个字段 = 字符级定位这一步没跑成，而不是"字符框为空"。
   */
  chars?: {
    char: string;
    bbox: [number, number, number, number];
    /**
     * 该字符的识别置信度；`null` = 这一位没有墨迹（空白）或识别多出被跳过。
     *
     * 它是判据里「位置异常 **且** 置信度偏低」那道门的输入，
     * 也是判断那道门到底有没有用的**唯一依据** —— 见下面写出处的注释。
     */
    confidence?: number | null;
    /**
     * ═══════════════════════════════════════════════════════════════
     * 机制 5（按字符自身尺寸）用的三个量 —— 下面三个字段是**一组**
     * ═══════════════════════════════════════════════════════════════
     *
     * **给谁用**：给**下一次改「机制 2（置信度门）与机制 5（按字符自身尺寸
     * 缩小）的关系」的人**用。现在的判据顺序是「几何 → 置信度 → 自身尺寸」，
     * 而真指数 `x+y−2` 的高度比**其实已经算出来了** —— 实测 `x` ≈ 0.35、
     * `2` ≈ 0.50，两者都 < `SCRIPT_MECH5_SCALEDOWN_RATIO`（0.8）；它们
     * **只是被置信度门挡在前面**（那五个字符的逐字符置信度 0.9205–0.9997，
     * 门槛 ≈ 0.91）。也就是说「几何合格 **且** 尺寸比 < 0.8 就算通过」
     * 是一条有实测数字支撑的改法。
     *
     * 但**在动手之前，这些量必须先能被看见**：导出里此前只有
     * `chars[].confidence`，**没有高度比** —— 于是「比值到底是多少」
     * 只能靠推算，而那正是本项目已经栽过三次的坑（同一个错误：用一个
     * 没验证过的假设去验证另一个假设），三次都是靠「把看不见却决定结论的
     * 量变成字段」走出来的：`charBoxSkips` → `charConfidencesComplete`
     * → `chars[].confidence`。这三个字段是同一件事的第四步。
     *
     * ⚠️ 三个字段**永远写出来**（量不到时写 `null`）——「量到了但是 null」
     * 本身就是信息，与「没有这个字段」是两回事（后者见 `chars` 本身：
     * 拿不到字符框的词连 `chars` 都不写）。
     */
    /**
     * 该字符的**像素**墨迹高度（= `bbox[3] - bbox[1]`，画布坐标，1 位小数）。
     *
     * `null` = 这一位**没有墨迹**：空白位（`word.text` 里的空格，对账时
     * 给的是退化框），或识别多出/漏掉、逐列墨迹分析没量到墨迹的位。
     * 判定用的标志与机制 5 建表时**是同一个**：`measurements[i] === null`
     * （= `buildCharSizeTable` 的第 1 条过滤规则）。
     *
     * ───────────────────────────────────────────────────────────────
     * ⚠️ 为什么必须是**像素**高度，而不是 `InkMeasurement.h`（归一化高度）
     * ───────────────────────────────────────────────────────────────
     *
     * `h` 的分母是**本词自己的裁剪高**，而检测框的紧致程度差异极大 ——
     * 同一个 `=`（墨迹高 6.1）在两个词里量出来是：
     *
     *   · 第 1 词（框高 43 → 裁剪高 ≈ 49）：6.1 / 49 ≈ **0.124**；
     *   · 第 16 词（框高 ≈ 23 → 裁剪高 ≈ 27）：6.1 / 27 ≈ **0.226**。
     *
     * 归一化后两者之比 0.124 / 0.226 ≈ **0.55 < 0.8** —— 本该**拒绝**的
     * 第 1 词等号会被判成「被缩小了」而**接受**。像素高度是「墨迹本身有
     * 多高」，两个词的框紧不紧都不影响它，这才是「该字符应有的高度」的
     * 口径（完整算式与依据见 `ocrCharBoxes.buildCharSizeTable` 的注释）。
     */
    inkHeight: number | null;
    /**
     * 机制 5 的分母 `H(c)`：**页内同字符**的最大实测像素高度。
     *
     * 取自机制 5 那张页级表（`ocrCharBoxes.buildCharSizeTable`），
     * 键用同一个 `charSizeKey`（只折全角；**不**折大小写、**不**把 Unicode
     * 上下标归到基字符 —— 每一条都有实测理由，见那个函数的注释）。
     * 因此它与 `inkHeight` **同源同口径**，可以直接相除。
     *
     * `null` 有两种情形，都表示「这个字符在本页没有可用基准」：
     *  1. **整页都没有表**（提供字符框的词少于 `SCRIPT_MECH5_MIN_WORDS`，
     *     机制 5 本来就没启用）→ 这一页每个字符都是 `null`；
     *  2. 这个字符不在表里 —— 它在整页没有留下任何可用的测量值，或者
     *     它**本身即 Unicode 上下标字符**（`²`/`₂`…，建表刻意排除它们：
     *     让「天生就矮」的形态去定义「全尺寸」是语义错误）。
     *     判据对第 2 类走**例外分支直接接受**，根本不查表。
     */
    pageMaxHeight: number | null;
    /**
     * `inkHeight / pageMaxHeight`（3 位小数）—— 就是机制 5 最后那次比较的
     * 左操作数（`px / full < SCRIPT_MECH5_SCALEDOWN_RATIO`）。
     *
     * `null` = 上面两个量有任何一个为 `null`（没有墨迹，或没有基准）。
     * 两个高度各舍入到 0.1px 之后才相除，所以 JSON 里这三个数**自洽**：
     * `heightRatio × pageMaxHeight` 就是 `inkHeight`。
     *
     * 为什么比值比坐标多留 2 位小数：这份真实数据里两个**待定读数**相隔
     * 只有 0.047（`2` 用全页最大 23 → 0.496；只认「21+」那个最保守的
     * 读数 → 0.543）。1 位小数会把两者都写成 0.5，恰好抹掉要看的差别。
     */
    heightRatio: number | null;
  }[];
  /** 整串逐字符置信度是否齐备；缺一个则为 `false`（`AttachedChars` 同一规则） */
  charConfidencesComplete?: boolean;
}

/** 一个词相对**本行基线**的实测几何：定阈值要看的正是这几个数 */
export interface OcrStructureLineStat {
  /** 词在 `words` 里的下标 */
  i: number;
  text: string;
  height: number;
  /** 中心相对本行基线的纵向偏移（正 = 更靠下/更低） */
  centerShift: number;
  /** 大致的基线偏移：按「基线 ≈ 基字下沿」估，正 = 更靠下 */
  baselineShift: number;
  /** 高度相对本行最大字高的比例（指数通常明显小于 1） */
  heightRatio: number;
  /** 与**左边最近一个更高词**的水平间隙，负数表示重叠 */
  gapToHigherLeft: number | null;
}

/** 成行之后的一行 */
export interface OcrStructureLine {
  text: string;
  /** 行中心 y */
  y: number;
  fontSize: number;
  avgConfidence: number;
  /** 该行纵向跨度 [y0, y1] */
  yRange: [number, number];
  /** 该行横向跨度 [x0, x1] */
  xRange: [number, number];
  /** 行内有序的词下标（顺序就是拼成文本的顺序） */
  wordIndices: number[];
  /** 该行是否被包进了上下标（`hasScripts`） */
  hasScripts: boolean;
  /** 只列**可疑的小字**：比本行基线矮 10% 以上的词 */
  stats: OcrStructureLineStat[];
}

/** 整页结构：这就是「复制识别结构」按钮复制出去的东西 */
export interface OcrStructure {
  kind: 'universal-reader/ocr-structure';
  version: 1;
  /** 构建标识（每次构建不同）—— 用来判断这份导出是哪一版跑出来的 */
  buildId: string;
  pageNum: number;
  /** 画布高度（像素）；判页眉页脚时用的是它 */
  canvasHeight?: number;
  /** 全页「正文字高」估计（出现次数最多、且占比足够高的那个字高） */
  dominantFontSize: number;
  /**
   * 本次识别实际使用的阈值。
   *
   * 写进来是为了让「阈值」与「实测数据」出现在同一份 JSON 里：
   * 收到这份数据的人可以直接把 `words` 里的高度与偏移和这里对比，
   * 判断阈值是松了还是紧了，而不必再去翻源码猜。
   */
  thresholds: {
    /** 候选要有多小：不超过正文字高的这个倍数 */
    scriptMaxFontRatio: number;
    /** 上标的最小上移量（正文字高倍数） */
    scriptSuperShift: number;
    /** 下标的最小下移量（正文字高倍数） */
    scriptSubShift: number;
    /** 水平紧邻上限（较小字高倍数） */
    scriptFragmentGap: number;
    /** 与基字中心距离上限（正文字高倍数），上标/下标分开 */
    scriptSuperBand: number;
    scriptSubBand: number;
    /** 平桶容差（px）：中心 y 相差不超过它的词算同一行 */
    sameLineTolerance: number;
    /**
     * 行基线拟合：拟合线在样本跨距上的总漂移（|slope| × 行宽）
     * 必须超过分桶容差的这个倍数，否则当平直行处理（判据不动）。
     * 行宽归一 → 对画布缩放不敏感。
     */
    baselineMinDriftRatio: number;
    /** 行基线拟合：残差上限（正文字高倍数） */
    baselineMaxResidualRatio: number;
    /** 倾斜行碎片合并：两段水平间隙上限（正文字高倍数） */
    tiltJoinGapRatio: number;
  };
  /** 所有词 */
  words: OcrStructureWord[];
  wordsTotal: number;
  /** 拿到字符级框的词数；0 表示字符级定位这一步没跑成 */
  wordsWithChars: number;
  /** 没拿到字符框的词及各自的原因（`ocrCharBoxes` 的三个失败出口之一） */
  charBoxSkips: { text: string; reason: string }[];
  /** 成行结果 */
  lines: OcrStructureLine[];
  linesTotal: number;
  /** 最终内容块（含 `^{}`/`_{}` 还原后的文本） */
  blocks: { type: string; content: string; hasInlineMath: boolean }[];
  /** 体积控制的如实说明：被裁掉多少、以及为什么 */
  truncated: { wordsDropped: number; linesDropped: number; charBudget: number };
}

/**
 * 单页结构占用的**字符数上限**。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么必须设上限
 * ═══════════════════════════════════════════════════════════════
 *
 * 词级数据很大：一页扫描件常有八百到两千个词，加上成行结构与
 * 每个词相对基线的实测几何，一页 JSON 轻松到几 MB。
 * 这个对象会**一直留在内存里**（不写 IndexedDB —— 参见 `libraryStore`），
 * 所以不设上限就等于让一次识别多占几 MB 常驻内存，
 * 而本应用已经因为内存吃过多次亏（标签页被系统回收、结果全丢）。
 *
 * 16 万字符约 0.32MB（UTF-16），够装下典型一页的完整词表；
 * 真撞上上限时**先丢词表尾部、再丢行明细**，但 `thresholds`、
 * `dominantFontSize`、`blocks` 与 `truncated` 永远保留 ——
 * 「要拿数据定阈值」这件事不能因为超限而失效。
 *
 * 为什么用「累加每条的 JSON 长度」估算而不是 `JSON.stringify` 后量长度：
 * 后者要先构造完整字符串，正好把我们想省的那份内存又分配一遍。
 */
export const OCR_STRUCTURE_CHAR_BUDGET = 160_000;

/** 只保留「比本行基线矮这个比例以上」的词作为可疑小字，避免整行都进 stats */
const SUSPICIOUS_HEIGHT_RATIO = 0.9;

/**
 * 构造一页的导出结构。
 *
 * 纯函数：输入是识别结果与后处理结果，输出是可直接 `JSON.stringify` 的对象。
 * 不传 `charBudget` 就按 `OCR_STRUCTURE_CHAR_BUDGET` 控体积。
 */
export function buildOcrStructure(input: {
  pageNum: number;
  canvasHeight?: number;
  dominantFontSize: number;
  words: OcrWord[];
  /** 成行结果。`wordIndices` 引用的是 `words` 的下标 */
  lines: {
    text: string;
    y: number;
    fontSize: number;
    avgConfidence: number;
    wordIndices: number[];
    hasScripts: boolean;
  }[];
  blocks: Omit<ContentBlock, 'id'>[];
  thresholds?: Partial<OcrStructure['thresholds']>;
  charBudget?: number;
}): OcrStructure {
  const budget = input.charBudget ?? OCR_STRUCTURE_CHAR_BUDGET;

  /**
   * ═══════════════════════════════════════════════════════════════
   * 机制 5 的**页级**字符高度表：复用判据自己那一张，不另建一份
   * ═══════════════════════════════════════════════════════════════
   *
   * `chars[].pageMaxHeight` / `heightRatio` 必须与机制 5 **同源**：
   * 另写一份统计（哪怕口径写得一模一样）迟早会与判据漂移，而漂移之后
   * 导出的数字会「证明」一个判据并没有在做的事 —— 那比没有数据更糟。
   * 所以这里直接调用判据用的那个纯函数 `buildCharSizeTable()`，
   * 输入就是本函数收到的这份 `words`。
   *
   * 为什么重建等于「同一张表」（逐个理由）：
   *  1. `buildCharSizeTable` 是**纯函数**，只读词上旁挂的字符框
   *     （`getAttachedChars`）与 `measurements`，不看行、不看时间、不缓存；
   *  2. `ocrPostProcess.groupWordsIntoLines()` 建表用的是
   *     **同一个数组**（`result.words`）—— 它就是 `ocrResultToBlocks` 之后
   *     交给本函数的那一份；
   *  3. 建行之后到导出之前**没有任何代码修改词或字符框**（页面家具过滤、
   *     构件合并、版面重排动的都是「行」，不是词）。
   * 于是重建出来的表与判据当时用的那张**逐键相同**。这条不变量有测试钉着：
   * `ocrStructure.charSize.test.ts` 里「同一个表」那条用例要求导出中每个
   * 字符的 `pageMaxHeight` 都等于
   * `buildCharSizeTable(words)!.get(charSizeKey(char))`。
   *
   * ⚠️ 为什么**不**把表直接传进来（那才是最字面的"同一张"）：
   * 表是 `groupWordsIntoLines()` 的局部量。要把它交出来，得改
   * `groupWordsIntoLines` → `ocrResultToBlocks` → `buildOcrStructure`
   * 三处签名，也就动了**判据链路**本身的形状。而本任务的前提是
   * 「不改任何判据」—— 「同一个纯函数 + 同一份输入」是零风险的等价物。
   *
   * 拿不到表时（提供字符框的词少于 `SCRIPT_MECH5_MIN_WORDS`）机制 5
   * 本来就不启用：导出里所有字符的 `pageMaxHeight` / `heightRatio` 都是
   * `null` —— 那不是「量到了但是空」，而是**这一页没有基准**。
   */
  const sizeTable = buildCharSizeTable(input.words);

  const wordEntries: OcrStructureWord[] = input.words.map((word, i) => {
    const height = word.bbox.y1 - word.bbox.y0;
    return {
      i,
      text: word.text,
      confidence: Math.round(word.confidence),
      bbox: [round(word.bbox.x0), round(word.bbox.y0), round(word.bbox.x1), round(word.bbox.y1)],
      fontSize: round(word.fontSize),
      height: round(height),
      centerY: round((word.bbox.y0 + word.bbox.y1) / 2),
      /**
       * 字符级框（如果这一页拿到了）。
       *
       * ═══════════════════════════════════════════════════════════════
       * 为什么必须导出它
       * ═══════════════════════════════════════════════════════════════
       *
       * 字符级定位是判断上下标的**唯一依据**，而它整条链路都是
       * 「拿不到就静默退回旧行为」（见 `ocrEngine.attachCharBoxes` 的注释）。
       * 这个设计对用户是对的 —— 少一个字符框不该让整页识别失败；
       * 但**对诊断是灾难**：导出里若没有字符框，就分不清
       * 「功能没跑」「跑了但识别器建不起来」「跑了但没判出上下标」。
       *
       * 实测撞上过这一点：导出的 JSON 里既没有字符框、文本里也没有 `^{}`，
       * 于是完全无从判断是哪一种。加字段比猜便宜得多。
       *
       * ⚠️ 字符框**不在 `word` 上**：`ocrCharBoxes` 刻意用 `WeakMap` 旁挂
       * （没有字符框的词一个额外属性都不加），必须经 `getAttachedChars()` 取。
       * 没有字符框时**不写这个字段**（而不是写空数组）——
       * 「没有字段」与「有字段但为空」是两种不同的事实，前者说明这步没跑成。
       */
      ...(getAttachedChars(word)?.chars?.length
        ? {
            chars: getAttachedChars(word)!.chars.map((c, i) => ({
              char: c.char,
              bbox: [round(c.x0), round(c.y0), round(c.x1), round(c.y1)] as [
                number,
                number,
                number,
                number,
              ],
              /**
               * ⚠️ 每字符置信度必须能看见，否则关于它的每一次讨论都是猜测。
               *
               * 这是被一个真实失败逼出来的字段：上下标判据里那道「位置异常
               * **且** 识别置信度偏低」的门，在用户文档上没挡住 `=`、`+`、`∼`
               * —— 而这些字符**天生**就是识别器没把握的字形。当时要判断是
               * 「系数不对」还是「这个维度根本没用」，**手里一个真实数值都没有**，
               * 只能拿构造数据论证，结果用假设验证了假设。
               *
               * 口径（见 `CtcDecoded.confidences`）：该字符全部触发时间步上
               * argmax 概率的平均值，与 `measurements` 逐位对齐。
               * 空白位与「识别多出被跳过」的位是 `null`。
               */
              confidence: Number.isFinite(getAttachedChars(word)!.confidences?.[i])
                ? Math.round((getAttachedChars(word)!.confidences![i] as number) * 1e4) / 1e4
                : null,
              /**
               * 机制 5 的三个量（像素墨迹高 / 页内同字符最大高 / 两者之比）。
               *
               * ⚠️ 它们**必须**与 `confidence` 放在同一个对象里：判据正是
               * 「置信度足够低 **且** 尺寸比足够小」这条合取式，而下一个要
               * 回答的问题就是「这两个条件该怎么组合」—— 把两个量分放在
               * 两处，就等于又要靠推算去拼它们。三个字段的语义、口径与
               * `null` 的边界见接口声明处的长注释。
               */
              ...charSizesOf(getAttachedChars(word)!, i, sizeTable),
            })),
            // 整串置信度是否齐备，一眼可见：缺一个就不写（与 `AttachedChars` 同一规则）
            charConfidencesComplete: Boolean(getAttachedChars(word)!.confidences),
          }
        : {}),
    };
  });

  /** 本页拿到字符框的词数 —— 一眼看出这一步到底跑没跑成 */
  const wordsWithChars = wordEntries.filter((w) => w.chars?.length).length;

  const lineEntries: OcrStructureLine[] = input.lines.map((line) => {
    const ws = line.wordIndices
      .map((i) => input.words[i])
      .filter((w): w is OcrWord => w !== undefined);
    const heights = ws.map((w) => w.bbox.y1 - w.bbox.y0);
    const maxHeight = heights.length ? Math.max(...heights) : 0;
    // 「本行基线」用**最高的那个词**估计：上下标的定义就是「比它更小」
    const baseWord = ws.find((w) => w.bbox.y1 - w.bbox.y0 === maxHeight);
    const baseCenter = baseWord ? (baseWord.bbox.y0 + baseWord.bbox.y1) / 2 : line.y;
    const baseBottom = baseWord ? baseWord.bbox.y1 : line.y;
    const x0s = ws.map((w) => w.bbox.x0);
    const x1s = ws.map((w) => w.bbox.x1);
    const y0s = ws.map((w) => w.bbox.y0);
    const y1s = ws.map((w) => w.bbox.y1);

    return {
      text: line.text,
      y: round(line.y),
      fontSize: round(line.fontSize),
      avgConfidence: round(line.avgConfidence),
      yRange: [
        round(y0s.length ? Math.min(...y0s) : line.y),
        round(y1s.length ? Math.max(...y1s) : line.y),
      ],
      xRange: [round(x0s.length ? Math.min(...x0s) : 0), round(x1s.length ? Math.max(...x1s) : 0)],
      wordIndices: [...line.wordIndices],
      hasScripts: line.hasScripts,
      stats: line.wordIndices
        .map((i) => {
          const word = input.words[i];
          if (!word) return null;
          const height = word.bbox.y1 - word.bbox.y0;
          if (!(maxHeight > 0) || height >= maxHeight * SUSPICIOUS_HEIGHT_RATIO) return null;

          // 与「左边最近的那个更高的词」的水平间隙：上下标总是紧贴基字，
          // 而**谁是基字**正是最难判的地方，所以把候选与它的间隙一并给出。
          // 找不到更高的词时给 null，而不是编一个 0 —— 数据要如实。
          let left: OcrWord | undefined;
          for (const o of ws) {
            if (o === word) continue;
            if (o.bbox.x1 > word.bbox.x0) continue;
            if (o.bbox.y1 - o.bbox.y0 <= height) continue;
            if (!left || o.bbox.x1 > left.bbox.x1) left = o;
          }

          return {
            i,
            text: word.text,
            height: round(height),
            centerShift: round((word.bbox.y0 + word.bbox.y1) / 2 - baseCenter),
            baselineShift: round(word.bbox.y1 - baseBottom),
            heightRatio: round(height / maxHeight),
            gapToHigherLeft: left ? round(word.bbox.x0 - left.bbox.x1) : null,
          };
        })
        .filter((s): s is OcrStructureLineStat => s !== null),
    };
  });

  const blocks = input.blocks.map((b) => ({
    type: b.type as string,
    content: b.content,
    hasInlineMath: b.metadata.hasInlineMath === true,
  }));

  // ── 体积控制：按预算依次装填，装不下的如实记进 `truncated` ──
  //
  // 顺序刻意是「词表 → 行明细」：要定上下标阈值，最需要的是一页全部词的
  // 高度与位置；行明细是二次加工的结果，缺一部分不影响定量。
  // 而 `thresholds` / `dominantFontSize` / `blocks` 不参与取舍，永远完整。
  const fixedCost = JSON.stringify({
    kind: 'universal-reader/ocr-structure',
    version: 1,
    pageNum: input.pageNum,
    canvasHeight: input.canvasHeight,
    dominantFontSize: round(input.dominantFontSize),
    thresholds: thresholdsOf(input.thresholds),
    blocks,
  }).length;

  let used = fixedCost + 64; // 留一点给外层字段名与 truncated
  const keptWords: OcrStructureWord[] = [];
  for (const entry of wordEntries) {
    const cost = JSON.stringify(entry).length + 1;
    if (used + cost > budget) break;
    used += cost;
    keptWords.push(entry);
  }

  const keptLines: OcrStructureLine[] = [];
  for (const entry of lineEntries) {
    const cost = JSON.stringify(entry).length + 1;
    if (used + cost > budget) break;
    used += cost;
    keptLines.push(entry);
  }

  return {
    kind: 'universal-reader/ocr-structure',
    version: 1,
    /**
     * 构建标识。**这一行是为了不让"你跑的是哪一版"变成猜测。**
     *
     * 实测撞上过：修复已部署（`1deb6c1`，Cloudflare Pages 与 verify 均 success），
     * 但用户导出的结构里仍是修复前的行为（等号被包成 `$^{=}$`）——
     * 唯一解释是浏览器还在用上一版构建（Service Worker 停在中间那一版）。
     *
     * 没有这个字段时，我分不清「修复没生效」与「你还没拿到修复」，
     * 而那两者的下一步动作完全相反：前者要继续改代码，
     * 后者只要刷新。把它写进导出，一眼就能分辨。
     *
     * 取值由 `vite.config.ts` 注入（每次构建不同），因此能唯一对应一次部署。
     */
    buildId: typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'unknown',
    pageNum: input.pageNum,
    canvasHeight: input.canvasHeight,
    dominantFontSize: round(input.dominantFontSize),
    thresholds: thresholdsOf(input.thresholds),
    words: keptWords,
    wordsTotal: wordEntries.length,
    /**
     * 拿到字符级框的词数。
     *
     * **0 与「字段不存在」含义不同**，所以这里单独给一个计数：
     *   · `wordsWithChars > 0` → 字符级定位跑通了；
     *   · `wordsWithChars === 0` → 没跑通（识别器建不起来，或被降档画布等前置条件挡住）。
     * 有了它，下一次导出就能一眼分清"功能没生效"与"生效了但没判出上下标"。
     */
    wordsWithChars,
    /**
     * 取不到字符框的词**各自的原因**。
     *
     * 没有它时，导出只能说明「8/23 拿到了」，而这个事实**不足以定位问题** ——
     * 实测为此连猜两轮（先猜词太宽超出模型上限，被 44px 短词也失败的数据否掉）。
     * 原因本来是采集了的，只是写进了 `console.warn`，而用户看不到控制台。
     */
    charBoxSkips: getCharBoxSkips(),
    lines: keptLines,
    linesTotal: lineEntries.length,
    blocks,
    truncated: {
      wordsDropped: wordEntries.length - keptWords.length,
      linesDropped: lineEntries.length - keptLines.length,
      charBudget: budget,
    },
  };
}

/**
 * 阈值默认值在这里**复制一份**，而不是从 `ocrPostProcess` 导入。
 *
 * 原因：导出结构要能被独立读懂 —— 收到 JSON 的人不该为了知道
 * 「0.9 到底是哪个阈值」再去翻源码。代价是两处可能漂移，
 * 因此 `ocrPostProcess` 在调用时会把真实值显式传进来，
 * 这里的默认值只用于「没传」的兜底，且两者由单元测试锁住一致。
 */
const DEFAULT_THRESHOLDS: OcrStructure['thresholds'] = {
  scriptMaxFontRatio: 0.9,
  scriptSuperShift: 0.25,
  scriptSubShift: 0.18,
  scriptFragmentGap: 0.6,
  scriptSuperBand: 1.5,
  scriptSubBand: 1.2,
  sameLineTolerance: 5,
  baselineMinDriftRatio: 1,
  baselineMaxResidualRatio: 0.35,
  tiltJoinGapRatio: 1.5,
};

function thresholdsOf(over?: Partial<OcrStructure['thresholds']>): OcrStructure['thresholds'] {
  return { ...DEFAULT_THRESHOLDS, ...over };
}

/** 坐标保留 1 位小数：像素级数据到 0.1px 已经足够定阈值，还能省掉大量字符 */
function round(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 10) / 10;
}

/**
 * 比值保留 3 位小数。
 *
 * 为什么比坐标（1 位）多留 2 位：机制 5 在这份真实数据上有两个**待定读数**
 * 相隔只有 0.047 —— 指数里的 `2`（墨迹高 11.4）：用全页最大 `2`（23）算
 * 得 **0.496**，只认「21+」那个最保守的读数则是 **0.543**。1 位小数会把
 * 两者都写成 0.5，恰好抹掉下次要看的那个差别（判据离阈值 0.8 有多远，
 * 全靠这个数）。多 2 位小数的代价是每个字符多几个字节，可以忽略。
 */
function roundRatio(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 1000) / 1000;
}

/**
 * 一个字符的「机制 5 三个量」。
 *
 * 口径与判据**逐条对齐**（不是近似、也不是另写一遍统计）：
 *
 *  · `inkHeight`：`chars[i].y1 - chars[i].y0` —— 与 `buildCharSizeTable`
 *    放进表里的那个像素高**是同一个算式**；`measurements[i]` 为 `null`
 *    （空白位 / 没量到墨迹）时给 `null`，那正是建表的第 1 条过滤规则。
 *    由 `measureCharPixelSpans` 保证「量到墨迹 ⟹ `y1 > y0`」，所以
 *    非 `null` 的 `inkHeight` 一定是正数（有测试钉着这条）。
 *  · `pageMaxHeight`：`sizeTable.get(charSizeKey(char))` —— 连键的算法都是
 *    同一个 `charSizeKey`（只折全角；不折大小写、不归 Unicode 上下标）。
 *  · `heightRatio`：`inkHeight / pageMaxHeight`，即判据最后那次比较的左操作数。
 *
 * 唯一的差别是**显示精度**：两个高度各舍入到 0.1px（本文件既有的省体积
 * 做法），比值再由舍入后的两个数算出。这样做的好处是 JSON 里的三个数
 * **自洽**：`heightRatio × pageMaxHeight` 就是 `inkHeight`，
 * 拿导出数据复核判据的人不必怀疑「这三个数为什么对不上」。
 */
function charSizesOf(
  attached: AttachedChars,
  i: number,
  sizeTable: CharSizeTable | null,
): { inkHeight: number | null; pageMaxHeight: number | null; heightRatio: number | null } {
  const box = attached.chars[i];
  if (!box) return { inkHeight: null, pageMaxHeight: null, heightRatio: null };

  const inkHeight = attached.measurements[i] ? round(box.y1 - box.y0) : null;

  const full = sizeTable?.get(charSizeKey(box.char));
  const pageMaxHeight = typeof full === 'number' && full > 0 ? round(full) : null;

  const heightRatio =
    inkHeight !== null && pageMaxHeight !== null ? roundRatio(inkHeight / pageMaxHeight) : null;

  return { inkHeight, pageMaxHeight, heightRatio };
}
