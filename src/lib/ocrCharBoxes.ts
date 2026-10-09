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

/**
 * 默认画布工厂。除了本模块自己用，`ocrTesseractScripts` 也直接复用它 ——
 * 「在浏览器里怎么造一块画布」不该有两个实现（两者面对的是同一批环境：
 * 有 `OffscreenCanvas` 就用它，没有就退回 DOM 画布，都没有就抛）。
 */
export function defaultCanvasFactory(width: number, height: number): OcrCanvasLike {
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

/**
 * 把一块源区域画到新画布上，尺寸由 drawImage 缩放（与库的 resize 路径一致）。
 *
 * 导出它的理由与 `defaultCanvasFactory` 相同：`ocrTesseractScripts` 要把
 * 词框裁出来**并放大**（tesseract 在 4 倍上才分得开指数的笔画），
 * 而「裁剪 + 缩放」这件事只能有一个实现 —— 两处各写一遍，
 * 裁剪边界差一个像素就会让两套字符框对不上。
 */
export function blitResized(
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
  /**
   * 与 `text` 逐字符对齐的**每字符置信度**（0..1）。
   *
   * ═══════════════════════════════════════════════════════════════
   * 为什么必须留下它（这是「重写上下标判定」的关键输入）
   * ═══════════════════════════════════════════════════════════════
   *
   * Tesseract 的 `ccmain/superscript.cpp`（David Eger, 2012, Apache-2.0，
   * https://tesseract-ocr.github.io/tessapi/3.05.02/a00149_source.html#l00253 ）
   * 判上下标时**同时要求两个独立信号**：
   *
   *     位置异常（机制 1）  **且**  识别置信度明显低于该词的平均（机制 2）
   *
   * 而本模块此前只输出「整个词的算术平均置信度」（`confidence`），
   * 拿不到**逐字符**的值 —— 于是机制 2 在数据上根本无法实现，
   * 判据只能退化成「只看几何」。实测后果（用户那份中英数混排习题）：
   * `17`、`P`、`)`、`√`、`Y` 全被包成上标，而真正的指数 `x+y−2` 反而漏了。
   * 被误判的都是**高置信度**认出来的普通字，真正的指数是**小而模糊**的块
   * —— 识别器本来就不确定。只看几何必然误判。
   *
   * ═══════════════════════════════════════════════════════════════
   * 口径：该字符**所有触发时间步上 argmax 概率的平均值**
   * ═══════════════════════════════════════════════════════════════
   *
   * 两种候选口径，这里选后者：
   *  1. **CTC 峰值**（首次触发那一步的概率）—— 只取一帧，
   *     而那一帧取什么值受这一步落在字形哪个位置影响很大（笔画交界处偏低）；
   *  2. **该字符覆盖的全部时间步的平均**（本实现采用）—— 与本函数里
   *     `confidence`（词级平均）以及 `steps`（时间步平均）**同一套聚合方式**，
   *     不必再定一条「哪一步算峰值」的规则，也不会因为某一帧抖动而翻面。
   *
   * ⚠️ 与库的差别只有「多留下一个数」，解码结果本身不变：合并重复、
   * 去除 blank、跳过字典外类别这几条与 `ctcGreedyDecode()` 完全一致。
   *
   * ⚠️ 取值区间：拿到的是模型输出的概率（PP-OCR 的识别头自带 softmax），
   * 因此落在 (0,1]；测试里的假 logits 也按概率给。
   */
  confidences: number[];
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
  /**
   * 每个字符已被折进平均值的那些步的 argmax 概率**之和**，
   * 与 `steps` 一一对应；除以各自的步数就是该字符的置信度。
   *
   * 为什么单独累计而不是直接就地平均：`steps` 用的是**逐步收敛**的平均
   * （见下面的续接分支），而置信度要的是**算术平均**。两者若共用一份
   * 累加器，后者就会被前者的收敛过程污染 —— 两类量必须分开记。
   */
  const certaintySums: number[] = [];
  const certaintyCounts: number[] = [];
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
      // 重复步「续接」同一个字符：把它的时间步往中间收，字符中心因此更准；
      // 该步的概率同时折进这个字符的置信度（口径见 `CtcDecoded.confidences`）。
      if (maxIndex !== CTC_BLANK_INDEX && maxIndex === lastIndex && steps.length) {
        const last = steps.length - 1;
        steps[last] = ((steps[last] ?? 0) + t) / 2;
        certaintySums[last] = (certaintySums[last] ?? 0) + maxProb;
        certaintyCounts[last] = (certaintyCounts[last] ?? 0) + 1;
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
      certaintySums.push(maxProb);
      certaintyCounts.push(1);
    }
    lastIndex = maxIndex;
  }

  const confidences = certaintySums.map((sum, i) => {
    const n = certaintyCounts[i] ?? 0;
    return n > 0 ? sum / n : 0;
  });

  return {
    text: chars.join(''),
    confidence: steps.length ? confidenceSum / steps.length : 0,
    steps,
    confidences,
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
  /**
   * 与 `text` 逐字符对齐的**每字符置信度**（判据用；口径见 `CtcDecoded.confidences`）。
   *
   * 为什么与 `measurements` 并列放在这一层，而不是塞进 `OcrChar`：
   * `OcrChar` 是被写回文字层、被导出、被序列化的公共形状（见 `ocrTypes.ts`），
   * 往里加字段就不是「渐进增强」了。置信度是**判据的输入**，与
   * `measurements` 同性质，因此放在一起 —— 判据要什么，这里就给什么。
   *
   * 为什么这里是**可选**（`?`）而 `measurements` 不是：生产路径一定会给出它
   * （见 `buildWordCharBoxes`），但「没有」是一个合法状态 ——
   * 判据会显式地退回纯几何（机制 2 不启用），而不是把缺值当成 0。
   * 标成可选，既如实描述了这件事，也让「手写一个识别器替身」的测试
   * 不必为了一个用不到的字段而多写一行。
   */
  confidences?: number[];
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
      confidences: [],
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
  const confidences: number[] = [];
  for (let i = 0; i < decoded.text.length; i++) {
    const ch = decoded.text[i] ?? '';
    const m = measured[i];
    if (!ch || !m) continue;
    chars.push({ char: ch, x0: m.span.x0, y0: m.span.y0, x1: m.span.x1, y1: m.span.y1 });
    measurements.push(m.ink ?? null);
    confidences.push(decoded.confidences[i] ?? 0);
  }

  return {
    chars,
    measurements,
    confidences,
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
 * 所以三条阈值都留了余量，而且**位移那条的参照物已经换掉了**：
 *  · `0.8`：候选的高度上限，相对**基准高度** `mainHeight`（= 各字符墨迹高度的中位数）。
 *    中文数学排版里的上下标通常是主字号的 0.6–0.75 倍，留到 0.8 是为了容忍
 *    扫描件的笔画膨胀 —— 小字被膨胀的比例更大；
 *  · `0.15`：上标底边至少要高出基线 15% × 位移单位。**同一基线上并排的字符
 *    底边与基线齐平，差值为 0**，无论它多小都不会被误判 ——
 *    这是区分「上标」与「就是小一号的字」的关键；
 *  · `0.5`：把「与基线差得离谱」的东西（下一行的小字、下划线上的字）挡住。
 *
 * ⚠️ 这里说「相对主字高」在重写前后**指的不是同一个量**：旧实现的
 * `mainHeight` 是高度的上四分位数，重写后是中位数（理由见
 * `classifyCharsByGeometry`）。数字没动，参照物换了 —— 这不是笔误。
 */
export const SCRIPT_CHAR_MAX_HEIGHT_RATIO = 0.8;
export const SCRIPT_CHAR_MIN_SHIFT_RATIO = 0.15;
/**
 * ⚠️ 这个常量**已不再参与判定**，只保留下来作历史记录（重写前后都是 0.5）。
 *
 * 它原本是「位移上限」：把「与基线差得离谱」的东西（下一行的小字）挡住。
 * 锚到基线上之后这条必须去掉 —— 它会把真正的指数一起挡掉，实测数字见
 * `classifyCharsByGeometry` 里那段（真指数抬高 0.62 × mainHeight，
 * 而被误判的 `7`/`P` 只抬高 0.30/0.35 × mainHeight）。
 *
 * 为什么留着一个不用的导出而不是删掉：删掉会让「位移上限去哪了」
 * 变成一个只能靠翻 git 才能回答的问题。有断言钉着它（见
 * `ocrCharBoxes.test.ts` 的常量组），谁想恢复它都得先看一眼原因。
 */
export const SCRIPT_CHAR_MAX_SHIFT_RATIO = 0.5;
/**
 * 测量值超过基准高度的多少倍就被当作异常、直接丢弃。
 *
 * 实测依据：混进相邻行墨迹的那几个框高 **49**，而真正的正文字形高 **27.6** ——
 * 比值 1.78。取 1.5 落在两者之间，且远离两侧，不靠卡边界通过。
 *
 * 丢弃而不是「当作正文」：一个量错位置的框，它的**纵向位置同样不可信**，
 * 留着它只会继续污染基准。
 */
export const SCRIPT_OUTLIER_RATIO = 1.5;
/** 判定所需的最少可测字符数（与词级判据的 `SCRIPT_MIN_LINE_WORDS` 同口径） */
export const SCRIPT_MIN_MEASURED_CHARS = 3;
/** 算基线时，「正常字」至少要有这么多个，否则不出结论 */
const SCRIPT_MIN_BASELINE_CHARS = 2;

/**
 * 上下标判定的**位移单位**：以「测出来的主字号（`mainHeight`）」为 1。
 *
 * 定义了它，`SCRIPT_CHAR_MIN_SHIFT_RATIO` / `SCRIPT_CHAR_MAX_SHIFT_RATIO`
 * 才有了明确的参照物 —— 这两个数此前是「相对最高字」的，而最高字会被
 * 异常框撑大（见 `classifyCharsByGeometry` 里那段实测）。
 */
export const SCRIPT_CHAR_SHIFT_UNIT_RATIO = 1;

/**
 * ═══════════════════════════════════════════════════════════════
 * 置信度门槛：`unlikely_threshold = SCRIPT_WORSE_CERTAINTY × 平均置信度`
 * ═══════════════════════════════════════════════════════════════
 *
 * Tesseract 的 `superscript_worse_certainty`（`tesseractclass.h`，默认 0.8）
 * 的对应物：**位置异常 且 置信度低于这个门槛** 才算上下标候选
 * （`ccmain/superscript.cpp` 第 253 行 `GetSubAndSuperscriptCandidates`，
 * https://tesseract-ocr.github.io/tessapi/3.05.02/a00149_source.html#l00253 ）。
 *
 * 为什么取 0.8 而不是照搬某个数字：它在**本项目的真实数据**上
 * 两侧都留了余量（见 `classifyCharsByGeometry` 的实测数字）：
 *   · 被误判的普通字（`7`、`P`、`p`）与平均之比 ≥ 0.94 → 不可能是上下标；
 *   · 真正的指数 `x+y−2` 有字符低到 0.62 → 只有它们能过这道门。
 * 门槛落在 0.8 时，两侧各自还有 0.14 / 0.18 的距离，不靠卡边界通过。
 *
 * ⚠️ **但那是**构造**数据上的余量。真实置信度首次拿到后，0.80 被证伪、改为 0.93。**
 *
 * Tesseract 的 0.80 作用在它自己那套**归一化 certainty** 上，与本项目
 * 「CTC argmax 概率的时间步均值」不是同一尺度，直接搬会过严。
 *
 * 真实导出（`buildId 2026-10-08T10:01:55.267Z`，17 个词置信度首次全部可得）
 * 给出的分界：
 *
 *   真上标 `σ²` 的 `²`                    **0.8852**   ← 必须接受
 *   误判的 `P`（第 1 词）                  0.9877      ← 必须拒绝
 *   误判的 `=`（第 1 词，三个）            0.9965 / 0.9983 / 0.9984
 *   误判的 `=` / `+` / `Y`（第 16 词）     0.9967 / 0.9933 / 0.9892
 *
 * 门槛必须落在 **0.8852 与 0.989 之间**，取 **0.93** 居中
 * （两侧各留 0.045 / 0.059）。按 0.80 算门槛约 0.78，**
 * 连真上标 `²` 一起拒掉** —— 这正是它在真实数据上失败的方式。
 *
 * 代价如实记录：第 1 词的真指数 `x+y−2` 置信度是
 * **0.9953 / 0.9997 / 0.9205 / 0.957 / 0.9883**，与误判字符**重叠**，
 * 单靠这道门分不开。所以调完之后那个指数**仍可能判不出**，
 * 但**不会再输出错误公式**：宁可漏，不再错。
 */
export const SCRIPT_WORSE_CERTAINTY = 0.93;

/**
 * ═══════════════════════════════════════════════════════════════
 * 机制 5：按字符**自身**的预期高度校验（上下标判定的**第三道门**）
 * ═══════════════════════════════════════════════════════════════
 *
 * 参照 Tesseract `ccmain/superscript.cpp`（David Eger, 2012, Apache-2.0）
 * 的 `BelievableSuperscript()`（该文件第 520 行起）：
 *
 * https://tesseract-ocr.github.io/tessapi/3.05.02/a00149_source.html#l00520
 *
 *     float char_height = blob->bounding_box().height();
 *     float normal_height = char_height;
 *     if (wc.unicharset()->top_bottom_useful()) {
 *       wc.unicharset()->get_top_bottom(unichar_id, &min_bot, &max_bot, &min_top, &max_top);
 *       float hi_height = max_top - max_bot, lo_height = min_top - min_bot;
 *       normal_height = (hi_height + lo_height) / 2;      // ← 该字符**自身**应有的高度
 *       if (normal_height >= kBlnXHeight) {               // ← 只对「本该正常大小」的字形下判断
 *         height_fraction = char_height / normal_height;
 *       }
 *     }
 *     bool bad_height = height_fraction < superscript_scaledown_ratio;
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么必须有它：置信度衡量的是「罕不罕见」，不是「小不小」
 * ═══════════════════════════════════════════════════════════════
 *
 * 用户最新真实导出（`buildId 2026-10-08T10:13:08.199Z`）：机制 1 + 机制 2
 * 判对了 2 个真上标，但**新出现 3 个误判** —— 同一个波折号 `∼`（U+223C）三次：
 *
 *     ❌ … X $^{∼}$ b(n1,p),Y$^{∼}$ b(n2,p) … b(n1+n₂,
 *
 * 根因已定位到具体数值：`∼` 的逐字符置信度是 **0.549 / 0.5816 / 0.5268**，
 * 是该词最低的三个 —— 所以它**通过了机制 2 的置信度门**。但它的置信度低
 * **不是因为小或被抬高，而是因为它是个罕见字形**；几何上它同样合格
 * （墨迹高 5.1、抬高 7.2）。**调系数解决不了**：`0.93` 再怎么调，
 * 「置信度」这个量本身与「有没有被缩小」无关。
 *
 * Tesseract 用机制 5 补上这一条：它**不**问「置信度高不高」，而问
 * 「这个字比它自己**本该有的**高度小了多少」。`=`、`∼`、`-` 这类
 * 中线符号天生就矮，`normal_height` 本身就小 → `height_fraction ≈ 1`
 * → 不算被缩小 → 拒绝；而指数里的 `2` 比正文的 `2` 明显缩小 → 接受。
 *
 * ═══════════════════════════════════════════════════════════════
 * 关键替代：Tesseract 查**字体度量表**，我们查**本页实测的最大高度**
 * ═══════════════════════════════════════════════════════════════
 *
 * PP-OCR 的字典里**没有** unicharset 那种「每个字符的字体上下沿」表，
 * 所以 `normal_height` 只能另找来源。本实现的替代是**页内实测**：
 *
 *     H(c) = 整页所有词的字符框里，字符 c 出现过的**最大**墨迹高度（像素）
 *
 * 于是判据变成 `h / H(c) < SCRIPT_MECH5_SCALEDOWN_RATIO` 才算「确实被缩小」。
 * 为什么取**最大**而不是中位数：只以缩小形态出现的字符（`∼` 三次都是 5.1）
 * 最大值就是它自己，比值 = 1 → 拒绝；而 `2` 在别处有正常尺寸实例
 * （实测第 3/9/22 词 h=21 / 20.4 / 23）→ 指数里的 `2`（11.4）比值 ≈ 0.50 → 接受。
 *
 * ═══════════════════════════════════════════════════════════════
 * 极性：与 Tesseract 的 `bad_height` **相反**，这不是抄错
 * ═══════════════════════════════════════════════════════════════
 *
 * 在 Tesseract 里 `bad_height` 是**拒绝**理由之一（第 586 行
 * `if (bad_certainty || bad_height || is_punc || is_italic)` 打断
 * 「正常字符」的连续段，`all_ok` 再决定这次切分可信不可信）：
 * 它的含义是「这个字形比**字体表里该有的样子**小太多 → 它多半不是我们
 * 以为的那个字」。这里的两处分母**不是同一个东西**：
 *
 *   · Tesseract 的分母：字体度量表里该字符应有的高度 —— **与本次识别无关**；
 *   · 本实现的分母：本页实测的该字符**最大**高度 —— 也就是它的缩小形态本身
 *     （当它只以缩小形态出现时）。
 *
 * 分母换了，比值的方向也就换了：本实现的 `h / H < 阈值` 恰恰意味着
 * 「**它比自己在本页的最大形态明显更小**」，这正是 Tesseract 的机制 5
 * 想表达的那件事在「没有字体表、只有页内实测」时的对应物。
 * 照抄 `bad_height` 的方向（小则拒）会把**真上标全部拒掉**，与目标相反。
 *
 * ═══════════════════════════════════════════════════════════════
 * 定值依据：真实导出（`buildId 2026-10-08T10:13:08.199Z`）逐字抄录
 * ═══════════════════════════════════════════════════════════════
 *
 *   字符                候选 h    页内最大 H(c)   比值     期望
 *   ────────────────────────────────────────────────────────────
 *   第 16 词指数 `2`     11.4      23（第 22 词）   0.496   接受 ✔
 *                            └─ 若只认「21+」这个最保守的读数 → 0.543
 *   第 1 词指数 `2`      12.3      23               0.535   接受
 *   第 1 词指数 `x`       7.2      20.4             0.353   接受
 *   第 1 词指数 `y`       7.2      20.4             0.353   接受
 *   `∼`（U+223C）         5.1      5.1（只有它自己）1.000   拒绝 ✔
 *   第 1 词 `P`          11.2      11.2（只有它自己）1.000   拒绝 ✔
 *   第 1 词 `=`（×3）     6.1      6.2（第 20 词）   0.984   拒绝 ✔
 *   `²`(U+00B2) / `₂`(U+2082)  —— 走「本身即 Unicode 上下标字符」的例外，直接接受
 *
 * 门槛必须落在 **0.543 与 0.984 之间**：
 *   · 取 0.8（Tesseract `superscript_scaledown_ratio` 的默认值同样量级）：
 *     接受侧余量 **0.257**（0.8 − 0.543）、拒绝侧余量 **0.184**（0.984 − 0.8）；
 *   · 实测里最紧的一个数是另一份导出（`buildId 2026-10-08T09:42:56.578Z`）
 *     第 14 词的 `=`，墨迹高 **7.3** —— 若它与第 1 词同页，同一个 6.1 的
 *     `=` 比值就是 **0.836**，离 0.8 只剩 0.036。**这一条如实记下来**：
 *     页面上最大的 `=` 若量到 ≥ 7.6，第 1 词那个等号就会被放行。
 *     要更稳可以降到 0.72（两侧 0.177 / 0.116），但那会把「被缩小得不多」
 *     的真上标一起放进来 —— 本项目方向是**宁可漏**，所以取更严的 0.8。
 *
 * ═══════════════════════════════════════════════════════════════
 * 两条局限（如实记录，都有实测数字，不修）
 * ═══════════════════════════════════════════════════════════════
 *
 * 1. **某字符在整页只以缩小形态出现时会失败**（本替代方案的固有缺口，
 *    Tesseract 有字体表所以不存在这个问题）。实测代价：
 *    第 1 词指数的 `+`、`−` 在页面上只有缩小实例（`+` 的另一个实例是
 *    第 16 词的 1.8、`−` 的另一个是 49 的异常框、已被丢弃）→ H 就是它自己
 *    → 比值 1.0 → **被拒**，输出会把指数切成 `$^{x}$+$^{y2}$` 这种形态。
 *    缓解它的正确方向是「页面上真的存在全尺寸的 `+`/`−`」（一份完整习题页
 *    本来就有），而不是放宽阈值。
 * 2. 表用的是**像素**高度，`InkMeasurement.h` 是**归一化**高度 —— 两者
 *    **绝不混算**（见 `buildCharSizeTable` 的长注释：同一份 `=` 在两个
 *    紧致程度不同的检测框里，归一化后能差 1.9 倍，会把该拒的变成该收的）。
 */
export const SCRIPT_MECH5_SCALEDOWN_RATIO = 0.8;

/**
 * 机制 5 需要多少个词提供字符框才算「有一张页级的表」。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么必须有这个下限（不是为了让测试变绿，是一条真实的退化）
 * ═══════════════════════════════════════════════════════════════
 *
 * 机制 5 的名字就是「**页级**统计」。整页只有一个词时，「别处的同一个字符」
 * 在定义上不存在，H 只可能落在**本词内部**，于是：
 *
 *   · 上标里的 `+`、`−`、`2` 在本词里往往**只有它们自己**这一个实例
 *     （实测第 1 词就是如此：`+` 全词只出现一次，就在指数里）→ H = h
 *     → 比值 1.0 → 判「它天生就这么矮」→ **把真上标拒掉**；
 *   · 这不是测量，是**恒等式**：`H = h ⟹ h/H = 1`，与字形大小无关。
 *
 * 所以本实现要求**至少两个词**提供字符框；不足则整张表为 `null`
 * （机制 5 不启用，行为与引入它之前**逐字节相同**，与「拿不到表」同一条
 * 降级路径）。后果如实记录：**单词页上机制 5 不生效**，那类页面里
 * `∼`/`=` 这种误判不会被它挡住 —— 但也不会比改动前更糟。
 */
export const SCRIPT_MECH5_MIN_WORDS = 2;

/**
 * 机制 3 用的字符类别判据。
 *
 * `PUNCTUATION_RE` 直接问 Unicode：这个字符是不是标点（`\p{P}`）。
 * 汉字区间与 `ocrPostProcess.cjkCountOf` / `CJK_CHAR_RE` 是同一组，
 * 不另起一套 —— 同一个概念在项目里只能有一个定义。
 *
 * ⚠️ 正则**不带** `g` 标志：`test()` 用不到它，而带上它会让 `lastIndex`
 * 在多次调用之间残留，是这类判据最常见的暗坑。
 */
const PUNCTUATION_RE = /\p{P}/u;
const CJK_CHAR_ONLY_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;

/**
 * ═══════════════════════════════════════════════════════════════
 * 减号必须从「标点」里**豁免**（这是被验收用例抓到的一次真实翻车）
 * ═══════════════════════════════════════════════════════════════
 *
 * 直接写 `\p{P}` 会把 ASCII 连字符 `-` 判成标点 —— 它的 Unicode 类别是
 * **`Pd`（Dash_Punctuation）**，即标点。而数学里的减号恰恰就是它。
 *
 * 后果实测（`x+y-2` 那条验收用例，夹具里用的是 ASCII `-`）：
 * 五个指数字符里 `x`、`+`、`y`、`2` 都判出来了，**只有 `-` 被 Mechanism 3 拒掉**，
 * 于是输出成了 `$^{x+y}$-$^{2}$` —— 一个被腰斩的公式，比不判更糟。
 *
 * Unicode 里四个「减号候选」，类别并不一致（这就是坑所在）：
 *   · `U+002D` `-` 连字符 → **Pd**
 *   · `U+2212` `−` 减号   → Sm
 *   · `U+2013` `–` 短破折号 → Pd
 *   · `U+2014` `—` 长破折号 → Pd
 * 只写 `\p{P}` 恰好把最常用的那一个放走了。
 *
 * 所以这里按**显式名单**豁免（而不是把整个 `Pd` 都放行）：
 * 破折号出现在真正的上标里没有排版依据，而减号必须有。
 * 参考实现那边没有这个坑 —— Tesseract 用的是 unicharset 自己的
 * `get_ispunctuation()`，它的标点集合来自训练语料，不含减号。
 */
const MINUS_LIKE_RE = /^[-−–—]$/u;

/** 机制 3：这个字符是不是「标点」（减号类除外，理由见 `MINUS_LIKE_RE`） */
function isPunctuationChar(ch: string): boolean {
  if (MINUS_LIKE_RE.test(ch)) return false;
  return PUNCTUATION_RE.test(ch);
}

/**
 * 阈值比较用的浮点容差。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么必须有它（这是一次实测抓到的边界失败）
 * ═══════════════════════════════════════════════════════════════
 *
 * 位移上限是 `0.5 × 位移单位`。取一组「正好卡在上限」的真实比例
 * （位移单位 0.72、下标高 0.36、顶边在基线上）时：
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

// ───────────────────────────────────────────────────────────────
// 4b. 机制 5 的页级字符高度表
//     （Tesseract 查 unicharset 的字体度量表；我们没有那张表，
//       改成从**当前页面自己**量出来 —— 见 SCRIPT_MECH5_SCALEDOWN_RATIO）
// ───────────────────────────────────────────────────────────────

/**
 * 「本身即 Unicode 上下标」的字符集。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么这几个字符必须**直接接受**（走例外，不查表）
 * ═══════════════════════════════════════════════════════════════
 *
 * `²`(U+00B2)、`₂`(U+2082) 这类字符**天生就是上下标**：它们的墨迹本来就小，
 * 与「有没有被缩小」无关。拿它们去比「同形基字符的全尺寸高度」只会得出
 * 「比值 1.0 → 它天生就这么矮 → 拒绝」的荒谬结论 —— 而实测第 15 词的
 * `N(0，σ²).试` 里那个 `²`（墨迹高 10.1、抬高 11.9）正是**判对了的真上标**，
 * 第 20 词的 `n₂`（10.2）也是真下标。
 *
 * 字符集 = `components/BlockRow.tsx` 里 `normalizeSuperSub()` 的
 * `SUPER_RE` / `SUB_RE`（本项目对「Unicode 上下标」的既有唯一一份定义）
 * ∪ `reconcileWithWordText` 里 `canonical()` 认的那几段码位
 * （`\u2070-\u2079`、`\u207A-\u207E`、`\u2080-\u2089`、`\u208A-\u208E`）。
 * 下面用**码位区间**写，覆盖上面两个来源的全部字符：
 *
 *  · `\u00B2\u00B3\u00B9` ¹²³（BlockRow 的 SUPER_MAP 里也有，但不在
 *    `canonical()` 的区间里 —— 这一条是**必须补上**的，第 15 词的真上标
 *    就是 U+00B2）；
 *  · `\u2070-\u207F` 上标数字/符号/括号/`ⁿ`；
 *  · `\u2080-\u208E` 下标数字/符号/括号；`\u2090-\u209C` ₐₑₒₓₔₕₖₗₘₙₚₛₜ；
 *  · `\u02B0-\u02B7`、`\u02E1-\u02E3`、`\u1D2C-\u1D6A`、`\u2C7C` 修饰字母
 *    （ʰʷˡˢˣᵃ…ᶻⱼ，BlockRow 的映射表里逐个列出的那些）。
 *
 * ⚠️ 区间里**没有** `∼`(U+223C)、`=`(U+003D)、`P`、`2`、`x` ——
 * 这条边界是量出来的：那四个正是要交给机制 5 去判的对象。
 */
const UNICODE_SCRIPT_CHAR_RE =
  /[\u00B2\u00B3\u00B9\u2070-\u207F\u2080-\u208E\u2090-\u209C\u02B0-\u02B7\u02E1-\u02E3\u1D2C-\u1D6A\u2C7C]/u;

/** 这个字符**本身**是不是 Unicode 上下标字符（是则机制 5 直接接受） */
export function isUnicodeScriptChar(char: string): boolean {
  return UNICODE_SCRIPT_CHAR_RE.test(char);
}

/**
 * 机制 5 的比较键：把**全角**折成半角，其余原样。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么**不**直接用 `canonical()`（两处刻意的不同，都有实测依据）
 * ═══════════════════════════════════════════════════════════════
 *
 * `reconcileWithWordText` 里的 `canonical()` 做了三件事：去空白、全角折半角、
 * Unicode 上下标归基字符、转小写。放到机制 5 的键上有两处会**直接判错**：
 *
 * 1. **不转小写**。真实第 1 词里 `P`（墨迹高 **11.2**）与 `p`
 *    （**22.4 / 22.4 / 16.3**，`p` 带下延部）**同词共存**。一旦折成小写，
 *    `H('P')` 就变成 22.4 → 比值 **0.50 < 0.8** → 那个必须拒掉的
 *    `$^{P}$` 反而被判成「确实被缩小了」而**接受**。
 *    这也不只是数据巧合：`P`（大写高度）与 `p`（x 高度 + 下延部）在任何
 *    字体里都是**两个不同的高度**，Tesseract 的 `get_top_bottom` 同样是
 *    逐 `UNICHAR_ID` 查的，不折大小写。
 * 2. **不把 Unicode 上下标归到基字符**。`²`/`₂` 在查表**之前**就被
 *    `isUnicodeScriptChar` 例外接走了（上面已经说明理由）；留在同一张表里
 *    只会把「天生就矮的形态」混进 `2` 这个键（虽因取 max 而无害，但语义上
 *    是错的：那是两个不同的问题）。
 *
 * 保留全角折半角：第 20 词实测同一张图两次识别一次给 `（`、一次给 `(`，
 * 语义相同，不该因此找不到基准（与 `reconcileWithWordText` 同一口径）。
 *
 * ⚠️ 已知缺口（如实记录）：`-`(U+002D)、`−`(U+2212)、`–`、`—` 四种减号
 * 在这里是**四个不同的键**（`MINUS_LIKE_RE` 在机制 3 里把它们当同一个东西，
 * 这里没有）。若页面上只有 ASCII `-` 的实例、而候选是 `−`，就会查不到
 * 基准 → 按规则**拒绝**（假阴性）。实测数据里没有出现过这一形态，
 * 故不臆造折叠规则；真要修，就按 `MINUS_LIKE_RE` 的口径折。
 */
export function charSizeKey(char: string): string {
  return char.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
}

/**
 * 页级字符高度表：键 = `charSizeKey(char)`，值 = 该字符在整页实测到的
 * **最大墨迹高度（画布像素）**。
 */
export type CharSizeTable = ReadonlyMap<string, number>;

/**
 * 扫一遍**整页所有词**的字符框，建出机制 5 要用的那张表。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么用**像素**高度，而不用 `InkMeasurement.h`（归一化高度）
 * ═══════════════════════════════════════════════════════════════
 *
 * 同一批字符，`measurements[i].h` 是「墨迹高 / **本词裁剪**高」，分母逐词不同；
 * 而检测框的紧致程度差异极大（实测第 1 词的框高 43，里面真正的字高只有
 * 27.6）。用归一化高度跨词比较会**直接判错**，实测算术：
 *
 *   · 第 1 词（框内高 43 → 裁剪高 ≈ 49）的 `=`：6.1 / 49 ≈ **0.124**；
 *   · 第 16 词（框高 ≈ 23 → 裁剪高 ≈ 27）的同一个 `=`：6.1 / 27 ≈ **0.226**；
 *   · 比值 0.124 / 0.226 ≈ **0.55 < 0.8** → 本该**拒绝**的第 1 词等号
 *     会被判成「被缩小了」而**接受**。
 *
 * 换成像素高度：`6.1 / 6.2 = 0.984 > 0.8` → 拒绝 ✔。像素高度是**墨迹本身
 * 有多高**，两个词的框紧不紧都不影响它，这才是「该字符应有的高度」的口径。
 *
 * ═══════════════════════════════════════════════════════════════
 * 建表时丢掉什么（每一条都有依据）
 * ═══════════════════════════════════════════════════════════════
 *
 * 1. **没有墨迹测量值的条目**（`measurements[i] === null`）。
 *    `measureCharPixelSpans` 对没量到墨迹的字符给的是**整个裁剪**的纵向范围
 *    （`y0=0, y1=裁剪高`），那是坏数据，混进来会把某个键的 H 抬到天上。
 * 2. **异常测量值**：超过本词像素高度中位数 `SCRIPT_OUTLIER_RATIO`（1.5）倍的
 *    直接丢掉。实测依据：混进相邻行墨迹的那几个框高 **49**，而同词真正的
 *    字形高约 **27.6**（比值 1.78）。**不丢的后果是具体的**：指数里的
 *    `−`（7.2）会因为页面上存在一个 49 的坏框而得到比值 0.147 → 被放行。
 *    用「本词中位数」而不是「全页中位数」：一页里字号不止一种，全页中位数
 *    会把大字号的正常字也当成异常。
 * 3. **本身即 Unicode 上下标的字符**（`isUnicodeScriptChar`）：它们**天生就矮**，
 *    让它们参与「全尺寸高度」的定义是语义错误（`²` 只有 10.1，`2` 有 23）。
 *    它们也不会因此吃亏 —— 判据在查表**之前**就例外接受了它们。
 *
 * 取 `max` 而不是中位数/最小值，理由见 `SCRIPT_MECH5_SCALEDOWN_RATIO`
 * （「只以缩小形态出现」的字符必须得到比值 1）。
 *
 * @returns 至少 `SCRIPT_MECH5_MIN_WORDS` 个词提供了字符框时才返回表；
 *   否则返回 `null`（机制 5 不启用 —— 单词页上 H 退化成恒等式，见
 *   `SCRIPT_MECH5_MIN_WORDS`）。
 */
export function buildCharSizeTable(words: ReadonlyArray<OcrWord>): CharSizeTable | null {
  const table = new Map<string, number>();
  let contributingWords = 0;

  for (const word of words) {
    const attached = getAttachedChars(word);
    if (!attached || !attached.chars.length) continue;

    const { chars, measurements } = attached;
    const heights = new Map<number, number>();
    for (let i = 0; i < chars.length; i++) {
      // 只认「量到了墨迹」的条目（理由见上面第 1 条）
      if (!measurements[i]) continue;
      const box = chars[i];
      if (!box) continue;
      const px = box.y1 - box.y0;
      if (!Number.isFinite(px) || px <= 0) continue;
      heights.set(i, px);
    }
    if (!heights.size) continue;

    const median = medianOf([...heights.values()]);
    if (!(median > 0)) continue;
    const limit = median * SCRIPT_OUTLIER_RATIO;

    let contributed = false;
    for (const [i, px] of heights) {
      if (px > limit) continue; // 异常测量值（实测那些 49 高的坏框走这里）
      const char = chars[i]?.char ?? '';
      if (!char.trim()) continue;
      if (isUnicodeScriptChar(char)) continue;
      const key = charSizeKey(char);
      const prev = table.get(key);
      if (prev === undefined || px > prev) table.set(key, px);
      contributed = true;
    }
    if (contributed) contributingWords++;
  }

  if (contributingWords < SCRIPT_MECH5_MIN_WORDS) return null;
  return table;
}

/**
 * 机制 5 的**单字符**判定：这个候选是不是「确实被缩小了」。
 *
 * 判定顺序与每一条的兜底（返回值含义：`true` = 接受，`false` = 拒绝）：
 *
 *  1. 这个字符本身是 Unicode 上下标（`²`/`₂`…）→ **接受**（天生如此）；
 *  2. 拿不到字符身份（没传 `chars`、该位没有字符）→ **接受**
 *     （与机制 3「不传字符就不做标点拒绝」同一约定：没有身份就没有判据）；
 *  3. 拿不到该字符的**像素框** → **接受**。这里刻意不退回
 *     `measurements[i].h`：那是归一化量，与像素表混算会犯上面 `=` 那种错，
 *     宁可「不判」（退回机制 1+2，与改动前一致）；
 *  4. 表里没有该字符的实例（H 不存在）→ **拒绝**（它天生就这么矮）；
 *  5. 否则看 `h / H < SCRIPT_MECH5_SCALEDOWN_RATIO`。
 *
 * ⚠️ 第 6 条在真实路径上**不可达**，写出来是为了把话说死：候选字符的
 * 墨迹测量值一定先过了 `classifyCharsByGeometry` 的同一个
 * `SCRIPT_OUTLIER_RATIO` 过滤（它 ≤ 中位数 × 1.5），所以它自己的那条实例
 * 必定留在表里 → `H ≥ h` 恒存在。也就是说第 4 条只在「调用方把表与字符
 * 对错了」这种 API 误用时才起作用。
 */
function ownHeightAccepts(
  entry: { char: string; y0?: number; y1?: number } | undefined,
  table: CharSizeTable,
): boolean {
  const char = entry?.char ?? '';
  if (!char.trim()) return true;
  if (isUnicodeScriptChar(char)) return true;

  const full = table.get(charSizeKey(char));
  if (full === undefined || !(full > 0)) return false;

  const y0 = entry?.y0;
  const y1 = entry?.y1;
  if (typeof y0 !== 'number' || typeof y1 !== 'number') return true;
  const px = y1 - y0;
  if (!Number.isFinite(px) || px <= 0) return true;

  return px / full < SCRIPT_MECH5_SCALEDOWN_RATIO;
}

/** 机制 1 的产出：与 `kept` 逐位对齐的位置分类 */
interface ScriptLayout {
  /** 通过基准中位数与异常值过滤的字符下标（升序） */
  kept: number[];
  /** 与 `kept` 逐位对齐：每个字符是 normal / super / sub */
  pos: Array<'normal' | ScriptKind>;
}

/**
 * 机制 1（几何位置分类）的**独立实现**，供两处共用：
 *
 *  1. `classifyCharsByGeometry` 的逐字符过滤（原本就是这段内联代码）；
 *  2. `findRescuableRuns` 的段发现 —— 救回机制必须与判定用**同一套**
 *     候选定义，否则「哪一段是候选」会在两个地方各算一遍、各错一样。
 *
 * 返回 null 表示闸门没过（可测字符不足 / 基准高度非正 / 连基线都定不下来），
 * 与原来各个 `return []` 的时机逐一对应。
 */
function computeScriptLayout(
  measurements: ReadonlyArray<InkMeasurement | null | undefined>,
): ScriptLayout | null {
  const idx: number[] = [];
  for (let i = 0; i < measurements.length; i++) {
    const m = measurements[i];
    if (m && m.h > 0) idx.push(i);
  }
  if (idx.length < SCRIPT_MIN_MEASURED_CHARS) return null;

  /**
   * ═══════════════════════════════════════════════════════════════
   * 基准高度 = **中位数**（机制 1）
   * ═══════════════════════════════════════════════════════════════
   *
   * 为什么是它而不是「最大值 / 上四分位数」：这份真实数据里
   * p75 = 0.708 而 max = 1.361，两者相差一倍 —— 取分位数就等于让
   * 「拉丁字母」去和「被异常框撑大的基准」比，那一定判成「更矮」。
   * 中位数既挪不动（抗异常值），又不需要假设「总有更大的正常字」。
   */
  const mainHeight = medianOf(idx.map((i) => measurements[i]?.h ?? 0));
  if (!(mainHeight > 0)) return null;

  // 丢弃明显不是本行字形的测量值（超过基准 SCRIPT_OUTLIER_RATIO 倍）
  const kept = idx.filter((i) => (measurements[i]?.h ?? 0) <= mainHeight * SCRIPT_OUTLIER_RATIO);
  if (kept.length < SCRIPT_MIN_MEASURED_CHARS) return null;

  const bottoms = kept.map((i) => measurements[i]?.y1 ?? 0);
  const baseline = medianOf(bottoms);
  // 闸门：连两个「底边落在基线附近」的字符都没有时，基线本身无从谈起
  if (bottoms.filter((b) => b <= baseline + mainHeight * 0.25).length < SCRIPT_MIN_BASELINE_CHARS) {
    return null;
  }

  const unit = mainHeight * SCRIPT_CHAR_SHIFT_UNIT_RATIO;
  const minShift = unit * SCRIPT_CHAR_MIN_SHIFT_RATIO;

  const maxCandidateHeight = mainHeight * SCRIPT_CHAR_MAX_HEIGHT_RATIO;

  /**
   * 位置分类（机制 1）。顺序与 Tesseract 的 `if / else if` 逐条对齐：
   * 先问「底边是不是抬到了基线上方」→ 再问「顶边是不是掉到了基线下方」。
   *
   * ═══════════════════════════════════════════════════════════════
   * ⚠️ 位移的**上限**（`SCRIPT_CHAR_MAX_SHIFT_RATIO`）在重写后被删掉了
   * ═══════════════════════════════════════════════════════════════
   *
   * 旧实现有一条「位移 ≤ 0.5 × 主字高」的判据，用来挡「下一行的小字」。
   * 锚到基线上之后它不能留 —— 会**把真正的指数挡掉**。
   * 实测数字（第 1 词，`mainHeight = 0.5944`）：
   *
   *   · 指数 `x+y−2`：底边 0.3811，基线 0.7506 → 抬高 **0.3694**
   *     = 0.62 × mainHeight。**远超 0.5 的上限**，会被旧判据拒掉；
   *   · 同一份数据里旧代码挑出来的 `7`/`P`：抬高只有 0.18/0.21，
   *     反而在门槛之内 —— 也就是说这条上限**只挡对的、不挡错的**。
   *
   * 根因同样在「参照物」：旧上限是相对**被异常框撑大的最高字**定的，
   * 而真实排版里指数的抬升量本来就接近半个字号。
   *
   * 「下一行的小字」由另外两条挡住，而且挡得更准：
   *   · 候选高度必须 ≤ 0.8 × mainHeight（`maxCandidateHeight`）——
   *     邻行的正文与我们这行的中位字高同量级，第一个条件就不成立；
   *   · **机制 2 的置信度门** —— 邻行正文是被高置信度认出来的普通字。
   * 代价是如实记下的：**只靠几何**（没有置信度）那条路径上，
   * 「比本行中位字高小得多的、恰好悬在基线上方一行距离处的小字」
   * 现在会被判成上标。这条路径只出现在单测与拿不到置信度的降级场景里。
   */
  const pos = kept.map((i) => {
    const m = measurements[i] as InkMeasurement;
    if (m.h > maxCandidateHeight) return 'normal' as const;
    const up = baseline - m.y1;
    const down = m.y0 - baseline;
    if (up >= minShift - SHIFT_EPSILON) return 'super' as const;
    if (down >= minShift - SHIFT_EPSILON) return 'sub' as const;
    return 'normal' as const;
  });

  return { kept, pos };
}

/**
 * 判定一组字符里哪些是上标 / 下标。
 *
 * ═══════════════════════════════════════════════════════════════
 * 参照实现：Tesseract `ccmain/superscript.cpp`（David Eger, 2012, Apache-2.0）
 * https://tesseract-ocr.github.io/tessapi/3.05.02/a00149_source.html#l00253
 * ═══════════════════════════════════════════════════════════════
 *
 * 本函数按它的机制重写。**照搬的是机制，不是数字** —— 因为 Tesseract 面对的是
 * 「一行已经切好的 blob + 一个英文 unicharset 的字高表」，而这里面对的是
 * 「PP-OCR 的 CTC 逐字符框 + 中英数混排的扫描件」。两者能对齐的是判据的**形状**。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么必须重写（用户真实数据，实测复现）
 * ═══════════════════════════════════════════════════════════════
 *
 * 旧判据在用户那份中英数混排习题上把 `17`、`P`、`)`、`√`、`Y` 全包成了上标，
 * 而真正的指数 `x+y−2` 反而没判出来。这次用**第 1 词的真实字符框**跑了一遍，
 * 复现出的候选恰好是 `7` 与 `P`（真正的指数一个都没进）—— 症状完全对上。
 *
 * 根因有两条，都不是「阈值松紧」能修的：
 *
 *  1. **基准被污染**。旧代码的 `mainHeight` 取高度的**上四分位数**，
 *     而这份数据的高度分布是 p25=0.342、p50=0.594、p75=0.708、
 *     max=1.361（1.361 就是那几个混进相邻行墨迹的 49px 异常框）。
 *     于是 p75 只有 0.708，而拉丁数字/大写字母天生就落在这个值附近 ——
 *     「更矮」这道门对**每一个数字与字母**都成立，与它有没有被抬高无关。
 *  2. **只看几何**。`7`、`P` 都是被**高置信度**认出来的普通字，真正的指数
 *     是**小而模糊**的块。位置异常这件事，它们看起来是一样的（都是「更小 + 底边更高」）。
 *
 * 修法就是补上参考实现里有、而旧实现一个都没有的两条机制（见下）。
 *
 * ═══════════════════════════════════════════════════════════════
 * 机制 1（阈值锚在「基线」上，不是「最高字」）
 * ═══════════════════════════════════════════════════════════════
 *
 * Tesseract：
 *
 *     int super_y_bottom = kBlnBaselineOffset + kBlnXHeight * superscript_min_y_bottom;
 *     int sub_y_top      = kBlnBaselineOffset + kBlnXHeight * subscript_max_y_top;
 *     if (box.bottom() >= super_y_bottom) pos = SP_SUPERSCRIPT;
 *     else if (box.top() <= sub_y_top)    pos = SP_SUBSCRIPT;
 *
 * 关键是比的是**基线**，不是「最高的那个字」：
 *
 *   · `mainHeight` = 各字符墨迹高度的**中位数**。中位数天然抗异常值
 *     （49px 的框混进来也挪不动它），而**幂等** ——
 *     整行字都大，中位数就大；整行字都小，中位数就小，不需要任何外部字号。
 *     旧实现取「最大值 / 上四分位数」，方向正好相反：它假设**总有一个正常字**，
 *     而这份数据里「正常字」的高度与「拉丁字母」的高度差了一整个字号。
 *   · `baseline` = 可测字符底边的**中位数**。用中位数而不是最小值：
 *     带下延的 `p` / `y` 底边低于基线，最小值会被它们拉下去。
 *   · 位移单位 = `mainHeight × SCRIPT_CHAR_SHIFT_UNIT_RATIO`，
 *     于是 `SCRIPT_CHAR_MIN_SHIFT_RATIO` / `SCRIPT_CHAR_MAX_SHIFT_RATIO`
 *     这两个既有阈值有了明确的参照物。
 *
 * ⚠️ **没做**的那一半：Tesseract 用的是归一化坐标里写死的
 * `kBlnBaselineOffset`（=128）与 `kBlnXHeight`（=64，即 x 高度的 1/2）。
 * 本模块拿不到那套归一化坐标，只能从**当前这组测量值**里反推基线。
 * 这是本函数与参照实现之间最大的一处偏差，已在 `.test.ts` 里用真实数字钉住。
 *
 * ═══════════════════════════════════════════════════════════════
 * 机制 2（⭐ 位置异常 **且** 置信度明显偏低 —— 这是本实现此前完全缺失的一条）
 * ═══════════════════════════════════════════════════════════════
 *
 * Tesseract 分两步：
 *
 *     // Step one: 统计「正常字符」的平均置信度
 *     for each blob: if (pos == SP_NORMAL) { total += certainty; num_normal++; 记最差 }
 *     if (num_normal >= 3) { num_normal--; total -= worst; }   // 丢掉最差的那个
 *     avg_certainty      = total / num_normal;
 *     unlikely_threshold = superscript_worse_certainty * avg_certainty;
 *
 *     // Step two: 只切走「位置异常 **且** 置信度 < unlikely_threshold」的段
 *     if (char_certainty > unlikely_threshold) break;          // 置信度正常 → 不是上下标
 *
 * 这一条是**区分「普通小字」与「真上下标」的唯一手段**，因为两者的几何
 * 确实一样。本实现用 CTC 的逐字符置信度（口径见 `CtcDecoded.confidences`）。
 * 实测数字（第 1 词，真实字符框 + 真实识别置信度的分布）：
 *
 *   · `7`(底边 0.541)、`P`(底边 0.541)：几何上**都合格**，
 *     但置信度与平均之比 ≥ 0.94 → 过不了 0.8 这道门 → 被拒；
 *   · `x+y−2`（底边 0.600）：置信度低到 0.62 → 只有它们能过门 → 被留。
 *
 * ⚠️ 没有置信度时**不启用**这道门（退回纯几何）：既有调用点与既有测试
 * 都只传测量值。这条兜底是显式的 —— 判据不接受「用 0 补齐」的假数据，
 * 因为那会把所有字符都判成低置信度。缺失即不判。
 *
 * ═══════════════════════════════════════════════════════════════
 * 机制 3（拒绝标点）
 * ═══════════════════════════════════════════════════════════════
 *
 * Tesseract：`bool is_punc = unicharset->get_ispunctuation(unichar_id);`
 * 与 `bad_certainty` / `bad_height` / `is_italic` 并列，命中即拒。
 * 这里用 Unicode 类别 `\p{P}`。实测要拒的 `)`、`,`、`.`、`？` 全部命中；
 * 而指数里必须留的 `+`(Sm)、`-`(Pd)、`=`(Sm) 都**不是** `\p{P}` ——
 * 这条边界是量出来的，不是猜的（`\p{S}` 会把 `+` `=` 一起拒掉，
 * 那样 `$^{x+y-2}$` 就成不了段）。
 *
 * `is_italic`（机制 3 的另一半）**没做**：CTC 的逐字符输出里没有任何字体信息，
 * 拿不到就不编一个。见文件末尾「未实现的机制」一节。
 *
 * ═══════════════════════════════════════════════════════════════
 * 机制 5（按字符自身的预期高度校验 —— 第三道门，见 `sizeTable`）
 * ═══════════════════════════════════════════════════════════════
 *
 * 机制 2 的漏网之鱼是**罕见字形**（`∼` 的置信度天然就低，与大小无关）。
 * 机制 5 换一个问法：「这个字比它自己在本页的最大形态小了多少？」
 * 完整依据、定值与两条局限见 `SCRIPT_MECH5_SCALEDOWN_RATIO`。
 *
 * @param measurements 与 `chars` 逐字符对齐的归一化墨迹框（`ocrCharBoxes`
 *   的 `measurements`）。没量到墨迹的字符（空格等）为 null，直接跳过。
 * @param chars 与 `measurements` 逐字符对齐的字符本身（机制 3 要看它是不是标点）。
 *   不传则不做标点拒绝。
 * @param confidences 与 `measurements` 逐字符对齐的每字符置信度（机制 2）。
 *   **不给就不启用置信度门**；给了但有一个字符缺值，也整体不启用 ——
 *   半份置信度比没有更危险（缺的那几个会被当成「置信度为 0」而全部放行）。
 * @param sizeTable 机制 5 要用的**页级**字符高度表（`buildCharSizeTable` 的产出）。
 *
 *   ═══════════════════════════════════════════════════════════════
 *   机制 5 是**第三道门**，只在机制 2 通过之后生效 —— 不是替代
 *   ═══════════════════════════════════════════════════════════════
 *
 *   三道门的顺序是有依据的，**不能调换**：
 *
 *    1. **机制 1（几何）**：位置/大小都异常才有资格当候选。这一条最粗，
 *       但它把 99% 的正常字符挡在外面，也决定了后面两道门要不要跑；
 *    2. **机制 2（置信度）**：候选里「识别得很确定」的那些是普通小字，
 *       不是上下标 —— 实测第 1 词的 `P`（0.9877）、`=`（0.9965+）走这里；
 *    3. **机制 5（字符自身预期高度）**：**补机制 2 的漏**。机制 2 挡不住的
 *       恰恰是**罕见字形**（`∼` 的置信度 0.549/0.5816/0.5268，是误判字符
 *       里最低的），而「罕不罕见」与「小不小」是两件事。机制 5 问的是
 *       另一个问题（比它自己在本页的最大形态小了多少），所以必须排在
 *       机制 2 **之后**：先便宜地挡掉大部分，再对剩下的做这一次测量。
 *       反过来（先机制 5）没有收益：机制 1 已经把所有候选算出来了。
 *
 *   ⚠️ **不传（`undefined`/`null`）或空表时机制 5 完全不启用** ——
 *   行为与引入它之前**逐字节相同**。这条不变量由测试守着
 *   （`ocrCharBoxes.test.ts` 的机制 5 一组里那条「不变量」用例）。
 *
 * @param evidence 第二意见的证据框（`ocrTesseractScripts` 的产出，**画布坐标**，
 *   与 `chars[i].x0..y1` 同一坐标系）。不给 / 空数组 → **救回机制完全不启用**
 *   （与「不传表时机制 5 不启用」同一约定：没有测量就没有判据）。
 */
export function classifyCharsByGeometry(
  measurements: Array<InkMeasurement | null | undefined>,
  chars?: ReadonlyArray<{ char: string; y0?: number; y1?: number; x0?: number; x1?: number }> | null,
  confidences?: ReadonlyArray<number | null | undefined> | null,
  sizeTable?: CharSizeTable | null,
  evidence?: ReadonlyArray<InkEvidenceBox> | null,
): CharScript[] {
  const layout = computeScriptLayout(measurements);
  if (!layout) return [];
  const { kept, pos } = layout;

  /**
   * ═══════════════════════════════════════════════════════════════
   * 第二意见救回（见 `findRescuableRuns`）
   * ═══════════════════════════════════════════════════════════════
   *
   * 在逐字符过滤**之前**算出该救回哪些下标：救回的意义正是绕开
   * 机制 2 / 机制 5 —— 而那两个门恰恰在指数 `x+y−2` 上全数拒绝。
   * 三个条件（连续段、≥2 个字母数字字符确实被缩小、≥2 个字符被
   * tesseract 证据框覆盖）与各自的实测依据见 `findRescuableRuns`。
   *
   * 拿不到表或拿不到证据 → 一个都不救 → 与引入本机制前逐字节相同。
   */
  const rescued = new Set<number>();
  if (evidence?.length && sizeTable && sizeTable.size > 0 && chars) {
    for (const run of findRescuableRuns(measurements, chars, sizeTable)) {
      let covered = 0;
      for (let i = run.from; i <= run.to; i++) {
        if (coveredByEvidence(chars[i], evidence)) covered++;
      }
      if (covered >= SCRIPT_RESCUE_MIN_EVIDENCE_CHARS) {
        for (let i = run.from; i <= run.to; i++) rescued.add(i);
      }
    }
  }

  /**
   * ═══════════════════════════════════════════════════════════════
   * Step one：正常字符的平均置信度（机制 2）
   * ═══════════════════════════════════════════════════════════════
   *
   * **缺值不再是全局开关**：门槛只用**已知**置信度算（原来要求齐全，见下）
   * 都有一个有限的置信度。缺一个就整体不启用这道门（理由见函数文档）。
   */
  let worstNormal = Infinity;
  let normalTotal = 0;
  let normalCount = 0;
  for (let k = 0; k < kept.length; k++) {
    const c = confidences?.[kept[k] as number];
    // ⚠️ 有洞照算，**只用已知值**（原因见函数文档「缺值不再是全局开关」）
    if (typeof c !== 'number' || !Number.isFinite(c)) continue;
    if (pos[k] !== 'normal') continue;
    normalTotal += c;
    normalCount++;
    if (c < worstNormal) worstNormal = c;
  }

  let unlikelyThreshold: number | null = null;
  if (normalCount >= 3) {
    // 丢掉最差的那一个：它是**唯一**一个可能在数据上「又正常又低置信」的字符
    // （真实的低置信字符几乎都会被位置判据归到候选段里；落在 normal 这边的那一个
    //  多半是识别抖动），留着会把门槛整体拉低。与 Tesseract 逐字一致。
    const adjusted = normalTotal - worstNormal;
    const adjustedCount = normalCount - 1;
    unlikelyThreshold =
      adjustedCount > 0 ? SCRIPT_WORSE_CERTAINTY * (adjusted / adjustedCount) : null;
  }

  /**
   * ═══════════════════════════════════════════════════════════════
   * Step two：逐字符过滤（机制 2 的置信度门 + 机制 3 的标点）
   * ═══════════════════════════════════════════════════════════════
   *
   * 与 Tesseract 的差别：它是「从头/从尾遇上第一个置信度正常的就 break」，
   * 我们这里**逐字符独立过滤**。原因是候选段在词内的形态不同：
   * `p(1−p)^{x+y−2}` 的指数**后面还接着正文**（`,0 < p < 1,…`），
   * 而指数内部并不保证每个字符都同样模糊 —— 一旦中间有一个字符的置信度
   * 略高于门槛，`break` 会把整段腰斩成 `x$^{+y}$` 这种错公式。
   * 按字符过滤最坏是漏掉那个字符，不会有半段公式。方向与全文件一致：宁可漏判。
   *
   * ⚠️ 结果**按 index 升序**返回（`kept` 本身就是升序构造的，这里显式再排一次），
   * `groupScriptFragments` 依赖这个顺序来并连续段。
   */
  const out: CharScript[] = [];
  for (let k = 0; k < kept.length; k++) {
    const kind = pos[k];
    if (kind === 'normal') continue;
    const i = kept[k] as number;

    // 机制 3：标点一律不是上下标（减号类豁免，理由见 `MINUS_LIKE_RE`）
    if (chars && isPunctuationChar(chars[i]?.char ?? '')) continue;

    /**
     * ⚠️ 汉字**不能**被当成上标（本实现特有的一条，Tesseract 没有）。
     *
     * 依据是一次真实的坏输出：`(1$^{)问}$ X 和 Y 是否相互独立？` ——
     * `问` 整个汉字被包进了上标。原因是标点的**墨迹天生就小**
     * （`）` 只有 9px 高），语料里又常有「一个标点带一个汉字」的检测框
     * （`）问`），于是那个汉字跟着标点一起满足了「更小 + 更高」。
     *
     * 中英混排下这条判据不会误伤真上下标：实测的指数、下标
     * （`x+y−2`、`n1`、`n2`）里一个汉字都没有。数学上下标本来就不用汉字。
     */
    if (CJK_CHAR_ONLY_RE.test(chars?.[i]?.char ?? '')) continue;

    /**
     * ═══════════════════════════════════════════════════════════════
     * 第二意见救回：这几个字符已被 `findRescuableRuns` + 证据框共同选中
     * ═══════════════════════════════════════════════════════════════
     *
     * 位置在机制 3 与汉字门**之后**：这两条是「这个字符在语义上不可能是
     * 上下标」的硬事实（标点、汉字），救回不推翻它们 —— 指数的 `+`/`−`
     * 本来就靠减号类豁免与标点判据通过，不靠救回。
     *
     * 位置在机制 2 / 机制 5 **之前**：救回的全部意义就是绕开这两个门。
     * 实测（第 1 词 53 个字符）：五个指数字符的置信度
     * 0.9953 / 0.9997 / 0.9205 / 0.957 / 0.9883 全部高于机制 2 的门槛
     * （≈0.91），机制 5 又只能接受其中 `x`/`y`/`2` 三个 —— 不绕开
     * 就被全数拒绝，而它恰恰是全页唯一真实的公式角标。
     */
    if (rescued.has(i)) {
      out.push({ index: i, kind });
      continue;
    }

    // 机制 2：置信度正常 → 不是上下标
    if (unlikelyThreshold !== null) {
      const c = confidences?.[i];
      /**
       * ⚠️ 缺值 → **不拒绝**，退回几何判据。
       *
       * 原来这里是 `if (缺值) continue;`，等于把缺值当成 0 → 一律拒绝。
       * 实测 17 个词里 11 个缺值，而**所有出误判的词都在那 11 个里** ——
       * 也就是说这条门在该用它的地方**从未运行**。缺值本就无法证明「置信度正常」，
       * 拿它当拒绝理由是错的。
       */
      if (typeof c === 'number' && Number.isFinite(c) && !(c <= unlikelyThreshold)) continue;
    }

    /**
     * ═══════════════════════════════════════════════════════════════
     * 机制 5：按字符**自身**的预期高度校验（第三道门，见 `sizeTable` 的说明）
     * ═══════════════════════════════════════════════════════════════
     *
     * 走到这里说明这个字符已经同时通过了机制 1（几何）与机制 2（置信度），
     * 而机制 2 漏掉的正是 `∼` 这种**罕见但没被缩小**的字形
     * （实测置信度 0.549/0.5816/0.5268，低是因为字形罕见，不是因为小）。
     *
     * 空表按「没有表」处理：一张**空**的表意味着「整页找不到任何实例」，
     * 那与「拿不到表」在信息量上没有区别，拿它去判会把所有候选一律拒掉 ——
     * 那不是测量，是缺省值造成的假结论。
     */
    if (sizeTable && sizeTable.size > 0) {
      if (!ownHeightAccepts(chars?.[i], sizeTable)) continue;
    }

    out.push({ index: i, kind });
  }

  return out.sort((a, b) => a.index - b.index);
}

// ───────────────────────────────────────────────────────────────
// 4c. 第二意见救回（tesseract 的字符框证据）
// ───────────────────────────────────────────────────────────────

/**
 * 第二意见给出的**证据框**：一个「墨迹小且抬高了」的字符。
 *
 * ⚠️ 坐标系：与 `chars[i]` 的 `x0/y0/x1/y1` **同一空间**（词框 / 导出坐标，
 * 见 `attachCharBoxes` 的 `(cropOrigin + c) / scale`）。`ocrTesseractScripts`
 * 负责把 tesseract 的裁剪内坐标映射过来 —— 映射错了这里不会报错，
 * 只会安静地判成「没覆盖」，所以两边都有测试盯着。
 */
export interface InkEvidenceBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * ═══════════════════════════════════════════════════════════════
 * 救回段的条件 (b)：至少两个「确实被缩小的字母数字」
 * ═══════════════════════════════════════════════════════════════
 *
 * 这条是**正向测量**：字符的身份是可比的字母/数字，且它在**本页**的
 * 最大形态（`sizeTable`）比它现在大 —— 也就是「它被缩小了」这件事
 * 有同页的对照物作证，而不是靠某一处的绝对值。
 *
 * 为什么是 2 而不是 1：单个字符的「更小」有太多解释（一个矮字形、
 * 一次测量抖动、一个被切掉一半的框）。两个**连着的**字符同时成立，
 * 才说得上「这一串是排版上特殊的」。实测第 1 词指数 `x+y−2` 里
 * 有 `x`(7.2/20.4)、`y`(7.2/20.4)、`2`(12.3/23) 三个成立。
 */
export const SCRIPT_RESCUE_MIN_CONFIRM_CHARS = 2;

/**
 * ═══════════════════════════════════════════════════════════════
 * 救回段的条件 (c)：至少两个字符被 tesseract 的证据框覆盖
 * ═══════════════════════════════════════════════════════════════
 *
 * 这条是**独立证据**：另一个引擎在同一位置也量到了「小且抬高」的墨迹。
 * 它与 (b) 量的是两件不同的事 —— (b) 只看**大小**（不与位置有关），
 * (c) 只看**位置**（不与大小有关，因为证据框的判据已经在 tesseract 侧
 * 用过一次高度与基线）。两条同时成立才算数，实测依据见 `findRescuableRuns`。
 */
export const SCRIPT_RESCUE_MIN_EVIDENCE_CHARS = 2;

/**
 * 证据框要「覆盖」一个字符，两条轴上的重叠都得达到**较短边**的这个比例。
 *
 * 取「较短边」而不是「字符边」：tesseract 的字形框与 CTC 的时间步框
 * 不是一个切法，两者宽度常有系统差（CTC 框含字间距、tesseract 只框墨迹）。
 * 拿较短的做分母，等于要求「小的一边被大的一边吃掉至少一半」——
 * 方向保守（宁可不覆盖），与全文件一致。
 *
 * 实测（第 1 词指数，见测试夹具）：`x` 0.56、`y` 0.88、`2` 0.86，
 * 三个都过线；其中 `x` 是最紧的一个，阈值每加 0.1 就会少一个覆盖 ——
 * 但它仍有 3 个 ≥ 2，所以这条阈值的具体取值在这份数据上不翻面。
 */
export const SCRIPT_RESCUE_COVER_RATIO = 0.5;

/** 救回的候选：可比的字母 / 数字（`\p{L}` 含汉字，故下方要单独排除） */
const LETTER_OR_DIGIT_RE = /[\p{L}\p{N}]/u;

/** `findRescuableRuns` 的一段产出：字符下标区间（含两端）与 (b) 的计数 */
export interface ScriptRescueRun {
  from: number;
  to: number;
  /** 段内同时满足「是字母数字」与「确实被缩小了」的字符数（≥ 2 才会出现在结果里） */
  confirmChars: number;
}

/**
 * 找出**值得请第二意见复核**的字符段。
 *
 * ═══════════════════════════════════════════════════════════════
 * 它要解决的缺口：机制 2 与机制 5 会**联手**把真指数拒掉
 * ═══════════════════════════════════════════════════════════════
 *
 * 第 1 词（真实导出）的指数 `x+y−2` 是五个字符的连续段，实测：
 *
 *   · 机制 2（置信度门）：五个字符的置信度 0.9953 / 0.9997 / 0.9205 /
 *     0.957 / 0.9883，**全部高于**门槛（≈0.91）→ 全数被拒。
 *     这不是阈值没调好：PP-OCR 对这几个字形认得很确定 ——
 *     而 Tesseract 的 superscript.cpp 敢用「置信度低」当判据，是因为
 *     它的**小字天生识别得更差**。这份数据里不成立。
 *   · 机制 5（页级字符高度）：只能接受 `x`/`y`/`2` 三个；`+` 与 `−`
 *     在整页只以缩小形态出现（`+` 的另一个实例在第 16 词、只有 1.8 高）
 *     → H = h → 比值 1.0 → 被拒。
 *
 * 两门联手的结果：**全页唯一真实的公式角标，五个字符一个都留不下。**
 * 所以救回必须**整段绕开机制 2 与机制 5**（而不是放宽它们 ——
 * 放宽会立刻把第 16 词、第 20 词那些误判放回来，见下）。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么段必须是**连续下标**，且救回要覆盖整段
 * ═══════════════════════════════════════════════════════════════
 *
 * 组装端 `groupScriptFragments` 只把 `chars` 里**连续**的同类上下标
 * 并成一个 `$^{...}$`。只救 `x`/`y`/`2` 三个（`+`/`−` 仍被机制 5 拒）
 * 会输出 `$^{x}$+$^{y}$-$^{2}$` —— 三个单字上标加两个正文符号，
 * 比不判更糟。段一旦成立就整段救回，`x+y−2` 才能成段。
 *
 * ═══════════════════════════════════════════════════════════════
 * 两条条件都必须存在 —— 这是两个**实测反例**逼出来的
 * ═══════════════════════════════════════════════════════════════
 *
 * 反例一（第 16 词，`⋯ Z = √X² + Y 的概率密度为`）：机制 1 给出的候选段
 * 是 `2+Y` 三个连续字符（`2` 是 X 的真上标，`+Y` 是正文）。条件 (b) 成立
 * （`2` 11.4/23 = 0.496、`Y` 13.1/21.4 = 0.61），**只凭 (b) 就会把整段
 * 救回来** → 输出 `$^{2+Y}$`，把正文 `+Y` 吞进上标。实测 tesseract
 * 在这一区域的证据框是 **0 个** → (c) 拦住。
 *
 * 反例二（第 20 词，`⋯ X ∼ b(n₁,p),Y∼ b(n₂,p),…`）：候选段是
 * `=∼∼∼`（等号带三个 `∼`，全是误判）。实测 tesseract 的证据框
 * **3 个，全部压在 `∼` 上**（它就是「小而抬高」的墨迹，只是不是角标）。
 * **只凭 (c) 就会把整段救回来** → 把 `=∼∼∼` 包成上标，恰好退回
 * 机制 5 存在的意义。条件 (b) 在这里是 0（`=`/`∼` 都不是字母数字）→ 拦住。
 *
 * 于是这两条条件在这份真实数据上**各自都是载荷**：去掉任何一条，
 * 都有一个已知的坏输出立刻回来。三个词各自的读数：
 *
 *   · 第 1 词指数：(b) 3 个（x/y/2）、(c) 3 个覆盖（实测 x 0.56、y 0.88、2 0.86）→ 救回 ✔
 *   · 第 16 词 `2+Y`：(b) 2 个、(c) **0** 个 → 不救 ✔
 *   · 第 20 词 `=∼∼∼`：(b) **0** 个、(c) 3 个 → 不救 ✔
 *
 * ═══════════════════════════════════════════════════════════════
 * 拿不到输入时的行为
 * ═══════════════════════════════════════════════════════════════
 *
 * `chars` / `sizeTable` 缺任一个、或表为空 → 返回空数组（无段可救）。
 * 这是**显式的降级路径**，与机制 5「没有表就不启用」同一约定：
 * 没有测量就没有判据，绝不拿缺省值去判。
 */
export function findRescuableRuns(
  measurements: ReadonlyArray<InkMeasurement | null | undefined>,
  chars?: ReadonlyArray<{ char: string; y0?: number; y1?: number }> | null,
  sizeTable?: CharSizeTable | null,
): ScriptRescueRun[] {
  if (!chars || !sizeTable || sizeTable.size === 0) return [];

  const layout = computeScriptLayout(measurements);
  if (!layout) return [];
  const { kept, pos } = layout;

  const runs: ScriptRescueRun[] = [];
  let cur: { from: number; to: number } | null = null;

  // 收尾时才算 (b)：段内「是的字母数字 **且** 确实被缩小了」的字符个数
  const finish = (): void => {
    if (!cur) return;
    let confirmChars = 0;
    for (let i = cur.from; i <= cur.to; i++) {
      if (isScaledDownLetterOrDigit(chars[i], sizeTable)) confirmChars++;
    }
    if (confirmChars >= SCRIPT_RESCUE_MIN_CONFIRM_CHARS) {
      runs.push({ from: cur.from, to: cur.to, confirmChars });
    }
    cur = null;
  };

  for (let k = 0; k < kept.length; k++) {
    const i = kept[k] as number;
    if (pos[k] === 'normal') {
      finish();
      continue;
    }
    // 段内必须**下标连续**：`kept` 里相邻但在原串里隔了一个字符（正常字符
    // 或没量到墨迹的字符）就不是同一段，组装端也并不起来。
    if (cur && i === cur.to + 1) {
      cur.to = i;
      continue;
    }
    finish();
    cur = { from: i, to: i };
  }
  finish();

  return runs;
}

/**
 * 条件 (b) 的单字符判定。
 *
 * 与机制 5 的 `ownHeightAccepts` 有两处**刻意的不同**，都是因为这里要的是
 * 「正向确认」而不是「不拒绝」：
 *
 *  1. `ownHeightAccepts` 在**拿不到像素框**时返回 `true`（不判），这里返回
 *     `false` —— (b) 是计数，缺值不能算一个确认；
 *  2. 这里要求字符身份是**字母 / 数字**（并排除汉字与 Unicode 上下标字符）——
 *     实测依据就是反例二：第 20 词那三个 `∼` 与一个 `=` 在机制 5 的
 *     「缩小」判据下全部成立（表里 `∼` 5.1 vs 它自己 5.1 不成立，
 *     但 `=` 6.2 vs 6.2 同样不成立 —— 总之它们提供不了正向的
 *     「被缩小」证据），而真正的问题是**它们根本不是角标该有的字符**。
 *
 * ⚠️ `\p{L}` **包含汉字**（`均`/`为`/`正` 都是 `Lo`），所以必须显式排除 ——
 * 与 `classifyCharsByGeometry` 里那道汉字门同一个理由、同一个正则。
 */
function isScaledDownLetterOrDigit(
  entry: { char: string; y0?: number; y1?: number } | undefined,
  table: CharSizeTable,
): boolean {
  const char = entry?.char ?? '';
  if (!char.trim()) return false;
  if (isUnicodeScriptChar(char)) return false;
  if (CJK_CHAR_ONLY_RE.test(char)) return false;
  if (!LETTER_OR_DIGIT_RE.test(char)) return false;

  const y0 = entry?.y0;
  const y1 = entry?.y1;
  if (typeof y0 !== 'number' || typeof y1 !== 'number') return false;
  const px = y1 - y0;
  if (!Number.isFinite(px) || px <= 0) return false;

  const full = table.get(charSizeKey(char));
  if (full === undefined || !(full > 0)) return false;
  return px / full < SCRIPT_MECH5_SCALEDOWN_RATIO;
}

/** 一条轴上，`[b0,b1]` 被 `[a0,a1]` 覆盖的比例（分母 = 两条里**较短**的那条） */
function axisCoverage(a0: number, a1: number, b0: number, b1: number): number {
  const overlap = Math.min(a1, b1) - Math.max(a0, b0);
  if (!(overlap > 0)) return 0;
  const minDim = Math.min(a1 - a0, b1 - b0);
  if (!(minDim > 0)) return 0;
  return overlap / minDim;
}

/**
 * 条件 (c) 的单字符判定：这个字符的像素框是否被**任一个**证据框覆盖
 * （两条轴的重叠都 ≥ `SCRIPT_RESCUE_COVER_RATIO`）。
 *
 * 拿不到字符框 → `false`（覆盖是计数，缺值不算）。
 * 证据框里只要有一个成立即可 —— 多个证据框是**多个**独立观察，
 * 任意一个与这个字符对上就够，不需要它们互相一致。
 */
function coveredByEvidence(
  entry: { x0?: number; y0?: number; x1?: number; y1?: number } | undefined,
  evidence: ReadonlyArray<InkEvidenceBox>,
): boolean {
  const x0 = entry?.x0;
  const y0 = entry?.y0;
  const x1 = entry?.x1;
  const y1 = entry?.y1;
  if (typeof x0 !== 'number' || typeof x1 !== 'number') return false;
  if (typeof y0 !== 'number' || typeof y1 !== 'number') return false;
  if (!(x1 > x0) || !(y1 > y0)) return false;

  for (const e of evidence) {
    if (axisCoverage(x0, x1, e.x0, e.x1) >= SCRIPT_RESCUE_COVER_RATIO &&
        axisCoverage(y0, y1, e.y0, e.y1) >= SCRIPT_RESCUE_COVER_RATIO) {
      return true;
    }
  }
  return false;
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

/**
 * 挂在词上的字符框：像素框（画布坐标）+ 归一化墨迹（判据用）+ 每字符置信度。
 *
 * `confidences` 是**可选**的：它由 `reconcileWithWordText` 在拿到逐字符
 * 置信度时才产出（判据的机制 2 需要它）。缺省时判据退回纯几何 ——
 * 这是显式的两条路径，不是「用 0 补齐」。理由见 `classifyCharsByGeometry`。
 */
export interface AttachedChars {
  chars: OcrChar[];
  measurements: Array<InkMeasurement | null>;
  confidences?: number[];
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
        recognized.confidences,
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

      charBoxRegistry.set(word, {
        chars,
        measurements: aligned.measurements,
        ...(aligned.confidences ? { confidences: aligned.confidences } : {}),
      });
      attached++;
    } catch (err) {
      options.onSkip?.(word, `字符框失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return attached;
}

/**
 * 去掉首尾空白字符（`OcrWord.text` 是 trim 过的，字符框必须跟着对齐）。
 *
 * 置信度与字符、测量值**共用同一段下标区间**：三者必须逐位对齐，
 * 各切各的一定会错位，而错位的置信度比没有置信度更糟（机制 2 会拿
 * 别的字符的置信度去决定这个字符的命运）。
 */
function trimCharRange(
  chars: OcrChar[],
  measurements: Array<InkMeasurement | null>,
  confidences?: ReadonlyArray<number | null | undefined> | null,
): {
  chars: OcrChar[];
  measurements: Array<InkMeasurement | null>;
  confidences?: number[];
  text: string;
} {
  let from = 0;
  let to = chars.length;
  while (from < to && !(chars[from]?.char ?? '').trim()) from++;
  while (to > from && !(chars[to - 1]?.char ?? '').trim()) to--;
  const slicedChars = chars.slice(from, to);
  const slicedMeasure = measurements.slice(from, to);
  const slicedConfidences = confidences ? confidences.slice(from, to) : null;
  const keptConfidences = slicedConfidences
    ? slicedConfidences.map((c) => (typeof c === 'number' && Number.isFinite(c) ? c : Number.NaN))
    : null;
  return {
    chars: slicedChars,
    measurements: slicedMeasure,
    // 有一个缺值就整条不给：半份置信度会让机制 2 的门槛算错（见函数文档）
    ...(keptConfidences && keptConfidences.some((c) => Number.isFinite(c))
      ? { confidences: keptConfidences }
      : {}),
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
  confidences?: ReadonlyArray<number | null | undefined> | null,
): { chars: OcrChar[]; measurements: Array<InkMeasurement | null>; confidences?: number[] } | null {
  const target = wordText.trim();
  if (!target) return null;

  /**
   * 置信度只在**输入里齐全**时才往下传。
   *
   * 与 `measurements` 不同：后者缺一个只影响那一个字符（`null` 就是它的表示），
   * 而置信度缺一个会让机制 2 的门槛算错（缺值会被当成 0），所以要么全有、
   * 要么整条不给。`alignConfidences` 为 null 时下游退回纯几何判据。
   */
  /**
   * ⚠️ 长度不等**不再整条丢弃**，而是补齐到 `chars.length`，洞位记 `NaN`。
   *
   * 原来要求 `confidences.length === chars.length`，否则整条给 null。
   * 用户真实导出（`buildId 2026-10-08T09:42:56.578Z`）显示后果是灾难性的：
   * 17 个有字符框的词里 **11 个** `charConfidencesComplete: false`、逐字符置信度
   * 全是 `null` —— 而**所有出误判的词（1/15/16/20）都在那 11 个里**。
   * 补一个洞最多让那一个字符退回几何判据，丢掉整条却会让整页退回几何。
   */
  const alignConfidences = confidences?.some((c) => Number.isFinite(c))
    ? chars.map((_, i) =>
        Number.isFinite(confidences[i]) ? (confidences[i] as number) : Number.NaN,
      )
    : null;

  const trimmed = trimCharRange(chars, measurements, alignConfidences);

  if (trimmed.text === target) {
    return {
      chars: trimmed.chars,
      measurements: trimmed.measurements,
      ...(trimmed.confidences ? { confidences: trimmed.confidences } : {}),
    };
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
      // Unicode 上下标字符归到基字符：实测第 20 词里 `n₂`(U+2082) 与 `n2`
      // 是同一张图的两次识别结果 —— 一次给真下标字符、一次给普通数字。
      // 语义相同，不该因此丢掉整行的字符框。
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

  /**
   * ═══════════════════════════════════════════════════════════════
   * 序列对齐：允许识别结果**多出**字符，不允许它**漏掉**字符
   * ═══════════════════════════════════════════════════════════════
   *
   * 此前要求两边（归一化后）**完全相同**，于是含指数的第 1 词被丢掉：
   *
   *   识别 `…=p²(1−p)x+y−2…`   期望 `…=p(1−p)x+y−2…`
   *                              ↑ 识别多出一个 `²`
   *
   * 其余逐个吻合 —— 多出来的那个跳过即可，**期望里每个字符仍然都有框**。
   *
   * 反过来不行：期望里有、识别里没有（实测 `μ>0` 被读成 `μ0`，漏了 `>`），
   * 说明从漏掉那一点起对应关系已经不可靠，必须整条拒绝 ——
   * 这正是原来那道闸要防的事（错位的框比没有框更糟）。
   *
   * 所以规则是**不对称**的，而这个不对称有依据：
   * **多识别**只影响被跳过的那一个字符，**漏识别**会让它后面全部错位。
   */
  const targetChars = [...target].filter((ch) => ch.trim());
  if (!targetChars.length) return null;

  /**
   * 整串识别结果也要能容下 target（与逐字符对齐互为印证）。
   *
   * 两者本该一致，但它们的来源不同：`recognizedText` 是识别器给的整串，
   * `trimmed.chars` 是逐字符框拼出来的。若只有一边对得上，说明中间某处
   * 出了问题，此时拒绝比给出坐标安全。
   */
  const recCanon = canonical(recognizedText);
  const tgtCanon = canonical(target);
  let matched = 0;
  for (const ch of recCanon) {
    if (matched < tgtCanon.length && ch === tgtCanon[matched]) matched++;
  }
  if (matched !== tgtCanon.length) return null;

  const keptChars: OcrChar[] = [];
  const keptMeasure: Array<InkMeasurement | null> = [];
  const keptConfidence: number[] = [];
  let cursor = 0;
  let skipped = 0;

  /**
   * ⚠️ 输出必须与 **`target` 逐位对齐**，包括空白位置。
   *
   * 这一点是契约，不是实现细节：`emitWordWithCharScripts` 是按**下标**在
   * `word.text` 上切片的，字符数组一旦与原文错位，切出来的就是别的字。
   *
   * 所以空白位与「识别漏掉」的位置都要占一个位置，只是**测量值为 null**
   * （`classifyCharsByGeometry` 本来就会跳过 null —— 没有墨迹就没有几何可言）。
   * 两条路径（精确匹配 / 序列对齐）由此得到**同一个**契约。
   *
   * 置信度同理必须逐位补齐：占位处填 `NaN`（而不是 0），
   * 好让下游一眼看出「这个位置没有置信度」而不是「它的置信度极低」。
   */
  let prevX = 0;
  let prevY = 0;
  for (const want of [...target]) {
    if (!want.trim()) {
      // 空白：占位，无墨迹、无置信度
      keptChars.push({ char: want, x0: prevX, y0: prevY, x1: prevX, y1: prevY });
      keptMeasure.push(null);
      keptConfidence.push(Number.NaN);
      continue;
    }

    const wantC = canonical(want);
    let found = -1;
    for (let j = cursor; j < trimmed.chars.length; j++) {
      const c = trimmed.chars[j];
      if (!c || !c.char.trim()) continue;
      if (canonical(c.char) === wantC) {
        found = j;
        break;
      }
      skipped++;
    }
    if (found < 0) return null;

    const hit = trimmed.chars[found] as OcrChar;
    // 字符身份取**原文**的 `want`（输出以 `word.text` 为准），几何取识别到的
    keptChars.push({ char: want, x0: hit.x0, y0: hit.y0, x1: hit.x1, y1: hit.y1 });
    keptMeasure.push(trimmed.measurements[found] ?? null);
    keptConfidence.push(trimmed.confidences?.[found] ?? Number.NaN);
    prevX = hit.x1;
    prevY = hit.y0;
    cursor = found + 1;
  }

  /**
   * 跳过的字符不能太多。
   *
   * 不设上限时，一段胡乱识别的文本也可能「碰巧」把 target 当子序列匹配上，
   * 那种对齐给出的坐标是错的。上限取「目标长度的四分之一，且至少允许 2 个」：
   * 实测词 1 只多出 **1** 个字符，离上限很远；胡乱匹配通常要跳过一大半。
   */
  const maxSkip = Math.max(2, Math.ceil(targetChars.length * 0.25));
  if (skipped > maxSkip) return null;

  if (keptChars.length !== [...target].length) return null;
  /**
   * 置信度同样只在**每一位都有真实取值**时才交出去。
   * 这条路径上「识别多出一个字符」是常态（实测词 1 多一个 `²`），
   * 被跳过的那一位自然没有置信度 —— 若把它当成 0 混进去，
   * 机制 2 的门槛会被整体拉低，反而放行本该拒掉的候选。
   */
  const anyConfidenceKnown = keptConfidence.some((c) => Number.isFinite(c));
  return {
    chars: keptChars,
    measurements: keptMeasure,
    ...(anyConfidenceKnown ? { confidences: keptConfidence } : {}),
  };
}
