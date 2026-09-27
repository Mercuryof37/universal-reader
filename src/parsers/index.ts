import type { DocDocument, FileParser } from '@/types/content';
import { describeUnknownError } from '@/lib/diagnostics';
import { guessExtension } from '@/lib/utils';
import { MarkdownParser } from '@/parsers/markdownParser';
import { TextParser } from '@/parsers/textParser';
// 从独立模块导入，而不是从 pdfParser：
// pdfParser 静态依赖 pdfjs、动态依赖 tesseract.js（OCR）。
// 仅仅为了拿到这个错误类而 import pdfParser，会把两个大依赖拖进首屏包
// —— 实测主包会从 68KB 涨到 201KB（gzip），按需加载的优化被一个 import 抵消。
import { isScannedPdfError } from '@/parsers/scannedPdfError';

export { ScannedPdfError, isScannedPdfError } from '@/parsers/scannedPdfError';

/**
 * 解析器注册表。
 *
 * 关键设计：轻量解析器与重量解析器分开处理。
 *
 * Markdown / TXT 的依赖（unified + remark，约 100KB）很小，直接静态引入；
 * PDF 与 EPUB 的依赖（pdfjs 约 400KB、epubjs 约 300KB）占了整个应用的大头，
 * 而实际使用中"只读 md/txt"的用户相当常见。因此这两个解析器改为动态 import：
 * 只有真的拖入 PDF / EPUB 时才下载对应的代码，首屏体积因此减半。
 *
 * 代价是查表变成异步的。为了让上传区仍能提前展示"支持哪些格式"，
 * 这里保留一份声明式的格式清单（SUPPORTED_EXTENSIONS），
 * 它与下方工厂函数一一对应；新增格式时两处都要改，这是刻意接受的少量重复。
 */

const markdownParser = new MarkdownParser();
const textParser = new TextParser();

/** 无需额外下载即可使用的解析器 */
const eagerParsers: FileParser[] = [markdownParser, textParser];

/** 需要时才加载的解析器工厂 */
const lazyParsers: Record<string, () => Promise<FileParser>> = {
  '.pdf': async () => new (await import('@/parsers/pdfParser')).PdfParser(),
  '.epub': async () => new (await import('@/parsers/epubParser')).EpubParser(),
};

/** 给 <input accept> 与提示文案复用的格式清单 */
export const SUPPORTED_EXTENSIONS = ['.md', '.markdown', '.mdx', '.txt', '.text', '.log', '.pdf', '.epub'];

export const SUPPORTED_HINT = 'Markdown (.md) / 纯文本 (.txt) / PDF (.pdf) / EPUB (.epub)';

/** 找出处理该扩展名的解析器（可能触发一次代码下载） */
export async function findParser(fileName: string): Promise<FileParser | undefined> {
  const ext = guessExtension(fileName);

  const eager = eagerParsers.find((p) => p.supportedFormats.includes(ext));
  if (eager) return eager;

  const factory = lazyParsers[ext];
  if (factory) return factory();

  return undefined;
}

export async function isSupported(fileName: string): Promise<boolean> {
  return (await findParser(fileName)) !== undefined;
}

/** 解析入口：按扩展名分发到对应解析器 */
export async function parseFile(file: File): Promise<DocDocument> {
  const parser = await findParser(file.name);
  if (!parser) {
    const ext = guessExtension(file.name) || '未知';
    throw new Error(`不支持的文件格式「${ext}」。当前支持：${SUPPORTED_HINT}`);
  }

  const doc = await parser.parse(file);

  if (doc.blocks.length === 0) {
    throw new Error(
      `未能从「${file.name}」中提取出任何文本内容。` +
        `如果是扫描版 PDF（图片型），需要先用 OCR 工具转成文字；` +
        `如果是空文件，请确认文件内容。`,
    );
  }

  return doc;
}

/**
 * 批量解析。
 *
 * 刻意串行执行：PDF 解析本身会占满一个核，
 * 并发多个大文件只会互相抢内存（一个 50MB 的 PDF 展开后可能占几百 MB）。
 *
 * ScannedPdfError 会被直接向上抛出，让调用方处理 OCR 流程。
 */
export async function parseFiles(
  files: File[],
  onProgress?: (done: number, total: number, currentName: string) => void,
): Promise<{ documents: DocDocument[]; errors: { fileName: string; message: string }[] }> {
  const documents: DocDocument[] = [];
  const errors: { fileName: string; message: string }[] = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i]!;
    onProgress?.(i, files.length, file.name);
    try {
      documents.push(await parseFile(file));
    } catch (err) {
      // 扫描件不是失败，而是需要用 OCR 这条另一路径处理，因此直接向上抛
      if (isScannedPdfError(err)) throw err;
      errors.push({ fileName: file.name, message: describeUnknownError(err) });
    }
  }
  onProgress?.(files.length, files.length, '');

  return { documents, errors };
}
