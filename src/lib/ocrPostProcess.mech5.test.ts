/**
 * 机制 5 的**接线**测试：页级字符高度表是否真在建行之前建好、
 * 真的一路传到了逐词判定里。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么必须有这一组（单元测试证明不了接线）
 * ═══════════════════════════════════════════════════════════════
 *
 * `classifyCharsByGeometry(..., sizeTable)` 传对了，不等于
 * `ocrPostProcess` 真的把表建出来并传进去 —— 少一处传参，
 * 所有单元测试照样全绿（本项目已经出现过 5 次这种「假保护」）。
 *
 * 所以这里走**整条链路**（`ocrResultToBlocks`），并且用一对**只差一个词**
 * 的页面把两条路径都钉住：
 *
 *   · 两个词的页（有跨词证据）→ 表成立 → `∼` 被拒；
 *   · 一个词的页（没有跨词证据）→ 表为 `null` → `∼` **回来**了。
 *
 * 两条断言方向相反，任何一处接线断了都会有一条变红。
 */
import { describe, expect, it } from 'vitest';
import { attachCharsToWord, buildCharSizeTable } from '@/lib/ocrCharBoxes';
import { ocrResultToBlocks } from '@/lib/ocrPostProcess';
import type { InkMeasurement } from '@/lib/ocrCharBoxes';
import type { OcrChar, OcrWord } from '@/lib/ocrTypes';

const pageResult = (over: Partial<Parameters<typeof ocrResultToBlocks>[0]>) => ({
  pageNum: 1,
  words: [] as OcrWord[],
  avgConfidence: 0,
  ...over,
});

const w = (text: string, x: number, y: number, h: number, width = 40, confidence = 92): OcrWord => ({
  text,
  confidence,
  bbox: { x0: x, y0: y, x1: x + width, y1: y + h },
  fontSize: h,
});

/** 与判据同一坐标系的逐字符框：`[字符, y0, y1, 置信度]`（画布像素） */
type CharRow = [string, number, number, number];

function withChars(word: OcrWord, rows: CharRow[]): OcrWord {
  const chars: OcrChar[] = [];
  const measurements: Array<InkMeasurement | null> = [];
  const confidences: number[] = [];
  rows.forEach(([char, y0, y1, conf], i) => {
    chars.push({ char, x0: 100 + i * 10, y0, x1: 110 + i * 10, y1 });
    measurements.push({ y0, y1, h: y1 - y0 });
    confidences.push(conf);
  });
  attachCharsToWord(word, { chars, measurements, confidences });
  return word;
}

/** 基线 */
const B = 100;
const BODY = 20.4;

/**
 * 真实第 20 词里 `∼` 的那一组数字（逐字抄录）：
 * 墨迹高 **5.1**、抬高 **11.3**、置信度 **0.549** —— 三个量全部是导出的原值。
 * `X`、`Y`、`b` 用同页正文字高 20.4，`,` 用实测 8.2。
 */
const TILDE_ROWS: CharRow[] = [
  ['X', B - BODY, B, 0.98],
  [',', B - 8.2, B, 0.98],
  ['Y', B - BODY, B, 0.98],
  ['∼', B - 11.3 - 5.1, B - 11.3, 0.549],
  ['b', B - BODY, B, 0.98],
];

const tildeWord = () => withChars(w('X,Y∼b', 100, B - BODY, BODY, 50), TILDE_ROWS);

/** 第二个词只提供「页面上还有别的词」这件事（跨词证据） */
const fillerWord = (y: number) =>
  withChars(w('正文', 100, y, BODY, 40), [
    ['正', y, y + BODY, 0.98],
    ['文', y, y + BODY, 0.98],
  ]);

describe('机制 5 的接线（真实 `∼` 数值走整条链路）', () => {
  it('前提：这一对页面确实只差「有没有第二个词」', () => {
    const twoWords = [tildeWord(), fillerWord(B + 60)];
    const oneWord = [tildeWord()];

    // 两个词 → 表成立；一个词 → 表为 null（单词页上 H 退化成恒等式）
    expect(buildCharSizeTable(twoWords)).not.toBeNull();
    expect(buildCharSizeTable(oneWord)).toBeNull();
    // 表里 `∼` 的「全尺寸高度」就是它自己（5.1）→ 比值 1.0
    expect(buildCharSizeTable(twoWords)!.get('∼')).toBeCloseTo(5.1, 6);
  });

  it('⭐ 两个词的页：`∼` 被包成 `$^{∼}$` 的误判**不再出现**', () => {
    const content =
      ocrResultToBlocks(pageResult({ words: [tildeWord(), fillerWord(B + 60)] }))[0]?.content ?? '';
    // 一个字都不能丢
    expect(content.replace(/\s+/g, '')).toContain('X,Y∼b');
    expect(content).not.toContain('^{');
  });

  it('⭐ 反向对照：同一个词**单独成页**时误判会回来 —— 说明挡住它的确实是页级表', () => {
    const content = ocrResultToBlocks(pageResult({ words: [tildeWord()] }))[0]?.content ?? '';
    expect(content).toContain('$^{∼}$');
  });
});
