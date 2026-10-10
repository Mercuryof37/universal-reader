/**
 * 版面包带式公式恢复（跨行大括号的分段函数）—— 纯逻辑层。
 *
 * ═══════════════════════════════════════════════════════════════
 * 解决的是什么（用户实测的第二个症状）
 * ═══════════════════════════════════════════════════════════════
 *
 * 习题页里 `f(x,y) = { 上排 / 下排 }` 这类大括号系统，识别器在
 * **整块裁剪**上只能读出词形错乱的结果（实测得到 `x(c) {。`、
 * `z = {0, ≡x>Y`、`fz(e)= 0`）；而按**行带**拆开、各裁各的再
 * 识别，同样的识别器、同样的 3× 放大，输出立刻变成
 * `fx(x) = fλe−x, x > 0`、`Z = {0, 当X > Y` 这类可用文本。
 *
 * 差别不在识别能力，而在**裁剪方式**：单行识别器的输入高度固定
 * （48px），两行叠在一条裁剪里时无论怎么放大都读不对。所以本模块
 * 只做三件事，全部是「区域 + 像素 → 新区域」的纯计算：
 *
 *  1. `mergeFormulaRegions` —— 版面对同一段公式常给出相互重叠的
 *     多个区域（实测一段公式 3 个），先并成一个；
 *  2. `findInkBands` —— 从墨迹行剖面里切出行带。大括号把两行连在
 *     一起、阈值法切不开时，用「墨迹最少的那一行」当刀口（实测
 *     该位置就是两行的分界：大括号腰最细）；
 *  3. `planRegionReplacement` —— 恢复结果与既有词的替换计划：
 *     垃圾词删掉、被覆盖的旧词删掉、救回词按去重准入。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么坚持纯函数、不碰 ONNX
 * ═══════════════════════════════════════════════════════════════
 *
 * 推理跑不了机器上仍可把边界情况全部钉死（`npx vitest run`），
 * 本机正是这种情况。调用方（`ocrEngine.recoverFormulaRegions`）
 * 只负责裁剪与推理，所有判定逻辑都在这里，可单测、可复算。
 *
 * ⚠️ 这一层是**渐进增强**：任何一步失败都只是「这块没恢复」，
 * 绝不改变其它内容 —— 调用方对此负责，本模块保证不抛错。
 */

import type { OcrWord } from '@/lib/ocrTypes';
import { overlapRatio } from '@/lib/ocrInkRegions';

export interface FormulaBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** 版面模型的区域（只取本模块需要的字段，避免和 layoutAnalysis 循环依赖） */
export interface LayoutRegionLike extends FormulaBox {
  classId?: number;
  label?: string;
  score?: number;
}

/** 版面对「公式」类的标签（与 `layoutAnalysis.LAYOUT_LABELS[7]` 一致） */
const FORMULA_LABEL = 'formula';

/** 判定两个区域属于同一段公式：包含度 ≥ 0.8 或 IoU ≥ 0.35（实测标定） */
const MERGE_OVERLAP = 0.8;
const MERGE_IOU = 0.35;

// ───────────────────────────────────────────────────────────────
// 墨迹网格
// ───────────────────────────────────────────────────────────────

/** 墨迹采样格子边长（像素）。实测值：4px 时行剖面的谷/峰最清晰 */
export const INK_CELL = 4;
/** 深色判定：亮度低于它算墨迹（与字符级坐标的 CHAR_INK_LUMA_THRESHOLD 同口径） */
export const INK_LUMA = 160;

export interface InkGrid {
  x0: number;
  y0: number;
  cell: number;
  cols: number;
  rows: number;
  /** 每格的深色像素数（行优先） */
  counts: Int32Array;
}

/**
 * 把区域裁出来建墨迹网格。坐标已夹到图像边界内。
 * 图像非法 / 区域为空时返回 `cols=0` 的空网格（调用方判空即可）。
 */
export function buildInkGrid(image: ImageData, area: FormulaBox, cell = INK_CELL): InkGrid {
  const empty: InkGrid = { x0: 0, y0: 0, cell, cols: 0, rows: 0, counts: new Int32Array(0) };
  const width = image?.width ?? 0;
  const height = image?.height ?? 0;
  const data = image?.data;
  if (!width || !height || !data) return empty;

  const x0 = Math.max(0, Math.floor(Math.min(area.x0, area.x1)));
  const y0 = Math.max(0, Math.floor(Math.min(area.y0, area.y1)));
  const x1 = Math.min(width, Math.ceil(Math.max(area.x0, area.x1)));
  const y1 = Math.min(height, Math.ceil(Math.max(area.y0, area.y1)));
  if (x1 - x0 <= 0 || y1 - y0 <= 0) return empty;

  const size = Math.max(2, Math.floor(cell));
  const cols = Math.ceil((x1 - x0) / size);
  const rows = Math.ceil((y1 - y0) / size);
  const counts = new Int32Array(cols * rows);

  for (let y = y0; y < y1; y++) {
    const rowOffset = Math.floor((y - y0) / size) * cols;
    for (let x = x0; x < x1; x++) {
      const p = (y * width + x) * 4;
      const luma = 0.299 * (data[p] ?? 0) + 0.587 * (data[p + 1] ?? 0) + 0.114 * (data[p + 2] ?? 0);
      if (luma < INK_LUMA) counts[rowOffset + Math.floor((x - x0) / size)]++;
    }
  }

  return { x0, y0, cell: size, cols, rows, counts };
}

/** 某行「有墨的格子数」 */
function rowInkCounts(grid: InkGrid): number[] {
  const { cols, rows, counts } = grid;
  const out: number[] = new Array(rows).fill(0);
  for (let r = 0; r < rows; r++) {
    let n = 0;
    const base = r * cols;
    for (let c = 0; c < cols; c++) if ((counts[base + c] ?? 0) > 0) n++;
    out[r] = n;
  }
  return out;
}

/** 某列「有墨的格子数」（列剖面，供以后的分列需求与测试用） */
export function columnInkCounts(grid: InkGrid): number[] {
  const { cols, rows, counts } = grid;
  const out: number[] = new Array(cols).fill(0);
  for (let c = 0; c < cols; c++) {
    let n = 0;
    for (let r = 0; r < rows; r++) if ((counts[r * cols + c] ?? 0) > 0) n++;
    out[c] = n;
  }
  return out;
}

// ───────────────────────────────────────────────────────────────
// 行带
// ───────────────────────────────────────────────────────────────

/** 一行算「有墨」所需的最少墨迹格数占比（实测 3%） */
const ROW_INK_SHARE = 0.03;
/** 行带最短高度（格数）：低于此是噪点/笔画末端，不成行 */
const MIN_BAND_ROWS = 3;
/** 允许一个空行以内继续并段：公式的行间隙常常只有 1 格（4px） */
const MAX_GAP_ROWS = 1;
/** 触发行带内峰谷切分的绝对高度下限（像素） */
const MIN_SPLIT_HEIGHT_PX = 60;
/** 触发行带内峰谷切分的相对高度：不到 1.6 倍正文高的带不可能是两行 */
const SPLIT_HEIGHT_RATIO = 1.6;
/** 谷的强度：最小行墨量 ≤ 中位数的这个比例才算「两行的分界」。实测
 *  FXFY 例 16/30 = 0.53（要过），p28 例 9/19 = 0.47（靠谷宽挡，见下）——
 *  强度只拦「浅谷」，真正分辨行界与分数横线的是谷宽 */
const VALLEY_RATIO = 0.55;
/** 谷的宽度：≤ 这个比例的连续低墨行才算「一片谷」 */
const VALLEY_LOW_RATIO = 0.75;
/** 谷的宽度下限（行数）：单行的低墨缺口是分数横线的签名，不是行分界 */
const VALLEY_MIN_LOW_ROWS = 2;
/** 谷的位置：距带两端至少这个比例（防止把边缘的下伸笔画当分界） */
const VALLEY_EDGE_MARGIN = 0.2;
/** 切分后每侧的最小高度（正文高的比例）：20px 的「行」不是行 */
const SPLIT_SIDE_RATIO = 0.7;
/** 无正文字号参考时的每侧最小高度（像素） */
const SPLIT_SIDE_MIN_PX = 24;

/**
 * 从区域的墨迹行剖面里切出**行带**（页坐标）。纯函数。
 *
 * 算法分三层，全部对着实测数据标定（习题 5 页面的四段公式）：
 *
 *  1. **阈值 RLE**：一行的墨迹格数 ≥ `max(2, 3%×列数)` 才算「有墨」；
 *     连续有墨行成带，间隔 ≤1 空行仍并段；不足 3 行的带丢掉。
 *     实测 `0, 其他` 这类窄带、两行之间的大间隙都靠这层切开；
 *  2. **峰谷切分**：大括号把两行连成一条 19 行的长带（阈值法切不开），
 *     此时在「距两端 ≥20% 范围内墨迹最少的行」下刀 —— 实测该位置
 *     就是大括号的腰、即两行的分界。要求谷 ≤ 0.55 倍中位数、带高
 *     ≥ 1.6 倍正文高，且**两侧都 ≥ 0.7 倍正文高**（防止把一行里的
 *     分数/上下标误当两行切开——241 例 `1/2(x+y)` 一行 56px 高，
 *     中段有弱谷，但切完一侧只剩 20px，判据把它挡住）。谷还必须
 *     **连片 ≥2 行**：强度与宽度各司其职 —— 谷要够深（0.55），
 *     更要够宽。实测 FXFY 例的谷 16/30（刚够深）向下连着 22/30
 *     一行，两行连片 → 真行界；28 例的谷 9/19（也够深）却只是
 *     被 16/19 夹住的一行 —— 那是分数横线压出的缝，单行缺口不切
 *     （见 `VALLEY_MIN_LOW_ROWS`）；
 *  3. 结果按从上到下排序，供调用方逐带裁剪识别。
 */
export function findInkBands(
  image: ImageData,
  area: FormulaBox,
  opts: { dominantFontSize?: number } = {},
): FormulaBox[] {
  const grid = buildInkGrid(image, area);
  const { cols, rows, cell, x0, y0 } = grid;
  if (!cols || !rows) return [];

  const profile = rowInkCounts(grid);
  const threshold = Math.max(2, Math.round(cols * ROW_INK_SHARE));
  const inked = profile.map((n) => n >= threshold);

  // 阈值 RLE：记录 [起, 止]（含）行号
  const cores: Array<[number, number]> = [];
  let start = -1;
  let gap = 0;
  for (let r = 0; r < rows; r++) {
    if (inked[r]) {
      if (start < 0) start = r;
      gap = 0;
    } else if (start >= 0) {
      gap++;
      if (gap > MAX_GAP_ROWS) {
        const end = r - gap;
        if (end - start + 1 >= MIN_BAND_ROWS) cores.push([start, end]);
        start = -1;
        gap = 0;
      }
    }
  }
  if (start >= 0) {
    const end = rows - 1 - gap;
    if (end - start + 1 >= MIN_BAND_ROWS) cores.push([start, end]);
  }

  const dominant = Number.isFinite(opts.dominantFontSize) ? (opts.dominantFontSize ?? 0) : 0;
  const minSplitHeight = Math.max(MIN_SPLIT_HEIGHT_PX, dominant > 0 ? dominant * SPLIT_HEIGHT_RATIO : 0);
  const minSide = Math.max(SPLIT_SIDE_MIN_PX, dominant > 0 ? dominant * SPLIT_SIDE_RATIO : 0);

  const bands: FormulaBox[] = [];
  for (const [s, e] of cores) {
    const height = (e - s + 1) * cell;
    let cutRow = -1;

    if (height >= minSplitHeight && e - s + 1 >= MIN_BAND_ROWS * 2) {
      const span = e - s + 1;
      const margin = Math.max(1, Math.floor(span * VALLEY_EDGE_MARGIN));
      const inside: number[] = [];
      for (let r = s + margin; r <= e - margin; r++) inside.push(profile[r] ?? 0);
      if (inside.length >= 3) {
        const sorted = [...inside].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
        let minVal = Infinity;
        let minRow = -1;
        for (let r = s + margin; r <= e - margin; r++) {
          const v = profile[r] ?? 0;
          // 取最小值时偏向带中心（平分时靠中心者优先）
          if (v < minVal) {
            minVal = v;
            minRow = r;
          }
        }
        const upper = (minRow - s) * cell;
        const lower = (e - minRow + 1) * cell;
        if (median > 0 && minVal <= median * VALLEY_RATIO && upper >= minSide && lower >= minSide) {
          // 谷宽判据：从 minRow 向两侧量「≤ 0.75×中位数」的连续行数。
          // 实测：FXFY 谷 y503(22)+y507(16) 两行连片、Z 谷 y650..y662 四行连片
          // → 真行界；而 28 例的谷 y1549(9) 只是被 16/19 夹住的一行 —— 那是
          // 分数横线（横线本身窄，上下就有墨），单行缺口**不切**。
          const lowLimit = median * VALLEY_LOW_RATIO;
          let runStart = minRow;
          while (runStart - 1 >= s && (profile[runStart - 1] ?? 0) <= lowLimit) runStart--;
          let runEnd = minRow;
          while (runEnd + 1 <= e && (profile[runEnd + 1] ?? 0) <= lowLimit) runEnd++;
          if (runEnd - runStart + 1 >= VALLEY_MIN_LOW_ROWS) cutRow = minRow;
        }
      }
    }

    if (cutRow < 0) {
      bands.push({ x0, y0: y0 + s * cell, x1: x0 + cols * cell, y1: y0 + (e + 1) * cell });
      continue;
    }

    // 刀口 = 谷行上一行的下沿（实测：谷行本身归下带时两带的识别都最好）
    const cutY = y0 + (cutRow - 1) * cell;
    bands.push({ x0, y0: y0 + s * cell, x1: x0 + cols * cell, y1: cutY });
    bands.push({ x0, y0: cutY, x1: x0 + cols * cell, y1: y0 + (e + 1) * cell });
  }

  return bands;
}

// ───────────────────────────────────────────────────────────────
// 门控：什么样的区域值得恢复
// ───────────────────────────────────────────────────────────────

/** 区域四周的判定留白：公式区域只框住墨迹，垃圾词框往往更大 */
export function paddedRegion(region: FormulaBox): FormulaBox {
  const w = region.x1 - region.x0;
  const h = region.y1 - region.y0;
  const padX = Math.min(36, Math.max(10, w * 0.05));
  const padY = Math.min(60, Math.max(16, h * 0.35));
  return { x0: region.x0 - padX, y0: region.y0 - padY, x1: region.x1 + padX, y1: region.y1 + padY };
}

/** 「垃圾词」判据：低置信 + 明显大于正文（或极低置信，不论大小） */
export function isGarbageWord(word: OcrWord, dominantFontSize: number): boolean {
  if (!Number.isFinite(word.confidence)) return false;
  if (word.confidence < 50) return true;
  if (word.confidence >= 80) return false;
  return dominantFontSize > 0 && word.fontSize > dominantFontSize * 1.5;
}

/** 词的中心落在区域内的比例（0-1）：判定「这个词属于该区域」 */
export function membershipRatio(word: OcrWord, region: FormulaBox): number {
  const b = word.bbox;
  const w = b.x1 - b.x0;
  const h = b.y1 - b.y0;
  if (w <= 0 || h <= 0) return 0;
  const cx = (b.x0 + b.x1) / 2;
  const cy = (b.y0 + b.y1) / 2;
  const inX = cx >= region.x0 && cx <= region.x1;
  const inY = cy >= region.y0 && cy <= region.y1;
  return inX && inY ? 1 : 0;
}

/** 词的矩形有多少落在区域内（交集 / 词面积） */
export function containmentRatio(word: FormulaBox, region: FormulaBox): number {
  const w = (word.x1 - word.x0) * (word.y1 - word.y0);
  if (w <= 0) return 0;
  const ix = Math.min(word.x1, region.x1) - Math.max(word.x0, region.x0);
  const iy = Math.min(word.y1, region.y1) - Math.max(word.y0, region.y0);
  if (ix <= 0 || iy <= 0) return 0;
  return (ix * iy) / w;
}

/** 只由标点/括号/符号组成（没有字母、数字、CJK、希腊字母） */
export function isPunctuationOnly(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return !/[A-Za-z0-9\u4e00-\u9fff\u0370-\u03ff\uFF10-\uFF19\uFF21-\uFF3A\uFF41-\uFF5A]/.test(t);
}

/** 区域内「属于本区域」的垃圾词（词大部分落在留白区域里） */
export function findGarbageWordsInRegion(
  region: FormulaBox,
  words: readonly OcrWord[],
  dominantFontSize: number,
): OcrWord[] {
  const padded = paddedRegion(region);
  return words.filter(
    (w) => isGarbageWord(w, dominantFontSize) && containmentRatio(w.bbox, padded) >= 0.5,
  );
}

/** 区域内「只由标点组成、且基本落在区域里」的碎片词（大括号下半边等） */
export function findFragmentWordsInRegion(
  region: FormulaBox,
  words: readonly OcrWord[],
): OcrWord[] {
  return words.filter(
    (w) => isPunctuationOnly(w.text) && membershipRatio(w, region) >= 1 && overlapRatio(w.bbox, region) >= 0.6,
  );
}

/**
 * 「有墨迹但没有任何词覆盖」的格子占墨迹格子的比例。
 * 洞的比例够大（≥ `HOLE_MIN_RATIO`）说明这块区域有内容整个没被认出来。
 */
export const HOLE_MIN_RATIO = 0.15;

export function holeRatio(
  grid: InkGrid,
  words: readonly OcrWord[],
  cloaked: readonly OcrWord[] = [],
): number {
  const { x0, y0, cell, cols, rows, counts } = grid;
  if (!cols || !rows) return 0;

  const covered = new Uint8Array(cols * rows);
  const markAll = [...words, ...cloaked] as readonly { bbox: OcrWord['bbox'] }[];
  for (const w of markAll) {
    const b = w?.bbox;
    if (!b) continue;
    const c0 = Math.max(0, Math.floor((Math.min(b.x0, b.x1) - x0) / cell));
    const c1 = Math.min(cols - 1, Math.floor((Math.max(b.x0, b.x1) - x0) / cell));
    const r0 = Math.max(0, Math.floor((Math.min(b.y0, b.y1) - y0) / cell));
    const r1 = Math.min(rows - 1, Math.floor((Math.max(b.y0, b.y1) - y0) / cell));
    if (!Number.isFinite(c0) || !Number.isFinite(c1) || !Number.isFinite(r0) || !Number.isFinite(r1)) continue;
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) covered[r * cols + c] = 1;
  }

  let inked = 0;
  let missed = 0;
  for (let i = 0; i < counts.length; i++) {
    if ((counts[i] ?? 0) <= 0) continue;
    inked++;
    if (!covered[i]) missed++;
  }
  return inked ? missed / inked : 0;
}

export type GateReason = 'garbage' | 'hole' | 'fragment';

export interface RegionGateDecision {
  fire: boolean;
  reason: GateReason | null;
  reasonText: string;
  garbageWords: OcrWord[];
  fragmentWords: OcrWord[];
  hole: number;
}

/**
 * 区域是否值得恢复 + 触发原因（纯投影，不做任何修改）。
 *
 * 三条原因对应实测的三种形态：
 *  · `garbage`：区域被**低置信的垃圾词**覆盖（`Z= 当X>Y`、`fz(e)= 0`）
 *    —— 删掉重认；
 *  · `hole`：区域里有整块墨迹没被任何词覆盖（241 题左半边）
 *    —— 补齐；
 *  · `fragment`：区域内只有标点碎片词（大括号下半边被读成 `）`）
 *    —— 借恢复顺带清掉。**门槛刻意保守**：≥2 个碎片、或 1 个碎片
 *    且还有明显空洞（≥ 半个 `HOLE_MIN_RATIO`）才触发 —— 洁净页面上
 *    一个独立的 `=` 也是「标点词」，绝不能因为它在公式区域里就把
 *    整段重认一遍：重认会丢掉这些词已有的字符级坐标，而上下标的
 *    渲染正是靠字符框（错的替换比不替换更糟）。
 */
export function regionGateDecision(
  region: FormulaBox,
  words: readonly OcrWord[],
  grid: InkGrid,
  dominantFontSize: number,
): RegionGateDecision {
  const garbageWords = findGarbageWordsInRegion(region, words, dominantFontSize);
  const fragmentWords = findFragmentWordsInRegion(region, words);
  const hole = holeRatio(grid, words);

  if (garbageWords.length) {
    return {
      fire: true,
      reason: 'garbage',
      reasonText: `${garbageWords.length} 个垃圾词（如「${garbageWords[0]?.text ?? ''}」）`,
      garbageWords,
      fragmentWords,
      hole,
    };
  }
  if (hole >= HOLE_MIN_RATIO) {
    return {
      fire: true,
      reason: 'hole',
      reasonText: `${Math.round(hole * 100)}% 的墨迹没有词覆盖`,
      garbageWords,
      fragmentWords,
      hole,
    };
  }
  if (fragmentWords.length >= 2 || (fragmentWords.length === 1 && hole >= HOLE_MIN_RATIO * 0.5)) {
    return {
      fire: true,
      reason: 'fragment',
      reasonText: `${fragmentWords.length} 个标点碎片词`,
      garbageWords,
      fragmentWords,
      hole,
    };
  }
  return { fire: false, reason: null, reasonText: '无垃圾词、无空洞', garbageWords, fragmentWords, hole };
}

// ───────────────────────────────────────────────────────────────
// 合并：版面对同一公式给出的多个区域
// ───────────────────────────────────────────────────────────────

function interArea(a: FormulaBox, b: FormulaBox): number {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  return w > 0 && h > 0 ? w * h : 0;
}

/** 只挑「公式」标签的合法区域，按包含度/IoU 并组 */
export function mergeFormulaRegions(regions: readonly LayoutRegionLike[]): FormulaBox[] {
  const seeds = regions
    .filter(
      (r) =>
        r?.label === FORMULA_LABEL &&
        Number.isFinite(r.x0) &&
        Number.isFinite(r.y0) &&
        Number.isFinite(r.x1) &&
        Number.isFinite(r.y1) &&
        r.x1 > r.x0 &&
        r.y1 > r.y0,
    )
    .map((r) => ({ x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1 }));
  if (!seeds.length) return [];

  const parent = seeds.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root] ?? root;
    let cur = i;
    while (parent[cur] !== cur) {
      const next = parent[cur] ?? cur;
      parent[cur] = root;
      cur = next;
    }
    return root;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  for (let i = 0; i < seeds.length; i++) {
    for (let j = i + 1; j < seeds.length; j++) {
      const a = seeds[i]!;
      const b = seeds[j]!;
      const inter = interArea(a, b);
      if (!inter) continue;
      const areaA = (a.x1 - a.x0) * (a.y1 - a.y0);
      const areaB = (b.x1 - b.x0) * (b.y1 - b.y0);
      const iou = inter / (areaA + areaB - inter);
      if (overlapRatio(a, b) >= MERGE_OVERLAP || iou >= MERGE_IOU) union(i, j);
    }
  }

  const groups = new Map<number, FormulaBox>();
  for (let i = 0; i < seeds.length; i++) {
    const s = seeds[i]!;
    const root = find(i);
    const g = groups.get(root);
    groups.set(
      root,
      g
        ? { x0: Math.min(g.x0, s.x0), y0: Math.min(g.y0, s.y0), x1: Math.max(g.x1, s.x1), y1: Math.max(g.y1, s.y1) }
        : { ...s },
    );
  }

  return [...groups.values()].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
}

// ───────────────────────────────────────────────────────────────
// 替换计划
// ───────────────────────────────────────────────────────────────

/** 匹配用折叠：去空白 + 全角 ASCII 转半角（`0，其他` ≡ `0,其他`） */
export function foldForMatch(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x3000 || /\s/.test(ch)) continue;
    if (code >= 0xff01 && code <= 0xff5e) out += String.fromCodePoint(code - 0xfee0);
    else out += ch;
  }
  return out;
}

export function foldedContains(haystack: string, needle: string): boolean {
  const n = foldForMatch(needle);
  if (!n) return false;
  return foldForMatch(haystack).includes(n);
}

export interface ReplacementDrop {
  word: OcrWord;
  reason: 'garbage' | 'duplicate' | 'fragment';
}

export interface ReplacementPlan {
  survivors: OcrWord[];
  recovered: OcrWord[];
  drops: ReplacementDrop[];
}

/**
 * 恢复结果与既有词的替换计划（纯函数，不做任何原地修改）。
 *
 * 删除既有词只走三条明确的理由：
 *
 *  · `garbage`：本区域自己的垃圾词（`garbageWords` 由门控给出）——
 *    它在留白区域里占比 ≥ 50%，判定它属于这段公式；
 *  · `duplicate`：救回文本**包含**该词文本、且两者有交叠 —— 内容
 *    已经被救回词覆盖，留着会重复（实测 `x>0`、`0,其他` 这类短词）；
 *    纯几何覆盖不算数：识别退化的救回文本可能不包含好词，删了会丢内容；
 *  · `fragment`：只由标点组成、且基本落在区域内的碎片词（大括号
 *    下半边被读成的 `）`）。
 *
 * 救回词准入：与任何**幸存词**高度交叠（≥0.5）时丢弃救回词。
 * 能走到这里的救回词，重叠的碎片基本已经被 duplicate 臂按文本
 * 包含关系清掉了；剩下的几何重叠意味着救回词不比幸存词更好
 * （截断/误读），此时保幸存词——救回词文本与幸存词无关时准入，
 * 下游会看到两段交叠文字，那是"重复"这类更糟的错误。
 * 救回词之间同样去重。
 * 结果顺序稳定：幸存词保持原顺序，救回词按传入顺序追加。
 */
export function planRegionReplacement(
  region: FormulaBox,
  words: readonly OcrWord[],
  recovered: readonly OcrWord[],
  opts: { dominantFontSize: number; garbageWords?: readonly OcrWord[] },
): ReplacementPlan {
  if (!recovered.length) return { survivors: [...words], recovered: [], drops: [] };

  const garbage = new Set(opts.garbageWords ?? findGarbageWordsInRegion(region, words, opts.dominantFontSize));
  const drops: ReplacementDrop[] = [];
  const survivors: OcrWord[] = [];

  for (const w of words) {
    if (garbage.has(w)) {
      drops.push({ word: w, reason: 'garbage' });
      continue;
    }

    let duplicate = false;
    for (const r of recovered) {
      if (!foldedContains(r.text, w.text)) continue;
      if (overlapRatio(w.bbox, r.bbox) <= 0) continue;
      duplicate = true;
      break;
    }
    if (duplicate) {
      drops.push({ word: w, reason: 'duplicate' });
      continue;
    }

    if (isPunctuationOnly(w.text) && overlapRatio(w.bbox, region) >= 0.6) {
      drops.push({ word: w, reason: 'fragment' });
      continue;
    }

    survivors.push(w);
  }

  const admitted: OcrWord[] = [];
  for (const r of recovered) {
    if (survivors.some((w) => overlapRatio(r.bbox, w.bbox) >= 0.5)) continue;
    if (admitted.some((w) => overlapRatio(r.bbox, w.bbox) >= 0.5)) continue;
    admitted.push(r);
  }

  return { survivors, recovered: admitted, drops };
}

// ───────────────────────────────────────────────────────────────
// 双读数择优：同一行带换一个裁剪尺度重认，取信息更全的那份
// ───────────────────────────────────────────────────────────────

/**
 * 记号字符集 —— 择优判据的第一把尺。
 *
 * 公式的信息几乎全在这些字符上（关系号、正负号、括号），而识别退化
 * 最典型的形态就是**丢记号**（`e^{−λx}` → `e^{λx}`、`x ≤ 0` → `x0`）。
 *
 * 刻意**不含**三类字符，全部有实测理由：
 *  · `^`：坏读数把它当指数占位符吐出来（实测 `µe−^` vs 好读数
 *    `µe−µy`）——它出现在坏读数里，计进去会让坏读数多一个假记号，
 *    正好把「按记号择优」判反；
 *  · `,`：两种读数各有一份，计数差为零（实测），只会扩大误判面；
 *  · `/` `_`：同上，实测两读数净差为零。
 */
const NOTATION_CHARS = new Set('=<>≤≥−-±×÷√{}[]()');

/** 读数里记号字符的个数 */
export function notationCount(text: string): number {
  let n = 0;
  for (const ch of text ?? '') if (NOTATION_CHARS.has(ch)) n++;
  return n;
}

/** 读数里的字母数字序列（照原顺序，去掉一切其它字符） */
export function alnumSequence(text: string): string {
  let out = '';
  for (const ch of text ?? '') if (/[\p{L}\p{N}]/u.test(ch)) out += ch;
  return out;
}

/** `needle` 是否是 `haystack` 的子序列（顺序一致，可跳过字符） */
export function isSubsequence(needle: string, haystack: string): boolean {
  if (!needle) return true;
  let i = 0;
  for (const ch of haystack) {
    if (ch === needle[i]) {
      i++;
      if (i >= needle.length) return true;
    }
  }
  return false;
}

/** 新读数至少要新增的字母数字个数（1 个的增益实测是垃圾插入，2 个起才是内容补全） */
const ALNUM_GAIN_MIN = 2;

/**
 * 行带的第二个读数（横向扩边裁剪 + 2× 放大）是否比第一个（现行裁剪
 * 3×）**严格更好**，可以顶替它。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么需要这条规则（实测，2026-10-10 分辨率/取景实验）
 * ═══════════════════════════════════════════════════════════════
 *
 * 公式行带的裁剪尺度与左右留白都是**真实的质量杠杆**，而且没有哪个
 * 组合全面更好（Q20 上排：3× 紧裁剪丢指数 `λe−x`，2× 横向扩边
 * 8% 读回 `λe−λx`；Q20 下排 `f_Y(y)` 标签则只有部分取景读得对）。
 * 取景相差 2px 就能翻转输出（实测），所以只能逐带比：新读数要拿出
 * **可验证的增益证据**才允许顶替现行读数。
 *
 * 判据三条，对着实测的全部读数对标定（4 段公式区域 × 各 2 行带 ×
 * 三种裁剪）：
 *
 *  1. **内容保留**：旧读数的字母数字序列是新读数序列的子序列 ——
 *     新读数是「补全」不是「重写」。`fx`→`fy` 这类同长改写、
 *     中途丢内容的截断都在这一步挡回（实测 Q20 下排 `fy(y)` vs
 *     `fx(y)` 就是靠这条挡住「看起来更整齐」的错误顶替）；
 *  2. **至少新增 2 个字母数字**：实测 +1 的增益是垃圾插入
 *     （`e > (λe−x...` 凭空多一个 `e`），+3 的增益是真内容
 *     （`λe−λx` 的 `λx` 与 `µe−µy` 的 `µy`）。1 与 3 在唯一
 *     正例/反例上各归一边，取 2 当中线；
 *  3. **记号不减**：新读数的记号个数 ≥ 旧读数（见 `NOTATION_CHARS`
 *     的设计说明）。增益必须在内容上，丢一个真记号换两个字母
 *     不算优化。
 *
 * 反例保护：两读数相同、空读数、只多出逗号/空格/噪点都在上面挡回。
 * **故意不放松** —— 现行 3× 读数是生产上验证过的基线，宁漏不错。
 */
export function preferRicherReading(primary: string, alternate: string): boolean {
  if (!alternate?.trim()) return false;
  if (alternate === primary) return false;
  const p = alnumSequence(primary);
  const a = alnumSequence(alternate);
  if (a.length < p.length + ALNUM_GAIN_MIN) return false;
  if (!isSubsequence(p, a)) return false;
  return notationCount(alternate) >= notationCount(primary);
}

/** 第二读数裁剪的横向扩边比例（带宽的 8%，实测 Q20 上排的获胜取景） */
export const ALTERNATE_BAND_PAD_RATIO = 0.08;
/** 横向扩边的下限（像素）：窄带的 8% 太小，撑不出识别器需要的两端留白 */
export const ALTERNATE_BAND_MIN_PAD = 16;

/**
 * 第一读数的第二候选裁剪框：**只在左右扩边、上下不动**。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么只扩左右（实测，2026-10-10）
 * ═══════════════════════════════════════════════════════════════
 *
 * 行带是**水平切片**：上下紧贴行墨迹，扩就会切进相邻行（实测行带
 * 上下的相邻行正是同一段公式的另一半）——现有裁剪对分带用 0 留白
 * 正是这个原因。而左右是空档：实测 Q20 上排把左右各扩 8% 得到
 * `(λe−λx, x > 0 (µe−µy, y> 0` 的完整读数，紧边裁剪则丢指数
 * （`λe−x`）。识别器在窄条两端需要留白才能把候选框切干净。
 *
 * 纯函数：返回夹到页面内的框，不分配画布。宽度不成框时返回 null。
 */
export function alternateBandBox(band: FormulaBox, pageWidth: number): FormulaBox | null {
  const width = band.x1 - band.x0;
  if (!(width > 0) || !(band.y1 > band.y0) || !(pageWidth > 0)) return null;
  const pad = Math.max(ALTERNATE_BAND_MIN_PAD, Math.round(width * ALTERNATE_BAND_PAD_RATIO));
  const x0 = Math.max(0, Math.floor(band.x0 - pad));
  const x1 = Math.min(pageWidth, Math.ceil(band.x1 + pad));
  if (x1 - x0 <= 0) return null;
  return { x0, y0: band.y0, x1, y1: band.y1 };
}
