/**
 * 扫描版 PDF 的类型与错误定义。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么这个错误类必须单独成文件
 * ═══════════════════════════════════════════════════════════════
 *
 * 这个类原先定义在 `pdfParser.ts` 里，而 `parsers/index.ts` 与
 * `store/libraryStore.ts` 都需要 import 它来判断"是不是扫描件"。
 * 问题在于：pdfParser 依赖 pdfjs，而 pdfParser 又依赖 tesseract.js（OCR），
 * 于是"只想要一个错误类"的模块被迫把这两个大依赖一起静态引入 ——
 * 首屏包从 68KB 涨到 201KB（gzip），按需加载的优化被一个 import 语句抵消掉了。
 *
 * 把类型与错误定义抽成零依赖的独立模块，是解决这类"为了一个类型拖进整棵依赖树"
 * 的标准做法：类型和错误是跨模块的契约，不应该与实现绑在同一个文件里。
 */

/** 判定一份 PDF 是否为扫描版所需的信息 */
export interface ScannedPdfInfo {
  totalPages: number;
  /** 原始文件字节，供 OCR 流程复用，避免二次读取 */
  buffer: ArrayBuffer;
  metaTitle: string;
  metaAuthor: string;
  fileName: string;
  fileSize: number;
}

/**
 * 扫描版 PDF 专用错误。
 *
 * 为什么单独一个错误类型（而不是返回 null 或抛普通 Error）：
 * 扫描件不是"失败"，而是"需要用另一条流程处理"——
 * 调用方需要据此切换到 OCR 路径，并拿到 buffer 而不必重新读文件。
 * 用类型来表达这种可预期的分支，比解析错误信息字符串可靠得多。
 *
 * `isScannedPdfError` 用标记属性而不是 `instanceof`：pdfParser 是动态 import 的，
 * 在极端的模块重复加载场景下 instanceof 可能失效，标记属性永远可靠。
 */
export class ScannedPdfError extends Error {
  readonly totalPages: number;
  readonly buffer: ArrayBuffer;
  readonly metaTitle: string;
  readonly metaAuthor: string;
  readonly fileName: string;
  readonly fileSize: number;
  /** 供 isScannedPdfError 识别的标记 */
  readonly isScannedPdf = true;

  /** `buffer` 的别名，语义更明确（调用方用 pdfBuffer 读取原始字节） */
  get pdfBuffer(): ArrayBuffer {
    return this.buffer;
  }

  /** `totalPages` 的别名，保持与 pageCount 命名习惯的兼容 */
  get pageCount(): number {
    return this.totalPages;
  }

  constructor(totalPages: number, buffer: ArrayBuffer, metaTitle: string, metaAuthor: string, fileName: string, fileSize: number) {
    super(
      `这份 PDF 的 ${totalPages} 页全部没有文字层，是扫描版（图片型）PDF。` +
        `可以选择用 OCR 识别文字后继续阅读。`,
    );
    this.name = 'ScannedPdfError';
    this.totalPages = totalPages;
    this.buffer = buffer;
    this.metaTitle = metaTitle;
    this.metaAuthor = metaAuthor;
    this.fileName = fileName;
    this.fileSize = fileSize;

    // 开发期立刻暴露"buffer 已被分离"的问题。
    // 背景：pdf.js 在独立 Worker 模式下会把传入的 ArrayBuffer **转移**给 worker，
    // 之后主线程这一侧的 buffer 长度为 0，再读它就抛
    // `Cannot perform Construct on a detached ArrayBuffer`。
    // 而 OCR 流程恰恰需要复用同一份字节 —— 与其等到用户点击"开始识别"才失败，
    // 不如在错误对象构造时就报出来（见 pdfParser.ts 的 copyForPdfJs）。
    if (buffer.byteLength === 0 && fileSize > 0) {
      console.error(
        '[scannedPdfError] 传入的 buffer 已分离（byteLength 为 0），OCR 将无法使用它。' +
          '调用方需要用 copyForPdfJs() 先拷贝一份再交给 pdf.js。',
      );
    }
  }
}

/**
 * 类型守卫。
 *
 * 用结构判断而非 instanceof，因此可以安全跨越动态 import 边界，
 * 也允许 mock 对象在测试中使用。
 */
export function isScannedPdfError(err: unknown): err is ScannedPdfError {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { isScannedPdf?: unknown }).isScannedPdf === true
  );
}
