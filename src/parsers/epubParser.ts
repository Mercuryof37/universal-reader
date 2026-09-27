import ePub from 'epubjs';
import type { ContentBlock, DocDocument, FileParser } from '@/types/content';
import { buildDocument, uid } from '@/lib/utils';

/** epubjs 的类型定义不完整，这里只声明我们真正用到的部分 */
interface EpubBook {
  ready: Promise<unknown>;
  loaded: { metadata: Promise<EpubMetadata> };
  packaging: { metadata: EpubMetadata };
  spine: { spineItems: EpubSpineItem[] };
  destroy: () => void;
}

interface EpubMetadata {
  title?: string;
  creator?: string | string[];
  language?: string | string[];
  publisher?: string;
}

interface EpubSpineItem {
  href: string;
  load: (loader: unknown) => Promise<unknown>;
  document?: Document | null;
}

const MAX_EPUB_ITEM_CHARS = 1500;

/**
 * EPUB 解析器。
 *
 * 选 epubjs 而不是"JSZip + 手写 OPF 解析"：
 * 手写方案要自己处理 OPF/NCX 命名空间、spine 的 idref 解析、相对路径拼接、
 * 非标准目录结构，实测在真实电子书上有相当比例会解析失败。
 * epubjs 直接给出按阅读顺序排好的 spine，且内置 HTML→DOM 的解析。
 *
 * 代价：epubjs 会创建隐藏的 iframe 来解析章节文档，所以在纯 Node 环境下不可用，
 * 必须在浏览器中运行（这也正是我们的运行环境）。
 */
export class EpubParser implements FileParser {
  supportedFormats = ['.epub'];
  label = 'EPUB';

  async parse(file: File): Promise<DocDocument> {
    const buffer = await file.arrayBuffer();

    const book = ePub(buffer) as unknown as EpubBook;
    await book.ready;

    const meta = await book.loaded.metadata.catch(() => ({}) as EpubMetadata);
    const drafts: Omit<ContentBlock, 'id'>[] = [];

    const spineItems = book.spine?.spineItems ?? [];
    for (const item of spineItems) {
      try {
        await item.load(book);
        const doc = item.document;
        if (!doc?.body) continue;
        drafts.push(...htmlToBlocks(doc.body));
      } catch {
        // 单个章节损坏不应导致整本书导入失败
        continue;
      }
    }

    try {
      book.destroy();
    } catch {
      // 忽略销毁失败
    }

    if (!drafts.length) {
      throw new Error('EPUB 中未找到可读正文，文件可能已损坏或使用 DRM 加密。');
    }

    const language = firstOf(meta.language);
    const author = firstOf(meta.creator);

    return buildDocument({
      docId: uid(),
      fileName: file.name,
      format: 'epub',
      blocks: drafts,
      title: firstOf(meta.title) || undefined,
      author: author || undefined,
      language: language || undefined,
      sizeBytes: file.size,
    });
  }
}

function firstOf(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

/**
 * 把一章的 body 拍平成块。
 *
 * 用块级元素作为切分单位（而不是逐个子节点），
 * 这样 <p>一段<em>强调</em></p> 会正确地变成一整段，而不是被拆成三段。
 */
export function htmlToBlocks(root: HTMLElement | Element): Omit<ContentBlock, 'id'>[] {
  const blocks: Omit<ContentBlock, 'id'>[] = [];
  const selector = 'h1,h2,h3,h4,h5,h6,p,blockquote,pre,li,figure';

  const elements = Array.from(root.querySelectorAll(selector));

  for (const el of elements) {
    const tag = el.tagName.toLowerCase();

    // 跳过嵌套在 li 里的 p，避免列表项重复出现
    if (tag === 'p' && el.closest('li')) continue;

    if (tag === 'figure') {
      const img = el.querySelector('img');
      const src = img?.getAttribute('src') ?? '';
      if (src) {
        blocks.push({
          type: 'image',
          content: img?.getAttribute('alt') ?? '',
          translations: {},
          metadata: { src },
        });
      }
      continue;
    }

    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!text) continue;

    if (tag.startsWith('h') && tag.length === 2) {
      blocks.push({
        type: 'heading',
        content: text,
        translations: {},
        metadata: { level: Number(tag[1]) },
      });
      continue;
    }

    if (tag === 'li') {
      // 把同属一个列表的多个 li 合并成一个块
      const prev = blocks[blocks.length - 1];
      if (prev && prev.type === 'list') {
        prev.content = `${prev.content}\n- ${text}`;
      } else {
        blocks.push({ type: 'list', content: `- ${text}`, translations: {}, metadata: {} });
      }
      continue;
    }

    const type: ContentBlock['type'] =
      tag === 'blockquote' ? 'quote' : tag === 'pre' ? 'code' : 'paragraph';

    blocks.push({
      type,
      content: type === 'code' ? (el.textContent ?? '').trim() : text,
      translations: {},
      metadata: tag === 'pre' ? { codeLang: el.querySelector('code')?.className || undefined } : {},
    });
  }

  // 章节内容过长时（有些 EPUB 一整章就一个 <p>），按句末标点再切
  return blocks.flatMap((b) =>
    b.content.length > MAX_EPUB_ITEM_CHARS && b.type !== 'code'
      ? splitBlock(b, MAX_EPUB_ITEM_CHARS)
      : [b],
  );
}

function splitBlock(
  block: Omit<ContentBlock, 'id'>,
  maxLen: number,
): Omit<ContentBlock, 'id'>[] {
  const pieces: string[] = [];
  let buf = '';
  for (const sentence of block.content.split(/(?<=[。！？!?.;；])/)) {
    if ((buf + sentence).length > maxLen && buf) {
      pieces.push(buf.trim());
      buf = '';
    }
    buf += sentence;
  }
  if (buf.trim()) pieces.push(buf.trim());
  return pieces.filter(Boolean).map((text) => ({ ...block, content: text }));
}
