/**
 * PaddleOCR 引擎封装（替换原 Tesseract.js）。
 *
 * 选用 ppu-paddle-ocr/web + PP-OCRv6 small 模型：
 * - 中文识别准确率远超 Tesseract（PP-OCR 专为中文训练）；
 * - 50+ 语言全字典，无需手动选语言包；
 * - ONNX Runtime Web (WASM) 运行，纯浏览器端；
 * - 模型从 HuggingFace CDN 下载并缓存。
 */
import { PaddleOcrService, V6_SMALL_MODEL } from 'ppu-paddle-ocr/web';
import { errorReport } from '@/lib/diagnostics';
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

    const service = new PaddleOcrService({
      model: V6_SMALL_MODEL,
      processing: { engine: 'canvas-native' },
    });

    try {
      await withTimeout(
        service.initialize(),
        INIT_TIMEOUT_MS,
        `OCR 引擎初始化超时（${INIT_TIMEOUT_MS / 1000} 秒）。` +
          `首次使用需下载模型（约 10MB），请检查网络后重试。`,
      );
    } catch (err) {
      throw new Error(
        errorReport('初始化 PaddleOCR 引擎失败', err) +
          '\n\n若持续失败，说明模型文件无法下载。请检查网络连接。',
      );
    }

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

    onProgress?.({ pageNum, total, status: 'complete' });

    return {
      pageNum,
      words,
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
}

export const ocrEngine = new OcrEngine();
