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
import { getAttachedChars, getCharBoxSkips } from '@/lib/ocrCharBoxes';

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
  chars?: { char: string; bbox: [number, number, number, number] }[];
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
            chars: getAttachedChars(word)!.chars.map((c) => ({
              char: c.char,
              bbox: [round(c.x0), round(c.y0), round(c.x1), round(c.y1)] as [
                number,
                number,
                number,
                number,
              ],
            })),
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
};

function thresholdsOf(over?: Partial<OcrStructure['thresholds']>): OcrStructure['thresholds'] {
  return { ...DEFAULT_THRESHOLDS, ...over };
}

/** 坐标保留 1 位小数：像素级数据到 0.1px 已经足够定阈值，还能省掉大量字符 */
function round(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 10) / 10;
}
