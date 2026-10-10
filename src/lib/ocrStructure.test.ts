import { describe, expect, it } from 'vitest';
import { ocrResultToBlocks } from '@/lib/ocrPostProcess';
import {
  buildOcrStructure,
  OCR_STRUCTURE_CHAR_BUDGET,
  type OcrStructure,
} from '@/lib/ocrStructure';

/**
 * 「导出识别结构」的测试。
 *
 * ═══════════════════════════════════════════════════════════════
 * 这个出口为什么必须有，以及为什么它的测试也要认真写
 * ═══════════════════════════════════════════════════════════════
 *
 * 上下标（指数、下标）的判据是**纯几何**的：更小、更偏上/偏下、水平紧邻。
 * 而这些阈值此前只在**手工合成的坐标**上验证过。合成词框是我们自己想象的
 * 形状，真实识别器的输出完全可能不一样 —— 用户的实测结果正是如此：
 * 同一套判据在合成坐标上全绿，在真实扫描件上**完全不生效**。
 *
 * 于是需要一个出口，把这一页真实的词框与成行结果交给用户复制出来。
 * 它一旦出错（字段缺失、被裁得看不懂、体积失控），
 * 拿到数据的人就会得出错误结论 —— 那比没有数据更糟。
 * 所以下面逐条锁死：字段、行引用、体积上限、以及「不要回调就不构造」。
 */

const pageResult = (over: Partial<Parameters<typeof ocrResultToBlocks>[0]>) => ({
  pageNum: 1,
  words: [],
  avgConfidence: 0,
  ...over,
});

const w = (text: string, x: number, y: number, h: number, width = 30, confidence = 90) => ({
  text,
  confidence,
  bbox: { x0: x, y0: y, x1: x + width, y1: y + h },
  fontSize: h,
});

/** 抓取一次识别里交出来的结构 */
function capture(words: Parameters<typeof ocrResultToBlocks>[0]['words'], pageHeight?: number) {
  let captured: OcrStructure | undefined;
  const blocks = ocrResultToBlocks(pageResult({ words }), pageHeight, (s) => {
    captured = s;
  });
  if (!captured) throw new Error('结构没有被交出来');
  return { blocks, structure: captured };
}

describe('识别结构导出：字段与行引用', () => {
  it('只有文本、没有词级坐标时不导出结构（没有几何可看）', () => {
    let called = false;
    const blocks = ocrResultToBlocks(
      pageResult({ pageText: '这是一段只有文本、没有坐标的识别结果。' }),
      undefined,
      () => {
        called = true;
      },
    );

    expect(blocks.length).toBeGreaterThan(0);
    expect(called).toBe(false);
  });

  it('不传回调时不构造任何结构（导出不能给正常识别加成本）', () => {
    // 只要能正常返回内容块即可：这里真正验的是「第三个参数可以不传」
    const blocks = ocrResultToBlocks(
      pageResult({ words: [w('设', 40, 88, 20, 20), w('函数', 70, 88, 20, 40)] }),
    );

    expect(blocks).toHaveLength(1);
  });

  it('每个词都带文本、bbox、字高与由 bbox 算出的高度', () => {
    const { structure } = capture([w('设', 40, 88, 20, 20), w('函数', 70, 90, 18, 40)]);

    expect(structure.kind).toBe('universal-reader/ocr-structure');
    expect(structure.pageNum).toBe(1);
    expect(structure.wordsTotal).toBe(2);
    expect(structure.words).toHaveLength(2);

    const first = structure.words[0];
    expect(first?.text).toBe('设');
    expect(first?.bbox).toEqual([40, 88, 60, 108]);
    expect(first?.fontSize).toBe(20);
    // 识别器的 fontSize 与词框高度必须能对上；
    // 对不上时这两个字段都会出现在 JSON 里，供人核对
    expect(first?.height).toBe(20);
    expect(first?.centerY).toBe(98);
    expect(first?.i).toBe(0);
  });

  it('成行结果的词下标能指回词表，且顺序就是拼成文本的顺序', () => {
    const { structure } = capture([w('丙', 180, 200, 20, 20), w('甲', 40, 200, 20, 20)]);

    expect(structure.linesTotal).toBe(1);
    const line = structure.lines[0];
    expect(line?.text).toBe('甲丙');
    // 词序按 x 排：甲（下标 1）在前
    expect(line?.wordIndices).toEqual([1, 0]);
    expect(line?.wordIndices.map((i) => structure.words[i]?.text)).toEqual(['甲', '丙']);
  });

  it('行里带上纵向/横向跨度与是否还原出上下标', () => {
    // ⚠️ 这组坐标是**刻意**选的：`e` 的框必须够宽（x0=120 → x1=154），
    // 否则 `-(x+y)` 与它的水平间隙会超过判据上限（较小字高的 0.6 倍 = 7.8px），
    // 指数就绑不上基字、单独成行 —— 实测用 12px 宽的 `e` 正是这样，
    // 结果这条用例验到的其实是「绑不上」的反面场景。
    const { structure } = capture([
      w('设', 40, 88, 20, 20),
      w('函数', 70, 88, 20, 40),
      w('e', 120, 88, 20, 34),
      w('-(x+y)', 154, 70, 13, 60),
    ]);

    const line = structure.lines[0];
    expect(structure.linesTotal).toBe(1);
    expect(line?.hasScripts).toBe(true);
    // 跨度要覆盖指数那一块（它比基字更高）
    expect(line?.yRange[0]).toBeLessThanOrEqual(70);
    expect(line?.xRange[1]).toBeGreaterThanOrEqual(214);
  });

  it('可疑小字（明显更矮的词）带上高度比例、中心偏移与到左侧更高词的间隙', () => {
    const { structure } = capture([
      w('设', 40, 88, 20, 20),
      w('函数', 70, 88, 20, 40),
      w('e', 120, 88, 20, 34),
      w('-(x+y)', 154, 70, 13, 60),
    ]);

    const line = structure.lines[0];
    // 只有那个 13px 的指数算「可疑小字」（其余都是 20px）
    expect(line?.stats).toHaveLength(1);
    const stat = line?.stats[0];
    expect(stat?.text).toBe('-(x+y)');
    expect(stat?.height).toBe(13);
    // 13 / 20 = 0.65，但导出会把它舍入到 1 位小数（`Math.round(6.5)` 进到 7）
    // → 0.7。断言用 toBeCloseTo 而不是精确值：这里要锁的是量级，
    // 而「1 位小数」是刻意的省体积手段，不该被这条用例禁止。
    expect(stat?.heightRatio).toBeCloseTo(0.65, 1);
    // 指数在基字上方 → 中心偏移为负（这正是「上标」的定义）
    expect(stat?.centerShift).toBeLessThan(0);
    // 与左侧更高词紧贴（间隙 0）—— 上下标总是紧贴基字
    expect(stat?.gapToHigherLeft).toBe(0);
  });

  it('字号一致的整行不产生任何「可疑小字」', () => {
    const text = '这是一段普通的识别结果';
    const words = [...text].map((ch, i) => w(ch, 40 + i * 20, 88, 20, 20));
    const { structure } = capture(words);

    expect(structure.lines[0]?.stats).toEqual([]);
  });

  it('导出里包含本次**实际生效**的阈值（否则没人知道 0.9 指的是什么）', () => {
    const { structure } = capture([w('设', 40, 88, 20, 20), w('函数', 70, 88, 20, 40)]);

    // 与 ocrPostProcess 里的常量一致（数值改了这里会红，是刻意的）
    expect(structure.thresholds).toEqual({
      scriptMaxFontRatio: 0.9,
      scriptSuperShift: 0.25,
      scriptSubShift: 0.18,
      scriptFragmentGap: 0.6,
      scriptSuperBand: 1.5,
      scriptSubBand: 1.2,
      sameLineTolerance: 5,
      baselineMinDriftRatio: 1,
      baselineMaxResidualRatio: 0.35,
      tiltJoinGapRatio: 1.5,
    });
  });

  it('最终块一并给出来，并标出哪一块含行内公式', () => {
    const { blocks, structure } = capture([
      w('设', 40, 88, 20, 20),
      w('函数', 70, 88, 20, 40),
      w('e', 120, 88, 20, 34),
      w('-(x+y)', 154, 70, 13, 60),
    ]);

    expect(structure.blocks).toHaveLength(blocks.length);
    expect(structure.blocks[0]?.hasInlineMath).toBe(true);
    expect(structure.blocks[0]?.content).toContain('$^{-(x+y)}$');
  });

  it('带回调与不带回调得到的内容块完全一致（导出纯属旁路）', () => {
    // 导出是诊断能力，**不能改变识别结果**。这条用例锁住它：
    // 一旦哪天有人在 `onStructure` 分支里顺手改了行/词，这里会立刻红。
    const words = [
      w('设', 40, 88, 20, 20),
      w('函数', 70, 88, 20, 40),
      w('e', 120, 88, 20, 34),
      w('-(x+y)', 154, 70, 13, 60),
      w('17. 求X的分布律', 40, 200, 20, 200),
    ];

    const withCallback = ocrResultToBlocks(pageResult({ words }), undefined, () => {});
    const withoutCallback = ocrResultToBlocks(pageResult({ words }));

    expect(withCallback).toEqual(withoutCallback);
  });

  it('页高（画布高度）如实带上，判页眉页脚靠的就是它', () => {
    const { structure } = capture([w('设', 40, 88, 20, 20), w('函数', 70, 88, 20, 40)], 2339);
    expect(structure.canvasHeight).toBe(2339);
  });

  it('导出的 JSON 可被 JSON.parse 完整读回（这是它唯一的用途）', () => {
    const { structure } = capture([w('设', 40, 88, 20, 20), w('函数', 70, 88, 20, 40)]);
    const round = JSON.parse(JSON.stringify(structure)) as OcrStructure;

    expect(round.words).toHaveLength(2);
    expect(round.lines[0]?.wordIndices).toEqual([0, 1]);
  });
});

describe('识别结构导出：体积控制', () => {
  /** 造一页词：每个词都带一段文本，便于把体积顶上去 */
  const manyWords = (count: number) =>
    Array.from({ length: count }, (_, i) =>
      w(`第${i}个识别出来的词`, 40 + (i % 8) * 120, 200 + Math.floor(i / 8) * 24, 20, 110),
    );

  it('默认上限内不会丢数据，且如实标注没有丢', () => {
    const { structure } = capture(manyWords(40));

    expect(structure.wordsTotal).toBe(40);
    expect(structure.words).toHaveLength(40);
    expect(structure.truncated.wordsDropped).toBe(0);
    expect(structure.truncated.linesDropped).toBe(0);
    expect(structure.truncated.charBudget).toBe(OCR_STRUCTURE_CHAR_BUDGET);
  });

  it('词很多时按上限截断，并如实报告丢了多少（绝不悄悄裁）', () => {
    const { structure } = capture(manyWords(4000));

    expect(structure.wordsTotal).toBe(4000);
    expect(structure.words.length).toBeLessThan(4000);
    expect(structure.truncated.wordsDropped).toBe(4000 - structure.words.length);
    // 关键：被裁之后**仍然是一份能读懂的结构** ——
    // 阈值、正文字高、最终块、截断说明一个都不能少
    expect(structure.thresholds.scriptMaxFontRatio).toBe(0.9);
    expect(structure.dominantFontSize).toBeGreaterThan(0);
    expect(structure.blocks.length).toBeGreaterThan(0);
  });

  it('体积不会超过预算（字符数），也不会留下被裁坏的行', () => {
    const { structure } = capture(manyWords(4000));

    expect(JSON.stringify(structure).length).toBeLessThan(OCR_STRUCTURE_CHAR_BUDGET * 1.1);
    // 每一行的词下标都必须仍能指回词表，否则导出的是坏数据
    for (const line of structure.lines) {
      for (const i of line.wordIndices) {
        expect(structure.words[i]).toBeDefined();
      }
    }
  });

  it('预算小到装不下任何词时，仍然给出阈值与最终块（定阈值不能因超限而失效）', () => {
    const structure = buildOcrStructure({
      pageNum: 7,
      dominantFontSize: 20,
      words: manyWords(50),
      lines: [],
      blocks: [
        { type: 'paragraph', content: '一段正文', translations: {}, metadata: {} },
      ],
      charBudget: 10,
    });

    expect(structure.pageNum).toBe(7);
    expect(structure.wordsTotal).toBe(50);
    expect(structure.words).toEqual([]);
    expect(structure.truncated.wordsDropped).toBe(50);
    expect(structure.dominantFontSize).toBe(20);
    expect(structure.blocks[0]?.content).toBe('一段正文');
  });

  it('空页不炸：没有词、没有行时仍然产出可解析的结构', () => {
    const structure = buildOcrStructure({
      pageNum: 3,
      dominantFontSize: 0,
      words: [],
      lines: [],
      blocks: [],
    });

    expect(structure.words).toEqual([]);
    expect(structure.lines).toEqual([]);
    expect(structure.wordsTotal).toBe(0);
    expect(JSON.parse(JSON.stringify(structure)).pageNum).toBe(3);
  });
});
