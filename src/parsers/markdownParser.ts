import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { visit } from 'unist-util-visit';
import type { ContentBlock, DocDocument, FileParser } from '@/types/content';
import { buildDocument, uid } from '@/lib/utils';
import { readTextFile } from '@/lib/textEncoding';

/** 解析结果块：尚未分配最终 id */
type DraftBlock = Omit<ContentBlock, 'id'>;

/**
 * Markdown 解析器。
 *
 * 用 remark 把 Markdown 解析为 mdast 语法树，再"拍平"成线性 ContentBlock 数组。
 * 拍平的原因：阅读器需要线性滚动 + 逐段朗读 + 逐段批注，
 * 而树结构在这三件事上都要额外做一次遍历，收益为负。
 *
 * 已知取舍：
 * - 嵌套列表压成单个 block，用缩进保留层级（朗读与批注按整块处理更合理）；
 * - 表格暂不处理为独立类型，会作为普通文本段落落入 paragraph；
 * - 行内格式（加粗、链接）在朗读与翻译时只取纯文本。
 */
export class MarkdownParser implements FileParser {
  supportedFormats = ['.md', '.markdown', '.mdx'];
  label = 'Markdown';

  async parse(file: File): Promise<DocDocument> {
    const { text: raw } = await readTextFile(file);
    const text = stripBom(raw);
    const tree = unified().use(remarkParse).use(remarkGfm).parse(text);

    const drafts: DraftBlock[] = [];

    visit(tree, (node, _index, parent) => {
      switch (node.type) {
        case 'heading': {
          const depth = 'depth' in node ? Number(node.depth) : 1;
          drafts.push(textBlock('heading', extractText(node), { level: depth }));
          return 'skip';
        }
        case 'paragraph': {
          // 列表项内部的段落交给 list 分支统一处理，避免重复
          if (parent && parent.type === 'listItem') return 'skip';
          drafts.push(textBlock('paragraph', extractText(node)));
          return 'skip';
        }
        case 'blockquote': {
          drafts.push(textBlock('quote', extractText(node)));
          return 'skip';
        }
        case 'code': {
          const value = 'value' in node ? String(node.value) : '';
          const codeLang = 'lang' in node && node.lang ? String(node.lang) : undefined;
          drafts.push(textBlock('code', value, { codeLang }));
          return 'skip';
        }
        case 'list': {
          const items = flattenList(node);
          if (items.length) drafts.push(textBlock('list', items.join('\n')));
          return 'skip';
        }
        case 'image': {
          const src = 'url' in node ? String(node.url) : '';
          const alt = 'alt' in node && node.alt ? String(node.alt) : '';
          if (src) drafts.push(textBlock('image', alt, { src }));
          return 'skip';
        }
        case 'html': {
          // 原始 HTML 块：去掉标签后当正文，避免整块内容凭空消失
          const value = 'value' in node ? String(node.value) : '';
          const plain = value.replace(/<[^>]+>/g, '').trim();
          if (plain) drafts.push(textBlock('paragraph', plain));
          return 'skip';
        }
        case 'thematicBreak':
          return 'skip';
        default:
          return undefined;
      }
    });

    return buildDocument({
      docId: uid(),
      fileName: file.name,
      format: 'markdown',
      blocks: mergeAdjacent(drafts),
      sizeBytes: file.size,
    });
  }
}

function textBlock(
  type: ContentBlock['type'],
  content: string,
  metadata: ContentBlock['metadata'] = {},
): DraftBlock {
  return { type, content, translations: {}, metadata };
}

/** 递归抽取节点下的纯文本 */
function extractText(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const n = node as { type?: string; value?: unknown; children?: unknown[] };
  if (typeof n.value === 'string') return n.value;
  if (Array.isArray(n.children)) {
    return n.children
      .map((child) => extractText(child))
      .join('')
      .replace(/[ \t]+\n/g, '\n')
      .trim();
  }
  return '';
}

/** 把列表压成带缩进的纯文本行 */
function flattenList(node: unknown, depth = 0): string[] {
  const n = node as { children?: unknown[] };
  const lines: string[] = [];
  for (const item of n.children ?? []) {
    const itemNode = item as { children?: unknown[] };
    const parts: string[] = [];
    const nested: unknown[] = [];
    for (const child of itemNode.children ?? []) {
      const c = child as { type?: string };
      if (c.type === 'list') nested.push(child);
      else parts.push(extractText(child));
    }
    const text = parts.join(' ').replace(/\s+/g, ' ').trim();
    if (text) lines.push(`${'  '.repeat(depth)}- ${text}`);
    for (const sub of nested) lines.push(...flattenList(sub, depth + 1));
  }
  return lines;
}

/**
 * 合并连续正文段落。
 *
 * PDF 与部分 Markdown 会把一段话拆成多个节点（软换行、分栏），
 * 逐块渲染会出现"一句话一行"的碎片化排版，也会让翻译按碎片送 API 导致语义断裂。
 */
function mergeAdjacent(blocks: DraftBlock[]): DraftBlock[] {
  const out: DraftBlock[] = [];
  for (const block of blocks) {
    const prev = out[out.length - 1];
    const mergeable =
      prev &&
      prev.type === 'paragraph' &&
      block.type === 'paragraph' &&
      !/[。！？.!?：:；;】」』"']$/.test(prev.content) &&
      prev.content.length + block.content.length <= 400;
    if (mergeable) {
      prev.content = `${prev.content} ${block.content}`.replace(/\s+/g, ' ').trim();
    } else {
      out.push({ ...block });
    }
  }
  return out;
}

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
