import { describe, expect, it } from 'vitest';
import { ocrResultToBlocks, ocrTextToBlocks } from '@/lib/ocrPostProcess';

/**
 * OCR 结果转内容块的测试。
 *
 * ═══════════════════════════════════════════════════════════════
 * 这组测试对应一次"把能用的结果丢掉"的故障
 * ═══════════════════════════════════════════════════════════════
 *
 * 现象：10 页 OCR 跑完，报"未能从任何页面中提取出文字"，
 * 但诊断信息里写着 **"纯文本长度合计：7058 字符"**。
 *
 * 也就是说 tesseract 明明识别出了七千多字，代码却因为拿不到词级坐标
 * （`data.words` 与 `data.blocks` 都为空）而返回了空数组。
 *
 * **把"能用的结果"当成"没有结果"是最不该发生的缺陷。**
 * 下面这些用例锁死"只要有文本就必须产出内容块"这条不变量。
 */

const pageResult = (over: Partial<Parameters<typeof ocrResultToBlocks>[0]>) => ({
  pageNum: 1,
  words: [],
  avgConfidence: 0,
  ...over,
});

describe('ocrTextToBlocks：纯文本兜底', () => {
  it('空文本返回空数组', () => {
    expect(ocrTextToBlocks('')).toEqual([]);
    expect(ocrTextToBlocks('   \n\n  \t ')).toEqual([]);
  });

  it('单段文本产出一个段落块（这是 7058 字被丢掉的那个场景）', () => {
    const text = '这是一段由 OCR 识别出的中文内容，长度足够成为完整的段落，不应该被当成空结果丢弃。';
    const blocks = ocrTextToBlocks(text);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe('paragraph');
    expect(blocks[0]?.content).toBe(text);
    // 内容一个字都不能丢
    expect(blocks[0]?.content.replace(/\s/g, '')).toBe(text.replace(/\s/g, ''));
  });

  it('空行分段', () => {
    const blocks = ocrTextToBlocks(
      '第一段的内容足够长，应当独立成为一块而不是被合并。\n\n第二段的内容同样足够长，也应当独立成块。',
    );
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.content).toContain('第一段');
    expect(blocks[1]?.content).toContain('第二段');
  });

  it('没有空行但行数很多时按单行分段', () => {
    const blocks = ocrTextToBlocks(
      '第一行的内容足够长，可以独立成为一段。\n第二行的内容足够长，可以独立成为一段。\n第三行的内容足够长，可以独立成为一段。',
    );
    expect(blocks).toHaveLength(3);
  });

  it('识别章节标题', () => {
    const blocks = ocrTextToBlocks('第一章 计算机系统漫游\n\n正文内容在这里展开说明。');
    expect(blocks[0]?.type).toBe('heading');
    expect(blocks[0]?.content).toBe('第一章 计算机系统漫游');
  });

  it('识别编号标题与全大写英文标题', () => {
    expect(ocrTextToBlocks('1.1 信息就是位加上下文')[0]?.type).toBe('heading');
    expect(ocrTextToBlocks('CHAPTER ONE')[0]?.type).toBe('heading');
  });

  it('以句号结尾的短行不当作标题', () => {
    const blocks = ocrTextToBlocks('这是一句完整的话。');
    expect(blocks[0]?.type).toBe('paragraph');
  });

  it('合并过短的碎片，避免一句话被拆成多段', () => {
    // 模拟 tesseract 按视觉行拆分的输出
    const blocks = ocrTextToBlocks(
      '这是被视觉行拆分后\n产生的一堆短碎片\n它们本应属于同一段',
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.content).toContain('这是被视觉行拆分后');
    expect(blocks[0]?.content).toContain('它们本应属于同一段');
  });

  it('中文碎片之间不插空格', () => {
    const blocks = ocrTextToBlocks('中文短行\n另一行中文');
    expect(blocks[0]?.content).toBe('中文短行另一行中文');
  });

  it('英文碎片之间插空格', () => {
    const blocks = ocrTextToBlocks('short line\nanother line');
    expect(blocks[0]?.content).toBe('short line another line');
  });

  it('上一块已以句末标点收尾时不再合并', () => {
    const blocks = ocrTextToBlocks('这是一个完整的句子。\n另起的内容');
    expect(blocks).toHaveLength(2);
  });
});

describe('ocrResultToBlocks：词级坐标缺失时必须走文本兜底', () => {
  it('无词但有文本时，仍产出内容块（本缺陷的核心断言）', () => {
    const blocks = ocrResultToBlocks(
      pageResult({ pageText: '识别出了内容，但没有词级坐标。' }),
    );

    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks[0]?.content).toContain('识别出了内容');
  });

  it('无词且无文本时才返回空', () => {
    expect(ocrResultToBlocks(pageResult({ pageText: '' }))).toEqual([]);
    expect(ocrResultToBlocks(pageResult({}))).toEqual([]);
  });

  it('有词时走坐标路径，不使用文本兜底', () => {
    const blocks = ocrResultToBlocks(
      pageResult({
        pageText: '这段文本应当被忽略，因为词级坐标可用。',
        words: [
          {
            text: '坐标路径',
            confidence: 95,
            bbox: { x0: 10, y0: 10, x1: 100, y1: 30 },
            fontSize: 20,
          },
        ],
      }),
    );

    expect(blocks[0]?.content).toBe('坐标路径');
  });

  it('多页累计的文本都能被保住（模拟 4 页 × 约 1764 字的场景）', () => {
    const pageText = '这是一页扫描书正文的内容，长度大约相当于真实页面的一段。'.repeat(40);
    let total = 0;
    for (let page = 1; page <= 4; page++) {
      const blocks = ocrResultToBlocks(pageResult({ pageNum: page, pageText }));
      total += blocks.reduce((n, b) => n + b.content.length, 0);
    }
    // 关键：不能是 0
    expect(total).toBeGreaterThan(1000);
  });
});
