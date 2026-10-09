import type { Annotation, ContentBlock, InlineSpan } from '@/types/content';
import { resolveAnchor } from '@/lib/utils';

export interface TextSegment {
  text: string;
  /** 该片段关联的批注 id 列表（可能重叠） */
  annotationIds: string[];
  /** 取第一个高亮批注的颜色，用于渲染底色 */
  color: string | null;
  /** 与该片段完全重叠的行内格式片段（粗体 / 代码 / 链接 / 公式…） */
  inlines: InlineSpan[];
}

/**
 * 把一段纯文本按"批注范围 + 行内格式片段"切成待渲染的片段。
 *
 * 这是阅读器里最容易出错、也最值得单独测试的一块逻辑：
 * - 批注可能重叠（用户先高亮再对同一段加笔记）；
 * - 锚点可能失锚（文档重新解析后偏移漂移），失锚的批注必须被跳过而不是抛错；
 * - 必须保证输出片段拼起来严格等于原文，否则界面会丢字。
 *
 * 因此这里统一用"边界点切分 + 区间归属"的方式，不做字符串替换。
 * 批注与行内格式共用同一次切分：两者的边界放在一起排序，
 * 每个片段同时携带"属于哪些批注"与"带哪些格式"，渲染层从内到外依次包裹。
 */
export function buildStyledSegments(
  content: string,
  annotations: Annotation[],
  inlines: InlineSpan[] = [],
): TextSegment[] {
  if (!content) return [];

  const ranges: { start: number; end: number; annotation: Annotation }[] = [];
  for (const ann of annotations) {
    const resolved = resolveAnchor(ann.anchor, content);
    if (!resolved || resolved.end <= resolved.start) continue;
    ranges.push({ ...resolved, annotation: ann });
  }
  const spans = inlines.filter((s) => s.end > s.start && s.start < content.length && s.end > 0);

  if (!ranges.length && !spans.length) {
    return [{ text: content, annotationIds: [], color: null, inlines: [] }];
  }

  // 收集所有切分边界（含首尾），排序去重
  const boundaries = new Set<number>([0, content.length]);
  for (const r of ranges) {
    boundaries.add(clampIndex(r.start, content.length));
    boundaries.add(clampIndex(r.end, content.length));
  }
  for (const s of spans) {
    boundaries.add(clampIndex(s.start, content.length));
    boundaries.add(clampIndex(s.end, content.length));
  }
  const points = [...boundaries].sort((a, b) => a - b);

  const segments: TextSegment[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i]!;
    const end = points[i + 1]!;
    if (end <= start) continue;

    const covering = ranges.filter((r) => r.start <= start && r.end >= end);
    const first = covering[0];
    segments.push({
      text: content.slice(start, end),
      annotationIds: covering.map((r) => r.annotation.id),
      color: first ? first.annotation.color : null,
      inlines: spans.filter((s) => s.start <= start && s.end >= end),
    });
  }

  // 相邻且归属完全相同的片段合并，减少 DOM 节点数量
  const merged: TextSegment[] = [];
  for (const seg of segments) {
    const prev = merged[merged.length - 1];
    if (prev && sameSegment(prev, seg)) {
      prev.text += seg.text;
    } else {
      merged.push({ ...seg });
    }
  }

  return merged;
}

/** 兼容旧签名：只按批注切分 */
export function buildSegments(content: string, annotations: Annotation[]): TextSegment[] {
  return buildStyledSegments(content, annotations, []);
}

function sameSegment(a: TextSegment, b: TextSegment): boolean {
  if (a.color !== b.color) return false;
  if (a.annotationIds.length !== b.annotationIds.length) return false;
  if (!a.annotationIds.every((id, i) => id === b.annotationIds[i])) return false;
  if (a.inlines.length !== b.inlines.length) return false;
  return a.inlines.every((s, i) => {
    const t = b.inlines[i]!;
    return s.start === t.start && s.end === t.end && s.kind === t.kind && s.href === t.href;
  });
}

/**
 * 取片段集合的一段子区间。
 *
 * start/end 相对**片段集合覆盖的起点**（完整片段的集合即 block.content），
 * 返回值是裁剪后的片段，属性（批注 / 格式）原样保留 ——
 * 表格单元格、列表项、Callout 标题都靠它从整块片段里切自己那一段。
 */
export function sliceSegments(segments: TextSegment[], start: number, end: number): TextSegment[] {
  const out: TextSegment[] = [];
  let cursor = 0;
  for (const seg of segments) {
    const segStart = cursor;
    const segEnd = cursor + seg.text.length;
    cursor = segEnd;
    if (segEnd <= start || segStart >= end) continue;
    const from = Math.max(start, segStart);
    const to = Math.min(end, segEnd);
    if (to <= from) continue;
    out.push({ ...seg, text: seg.text.slice(from - segStart, to - segStart) });
  }
  return out;
}

export interface StyledLine {
  text: string;
  segments: TextSegment[];
}

/**
 * 按 '\n' 把片段切成"行"。
 *
 * 与渲染层的约定：多行块（引用、列表、表格行…）在 DOM 里用
 * `data-sep="1"` 的容器分行，行与行之间恰好对应 content 里的一个 '\n'。
 */
export function splitStyledLines(segments: TextSegment[], content: string): StyledLine[] {
  const lines: StyledLine[] = [];
  let start = 0;
  for (let i = 0; i <= content.length; i++) {
    if (i === content.length || content[i] === '\n') {
      lines.push({ text: content.slice(start, i), segments: sliceSegments(segments, start, i) });
      start = i + 1;
    }
  }
  return lines;
}

function clampIndex(value: number, max: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(max, Math.max(0, value));
}

// ═══════════════════════════════════════════════════════════════
// 选区偏移
// ═══════════════════════════════════════════════════════════════

/**
 * 把浏览器选区的位置换算成 block.content 里的字符偏移。
 *
 * 为什么不能直接用 `Range.toString().length`：
 * 1. KaTeX 的公式会同时渲染 MathML 与 HTML 两份字形，toString 会把
 *    每个字符数两遍（`$\alpha$` 会数成好几个字符）；
 * 2. 表格单元格、分行容器在 DOM 里并没有分隔字符，而 content 里有空格 / 换行。
 *
 * 于是渲染层与这里约定了一套显式标记（见 BlockRow）：
 * - `data-math-src`：公式元素，按**原始文本**计数，不进入其内部；
 * - `data-sep="1"`：容器元素，相邻子元素之间插入 1 个分隔字符（对应空格 / 换行），
 *   只允许加在"子元素恰好是行 / 单元格 / 表格行"这类结构容器上；
 * - `data-dec="1"`：纯装饰元素（复选框、Callout 图标），不计长、也不触发分隔符。
 *
 * 不变量：按这套规则数出来的文本必须逐字符等于 content。
 * 数不出来（返回 null）时宁可放弃选区，也不给出错的坐标。
 */
const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

interface WalkState {
  acc: number;
  done: boolean;
  result: number;
  targetNode: Node;
  targetOffset: number;
}

export function domTextOffset(container: Node, node: Node, offset: number): number | null {
  const st: WalkState = { acc: 0, done: false, result: 0, targetNode: node, targetOffset: offset };
  walk(container, st);
  return st.done ? st.result : null;
}

function walk(node: Node, st: WalkState): void {
  if (st.done) return;

  if (node.nodeType === TEXT_NODE) {
    const len = node.nodeValue?.length ?? 0;
    if (node === st.targetNode) {
      st.result = st.acc + Math.min(st.targetOffset, len);
      st.done = true;
      return;
    }
    st.acc += len;
    return;
  }
  if (node.nodeType !== ELEMENT_NODE) return;

  const el = node as Element;
  const mathSrc = el.getAttribute('data-math-src');
  if (mathSrc !== null) {
    if (node === st.targetNode || subtreeContains(el, st.targetNode)) {
      st.result = st.acc;
      st.done = true;
      return;
    }
    st.acc += mathSrc.length;
    return;
  }

  if (node === st.targetNode) {
    // 选区端点落在元素边界上（少见）：按元素起点计
    st.result = st.acc;
    st.done = true;
    return;
  }

  const sepAttr = el.getAttribute('data-sep');
  const sep = sepAttr ? Number(sepAttr) || 0 : 0;
  let sawElement = false;
  const children = node.childNodes;
  for (let i = 0; i < children.length && !st.done; i++) {
    const child = children[i]!;
    const isElement = child.nodeType === ELEMENT_NODE;
    // data-dec：纯装饰元素（复选框、Callout 图标），既不计长也不触发分隔符
    if (isElement && (child as Element).getAttribute('data-dec') !== null) continue;
    if (isElement && sawElement && sep > 0) st.acc += sep;
    if (isElement) sawElement = true;
    walk(child, st);
  }
}

/** 纯结构判断：target 是否在 root 子树内（不计长度，用于公式内部落点） */
function subtreeContains(root: Node, target: Node): boolean {
  if (root === target) return true;
  if (root.nodeType !== ELEMENT_NODE) return false;
  const children = root.childNodes;
  for (let i = 0; i < children.length; i++) {
    if (subtreeContains(children[i]!, target)) return true;
  }
  return false;
}

/** 从浏览器 Selection 反推它在指定容器内的字符偏移 */
export function selectionOffsets(
  selection: Selection,
  container: HTMLElement,
): { start: number; end: number; text: string } | null {
  if (!selection.rangeCount) return null;

  const range = selection.getRangeAt(0);
  if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) {
    return null;
  }

  const text = range.toString();
  if (!text.trim()) return null;

  const start = domTextOffset(container, range.startContainer, range.startOffset);
  const end = domTextOffset(container, range.endContainer, range.endOffset);
  if (start === null || end === null || end <= start) return null;

  return { start, end, text };
}

/** 判断某块是否含有批注，供侧边栏过滤与块级样式使用 */
export function blockHasAnnotation(block: ContentBlock, annotations: Annotation[]): boolean {
  return annotations.some((a) => a.blockId === block.id);
}
