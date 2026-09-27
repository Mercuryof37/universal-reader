import { describe, expect, it } from 'vitest';
import { buildPdf } from '@/parsers/__fixtures__/makePdf';
import { clusterIntoParagraphs, splitLongText } from '@/parsers/pdfParser';

/**
 * PDF 解析的端到端验证。
 *
 * 这里用的是合成 PDF（见 __fixtures__/makePdf.ts），不是真实扫描件，
 * 目的是把"片段 → 行 → 段"这条重建链路的正确性钉死。
 * 真实文件的排版怪癖（双栏、页眉页脚、表格）仍需人工回归，见 README 已知限制。
 */

function fakePdfFile(name: string, bytes: Uint8Array): File {
  return {
    name,
    size: bytes.byteLength,
    text: async () => '',
    arrayBuffer: async () => bytes.buffer.slice(0) as ArrayBuffer,
  } as unknown as File;
}

describe('clusterIntoParagraphs（不依赖 pdf.js 的纯函数）', () => {
  const item = (str: string, x: number, y: number, height = 12) => ({
    str,
    transform: [height, 0, 0, height, x, y],
    width: str.length * height * 0.5,
    height,
  });

  // 真实排版的基线间隔：12pt 字体配 1.2 倍行距 ≈ 每行下移 14.4pt。
  // 夹具必须用这个量级，否则测出的行为与真实文档无关。
  const LINE_STEP = 14.4;

  it('同一 y 坐标的片段合并为一行，并按 x 排序', () => {
    // 刻意打乱输入顺序：PDF 里文字片段的存储顺序不保证等于阅读顺序
    const paragraphs = clusterIntoParagraphs([item('World', 100, 700), item('Hello ', 50, 700)]);
    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0]?.text).toBe('Hello World');
  });

  it('正常行距的连续多行合并为同一段（回归：曾把每行都切成独立段落）', () => {
    const paragraphs = clusterIntoParagraphs([
      item('这是第一行的内容，', 50, 700),
      item('这是第二行紧接其后，', 50, 700 - LINE_STEP),
      item('这是第三行。', 50, 700 - LINE_STEP * 2),
    ]);
    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0]?.lines).toBe(3);
  });

  it('行距明显变大时切分为新段落', () => {
    const paragraphs = clusterIntoParagraphs([
      item('第一段第一行', 50, 700),
      item('第一段第二行', 50, 700 - LINE_STEP),
      // 段间距远大于行距
      item('第二段的第一行', 50, 700 - LINE_STEP * 2 - 24),
    ]);
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]?.text).toContain('第一段第一行');
    expect(paragraphs[1]?.text).toContain('第二段的第一行');
  });

  it('字号突变时切分为新段落', () => {
    const paragraphs = clusterIntoParagraphs([
      item('正文内容', 50, 700, 12),
      item('大标题', 50, 700 - LINE_STEP, 22),
    ]);
    expect(paragraphs).toHaveLength(2);
  });

  it('插入顺序不影响结果：输出按 y 坐标降序（PDF 原点在左下角）', () => {
    // 关键点是"输入的先后顺序不等于阅读顺序"。
    // 这里用两个相距很远的块，确保它们不会被合并，从而能逐块验证排序。
    const paragraphs = clusterIntoParagraphs([
      item('最后一段。', 50, 200),
      item('最前一段。', 50, 700),
      item('中间一段。', 50, 450),
    ]);
    expect(paragraphs.map((p) => p.text)).toEqual(['最前一段。', '中间一段。', '最后一段。']);
  });

  it('中文行之间不插入空格', () => {
    const paragraphs = clusterIntoParagraphs([
      item('这是中文的一行', 50, 700),
      item('这是紧接的下一行', 50, 700 - LINE_STEP),
    ]);
    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0]?.text).toBe('这是中文的一行这是紧接的下一行');
  });

  it('英文行之间插入空格', () => {
    const paragraphs = clusterIntoParagraphs([
      item('This sentence continues', 50, 700),
      item('on the next line.', 50, 700 - LINE_STEP),
    ]);
    expect(paragraphs[0]?.text).toBe('This sentence continues on the next line.');
  });

  it('空数组不抛错', () => {
    expect(clusterIntoParagraphs([])).toEqual([]);
  });
});

describe('splitLongText', () => {
  it('按句末标点切分且不丢字', () => {
    const text = '第一句。第二句！第三句？第四句。'.repeat(10);
    const parts = splitLongText(text, 40);
    expect(parts.join('')).toBe(text);
    expect(parts.every((p) => p.length <= 40)).toBe(true);
  });
});

describe('PdfParser（端到端，需要 pdf.js 真正解析）', () => {
  it('从合成 PDF 中还原出文本块与元信息', async () => {
    const bytes = buildPdf(
      [
        {
          lines: [
            { text: 'Chapter One', x: 72, y: 720, size: 20 },
            { text: 'This is the first paragraph of the document.', x: 72, y: 680 },
            { text: 'It continues on a second line here.', x: 72, y: 665.6 },
          ],
        },
        {
          lines: [{ text: 'Second page content.', x: 72, y: 720 }],
        },
      ],
      { title: 'Synthetic Reader Fixture', author: 'Test Author' },
    );

    const { PdfParser } = await import('@/parsers/pdfParser');
    const doc = await new PdfParser().parse(fakePdfFile('fixture.pdf', bytes));

    expect(doc.format).toBe('pdf');
    expect(doc.metadata.author).toBe('Test Author');
    expect(doc.blocks.length).toBeGreaterThan(0);

    const allText = doc.blocks.map((b) => b.content).join(' ');
    expect(allText).toContain('Chapter One');
    expect(allText).toContain('first paragraph');
    expect(allText).toContain('Second page content');

    // 页码必须落在块上，否则后续无法做"回跳原页"
    const pages = new Set(doc.blocks.map((b) => b.metadata.pageNumber));
    expect(pages.has(1)).toBe(true);
    expect(pages.has(2)).toBe(true);
  });

  it('大字号短文本被识别为标题', async () => {
    const bytes = buildPdf([
      {
        lines: [
          { text: 'Big Heading', x: 72, y: 720, size: 24 },
          { text: 'Normal body text that is clearly longer than the heading line.', x: 72, y: 680 },
        ],
      },
    ]);

    const { PdfParser } = await import('@/parsers/pdfParser');
    const doc = await new PdfParser().parse(fakePdfFile('h.pdf', bytes));

    const heading = doc.blocks.find((b) => b.type === 'heading');
    expect(heading?.content).toBe('Big Heading');
    expect(doc.toc.length).toBeGreaterThan(0);
  });

  it('没有文字层的 PDF 必须明确报错，而不是产出空文档', async () => {
    const bytes = buildPdf([{ lines: [], blank: true }]);

    const { PdfParser } = await import('@/parsers/pdfParser');
    await expect(new PdfParser().parse(fakePdfFile('scan.pdf', bytes))).rejects.toThrow(
      /文字层|OCR/,
    );
  });

  it('损坏的文件给出可读错误而不是原始堆栈', async () => {
    const garbage = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x39, 0x39, 0x00, 0x01, 0x02]);

    const { PdfParser } = await import('@/parsers/pdfParser');
    await expect(new PdfParser().parse(fakePdfFile('broken.pdf', garbage))).rejects.toThrow(
      /PDF 打开失败/,
    );
  });
});

describe('文字层探测（回归：用户报告的"导入后内容为空"）', () => {
  it('有文字层的 PDF 解析后 blocks 不能为空', async () => {
    const bytes = buildPdf([{ lines: [{ text: 'only one line', x: 72, y: 720 }] }]);
    const { PdfParser } = await import('@/parsers/pdfParser');
    const doc = await new PdfParser().parse(fakePdfFile('one.pdf', bytes));

    // 这条断言存在的意义：早期实现在文字层为空时返回了 blocks: []，
    // 界面就会表现为"导入成功但一片空白"，且不报任何错。
    expect(doc.blocks.length).toBeGreaterThan(0);
    expect(doc.blocks[0]?.content.trim().length).toBeGreaterThan(0);
  });
});
