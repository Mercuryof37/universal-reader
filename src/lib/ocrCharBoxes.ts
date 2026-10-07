/**
 * 字符级坐标：把「一个词框」细化成「每个字符一个框」。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么需要它（要解决的是「指数在词框内部」这个死角）
 * ═══════════════════════════════════════════════════════════════
 *
 * 用户那份扫描版习题 PDF 的第 17 题，识别出来是**一个词**：
 *
 *     词 1: "17. 设 随机 变量 (X ,Y) 具有 分 布律 P {X = x ,Y = y}
 *            = p (1 − p )x+y−2 ,0 < p < 1,x ,y 均为 正"
 *            bbox [225, 212, 1604, 255]   fontSize 43
 *
 * 指数 `x+y−2` 与整行**同在这一个检测框里**。而 `ocrPostProcess.ts` 里
 * 现有的上下标判据全是**词级**的（比较两个词框的高度与中心 y），
 * 同框内部的指数在几何上根本不可见 —— 判据再准也判不出来。
 *
 * ═══════════════════════════════════════════════════════════════
 * 怎么拿到字符级坐标（两条信息拼起来）
 * ═══════════════════════════════════════════════════════════════
 *
 * 1. **横向**：识别模型（CTC）内部**本来就算出了每个字符落在输入的哪个
 *    时间步**。`ppu-paddle-ocr/core/recognition/ctc.d.ts` 里写得很清楚：
 *
 *      positions: per emitted character, the fraction (0..1) of the input
 *                 width where its timestep fired; CTC peaks near the
 *                 glyph's center
 *
 *    但包的 `exports` 只暴露 `.` / `./web` / `./mobile`，**深路径没导出**，
 *    公开 API（`DecodedText`）也不把 `positions` 交出来。所以这里按
 *    `core/recognition/ctc.js` 的算法**重写一遍贪心解码**，把时间步留下。
 *
 * 2. **纵向**：`positions` **只有横向**。纵向必须自己做像素分析 ——
 *    在字符中心那一列上找墨迹的 y 范围。这一步是本模块的真正价值所在：
 *    有了真实纵向范围，「更小 + 更高」才是**可测的几何事实**，
 *    而不是靠阈值去猜。
 *
 * ═══════════════════════════════════════════════════════════════
 * 与库的识别前处理**必须逐项一致**（不一致则 CTC 解码全是错的）
 * ═══════════════════════════════════════════════════════════════
 *
 * 依据是 `node_modules/ppu-paddle-ocr/` 里这几个文件（我逐个读过）：
 *
 * | 参数 | 取值 | 依据 |
 * | --- | --- | --- |
 * | 输入高度 | `48` | `constants.js:2` `DEFAULT_RECOGNITION_OPTIONS.imageHeight=48`；`core/recognition/batched.js:1` `ctx.options.imageHeight??48` |
 * | 输入宽度 | `max(8, round(48*原宽/原高))` | `imageHeight*aspectRatio`，`MIN_CROP_WIDTH=8` 来自 `core/recognition/ctc.js:3` |
 * | 通道 | 3 通道**同值**（取画布 R 通道） | `core/recognition/image-tensor.js` `createImageTensorFromCanvas()`：`imageTensor[i]=pixelData[p]*INV_127_5-1`（p 是 RGBA 的 R），随后两次 `copyWithin` 复制到另外两个通道 |
 * | 归一化 | `R/127.5 − 1`，即 `[0,255] → [−1,1]` | 同上，`INV_127_5 = 1/127.5` |
 * | 输入名 / 形状 | `x` / `[1,3,H,W]` | `core/base-recognition.service.js`：`feeds={x:inputTensor}`，`[1,3,tensorHeight,tensorWidth]` |
 * | 空白类 | `BLANK_INDEX = 0` | `core/recognition/ctc.js:1` |
 * | 解码 | 逐步 argmax → 合并重复 → 去 blank | `ctcGreedyDecode()`；`lastDictIndex` 当空格类 |
 *
 * 至于「为什么识别输入是灰度」：检测的后处理把概率图写成
 * **三个通道同值**的画布（`core/detection/image-tensor.js` `tensorToCanvas()`：
 * `data[idx]=data[idx+1]=data[idx+2]=grayValue`），识别再从这个画布上取 R。
 * 所以取 R 与取灰度**在数学上等价**；这里与库保持完全一致，取 R。
 *
 * ═══════════════════════════════════════════════════════════════
 * 渐进增强：这里出任何问题都不能影响现有识别
 * ═══════════════════════════════════════════════════════════════
 *
 * `attachCharBoxes()` 对每个词都是**独立 try/catch**：拿不到字符框的词
 * 保持原样（`OcrWord` 上一个额外属性都不加），整页识别不会因此失败。
 */
// `SessionOptions` 不是顶层导出，它在 `InferenceSession` 命名空间下
// （见 onnxruntime-common 的 inference-session.d.ts 第 36 行）。
import type { InferenceSession } from 'onnxruntime-web';
import type { OcrChar, OcrWord } from '@/lib/ocrTypes';
import { OCR_MODEL_FILES, OCR_MODEL_BASE } from '@/lib/ocrModelSource';
import { resolveExecutionProviders } from '@/lib/ocrExecutionProvider';

/**
 * ═══════════════════════════════════════════════════════════════
 * 为什么 `onnxruntime-web` 只做 **type-only** import
 * ═══════════════════════════════════════════════════════════════
 *
 * 本模块被 `ocrPostProcess.ts` **静态**引用（字符级上下标判定要在这里生效），
 * 而 `ocrPostProcess` 又被 `parsers/pdfParser.ts` 静态引用。
 * 若这里写 `import * as ort from 'onnxruntime-web'`，整条链路就会
 * 把 onnxruntime-web（连同它那 ~28MB 的 WASM 加载逻辑）拖进主包 ——
 * 那与本项目「OCR 引擎按需动态 import、主包 68KB」的既有约束冲突
 * （见 `lib/ocrTypes.ts` 顶部对拆分动机的说明）。
 *
 * 所以运行时对象只在**真的要推理时**（`createCharBoxSession`）动态 import。
 * 纯函数部分（前处理 / CTC 解码 / 墨迹分析 / 判定）一行都不碰它。
 */
async function loadOrt(): Promise<typeof import('onnxruntime-web')> {
  return import('onnxruntime-web');
}

// ───────────────────────────────────────────────────────────────
// 与库对齐的常量（每一项都在文件顶部表格里写明依据）
// ───────────────────────────────────────────────────────────────

/** 识别输入高度，与 `constants.js` 的 `imageHeight: 48` 一致 */
export const REC_IMAGE_HEIGHT = 48;
/** 裁剪后最小宽度，与 `ctc.js` 的 `MIN_CROP_WIDTH = 8` 一致 */
export const REC_MIN_CROP_WIDTH = 8;
/** 空白类下标，与 `ctc.js` 的 `BLANK_INDEX = 0` 一致 */
export const CTC_BLANK_INDEX = 0;
/** 归一化系数 `1/127.5`（把 [0,255] 映到 [−1,1]） */
const INV_127_5 = 1 / 127.5;

/**
 * 墨迹判定的亮度阈值。
 *
 * 扫描件不是纯黑白：纸面有灰度起伏、JPEG 有块效应。
 * 取 160 而不是常见的 128，是为了把**浅灰的抗锯齿边缘**也算作墨迹 ——
 * 上下标本来就是小字，边缘再被削掉一圈，「更小」这个判据就失真了。
 *
 * 对比：同项目 `ocrTypes.OCR_BLANK_LUMA_THRESHOLD = 250` 判的是「整页是否空白」，
 * 量级完全不同，不能复用；`ocrInkRegions` 用的是「相对该区域均值」的口径。
 * 这里要的是**绝对**阈值（字符框要能与页面其他部分比较），故取固定中灰偏亮值。
 */
export const CHAR_INK_LUMA_THRESHOLD = 160;

/** 中心列之外还要往两侧扩多少列来量纵向范围（按字符切片宽度归一） */
const MEASURE_BAND_RATIO = 0.22;
/** 单列上至少要有几个暗像素才算「这一列有墨迹」，用来滤掉孤立噪点 */
const MIN_INK_PER_COLUMN = 2;
/** 一个字符至少要有多少列量到墨迹才算「量到了」（把单列噪点排除掉） */
const MIN_INKED_COLUMNS = 2;

// ───────────────────────────────────────────────────────────────
// 画布接口（浏览器用真的 canvas，测试可用最简替身）
// ───────────────────────────────────────────────────────────────

/** 只需 `drawImage` + `getImageData` 的最小 2D 上下文 */
export interface OcrCanvas2D {
  /**
   * `fillRect` 只有测试替身会用到（画合成墨块来验证墨迹分析），
   * 但它本来就是 2D 上下文的必备方法，列进来不会有任何副作用 ——
   * 列进来的好处是测试里的替身不必再 `as unknown as` 地骗类型。
   */
  fillRect(x: number, y: number, w: number, h: number): void;
  drawImage(
    image: OcrCanvasLike,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void;
  getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray };
}

/** 画布的最小结构（`HTMLCanvasElement` / `OffscreenCanvas` 都满足） */
export interface OcrCanvasLike {
  width: number;
  height: number;
  getContext(id: '2d'): OcrCanvas2D | null;
}

export type CanvasFactory = (width: number, height: number) => OcrCanvasLike;

function defaultCanvasFactory(width: number, height: number): OcrCanvasLike {
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(width, height) as unknown as OcrCanvasLike;
  }
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    return c as unknown as OcrCanvasLike;
  }
  throw new Error('当前环境没有可用的画布实现');
}

/** 把一块源区域画到新画布上，尺寸由 drawImage 缩放（与库的 resize 路径一致） */
function blitResized(
  source: OcrCanvasLike,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
  createCanvas: CanvasFactory = defaultCanvasFactory,
): OcrCanvasLike | null {
  if (dw < 1 || dh < 1 || sw < 1 || sh < 1) return null;
  const out = createCanvas(dw, dh);
  const ctx = out.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, dw, dh);
  return out;
}

// ───────────────────────────────────────────────────────────────
// 1. 前处理（与库逐项一致，见文件顶部表格）
// ───────────────────────────────────────────────────────────────

export interface RecCrop {
  /** 送入模型的画布（高 48，宽按比例） */
  canvas: OcrCanvasLike;
  /** 张量宽（= canvas.width） */
  tensorWidth: number;
  /** 张量高（= 48） */
  tensorHeight: number;
  /** 原裁剪相对张量的横向放大倍数：origX = tensorX * widthScale */
  widthScale: number;
  /** 原裁剪相对张量的纵向放大倍数：origY = tensorY * heightScale */
  heightScale: number;
  /** 原裁剪尺寸（归一化字符框要用它） */
  originalWidth: number;
  originalHeight: number;
  /**
   * 模型的下采样倍率：`张量宽 / 时间步数`。
   *
   * PP-OCR 的识别骨干是 CRNN 式的，横向下采样固定（PP-OCRv4/v5/v6 都是 **8**）。
   * 这个值不靠猜 —— `createWordCharBoxRecognizer()` 从会话的
   * `outputMetadata` 里读真实的时间步数，再按本公式反算出来；
   * 没有元数据时退回 `8`（见 `DEFAULT_SEQ_DOWNSAMPLE`）。
   */
  downsample: number;
}

/**
 * 把裁剪画布缩放到识别模型的输入尺寸。
 *
 * 宽度公式与 `core/recognition/image-tensor.js` 的
 * `resizedWidth = max(MIN_CROP_WIDTH, round(targetHeight * aspectRatio))`
 * **逐字一致**：不这么做的后果不是「稍微不准」，而是
 * 「每个字符的横向位置都偏移」—— 因为 `positions` 是相对**输入宽度**的比例。
 */
export function preprocessRecCrop(
  crop: OcrCanvasLike,
  downsample = DEFAULT_SEQ_DOWNSAMPLE,
  createCanvas: CanvasFactory = defaultCanvasFactory,
): RecCrop | null {
  const w = crop.width;
  const h = crop.height;
  if (!(w > 0) || !(h > 0)) return null;

  const resizedWidth = Math.max(REC_MIN_CROP_WIDTH, Math.round(REC_IMAGE_HEIGHT * (w / h)));
  const canvas = blitResized(crop, 0, 0, w, h, resizedWidth, REC_IMAGE_HEIGHT, createCanvas);
  if (!canvas) return null;

  return {
    canvas,
    tensorWidth: resizedWidth,
    tensorHeight: REC_IMAGE_HEIGHT,
    widthScale: w / resizedWidth,
    heightScale: h / REC_IMAGE_HEIGHT,
    originalWidth: w,
    originalHeight: h,
    downsample: downsample > 0 ? downsample : DEFAULT_SEQ_DOWNSAMPLE,
  };
}

/**
 * 画布 → 模型输入张量：`[1,3,H,W]`，`R/127.5 − 1`，三通道同值。
 *
 * 与 `createImageTensorFromCanvas()` 完全同构（含「先填通道 0、再整块复制」），
 * 只是这里显式写出来，不再依赖库里那个内部函数。
 */
export function canvasToRecTensor(canvas: OcrCanvasLike): Float32Array | null {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const width = canvas.width;
  const height = canvas.height;
  if (!(width > 0) || !(height > 0)) return null;
  const { data } = ctx.getImageData(0, 0, width, height);

  const channelSize = height * width;
  const tensor = new Float32Array(3 * channelSize);
  for (let i = 0, p = 0; i < channelSize; i++, p += 4) {
    tensor[i] = (data[p] ?? 0) * INV_127_5 - 1;
  }
  tensor.copyWithin(channelSize, 0, channelSize);
  tensor.copyWithin(channelSize * 2, 0, channelSize);
  return tensor;
}

// ───────────────────────────────────────────────────────────────
// 2. CTC 贪心解码（照抄库的算法，额外保留时间步）
// ───────────────────────────────────────────────────────────────

export interface CtcDecoded {
  text: string;
  confidence: number;
  /** 与 `text` 逐字符对齐：该字符触发的输入时间步（0..sequenceLength-1） */
  steps: number[];
  sequenceLength: number;
  numClasses: number;
}

/**
 * 贪心 CTC 解码：逐步 argmax → 与上一步同类则合并 → 去掉 blank。
 *
 * 与 `ctcGreedyDecode()` 的差异只有两处，都是**为了位置更准**：
 *  1. 多输出一个 `steps`（每个字符的时间步）。库那边只把它折算成
 *     `positions = (t+0.5)/seqLen`，整数时间步信息量更大；
 *  2. 同一个字符跨多个时间步时，取这些步的**平均**而不是首次那一步 ——
 *     CTC 的峰值在字形中心，均值比首值更接近中心。
 *     （库那边用了 `lastCharIndex` 只做合并、不记录，所以做不到这一点。）
 *
 * ⚠️ 与库一致地**不做** `injectGapSpaces` / `refineDecodedChars`：
 *    · 前者会往 `chars`/`positions` 里插空格，插进去的位置不是真实字符；
 *    · 后者会把全角映射成半角（`（` → `(`），那样字符框就对不上了。
 *    本模块要的是「识别器眼里的那个字符序列」，不做文本修辞。
 */
export function decodeCtcWithSteps(
  logits: Float32Array,
  sequenceLength: number,
  numClasses: number,
  charDict: string[],
): CtcDecoded {
  const dictLen = charDict.length;
  const lastDictIndex = dictLen - 1;
  const steps: number[] = [];
  const chars: string[] = [];
  let lastIndex = -1;
  let confidenceSum = 0;

  for (let t = 0; t < sequenceLength; t++) {
    const base = t * numClasses;
    let maxProb = logits[base] ?? 0;
    let maxIndex = 0;
    for (let c = 1; c < numClasses; c++) {
      const prob = logits[base + c] ?? 0;
      if (prob > maxProb) {
        maxProb = prob;
        maxIndex = c;
      }
    }

    if (maxIndex === CTC_BLANK_INDEX || maxIndex === lastIndex) {
      // 重复步「续接」同一个字符：把它的时间步往中间收，字符中心因此更准。
      if (maxIndex !== CTC_BLANK_INDEX && maxIndex === lastIndex && steps.length) {
        const last = steps.length - 1;
        steps[last] = ((steps[last] ?? 0) + t) / 2;
      }
      lastIndex = maxIndex;
      continue;
    }

    if (maxIndex >= 0 && maxIndex < dictLen) {
      const char = charDict[maxIndex] ?? '';
      // 字典最后一项是「空格类」：库在这里推入一个空格，字符本身不是字典项
      chars.push(maxIndex === lastDictIndex && char !== '<unk>' ? ' ' : char);
      confidenceSum += maxProb;
      steps.push(t);
    }
    lastIndex = maxIndex;
  }

  return {
    text: chars.join(''),
    confidence: steps.length ? confidenceSum / steps.length : 0,
    steps,
    sequenceLength,
    numClasses,
  };
}

/**
 * 把字典对齐到模型类别数。
 *
 * 与 `alignDictionaryToClasses()` 同构：字典文件的行数**未必**等于类别数
 * （末尾换行会多出一个空项；有些字典开头还带一个显式空项代表 blank）。
 * 对齐规则错一格，全部输出都会错位 —— 这是最致命的失败模式。
 */
export function alignDictToClasses(dict: string[], numClasses: number): string[] {
  if (dict.length === numClasses) return dict;

  let end = dict.length;
  while (end > 0 && dict[end - 1] === '') end--;
  const trimmed = dict.slice(0, end);
  if (trimmed.length === numClasses) return trimmed;

  const first = trimmed[0];
  const aligned = first === '' ? ['', ...trimmed.slice(1)] : ['', ...trimmed];
  if (aligned.length === numClasses - 1) aligned.push('');
  return aligned;
}

/**
 * 模型的默认横向下采样倍率。
 *
 * PP-OCR 识别骨干（CRNN / SVTR 系列）对输入宽度做固定倍率下采样，
 * 输出时间步 = 输入宽 / 8。`index.d.ts` 里把识别输入高度写成 48、
 * 检测输出按 32 对齐，都是这套骨干的既有约束。
 *
 * ⚠️ 这个值**不靠猜**：`createWordCharBoxRecognizer()` 会从会话的
 * `outputMetadata` 里读真实时间步数并反算（见 `sequenceLengthForWidth`）。
 * 只有拿不到元数据时才退回这里的 8，而且**只影响首尾字符的半个切片宽度**，
 * 不影响字符中心位置（中心是从返回的 `dims` 算的，那份一定是真的）。
 */
export const DEFAULT_SEQ_DOWNSAMPLE = 8;

/** 张量宽 → 时间步数（与库 `batched.js` 的 `validSeq` 同口径：向上取整） */
export function sequenceLengthForWidth(tensorWidth: number, downsample: number): number {
  const d = downsample > 0 ? downsample : DEFAULT_SEQ_DOWNSAMPLE;
  return Math.max(1, Math.ceil(tensorWidth / d));
}

// ───────────────────────────────────────────────────────────────
// 3. 逐列墨迹分析（纵向范围只能靠这个拿到）
// ───────────────────────────────────────────────────────────────

export interface CharPixelSpan {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** 有没有真的量到墨迹（空格、笔画被检测框切掉的字符会是 false） */
  hasInk: boolean;
}

/**
 * 判定上下标**只需要**这三个归一化量（都是该字符自身的墨迹范围，
 * 与本裁剪的宽高相除得到，因此无量纲、可跨字符直接比较）：
 *
 *  · `y0` 顶边、`y1` 底边（判断「更高 / 更低」，以及与基线的关系）；
 *  · `h` 高度（判断「更小」）。
 *
 * 横向的 `x0/x1` 属于**像素框**（`CharPixelSpan`）的职责，
 * 不放进这个最小结构里 —— 判据用不到它，混在一起只会让
 * 「哪些量参与了判定」变得含糊。
 */
export interface InkMeasurement {
  y0: number;
  y1: number;
  h: number;
}

/**
 * 一个字符的两种坐标。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么要分成「像素框」与「归一化墨迹框」两份
 * ═══════════════════════════════════════════════════════════════
 *
 *  · **像素框**是给调用方用的：要能贴回 `OcrWord.bbox` 所在的画布坐标系，
 *    所以必须乘回放大倍数、加上词框原点；
 *  · **归一化墨迹框**是给判据用的：只有「字符自身的高度」与「它相对
 *    这一行的位置」参与判断，而这两者都必须是**无量纲**的 ——
 *    一个词框可能被检测器撑得很大（实测 `Z= 当X>Y` 的框 fontSize=124，
 *    而真正的字高只有 36），像素量在这个坐标系里毫无可比性。
 *
 * 归一化的分母取**本裁剪**的宽高，所以 `ink.h`、`ink.y0/y1` 在同一裁剪内
 * 天然可比；跨词比较时用的是「同一裁剪内字符之间」的相对关系，
 * 因此也不受裁剪尺寸影响。这是本模块能做到「不靠阈值猜」的原因。
 */
export interface MeasuredChar {
  /** 裁剪内像素坐标（横向是切片范围，纵向是墨迹范围） */
  span: CharPixelSpan;
  /** 归一化到 [0,1] 的墨迹框；`span.hasInk` 为假时不存在 */
  ink?: InkMeasurement;
}

/**
 * 在一列上找墨迹的纵向范围。
 *
 * 为什么按**列**而不是按「切片内所有墨迹」：切片边界只能取相邻字符中心的
 * 中点，斜体/连笔时邻字的笔画会探进来。按列找、并从中线向两侧扩展，
 * 得到的是**这个字符自己**的纵向范围 —— 这正是上下标判据要的输入。
 */
function columnInkSpan(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
): { y0: number; y1: number } | null {
  let y0 = Infinity;
  let y1 = -Infinity;
  let count = 0;
  for (let y = 0; y < height; y++) {
    const p = (y * width + x) * 4;
    const luma = 0.299 * (data[p] ?? 0) + 0.587 * (data[p + 1] ?? 0) + 0.114 * (data[p + 2] ?? 0);
    if (luma < CHAR_INK_LUMA_THRESHOLD) {
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      count++;
    }
  }
  if (count < MIN_INK_PER_COLUMN || !Number.isFinite(y0) || y1 < y0) return null;
  return { y0, y1 };
}

/**
 * 找出每个字符的真实像素框。
 *
 * @param canvas 已缩放到识别输入尺寸的**灰度**画布（高 48）
 * @param steps  每个字符的时间步（`decodeCtcWithSteps` 的产出）
 * @param sequenceLength 模型输出的时间步总数
 * @param crop   前处理结果（提供张量↔原图的换算系数）
 */
export function measureCharPixelSpans(
  canvas: OcrCanvasLike,
  steps: number[],
  sequenceLength: number,
  crop: RecCrop,
): MeasuredChar[] {
  const width = canvas.width;
  const height = canvas.height;
  const blank = (): MeasuredChar => ({
    span: { x0: 0, x1: width, y0: 0, y1: height, hasInk: false },
  });
  const out: MeasuredChar[] = steps.map(blank);
  if (!steps.length || sequenceLength <= 0 || width <= 0 || height <= 0) return out;

  const ctx = canvas.getContext('2d');
  if (!ctx) return out;
  const { data } = ctx.getImageData(0, 0, width, height);

  // 字符中心（张量横向像素）：时间步 t 代表 [t, t+1) 这段输入，
  // 中心在 (t+0.5)/L 处 —— 与库 `positions` 的定义完全一致。
  const stepPx = width / sequenceLength;
  const toPx = (t: number): number => ((t + 0.5) / sequenceLength) * width;
  const centers = steps.map(toPx);

  for (let i = 0; i < steps.length; i++) {
    const center = centers[i] ?? 0;
    const prevCenter = i > 0 ? (centers[i - 1] ?? center - stepPx) : center - stepPx;
    const nextCenter =
      i + 1 < centers.length ? (centers[i + 1] ?? center + stepPx) : center + stepPx;

    // 切片边界 = 相邻字符中心的中点；首尾字符各向外扩半个步，
    // 否则第一个字符的左半边会被切掉。
    let x0 = Math.round(i === 0 ? Math.min(0, center - stepPx / 2) : (prevCenter + center) / 2);
    let x1 = Math.round(
      i === steps.length - 1
        ? Math.max(width - 1, center + stepPx / 2)
        : (center + nextCenter) / 2,
    );
    x0 = Math.max(0, Math.min(width - 1, x0));
    x1 = Math.max(x0 + 1, Math.min(width, x1));

    // 中心列必定落在字形内（CTC 峰值就在字形中心）；外扩一点提高稳健性，
    // 但**不能扩到邻字**，所以按切片宽度取一个有限的比例。
    const band = Math.max(1, Math.round((x1 - x0) * MEASURE_BAND_RATIO));
    const mid = Math.round((x0 + x1) / 2);
    const from = Math.max(x0, mid - band);
    const to = Math.min(x1 - 1, mid + band);

    let top = Infinity;
    let bottom = -Infinity;
    let inkedColumns = 0;

    for (let x = from; x <= to; x++) {
      const col = columnInkSpan(data, width, height, x);
      if (!col) continue;
      inkedColumns++;
      if (col.y0 < top) top = col.y0;
      if (col.y1 > bottom) bottom = col.y1;
    }

    const hasInk = inkedColumns >= MIN_INKED_COLUMNS && Number.isFinite(top) && bottom >= top;
    const span: CharPixelSpan = {
      x0,
      x1,
      y0: hasInk ? top * crop.heightScale : 0,
      y1: hasInk ? (bottom + 1) * crop.heightScale : height * crop.heightScale,
      hasInk,
    };

    const entry: MeasuredChar = { span };
    if (hasInk) {
      // 纵向用真实墨迹范围；横向只用**有墨迹的那几列**（比切片边界准），
      // 但横向不参与上下标判定，所以只留在 span 里，不放进 ink。
      const inkY0 = span.y0;
      const inkY1 = span.y1;
      entry.ink = {
        y0: inkY0 / crop.originalHeight,
        y1: inkY1 / crop.originalHeight,
        h: (inkY1 - inkY0) / crop.originalHeight,
      };
    }
    out[i] = entry;
  }
  return out;
}

/** 一个词的识别产出（裁剪内坐标） */
export interface WordCharBoxes {
  /** 与 `text` 逐字符对齐的像素框（裁剪内坐标） */
  chars: OcrChar[];
  /** 与 `text` 逐字符对齐的归一化墨迹框（判据用；没量到的为 null） */
  measurements: Array<InkMeasurement | null>;
  /** 识别出的原文（未 trim） */
  text: string;
  confidence: number;
  /** 本次推理的张量宽度、时间步数与下采样倍率，供诊断核对 */
  tensorWidth: number;
  sequenceLength: number;
  downsample: number;
}

/** 一次识别推理的原始输出（把 `ort.Tensor` 的 dims 一起带出来） */
export interface RecInferenceOutput {
  data: Float32Array;
  /** 模型输出形状 `[batch, seq, classes]` */
  dims: readonly number[];
}

/**
 * 把一个**词/行裁剪**跑一遍识别，返回每个字符的框（裁剪内坐标）。
 *
 * `runInference` 由调用方注入（生产用 `createWordCharBoxRecognizer()`，
 * 测试可替换成固定的假 logits）。
 */
export async function buildWordCharBoxes(
  crop: OcrCanvasLike,
  runInference: (
    tensor: Float32Array,
    width: number,
    height: number,
  ) => Promise<RecInferenceOutput>,
  charDict: string[],
  downsample = DEFAULT_SEQ_DOWNSAMPLE,
  createCanvas: CanvasFactory = defaultCanvasFactory,
): Promise<WordCharBoxes | null> {
  const pre = preprocessRecCrop(crop, downsample, createCanvas);
  if (!pre) return null;

  const tensor = canvasToRecTensor(pre.canvas);
  if (!tensor) return null;

  const output = await runInference(tensor, pre.tensorWidth, pre.tensorHeight);

  /**
   * 类别数**只从 `dims[2]` 读**。
   *
   * ⚠️ 不能用 `data.length` 反推：库在批次路径里会把这一行按
   * `validSeq = ceil(seq * 本行宽 / 批内最宽)` 截断（`batched.js`），
   * 截断后的长度是 `validSeq * classes`，两个未知数一个方程，解不出来。
   * 拿不到合法 dims 时直接返回 null —— 走「没有字符框」的兜底路径，
   * 绝不猜一个类别数出来（猜错会让全部输出错位，比没有更糟）。
   */
  const numClasses = Math.floor(output.dims[2] ?? 0);
  if (!(numClasses > 0)) return null;
  const sequenceLength = Math.floor(output.dims[1] ?? 0) || Math.floor(output.data.length / numClasses);
  if (!(sequenceLength > 0)) return null;

  const dict = alignDictToClasses(charDict, numClasses);
  const decoded = decodeCtcWithSteps(output.data, sequenceLength, numClasses, dict);
  if (!decoded.text.length) {
    return {
      chars: [],
      measurements: [],
      text: '',
      confidence: decoded.confidence,
      tensorWidth: pre.tensorWidth,
      sequenceLength,
      downsample: pre.downsample,
    };
  }

  const measured = measureCharPixelSpans(pre.canvas, decoded.steps, sequenceLength, pre);

  const chars: OcrChar[] = [];
  const measurements: Array<InkMeasurement | null> = [];
  for (let i = 0; i < decoded.text.length; i++) {
    const ch = decoded.text[i] ?? '';
    const m = measured[i];
    if (!ch || !m) continue;
    chars.push({ char: ch, x0: m.span.x0, y0: m.span.y0, x1: m.span.x1, y1: m.span.y1 });
    measurements.push(m.ink ?? null);
  }

  return {
    chars,
    measurements,
    text: decoded.text,
    confidence: decoded.confidence,
    tensorWidth: pre.tensorWidth,
    sequenceLength,
    downsample: pre.downsample,
  };
}

// ───────────────────────────────────────────────────────────────
// 4. 上下标判定：用真实的字符墨迹范围
// ───────────────────────────────────────────────────────────────

export type ScriptKind = 'super' | 'sub';

export interface CharScript {
  index: number;
  kind: ScriptKind;
}

/**
 * 上下标判定的保守阈值（**全部是同一裁剪内的相对量**，无绝对像素依赖）。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么这里比词级判据更有底气，但仍然要保守
 * ═══════════════════════════════════════════════════════════════
 *
 * 词级判据（`ocrPostProcess.ts` 的 `findScriptAnchors`）面对的是
 * **两个检测框** —— 它不知道框里画的是什么，只能比框高与框中心；
 * 而检测框会被公式撑得面目全非（实测 `Z= 当X>Y` 的框高 124，
 * 里面真正的字高只有 36）。这里面对的是**单个字符的真实墨迹范围**：
 * `x+y−2` 里那个 `x` 的墨迹高度与它底边相对基线的位置，是量出来的事实。
 *
 * 但**误判的代价依然大于漏判**（把正常字符塞进 `^{}` 会让整段公式渲染错），
 * 所以三条阈值都留了余量：
 *  · `0.8`：中文数学排版里的上下标通常是主字号的 0.6–0.75 倍；
 *    留到 0.8 是为了容忍扫描件的笔画膨胀 —— 小字被膨胀的比例更大；
 *  · `0.15`：上标底边至少要高出基线 15% 主字高。**同一基线上并排的字符
 *    底边与基线齐平，差值为 0**，无论它多小都不会被误判 ——
 *    这是区分「上标」与「就是小一号的字」的关键；
 *  · `0.5`：把「与基线差得离谱」的东西（下一行的小字、下划线上的字）挡住。
 */
export const SCRIPT_CHAR_MAX_HEIGHT_RATIO = 0.8;
export const SCRIPT_CHAR_MIN_SHIFT_RATIO = 0.15;
export const SCRIPT_CHAR_MAX_SHIFT_RATIO = 0.5;
/**
 * 中心位移的门槛（相对主字高），**取 0**。
 *
 * 用来排除**中线符号**：等号这类字符墨迹天生只占中线，
 * 底边高于基线但**中心并不上移**，只看底边会把它们判成上标
 * （实测 `$^{=}$` 就是这么来的）。
 *
 * 为什么门槛是 0 而不是某个正数 —— 可以推出来：
 *
 *   中心位移 = 抬高量 + 半个自身字高 − 半个主字高      （均以主字高归一化）
 *
 *   · 实测那个等号：抬高 0.295、自身高 0.256 → **−0.077**（中心反而更低）；
 *   · 恰好在抬高下限的浅上标（既有用例的夹具）：抬高 0.15、自身高 0.75 → **+0.025**。
 *
 * 两者分别落在 0 的两侧，所以门槛取 0 就能分开，而且**判据本身是有意义的**：
 * 「升起来的字，中心不该低于正文中心」。
 *
 * 已知代价：抬高量很小、自身又偏高的字符可能被漏判。
 * 按本文件一贯取舍 —— 宁可漏判，也不要把等号包成上标。
 */
export const SCRIPT_CHAR_MIN_CENTER_SHIFT_RATIO = 0;
/** 判定所需的最少可测字符数（与词级判据的 `SCRIPT_MIN_LINE_WORDS` 同口径） */
export const SCRIPT_MIN_MEASURED_CHARS = 3;
/** 算基线时，「正常字」至少要有这么多个，否则不出结论 */
const SCRIPT_MIN_BASELINE_CHARS = 2;

/**
 * 阈值比较用的浮点容差。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么必须有它（这是一次实测抓到的边界失败）
 * ═══════════════════════════════════════════════════════════════
 *
 * 位移上限是 `0.5 × 主字高`。取一组「正好卡在上限」的真实比例
 * （主字高 0.72、下标高 0.36、顶边在基线上）时：
 *
 *     0.72 − 1.08 = −0.3600000000000001
 *     0.5 × 0.72  =  0.36
 *
 * 于是 `0.3600000000000001 <= 0.36` 判**假** —— 一个完全正确的下标
 * 被判据拒之门外。这类「差 1e-16 就翻面」的比较在几何判据里到处都是，
 * 加一个远小于任何真实排版差异的容差（1e-9）比到处写 `<=` 更稳妥。
 */
const SHIFT_EPSILON = 1e-9;

function medianOf(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0);
}

/**
 * 判定一组字符里哪些是上标 / 下标。
 *
 * 基准（主字号、基线）**全部由这一组字符自己量出来**，不引入任何外部字号：
 *  · 主字号 = 各字符墨迹高度的**最大值**。最大的那个一定是正文字符，
 *    上下标只会更小。用最大值而不是中位数，是因为指数可能占多数
 *    （`a_{i}b_{j}c_{k}` 这类行），中位数会被上下标拖低，
 *    基准一低，「更小」这道门就形同虚设；
 *  · 基线 = **正常高度字符**（≥ 0.8×主字号）底边的**中位数**。
 *    用中位数而不是平均值：`p`、`y` 这类带下延的字母底边低于基线，
 *    平均会被拉下去，中位数稳得住。
 *
 * 三条判据**全部满足**才算上下标：
 *  1. 高度 ≤ 0.8 × 主字号；
 *  2. 上标：底边高出基线 ≥ 0.15 × 主字号；下标：顶边低于基线 ≥ 0.15 × 主字号；
 *  3. 位移 ≤ 0.5 × 主字号。
 *
 * @param measurements 与 `chars` 逐字符对齐的归一化墨迹框（`ocrCharBoxes`
 *   的 `measurements`）。没量到墨迹的字符（空格等）为 null，直接跳过。
 */
export function classifyCharsByGeometry(
  measurements: Array<InkMeasurement | null | undefined>,
): CharScript[] {
  const idx: number[] = [];
  for (let i = 0; i < measurements.length; i++) {
    const m = measurements[i];
    if (m && m.h > 0) idx.push(i);
  }
  if (idx.length < SCRIPT_MIN_MEASURED_CHARS) return [];

  const mainHeight = Math.max(...idx.map((i) => measurements[i]?.h ?? 0));
  if (!(mainHeight > 0)) return [];

  const normalBottoms = idx
    .filter((i) => (measurements[i]?.h ?? 0) >= mainHeight * SCRIPT_CHAR_MAX_HEIGHT_RATIO)
    .map((i) => measurements[i]?.y1 ?? 0);
  if (normalBottoms.length < SCRIPT_MIN_BASELINE_CHARS) return [];

  const baseline = medianOf(normalBottoms);
  const minShift = mainHeight * SCRIPT_CHAR_MIN_SHIFT_RATIO;
  const maxShift = mainHeight * SCRIPT_CHAR_MAX_SHIFT_RATIO;

  /**
   * ═══════════════════════════════════════════════════════════════
   * 为什么还必须看**中心**，不能只看底边（用户真实数据，实测）
   * ═══════════════════════════════════════════════════════════════
   *
   * 只看底边会把**中线符号**判成上标。实测第 20 题那一行：
   *
   *   求  bbox [296, 1174.3, 320, 1202.8]  高 28.5  底边 1202.8  中心 1188.55
   *   =  bbox [378, 1186.3, 398, 1193.6]  高  7.3  底边 1193.6  中心 1189.95
   *
   * 于是输出成了 `(2) 求 Z $^{=}$ X + Y 的概率密度.` —— **等号被包成了上标**。
   *
   * 但等号的**中心比正文还低 1.4px**：它根本没有「升高」，
   * 它只是「矮」—— 等号的墨迹天生只占中线那两条横杠。
   * 任何墨迹位于基线上方的中线符号（`=`、`≈`、`≡`、`~`）都会这样。
   *
   * 真正的上标是**整个字身都在更高处**：底边高，**中心也高**。
   * 所以这里补一条中心位移判据，两条同时成立才算。
   * 它能挡住全部中线符号，却不影响真正的指数 ——
   * 指数被抬高后中心必然随之上移。
   */
  const normalCenters = idx
    .filter((i) => (measurements[i]?.h ?? 0) >= mainHeight * SCRIPT_CHAR_MAX_HEIGHT_RATIO)
    .map((i) => {
      const m = measurements[i];
      return m ? (m.y0 + m.y1) / 2 : 0;
    });
  const baselineCenter = medianOf(normalCenters);
  const minCenterShift = mainHeight * SCRIPT_CHAR_MIN_CENTER_SHIFT_RATIO;

  const out: CharScript[] = [];
  for (const i of idx) {
    const m = measurements[i];
    if (!m || m.h > mainHeight * SCRIPT_CHAR_MAX_HEIGHT_RATIO) continue;

    const up = baseline - m.y1;
    const down = m.y0 - baseline;
    const centerUp = baselineCenter - (m.y0 + m.y1) / 2;

    if (
      up >= minShift - SHIFT_EPSILON &&
      up <= maxShift + SHIFT_EPSILON &&
      centerUp >= minCenterShift - SHIFT_EPSILON
    ) {
      out.push({ index: i, kind: 'super' });
    } else if (
      down >= minShift - SHIFT_EPSILON &&
      down <= maxShift + SHIFT_EPSILON &&
      centerUp <= -minCenterShift + SHIFT_EPSILON
    ) {
      out.push({ index: i, kind: 'sub' });
    }
  }
  return out;
}

/**
 * 把连续同类上下标字符并成「片段」。
 *
 * 为什么要成段：`x+y−2` 是**五个字符的指数**，组装行文本时要合成
 * **一个** `$^{x+y-2}$`，而不是五个 `$^{x}$$^{+}$$^{y}$` ——
 * 后者在 KaTeX 里是五个并列公式，语义完全不对。
 *
 * 两条打断规则，都与排版事实对齐：
 *  · **空白打断**：`x + y` 里的空格不属于指数（与 `orderLineWords` 同口径）；
 *  · **遇到非上下标字符打断**：片段必须是在 `chars` 里**连续**的一段，
 *    否则「按下标区间切原串」拼出来的就不是原串了。
 *    这条比「遇到基字打断」更严格也更简单：只要中间夹着一个被判为
 *    正文的字符，片段到此为止（`p(1−p)^{x+y−2}` 里 `x` 前面是正文 `p`，
 *    本来就该断）。
 */
export interface ScriptFragment {
  kind: ScriptKind;
  /** 在字符数组里的下标区间 [from, to]（含两端） */
  from: number;
  to: number;
  /** 片段的字符内容（不含空白），用于拼 `^{...}` */
  text: string;
}

export function groupScriptFragments(
  chars: Array<{ char: string }>,
  scripts: CharScript[],
): ScriptFragment[] {
  const kindAt = new Map<number, ScriptKind>();
  for (const s of scripts) kindAt.set(s.index, s.kind);

  const fragments: ScriptFragment[] = [];
  let i = 0;
  while (i < chars.length) {
    const kind = kindAt.get(i);
    if (!kind) {
      i++;
      continue;
    }
    let j = i;
    let text = '';
    while (j < chars.length) {
      const ch = chars[j]?.char ?? '';
      if (kindAt.get(j) !== kind || !ch.trim()) break;
      text += ch;
      j++;
    }
    if (text) fragments.push({ kind, from: i, to: j - 1, text });
    i = Math.max(j, i + 1);
  }
  return fragments;
}

// ───────────────────────────────────────────────────────────────
// 5. ONNX 会话（复用自托管模型，零新依赖）
// ───────────────────────────────────────────────────────────────

let cachedSession: InferenceSession | null = null;
let cachedSessionPromise: Promise<InferenceSession> | null = null;
let cachedDict: string[] | null = null;

/** 清掉会话与字典缓存（测试与「换模型」场景用） */
export function resetCharBoxSession(): void {
  cachedSession?.release?.();
  cachedSession = null;
  cachedSessionPromise = null;
  cachedDict = null;
}

/**
 * 建一个**只做识别**的 ONNX 会话。
 *
 * 为什么单独建会话而不是复用 `PaddleOcrService` 里的那个：
 * 库的 `session` 是 private 字段，公开 API 只给 `recognize()` 的成品结果 ——
 * 拿不到中间的 logits。而字符位置恰恰只存在于 logits 里（见文件顶部）。
 *
 * 代价是**同一份 20.3MB 模型被加载两次**（约 40MB 内存，实测文件大小
 * `public/ocr-models/recognition/ort/PP-OCRv6_small_rec.ort` = 21290816 字节）。
 * 这是有意的取舍：只有真的要用字符框时才建（懒加载），
 * 而且失败只影响这一步（见 `attachCharBoxes`）。
 */
export async function createCharBoxSession(): Promise<InferenceSession> {
  if (cachedSession) return cachedSession;
  if (cachedSessionPromise) return cachedSessionPromise;

  cachedSessionPromise = (async () => {
    const url = `${OCR_MODEL_BASE}/${OCR_MODEL_FILES.recognition}`;
    const response = await fetch(url, { referrerPolicy: 'no-referrer' });
    if (!response.ok) throw new Error(`识别模型下载失败（HTTP ${response.status}）：${url}`);
    const bytes = await response.arrayBuffer();
    const ort = await loadOrt();
    const session = await ort.InferenceSession.create(bytes, {
      executionProviders: resolveExecutionProviders(),
      graphOptimizationLevel: 'all',
      // 与 ocrEngine 同样的理由（见那里的长注释）：线程池要 SharedArrayBuffer
      // 与跨源 Worker，本站都没开；失败时是 Emscripten abort（不是异常），
      // 页面会静默消失。这里同样压成单线程。
      intraOpNumThreads: 1,
      interOpNumThreads: 1,
    } as InferenceSession.SessionOptions);
    cachedSession = session;
    return session;
  })();

  try {
    return await cachedSessionPromise;
  } catch (err) {
    cachedSessionPromise = null;
    throw err;
  }
}

/** 读识别字典（`ppocrv6_dict.txt`，实测 18709 行），失败返回 null、不抛 */
export async function loadCharDict(): Promise<string[] | null> {
  if (cachedDict) return cachedDict;
  try {
    const url = `${OCR_MODEL_BASE}/${OCR_MODEL_FILES.charactersDictionary}`;
    const response = await fetch(url, { referrerPolicy: 'no-referrer' });
    if (!response.ok) throw new Error(`字典下载失败（HTTP ${response.status}）`);
    const text = await response.text();
    // `split('\n')` 与库的 parseDictionary 同口径（末尾换行会留下一个空项，
    // `alignDictToClasses` 会把它处理掉）
    cachedDict = text.split('\n');
    return cachedDict;
  } catch (err) {
    console.warn('[ocrCharBoxes] 识别字典读取失败，字符框功能停用：', err);
    return null;
  }
}

/**
 * 从会话元数据里读出**真实的下采样倍率**。
 *
 * 时间步数 = 输入宽 / 下采样倍率，而输入宽是动态轴（`[-1,3,48,-1]`），
 * 所以不能直接读出一个数。做法：ONNX 的符号维度名（如 `"W/8"`）
 * 里就写着这个除法，能解析就解析；解析不出来再退回
 * `SESSION_OUTPUT_DOWNSAMPLE_HINTS` 里的经验值。
 */
function downsampleFromSession(session: InferenceSession): number {
  try {
    const meta = session.outputMetadata as unknown as
      | Array<{ shape?: Array<number | string> }>
      | undefined;
    const shape = meta?.[0]?.shape;
    const dim = shape?.[1];
    if (typeof dim === 'number' && dim > 0) return DEFAULT_SEQ_DOWNSAMPLE;
    if (typeof dim === 'string') {
      const m = /\/\s*(\d+)/.exec(dim);
      const divisor = m?.[1] ? Number.parseInt(m[1], 10) : 0;
      if (divisor > 0) return divisor;
    }
  } catch {
    /* 元数据不可用：用默认值 */
  }
  return DEFAULT_SEQ_DOWNSAMPLE;
}

/**
 * 建好「裁剪 → 字符框」的全部依赖，返回一个可直接用的函数。
 *
 * 任一步失败都返回 `null`（调用方据此完全跳过字符框这一层）。
 */
export async function createWordCharBoxRecognizer(): Promise<
  | ((
      crop: OcrCanvasLike,
      createCanvas?: CanvasFactory,
    ) => Promise<WordCharBoxes | null>)
  | null
> {
  try {
    const [session, dict, ort] = await Promise.all([
      createCharBoxSession(),
      loadCharDict(),
      loadOrt(),
    ]);
    if (!dict?.length) return null;
    const downsample = downsampleFromSession(session);

    return async (crop, createCanvas) =>
      buildWordCharBoxes(
        crop,
        async (tensor, width, height) => {
          const input = new ort.Tensor('float32', tensor, [1, 3, height, width]);
          try {
            const outputs = await session.run({ x: input });
            const first = Object.keys(outputs)[0];
            const out = first ? outputs[first] : undefined;
            if (!out) throw new Error('识别模型没有输出张量');
            return { data: out.data as Float32Array, dims: out.dims };
          } finally {
            input.dispose();
          }
        },
        dict,
        downsample,
        createCanvas,
      );
  } catch (err) {
    console.warn('[ocrCharBoxes] 字符框会话创建失败，本次识别不做字符级坐标：', err);
    return null;
  }
}

// ───────────────────────────────────────────────────────────────
// 6. 给词挂字符框（渐进增强的接线口）
// ───────────────────────────────────────────────────────────────

/**
 * 字符框的旁挂表。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么不加进 `OcrWord` 类型
 * ═══════════════════════════════════════════════════════════════
 *
 * `OcrWord` 是「识别结果」的公共形状，被写回文字层、被导出、被多处序列化。
 * 往里加一个字段意味着：所有构造 `OcrWord` 的地方都得考虑它，
 * 所有 `toEqual` 断言都得跟着改 —— 那就不是「渐进增强」了。
 *
 * 用 `WeakMap` 旁挂：没有字符框时**一个额外属性都不加**，
 * `OcrWord` 的形状与行为与改动前一致；想要字符框的地方用
 * `getAttachedChars(word)` 显式来取。
 * `WeakMap` 也不影响 GC（词被回收时表项自动消失）。
 */
const charBoxRegistry = new WeakMap<OcrWord, AttachedChars>();

/**
 * 取不到字符框的**原因**记录。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么必须记下来（真实教训）
 * ═══════════════════════════════════════════════════════════════
 *
 * `attachCharBoxes` 对每个失败的词都会报原因（尺寸不合适 / 未解出字符 /
 * 字符序列与词文本不一致），但**只送进 `console.warn`**。
 * 而用户看不到控制台 —— 于是导出的结构里只有
 * 「`wordsWithChars: 8`、含指数的那一行不在其中」这一个事实，
 * **完全不知道 15 个词各自停在哪一个出口**。
 *
 * 实测为此连猜两轮：先猜「词太宽、超出模型宽度上限」，
 * 但数据立刻否掉了它 —— 44px 宽的短词也没拿到，825px 的反而拿到了。
 * 猜测之所以发生，只是因为原因被写进了看不见的地方。
 *
 * 所以这里把原因留下来，由 `ocrStructure` 导出。
 * 机制与 `charBoxRegistry` 一致：旁挂、按页清空、不污染 `OcrWord`。
 */
const skipLog: { text: string; reason: string }[] = [];

/** 记录一个词为什么没取到字符框（由 `ocrEngine` 的 `onSkip` 调用） */
export function recordCharBoxSkip(text: string, reason: string): void {
  // 词汇级别的明细可能很长，截断到可读长度；条数不限（一页的词是有限的）
  skipLog.push({ text: text.slice(0, 24), reason });
}

/** 取本页记录到的失败原因 */
export function getCharBoxSkips(): { text: string; reason: string }[] {
  return [...skipLog];
}

/** 每页开始前清空 —— 否则会跨页累积，读出来的就不是这一页的情况 */
export function clearCharBoxSkips(): void {
  skipLog.length = 0;
}

/** 挂在词上的字符框：像素框（画布坐标）+ 归一化墨迹（判据用） */
export interface AttachedChars {
  chars: OcrChar[];
  measurements: Array<InkMeasurement | null>;
}

export function getAttachedChars(word: OcrWord): AttachedChars | undefined {
  return charBoxRegistry.get(word);
}

export function attachCharsToWord(word: OcrWord, attached: AttachedChars): void {
  charBoxRegistry.set(word, attached);
}

/**
 * 裁剪一个词框（含上下留白），返回裁剪画布与它在**画布**上的原点。
 *
 * ⚠️ `scale` 必须在这里用上：`word.bbox` 是在**词框坐标系**里量的，
 * 而 `canvas` 可能是一张降档画布（0.7/0.5/0.35）。少乘这一次的后果是
 * 「裁到别处的内容」—— 识别出别的字，对账会拦住（不会写错坐标），
 * 但每个词都白跑一次推理，字符框一个也拿不到。
 */
function cropWord(
  canvas: OcrCanvasLike,
  box: { x0: number; y0: number; x1: number; y1: number },
  scale: number,
  createCanvas: CanvasFactory,
): { crop: OcrCanvasLike; originX: number; originY: number } | null {
  const sx = Math.max(0, Math.floor(box.x0 * scale));
  const sy = Math.max(0, Math.floor(box.y0 * scale));
  const ex = Math.min(canvas.width, Math.ceil(box.x1 * scale));
  const ey = Math.min(canvas.height, Math.ceil(box.y1 * scale));
  const w = ex - sx;
  const h = ey - sy;
  if (w < 8 || h < 6) return null;

  /**
   * 上下各留 8% 的余量。
   *
   * 检测框常常切掉上下标的极端笔画（实测 `e^{-(x+y)}` 的指数框上沿
   * 就压在笔画的最高点上）。而纵向范围正是本模块要量的东西 ——
   * 切掉了就量不准，量不准就会把真上标判成普通字。横向留白同理，
   * 但留白会让 `positions` 的比例映射整体平移，所以横向**不留**：
   * 检测框左右已经包含文字的完整起止。
   */
  const padY = Math.max(1, Math.round(h * 0.08));
  const cy = Math.max(0, sy - padY);
  const ch = Math.min(canvas.height - cy, h + padY * 2);
  if (ch < 6) return null;

  const crop = blitResized(canvas, sx, cy, w, ch, w, ch, createCanvas);
  if (!crop) return null;
  return { crop, originX: sx, originY: cy };
}

/** 缩放：识别时可能用过降档画布（0.7/0.5/0.35），坐标要能回落到原画布 */
export interface CharBoxAttachOptions {
  /** 词框所在的画布（与 `OcrWord.bbox` 同一坐标系） */
  canvas: OcrCanvasLike;
  /** 画布像素 → 词坐标的缩放（词框是在**缩放后**的画布上量到的） */
  scale?: number;
  /** 太小/太大的框直接跳过，避免无谓推理 */
  minCropPixels?: number;
  maxCropPixels?: number;
  /** 上限：一页最多给多少个词补字符框 */
  maxWords?: number;
  /**
   * 建裁剪画布的工厂。
   *
   * 默认用 `OffscreenCanvas` / `document.createElement('canvas')`，
   * 两者都不存在时**抛异常**（在 Node 里跑测试就会遇到）。
   * 留这个注入口有两个用处：
   *  1. 单测可以在无 DOM 环境里注入替身，于是「坐标映射」这一段
   *     不需要浏览器也能验证；
   *  2. 将来若要用别的画布实现（例如 OffscreenCanvas 优先、
   *     失败再退回 DOM 画布），不必改这里的逻辑。
   */
  createCanvas?: CanvasFactory;
  /** 诊断回调：某个词为什么没拿到字符框 */
  onSkip?: (word: OcrWord, reason: string) => void;
}

/**
 * 给一批词补上字符框 —— **能补多少补多少，补不上就保持原样**。
 *
 * ═══════════════════════════════════════════════════════════════
 * 这里的三层「不拖累主流程」
 * ═══════════════════════════════════════════════════════════════
 *
 * 1. **会话建不起来就直接返回**（`recognizer` 为 null → 返回 0、不抛）：
 *    模型没下下来、WASM 被拦、浏览器不支持 —— 任何一种都不该让
 *    「整页识别」失败。
 * 2. **每个词独立 try/catch**：一个词的裁剪/推理炸了，只是这个词没有
 *    字符框，其余词照常。
 * 3. **不改 `OcrWord` 本身**：字符框挂在 `WeakMap` 上，没有字符框的词
 *    与改动前完全一样（连一个 `undefined` 属性都不多）。
 *
 * @returns 成功挂上字符框的词数；`recognizer` 为 null 时返回 0。
 */
export async function attachCharBoxes(
  words: OcrWord[],
  recognizer: Awaited<ReturnType<typeof createWordCharBoxRecognizer>>,
  options: CharBoxAttachOptions,
): Promise<number> {
  if (!recognizer || !words.length) return 0;

  const scale = options.scale && options.scale > 0 ? options.scale : 1;
  const maxWords = options.maxWords ?? words.length;
  const minCrop = options.minCropPixels ?? 24;
  const maxCrop = options.maxCropPixels ?? 4096;
  const createCanvas = options.createCanvas ?? defaultCanvasFactory;

  let attached = 0;
  for (const word of words) {
    if (attached >= maxWords) break;
    if (charBoxRegistry.has(word)) continue;

    const w = word.bbox.x1 - word.bbox.x0;
    const h = word.bbox.y1 - word.bbox.y0;
    if (w < minCrop || h < 6 || w > maxCrop) {
      options.onSkip?.(word, `词框尺寸不合适（${Math.round(w)}×${Math.round(h)}）`);
      continue;
    }

    try {
      const cropped = cropWord(options.canvas, word.bbox, scale, createCanvas);
      if (!cropped) {
        options.onSkip?.(word, '裁剪失败');
        continue;
      }

      const recognized = await recognizer(cropped.crop, createCanvas);
      if (!recognized?.chars.length) {
        options.onSkip?.(word, '未解出字符');
        continue;
      }

      // ⚠️ 字符数必须与词文本对得上，否则字符框会整体错位 ——
      // 那比没有字符框更糟（错位的框会让正常字符被误判成上下标）。
      const aligned = reconcileWithWordText(
        recognized.chars,
        recognized.measurements,
        recognized.text,
        word.text,
      );
      if (!aligned) {
        /**
         * ⚠️ 把**重新识别得到的文本**一起报出来。
         *
         * 用户真实数据里 15 个词**全部**卡在这个出口 ——
         * 没有一个卡在尺寸闸、也没有一个卡在「未解出字符」。
         * 但只有「不一致」这三个字是**不够定位**的：
         * 不知道它识别成了什么，就只能继续猜（此前已经猜错两轮）。
         *
         * 记下这句话之后，下一次导出就能直接对照：
         * 是整体串行（错位）、还是少了几个字（裁剪不全）、
         * 还是把符号认成了别的字（识别质量）。
         * 三者的修法完全不同，而它们的区别全在这一段文本里。
         */
        options.onSkip?.(
          word,
          `字符序列与词文本不一致（重新识别得到「${recognized.text}」，` +
            `期望「${word.text}」，字符数 ${recognized.chars.length} / ${word.text.length}）`,
        );
        continue;
      }

      // 裁剪内坐标 → 画布坐标：加回裁剪原点、再除以 scale
      // （词框是在缩放画布上量的，字符框要回到同一坐标系）
      const chars: OcrChar[] = aligned.chars.map((c) => ({
        char: c.char,
        x0: (cropped.originX + c.x0) / scale,
        y0: (cropped.originY + c.y0) / scale,
        x1: (cropped.originX + c.x1) / scale,
        y1: (cropped.originY + c.y1) / scale,
      }));

      charBoxRegistry.set(word, { chars, measurements: aligned.measurements });
      attached++;
    } catch (err) {
      options.onSkip?.(word, `字符框失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return attached;
}

/** 去掉首尾空白字符（`OcrWord.text` 是 trim 过的，字符框必须跟着对齐） */
function trimCharRange(
  chars: OcrChar[],
  measurements: Array<InkMeasurement | null>,
): { chars: OcrChar[]; measurements: Array<InkMeasurement | null>; text: string } {
  let from = 0;
  let to = chars.length;
  while (from < to && !(chars[from]?.char ?? '').trim()) from++;
  while (to > from && !(chars[to - 1]?.char ?? '').trim()) to--;
  const slicedChars = chars.slice(from, to);
  const slicedMeasure = measurements.slice(from, to);
  return {
    chars: slicedChars,
    measurements: slicedMeasure,
    text: slicedChars.map((c) => c.char).join(''),
  };
}

/**
 * 把「本模块识别出的字符」与「词文本」对齐。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么必须对账，而不是直接信自己这一遍的输出
 * ═══════════════════════════════════════════════════════════════
 *
 * 同一个裁剪会**被识别两次**：一次是库的 `recognize()`（结果进了
 * `OcrWord.text`），一次是本模块为了拿 `steps` 而重跑。两次的输入理论上
 * 等价，但库走的是**批次填充**路径（同一批里按最宽的裁剪右侧补边，
 * 见 `batched.js`），数值上不保证逐比特一致 —— 偶尔会在
 * `l`/`1`、`O`/`0` 这种地方分歧。
 *
 * 分歧本身不可怕，可怕的是**字符数不一致时框会整体错位**：
 * 本来判 `x` 是上标，错位之后判到 `y` 头上，输出就成了错的公式。
 * 所以这里严格对账：**字符序列不一致就放弃这个词的字符框**（返回 null），
 * 退回原来的词级判据。少一点覆盖，绝不产出错的坐标。
 */
export function reconcileWithWordText(
  chars: OcrChar[],
  measurements: Array<InkMeasurement | null>,
  recognizedText: string,
  wordText: string,
): { chars: OcrChar[]; measurements: Array<InkMeasurement | null> } | null {
  const target = wordText.trim();
  if (!target) return null;

  const trimmed = trimCharRange(chars, measurements);
  if (trimmed.text === target) {
    return { chars: trimmed.chars, measurements: trimmed.measurements };
  }

  /**
   * 归一化：去空白 + 全角转半角 + 忽略大小写。
   *
   * ═══════════════════════════════════════════════════════════════
   * 为什么只去空白不够（用户真实数据，15 条实测）
   * ═══════════════════════════════════════════════════════════════
   *
   * 原先这里只做 `replace(/\s+/g,'')`，实测 23 个词里有 **15 个**卡在
   * 「字符序列与词文本不一致」。把两次识别结果并排看，差别**几乎全是格式**：
   *
   *   期望 `(1） 求 条件 概率 密度 f x|Y(x |y).`
   *   得到 `（1）求条件概率密度 f x|Y(x |y).`      ← 半角括号变全角
   *
   *   期望 `24. 设随机变量(X,Y)的概率密度为`
   *   得到 `24. 设随机变量(X，Y）的概率密度为`      ← 半角逗号/括号变全角
   *
   *   期望 `P).`   得到 `p).`                     ← 大小写
   *
   * **内容是对的**，只是两次独立识别在标点宽度与大小写上不一致。
   * 于是「逐字符完全相同」这道闸把 15 个词全丢了 —— 包括含指数的第 1 词。
   *
   * 归一化后仍不匹配的**照样丢弃**，例如实测里的
   * `）`→`1`、`0，`→`O，` —— 那是真的认错了字，
   * 放行会让字符框对到别的字上，比没有更糟。
   *
   * 全角转半角用码位减法（U+FF01–U+FF5E → U+0021–U+007E），**逐字符一一对应**，
   * 所以归一化后按下标对齐仍然成立。
   */
  const canonical = (s: string): string =>
    s
      .replace(/\s+/g, '')
      .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
      .toLowerCase();

  if (canonical(trimmed.text) !== canonical(target)) return null;
  if (canonical(recognizedText) !== canonical(target)) return null;

  const keptChars: OcrChar[] = [];
  const keptMeasure: Array<InkMeasurement | null> = [];
  for (let i = 0; i < trimmed.chars.length; i++) {
    const c = trimmed.chars[i];
    // 空白没有墨迹，去掉它才与 `target` 的非空白字符逐字符对齐
    if (!c || !c.char.trim()) continue;
    keptChars.push(c);
    keptMeasure.push(trimmed.measurements[i] ?? null);
  }
  if (canonical(keptChars.map((c) => c.char).join('')) !== canonical(target)) return null;
  return { chars: keptChars, measurements: keptMeasure };
}
