import type { Annotation, ContentBlock } from '@/types/content';
import { resolveAnchor } from '@/lib/utils';

export interface TextSegment {
  text: string;
  /** 该片段关联的批注 id 列表（可能重叠） */
  annotationIds: string[];
  /** 取第一个高亮批注的颜色，用于渲染底色 */
  color: string | null;
}

/**
 * 把一段纯文本按批注范围切成待渲染的片段。
 *
 * 这是阅读器里最容易出错、也最值得单独测试的一块逻辑：
 * - 批注可能重叠（用户先高亮再对同一段加笔记）；
 * - 锚点可能失锚（文档重新解析后偏移漂移），失锚的批注必须被跳过而不是抛错；
 * - 必须保证输出片段拼起来严格等于原文，否则界面会丢字。
 *
 * 因此这里统一用"边界点切分 + 区间归属"的方式，不做字符串替换。
 */
export function buildSegments(content: string, annotations: Annotation[]): TextSegment[] {
  if (!annotations.length || !content) {
    return content ? [{ text: content, annotationIds: [], color: null }] : [];
  }

  const ranges: { start: number; end: number; annotation: Annotation }[] = [];
  for (const ann of annotations) {
    const resolved = resolveAnchor(ann.anchor, content);
    if (!resolved || resolved.end <= resolved.start) continue;
    ranges.push({ ...resolved, annotation: ann });
  }

  if (!ranges.length) {
    return [{ text: content, annotationIds: [], color: null }];
  }

  // 收集所有切分边界（含首尾），排序去重
  const boundaries = new Set<number>([0, content.length]);
  for (const r of ranges) {
    boundaries.add(clampIndex(r.start, content.length));
    boundaries.add(clampIndex(r.end, content.length));
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
    });
  }

  // 相邻且归属完全相同的片段合并，减少 DOM 节点数量
  const merged: TextSegment[] = [];
  for (const seg of segments) {
    const prev = merged[merged.length - 1];
    if (
      prev &&
      prev.color === seg.color &&
      prev.annotationIds.length === seg.annotationIds.length &&
      prev.annotationIds.every((id, idx) => id === seg.annotationIds[idx])
    ) {
      prev.text += seg.text;
    } else {
      merged.push({ ...seg });
    }
  }

  return merged;
}

function clampIndex(value: number, max: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(max, Math.max(0, value));
}

/** 从浏览器 Selection 反推它在指定元素内的字符偏移 */
export function selectionOffsets(
  selection: Selection,
  container: HTMLElement,
): { start: number; end: number; text: string } | null {
  if (!selection.rangeCount) return null;

  const range = selection.getRangeAt(0);
  if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) {
    return null;
  }

  const preRange = document.createRange();
  preRange.selectNodeContents(container);
  preRange.setEnd(range.startContainer, range.startOffset);

  const start = preRange.toString().length;
  const text = range.toString();
  if (!text.trim()) return null;

  return { start, end: start + text.length, text };
}

/** 判断某块是否含有批注，供侧边栏过滤与块级样式使用 */
export function blockHasAnnotation(block: ContentBlock, annotations: Annotation[]): boolean {
  return annotations.some((a) => a.blockId === block.id);
}
