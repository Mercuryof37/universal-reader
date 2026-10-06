import type {
  Annotation,
  BlockType,
  ContentBlock,
  DocDocument,
  DocFormat,
  TocEntry,
} from '@/types/content';

/** 生成稳定 id。优先用 crypto.randomUUID，降级到时间戳随机串。 */
export function uid(prefix = ''): string {
  const raw =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return prefix ? `${prefix}-${raw}` : raw;
}

/** 从文件名推断展示标题（去掉扩展名、下划线与多余空格） */
export function titleFromFileName(fileName: string): string {
  return fileName
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 统计不含空白的字符数 */
export function countChars(blocks: ContentBlock[]): number {
  return blocks.reduce((sum, b) => sum + b.content.replace(/\s/g, '').length, 0);
}

/** 把任意文本切成适合 TTS 朗读的片段（过长的段落引擎会截断） */
export function splitForSpeech(text: string, maxLen = 180): string[] {
  if (text.length <= maxLen) return [text];
  const sentences = text.split(/(?<=[。！？!?.;；\n])/);
  const chunks: string[] = [];
  let buf = '';
  for (const s of sentences) {
    if ((buf + s).length > maxLen && buf) {
      chunks.push(buf);
      buf = '';
    }
    if (s.length > maxLen) {
      // 单句过长（常见于 PDF 抽出的整页文本），按硬长度切
      for (let i = 0; i < s.length; i += maxLen) chunks.push(s.slice(i, i + maxLen));
    } else {
      buf += s;
    }
  }
  if (buf) chunks.push(buf);
  return chunks.filter((c) => c.trim().length > 0);
}

/** 从 blocks 自动生成目录 */
export function buildToc(blocks: ContentBlock[]): TocEntry[] {
  return blocks
    .filter((b) => b.type === 'heading' && b.content.trim().length > 0)
    .map((b) => ({
      blockId: b.id,
      title: b.content.trim(),
      level: Math.min(6, Math.max(1, b.metadata.level ?? 1)),
    }));
}

/** 组装一篇文档，统一补齐 id、字数、目录、时间戳 */
export function buildDocument(input: {
  docId: string;
  fileName: string;
  format: DocFormat;
  blocks: Omit<ContentBlock, 'id'>[];
  language?: string;
  author?: string;
  sizeBytes?: number;
  /** 部分格式（如 PDF）能拿到更准确的标题 */
  title?: string;
}): DocDocument {
  const now = new Date().toISOString();
  const blocks: ContentBlock[] = input.blocks.map((b, i) => ({
    ...b,
    id: `doc-${input.docId}-b${i}`,
    translations: b.translations ?? {},
    metadata: b.metadata ?? {},
  }));

  return {
    id: input.docId,
    title: input.title?.trim() || titleFromFileName(input.fileName) || '未命名文档',
    format: input.format,
    blocks,
    metadata: {
      author: input.author,
      sourceFile: input.fileName,
      language: input.language ?? detectLanguage(blocks.map((b) => b.content).join('\n')),
      sizeBytes: input.sizeBytes ?? 0,
      created: now,
      modified: now,
      charCount: countChars(blocks),
      tags: [],
    },
    toc: buildToc(blocks),
  };
}

/** 粗粒度语言探测：只用于给出默认值，用户可以手动改 */
export function detectLanguage(sample: string): string {
  const text = sample.slice(0, 2000);
  if (!text.trim()) return 'zh';
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const kana = (text.match(/[\u3040-\u30ff]/g) ?? []).length;
  const hangul = (text.match(/[\uac00-\ud7af]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  if (kana > 20) return 'ja';
  if (hangul > 20) return 'ko';
  if (cjk > latin * 0.3) return 'zh';
  return 'en';
}

/** 根据选区上下文生成稳定锚点 */
export function makeAnchor(blockContent: string, start: number, end: number): Annotation['anchor'] {
  const ctx = 15;
  return {
    prefix: blockContent.slice(Math.max(0, start - ctx), start),
    suffix: blockContent.slice(end, Math.min(blockContent.length, end + ctx)),
    offset: start,
    length: end - start,
    selectedText: blockContent.slice(start, end),
  };
}

/**
 * 依据锚点还原选区位置。
 *
 * 三级降级策略：
 * 1. 原文偏移处精确匹配 —— 最常见的命中路径；
 * 2. 全文搜索原文 —— 段落前面被插入少量文字时的兜底；
 * 3. prefix/suffix 指纹夹逼 —— 段落被小幅编辑过的最终兜底。
 * 全部失败返回 null，调用方应把该批注标记为“已失锚”而不是丢弃。
 */
export function resolveAnchor(
  anchor: Annotation['anchor'],
  blockContent: string,
): { start: number; end: number } | null {
  if (!anchor) return null;
  const { selectedText, offset, prefix, suffix } = anchor;

  if (!selectedText) return null;

  // 1. 原位精确匹配
  if (blockContent.startsWith(selectedText, offset)) {
    return { start: offset, end: offset + selectedText.length };
  }

  // 2. 全文搜索
  const found = blockContent.indexOf(selectedText, Math.max(0, offset - 40));
  if (found !== -1) {
    return { start: found, end: found + selectedText.length };
  }
  const anywhere = blockContent.indexOf(selectedText);
  if (anywhere !== -1) {
    return { start: anywhere, end: anywhere + selectedText.length };
  }

  // 3. 指纹夹逼
  // 注意：prefix 为空串时 indexOf('') 恒为 0，会误命中整段开头，
  // 因此选区位于段首（prefix 为空）时必须直接放弃，交给调用方标记为失锚。
  if (!prefix) return null;

  const prefixIdx = blockContent.indexOf(prefix);
  if (prefixIdx !== -1) {
    const searchStart = prefixIdx + prefix.length;
    if (suffix) {
      const suffixIdx = blockContent.indexOf(suffix, searchStart);
      if (suffixIdx !== -1 && suffixIdx > searchStart) {
        return { start: searchStart, end: suffixIdx };
      }
      // 后缀也找不到说明改动较大，不再猜测
      return null;
    }
    return {
      start: searchStart,
      end: Math.min(blockContent.length, searchStart + selectedText.length),
    };
  }

  return null;
}

/** 猜测 MIME 是否可交给某个类型的解析器（用于拖拽时提前给出提示） */
export function guessExtension(fileName: string): string {
  const idx = fileName.lastIndexOf('.');
  return idx === -1 ? '' : fileName.slice(idx).toLowerCase();
}

/** 把 block 类型映射为可读标签，用于调试与导出 */
export const BLOCK_TYPE_LABEL: Record<BlockType, string> = {
  heading: '标题',
  paragraph: '正文',
  quote: '引用',
  code: '代码',
  list: '列表',
  image: '图片',
  math: '公式',
};
