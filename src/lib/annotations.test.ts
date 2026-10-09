import { describe, expect, it } from 'vitest';
import {
  buildStyledSegments,
  domTextOffset,
  sliceSegments,
  splitStyledLines,
  type TextSegment,
} from '@/lib/annotations';
import { makeAnchor } from '@/lib/utils';
import type { Annotation, HighlightColor, InlineSpan } from '@/types/content';

/**
 * 选区收集器只依赖 nodeType / nodeValue / childNodes / getAttribute，
 * 所以这里用一棵鸭子类型的假树来测，不引入 jsdom。
 */
interface FakeNode {
  nodeType: number;
  nodeValue?: string;
  childNodes?: FakeNode[];
  getAttribute?: (name: string) => string | null;
}

function text(value: string): FakeNode {
  return { nodeType: 3, nodeValue: value };
}

function el(attrs: Record<string, string>, ...children: FakeNode[]): FakeNode {
  return { nodeType: 1, childNodes: children, getAttribute: (name) => attrs[name] ?? null };
}

const N = (n: FakeNode) => n as unknown as Node;

function annotation(anchor: Annotation['anchor'], color: HighlightColor = 'amber'): Annotation {
  return {
    id: 'a1',
    docId: 'd',
    blockId: 'b0',
    type: 'highlight',
    color,
    tags: [],
    anchor,
    createdAt: '',
    updatedAt: '',
  };
}

describe('domTextOffset', () => {
  it('把嵌套元素的文本累加成偏移', () => {
    const world = text('world');
    const root = el({}, text('Hello '), el({}, world));
    expect(domTextOffset(N(root), N(world), 0)).toBe(6);
    expect(domTextOffset(N(root), N(world), 3)).toBe(9);
  });

  it('选区端点落在元素边界上时按元素起点计', () => {
    const span = el({}, text('abc'));
    const root = el({}, text('xy'), span);
    expect(domTextOffset(N(root), N(span), 0)).toBe(2);
  });

  it('data-math-src 按原始文本计数，不进入 KaTeX 的双份字形', () => {
    const glyph = text('μ');
    const html = el({}, text('μ'));
    const math = el({ 'data-math-src': '$\\mu$' }, glyph, html);
    const rest = text('abc');
    const root = el({}, math, rest);

    // content 是 '$\mu$abc'（5 + 3），公式内部落点归到公式起点
    expect(domTextOffset(N(root), N(glyph), 0)).toBe(0);
    expect(domTextOffset(N(root), N(rest), 1)).toBe(6);
  });

  it('data-sep 容器在相邻子元素之间插入 1 个分隔字符', () => {
    const first = text('ab');
    const second = text('cd');
    const root = el({ 'data-sep': '1' }, el({}, first), el({}, second));
    // content 'ab\ncd'
    expect(domTextOffset(N(root), N(second), 0)).toBe(3);
    expect(domTextOffset(N(root), N(second), 2)).toBe(5);
  });

  it('表格的双层分隔符与 "单元格用空格、行用换行" 的约定一致', () => {
    const a = text('a');
    const b = text('b');
    const c = text('c');
    const d = text('d');
    const root = el(
      {},
      el(
        {},
        el(
          { 'data-sep': '1' },
          el({ 'data-sep': '1' }, el({}, a), el({}, b)),
          el({ 'data-sep': '1' }, el({}, c), el({}, d)),
        ),
      ),
    );
    // content 'a b\nc d'
    expect(domTextOffset(N(root), N(c), 0)).toBe(4);
    expect(domTextOffset(N(root), N(d), 0)).toBe(6);
  });

  it('data-dec 装饰元素（复选框）不占位、也不触发分隔符', () => {
    const checkbox = el({ 'data-dec': '1' });
    const itemText = text('买牛奶');
    const next = text('写代码');
    const root = el({ 'data-sep': '1' }, el({}, checkbox, itemText), el({}, next));
    // content '买牛奶\n写代码'：复选框若被当成元素，偏移会整体 +1
    expect(domTextOffset(N(root), N(itemText), 0)).toBe(0);
    expect(domTextOffset(N(root), N(next), 0)).toBe(4);
  });

  it('Callout 结构下图标不占位，标题与正文之间恰好 1 个分隔符', () => {
    const title = text('提示');
    const body = text('正文');
    const root = el(
      { 'data-sep': '1' },
      el({}, el({ 'data-dec': '1' }, el({}, text(''))), el({}, title)),
      el({}, body),
    );
    // content '提示\n正文'
    expect(domTextOffset(N(root), N(title), 0)).toBe(0);
    expect(domTextOffset(N(root), N(body), 0)).toBe(3);
    expect(domTextOffset(N(root), N(body), 2)).toBe(5);
  });

  it('目标不在树里、或超出文本长度时的行为可预期', () => {
    const root = el({}, text('ab'));
    expect(domTextOffset(N(root), N(text('zz')), 0)).toBeNull();
    expect(domTextOffset(N(root), N(root.childNodes![0]!), 5)).toBe(2);
  });
});

describe('buildStyledSegments 与 sliceSegments', () => {
  const content = 'ABCDEFG';

  it('批注与行内格式共用同一次切分，拼接严格等于原文', () => {
    const strong: InlineSpan = { start: 0, end: 3, kind: 'strong' };
    const segments = buildStyledSegments(content, [annotation(makeAnchor(content, 2, 5))], [strong]);
    expect(segments.map((s) => s.text).join('')).toBe(content);

    const overlap = segments.find((s) => s.text === 'C');
    expect(overlap?.annotationIds).toEqual(['a1']);
    expect(overlap?.inlines.map((s) => s.kind)).toEqual(['strong']);
    expect(overlap?.color).toBe('amber');

    // 只有格式没有批注的片段 color 必须是 null，避免被误画成高亮
    const plain = segments.find((s) => s.text === 'AB');
    expect(plain?.annotationIds).toEqual([]);
    expect(plain?.color).toBeNull();
  });

  it('相邻且归属相同的片段会被合并', () => {
    const inline: InlineSpan[] = [{ start: 0, end: 7, kind: 'strong' }];
    const segments = buildStyledSegments(content, [], inline);
    expect(segments).toHaveLength(1);
    expect((segments[0] as TextSegment).inlines).toHaveLength(1);
  });

  it('sliceSegments 裁剪出子区间且保留格式归属', () => {
    const segments = buildStyledSegments(
      content,
      [],
      [
        { start: 0, end: 3, kind: 'strong' },
        { start: 4, end: 7, kind: 'code' },
      ],
    );
    const sliced = sliceSegments(segments, 2, 6);
    expect(sliced.map((s) => s.text).join('')).toBe('CDEF');
    expect(sliced[0]?.inlines.map((s) => s.kind)).toEqual(['strong']);
    expect(sliced[sliced.length - 1]?.inlines.map((s) => s.kind)).toEqual(['code']);
  });

  it('splitStyledLines 按换行切行，跨行的格式在每行里各自保留', () => {
    const multi = 'ab\ncd';
    const segments = buildStyledSegments(multi, [], [{ start: 0, end: 5, kind: 'strong' }]);
    const lines = splitStyledLines(segments, multi);
    expect(lines.map((l) => l.text)).toEqual(['ab', 'cd']);
    expect(lines[1]?.segments[0]?.text).toBe('cd');
    expect(lines[1]?.segments[0]?.inlines.map((s) => s.kind)).toEqual(['strong']);
  });
});
