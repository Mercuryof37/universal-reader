import { describe, expect, it } from 'vitest';
import { MarkdownParser } from '@/parsers/markdownParser';
import { buildHeadingAnchors, findHeadingIndex, normalizeAnchor } from '@/lib/utils';
import type { ContentBlock, DocDocument } from '@/types/content';

/** Node 环境没有 File 的完整实现；解析器只用到 name / size / text()，构造一个等价物 */
function fakeFile(name: string, content: string): File {
  return {
    name,
    size: content.length,
    text: async () => content,
    arrayBuffer: async () => new TextEncoder().encode(content).buffer,
  } as unknown as File;
}

async function parse(md: string, name = 'doc.md'): Promise<DocDocument> {
  return new MarkdownParser().parse(fakeFile(name, md));
}

function blockOf(blocks: ContentBlock[], type: ContentBlock['type'], contains?: string) {
  return blocks.find((b) => b.type === type && (contains === undefined || b.content.includes(contains)));
}

/** 取某类行内片段覆盖的原文文本，用来断言偏移是否精确 */
function spanTexts(block: ContentBlock, kind: string): string[] {
  return (block.metadata.inline ?? [])
    .filter((s) => s.kind === kind)
    .map((s) => block.content.slice(s.start, s.end));
}

const md = `# 高斯分布与希腊字母

## 行内希腊字母

Unicode 形式：均值 μ、标准差 σ、α β γ λ θ。

LaTeX 形式行内：$\\mu$、$\\sigma$、$\\alpha$。

$$
f(x) = \\frac{1}{\\sigma\\sqrt{2\\pi}} e^{-\\frac{(x-\\mu)^2}{2\\sigma^2}}
$$

## 行内格式

**加粗**、*斜体*、***粗斜***、~~删除线~~、\`行内代码\`、==高亮==。

带链接：[内部链接](#行内格式) 与 [外部链接](https://example.com)。

## 表格

| 名称 | 符号 | 值 |
| --- | :---: | ---: |
| 均值 | μ | 3.2 |
| 标准差 | σ | 1.1 |

## 任务列表

- [x] 已完成项
- [ ] 未完成项

## Callout

> [!note] 提示
> 这是一条提示。
>
> 第二段。

## 引用

> 普通引用第一段。
>
> 普通引用第二段。

---

段尾。
`;

describe('MarkdownParser 结构化块', () => {
  it('表格不再整块消失，且行 / 单元格的拼接规则固定', async () => {
    const doc = await parse(md);
    const table = blockOf(doc.blocks, 'table');
    expect(table).toBeDefined();
    // 回归点：早期实现没有 table 分支，整张表在拍平时被静默丢弃
    expect(table!.content).toBe('名称 符号 值\n均值 μ 3.2\n标准差 σ 1.1');
    expect(table!.metadata.table?.rows).toEqual([
      ['名称', '符号', '值'],
      ['均值', 'μ', '3.2'],
      ['标准差', 'σ', '1.1'],
    ]);
    expect(table!.metadata.table?.align).toEqual([null, 'center', 'right']);
  });

  it('任务列表保留勾选状态，且 content 里不含语法符号', async () => {
    const doc = await parse(md);
    const list = blockOf(doc.blocks, 'list', '已完成项');
    expect(list).toBeDefined();
    expect(list!.content).toBe('已完成项\n未完成项');
    expect(list!.metadata.list?.items).toEqual([
      { text: '已完成项', indent: 0, marker: '•', checked: true },
      { text: '未完成项', indent: 0, marker: '•', checked: false },
    ]);
  });

  it('普通列表项 checked 为 null，嵌套列表记录 indent 与不同符号', async () => {
    const doc = await parse('- 一级\n  - 二级\n\n1. 甲\n2. 乙\n');
    const [ul, ol] = doc.blocks.filter((b) => b.type === 'list');
    expect(ul!.metadata.list?.items).toEqual([
      { text: '一级', indent: 0, marker: '•', checked: null },
      { text: '二级', indent: 1, marker: '◦', checked: null },
    ]);
    expect(ul!.content).toBe('一级\n二级');
    expect(ol!.metadata.list).toEqual({
      ordered: true,
      items: [
        { text: '甲', indent: 0, marker: '1.', checked: null },
        { text: '乙', indent: 0, marker: '2.', checked: null },
      ],
    });
  });

  it('Callout 识别类型与标题，正文多段按行分隔', async () => {
    const doc = await parse(md);
    const callout = blockOf(doc.blocks, 'callout');
    expect(callout).toBeDefined();
    expect(callout!.metadata.callout).toEqual({ type: 'note', title: '提示' });
    expect(callout!.content).toBe('提示\n这是一条提示。\n第二段。');
  });

  it('未写标题的 Callout 用类型名兜底，不至于输出空标题行', async () => {
    const doc = await parse('> [!warning]\n> 小心地滑。\n');
    const callout = doc.blocks.find((b) => b.type === 'callout');
    expect(callout!.metadata.callout).toEqual({ type: 'warning', title: 'Warning' });
    expect(callout!.content).toBe('Warning\n小心地滑。');
  });

  it('普通引用按段落分行，不再把两段挤成一段', async () => {
    const doc = await parse(md);
    const quote = blockOf(doc.blocks, 'quote');
    expect(quote!.content).toBe('普通引用第一段。\n普通引用第二段。');
  });

  it('分隔线成为独立块，前后正文都还在', async () => {
    const doc = await parse(md);
    const dividerIndex = doc.blocks.findIndex((b) => b.type === 'divider');
    expect(dividerIndex).toBeGreaterThan(-1);
    expect(doc.blocks[dividerIndex + 1]?.content).toBe('段尾。');
  });
});

describe('MarkdownParser 行内格式', () => {
  it('粗体 / 斜体 / 删除线 / 代码 / 高亮的偏移精确指向原文', async () => {
    const doc = await parse(md);
    const p = blockOf(doc.blocks, 'paragraph', '加粗');
    expect(p!.content).toBe('加粗、斜体、粗斜、删除线、行内代码、高亮。');
    expect(spanTexts(p!, 'strong').sort()).toEqual(['加粗', '粗斜']);
    expect(spanTexts(p!, 'emphasis').sort()).toEqual(['斜体', '粗斜']);
    expect(spanTexts(p!, 'del')).toEqual(['删除线']);
    expect(spanTexts(p!, 'code')).toEqual(['行内代码']);
    expect(spanTexts(p!, 'mark')).toEqual(['高亮']);
  });

  it('链接保留 href，正文里只剩链接文字', async () => {
    const doc = await parse(md);
    const p = blockOf(doc.blocks, 'paragraph', '内部链接');
    expect(p!.content).toBe('带链接：内部链接 与 外部链接。');
    const links = (p!.metadata.inline ?? []).filter((s) => s.kind === 'link');
    expect(links.map((s) => [p!.content.slice(s.start, s.end), s.href])).toEqual([
      ['内部链接', '#行内格式'],
      ['外部链接', 'https://example.com'],
    ]);
  });

  it('文内链接在目录锚点里找得到目标标题', async () => {
    const doc = await parse(md);
    const anchors = buildHeadingAnchors(doc.blocks);
    expect(anchors.has(normalizeAnchor('#行内格式'))).toBe(true);
    const index = findHeadingIndex(doc.blocks, '#行内格式');
    expect(doc.blocks[index]?.type).toBe('heading');
    expect(doc.blocks[index]?.content).toBe('行内格式');
  });

  it('[[#标题|别名]] 可跳转，[[其他笔记]] 标记为不可跳转', async () => {
    const doc = await parse('见 [[#行内格式|那一节]] 与 [[其他笔记]]。\n\n## 行内格式\n');
    const p = doc.blocks[0]!;
    expect(p.content).toBe('见 那一节 与 其他笔记。');
    const wikis = (p.metadata.inline ?? []).filter((s) => s.kind === 'wikilink');
    expect(wikis.map((s) => [p.content.slice(s.start, s.end), s.href])).toEqual([
      ['那一节', '#行内格式'],
      ['其他笔记', ''],
    ]);
  });

  it('标题始终单行化，<br> 折成空格且不破坏偏移', async () => {
    const doc = await parse('# 行一<br>行二\n');
    const h = doc.blocks[0]!;
    expect(h.type).toBe('heading');
    expect(h.content).toBe('行一 行二');
  });

  it('Markdown 段落不参与合并，两个短段仍是两块', async () => {
    const doc = await parse('第一行没有句号\n\n第二行也没有\n');
    expect(doc.blocks.map((b) => b.content)).toEqual(['第一行没有句号', '第二行也没有']);
  });
});

describe('MarkdownParser 公式与希腊字母', () => {
  it('Unicode 希腊字母原样保留在正文里', async () => {
    const doc = await parse(md);
    const p = blockOf(doc.blocks, 'paragraph', 'Unicode 形式');
    expect(p!.content).toBe('Unicode 形式：均值 μ、标准差 σ、α β γ λ θ。');
    expect(p!.metadata.inline).toEqual([]);
  });

  it('$\\mu$ 形式被标记为行内公式，原文（含 $）留在 content 里', async () => {
    const doc = await parse(md);
    const p = blockOf(doc.blocks, 'paragraph', 'LaTeX 形式行内');
    expect(p!.content).toBe('LaTeX 形式行内：$\\mu$、$\\sigma$、$\\alpha$。');
    expect(spanTexts(p!, 'math')).toEqual(['$\\mu$', '$\\sigma$', '$\\alpha$']);
    expect(p!.metadata.hasInlineMath).toBe(true);
  });

  it('行间公式成为 math 块', async () => {
    const doc = await parse(md);
    const math = blockOf(doc.blocks, 'math');
    expect(math!.content).toContain('\\frac{1}{\\sigma\\sqrt{2\\pi}}');
  });

  it('\\(...\\) 与 \\[...\\] 定界符被改写（Obsidian 的 MathJax 同样两种都认）', async () => {
    const doc = await parse('设 \\(\\alpha\\) 为系数。\n\n\\[ E = mc^2 \\]\n');
    const p = doc.blocks[0]!;
    expect(p.content).toBe('设 $\\alpha$ 为系数。');
    expect(spanTexts(p, 'math')).toEqual(['$\\alpha$']);
    const math = blockOf(doc.blocks, 'math');
    expect(math?.content).toBe('E = mc^2');
  });

  it('围栏代码块与行内代码里的 \\( 不被改写', async () => {
    const doc = await parse('```\n\\(\\alpha\\)\n```\n\n行内 `\\(\\beta\\)` 保持字面量。\n');
    const code = blockOf(doc.blocks, 'code');
    expect(code!.content).toBe('\\(\\alpha\\)');
    const p = blockOf(doc.blocks, 'paragraph');
    expect(p!.content).toBe('行内 \\(\\beta\\) 保持字面量。');
    expect(spanTexts(p!, 'code')).toEqual(['\\(\\beta\\)']);
  });

  it('单行 $$...$$ 也算行间公式，而不是行内公式', async () => {
    const doc = await parse('$$ x^2 + y^2 = z^2 $$\n');
    expect(doc.blocks[0]?.type).toBe('math');
    expect(doc.blocks[0]?.content).toBe('x^2 + y^2 = z^2');
  });
});

describe('MarkdownParser 元信息', () => {
  it('frontmatter 不进正文，title 用作文档标题', async () => {
    const doc = await parse('---\ntitle: 我的笔记\ntags: [a, b]\n---\n\n正文。\n', 'note.md');
    expect(doc.title).toBe('我的笔记');
    expect(doc.blocks.map((b) => b.content)).toEqual(['正文。']);
    expect(doc.blocks.some((b) => b.type === 'divider')).toBe(false);
  });

  it('脚注引用与定义都被保留', async () => {
    const doc = await parse('正文引用[^a]。\n\n[^a]: 脚注内容。\n');
    const p = doc.blocks[0]!;
    expect(p.content).toBe('正文引用[1]。');
    expect(spanTexts(p, 'fnref')).toEqual(['[1]']);
    const def = doc.blocks.find((b) => b.metadata.footnote === 1);
    expect(def?.content).toBe('[1] 脚注内容。');
  });

  it('每个块都拿到 doc 前缀的唯一 id', async () => {
    const doc = await parse(md);
    const ids = doc.blocks.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.startsWith(`doc-${doc.id}-b`))).toBe(true);
  });
});
