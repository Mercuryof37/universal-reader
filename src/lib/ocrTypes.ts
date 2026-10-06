/**
 * OCR 的语言选项与共享类型。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么这些定义不放在 ocrEngine.ts 里
 * ═══════════════════════════════════════════════════════════════
 *
 * `ocrEngine.ts` 静态依赖 PaddleOCR（`ppu-paddle-ocr` + `onnxruntime-web`；
 * 模型约 10MB 从 HuggingFace CDN 下载，ONNX Runtime WASM 约 28MB 从 CDN 加载）。
 * 但有两处只想要"类型或常量"：
 * - `FileUploadZone` 需要语言下拉框的选项列表；
 * - `pdfParser` / `ocrPostProcess` 需要类型定义。
 *
 * 若这些定义留在 ocrEngine 里，上述模块就会被迫把整个 OCR 引擎拉进依赖图，
 * 首屏包因此膨胀（实测主包从 68KB 涨到 201KB gzip）。
 *
 * 规律：**跨模块共享的常量与类型必须与重量级实现分离。**
 * 这与 `parsers/scannedPdfError.ts` 的拆分动机相同。
 */

export type OcrLang = 'chi_sim+eng' | 'chi_tra+eng' | 'jpn+eng' | 'kor+eng' | 'eng';

export const OCR_LANG_OPTIONS: { value: OcrLang; label: string }[] = [
  { value: 'chi_sim+eng', label: '简体中文 + English' },
  { value: 'chi_tra+eng', label: '繁體中文 + English' },
  { value: 'jpn+eng', label: '日本語 + English' },
  { value: 'kor+eng', label: '한국어 + English' },
  { value: 'eng', label: 'English only' },
];

/** OCR 流程的阶段，供界面展示进度文案 */
export type OcrStatus =
  /**
   * 首次下载模型并初始化 ONNX Runtime WASM
   * （PP-OCRv6 small 模型约 10MB 来自 HuggingFace CDN，ONNX WASM 约 28MB 来自 jsDelivr，这一步最慢）
   */
  | 'initializing'
  | 'recognizing'
  | 'complete';

export interface OcrProgress {
  pageNum: number;
  total: number;
  status: OcrStatus;
}

export interface OcrWord {
  text: string;
  /** 置信度 0-100 */
  confidence: number;
  /** 像素坐标，原点在左上角。写回文字层时需要换算到 PDF 坐标系 */
  bbox: { x0: number; y0: number; x1: number; y1: number };
  /** 字高（像素），用于段落聚类时判断行距与字号突变 */
  fontSize: number;
}

export interface OcrPageResult {
  pageNum: number;
  words: OcrWord[];
  /** 该页平均置信度 0-100，低于阈值时应提示用户核对 */
  avgConfidence: number;
  /**
   * 整页纯文本。PaddleOCR 的结果里也始终提供它，
   * 因此是"识别出了文字但取不到坐标"时的兜底，也是重要诊断信息。
   */
  pageText?: string;
  /** 词提取的诊断信息，用于区分"真的一无所获"与"结构没匹配上" */
  extraction?: {
    source: 'flat-words' | 'nested-blocks' | 'page-text-only' | 'empty';
    hasFlatWords: boolean;
    hasBlocks: boolean;
    blocks: number;
    paragraphs: number;
    lines: number;
    skippedBlank: number;
  };
}

/**
 * 渲染 DPI。
 *
 * 300 是 OCR 的常规推荐值，但**必须配合像素上限使用**：
 * 真实故障里遇到 PDF 页面本身有 20.7×27 英寸，300 DPI 下渲染出 6200×8100
 * 的 50 兆像素画布，超过 Leptonica 的处理能力并报
 * `Error attempting to read image.`
 */
export const OCR_RENDER_DPI = 300;

/**
 * 单页渲染的像素上限（40 MP）。
 *
 * 超过时等比降采样。OCR 在 200 DPI 左右已接近识别率上限，
 * 而 50 MP → 40 MP 的降采样对识别率几乎没有影响，
 * 却能避免超出下游图像库的尺寸限制。
 */
export const OCR_MAX_PIXELS = 40_000_000;

/** 超过该比例判定为空白页，直接跳过 OCR（扫描书里有大量空白页与插图页） */
export const OCR_BLANK_LUMA_THRESHOLD = 250;

/** 一次 OCR 任务中单页失败后是否继续处理后续页面 */
export const OCR_CONTINUE_ON_PAGE_ERROR = true;

/**
 * 计算实际要处理的页数。
 *
 * 抽成纯函数的原因：这个计算在两个地方用到（store 展示进度、parser 决定循环边界），
 * 而两处口径不一致会导致进度条与实际处理量对不上 —— 这类 bug 很难查。
 *
 * 边界处理：
 * - 不传上限 → 处理全部
 * - 上限超过总页数 → 收敛到总页数
 * - 上限为 0 / 负数 / NaN → 视为不限（而不是"一页都不处理"，那会让按钮像坏了一样）
 */
export function resolvePageLimit(totalPages: number, maxPages?: number): number {
  if (!Number.isFinite(totalPages) || totalPages <= 0) return 0;
  if (maxPages === undefined) return totalPages;
  if (!Number.isFinite(maxPages) || maxPages <= 0) return totalPages;
  return Math.min(Math.floor(maxPages), totalPages);
}
