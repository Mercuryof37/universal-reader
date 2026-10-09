/**
 * 第二意见：用 tesseract.js 的字符框（`hocr_char_boxes`）复核角标候选段。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么需要「第二个引擎」（这是路径 B 被选中的全部理由）
 * ═══════════════════════════════════════════════════════════════
 *
 * `ocrCharBoxes` 的机制 1~5 全部建立在**同一次识别**的产出上：CTC 时间步
 * 给横向、逐列墨迹给纵向、置信度来自同一个解码器、页级高度表也来自
 * 同一批框。零新依赖是它的好处，代价是**同一套系统偏差会被四条判据
 * 一起继承**。实测就撞上了：第 1 词的真指数 `x+y−2` 被机制 2（置信度
 * 0.99+，太高）与机制 5（`+`/`−` 在整页只以缩小形态出现）联手拒掉，
 * 五个字符一个不剩 —— 而它是全页唯一真实的公式角标。
 *
 * `docs/字符级OCR技术调研.md` 的路径 B 给的解法就是**换一个引擎问一次**：
 * tesseract.js 的 `hocr_char_boxes` 能逐字符输出框。代价是 +5.2MB
 * 自托管资产（`public/tess-core`、`public/tess`、`public/tessdata`，
 * 由 `scripts/fetch-tess-assets.mjs` 落盘、全部同源、**懒加载**）。
 *
 * ⚠️ 它的定位是**只做第二意见，不替换**（调研文档的原话）：
 *   · 主识别的文本、词框、置信度**一个都不动**；
 *   · 它只在 `findRescuableRuns` 已经圈出候选段之后才被调用（预筛在
 *     `attachTesseractEvidence` 里，整页通常只有一两个词会走到这里）；
 *   · 它的结论只是一个「这几段可以救回」的开关（见 `classifyCharsByGeometry`
 *     的 `evidence` 参数），不参与任何文字的产生。
 *
 * ═══════════════════════════════════════════════════════════════
 * 实测得到的运行点（不是抄文档，是在用户真实作业页上量出来的）
 * ═══════════════════════════════════════════════════════════════
 *
 *  · **语言只认 eng**：`chi_sim+eng` 在 tesseract.js v7 上直接加载失败
 *    （worker 抛错）。而这里只做几何复核、不采信它的文本，eng 够用，
 *    也省掉一份 44MB 的中文字典；
 *  · **放大 4 倍 + PSM 7（单行）**：2 倍时指数的笔画连成一片（分不出
 *    `x`/`y`），4 倍才把五个字形逐个分开；PSM 7 把裁剪当成一整行，
 *    这是词级裁剪唯一正确的假设（整页 PSM 3 会按列切块）；
 *  · **只取几何、不取文本**：tesseract 在这批数据上把 `x+y` 认成 `"`、
 *    把 `²` 认成 `*`。它的**框**是准的，它的**字**是错的 ——
 *    所以本模块的产出里只有 `InkEvidenceBox`（坐标），**一个字都不取自它**。
 *
 * ═══════════════════════════════════════════════════════════════
 * 证据判据（与 tesseract 自己的上下标标记无关）
 * ═══════════════════════════════════════════════════════════════
 *
 * 先试过走它的现成标记（`blocks` 输出里的 `is_superscript` / `is_subscript`），
 * 在三个真实区域上**全部为 0**（`.spike/tess-sup.mjs`）—— 那条路不通。
 * 所以证据由本模块自己按几何算，与机制 1 **同形**但**独立**：
 *
 *     fullH    = 本次裁剪里所有字符框的最大高度
 *     baseline = 「高度 ≥ 0.6×fullH」的那些字符的底边**中位数**
 *     证据框   = 高度 ≤ 0.6×fullH **且** 底边 ≤ baseline − 0.25×fullH
 *
 * 「独立」的意思：参照物是 tesseract 自己在这一小块里量到的字，
 * 完全不用 CTC 的 `mainHeight` / `baseline`。两个引擎在同一处**各自**
 * 得出「这里有小而抬高的墨迹」，才算一次独立确认。
 *
 * 实测（`.spike/tess-verify.mjs`，三个区域逐字符打印，4 倍/PSM7/eng）：
 *   · 区域 A（第 1 词整行）→ 4 个证据框，其中 `"`x[1184,1216] 与
 *     `2`x[1235,1242] 正压在指数 `x+y−2` 上；
 *   · 区域 B（第 16 词）→ **0 个**；
 *   · 区域 C（第 20 词）→ 3 个，**全部压在三个 `∼` 上**（它们是误判候选）。
 * 后两条（B 的 0 个、C 的 3 个）正是 `findRescuableRuns` 必须同时要
 * (b)「≥2 个确实被缩小的字母数字」与 (c)「≥2 个字符被证据框覆盖」的
 * 实测原因 —— 单靠 C 会把 `=∼∼∼` 救回来，单靠 B 会把 `2+Y` 救回来。
 *
 * ═══════════════════════════════════════════════════════════════
 * 三层「不拖累主流程」（与 `attachCharBoxes` 同一套写法）
 * ═══════════════════════════════════════════════════════════════
 *
 *  1. worker 建不起来（资产没下下来 / WASM 被拦 / 浏览器不支持）→
 *     记下失败、返回 0，**不再重试**（否则每个词都白等一次超时）；
 *  2. 每个词独立 try/catch：一个词的裁剪或识别炸了，只是这个词没有
 *     第二意见，其余词照常；
 *  3. 不改 `OcrWord`：证据挂在 `WeakMap` 上，没有证据的词与改动前
 *     **逐字节相同**（这也是「拿不到证据 = 救回机制不启用」的实现，
 *     判据那边用 `evidence?.length` 显式守着）。
 */
import {
  blitResized,
  defaultCanvasFactory,
  findRescuableRuns,
  getAttachedChars,
  type CanvasFactory,
  type CharSizeTable,
  type InkEvidenceBox,
  type OcrCanvasLike,
} from '@/lib/ocrCharBoxes';
import type { OcrWord } from '@/lib/ocrTypes';

// ───────────────────────────────────────────────────────────────
// 运行点常量（每一个都有实测依据，见文件顶部）
// ───────────────────────────────────────────────────────────────

/** 裁剪放大倍数。实测：2 倍分不开指数笔画，4 倍可以 */
export const TESS_UPSCALE = 4;

/**
 * 放大后的宽度上限：超过就按比例降档。
 *
 * 6180 这个数来自实测：第 1 词整行裁剪 ≈1545px 宽（区域 A 的实际宽度），
 * 4 倍后 ≈6180px —— 这一档是**量过的、能出正确几何的最大档**，
 * 再大只是白烧内存；更宽的词（超过这个宽度）只好降档，
 * 降档到 2 倍以下时分不开笔画，那时宁可跳过这个词（见 `onSkip`）。
 */
export const TESS_MAX_UPSCALED_WIDTH = 6200;

/** 裁剪留白：纵向给足（上下标贴边），横向只留一点点（PSM 7 会吃掉边缘） */
const TESS_PAD_Y_RATIO = 0.15;
const TESS_PAD_X_RATIO = 0.02;
/** 放大后仍小于这个宽度的裁剪不值得跑（一两个字形，PSM 7 会瞎猜） */
const TESS_MIN_UPSCALED_WIDTH = 64;
/** 词框小于这个尺寸直接跳过（与 `attachCharBoxes` 的 minCropPixels 同一量级） */
const TESS_MIN_WORD_WIDTH = 8;

/** 证据判据的三个比例（实测依据见文件顶部） */
const TESS_EVIDENCE_FULL_RATIO = 0.6;
const TESS_EVIDENCE_SMALL_RATIO = 0.6;
const TESS_EVIDENCE_RAISED_RATIO = 0.25;

// ───────────────────────────────────────────────────────────────
// 证据框的登记处（WeakMap：不往 OcrWord 上加字段）
// ───────────────────────────────────────────────────────────────

/**
 * 证据登记处。WeakMap 的键就是 `OcrWord` 本体 —— 词被回收时证据自然消失，
 * 不会把整页的词都钉在内存里（与 `attachCharBoxes` 的 `charBoxRegistry`
 * 同一套做法、同一个理由）。
 */
let evidenceRegistry = new WeakMap<OcrWord, InkEvidenceBox[]>();

/** 取一个词的证据框；没有就是 `undefined`（判据据此不启用救回） */
export function getTesseractEvidence(word: OcrWord): InkEvidenceBox[] | undefined {
  return evidenceRegistry.get(word);
}

/**
 * 清空全部证据（**每一页开始时**调用，与 `clearCharBoxSkips` 同一时机）。
 *
 * ⚠️ 只清证据、**不动 worker**：worker 里装着已加载的语言与建好的
 * WASM 运行时，销毁重建意味着每页重下一次 IndexedDB、重写一次
 * WASM 文件系统（秒级代价），而证据本身就是「按词」挂的 ——
 * 词换了，旧证据就不可能再被查到。两件事的时机不同，就不该在
 * 同一个函数里做。
 */
export function clearTesseractEvidence(): void {
  // WeakMap 没有 clear：换一个实例，旧的自然被回收
  evidenceRegistry = new WeakMap();
}

/**
 * 彻底重置（**换文档 / 引擎销毁**时调用）：连 worker 一起丢掉。
 *
 * 至于 terminate 的等待：故意**不等**（不 `await`）。调用点在
 * `ocrEngine.terminate()` 这类同步清理里，等一个 WASM 线程的收尾
 * 只会拖慢退出；`terminate()` 本身是幂等的、失败也无所谓，
 * 所以这里静默吞掉。
 */
export function resetScriptSecondOpinion(): void {
  const pending = workerPromise;
  workerPromise = null;
  void pending?.then((worker) => worker.terminate().catch(() => undefined)).catch(() => undefined);
  clearTesseractEvidence();
}

// ───────────────────────────────────────────────────────────────
// worker 生命周期（懒建 + 失败不再重试）
// ───────────────────────────────────────────────────────────────

type TessWorker = {
  setParameters(params: Record<string, string>): Promise<unknown>;
  recognize(
    image: OcrCanvasLike | string,
    options?: Record<string, unknown>,
    output?: Record<string, boolean>,
  ): Promise<{ data: { hocr?: string | null } }>;
  terminate(): Promise<unknown>;
};

/**
 * 建 worker 与「是否重试」的策略：与 `ocrEngine.ensureCharBoxRecognizer`
 * 逐条一致 —— 一旦失败就**记住这个失败的 promise**，后续调用直接拿到
 * 同一个拒绝，不会一次又一次地重下资产。
 */
let workerPromise: Promise<TessWorker> | null = null;

async function ensureTessWorker(): Promise<TessWorker> {
  if (!workerPromise) {
    workerPromise = (async () => {
      const { createWorker } = await import('tesseract.js');
      /**
       * 全部路径都指向**同源自托管资产**（`scripts/fetch-tess-assets.mjs`
       * 落盘、`.gitignore` 排除、构建时预打包进 `dist/`）。
       *
       * ⚠️ 必须是绝对路径（`/tess-core` 这样）：资源由**主线程**的
       * `resolvePaths` 解析（`new URL(s, window.location.href)`），
       * 而 worker 本身是 blob URL —— blob 不能当相对路径的基。
       * `workerBlobURL: true` 下 `importScripts` 只吃绝对地址。
       */
      const worker = (await createWorker('eng', 1, {
        workerPath: '/tess/worker.min.js',
        corePath: '/tess-core',
        langPath: '/tessdata',
        gzip: true,
        // 默认值，写出来是为了让「换语言不用重新下载」这件事显式
        cacheMethod: 'write',
        workerBlobURL: true,
      })) as unknown as TessWorker;

      await worker.setParameters({
        // ⭐ 逐字符框就靠这个参数（默认关）
        hocr_char_boxes: '1',
        // 单行：词级裁剪唯一正确的假设
        tessedit_pageseg_mode: '7',
        // 关掉词典偏置，让罕见字形（`∼`、`−`）正常出框 —— 这里不采信文本，
        // 但偏置会改变**切字**的方式，进而改变框。
        load_system_dawg: '0',
        load_freq_dawg: '0',
      });
      return worker;
    })();
    // 失败也留着这个 promise：下一次 await 直接拿到同一个拒绝
    workerPromise.catch(() => undefined);
  }
  return workerPromise;
}

// ───────────────────────────────────────────────────────────────
// hOCR 解析（只取 ocrx_cinfo 的 x_bboxes）
// ───────────────────────────────────────────────────────────────

/** 一个字符框：hOCR 的 `ocrx_cinfo` 给出的像素范围（**传进去那张图**的坐标） */
export interface HocrCharBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * 从 hOCR 里取逐字符框。
 *
 * 只看 `ocrx_cinfo`（tesseract 的「字符信息」span，只有开了
 * `hocr_char_boxes` 才有）：它的 `title` 是
 * `x_bboxes x0 y0 x1 y1; x_conf N`。**不取 `ocrx_word` 的 `bbox`** ——
 * 词框是字框的并集，拿它当证据等于把整个词当成「一个很小的字」。
 *
 * ⚠️ 坐标就是**传进去那张图**的像素（我们传的是放大后的裁剪），
 * 调用方负责除以放大倍数、加回裁剪原点。
 */
export function parseHocrCharBoxes(hocr: string): HocrCharBox[] {
  const out: HocrCharBox[] = [];
  if (!hocr) return out;
  const re = /<span class='ocrx_cinfo'[^>]*title='([^']*)'/g;
  for (const m of hocr.matchAll(re)) {
    const title = m[1] ?? '';
    const b = /x_bboxes\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/.exec(title);
    if (!b) continue;
    const x0 = Number(b[1]);
    const y0 = Number(b[2]);
    const x1 = Number(b[3]);
    const y1 = Number(b[4]);
    if (!(x1 > x0) || !(y1 > y0)) continue;
    out.push({ x0, y0, x1, y1 });
  }
  return out;
}

function medianOf(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0);
}

/**
 * 从一批**裁剪内**字符框里挑出「小而抬高」的证据框（判据见文件顶部）。
 *
 * 返回的是同一坐标系（裁剪内像素）的证据框；映射到画布/词坐标由
 * 调用方做。这里刻意不做映射，因为这一步是纯函数 —— 它可以在
 * 没有画布的环境里被直接测。
 */
export function computeEvidenceBoxes(boxes: ReadonlyArray<HocrCharBox>): HocrCharBox[] {
  if (boxes.length < 2) return [];
  const heights = boxes.map((b) => b.y1 - b.y0);
  const fullH = Math.max(...heights);
  if (!(fullH > 0)) return [];

  // 基线：只让「够高的字」（≥ 0.6×fullH）说话 —— 小字的底边天然更高，
  // 放进中位数会把基线整体抬起来，抬到自己都够不着
  const tall = boxes.filter((_b, i) => (heights[i] ?? 0) >= fullH * TESS_EVIDENCE_FULL_RATIO);
  if (!tall.length) return [];
  const baseline = medianOf(tall.map((b) => b.y1));

  const limit = baseline - fullH * TESS_EVIDENCE_RAISED_RATIO;
  const out: HocrCharBox[] = [];
  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i] as HocrCharBox;
    if ((heights[i] ?? 0) > fullH * TESS_EVIDENCE_SMALL_RATIO) continue;
    if (!(box.y1 <= limit)) continue;
    out.push(box);
  }
  return out;
}

/**
 * 证据框的坐标映射：裁剪内（**放大后**）像素 → 词框 / 画布坐标。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么把这三步单独写出来
 * ═══════════════════════════════════════════════════════════════
 *
 * 顺序：先除以放大倍数回到裁剪的原尺度，再加回裁剪原点（画布坐标），
 * 最后除以 `scale` —— 词框是在**缩放后**的画布上量的，与
 * `attachCharBoxes` 的 `(originX + c.x0) / scale` 是同一口径。
 *
 * 它与 `ocrCharBoxes.coveredByEvidence` 之间是一条**看不见**的契约：
 * 少乘/多除任何一步都不会报错，只会让覆盖计数静默归零（词「不救回」，
 * 与「没有证据」从输出上无法区分）。所以这里导出、并用真实区域 A
 * 的读数钉住（见 `ocrTesseractScripts.test.ts` 里 `mapCropBoxToWord` 一组）。
 */
export function mapCropBoxToWord(
  box: HocrCharBox,
  originX: number,
  originY: number,
  upscale: number,
  scale: number,
): InkEvidenceBox {
  return {
    x0: (originX + box.x0 / upscale) / scale,
    y0: (originY + box.y0 / upscale) / scale,
    x1: (originX + box.x1 / upscale) / scale,
    y1: (originY + box.y1 / upscale) / scale,
  };
}

// ───────────────────────────────────────────────────────────────
// 裁剪（词框 → 放大后的裁剪画布）
// ───────────────────────────────────────────────────────────────

interface TessCrop {
  crop: OcrCanvasLike;
  /** 裁剪原点在**画布**坐标系里的位置（映射回词坐标还要再除以 scale） */
  originX: number;
  originY: number;
  upscale: number;
}

function cropForTesseract(
  canvas: OcrCanvasLike,
  box: { x0: number; y0: number; x1: number; y1: number },
  scale: number,
  createCanvas: CanvasFactory,
): TessCrop | null {
  const sx0 = Math.max(0, Math.floor(box.x0 * scale));
  const sy0 = Math.max(0, Math.floor(box.y0 * scale));
  const sx1 = Math.min(canvas.width, Math.ceil(box.x1 * scale));
  const sy1 = Math.min(canvas.height, Math.ceil(box.y1 * scale));
  const w = sx1 - sx0;
  const h = sy1 - sy0;
  if (w < TESS_MIN_WORD_WIDTH || h < 6) return null;

  const padX = Math.max(1, Math.round(w * TESS_PAD_X_RATIO));
  const padY = Math.max(1, Math.round(h * TESS_PAD_Y_RATIO));
  const cx = Math.max(0, sx0 - padX);
  const cy = Math.max(0, sy0 - padY);
  const cw = Math.min(canvas.width - cx, w + padX * 2);
  const ch = Math.min(canvas.height - cy, h + padY * 2);
  if (cw < TESS_MIN_WORD_WIDTH || ch < 6) return null;

  const upscale = Math.min(TESS_UPSCALE, TESS_MAX_UPSCALED_WIDTH / cw);
  const dw = Math.max(1, Math.round(cw * upscale));
  const dh = Math.max(1, Math.round(ch * upscale));
  if (dw < TESS_MIN_UPSCALED_WIDTH) return null;

  const crop = blitResized(canvas, cx, cy, cw, ch, dw, dh, createCanvas);
  if (!crop) return null;
  return { crop, originX: cx, originY: cy, upscale };
}

// ───────────────────────────────────────────────────────────────
// 接线口
// ───────────────────────────────────────────────────────────────

export interface TesseractEvidenceOptions {
  /** 词框所在的画布（与 `OcrWord.bbox` 同一坐标系）—— 与 `attachCharBoxes` 同一张 */
  canvas: OcrCanvasLike;
  /** 画布像素 → 词坐标的缩放（词框是在**缩放后**的画布上量到的） */
  scale?: number;
  /**
   * 页级字符高度表（`buildCharSizeTable` 的产出）。
   *
   * 它是**预筛**的输入：`findRescuableRuns` 要先看到「某段里有 ≥2 个
   * 确实被缩小的字母数字」才会认为这个词值得跑一次 tesseract。
   * 没有表 → 一个词都不跑（少这一层，第二意见会退化成「每个词都问一遍」，
   * 那是拿几 MB 的推理去换一个本来就不存在的候选段）。
   */
  sizeTable?: CharSizeTable | null;
  /** 上限：一页最多给多少个词请第二意见（默认全部通过预筛的词） */
  maxWords?: number;
  /** 建裁剪画布的工厂（与 `attachCharBoxes` 同一约定，测试可注入替身） */
  createCanvas?: CanvasFactory;
  /** 诊断回调：某个词为什么没拿到证据 */
  onSkip?: (word: OcrWord, reason: string) => void;
  /** 诊断回调：正常信息（走了几个词、拿到几个框） */
  onInfo?: (message: string) => void;
}

/**
 * 给一批词补上**第二意见的证据框** —— 能补多少补多少，补不上就保持原样。
 *
 * @returns 拿到证据的词数（worker 建不起来时返回 0，不抛）。
 */
export async function attachTesseractEvidence(
  words: OcrWord[],
  options: TesseractEvidenceOptions,
): Promise<number> {
  if (!words.length) return 0;

  /**
   * ⭐ 预筛：只有「有段可救」的词才值得请第二意见。
   * 这一层是成本闸，也是「与改动前逐字节相同」的一半实现 ——
   * 没有候选段的词在这里就被排除，连 worker 都不会被建起来。
   */
  const targets: OcrWord[] = [];
  for (const word of words) {
    const attached = getAttachedChars(word);
    if (!attached) continue;
    const runs = findRescuableRuns(attached.measurements, attached.chars, options.sizeTable);
    if (runs.length) targets.push(word);
  }
  if (!targets.length) return 0;

  let worker: TessWorker;
  try {
    worker = await ensureTessWorker();
  } catch (err) {
    options.onInfo?.(
      `第二意见不可用（worker 建不起来，本次页内所有词都不救回）：` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return 0;
  }

  const scale = options.scale && options.scale > 0 ? options.scale : 1;
  const maxWords = options.maxWords ?? targets.length;
  const createCanvas = options.createCanvas ?? defaultCanvasFactory;

  let attachedCount = 0;
  for (const word of targets) {
    if (attachedCount >= maxWords) break;
    if (evidenceRegistry.has(word)) continue;

    try {
      const cropped = cropForTesseract(options.canvas, word.bbox, scale, createCanvas);
      if (!cropped) {
        options.onSkip?.(word, '词框尺寸不合适（第二意见裁剪失败）');
        continue;
      }

      const result = await worker.recognize(
        cropped.crop,
        {},
        { hocr: true, text: false, blocks: false },
      );
      const boxes = parseHocrCharBoxes(result.data.hocr ?? '');
      if (!boxes.length) {
        options.onSkip?.(word, '第二意见未给出字符框（hocr 为空）');
        continue;
      }

      const local = computeEvidenceBoxes(boxes);
      if (!local.length) {
        /**
         * ⚠️ 这是**正常结果**，不是失败：多数词的第二意见就是「没看到
         * 小而抬高的墨迹」（实测第 16 词就是 0 个）。它同样要登记 ——
         * 登记成空数组，判据那边 `evidence?.length` 会把它当「没有证据」，
         * 而诊断里能看出「问过了、答的是没有」与「没问」的区别。
         */
        options.onSkip?.(word, '第二意见未发现小而抬高的墨迹（0 个证据框）');
        evidenceRegistry.set(word, []);
        attachedCount++;
        continue;
      }

      const mapped: InkEvidenceBox[] = local.map((b) =>
        mapCropBoxToWord(b, cropped.originX, cropped.originY, cropped.upscale, scale),
      );
      evidenceRegistry.set(word, mapped);
      attachedCount++;
      options.onInfo?.(
        `第「${word.text.slice(0, 12)}」词第二意见：${local.length} 个证据框` +
          `（裁剪放大 ${cropped.upscale.toFixed(2)} 倍、${boxes.length} 个字符框）`,
      );
    } catch (err) {
      options.onSkip?.(word, `第二意见失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return attachedCount;
}
