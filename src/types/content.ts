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
  | 'image'
  | 'math'
  | 'table'
  | 'callout'
  | 'divider';

/**
 * 行内格式片段（Markdown 的 **粗体**、`代码`、==高亮==、链接、行内公式等）。
 *
 * 只记录 offsets，不破坏 content 纯文本：朗读、翻译、批注锚点全部继续
 * 基于 content 工作，渲染层把 offsets 变成包裹元素。这也是"DOM 文本必须
 * 等于 content 文本"这条不变量的来源（见 annotations.ts 的偏移收集器）——
 * 包裹元素不允许增删任何字符。
 */
export type InlineKind =
  | 'strong'
  | 'emphasis'
  | 'code'
  | 'del'
  | 'mark'
  | 'link'
  | 'wikilink'
  | 'math'
  | 'fnref';

export interface InlineSpan {
  /** 相对 block.content 的起止偏移（[start, end)） */
  start: number;
  end: number;
  kind: InlineKind;
  /** link/wikilink 的目标（# 开头为文内锚点）；fnref 为脚注标识 */
  href?: string;
}

/** GFM 表格：rows 含表头行，cells 用单个空格连接作为 content 的一行 */
export interface TableSpec {
  align: Array<'left' | 'center' | 'right' | null>;
  rows: string[][];
}

/** 列表项（嵌套列表被拍平，用 indent 记录层级） */
export interface ListItemSpec {
  text: string;
  indent: number;
  /** 悬挂在行首的项目符号（CSS ::before 绘制，不进入 content） */
  marker: string;
  /** 任务列表的勾选状态；null 表示普通列表项 */
  checked: boolean | null;
}

export interface ListSpec {
  ordered: boolean;
  items: ListItemSpec[];
}

/** `> [!note] 标题` 提示框 */
export interface CalloutSpec {
  /** note / tip / warning / ... 未知类型按默认色渲染 */
  type: string;
  /** 标题行文本（content 的第 0 行） */
  title: string;
}

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

/**
 * 批注锚点：**块内字符偏移**的定位符字符串。
 *
 * 形态（本项目自己的语义，不是 MinerU 的坐标格式）：
 *
 * ```
 * doc:{documentId}/page:{pageIdx}/block:{blockIdx}/char:{offset}+{length}
 * ```
 *
 * **base 约定（三个数各不相同，因此写死在这里，改动必须同步改测试）：**
 * - `doc` —— `documents` 表主键 `DocDocument.id`，原样，不做转义；
 * - `page` —— **1-based**（与 `BlockMetadata.pageNumber` 一致，与用户看到的页码一致）。
 *   ⚠️ 没有页概念的格式（md / txt / epub）**没有这个段**，连 `page:` 都不写 ——
 *   不写一个假的 `page:1`，因为那会让"这本 md 有第 1 页"变成一句谎话；
 * - `block` —— **0-based**，`DocDocument.blocks` 里的数组序号；
 * - `char` —— **0-based**，**块内**字符偏移（`block.content` 的 UTF-16 code unit 下标，
 *   换行符计入 1）。`+{length}` 是选区长度；`{length}` 为 0 时退化成点锚点。
 *
 * 为什么不复用 MinerU 的 1-based block：本项目的数组下标本来就是 0-based，
 * 多一次 ±1 换算就多一处能写错的地方。**纪律在于"写清楚"，不在于选哪个 base。**
 */
export type AnnotationLocator = string;

/**
 * 迁移留痕（纯增量字段，只在真的迁移过之后才写入）。
 *
 * 记录"这条旧批注是什么时候、以什么方式升级到块内字符偏移的"，
 * 让用户能看见升级发生过、也能看见升级时位置挪了多少。
 */
export interface AnnotationMigration {
  /** 迁移时间（ISO 字符串） */
  at: string;
  /** 迁移时用的判据：‘exact’ 原位命中；‘repaired’ 靠块内修复命中 */
  strategy: 'exact' | 'repaired' | 'rebased';
  /** 相对旧偏移挪了多少字符（0 表示没挪） */
  shiftedBy: number;
}

/** 单条批注 */
export interface Annotation {
  id: string;
  docId: string;
  blockId: string;
  type: AnnotationType;
  /** 选区锚点；纯笔记类批注（针对整段）可以没有选区 */
  anchor?: StableAnchor;
  /**
   * 块内字符偏移定位符（纯增量字段）。
   *
   * 旧批注没有这个字段，渲染时自动退回 `anchor` 的文本匹配路径；
   * 打开文档时会被一次性迁移补上（见 `lib/annotationAnchor.ts` 的 migrateAnnotation）。
   * ⚠️ **迁移只新增、不删除** —— `anchor` 永久保留作为降级路径，
   * 删掉它等于让历史批注在迁移失败时彻底丢失。
   */
  locator?: AnnotationLocator;
  /** 旧锚点被迁移到定位符时留下的痕迹 */
  migration?: AnnotationMigration;
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
  /** 段落内是否包含行内公式（$...$），渲染时需走 KaTeX */
  hasInlineMath?: boolean;
  /**
   * 行内格式片段。
   *
   * 只有 Markdown 解析器会写这个字段，而且**即使没有格式也会写空数组**：
   * 渲染层用 `inline !== undefined` 判断"这是 Markdown 块"，
   * 从而启用 Obsidian 排版、关闭 OCR 专用的 `x^2` / `snake_case` 猜测。
   */
  inline?: InlineSpan[];
  table?: TableSpec;
  list?: ListSpec;
  callout?: CalloutSpec;
  /** 脚注定义块的编号（内容以 `[n] ` 开头） */
  footnote?: number;
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
