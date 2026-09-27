import { describe, expect, it } from 'vitest';
import { extractWords } from '@/lib/ocrWordExtraction';

/**
 * 词提取的回归测试。
 *
 * ═══════════════════════════════════════════════════════════════
 * 这组测试对应一次真实的线上故障
 * ═══════════════════════════════════════════════════════════════
 *
 * 现象：整本扫描书 OCR 跑完，报"未能从任何页面中识别出文字
 * （共尝试 30 页，其中 0 页出错）"。
 *
 * 根因：tesseract.js v7 把词的输出从**平铺**改成了**嵌套**：
 * - v5：`data.words[]`
 * - v7：`data.blocks[].paragraphs[].lines[].words[]`
 *
 * 旧代码只读 `data.words`，在 v7 上恒为 undefined → 每页 0 个词 → 静默跳过。
 * 因此本模块必须**同时兼容两种结构**，下面的用例把这条要求钉死。
 */

const bbox = { x0: 10, y0: 20, x1: 60, y1: 40 };

/** v7 的默认形状：嵌套 */
function v7Shape(words: { text: string; confidence?: number }[]) {
  return {
    text: words.map((w) => w.text).join(' '),
    blocks: [
      {
        paragraphs: [
          {
            lines: [
              {
                words: words.map((w) => ({
                  text: w.text,
                  confidence: w.confidence ?? 90,
                  bbox,
                })),
              },
            ],
          },
        ],
      },
    ],
  };
}

/** v5 的形状：平铺 */
function v5Shape(words: { text: string; confidence?: number }[]) {
  return {
    text: words.map((w) => w.text).join(' '),
    words: words.map((w) => ({ text: w.text, confidence: w.confidence ?? 90, bbox })),
  };
}

describe('extractWords：v7 嵌套结构（本次故障的直接原因）', () => {
  it('能从 blocks.paragraphs.lines.words 里取到词', () => {
    const result = extractWords(v7Shape([{ text: '深入' }, { text: '理解' }, { text: '计算机' }]));

    expect(result.words).toHaveLength(3);
    expect(result.words.map((w) => w.text)).toEqual(['深入', '理解', '计算机']);
    expect(result.diagnostics.source).toBe('nested-blocks');
    expect(result.diagnostics.hasBlocks).toBe(true);
    expect(result.diagnostics.lines).toBe(1);
  });

  it('多块、多段、多行都能遍历到', () => {
    const result = extractWords({
      text: 'a b c d',
      blocks: [
        { paragraphs: [{ lines: [{ words: [{ text: 'a', confidence: 9, bbox }] }] }] },
        {
          paragraphs: [
            { lines: [{ words: [{ text: 'b', confidence: 9, bbox }] }] },
            {
              lines: [
                { words: [{ text: 'c', confidence: 9, bbox }] },
                { words: [{ text: 'd', confidence: 9, bbox }] },
              ],
            },
          ],
        },
      ],
    });

    expect(result.words.map((w) => w.text)).toEqual(['a', 'b', 'c', 'd']);
    expect(result.diagnostics.blocks).toBe(2);
    expect(result.diagnostics.paragraphs).toBe(3);
    expect(result.diagnostics.lines).toBe(4);
  });

  it('v7 形状下不再返回空数组（这就是 30 页全空的机制）', () => {
    const result = extractWords(v7Shape([{ text: '第一章' }]));
    // 旧实现读 data.words，在这个输入上恒为 []
    expect(result.words.length).toBeGreaterThan(0);
  });
});

describe('extractWords：v5 平铺结构仍然兼容', () => {
  it('优先使用平铺的 words', () => {
    const result = extractWords(v5Shape([{ text: 'hello' }, { text: 'world' }]));

    expect(result.words.map((w) => w.text)).toEqual(['hello', 'world']);
    expect(result.diagnostics.source).toBe('flat-words');
    expect(result.diagnostics.hasFlatWords).toBe(true);
  });

  it('平铺 words 存在但为空时，继续尝试嵌套结构', () => {
    const result = extractWords({ words: [], ...v7Shape([{ text: 'x' }]) });

    expect(result.words.map((w) => w.text)).toEqual(['x']);
    expect(result.diagnostics.source).toBe('nested-blocks');
  });
});

describe('extractWords：边界与畸形输入', () => {
  it('undefined / null 不抛错', () => {
    expect(extractWords(undefined).words).toEqual([]);
    expect(extractWords(null).words).toEqual([]);
    expect(extractWords(undefined).diagnostics.source).toBe('empty');
  });

  it('空对象返回 empty', () => {
    expect(extractWords({}).diagnostics.source).toBe('empty');
  });

  it('只有纯文本、没有词时返回 page-text-only（区别于彻底为空）', () => {
    const result = extractWords({ text: '识别出了文字但没有坐标信息' });
    expect(result.words).toEqual([]);
    expect(result.diagnostics.source).toBe('page-text-only');
    expect(result.pageText).toContain('识别出了文字');
  });

  it('blocks 为 null 不抛错（类型定义允许 null）', () => {
    const result = extractWords({ text: '', blocks: null });
    expect(result.words).toEqual([]);
    expect(result.diagnostics.hasBlocks).toBe(false);
  });

  it('层级中夹杂 null 与非法值时不崩溃', () => {
    const result = extractWords({
      text: 'ok',
      blocks: [
        null,
        { paragraphs: null },
        { paragraphs: [{ lines: null }] },
        { paragraphs: [{ lines: [{ words: null }] }] },
        { paragraphs: [{ lines: [{ words: [null, { text: 'ok', confidence: 1, bbox }] }] }] },
      ],
    });
    expect(result.words.map((w) => w.text)).toEqual(['ok']);
  });

  it('空白词被过滤并计入 skippedBlank', () => {
    const result = extractWords(v7Shape([{ text: '  ' }, { text: '有效' }, { text: '' }]));
    expect(result.words.map((w) => w.text)).toEqual(['有效']);
    expect(result.diagnostics.skippedBlank).toBe(2);
  });

  it('confidence 或 bbox 缺失时给出安全默认值', () => {
    const result = extractWords({
      text: 'x',
      blocks: [{ paragraphs: [{ lines: [{ words: [{ text: 'x' }] }] }] }],
    });
    expect(result.words[0]?.confidence).toBe(0);
    expect(result.words[0]?.bbox).toEqual({ x0: 0, y0: 0, x1: 0, y1: 0 });
    expect(result.words[0]?.fontSize).toBe(0);
  });

  it('fontSize 由 bbox 高度推导', () => {
    const result = extractWords(v7Shape([{ text: 'x' }]));
    expect(result.words[0]?.fontSize).toBe(20); // y1 - y0 = 40 - 20
  });
});
