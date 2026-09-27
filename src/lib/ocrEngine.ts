/**
 * Tesseract.js OCR 引擎封装。
 *
 * 设计要点：
 * - Worker 池复用：避免每页都重新加载 WASM + traineddata（中文包 22MB）；
 * - 进度回调：让 UI 能展示"正在识别第 X/Y 页"；
 * - 自动降级：chi_sim+eng 双语识别，首次使用从 CDN 下载语言包后浏览器缓存。
 */
import { createWorker, type Worker as TesseractWorker } from 'tesseract.js';
import { errorReport } from '@/lib/diagnostics';
import { extractWords } from '@/lib/ocrWordExtraction';
import {
  OCR_BLANK_LUMA_THRESHOLD,
  OCR_MAX_PIXELS,
  type OcrLang,
  type OcrPageResult,
  type OcrProgress,
  type OcrWord,
} from '@/lib/ocrTypes';

/**
 * 按比例缩放 canvas，返回新画布；比例为 1 或无法缩放时返回 null。
 *
 * 这是「页面过大导致 Leptonica 读不出图像」的正面解法：
 * 与其等 tesseract 报错，不如在交给它之前就把尺寸压到安全范围。
 */
function scaleCanvas(
  source: ImageData | HTMLCanvasElement | OffscreenCanvas,
  factor: number,
): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null; // 非浏览器环境
  if (source instanceof ImageData) return null; // ImageData 换尺寸需重建，不处理
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

  // 白底 + 平滑缩放：透明像素在 PNG 里会变黑，直接影响 OCR 识别率
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, targetW, targetH);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source as CanvasImageSource, 0, 0, targetW, targetH);

  return target;
}

/**
 * 超过像素上限时的缩放比例；未超限返回 1。
 */
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
 * 分析画布的墨迹分布。
 *
 * 返回**可测量的数值**而不是布尔值，这一点是刻意的：
 * 上一轮的故障里，"10 页全部被判定为空白"与"10 页真的都是空白"
 * 在日志上完全无法区分，导致排查绕了一大圈。
 * 把深色像素比例暴露出来，就能一眼看出是渲染问题还是文件问题。
 */
export interface CanvasInkStats {
  /** 深色像素占比 0-1 */
  darkRatio: number;
  /** 平均亮度 0-255 */
  meanLuma: number;
  width: number;
  height: number;
  /** 是否因为异常而无法测量（此时**不应**据此跳过页面） */
  failed: boolean;
  /** 采样用的缩略图尺寸 */
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
      // 亮度近似：人眼对绿色最敏感，加权平均比简单平均更符合感知
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
    // 读取失败（画布被污染、显存不足等）时标记 failed，
    // 调用方应据此**继续做 OCR** 而不是跳过 —— 宁可白跑一次，也不能静默丢页
    console.warn('[ocrEngine] 画布墨迹分析失败：', err);
    return failedStats;
  }
}

/**
 * 判断画布是否几乎全白（空白页）。
 *
 * 故意做成"测量失败时返回 false"：跳过页面的代价是丢掉内容，
 * 而多做一次 OCR 的代价只是几秒。**不确定时选择不跳过。**
 */
export function isMostlyBlank(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  threshold = OCR_BLANK_LUMA_THRESHOLD,
): boolean {
  const stats = analyzeCanvasInk(canvas, threshold);
  if (stats.failed) return false;
  // 深色像素占比极低 → 空白页
  return stats.darkRatio < 0.0005;
}

/** 初始化超时上限：语言包下载慢是常态，但不能无限等 */
const INIT_TIMEOUT_MS = 180_000;

/** 给 promise 加超时；超时抛带说明的错误，避免界面永远卡在"初始化中" */
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

// 类型定义集中在 ocrTypes.ts（零依赖），这里重新导出以保持既有 import 路径可用。
// 这样做让"只想要类型/常量"的模块不必引入 tesseract.js。
export type { OcrLang, OcrPageResult, OcrProgress, OcrWord };
export { OCR_LANG_OPTIONS } from '@/lib/ocrTypes';

class OcrEngine {
  private workers: TesseractWorker[] = [];
  private initialized = false;
  private lang: OcrLang = 'chi_sim+eng';

  /**
   * 初始化引擎（下载 WASM 与语言包）。
   *
   * 第一次使用需要下载中文语言包（约 22MB），**耗时可能很长且全程无进度**，
   * 因此：
   * 1. 加超时上限 —— 否则网络卡住时界面会永远停在"初始化中"；
   * 2. 失败时把阶段说清楚 —— createWorker 的失败原因通常不够具体，
   *    用户需要知道"是下载语言包失败"而不是笼统的"初始化失败"。
   */
  async initialize(lang: OcrLang = 'chi_sim+eng'): Promise<void> {
    if (this.initialized && this.lang === lang) return;

    await this.terminate();
    this.lang = lang;

    let worker: TesseractWorker;
    try {
      worker = await withTimeout(
        createWorker(lang, 1, {
          logger: () => {},
        }),
        INIT_TIMEOUT_MS,
        `OCR 引擎初始化超时（${INIT_TIMEOUT_MS / 1000} 秒）。` +
          `首次识别需要下载语言包（中文约 22MB），请检查网络后重试；` +
          `若网络受限，可改用外部工具离线 OCR。`,
      );
    } catch (err) {
      // 抛出带上下文的错误：这里失败几乎总是网络或 CDN 问题
      throw new Error(
        errorReport(
          `初始化 OCR 引擎失败（语言：${lang}）`,
          err,
        ) +
          `\n\n若持续失败，说明语言包无法下载。可改用外部工具离线 OCR：` +
          `ocrmypdf -l chi_sim --force-ocr 输入.pdf 输出.pdf`,
      );
    }

    this.workers = [worker];
    this.initialized = true;
  }

  async recognizePage(
    imageData: ImageData | HTMLCanvasElement | OffscreenCanvas,
    pageNum: number,
    total: number,
    onProgress?: (p: OcrProgress) => void,
  ): Promise<OcrPageResult> {
    if (!this.initialized || !this.workers.length) {
      throw new Error('OCR 引擎未初始化，请先调用 initialize()');
    }

    onProgress?.({ pageNum, total, status: 'recognizing' });

    const worker = this.workers[0]!;
    const data = await this.recognizeWithFallback(worker, imageData, pageNum, total);

    // 词在 tesseract v7 里位于 blocks[].paragraphs[].lines[].words[]，
    // 而 v5 及更早是平铺的 words[]。extractWords 同时兼容两者。
    // 曾经的写法是直接读 `data.words` —— 在 v7 上恒为 undefined，
    // 导致每一页都被当成"没识别出文字"，且因为上层把这种情况与空白页
    // 归为一类而完全不报错（详见 ocrWordExtraction.ts 的说明）。
    const { words, pageText, diagnostics } = extractWords(data);

    if (!words.length) {
      // 关键诊断：区分"真的一无所获"与"结构没匹配上"。
      // 这个区分是缺失的，才让上一轮的故障被静默掩盖了一整轮。
      console.warn(
        `[ocrEngine] 第 ${pageNum} 页未提取到词。` +
          `提取路径=${diagnostics.source}` +
          `（平铺 words=${diagnostics.hasFlatWords}, blocks=${diagnostics.hasBlocks},` +
          ` 遍历到 ${diagnostics.blocks} 块/${diagnostics.paragraphs} 段/${diagnostics.lines} 行），` +
          `纯文本长度=${pageText.length}`,
      );
    }

    const avgConfidence = words.length
      ? words.reduce((sum, w) => sum + w.confidence, 0) / words.length
      : 0;

    onProgress?.({ pageNum, total, status: 'complete' });

    return { pageNum, words, avgConfidence, pageText, extraction: diagnostics };
  }

  /**
   * 识别一页，带多档降采样保底。
   *
   * ═══════════════════════════════════════════════════════════════
   * 为什么需要"多档"而不是"重试一次"
   * ═══════════════════════════════════════════════════════════════
   *
   * pdf.js 把 canvas 转成 PNG 交给 Leptonica，页面过大会导致
   * `Error attempting to read image.`（SetImageFile 返回 1）。
   *
   * 实测这份 PDF 的页面在 300 DPI 下达 50 兆像素。第一版只做了一次
   * "降到 40 MP 后重试"，结果 10 页里仍有 6 页失败 —— 说明失败阈值
   * 并不取决于我们设的像素上限，而可能是内存或 PNG 体积的综合限制。
   *
   * **同一尺寸重试是没有意义的**，所以这里逐档缩小：1 → 0.7 → 0.5 → 0.35。
   * 0.5 × 50 MP = 12.5 MP，对应约 150 DPI，对 OCR 识别率几乎没有影响
   * （识别率在 200 DPI 左右就接近上限了），但 PNG 体积降到 1/4。
   */
  private async recognizeWithFallback(
    worker: TesseractWorker,
    imageData: ImageData | HTMLCanvasElement | OffscreenCanvas,
    pageNum: number,
    total: number,
  ): Promise<Awaited<ReturnType<TesseractWorker['recognize']>>['data']> {
    /** 显式要求 blocks 输出：它是词级坐标的来源，也就是段落切分的依据 */
    const options = { blocks: true } as Parameters<TesseractWorker['recognize']>[1];

    // 第一档：若超过像素上限，先按上限缩放；否则用原始尺寸
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
        const { data } = await worker.recognize(
          input as Parameters<TesseractWorker['recognize']>[0],
          options,
        );
        if (factor < 0.999) {
          console.info(`[ocrEngine] 第 ${pageNum} 页以「${label}」识别成功`);
        }
        return data;
      } catch (err) {
        lastError = err;
        console.warn(`[ocrEngine] 第 ${pageNum} 页「${label}」识别失败：`, err);
      }
    }

    throw new Error(errorReport(`识别第 ${pageNum} 页（共 ${total} 页）失败`, lastError));
  }

  async terminate(): Promise<void> {
    for (const w of this.workers) {
      try {
        await w.terminate();
      } catch (err) {
        // 销毁失败不该影响主流程，但要留下痕迹（worker 泄漏查起来很麻烦）
        console.warn('[ocrEngine] 终止 worker 失败：', err);
      }
    }
    this.workers = [];
    this.initialized = false;
  }

  get isReady(): boolean {
    return this.initialized;
  }
}

export const ocrEngine = new OcrEngine();
