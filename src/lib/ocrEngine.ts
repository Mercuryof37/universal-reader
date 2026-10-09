/**
 * PaddleOCR 引擎封装（替换原 Tesseract.js）。
 *
 * 选用 ppu-paddle-ocr/web + PP-OCRv6 small 模型：
 * - 中文识别准确率远超 Tesseract（PP-OCR 专为中文训练）；
 * - 50+ 语言全字典，无需手动选语言包；
 * - ONNX Runtime Web (WASM) 运行，纯浏览器端。
 */
import { PaddleOcrService } from 'ppu-paddle-ocr/web';
// 结果类型**必须显式导入**，不能靠 `ReturnType<PaddleOcrService['recognize']>`：
// `recognize` 是重载函数，`ReturnType` 只会取到其中一个重载的返回类型
// （实测取到的是 `PaddleOcrResult`，即按行分组、带 `lines` 的那一支），
// 而本文件**始终**以 `{ flatten: true }` 调用，运行时拿到的是扁平结果（带 `results`）。
// 两者对不上就会报「`results` 不存在」——之前那版正是这样留下 4 个类型错误。
import type { FlattenedPaddleOcrResult } from 'ppu-paddle-ocr/web';
import * as ort from 'onnxruntime-web';
import { errorReport } from '@/lib/diagnostics';
import { recognizeFormula } from '@/services/formulaOcrService';
import { useSettingsStore } from '@/store/settingsStore';
import { OCR_MODEL_BASE, OCR_MODEL_FILES, buildOcrModel } from '@/lib/ocrModelSource';
import { resolveExecutionProviders } from '@/lib/ocrExecutionProvider';
import { noteOcrStage } from '@/lib/sessionDiagnostics';
import {
  attachCharBoxes,
  buildCharSizeTable,
  clearCharBoxSkips,
  createWordCharBoxRecognizer,
  recordCharBoxSkip,
} from '@/lib/ocrCharBoxes';
import type { OcrCanvasLike } from '@/lib/ocrCharBoxes';
import {
  attachTesseractEvidence,
  clearTesseractEvidence,
  resetScriptSecondOpinion,
} from '@/lib/ocrTesseractScripts';
import {
  admitRetryWords,
  detectMissedInkRegionsFromCanvas,
  overlapRatio,
  planRetryCrop,
  type MissedInkRegion,
  type RetryCropPlan,
} from '@/lib/ocrInkRegions';

/** 「裁剪 → 字符框」的识别器；建不起来时是 null（见 `ensureCharBoxRecognizer`） */
type CharBoxRecognizer = Awaited<ReturnType<typeof createWordCharBoxRecognizer>>;

// Force ONNX Runtime to load WASM from CDN instead of bundling locally.
// The .wasm file is ~28MB which exceeds Cloudflare Pages' 25MB limit.
ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ort.env.versions.web ?? ort.env.versions.common}/dist/`;

/**
 * 单线程运行 ONNX。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么必须设成 1
 * ═══════════════════════════════════════════════════════════════
 *
 * ONNX Runtime Web 默认会按 CPU 核数起线程池，用它那个
 * `ort-wasm-simd-threaded.*.wasm` 构建。多线程版本依赖：
 *   · `SharedArrayBuffer` —— 需要页面处于**跨源隔离**（COOP/COEP 响应头），
 *     本站在 Cloudflare Pages 上并未开启；
 *   · 从脚本 URL 创建 **Worker** —— 而我们的 wasm/worker 是从
 *     `cdn.jsdelivr.net` **跨源**加载的，浏览器不允许从跨源地址直接 new Worker。
 *
 * 这两条一旦失败，Emscripten 的运行时会走 `abort()` 路径。
 * `abort()` **不是 JS 异常**，它直接终止执行环境 ——
 * 页面不会留下任何报错、不会进入我们的 catch，用户只看到进程消失、
 * 页面被重载。这正是用户实测到的形态：
 *   「刷新来源：不是应用发起的」「中断前最后走到：recognize」
 *
 * 设成 1 之后完全不用线程池，也就不碰 SharedArrayBuffer 与跨源 Worker。
 * 代价是推理慢一些，但换来的是**失败时抛正常异常、能显示成错误横幅**，
 * 而不是静默把页面带走。
 */
ort.env.wasm.numThreads = 1;
import {
  OCR_BLANK_LUMA_THRESHOLD,
  OCR_MAX_PIXELS,
  type OcrLang,
  type OcrPageResult,
  type OcrProgress,
  type OcrWord,
} from '@/lib/ocrTypes';

export interface CanvasInkStats {
  darkRatio: number;
  meanLuma: number;
  width: number;
  height: number;
  failed: boolean;
  sampleWidth: number;
  sampleHeight: number;
}

export function analyzeCanvasInk(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  threshold = OCR_BLANK_LUMA_THRESHOLD,
): CanvasInkStats {
  const width = canvas.width;
  const height = canvas.height;

  const failedStats: CanvasInkStats = {
    darkRatio: 0,
    meanLuma: 255,
    width,
    height,
    failed: true,
    sampleWidth: 0,
    sampleHeight: 0,
  };

  if (typeof document === 'undefined') return failedStats;
  if (!width || !height) return { ...failedStats, failed: false, darkRatio: 0 };

  try {
    const sampleWidth = Math.max(1, Math.floor(width / 16));
    const sampleHeight = Math.max(1, Math.floor(height / 16));

    const probe = document.createElement('canvas');
    probe.width = sampleWidth;
    probe.height = sampleHeight;
    const ctx = probe.getContext('2d', { willReadFrequently: true });
    if (!ctx) return failedStats;

    ctx.drawImage(canvas as CanvasImageSource, 0, 0, sampleWidth, sampleHeight);
    const { data } = ctx.getImageData(0, 0, sampleWidth, sampleHeight);

    let dark = 0;
    let lumaSum = 0;
    const total = data.length / 4;

    for (let i = 0; i < data.length; i += 4) {
      const luma = 0.299 * (data[i] ?? 0) + 0.587 * (data[i + 1] ?? 0) + 0.114 * (data[i + 2] ?? 0);
      lumaSum += luma;
      if (luma < threshold) dark++;
    }

    return {
      darkRatio: total > 0 ? dark / total : 0,
      meanLuma: total > 0 ? lumaSum / total : 255,
      width,
      height,
      failed: false,
      sampleWidth,
      sampleHeight,
    };
  } catch (err) {
    console.warn('[ocrEngine] 画布墨迹分析失败：', err);
    return failedStats;
  }
}

export function isMostlyBlank(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  threshold = OCR_BLANK_LUMA_THRESHOLD,
): boolean {
  const stats = analyzeCanvasInk(canvas, threshold);
  if (stats.failed) return false;
  return stats.darkRatio < 0.0005;
}

const INIT_TIMEOUT_MS = 180_000;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(errorReport('初始化失败', err)));
      },
    );
  });
}

function scaleCanvas(
  source: ImageData | HTMLCanvasElement | OffscreenCanvas,
  factor: number,
): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  if (source instanceof ImageData) return null;
  if (factor >= 0.999) return null;

  const width = 'width' in source ? source.width : 0;
  const height = 'height' in source ? source.height : 0;
  if (!width || !height) return null;

  const targetW = Math.max(1, Math.floor(width * factor));
  const targetH = Math.max(1, Math.floor(height * factor));

  const target = document.createElement('canvas');
  target.width = targetW;
  target.height = targetH;
  const ctx = target.getContext('2d');
  if (!ctx) return null;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, targetW, targetH);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source as CanvasImageSource, 0, 0, targetW, targetH);

  return target;
}

function factorForMaxPixels(
  source: ImageData | HTMLCanvasElement | OffscreenCanvas,
  maxPixels: number,
): number {
  if (source instanceof ImageData) return 1;
  const width = 'width' in source ? source.width : 0;
  const height = 'height' in source ? source.height : 0;
  if (!width || !height) return 1;
  const pixels = width * height;
  return pixels <= maxPixels ? 1 : Math.sqrt(maxPixels / pixels);
}

/**
 * 把各种图像输入统一成 `HTMLCanvasElement`。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么**不再**编码成 PNG buffer
 * ═══════════════════════════════════════════════════════════════
 *
 * 原先这里把画布 `toBlob('image/png')` 再 `arrayBuffer()`，然后把 buffer
 * 交给 `recognize()`。那是一条又贵又脆的路径：
 *   · 一张 8.3 MP 的画布编码成 PNG 要遍历全部像素，还要额外分配 blob 与 buffer 两份内存；
 *   · `toBlob` 是浏览器内部的异步编码，失败了**既没有异常也没有回调**，
 *     我们只能拿到 null —— 而在它内部崩溃时连 null 都拿不到，是进程直接消失。
 *
 * 而本库的 `recognize()` 本来就接受画布对象（`CanvasLike` 只需要
 * `width` / `height` / `getContext('2d')`，`HTMLCanvasElement` 完全满足）。
 * 直接传画布：少一次全图编码、少两份大内存，也少了一个会静默失败的环节。
 */
function toCanvas(
  imageData: ImageData | HTMLCanvasElement | OffscreenCanvas,
): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  if (imageData instanceof HTMLCanvasElement) return imageData;

  const canvas = document.createElement('canvas');
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  if (imageData instanceof ImageData) {
    ctx.putImageData(imageData, 0, 0);
  } else {
    ctx.drawImage(imageData, 0, 0);
  }
  return canvas;
}

/**
 * 把设备内存与当前 JS 堆用量拼成一句可显示的诊断文本。
 *
 * 为什么要记这个：进程在推理时静默消失，可能是被系统 OOM 杀的，
 * 也可能是 WASM 侧的 abort。两者处理方式完全不同，而在没有控制台的情况下
 * 唯一能区分的办法就是**把当时的机器内存状况一并记下来**，
 * 让它出现在用户能看到的诊断轨迹里。
 *
 * `deviceMemory` 只有 Chromium 系提供（单位 GB，且会被取整到 0.25/0.5/1/2/4/8），
 * `performance.memory` 更是 Chrome 专有 —— 两者都取不到时就不显示，不报错。
 */
function describeMemory(): string {
  const parts: string[] = [];

  const deviceMemory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  if (typeof deviceMemory === 'number') parts.push(`设备内存约 ${deviceMemory}GB`);

  const perf = performance as Performance & {
    memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number };
  };
  if (perf.memory) {
    const used = Math.round(perf.memory.usedJSHeapSize / 1024 / 1024);
    const limit = Math.round(perf.memory.jsHeapSizeLimit / 1024 / 1024);
    parts.push(`JS 堆 ${used}/${limit}MB`);
  }

  return parts.length ? ` · ${parts.join('，')}` : '';
}

export type { OcrLang, OcrPageResult, OcrProgress, OcrWord };
export { OCR_LANG_OPTIONS } from '@/lib/ocrTypes';

class OcrEngine {
  private service: PaddleOcrService | null = null;
  private initialized = false;
  /**
   * 字符框识别器（懒建、只建一次）。
   *
   * ═══════════════════════════════════════════════════════════════
   * 为什么要单独一个会话，以及为什么是懒的
   * ═══════════════════════════════════════════════════════════════
   *
   * 逐字符的横向位置只存在于识别模型的 logits 里（CTC 的 `positions`，
   * 见 `lib/ocrCharBoxes.ts` 顶部的完整推导），而 `PaddleOcrService`
   * 的 session 是 private 字段、公开 API 只给成品文本 —— 所以必须自建一个
   * 识别会话（**同一份 21.29MB 模型被加载两次**，这是有意的取舍）。
   *
   * 懒建的理由：不用字符框的路径（例如只要纯文本）不该为此多付
   * 20MB 内存与一次模型反序列化。真正要用时（第一次识别到词之后）才建。
   */
  private charBoxRecognizer: CharBoxRecognizer | null = null;
  private charBoxRecognizerPromise: Promise<CharBoxRecognizer> | null = null;

  async initialize(_lang: OcrLang = 'chi_sim+eng'): Promise<void> {
    if (this.initialized) return;

    // 模型来源见 lib/ocrModelSource.ts：内置预设指向 huggingface.co，
    // 而国内访问不了它 —— 那会让 OCR 永远停在初始化、一页都识别不出来。
    const model = buildOcrModel();
    const executionProviders = resolveExecutionProviders();
    console.info(
      `[ocrEngine] 模型来源：${OCR_MODEL_BASE}\n` +
        `  · 检测模型 9.52MB · 识别模型 20.30MB · 字典 0.07MB（合计约 29.9MB）\n` +
        `  · 首次使用需完整下载，之后会被缓存，离线可用\n` +
        `  · 推理后端：${executionProviders.join(' → ')}`,
    );

    const service = new PaddleOcrService({
      model,
      processing: { engine: 'canvas-native' },
      session: {
        executionProviders,
        // 如果首选后端建会话失败，库会自动退回安全后端 —— 记下来，
        // 否则「硬件加速被静默丢弃」这件事永远没人知道
        onSessionFallback: (err: unknown) => {
          console.warn('[ocrEngine] 首选推理后端不可用，已回退：', err);
        },
      },
    });

    const t0 = Date.now();
    try {
      await withTimeout(
        service.initialize(),
        INIT_TIMEOUT_MS,
        `OCR 引擎初始化超时（${INIT_TIMEOUT_MS / 1000} 秒）。\n\n` +
          `首次使用需要下载模型（约 30MB，来自 ${OCR_MODEL_BASE}）。\n` +
          `· 若该域名在你的网络下不可达，模型会一直下不下来。\n` +
          `· 可以用环境变量 VITE_OCR_MODEL_BASE 换成别的来源（详见构建说明）。`,
      );
    } catch (err) {
      throw new Error(
        errorReport('初始化 PaddleOCR 引擎失败', err) +
          `\n\n模型来源：${OCR_MODEL_BASE}\n` +
          `请在浏览器开发者工具的 Network 面板确认这三个文件是否下载成功：\n` +
          Object.values(OCR_MODEL_FILES)
            .map((f) => `  · ${OCR_MODEL_BASE}/${f}`)
            .join('\n'),
      );
    }
    console.info(`[ocrEngine] 引擎就绪，用时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);

    this.service = service;
    this.initialized = true;
  }

  async recognizePage(
    imageData: ImageData | HTMLCanvasElement | OffscreenCanvas,
    pageNum: number,
    total: number,
    onProgress?: (p: OcrProgress) => void,
  ): Promise<OcrPageResult> {
    if (!this.initialized || !this.service) {
      throw new Error('OCR 引擎未初始化，请先调用 initialize()');
    }

    onProgress?.({ pageNum, total, status: 'recognizing' });

    const { result, canvas: recognizedCanvas, factor } = await this.recognizeWithFallback(
      imageData,
      pageNum,
      total,
    );

    const words: OcrWord[] = [];
    /**
     * 把词框从「识别画布坐标系」换算回「原图坐标系」。
     *
     * ═══════════════════════════════════════════════════════════════
     * 为什么必须有这一步（降档识别时坐标会差一个 factor 倍）
     * ═══════════════════════════════════════════════════════════════
     *
     * `result.results[].box` 是**在那张喂进识别的画布上**量的
     * （读库的源码可确认：检测器把框按 input 画布的尺寸还原，
     * 识别器最后又按 `1/cropRatio` 折算回去，两者都以传入画布为准）。
     * 内存不足走降档（0.7 / 0.5 / 0.35，见 `recognizeWithFallback`）时，
     * 那张画布比原图小，于是同一块内容的坐标会小一个 factor 倍。
     *
     * 而下游**全部**按原图坐标系解释词框：
     *   · `attachCharBoxes` / `attachTesseractEvidence` 都用
     *     `box.x0 * scale` 在降档画布上裁剪（契约写在 `cropWord` 注释里）；
     *   · `detectMissedInkRegionsFromCanvas(imageData, words)` 要求词与
     *     source 同一坐标系（写在它的函数注释里）；
     *   · 公式增强与本地重试都从 `imageData` 裁剪；
     *   · 页眉页脚按整页高度取边缘带。
     *
     * 不换算的后果不是报错，而是**静默降级**：字符框对账失败
     * （错的坐标比没有更糟，于是整页一个都挂不上）、墨迹探测把
     * 已识别区域也算成漏识别、公式裁剪裁到别处。所以在这里一次性
     * 换算成原图坐标，让全链路只有**一个**坐标系。
     */
    const toPageFrame = factor < 0.999 ? 1 / factor : 1;
    // 每页开始前清空「取不到字符框」的原因记录，否则会跨页累积
    clearCharBoxSkips();
    /**
     * 第二意见的证据同样**按页**清空（worker 留着不销毁，见
     * `clearTesseractEvidence` 的说明）：证据挂在词上，词换了就再也
     * 查不到，留着只会在诊断里制造「上一页的坐标」这种假象。
     */
    clearTesseractEvidence();
    /**
     * 「检测器给了框、识别结果却是空」的计数。
     *
     * 这正是跨行大括号公式整块消失的形态：`if (!text) continue` 把那个框
     * 无声丢掉，`words` 里连痕迹都没有，下游（公式增强靠词聚类找候选）
     * 也就永远发现不了它。至少要**把它数出来并说出来** ——
     * 否则用户看到的只是一道少了主分支的题，不知道少了什么、为什么少。
     * 这些框会在下面由「墨迹探测 + 本地重试」尝试救回。
     */
    let skippedBlank = 0;
    for (const item of result.results) {
      const text = item.text.trim();
      if (!text) {
        skippedBlank++;
        continue;
      }
      words.push({
        text,
        confidence: Math.round(item.confidence * 100),
        bbox: {
          x0: item.box.x * toPageFrame,
          y0: item.box.y * toPageFrame,
          x1: (item.box.x + item.box.width) * toPageFrame,
          y1: (item.box.y + item.box.height) * toPageFrame,
        },
        fontSize: item.box.height * toPageFrame,
      });
    }
    if (skippedBlank) {
      console.warn(
        `[ocrEngine] 第 ${pageNum} 页有 ${skippedBlank} 个检测框识别结果为空` +
          `（共 ${result.results.length} 个）—— 这类内容不会出现在 words 里，` +
          `接下来由墨迹探测 + 本地重试尝试救回`,
      );
    }

    /**
     * ═══════════════════════════════════════════════════════════════
     * 字符级坐标：上下标能不能真正解决，全看这一步
     * ═══════════════════════════════════════════════════════════════
     *
     * 词级框判不出「同框内部的指数」（实测第 17 题 `p (1 − p )x+y−2`
     * 的指数就在整行框里）。`lib/ocrCharBoxes.ts` 用 CTC 的时间步拿到
     * 每个字符的横向位置、再用逐列墨迹分析拿到纵向范围，于是
     * 「更小 + 更高」变成可测事实，`ocrPostProcess` 据此按**字符**切分。
     *
     * ⚠️ **渐进增强**，三层兜底（少任何一层都会让这一页整个失败）：
     *  1. 识别器建不起来 → `attachCharBoxes` 收到 null，直接返回 0；
     *  2. 单个词失败 → 只是这个词没有字符框（`ocrCharBoxes` 内部 try/catch）；
     *  3. 整段失败 → 这里再兜一层 catch。
     * 三种情况下 `words` 与改动前**逐字节一致**，识别结果一个字都不会少。
     */
    if (words.length) {
      try {
        const recognizer = await this.ensureCharBoxRecognizer();
        const attachedCount = await attachCharBoxes(words, recognizer, {
          canvas: recognizedCanvas as unknown as OcrCanvasLike,
          scale: factor < 0.999 ? factor : 1,
          onSkip: (word, reason) => {
            // 记进可导出的诊断里 —— 只写 console 的话用户永远看不到，
            // 而这正是「15 个词为什么没拿到字符框」唯一的线索（见 ocrCharBoxes）。
            recordCharBoxSkip(word.text, reason);
            console.warn(
              `[ocrEngine] 第 ${pageNum} 页词「${word.text.slice(0, 20)}」未取到字符级坐标：${reason}`,
            );
          },
        });
        if (attachedCount) {
          console.info(
            `[ocrEngine] 第 ${pageNum} 页 ${attachedCount}/${words.length} 个词取到字符级坐标` +
              `（上下标按逐字符几何判定）`,
          );
        }
      } catch (err) {
        console.warn('[ocrEngine] 字符级坐标附加失败（识别结果不受影响）：', err);
      }

      /**
       * ═══════════════════════════════════════════════════════════════
       * 第二意见：用 tesseract 的字符框复核角标候选段（懒加载、可缺席）
       * ═══════════════════════════════════════════════════════════════
       *
       * 机制 1~5 全部建立在**同一次识别**的产出上，所以同一个引擎的系统
       * 偏差会被四条判据一起继承 —— 实测第 1 词的真指数 `x+y−2` 就是这样
       * 被机制 2（置信度 0.99+）与机制 5（`+`/`−` 在整页只有缩小形态）
       * 联手拒掉的。这里换一个引擎（tesseract.js，资产自托管、懒加载）
       * 在同一位置量一次「小而抬高的墨迹」作为**独立证据**。
       *
       * 顺序有两条硬要求：
       *  1. **必须在 `attachCharBoxes` 之后**：预筛（`findRescuableRuns`）
       *     要读 CTC 的逐字符框，没有它一个词都不会被筛出来；
       *  2. **必须在 `ocrResultToBlocks` 之前**（也就是这里）：判据在
       *     后处理里跑，证据那时必须已经挂在词上。
       *
       * `sizeTable` 与后处理里用的是**同一个函数、同一批词**算出来的
       * （`buildCharSizeTable` 只读挂好的字符框，纯函数、无副作用），
       * 所以两边的「全尺寸高度」逐字节一致 —— 预筛与判定看到的
       * 是同一个世界。
       *
       * ⚠️ 同样是**渐进增强**：worker 建不起来（离线首次访问、资产被拦）
       * 时返回 0，`words` 与改动前逐字节相同，只是这一页没有救回。
       */
      if (words.length) {
        try {
          const sizeTable = buildCharSizeTable(words);
          const evidenceCount = await attachTesseractEvidence(words, {
            canvas: recognizedCanvas as unknown as OcrCanvasLike,
            scale: factor < 0.999 ? factor : 1,
            sizeTable,
            onSkip: (word, reason) => {
              recordCharBoxSkip(word.text, `第二意见：${reason}`);
              console.info(
                `[ocrEngine] 第 ${pageNum} 页词「${word.text.slice(0, 20)}」无第二意见：${reason}`,
              );
            },
            onInfo: (message) => console.info(`[ocrEngine] ${message}`),
          });
          if (evidenceCount) {
            console.info(
              `[ocrEngine] 第 ${pageNum} 页 ${evidenceCount} 个词取到第二意见证据` +
                `（tesseract 字符框，用于救回被机制 2/5 误拒的角标段）`,
            );
          }
        } catch (err) {
          console.warn('[ocrEngine] 第二意见附加失败（识别结果不受影响）：', err);
        }
      }
    }

    /**
     * 找出「有墨迹但没有词覆盖」的区域。
     *
     * ═══════════════════════════════════════════════════════════════
     * 为什么这一步必须**无条件**做（而不是只在公式增强开启时做）
     * ═══════════════════════════════════════════════════════════════
     *
     * 用户的隐私开关默认关闭，所以这条信息在默认配置下**只用于诊断**：
     * 它让「页面上一半内容没被识别出来」这件事**看得见** ——
     * 而不是像现在这样，用户只能看到一段少了主分支的题目，
     * 既不知道少了什么，也不知道为什么少。
     *
     * 同时它也是公式增强的候选来源：`detectFormulaRegions()` 靠已识别的词
     * 聚类，公式整块没识别出来时它一个候选都提不出来
     * （见 `lib/ocrInkRegions.ts` 顶部注释）。
     *
     * 成本：一次缩小采样 + 网格统计，纯本地像素运算，不联网。
     * 失败时返回空数组，不影响识别结果。
     */
    const missedInkRegions = detectMissedInkRegionsFromCanvas(imageData, words);
    if (missedInkRegions.length) {
      console.warn(
        `[ocrEngine] 第 ${pageNum} 页有 ${missedInkRegions.length} 处区域「有墨迹但没有识别词覆盖」，` +
          `最大一处 ${Math.round(
            Math.max(...missedInkRegions.map((r) => (r.x1 - r.x0) * (r.y1 - r.y0))),
          )} 平方像素 —— 这块内容很可能是识别失败的公式/图表（文字已丢失，无法从词里恢复）`,
      );
    }

    /**
     * ═══════════════════════════════════════════════════════════════
     * 漏识别区域的**本地重试**：放大后再识别一次（不联网）
     * ═══════════════════════════════════════════════════════════════
     *
     * 上面那批区域在**默认配置下**没有任何补救路径：SimpleTex 公式增强
     * 在隐私开关后面（默认关闭），而识别器对跨行大括号那类形状返回的
     * 是空串 —— 主分支 `f(x,y) = 1/2(x+y)e^{-(x+y)}` 就是这样整块消失的。
     * 本地重试补上的正是这一段：区域已经被定位好，放大后常常就能认出来
     * （机制与成本上限见 `retryMissedInkLocally`）。
     *
     * 救回的词与普通词**同一条路**：并进 `words` 后一起成行、判上下标、
     * 拼段落。排序只在真的救回时才做（`groupWordsIntoLines` 自己会分组，
     * 但公式增强的替换与诊断输出都读顺序，顺手给一个确定的顺序）。
     */
    const recoveredWords = await this.retryMissedInkLocally(
      imageData,
      missedInkRegions,
      words,
      pageNum,
    );
    const wordsWithRecovery = recoveredWords.length
      ? [...words, ...recoveredWords].sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0)
      : words;

    /**
     * 救回的词尽量也补一次字符级坐标。
     *
     * 识别器已经因为普通词热起来了（会话、字典都在内存里），
     * 这一步只是对**新增的那些词**做一次裁剪识别；补不上不改变任何行为：
     * 没有字符框的词照样成行、照样进 blocks，只是上下标只能靠词级判据。
     *
     * ⚠️ 对放大后才认出来的词，这张原尺度画布上的字符框可能对不上账
     * （`attachCharBoxes` 的对账会拦住，不会写错坐标）—— 那只是
     * 「没有字符框」，不是错误。第二意见（tesseract）暂不给救回的词补：
     * 它读的是同一批字符框，字符框都没有时它也无从下手。
     */
    if (recoveredWords.length) {
      try {
        const recognizer = await this.ensureCharBoxRecognizer();
        const attached = await attachCharBoxes(recoveredWords, recognizer, {
          canvas: recognizedCanvas as unknown as OcrCanvasLike,
          scale: factor < 0.999 ? factor : 1,
          onSkip: (word, reason) => recordCharBoxSkip(word.text, `本地重试救回：${reason}`),
        });
        if (attached) {
          console.info(
            `[ocrEngine] 第 ${pageNum} 页救回的 ${recoveredWords.length} 个词中 ` +
              `${attached} 个取到字符级坐标`,
          );
        }
      } catch (err) {
        console.warn('[ocrEngine] 救回词的字符级坐标附加失败（识别结果不受影响）：', err);
      }
    }

    /**
     * 救回之后**重新探测**漏识别区域。
     *
     * 不重新探测的话，刚救回来的那块在下面的公式增强里还会被当成
     * 「仍然漏识别」—— 只认出了一个词的区域可能仍然触发一次 SimpleTex
     * 请求（如果用户开了公式增强），而本地明明已经认出内容了。
     * 没救回任何词时结果必然与第一次相同，不做第二次像素运算。
     */
    const remainingInkRegions = recoveredWords.length
      ? detectMissedInkRegionsFromCanvas(imageData, wordsWithRecovery)
      : missedInkRegions;

    // Enhance formula regions with SimpleTex cloud OCR
    const enhancedWords = await this.enhanceFormulaRegions(
      wordsWithRecovery,
      imageData,
      remainingInkRegions,
    );

    if (!wordsWithRecovery.length) {
      console.warn(
        `[ocrEngine] 第 ${pageNum} 页未提取到词（本地重试后仍为空）。` +
          `识别结果数=${result.results.length}，纯文本长度=${result.text.length}`,
      );
    }

    /**
     * 平均置信度按**最终词表**算（含本地重试救回的词，不含 SimpleTex
     * 的替换词）：救回的词也是识别出来的内容，把它排除在外会让
     * 「救回了一整块公式」的页面仍然显示成低质量页。
     * 排除替换词的原因不一样：那个 95 是写死的常数，不是识别置信度。
     */
    const avgConfidence = wordsWithRecovery.length
      ? wordsWithRecovery.reduce((sum, w) => sum + w.confidence, 0) / wordsWithRecovery.length
      : 0;

    onProgress?.({ pageNum, total, status: 'complete' });

    return {
      pageNum,
      words: enhancedWords,
      avgConfidence,
      pageText: result.text,
      missedInkRegions: remainingInkRegions.length ? remainingInkRegions : undefined,
      extraction: {
        source: wordsWithRecovery.length
          ? 'flat-words'
          : result.text.trim()
            ? 'page-text-only'
            : 'empty',
        hasFlatWords: wordsWithRecovery.length > 0,
        hasBlocks: false,
        blocks: 0,
        paragraphs: 0,
        lines: 0,
        skippedBlank,
      },
    };
  }

  private async recognizeWithFallback(
    imageData: ImageData | HTMLCanvasElement | OffscreenCanvas,
    pageNum: number,
    total: number,
  ): Promise<{
    /**
     * ⚠️ 这里必须写**扁平**结果类型，不能写 `ReturnType<PaddleOcrService['recognize']>`。
     *
     * `recognize` 是重载函数，`ReturnType` 只会取到其中一个重载的返回类型 ——
     * 实测取到的是 `PaddleOcrResult`（按行分组、带 `lines`）。
     * 而本函数**始终**以 `{ flatten: true }` 调用（见下面第 532 行附近），
     * 运行时拿到的必然是扁平结果（带 `results`）。
     *
     * 类型与实际不符的后果不是运行时报错，而是**编译期**报一堆
     * 「`results` 不存在于 `PaddleOcrResult`」—— 之前那版正是这样
     * 留下 4 个类型错误、过不了 CI 门禁。
     */
    result: FlattenedPaddleOcrResult;
    /**
     * 真正喂给识别的画布，以及它相对原图的缩放系数。
     *
     * ═══════════════════════════════════════════════════════════════
     * 为什么必须把它带出来（字符框会不会贴错地方全看这个）
     * ═══════════════════════════════════════════════════════════════
     *
     * `result.results[].box` 的坐标是**在这张画布上**量到的，而不是原图的。
     * 一旦走了降档（0.7 / 0.5 / 0.35 —— 内存不足时真的会走），
     * 拿这些框去原图上裁剪，裁到的就是**错位的内容**：
     * 裁错内容 → 识别出别的字 → 字符框与 `OcrWord.text` 对不上 →
     * （对账逻辑会拦住，所以不会写错坐标）每个词都白跑一次推理。
     * 所以字符框一律用**这张画布**，坐标天然一致。
     */
    canvas: HTMLCanvasElement;
    factor: number;
  }> {
    const maxPixelFactor = factorForMaxPixels(imageData, OCR_MAX_PIXELS);
    const factors = [maxPixelFactor, 0.7, 0.5, 0.35].filter(
      (f, i, arr) => f > 0 && arr.indexOf(f) === i,
    );

    let lastError: unknown;

    for (const factor of factors) {
      const input = factor >= 0.999 ? imageData : scaleCanvas(imageData, factor);
      if (!input) continue;

      const label =
        factor >= 0.999
          ? '原始尺寸'
          : `${factor === maxPixelFactor ? '上限缩放' : '降档'} ×${factor.toFixed(2)}`;

      try {
        noteOcrStage('to-canvas', `第 ${pageNum} 页：${label} → 准备画布`);
        const canvas = toCanvas(input);
        if (!canvas) {
          lastError = new Error('无法把页面图像转换为画布');
          continue;
        }

        // 直接把画布交给 OCR（不再编码 PNG，见 toCanvas 的注释）
        noteOcrStage('onnx', `第 ${pageNum} 页：${label} → 送入推理（${canvas.width}×${canvas.height}）${describeMemory()}`);
        const result = await this.service!.recognize(canvas, { flatten: true });

        noteOcrStage('onnx-done', `第 ${pageNum} 页：${label} → 推理返回`);
        if (factor < 0.999) {
          console.info(`[ocrEngine] 第 ${pageNum} 页以「${label}」识别成功`);
        }
        return { result, canvas, factor };
      } catch (err) {
        lastError = err;
        console.warn(`[ocrEngine] 第 ${pageNum} 页「${label}」识别失败：`, err);
      }
    }

    throw new Error(errorReport(`识别第 ${pageNum} 页（共 ${total} 页）失败`, lastError));
  }

  /**
   * 懒建字符框识别器；建不起来返回 null（**永不抛**）。
   *
   * 三重保险，任何一层失败都只是「这一页没有字符级坐标」：
   *  1. 会话/字典建不起来（模型拿不到、WASM 被拦、浏览器不支持）→ null；
   *  2. 上一次已经失败过 → 记下 null，不再重试（否则每页都白等一次超时）；
   *  3. 调用方 `attachCharBoxes` 内部对每个词单独 try/catch。
   */
  private async ensureCharBoxRecognizer(): Promise<CharBoxRecognizer> {
    if (this.charBoxRecognizer) return this.charBoxRecognizer;
    if (!this.charBoxRecognizerPromise) {
      const t0 = Date.now();
      this.charBoxRecognizerPromise = createWordCharBoxRecognizer()
        .then((recognizer) => {
          if (recognizer) {
            console.info(
              `[ocrEngine] 字符级坐标已启用（识别会话就绪，用时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒）` +
                ` —— 上下标将按**逐字符**的真实几何判定`,
            );
          } else {
            console.info('[ocrEngine] 字符级坐标不可用，上下标退回词级判据（行为与以前一致）');
          }
          return recognizer;
        })
        .catch((err: unknown) => {
          console.warn('[ocrEngine] 字符级坐标初始化失败，退回词级判据：', err);
          return null;
        });
    }
    return this.charBoxRecognizerPromise;
  }

  async terminate(): Promise<void> {
    this.service = null;
    this.initialized = false;
    this.charBoxRecognizer = null;
    this.charBoxRecognizerPromise = null;
    // 第二意见的 worker 也要收掉：它自己持有一份 WASM 运行时与语言数据，
    // 不 terminate 就是一段活到页面关闭的内存（若一直没建过，这里是空操作）
    resetScriptSecondOpinion();
  }

  get isReady(): boolean {
    return this.initialized;
  }

  /**
   * Detect formula-like word clusters and re-recognize them with SimpleTex.
   *
   * PaddleOCR treats formulas as regular text, producing garbled output like
   * "P{X=x,Y=y}=p²(1-p)^(x+y-2)" → "PI{X=2,Y=y}=p"A−p"".
   * SimpleTex specializes in formula OCR and returns accurate LaTeX.
   *
   * ⚠️ 这是全应用**唯一**会把文档内容送出本机的路径，因此受
   * `settingsStore.formulaOcrEnabled` 控制，且该开关**默认关闭**。
   * 关闭时直接返回原始结果 —— 不发起任何网络请求。
   *
   * `missedInkRegions` 是「图像上有墨迹、却没有词覆盖」的区域
   * （见 `lib/ocrInkRegions.ts`）。它们必须**并进候选**，否则会出现
   * 一个死角：公式整块没被识别 → 没有词 → `detectFormulaRegions()` 提不出候选
   * → 公式增强对它永远无能为力。这正是用户实测到的「主分支整块消失」。
   */
  private async enhanceFormulaRegions(
    words: OcrWord[],
    imageData: ImageData | HTMLCanvasElement | OffscreenCanvas,
    missedInkRegions: MissedInkRegion[] = [],
  ): Promise<OcrWord[]> {
    // 注意：这里不能再用 `words.length < 3` 提前返回 ——
    // 整页只认出一个词、其余全是漏识别区域时，恰恰是最需要增强的场景
    if (!words.length && !missedInkRegions.length) return words;

    // 隐私开关：默认关闭，关闭时不联网（读 store 是为了让扫描件 OCR 这条
    // 非 React 链路也能拿到设置；ocrEngine 本身是按需动态 import 的）
    if (!useSettingsStore.getState().formulaOcrEnabled) return words;

    const textRegions = detectFormulaRegions(words);
    const regions = mergeInkCandidates(textRegions, missedInkRegions, words);
    if (!regions.length) return words;

    console.info(
      `[ocrEngine] 公式候选 ${regions.length} 个（词聚类 ${textRegions.length} 个 + ` +
        `漏识别区域补入 ${regions.filter((r) => r.fromInk).length} 个），尝试 SimpleTex 增强`,
    );

    const canvas = ensureCanvas(imageData);
    if (!canvas) return words;

    const enhanced = [...words];

    for (const region of regions) {
      try {
        const crop = cropCanvas(canvas, region.bbox);
        if (!crop) continue;

        const latex = await recognizeFormula(crop);
        if (!latex || latex.length < 2) continue;

        // Replace all words in this region with a single LaTeX word
        const replacement: OcrWord = {
          text: `$${latex}$`,
          confidence: 95,
          bbox: region.bbox,
          fontSize: region.avgFontSize,
        };

        // Mark original words for removal, insert replacement at first position
        if (!region.wordIndices.length) {
          // 图像候选区域：它在 `words` 里**本来就没有对应词**（识别失败的正是它），
          // 因此只需要把识别出的 LaTeX 追加成一个新词 —— 追加而不是插入，
          // 位置由下面那一次按坐标排序统一决定。
          enhanced.push(replacement);
        } else {
          for (let i = 0; i < enhanced.length; i++) {
            if (region.wordIndices.includes(i)) {
              if (i === region.wordIndices[0]) {
                enhanced[i] = replacement;
              } else {
                enhanced[i] = null as unknown as OcrWord;
              }
            }
          }
        }

        console.info(
          `[ocrEngine] 公式增强成功：${region.originalText.slice(0, 40) || '（漏识别区域）'}… → $${latex.slice(0, 40)}$`,
        );
      } catch (err) {
        console.warn('[ocrEngine] 公式增强失败（保留原始识别结果）：', err);
      }
    }

    return enhanced
      .filter((w): w is OcrWord => w !== null)
      // 追加进去的候选会排在末尾，而阅读顺序是按坐标决定的：
      // 不排序的话公式会被拼到段落最后面。这里用与
      // `ocrPostProcess.groupWordsIntoLines` 相同的「先上后下、先左后右」口径。
      .sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0);
  }

  /**
   * 把「有墨迹但没有词覆盖」的区域放大后再识别一次 —— **纯本地**。
   *
   * ═══════════════════════════════════════════════════════════════
   * 它要解决的那次真实内容丢失
   * ═══════════════════════════════════════════════════════════════
   *
   * 用户在扫描版数学题 PDF 上实测到：跨行大括号里的主分支
   * `f(x,y) = 1/2(x+y)e^{-(x+y)}` 整块从输出里消失，只剩 `0, 其他`。
   * 根因在词提取循环里写得很清楚：识别器对那种形状（跨行大括号、
   * 堆叠分数、指数上标）返回了空串，检测框被 `if (!text) continue`
   * 无声丢掉 —— `words` 里连痕迹都没有。
   *
   * 丢掉之后的连锁反应是：公式增强靠**已识别出的词**聚类找候选，
   * 没有词就永远发现不了那块区域；而它唯一的替代入口 SimpleTex 又在
   * 隐私开关（默认关闭）后面。也就是说默认配置下这块内容
   * **没有任何补救路径**。本函数把「本地最后能做的一次尝试」补上：
   * 区域已经由墨迹探测定位好了（见 `lib/ocrInkRegions.ts`），
   * 放大再送一次识别。
   *
   * ═══════════════════════════════════════════════════════════════
   * 为什么是「放大重试」
   * ═══════════════════════════════════════════════════════════════
   *
   * 原尺度上检测/识别已经失败过一次，原样再送只会得到同一个结果
   * （同模型、同输入）。输入里唯一还没试过的变量就是尺度：
   * 跨行大括号这类形状在原尺度下笔画粘连，检测器切不出干净的框；
   * 放大后笔画分开，往往就能认出来。3 倍是本模块里有实测依据的量级
   * （tesseract 第二意见的裁剪放大用的是同一档，见 `ocrTesseractScripts`）。
   *
   * ═══════════════════════════════════════════════════════════════
   * 成本必须封顶（否则「补救」会变成「卡死」）
   * ═══════════════════════════════════════════════════════════════
   *
   * 每次重试都是一次完整的检测 + 识别，所以有四道闸门：
   *  · 尺寸闸门：太小的条（噪声/表格线）和太大的块（插图/整页失败）
   *    都不试，只救「识别正常的页面上的一个洞」；
   *  · 最多 8 个区域，按面积从大到小（丢得越多越先救）；
   *  · 单个裁剪放大后的面积不超过 2.5MP（放不下就不放大，**不缩小**）；
   *  · 整页重试有**总像素预算**（8MP）：预算是先算几何、后分配画布，
   *    装不下的区域直接不试 —— 一页最多再花「两张页面」的推理量。
   *
   * ═══════════════════════════════════════════════════════════════
   * ⚠️ 纯本地，绝不联网
   * ═══════════════════════════════════════════════════════════════
   *
   * 这里只驱动本地 ONNX 引擎，与 `formulaOcrEnabled` 无关 ——
   * 那个开关管的是 SimpleTex（全应用唯一会把内容送出本机的路径），
   * 本函数既不读它、也不碰任何网络 API。
   *
   * 渐进增强：取不到画布、裁剪失败、某块推理抛错 —— 都只是那一块
   * 没救回，`words` 与改动前逐字节相同。
   *
   * ⚠️ 诚实说明：救回的词**没有**字符级坐标（下面调用方会尽力补，
   * 但对「放大后才认出来」的词可能补不上），因此它们内部的上下标
   * 只能靠词级判据；这比整块消失仍然是严格更好的状态。
   */
  private async retryMissedInkLocally(
    imageData: ImageData | HTMLCanvasElement | OffscreenCanvas,
    regions: readonly MissedInkRegion[],
    existing: readonly OcrWord[],
    pageNum: number,
  ): Promise<OcrWord[]> {
    const service = this.service;
    if (!service || !regions.length) return [];

    const canvas = ensureCanvas(imageData);
    if (!canvas) return [];

    /**
     * 两条尺寸闸门：
     *  · 太细的条不试：24px 以下（200 DPI 下不到 3 毫米）基本是表格线、
     *    扫描噪声或孤立标点 —— 不是「丢失的内容」，不值得花一次推理；
     *  · 太大的块也不试：超过页面三成面积的区域**不再是「识别正常的页面
     *    上的一个洞」**。那种尺寸更像是整幅插图（重试只会从图里读出垃圾
     *    字符混进正文），或者整页都没认出来（这么大的区域也过了像素上限、
     *    放大不了，等于把已经失败过的输入原样再送一次）。
     */
    const pageArea = canvas.width * canvas.height;
    const candidates = regions
      .filter(
        (r) =>
          r.x1 - r.x0 >= RETRY_MIN_SIDE &&
          r.y1 - r.y0 >= RETRY_MIN_SIDE &&
          (r.x1 - r.x0) * (r.y1 - r.y0) <= pageArea * RETRY_MAX_REGION_AREA_RATIO,
      )
      .sort((a, b) => (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0));
    if (!candidates.length) return [];

    // 先算几何、后分配画布：预算必须在画布分配之前判掉
    const jobs: Array<{ plan: RetryCropPlan; region: MissedInkRegion }> = [];
    let budget = RETRY_PIXEL_BUDGET;
    let skippedForBudget = 0;
    for (const region of candidates) {
      if (jobs.length >= RETRY_MAX_REGIONS) break;
      const plan = planRetryCrop(
        canvas.width,
        canvas.height,
        region,
        RETRY_UPSCALE,
        RETRY_MAX_CROP_PIXELS,
      );
      if (!plan) continue;

      const cost = plan.targetW * plan.targetH;
      // 第一个候选无论多大都试（用户看到的第一处丢失必须有人管），
      // 之后的按预算放行
      if (jobs.length > 0 && cost > budget) {
        skippedForBudget++;
        continue;
      }
      budget -= cost;
      jobs.push({ plan, region });
    }
    if (!jobs.length) return [];

    console.info(
      `[ocrEngine] 第 ${pageNum} 页本地重试：${jobs.length} 处漏识别区域放大 ${RETRY_UPSCALE}× 重新识别` +
        `（纯本地，不联网）` +
        (skippedForBudget ? `，另有 ${skippedForBudget} 处超出像素预算未试` : ''),
    );

    const t0 = Date.now();
    const recovered: OcrWord[] = [];

    for (const { plan, region } of jobs) {
      try {
        const crop = renderRetryCrop(canvas, plan);
        if (!crop) continue;

        const result = await service.recognize(crop, { flatten: true });
        const admitted = admitRetryWords(
          result.results,
          { originX: plan.px, originY: plan.py, scale: plan.scale },
          // 已有的词 + 前面几块救回的词一起做去重基准：
          // 裁剪的留白会把邻居正文也带进来，重复词是**比缺失更糟**的一类错误
          // （同一句话里出现两遍，还可能是错位的）
          [...existing, ...recovered],
        );
        if (!admitted.length) continue;

        recovered.push(...admitted);
        console.info(
          `[ocrEngine] 第 ${pageNum} 页本地重试救回 ${admitted.length} 个词：` +
            `${admitted
              .map((w) => w.text)
              .join(' ')
              .slice(0, 60)}`,
        );
      } catch (err) {
        console.warn(
          `[ocrEngine] 第 ${pageNum} 页漏识别区域重试失败` +
            `（${Math.round(region.x0)},${Math.round(region.y0)}，不影响其他区域）：`,
          err,
        );
      }
    }

    if (recovered.length) {
      console.info(
        `[ocrEngine] 第 ${pageNum} 页本地重试共救回 ${recovered.length} 个词，` +
          `耗时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`,
      );
    }
    return recovered;
  }
}

export const ocrEngine = new OcrEngine();

// --- Formula region detection helpers ---

const FORMULA_CONFIDENCE_THRESHOLD = 70;
const FORMULA_SYMBOL_RE = /[{}^_\\±∑∏∫√∞≈≠≤≥∈∉⊂⊃∪∩∀∃∇∂αβγδεζηθλμνξπρσφψωΑΒΓΔΕΖΗΘΛΜΝΞΠΡΣΦΨΩ]/;
const MATH_CHAR_RE = /[A-Za-z0-9{}^_+\-*/=()<>|!.,;:?'`~@#$%&[\]\\]/;

interface FormulaRegion {
  wordIndices: number[];
  bbox: { x0: number; y0: number; x1: number; y1: number };
  avgFontSize: number;
  originalText: string;
  /** 该候选是否来自「有墨迹但没识别出词」的图像判定（而不是词聚类） */
  fromInk?: boolean;
}

/**
 * 把「图像候选区域」并进「词聚类候选区域」，并按重叠去重。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么必须去重，而且要用「重叠占较小者」来判
 * ═══════════════════════════════════════════════════════════════
 *
 * 两条路径会找到**同一块**内容：一页公式识别得较差但仍有低置信度词时，
 * 词聚类会圈出一块区域，而图像判定也会把这块「覆盖不足的墨迹」圈出来。
 * 不去重就会对同一块内容发**两次**网络请求 ——
 * 这是全应用唯一会把内容送出本机的路径，多发一次是实打实的隐私与费用成本。
 *
 * 用「重叠面积 ÷ 较小者面积」而不是 IoU：图像候选的框通常比词聚类的框
 * 更紧（词框可能只盖住公式的一部分），IoU 会因此偏小、漏判重复。
 *
 * `avgFontSize` 只是给替换词用的一个估计值（后续的上下标判定读的是
 * `bbox` 高度，不是它）：取「区域高度的一半」与「本页词框中位高度」的较小者，
 * 这样既不会把整块公式的高度当成字号，也不会小到离谱。
 */
function mergeInkCandidates(
  textRegions: FormulaRegion[],
  missedInkRegions: MissedInkRegion[],
  words: OcrWord[] = [],
): FormulaRegion[] {
  const merged = [...textRegions];
  const heights = words.map((w) => w.fontSize).filter((h) => h > 0).sort((a, b) => a - b);
  const medianWordHeight = heights.length ? heights[Math.floor(heights.length / 2)] ?? 0 : 0;

  for (const ink of missedInkRegions) {
    const duplicate = merged.some((r) => overlapRatio(r.bbox, ink) >= 0.5);
    if (duplicate) continue;

    const halfHeight = (ink.y1 - ink.y0) / 2;
    const estimated = medianWordHeight > 0 ? Math.min(halfHeight, medianWordHeight) : halfHeight;

    merged.push({
      wordIndices: [],
      bbox: { x0: ink.x0, y0: ink.y0, x1: ink.x1, y1: ink.y1 },
      avgFontSize: Math.max(8, estimated),
      originalText: '',
      fromInk: true,
    });
  }

  // 阅读顺序：先上后下、先左后右
  return merged.sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0);
}

/**
 * Detect clusters of words that likely contain mathematical formulas.
 *
 * Heuristics:
 * - Low confidence (< 70%) suggests PaddleOCR struggled (common with formulas)
 * - Presence of math symbols or dense special characters
 * - Adjacent low-confidence words are grouped into a single region
 */
function detectFormulaRegions(words: OcrWord[]): FormulaRegion[] {
  const isFormulaCandidate = (w: OcrWord): boolean => {
    if (w.confidence < FORMULA_CONFIDENCE_THRESHOLD) return true;
    if (FORMULA_SYMBOL_RE.test(w.text)) return true;
    // Dense math-like content: mostly ASCII symbols/digits, few CJK chars
    const cjkCount = (w.text.match(/[\u4e00-\u9fff]/g) || []).length;
    const totalChars = w.text.replace(/\s/g, '').length;
    if (totalChars > 3 && cjkCount / totalChars < 0.3 && MATH_CHAR_RE.test(w.text)) {
      return w.confidence < 85;
    }
    return false;
  };

  const regions: FormulaRegion[] = [];
  let currentIndices: number[] = [];
  let currentBbox = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  let currentFontSum = 0;
  let currentText = '';

  const flushRegion = () => {
    if (currentIndices.length >= 2) {
      regions.push({
        wordIndices: [...currentIndices],
        bbox: { ...currentBbox },
        avgFontSize: currentFontSum / currentIndices.length,
        originalText: currentText.trim(),
      });
    }
    currentIndices = [];
    currentBbox = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    currentFontSum = 0;
    currentText = '';
  };

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (isFormulaCandidate(w)) {
      currentIndices.push(i);
      currentBbox.x0 = Math.min(currentBbox.x0, w.bbox.x0);
      currentBbox.y0 = Math.min(currentBbox.y0, w.bbox.y0);
      currentBbox.x1 = Math.max(currentBbox.x1, w.bbox.x1);
      currentBbox.y1 = Math.max(currentBbox.y1, w.bbox.y1);
      currentFontSum += w.fontSize;
      currentText += (currentText ? ' ' : '') + w.text;
    } else {
      // Check gap to previous candidate — if close, keep grouping
      if (currentIndices.length > 0) {
        const prevWord = words[currentIndices[currentIndices.length - 1]];
        const gapX = w.bbox.x0 - (prevWord?.bbox.x1 ?? 0);
        const gapY = Math.abs(((w.bbox.y0 + w.bbox.y1) / 2) - ((prevWord?.bbox.y0 + prevWord?.bbox.y1) / 2));
        // If on same line and close, include as part of formula context
        if (gapY < w.fontSize * 0.5 && gapX < w.fontSize * 3 && isFormulaCandidate(w)) {
          currentIndices.push(i);
          currentBbox.x0 = Math.min(currentBbox.x0, w.bbox.x0);
          currentBbox.y0 = Math.min(currentBbox.y0, w.bbox.y0);
          currentBbox.x1 = Math.max(currentBbox.x1, w.bbox.x1);
          currentBbox.y1 = Math.max(currentBbox.y1, w.bbox.y1);
          currentFontSum += w.fontSize;
          currentText += ' ' + w.text;
          continue;
        }
        flushRegion();
      }
    }
  }
  flushRegion();

  return regions;
}

function ensureCanvas(
  source: ImageData | HTMLCanvasElement | OffscreenCanvas,
): HTMLCanvasElement | null {
  if (source instanceof HTMLCanvasElement) return source;
  if (typeof document === 'undefined') return null;

  if (source instanceof ImageData) {
    const c = document.createElement('canvas');
    c.width = source.width;
    c.height = source.height;
    c.getContext('2d')!.putImageData(source, 0, 0);
    return c;
  }

  // OffscreenCanvas → HTMLCanvasElement
  const c = document.createElement('canvas');
  c.width = source.width;
  c.height = source.height;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(source, 0, 0);
  return c;
}

function cropCanvas(
  source: HTMLCanvasElement,
  bbox: { x0: number; y0: number; x1: number; y1: number },
): HTMLCanvasElement | null {
  const x = Math.max(0, Math.floor(bbox.x0));
  const y = Math.max(0, Math.floor(bbox.y0));
  const w = Math.min(Math.ceil(bbox.x1 - bbox.x0), source.width - x);
  const h = Math.min(Math.ceil(bbox.y1 - bbox.y0), source.height - y);
  if (w < 10 || h < 10) return null;

  // Add padding around the crop for better formula recognition
  const pad = Math.round(Math.max(w, h) * 0.1);
  const px = Math.max(0, x - pad);
  const py = Math.max(0, y - pad);
  const pw = Math.min(w + pad * 2, source.width - px);
  const ph = Math.min(h + pad * 2, source.height - py);

  const crop = document.createElement('canvas');
  crop.width = pw;
  crop.height = ph;
  const ctx = crop.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, pw, ph);
  ctx.drawImage(source, px, py, pw, ph, 0, 0, pw, ph);
  return crop;
}

// ── 漏识别区域「放大重试」的参数（见 `retryMissedInkLocally`） ──────────────
/** 区域任一边小于这个值（像素）就不试：那是表格线/噪声，不是丢失的内容 */
const RETRY_MIN_SIDE = 24;
/** 区域面积超过页面的这个比例就不试：那是插图或整页失败，不是一个「洞」 */
const RETRY_MAX_REGION_AREA_RATIO = 0.3;
/** 一页最多重试几处（按面积从大到小取） */
const RETRY_MAX_REGIONS = 8;
/** 放大倍数（检测/识别都已在原尺度失败过，原样再送没有意义） */
const RETRY_UPSCALE = 3;
/** 单个裁剪放大后的面积上限；放不下就少放一点，但**不缩小** */
const RETRY_MAX_CROP_PIXELS = 2_500_000;
/** 整页重试的总像素预算 —— 一页最多再花两张页面的推理量 */
const RETRY_PIXEL_BUDGET = 8_000_000;

/**
 * 把放大裁剪的计划渲染成画布。
 *
 * 计划本身（留白、放大倍数、像素上限）在 `lib/ocrInkRegions.ts` 的
 * `planRetryCrop` 里 —— 它是纯算术，放在那边才能在没有 DOM 的环境里
 * 单测；这里只负责「按计划画一张画布」。
 */
function renderRetryCrop(
  source: HTMLCanvasElement,
  plan: RetryCropPlan,
): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;

  const canvas = document.createElement('canvas');
  canvas.width = plan.targetW;
  canvas.height = plan.targetH;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, plan.targetW, plan.targetH);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, plan.px, plan.py, plan.pw, plan.ph, 0, 0, plan.targetW, plan.targetH);
  return canvas;
}
