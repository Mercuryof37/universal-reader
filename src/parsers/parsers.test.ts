import { describe, expect, it } from 'vitest';
import { MarkdownParser } from '@/parsers/markdownParser';
import { TextParser } from '@/parsers/textParser';

/** Node 环境没有 File 的完整实现；解析器只用到 name / size / text()，构造一个等价物 */
function fakeFile(name: string, content: string): File {
  return {
    name,
    size: content.length,
    text: async () => content,
    arrayBuffer: async () => new TextEncoder().encode(content).buffer,
  } as unknown as File;
}

describe('MarkdownParser', () => {
  const md = `# 第一章 雨幕

清晨的雨幕笼罩着整座城市。

## 小节

> 引用一句话。

- 列表项一
- 列表项二

\`\`\`ts
const a = 1;
\`\`\`
`;

  it('把各类节点拍平成线性块并保留层级', async () => {
    const doc = await new MarkdownParser().parse(fakeFile('rain.md', md));

    expect(doc.format).toBe('markdown');
    expect(doc.title).toBe('rain');

    const types = doc.blocks.map((b) => b.type);
    expect(types).toContain('heading');
    expect(types).toContain('paragraph');
    expect(types).toContain('quote');
    expect(types).toContain('list');
    expect(types).toContain('code');

    const h1 = doc.blocks.find((b) => b.type === 'heading');
    expect(h1?.metadata.level).toBe(1);
  });

  it('自动生成目录', async () => {
    const doc = await new MarkdownParser().parse(fakeFile('rain.md', md));
    expect(doc.toc.map((t) => t.title)).toEqual(['第一章 雨幕', '小节']);
  });

  it('列表项被合并成一个块，且不重复出现在段落里', async () => {
    const doc = await new MarkdownParser().parse(fakeFile('rain.md', md));
    const lists = doc.blocks.filter((b) => b.type === 'list');
    expect(lists).toHaveLength(1);
    expect(lists[0]?.content).toContain('列表项一');
    expect(lists[0]?.content).toContain('列表项二');

    // 关键回归点：列表项内部的段落若被重复处理，会多出只含"列表项一"的正文块
    const duplicated = doc.blocks.filter(
      (b) => b.type === 'paragraph' && b.content.trim() === '列表项一',
    );
    expect(duplicated).toHaveLength(0);
  });

  it('代码块保留原文与语言标记', async () => {
    const doc = await new MarkdownParser().parse(fakeFile('rain.md', md));
    const code = doc.blocks.find((b) => b.type === 'code');
    expect(code?.content).toBe('const a = 1;');
    expect(code?.metadata.codeLang).toBe('ts');
  });

  it('每个块都拿到 doc 前缀的唯一 id', async () => {
    const doc = await new MarkdownParser().parse(fakeFile('rain.md', md));
    const ids = doc.blocks.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.startsWith(`doc-${doc.id}-b`))).toBe(true);
  });

  it('统计字符数时忽略空白', async () => {
    const doc = await new MarkdownParser().parse(fakeFile('a.md', '一二三 四五六\n\n七八九'));
    expect(doc.metadata.charCount).toBe(9);
  });
});

describe('TextParser', () => {
  it('按空行分段', async () => {
    const doc = await new TextParser().parse(fakeFile('a.txt', '第一段。\n\n第二段。\n\n第三段。'));
    expect(doc.blocks).toHaveLength(3);
    expect(doc.blocks[0]?.content).toBe('第一段。');
  });

  it('没有空行但行数很多时按单行分段', async () => {
    const doc = await new TextParser().parse(fakeFile('a.txt', '第一行。\n第二行。\n第三行。'));
    expect(doc.blocks).toHaveLength(3);
  });

  it('识别章节标题', async () => {
    const doc = await new TextParser().parse(
      fakeFile('a.txt', '第一章 起点\n\n正文内容在这里。\n\n第二章 转折\n\n更多正文。'),
    );
    expect(doc.blocks[0]?.type).toBe('heading');
    expect(doc.toc).toHaveLength(2);
  });

  it('空文件抛出可读错误，而不是产出零块文档', async () => {
    // 早期实现会返回一个 blocks 为空、不报错的文档，
    // 界面上表现为"导入成功但一片空白"，这是最糟的失败方式。
    await expect(new TextParser().parse(fakeFile('empty.txt', ''))).rejects.toThrow(/没有可读文本/);
  });

  it('CRLF 换行被规范化', async () => {
    const doc = await new TextParser().parse(fakeFile('a.txt', '第一段。\r\n\r\n第二段。'));
    expect(doc.blocks).toHaveLength(2);
    expect(doc.blocks[1]?.content).toBe('第二段。');
  });
});
