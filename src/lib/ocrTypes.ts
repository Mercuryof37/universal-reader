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

/**
 * 计算「为了不超过像素上限，实际该用多大的渲染缩放」。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么必须在**渲染之前**算，而不是渲染完再缩
 * ═══════════════════════════════════════════════════════════════
 *
 * `OCR_MAX_PIXELS` 原先只在 OCR 引擎内部生效（`factorForMaxPixels`），
 * 也就是说：**先把整页按 300 DPI 画出来，再缩到 40 MP**。
 *
 * 问题在于那张「先画出来」的画布是按原始尺寸分配的：
 * 20.7×27 英寸的页面 = 6200×8100 ≈ 50 MP ≈ **200MB 单张画布**。
 * 峰值内存出现在缩放之前，而下采样并不能把峰值降下来 ——
 * 它只是让**下游**拿到一张小图。
 *
 * 后果是真实存在的：在内存受限的设备（手机浏览器尤其明显）上，
 * 标签页会被系统直接回收 —— 表现为**页面莫名其妙自己刷新**、
 * 一直转圈、并且识别结果一个字都没留下。用户报的正是这个现象，
 * 而且只在扫描版 PDF 上出现（只有这条路径会渲染这种大画布）。
 *
 * 这里改成**先算好缩放再渲染**：最终交给 OCR 的图与原来**完全等价**
 * （同样受 40 MP 上限约束），但峰值内存从 200MB 降到 160MB 以下，
 * 更重要的是不再有「先分配 200MB 再丢掉」这一步。
 *
 * @param baseWidth  页面在 scale=1 时的宽度（PDF 点）
 * @param baseHeight 页面在 scale=1 时的高度（PDF 点）
 * @returns 实际使用的缩放系数
 */
export function renderScaleFor(
  baseWidth: number,
  baseHeight: number,
  dpi = OCR_RENDER_DPI,
  maxPixels = OCR_MAX_PIXELS,
): number {
  const ideal = dpi / 72;
  if (!Number.isFinite(baseWidth) || !Number.isFinite(baseHeight)) return ideal;
  if (baseWidth <= 0 || baseHeight <= 0) return ideal;

  const width = baseWidth * ideal;
  const height = baseHeight * ideal;
  const pixels = width * height;
  if (!Number.isFinite(pixels) || pixels <= maxPixels) return ideal;

  // 等比降采样：面积比开平方就是线性比例
  return ideal * Math.sqrt(maxPixels / pixels);
}

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

/**
 * 每隔多少页把已识别的结果落盘一次。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么必须有「中途落盘」这件事
 * ═══════════════════════════════════════════════════════════════
 *
 * 原先整次 OCR 的结果只存在内存里，**直到最后一页跑完才写 IndexedDB**。
 * 一本几百页的扫描书要跑十几分钟，这十几分钟里任何中断 ——
 * 页面刷新、误关标签页、浏览器崩溃、内存不足 ——
 * 都会让整次扫描**无声无息地全部丢失**：没有报错、没有摘要、书库里也没有条目，
 * 用户完全不知道发生了什么。
 *
 * 这不是假想：本应用用 `autoUpdate` 的 Service Worker，
 * 新版本部署后页面会**自动重载**，正好会在扫描途中把内存里的结果清空。
 *
 * 取 5 页：一次 IndexedDB 写入的代价远小于一页 OCR，
 * 但丢失窗口从"整次扫描"缩小到"最多 5 页"。
 */
export const OCR_CHECKPOINT_EVERY_PAGES = 5;

/**
 * 当前这一页处理完后，是否应该把结果落盘。
 *
 * 纯函数，便于单测 —— 落盘时机的边界（第一页、末页、不足一个间隔的小任务）
 * 是最容易写错又最不容易发现的地方。
 *
 * @param firstSuccessfulPage 本页是否是**第一页成功产出内容**的页。
 *   这一条是后来补上的，而且很关键：原来只在「第 5、10、15…页」落盘，
 *   于是**少于 5 页就中断的任务一个字都没保存**。
 *   用户报的正是这个 —— 「扫描完看不到文档，书库里也没有新条目」。
 *   现在只要第一页识别成功就立刻落盘，几秒内书库里就会出现条目，
 *   之后无论发生什么中断，至少有东西留下来。
 */
export function shouldCheckpoint(
  pageNum: number,
  totalPages: number,
  firstSuccessfulPage = false,
): boolean {
  if (!Number.isFinite(pageNum) || pageNum <= 0) return false;
  // 第一页成功 → 立刻落盘，把「书库里什么都没有」这个窗口压到最短
  if (firstSuccessfulPage) return true;
  // 末页一定落盘：否则不足一个间隔的任务（比如试跑 3 页）永远等不到检查点
  if (pageNum >= totalPages) return true;
  return pageNum % OCR_CHECKPOINT_EVERY_PAGES === 0;
}
