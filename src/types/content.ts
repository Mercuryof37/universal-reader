/**
 * 统一内容模型 —— 整个阅读器的数据契约。
 *
 * 设计原则：
 * 1. 所有格式（md / txt / pdf / epub）解析后都收敛到 DocDocument，渲染层只认这一种结构。
 * 2. 译文与批注挂在 Block 上，而不是另建索引表，导出时天然自洽。
 * 3. 所有字段都可 JSON 序列化，保证能直接塞进 IndexedDB。
 */

/** 支持的源文件格式 */
export type DocFormat = 'markdown' | 'plaintext' | 'pdf' | 'epub';

/** 内容块的语义类型，决定渲染样式 */
export type BlockType =
  | 'heading'
  | 'paragraph'
  | 'quote'
  | 'code'
  | 'list'
  | 'image';

/** 批注类型 */
export type AnnotationType = 'highlight' | 'note' | 'tag' | 'question';

/** 高亮预设色，避免用户随手选色导致对比度不可读 */
export const HIGHLIGHT_COLORS = ['amber', 'rose', 'sky', 'emerald', 'violet'] as const;
export type HighlightColor = (typeof HIGHLIGHT_COLORS)[number];

/**
 * 稳定选区锚点。
 *
 * 只存 offset 是不够的：文档重新解析（换了解析器版本、去掉了页眉）
 * 之后 offset 会整体漂移，批注就会跑到别的句子上。
 * 因此额外记录选区前后各 15 个字符，作为二次定位的指纹。
 */
export interface StableAnchor {
  /** 选区前 15 个字符（指纹前缀） */
  prefix: string;
  /** 选区后 15 个字符（指纹后缀） */
  suffix: string;
  /** 相对于所属 block.content 的字符偏移 */
  offset: number;
  /** 选区字符长度 */
  length: number;
  /** 被选中的原文，用于精确匹配 */
  selectedText: string;
}

/** 单条批注 */
export interface Annotation {
  id: string;
  docId: string;
  blockId: string;
  type: AnnotationType;
  /** 选区锚点；纯笔记类批注（针对整段）可以没有选区 */
  anchor?: StableAnchor;
  /** 笔记正文 / 提问内容 */
  content?: string;
  color: HighlightColor;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

/** 内容块的元信息 */
export interface BlockMetadata {
  /** heading 层级 1-6 */
  level?: number;
  /** 代码块语言 */
  codeLang?: string;
  /** 原文语言代码，如 zh / en / ja */
  lang?: string;
  /** PDF 页码，便于回跳 */
  pageNumber?: number;
  /** 图片（EPUB 内嵌）的 data URL */
  src?: string;
  /** OCR 置信度 0-100，仅 OCR 生成的块有此字段 */
  ocrConfidence?: number;
}

/** 统一内容块 */
export interface ContentBlock {
  /** 唯一标识，格式 doc-{docId}-b{index} */
  id: string;
  type: BlockType;
  /** 原文文本 */
  content: string;
  /** 译文缓存，键为语言代码，如 { zh: "……" } */
  translations: Record<string, string>;
  metadata: BlockMetadata;
}

/** 目录条目 */
export interface TocEntry {
  blockId: string;
  title: string;
  level: number;
}

/** 文档级元信息 */
export interface DocumentMetadata {
  author?: string;
  /** 原始文件名 */
  sourceFile: string;
  /** 原文语言 */
  language: string;
  /** 字节数，用于展示与容量提示 */
  sizeBytes: number;
  created: string;
  modified: string;
  /** 不含空白的字符数，中文场景下比 word count 更直观 */
  charCount: number;
  tags: string[];
}

/** 一篇文档 */
export interface DocDocument {
  id: string;
  title: string;
  format: DocFormat;
  blocks: ContentBlock[];
  metadata: DocumentMetadata;
  toc: TocEntry[];
}

/** 阅读进度，独立存储以免每次翻页都重写整篇文档 */
export interface ReadingProgress {
  docId: string;
  /** 当前顶部可见的 block 下标 */
  blockIndex: number;
  /** 0-1 的百分比，仅用于展示 */
  percent: number;
  updatedAt: string;
}

/** 解析器的统一接口 */
export interface FileParser {
  /** 支持的扩展名，小写且带点，如 ['.md', '.markdown'] */
  supportedFormats: string[];
  /** 展示名 */
  label: string;
  /** 解析入口；失败时抛出带可读信息的 Error */
  parse(file: File): Promise<DocDocument>;
}

/** 双语对照布局 */
export type BilingualLayout = 'stacked' | 'side-by-side' | 'original-only' | 'translation-only';

/** 阅读主题 */
export type Theme = 'scroll' | 'sepia' | 'dark';
