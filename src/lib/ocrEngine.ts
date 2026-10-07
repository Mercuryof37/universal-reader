/**
 * PaddleOCR 引擎封装（替换原 Tesseract.js）。
 *
 * 选用 ppu-paddle-ocr/web + PP-OCRv6 small 模型：
 * - 中文识别准确率远超 Tesseract（PP-OCR 专为中文训练）；
 * - 50+ 语言全字典，无需手动选语言包；
 * - ONNX Runtime Web (WASM) 运行，纯浏览器端。
 */
import { PaddleOcrService } from 'ppu-paddle-ocr/web';
import * as ort from 'onnxruntime-web';
import { errorReport } from '@/lib/diagnostics';
import { recognizeFormula } from '@/services/formulaOcrService';
import { useSettingsStore } from '@/store/settingsStore';
import { OCR_MODEL_BASE, OCR_MODEL_FILES, buildOcrModel } from '@/lib/ocrModelSource';
import { resolveExecutionProviders } from '@/lib/ocrExecutionProvider';
import { noteOcrStage } from '@/lib/sessionDiagnostics';
import {
  detectMissedInkRegionsFromCanvas,
  overlapRatio,
  type MissedInkRegion,
} from '@/lib/ocrInkRegions';

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

    const result = await this.recognizeWithFallback(imageData, pageNum, total);

    const words: OcrWord[] = [];
    for (const item of result.results) {
      const text = item.text.trim();
      if (!text) continue;
      words.push({
        text,
        confidence: Math.round(item.confidence * 100),
        bbox: {
          x0: item.box.x,
          y0: item.box.y,
          x1: item.box.x + item.box.width,
          y1: item.box.y + item.box.height,
        },
        fontSize: item.box.height,
      });
    }

    if (!words.length) {
      console.warn(
        `[ocrEngine] 第 ${pageNum} 页未提取到词。` +
          `识别结果数=${result.results.length}，纯文本长度=${result.text.length}`,
      );
    }

    const avgConfidence = words.length
      ? words.reduce((sum, w) => sum + w.confidence, 0) / words.length
      : 0;

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

    // Enhance formula regions with SimpleTex cloud OCR
    const enhancedWords = await this.enhanceFormulaRegions(words, imageData, missedInkRegions);

    onProgress?.({ pageNum, total, status: 'complete' });

    return {
      pageNum,
      words: enhancedWords,
      avgConfidence,
      pageText: result.text,
      missedInkRegions: missedInkRegions.length ? missedInkRegions : undefined,
      extraction: {
        source: words.length ? 'flat-words' : result.text.trim() ? 'page-text-only' : 'empty',
        hasFlatWords: words.length > 0,
        hasBlocks: false,
        blocks: 0,
        paragraphs: 0,
        lines: 0,
        skippedBlank: result.results.length - words.length,
      },
    };
  }

  private async recognizeWithFallback(
    imageData: ImageData | HTMLCanvasElement | OffscreenCanvas,
    pageNum: number,
    total: number,
  ) {
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
        return result;
      } catch (err) {
        lastError = err;
        console.warn(`[ocrEngine] 第 ${pageNum} 页「${label}」识别失败：`, err);
      }
    }

    throw new Error(errorReport(`识别第 ${pageNum} 页（共 ${total} 页）失败`, lastError));
  }

  async terminate(): Promise<void> {
    this.service = null;
    this.initialized = false;
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
