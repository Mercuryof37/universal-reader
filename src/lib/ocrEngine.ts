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

// Force ONNX Runtime to load WASM from CDN instead of bundling locally.
// The .wasm file is ~28MB which exceeds Cloudflare Pages' 25MB limit.
ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ort.env.versions.web ?? ort.env.versions.common}/dist/`;
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

/** 将 canvas 转为 PNG ArrayBuffer 供 PaddleOCR 消费 */
async function canvasToBuffer(
  imageData: ImageData | HTMLCanvasElement | OffscreenCanvas,
): Promise<ArrayBuffer> {
  let canvas: HTMLCanvasElement;

  if (imageData instanceof ImageData) {
    canvas = document.createElement('canvas');
    canvas.width = imageData.width;
    canvas.height = imageData.height;
    const ctx = canvas.getContext('2d')!;
    ctx.putImageData(imageData, 0, 0);
  } else if (imageData instanceof OffscreenCanvas) {
    const blob = await imageData.convertToBlob({ type: 'image/png' });
    return blob.arrayBuffer();
  } else {
    canvas = imageData;
  }

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) reject(new Error('canvas.toBlob returned null'));
        else blob.arrayBuffer().then(resolve, reject);
      },
      'image/png',
    );
  });
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
    console.info(
      `[ocrEngine] 模型来源：${OCR_MODEL_BASE}\n` +
        `  · 检测模型 ${(9.52).toFixed(2)}MB · 识别模型 20.30MB · 字典 0.07MB（合计约 29.9MB）\n` +
        `  · 首次使用需完整下载，之后会被缓存，离线可用`,
    );

    const service = new PaddleOcrService({
      model,
      processing: { engine: 'canvas-native' },
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

    // Enhance formula regions with SimpleTex cloud OCR
    const enhancedWords = await this.enhanceFormulaRegions(words, imageData);

    onProgress?.({ pageNum, total, status: 'complete' });

    return {
      pageNum,
      words: enhancedWords,
      avgConfidence,
      pageText: result.text,
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
        const buffer = await canvasToBuffer(input);
        const result = await this.service!.recognize(buffer, { flatten: true });
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
   */
  private async enhanceFormulaRegions(
    words: OcrWord[],
    imageData: ImageData | HTMLCanvasElement | OffscreenCanvas,
  ): Promise<OcrWord[]> {
    if (words.length < 3) return words;

    // 隐私开关：默认关闭，关闭时不联网（读 store 是为了让扫描件 OCR 这条
    // 非 React 链路也能拿到设置；ocrEngine 本身是按需动态 import 的）
    if (!useSettingsStore.getState().formulaOcrEnabled) return words;

    const regions = detectFormulaRegions(words);
    if (!regions.length) return words;

    console.info(`[ocrEngine] 检测到 ${regions.length} 个公式候选区域，尝试 SimpleTex 增强`);

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
        for (let i = 0; i < enhanced.length; i++) {
          if (region.wordIndices.includes(i)) {
            if (i === region.wordIndices[0]) {
              enhanced[i] = replacement;
            } else {
              enhanced[i] = null as unknown as OcrWord;
            }
          }
        }

        console.info(
          `[ocrEngine] 公式增强成功：${region.originalText.slice(0, 40)}… → $${latex.slice(0, 40)}$`,
        );
      } catch (err) {
        console.warn('[ocrEngine] 公式增强失败（保留原始识别结果）：', err);
      }
    }

    return enhanced.filter((w): w is OcrWord => w !== null);
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
