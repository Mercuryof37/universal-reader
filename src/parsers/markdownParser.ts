import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { visit } from 'unist-util-visit';
import type {
  BlockMetadata,
  ContentBlock,
  DocDocument,
  FileParser,
  InlineKind,
  InlineSpan,
  ListItemSpec,
  ListSpec,
  TableSpec,
} from '@/types/content';
import { buildDocument, uid } from '@/lib/utils';
import { readTextFile } from '@/lib/textEncoding';

/** 解析结果块：尚未分配最终 id */
type DraftBlock = Omit<ContentBlock, 'id'>;

/** mdast 节点里这份解析器真正会读到的字段 */
interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  depth?: number;
  lang?: string | null;
  url?: string;
  alt?: string | null;
  identifier?: string;
  label?: string;
  checked?: boolean | null;
  ordered?: boolean;
  start?: number | null;
  align?: Array<'left' | 'center' | 'right' | null>;
  position?: { start: { offset: number }; end: { offset: number } };
}

interface ParseCtx {
  /** 脚注标识 → 序号（按引用顺序编号） */
  footnotes: Map<string, number>;
  /** 预处理后的源码，只有单行 $$...$$ 的兼容分支需要它 */
  source: string;
}

/** 行内文本 + 片段偏移的构建状态 */
interface InlineCtx {
  text: string;
  spans: InlineSpan[];
}

/**
 * Markdown 解析器。
 *
 * 用 remark 把 Markdown 解析为 mdast 语法树，再"拍平"成线性 ContentBlock 数组。
 * 拍平的原因：阅读器需要线性滚动 + 逐段朗读 + 逐段批注，
 * 而树结构在这三件事上都要额外做一次遍历，收益为负。
 *
 * 行内格式（粗体 / 斜体 / 代码 / 高亮 / 链接 / 行内公式）**不写进 content**，
 * 而是记录为 metadata.inline 的偏移片段：content 始终是纯文本，
 * 朗读、翻译、批注锚点（StableAnchor 的 offset）都继续按纯文本工作。
 * 渲染层负责把偏移变成包裹元素，并保证不增删任何字符。
 *
 * 已知取舍：
 * - 嵌套列表压成单个 block，用 indent 记录层级（朗读与批注按整块处理更合理）；
 * - 表格渲染为 GFM 表格，cell 用单个空格连接进 content（朗读/翻译仍可读）；
 * - Callout（> [!note]）识别为独立块类型，标题是 content 的第 0 行；
 * - `\(...\)` / `\[...\]` 在解析前统一改写为 `$...$`（Obsidian 的 MathJax 同样支持两套定界符），
 *   代价是正文里"转义括号"的写法（较少见）会被当成公式；
 * - YAML frontmatter 不进入正文（与 Obsidian 阅读视图一致），只取其中的 title。
 */
export class MarkdownParser implements FileParser {
  supportedFormats = ['.md', '.markdown', '.mdx'];
  label = 'Markdown';

  async parse(file: File): Promise<DocDocument> {
    const { text: raw } = await readTextFile(file);
    const { body, title } = splitFrontmatter(stripBom(raw));
    const source = normalizeMathDelimiters(body);
    const tree = unified().use(remarkParse).use(remarkGfm).use(remarkMath).parse(source) as unknown as MdNode;

    const ctx: ParseCtx = { footnotes: numberFootnotes(tree), source };
    const drafts: DraftBlock[] = [];
    collectBlocks(tree.children ?? [], drafts, ctx);

    return buildDocument({
      docId: uid(),
      fileName: file.name,
      format: 'markdown',
      blocks: mergeAdjacent(drafts),
      sizeBytes: file.size,
      title,
    });
  }
}

/**
 * 把块级节点拍平成 draft。
 *
 * 用递归而不是 visit：blockquote / callout / list / table 需要"把子树
 * 序列化成一段文本"的能力（见 draftsToLines），visit 的回调模型做不到这件事。
 */
function collectBlocks(nodes: MdNode[], out: DraftBlock[], ctx: ParseCtx): void {
  for (const node of nodes) {
    switch (node.type) {
      case 'heading': {
        const level = Math.min(6, Math.max(1, node.depth ?? 1));
        const inline = collectInlineText(node.children, ctx);
        // 标题固定单行渲染（与 Obsidian 一致）：换行折成空格，1:1 替换不动偏移
        const text = inline.text.replace(/\n/g, ' ');
        if (text.trim()) {
          out.push(draft('heading', text, { level, inline: inline.spans }));
        }
        break;
      }
      case 'paragraph': {
        const displayMath = singleLineDisplayMath(node, ctx.source);
        if (displayMath) {
          out.push(draft('math', displayMath));
          break;
        }
        const inline = collectInlineText(node.children, ctx);
        if (!inline.text.trim()) break;
        const meta: BlockMetadata = { inline: inline.spans };
        if (inline.spans.some((s) => s.kind === 'math')) meta.hasInlineMath = true;
        out.push(draft('paragraph', inline.text, meta));
        break;
      }
      case 'blockquote': {
        const callout = detectCallout(node, ctx);
        if (callout) {
          const body = draftsToLines(callout.body, ctx);
          const hasTitle = callout.title.text.trim().length > 0;
          const title = hasTitle ? callout.title.text : defaultCalloutTitle(callout.type);
          const content = body.text ? `${title}\n${body.text}` : title;
          const spans = [
            ...(hasTitle ? callout.title.spans : []),
            ...shiftSpans(body.spans, body.text ? title.length + 1 : 0),
          ];
          out.push(draft('callout', content, { callout: { type: callout.type, title }, inline: spans }));
          break;
        }
        const body = draftsToLines(node.children ?? [], ctx);
        if (body.text.trim()) out.push(draft('quote', body.text, { inline: body.spans }));
        break;
      }
      case 'list': {
        const built = buildList(node, ctx);
        if (built.items.length) {
          out.push(draft('list', built.text, { list: built.spec, inline: built.spans }));
        }
        break;
      }
      case 'table': {
        const built = buildTable(node, ctx);
        if (built.spec.rows.length) {
          out.push(draft('table', built.text, { table: built.spec, inline: built.spans }));
        }
        break;
      }
      case 'code': {
        const value = node.value ?? '';
        const codeLang = node.lang ? String(node.lang) : undefined;
        out.push(draft('code', value, { codeLang }));
        break;
      }
      case 'image': {
        const src = node.url ? String(node.url) : '';
        const alt = node.alt ? String(node.alt) : '';
        if (src) out.push(draft('image', alt, { src }));
        break;
      }
      case 'math': {
        const value = node.value ?? '';
        if (value.trim()) out.push(draft('math', value));
        break;
      }
      case 'footnoteDefinition': {
        const id = String(node.identifier ?? '');
        const index = ctx.footnotes.get(id) ?? 0;
        const body = draftsToLines(node.children ?? [], ctx);
        const prefix = `[${index}] `;
        const flat = body.text.replace(/\n/g, ' ');
        const content = flat ? `${prefix}${flat}` : `[${index}]`;
        out.push(draft('paragraph', content, { footnote: index, inline: shiftSpans(body.spans, prefix.length) }));
        break;
      }
      case 'html': {
        // 原始 HTML 块：<br> 变成换行，其余标签去掉后当正文，避免整块内容凭空消失
        const plain = (node.value ?? '')
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<[^>]+>/g, '')
          .trim();
        if (plain) out.push(draft('paragraph', plain, { inline: [] }));
        break;
      }
      case 'thematicBreak': {
        out.push(draft('divider', ''));
        break;
      }
      case 'definition':
      case 'yaml':
      case 'toml': {
        // 链接引用定义 / frontmatter：不属于正文（frontmatter 已在 parse 前剥离）
        break;
      }
      default: {
        if (node.children?.length) collectBlocks(node.children, out, ctx);
        break;
      }
    }
  }
}

function draft(type: ContentBlock['type'], content: string, metadata: BlockMetadata = {}): DraftBlock {
  return { type, content, translations: {}, metadata };
}

// ═══════════════════════════════════════════════════════════════
// 行内格式
// ═══════════════════════════════════════════════════════════════

/** 收集一段 mdast 子树的行内文本与格式片段 */
function collectInlineText(nodes: MdNode[] | undefined, ctx: ParseCtx): InlineCtx {
  const out: InlineCtx = { text: '', spans: [] };
  collectChildren(nodes, out, ctx, null);
  return out;
}

function collectChildren(
  nodes: MdNode[] | undefined,
  out: InlineCtx,
  ctx: ParseCtx,
  wrap: { kind: InlineKind; href?: string } | null,
): void {
  const start = out.text.length;
  for (const child of nodes ?? []) collectNode(child, out, ctx);
  if (wrap) {
    const end = out.text.length;
    if (end > start) {
      out.spans.push(wrap.href === undefined
        ? { start, end, kind: wrap.kind }
        : { start, end, kind: wrap.kind, href: wrap.href });
    }
  }
}

function collectNode(node: MdNode, out: InlineCtx, ctx: ParseCtx): void {
  switch (node.type) {
    case 'text':
      pushScannedText(node.value ?? '', out);
      return;
    case 'strong':
      collectChildren(node.children, out, ctx, { kind: 'strong' });
      return;
    case 'emphasis':
      collectChildren(node.children, out, ctx, { kind: 'emphasis' });
      return;
    case 'delete':
      collectChildren(node.children, out, ctx, { kind: 'del' });
      return;
    case 'link':
      collectChildren(node.children, out, ctx, { kind: 'link', href: node.url ? String(node.url) : '' });
      return;
    case 'inlineCode': {
      // 代码片段是字面量：不做 == / [[ ]] 扫描，也不做上下标猜测
      const start = out.text.length;
      out.text += node.value ?? '';
      if (out.text.length > start) out.spans.push({ start, end: out.text.length, kind: 'code' });
      return;
    }
    case 'inlineMath': {
      const start = out.text.length;
      out.text += `$${node.value ?? ''}$`;
      out.spans.push({ start, end: out.text.length, kind: 'math' });
      return;
    }
    case 'footnoteReference': {
      const id = String(node.identifier ?? node.label ?? '');
      const index = ctx.footnotes.get(id) ?? 0;
      const start = out.text.length;
      out.text += `[${index}]`;
      out.spans.push({ start, end: out.text.length, kind: 'fnref', href: id });
      return;
    }
    case 'break':
      out.text += '\n';
      return;
    case 'image':
      // 段内图片：保留 alt 文本，避免内容凭空消失
      out.text += node.alt ?? '';
      return;
    case 'html': {
      const raw = node.value ?? '';
      out.text += raw.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '');
      return;
    }
    default: {
      if (node.children?.length) collectChildren(node.children, out, ctx, null);
      else if (typeof node.value === 'string') pushScannedText(node.value, out);
      return;
    }
  }
}

/**
 * 纯文本节点：顺带扫描 Obsidian 特有的两种行内语法。
 *
 * 扫描的是**去掉定界符后**的文本（`==x==` 只留 x、`[[目标|别名]]` 只留别名），
 * 与 strong/em 的处理一致 —— 定界符属于语法，不属于正文，
 * 因此批注偏移、朗读、翻译看到的都是干净文本。
 */
const OBSIDIAN_INLINE_RE = /==([^=\n]+)==|\[\[([^[\]\n]+)\]\]/g;

function pushScannedText(value: string, out: InlineCtx): void {
  if (!value) return;
  OBSIDIAN_INLINE_RE.lastIndex = 0;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = OBSIDIAN_INLINE_RE.exec(value)) !== null) {
    if (m.index > last) out.text += value.slice(last, m.index);
    if (m[1] !== undefined) {
      const start = out.text.length;
      out.text += m[1];
      out.spans.push({ start, end: out.text.length, kind: 'mark' });
    } else {
      const raw = m[2] ?? '';
      const pipe = raw.indexOf('|');
      const target = (pipe === -1 ? raw : raw.slice(0, pipe)).trim();
      const display = (pipe === -1 ? raw : raw.slice(pipe + 1)).trim() || target;
      const start = out.text.length;
      out.text += display;
      out.spans.push({ start, end: out.text.length, kind: 'wikilink', href: wikilinkTarget(target) });
    }
    last = OBSIDIAN_INLINE_RE.lastIndex;
  }
  if (last < value.length) out.text += value.slice(last);
}

/**
 * 把 wikilink 目标转成本阅读器能跳的锚点。
 *
 * `[[#标题]]` → `#标题`（文内跳转，双方都能处理）；
 * `[[笔记]]` / `[[笔记#标题]]` 指向**别的文件**，本阅读器同时只打开一篇文档，
 * 无法跳转 —— 保留空 href，渲染层画成"未解析链接"（与 Obsidian 的失效链接观感一致）。
 */
function wikilinkTarget(raw: string): string {
  const hash = raw.indexOf('#');
  if (hash === 0) return raw.slice(1) ? `#${raw.slice(1)}` : '';
  return '';
}

// ═══════════════════════════════════════════════════════════════
// 引用 / Callout
// ═══════════════════════════════════════════════════════════════

const CALLOUT_MARKER_RE = /^\[!([A-Za-z][\w-]*)\]([+-]?)[ \t]*/;

/** 识别 `> [!note] 标题`；返回标题行与正文节点 */
function detectCallout(
  node: MdNode,
  ctx: ParseCtx,
): { type: string; title: InlineCtx; body: MdNode[] } | null {
  const first = node.children?.[0];
  if (!first || first.type !== 'paragraph') return null;
  const firstChild = first.children?.[0];
  if (!firstChild || firstChild.type !== 'text') return null;
  const m = CALLOUT_MARKER_RE.exec(firstChild.value ?? '');
  if (!m) return null;

  const type = m[1]!.toLowerCase();
  // 标题只取标记后的第一行；同一段落里换行后的文字属于正文
  // （Obsidian 里 `> [!note] 标题` 与 `> 正文` 之间可以没有空行）
  const restRaw = (firstChild.value ?? '').slice(m[0].length);
  const nl = restRaw.search(/\r?\n/);
  const titleRaw = nl === -1 ? restRaw : restRaw.slice(0, nl);
  const leftover = nl === -1 ? '' : restRaw.slice(nl + (restRaw[nl] === '\r' ? 2 : 1));
  const tailSiblings = (first.children ?? []).slice(1);

  const body: MdNode[] = [];
  if (leftover.trim()) {
    body.push({ ...first, children: [{ ...firstChild, value: leftover }, ...tailSiblings] });
  }
  body.push(...(node.children ?? []).slice(1));

  return {
    type,
    title: collectInlineText([{ ...firstChild, value: titleRaw }, ...tailSiblings], ctx),
    body,
  };
}

function defaultCalloutTitle(type: string): string {
  return type.charAt(0).toUpperCase() + type.slice(1);
}

/**
 * 把一组块级节点序列化成多行文本。
 *
 * 直接复用 collectBlocks：引用里嵌列表、代码、嵌套引用的场景
 * 会得到与顶层完全一致的文本形态，不需要第二套序列化规则。
 * 返回的 spans 偏移已按行拼接后整体平移。
 */
function draftsToLines(nodes: MdNode[], ctx: ParseCtx): InlineCtx {
  const drafts: DraftBlock[] = [];
  collectBlocks(nodes, drafts, ctx);
  const out: InlineCtx = { text: '', spans: [] };
  for (const d of drafts) {
    if (!d.content) continue;
    if (out.text) out.text += '\n';
    const base = out.text.length;
    out.text += d.content;
    for (const s of d.metadata.inline ?? []) {
      out.spans.push({ ...s, start: s.start + base, end: s.end + base });
    }
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════
// 列表 / 表格
// ═══════════════════════════════════════════════════════════════

function buildList(
  node: MdNode,
  ctx: ParseCtx,
): { spec: ListSpec; items: ListItemSpec[]; text: string; spans: InlineSpan[] } {
  const items: ListItemSpec[] = [];
  const out: InlineCtx = { text: '', spans: [] };
  walkList(node, 0, items, out, ctx);
  return { spec: { ordered: !!node.ordered, items }, items, text: out.text, spans: out.spans };
}

function walkList(
  list: MdNode,
  depth: number,
  items: ListItemSpec[],
  out: InlineCtx,
  ctx: ParseCtx,
): void {
  const ordered = !!list.ordered;
  const startAt = typeof list.start === 'number' && list.start > 0 ? list.start : 1;
  let index = startAt;

  for (const item of list.children ?? []) {
    if (item.type !== 'listItem') continue;
    const own: MdNode[] = [];
    const nested: MdNode[] = [];
    for (const child of item.children ?? []) {
      if (child.type === 'list') nested.push(child);
      else own.push(child);
    }

    // 一项可以含多个块（多段/代码/表格）：用空格压成一行，' ' 与 '\n' 等长，spans 不受影响
    const inline = draftsToLines(own, ctx);
    const text = inline.text.replace(/\n/g, ' ');
    if (text.trim()) {
      if (out.text) out.text += '\n';
      const base = out.text.length;
      out.text += text;
      for (const s of inline.spans) {
        out.spans.push({ ...s, start: s.start + base, end: s.end + base });
      }
      items.push({
        text,
        indent: depth,
        marker: ordered ? `${index}.` : depth === 0 ? '\u2022' : depth === 1 ? '\u25E6' : '\u25AA',
        checked: typeof item.checked === 'boolean' ? item.checked : null,
      });
    }
    index++;
    for (const sub of nested) walkList(sub, depth + 1, items, out, ctx);
  }
}

function buildTable(
  node: MdNode,
  ctx: ParseCtx,
): { spec: TableSpec; text: string; spans: InlineSpan[] } {
  const align = (node.align ?? []).map((a) => a ?? null);
  const rows: string[][] = [];
  const out: InlineCtx = { text: '', spans: [] };

  for (const row of node.children ?? []) {
    // 行分隔符必须加在本行单元格之前：加在行尾会变成"第 1、2 行粘连"
    // （rows.length 在 push 之前少 1，判断位置错一格就会错行）
    if (rows.length) out.text += '\n';
    const cells: string[] = [];
    for (const cell of row.children ?? []) {
      const inline = collectInlineText(cell.children, ctx);
      // cell 内不允许出现换行：content 用换行分隔行、用空格分隔单元格，
      // 这两种字符就是渲染层重建偏移的依据（见 BlockRow 的表格渲染）
      const text = inline.text.replace(/\n/g, ' ');
      if (cells.length) out.text += ' ';
      const base = out.text.length;
      out.text += text;
      for (const s of inline.spans) {
        out.spans.push({ ...s, start: s.start + base, end: s.end + base });
      }
      cells.push(text);
    }
    rows.push(cells);
  }

  return { spec: { align, rows }, text: out.text, spans: out.spans };
}

function shiftSpans(spans: InlineSpan[], delta: number): InlineSpan[] {
  if (!delta) return spans;
  return spans.map((s) => ({ ...s, start: s.start + delta, end: s.end + delta }));
}

// ═══════════════════════════════════════════════════════════════
// 源码预处理
// ═══════════════════════════════════════════════════════════════

/**
 * 单行 `$$...$$` 会被 remark-math 解析成 inlineMath，
 * 这里用节点的原始切片判断它其实是行间公式。
 */
function singleLineDisplayMath(node: MdNode, source: string): string | null {
  const children = node.children ?? [];
  if (children.length !== 1) return null;
  const only = children[0];
  if (only?.type !== 'inlineMath' || !only.position) return null;
  const raw = source.slice(only.position.start.offset, only.position.end.offset).trim();
  if (!raw.startsWith('$$') || !raw.endsWith('$$')) return null;
  const value = (only.value ?? '').trim();
  return value ? value : null;
}

/**
 * 把 MathJax 风格的 `\(...\)` / `\[...\]` 改写为 `$...$` / `$$...$$`。
 *
 * Obsidian 的 MathJax 两套定界符都认，而 remark-math 只认 `$`；
 * 不改写的话，从 LaTeX / AI 导出、Obsidian 里抄来的 `\(\alpha\)`
 * 会以字面量 `\alpha` 出现（这正是"希腊字母显示不出来"的常见形态）。
 *
 * 逐行扫描并跳过围栏代码块；行内代码（反引号）在 convertInlineDelims 里跳过。
 * 跨行的 `\[ ... \]` 依然有效（同一段非围栏文本整体处理）。
 */
function normalizeMathDelimiters(src: string): string {
  const lines = src.split('\n');
  const out: string[] = [];
  let segment: string[] = [];
  let fence: string | null = null;

  const flush = () => {
    if (segment.length) out.push(convertInlineDelims(segment.join('\n')));
    segment = [];
  };

  for (const line of lines) {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (m) {
      const marker = m[1]![0]!;
      if (fence === null) {
        flush();
        fence = marker;
      } else if (marker === fence) {
        fence = null;
        out.push(line);
        continue;
      }
    }
    if (fence !== null) out.push(line);
    else segment.push(line);
  }
  flush();
  return out.join('\n');
}

function convertInlineDelims(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '`') {
      const run = /^`+/.exec(text.slice(i))![0];
      const close = text.indexOf(run, i + run.length);
      if (close === -1) {
        out += text.slice(i);
        break;
      }
      out += text.slice(i, close + run.length);
      i = close + run.length;
      continue;
    }
    if (ch === '\\' && text[i + 1] === '(') {
      const close = text.indexOf('\\)', i + 2);
      if (close !== -1) {
        out += `$${text.slice(i + 2, close)}$`;
        i = close + 2;
        continue;
      }
    }
    if (ch === '\\' && text[i + 1] === '[') {
      const close = text.indexOf('\\]', i + 2);
      if (close !== -1) {
        out += `$$${text.slice(i + 2, close)}$$`;
        i = close + 2;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * 剥离 YAML frontmatter。
 *
 * 不剥的话，开头的 `---` 会被解析成主题分隔线 + setext 标题，
 * 正文里凭空出现一个巨大的「title: xxx」标题 —— Obsidian 阅读视图
 * 是不显示 frontmatter 的。title 顺带作为文档标题使用。
 */
function splitFrontmatter(text: string): { body: string; title?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { body: text };
  const titleLine = /^title:[ \t]*(.+)$/m.exec(m[1] ?? '');
  const title = titleLine ? titleLine[1]!.trim().replace(/^['"]|['"]$/g, '') : undefined;
  return { body: text.slice(m[0].length), title: title || undefined };
}

/** 按引用出现顺序给脚注编号；从未被引用的定义排在最后 */
function numberFootnotes(tree: MdNode): Map<string, number> {
  const numbers = new Map<string, number>();
  const collect = (type: string) => {
    visit(tree as never, (node) => {
      const n = node as unknown as MdNode;
      if (n.type !== type) return;
      const id = String(n.identifier ?? '');
      if (id && !numbers.has(id)) numbers.set(id, numbers.size + 1);
    });
  };
  collect('footnoteReference');
  collect('footnoteDefinition');
  return numbers;
}

/**
 * 合并连续正文段落（PDF 文本层与部分 Markdown 会把一段话拆成多个节点）。
 *
 * Markdown 块一律不合并：`inline` 字段存在说明它是 Markdown 语义的独立段落，
 * 且合并会破坏行内片段与批注的偏移对应。
 */
function mergeAdjacent(blocks: DraftBlock[]): DraftBlock[] {
  const out: DraftBlock[] = [];
  for (const block of blocks) {
    const prev = out[out.length - 1];
    const mergeable =
      prev &&
      prev.type === 'paragraph' &&
      block.type === 'paragraph' &&
      prev.metadata.inline === undefined &&
      block.metadata.inline === undefined &&
      !prev.metadata.hasInlineMath &&
      !block.metadata.hasInlineMath &&
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
