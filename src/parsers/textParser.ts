import type { ContentBlock, DocDocument, FileParser } from '@/types/content';
import { buildDocument, uid } from '@/lib/utils';
import { hasReadableContent, readTextFile } from '@/lib/textEncoding';
import { stripBom } from '@/parsers/markdownParser';

/**
 * 纯文本解析器。
 *
 * 段落切分策略（按优先级降级）：
 * 1. 空行分段 —— 标准且最可靠；
 * 2. 若空行分段结果只有 1 段但行数很多，说明是"每行一段"的硬换行文本，
 *    改为按单行分段；
 * 3. 仍只有 1 段则整篇作为一个 block（避免出现 0 块文档）。
 *
 * 编码处理见 lib/textEncoding.ts：不能直接用 file.text()，
 * 中文 Windows 的 txt 常是 GBK 或 UTF-16，按 UTF-8 硬读会得到空白或乱码。
 */
export class TextParser implements FileParser {
  supportedFormats = ['.txt', '.text', '.log'];
  label = '纯文本';

  async parse(file: File): Promise<DocDocument> {
    const { text: raw, encoding, lossy } = await readTextFile(file);

    if (!hasReadableContent(raw)) {
      throw new Error(
        `文件「${file.name}」中没有可读文本（实测编码：${encoding}）。` +
          `可能是空文件，或内容全部是无法识别的二进制数据。`,
      );
    }

    const text = stripBom(raw);
    const normalized = text.replace(/\r\n?/g, '\n').trim();

    let chunks = normalized
      .split(/\n{2,}/)
      .map((c) => c.trim())
      .filter(Boolean);

    if (chunks.length <= 1) {
      const lines = normalized
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      if (lines.length > 1) chunks = lines;
    }
    if (!chunks.length) chunks = [normalized];

    const blocks: Omit<ContentBlock, 'id'>[] = chunks.map((chunk) => ({
      type: detectBlockType(chunk),
      content: chunk.replace(/\n/g, ' ').replace(/\s{2,}/g, ' ').trim(),
      translations: {},
      metadata: {},
    }));

    const doc = buildDocument({
      docId: uid(),
      fileName: file.name,
      format: 'plaintext',
      blocks,
      sizeBytes: file.size,
    });

    // 把识别到的编码记进标签，便于用户在"乱码/空白"时自查
    doc.metadata.tags = [`编码：${encoding}${lossy ? '（可能有误）' : ''}`];

    return doc;
  }
}

/**
 * 依据文本外形猜测块类型。
 * 纯文本没有语义标记，只能靠启发式规则，宁可不猜也不要猜错。
 */
function detectBlockType(text: string): ContentBlock['type'] {
  const firstLine = text.split('\n')[0]!.trim();

  // Markdown 风格标题
  const heading = /^(#{1,6})\s+/.exec(firstLine);
  if (heading) return 'heading';

  // 中文/英文章节标题：第X章 / Chapter N / 一、二、
  if (/^(第[一二三四五六七八九十百千\d]+[章节回卷篇部]|Chapter\s+\d+|序章|后记|尾声)/i.test(firstLine)) {
    return 'heading';
  }

  // 引用：整段以 > 开头
  if (text.split('\n').every((l) => l.trim().startsWith('>'))) return 'quote';

  return 'paragraph';
}

/** 从纯文本首行标题中剥离 Markdown 井号，供解析器外部复用 */
export function cleanHeadingText(text: string): string {
  return text.replace(/^#{1,6}\s+/, '').trim();
}
