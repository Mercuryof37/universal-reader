import { describe, expect, it } from 'vitest';
import katex from 'katex';
import type { OcrWord } from '@/lib/ocrTypes';
import { planPiecewise, type PiecewiseLineLike } from '@/lib/ocrPiecewise';
import { ocrResultToBlocks } from '@/lib/ocrPostProcess';

/**
 * 跨行大括号分段函数重组的测试。
 *
 * ═══════════════════════════════════════════════════════════════
 * 数据来源：真实扫描件（不是手工编的坐标）
 * ═══════════════════════════════════════════════════════════════
 *
 * 下面 `pageWords` 里的每个词都是用户那份《习题5-10月19日交(1).pdf》
 * 第 1 页（画布 1667×2223）**识别结果的逐字复制** —— 文本、置信度、
 * 字号、词框坐标一个没改（来自浏览器 E2E 抓取的 e2e-dump）。
 *
 * 这一页同时包含四处要重组的分段函数（20 题的 f_X / f_Y、21 题的 Z、
 * 28 题的 f_z，以及 24 题「大括号被误读成 `≥`」的替身构造）和一批
 * **必须被排除**的近似物：
 *  · 第 17 题的长句也含 `{`（`P {X = x …}`）但框高 43 < 36×1.35 → 拒；
 *  · 第 24 题公式词上方的那段假文本（`.议随机变量(A，1)的概率出度为`）
 *    现在由识别层的裁边碎片判据在源头拦掉；这里保留它作为**邻居噪声
 *    的健壮性用例** —— 它既不能成为锚点，也不能被并进分支；
 *  · 同页散文（`其中λ>0，…`、`验证随机变量 Z = …`）在锚点邻近，
 *    但长度/汉字连串判据把它们挡在分支之外 —— 不能把正文并进公式。
 *
 * 这些用例锁死两条不变量：
 *  ① 判据成立 → 输出带 `\begin{cases}` 的 math 块（跨行大括号真的显示出来）；
 *  ② 判据不成立 → **一个字都不动**（原文照旧成段，宁可漏也不毁）。
 */

const w = (
  text: string,
  confidence: number,
  fontSize: number,
  b: [number, number, number, number],
): OcrWord => ({
  text,
  confidence,
  fontSize,
  bbox: { x0: b[0], y0: b[1], x1: b[2], y1: b[3] },
});

// ── 真实词表（索引与识别结果一致，i0…i26）─────────────────────────
const W = [
  w('概率论与数理统计习题5', 100, 36, [657, 44, 1010, 80]), // 页眉（应被滤掉）
  w(
    '17. 设 随机 变量 (X ,Y) 具有 分 布律 P {X = x ,Y = y} = p² (1 − p )x+y−2 ,0 < p < 1,x ,y 均为 正',
    90,
    43,
    [225, 212, 1604, 255],
  ),
  w('整数，问X，Y是否相互独立.', 99, 36, [147, 266, 573, 302]),
  w('20. 设 X和Y是相互独立的随机变量，其概率密度分别为', 97, 42, [225, 418, 1050, 460]),
  w('(λe−x, x>0', 88, 28, [400, 479, 742, 503]),
  w('(µe−^, y>0', 88, 28, [803, 479, 1085, 503]),
  w('fx(x) = { 0, x ≤ 0 fx(y) = { 0, y≤ 0', 92, 56, [297, 503, 1085, 555]),
  w('其中λ>0，μ>0是常数.引入随机变量', 97, 41, [162, 568, 752, 609]),
  w('_(1，当 X≤Y', 87, 32, [301, 622, 613, 650]),
  w('Z = {0, 当X > Y', 86, 56, [293, 650, 613, 702]),
  w('(1） 求 条件 概率 密度 f x|Y(x |y).', 89, 43, [228, 720, 709, 763]),
  w('(2) 求 Z 的分布律和分布函数.', 94, 37, [231, 775, 681, 812]),
  w('24. 设随机变量(X,Y)的概率密度为', 93, 43, [211, 931, 756, 974]),
  // 识别层已用「裁边碎片」判据在源头拦掉这类假文本，这里保留作邻居噪声用例
  w('.议随机变量(A，1)的概率出度为', 64, 38, [247, 955, 771, 993]),
  // 大括号上钩被认成 `≥` —— 关系符紧跟 `=` 语法上不成立，按构造替身处理
  w('f(x,y) = ≥(x +y)e−(x+x), x >0,y > 0', 90, 60, [284, 1008, 964, 1064]),
  w('0，', 99, 36, [527, 1076, 658, 1108]),
  w('其他', 99, 36, [777, 1076, 937, 1108]),
  w('(1)问 X 和 Y 是否相互独立？', 88, 36, [218, 1122, 649, 1158]),
  w('(2) 求 Z = X + Y 的概率密度.', 89, 38, [215, 1170, 681, 1208]),
  w('28. 设 X,Y是相互独立的随机变量，它们都服从正态分布 N(0，σ²).试', 94, 38, [225, 1397, 1181, 1435]),
  w('验证随机变量 Z = √X2 + Y 的概率密度为', 91, 36, [167, 1452, 778, 1488]),
  w('fz(z) = { e²/2s2, x≥0', 80, 68, [292, 1513, 708, 1577]),
  w('0， 其他', 98, 36, [372, 1585, 708, 1617]),
  w('我们称 Z 服从参数 为σ(σ > 0) 的瑞利(Rayleigh) 分布.', 95, 37, [166, 1629, 918, 1666]),
  w('35. 设 X,Y是相互独立的随机变量,X ∼ b(n1,p),Y∼ b(n2,p),证明Z = X +Y∼b(n1+n₂,', 89, 43, [215, 1826, 1519, 1869]),
  w('P).', 82, 58, [140, 1868, 231, 1926]),
  w('单周周一下午2点前交作业', 100, 42, [634, 2149, 1035, 2191]), // 页脚（应被滤掉）
];

const REF_FONT = 36; // 该页参考字号（众数，dominantFontSize 的实测值）

/** 成行后的行（与 E2E 抓到的行结构一致；planPiecewise 只看 words） */
const realLines = (): PiecewiseLineLike[] => [
  { text: '', words: [W[1]] },
  { text: '', words: [W[2]] },
  { text: '', words: [W[3]] },
  { text: '', words: [W[4]!, W[5]!] },
  { text: '', words: [W[6]!] },
  { text: '', words: [W[7]!, W[8]!] },
  { text: '', words: [W[9]!] },
  { text: '', words: [W[10]!, W[11]!] },
  { text: '', words: [W[12]!, W[13]!] },
  { text: '', words: [W[14]!, W[15]!, W[16]!] },
  { text: '', words: [W[17]!, W[18]!] },
  { text: '', words: [W[19]!, W[20]!] },
  { text: '', words: [W[21]!] },
  { text: '', words: [W[22]!] },
  { text: '', words: [W[23]!] },
  { text: '', words: [W[24]!, W[25]!] },
];

describe('planPiecewise：真实页面的四处分段函数', () => {
  const plans = planPiecewise(realLines(), REF_FONT);

  it('四处锚点各产出一个计划（f_X/f_Y 合并词算两个构造），顺序与页面一致', () => {
    expect(plans.map((p) => p.anchor)).toEqual([W[6], W[9], W[14], W[21]]);
    expect(plans[0]?.claimed).toEqual([W[4], W[5]]);
    expect(plans[1]?.claimed).toEqual([W[8]]);
    // 24 题：下分支是 `0，` + `其他` 两个词，并成一份分支后整行摘走
    expect(plans[2]?.claimed).toEqual([W[15], W[16]]);
    expect(plans[3]?.claimed).toEqual([W[22]]);
  });

  it('f_X / f_Y：两个构造并排，分支在上、锚点内下分支在下', () => {
    // ⚠️ 第二个标签是识别结果里的 `fx(y)`（真值是 f_Y(y)，但这里**不替它改** ——
    // 重组只做版面，不改字）
    expect(plans[0]?.latex).toBe(
      'fx(x) =\\begin{cases} \\lambda e-x, x>0 \\\\ 0, x \\le 0 \\end{cases}' +
        ' \\qquad fx(y) =\\begin{cases} \\mu e-, y>0 \\\\ 0, y\\le 0 \\end{cases}',
    );
  });

  it('Z：上分支 `_(1，当 X≤Y` 的大括号残影被清掉', () => {
    expect(plans[1]?.latex).toBe(
      'Z =\\begin{cases} 1，当 X\\le Y \\\\ 0, 当X > Y \\end{cases}',
    );
  });

  it('24 题：`≥` 是误读的大括号，按构造替身重组；`0，` 与 `其他` 并成下分支', () => {
    // `≥` 被正则吃掉（不进入行内容），cases 环境显示真正的大括号
    expect(plans[2]?.latex).toBe(
      'f(x,y) =\\begin{cases} (x +y)e-(x+x), x >0,y > 0 \\\\ 0， 其他 \\end{cases}',
    );
  });

  it('f_z：上分支在锚点内、下分支 `0， 其他` 在锚点下方', () => {
    expect(plans[3]?.latex).toBe(
      'fz(z) =\\begin{cases} e^{2}/2s2, x\\ge 0 \\\\ 0， 其他 \\end{cases}',
    );
  });

  it('每个计划的 LaTeX 都能通过 KaTeX 验证门（throwOnError）', () => {
    for (const plan of plans) {
      expect(() =>
        katex.renderToString(plan.latex, {
          displayMode: true,
          throwOnError: true,
          strict: false,
          trust: true,
        }),
      ).not.toThrow();
    }
  });

  it('同页散文、含 `{` 的长句、邻居噪声都不是锚点，也不被占用', () => {
    const anchors = new Set(plans.map((p) => p.anchor));
    // 17 题长句含 `{` 但框高 43 < 48.6
    expect(anchors.has(W[1]!)).toBe(false);
    // `P).` 框高 58，不含构造头
    expect(anchors.has(W[25]!)).toBe(false);
    // 散文行、邻居噪声（假文本）一个都不是锚点、也一个都没被占用
    const claimed = new Set(plans.flatMap((p) => p.claimed));
    for (const prose of [W[3]!, W[7]!, W[10]!, W[12]!, W[13]!, W[17]!, W[20]!, W[23]!]) {
      expect(anchors.has(prose)).toBe(false);
      expect(claimed.has(prose)).toBe(false);
    }
  });
});

describe('planPiecewise：门槛的边界（宁可不重组，也不硬拼）', () => {
  it('分支与锚点空隙超过 1.4 倍参考字号 → 整个锚点放弃', () => {
    const anchor = w('fx(x) = { 0, x ≤ 0', 90, 56, [297, 503, 700, 555]);
    const far = w('1, x>0', 90, 28, [400, 412, 600, 436]); // 空隙 67px > 50.4
    expect(
      planPiecewise(
        [
          { text: '', words: [anchor] },
          { text: '', words: [far] },
        ],
        REF_FONT,
      ),
    ).toEqual([]);
  });

  it('空隙在门槛内 → 重组（同一个锚点、同一个分支，只差 66px 位置）', () => {
    const anchor = w('fx(x) = { 0, x ≤ 0', 90, 56, [297, 503, 700, 555]);
    const near = w('1, x>0', 90, 28, [400, 470, 600, 502]); // 空隙 1px
    const plans = planPiecewise(
      [
        { text: '', words: [anchor] },
        { text: '', words: [near] },
      ],
      REF_FONT,
    );
    expect(plans).toHaveLength(1);
    expect(plans[0]?.claimed).toEqual([near]);
    expect(plans[0]?.latex).toBe('fx(x) =\\begin{cases} 1, x>0 \\\\ 0, x \\le 0 \\end{cases}');
  });

  it('散文不会被当成分支（长度判据）', () => {
    const anchor = w('fx(x) = { 0, x ≤ 0', 90, 56, [297, 503, 1085, 555]);
    const prose = w('其中λ>0，μ>0是常数.引入随机变量', 97, 41, [162, 568, 752, 609]);
    expect(
      planPiecewise(
        [
          { text: '', words: [anchor] },
          { text: '', words: [prose] },
        ],
        REF_FONT,
      ),
    ).toEqual([]);
  });

  it('参考字号不可用时直接放弃（不做无基准的猜测）', () => {
    expect(planPiecewise(realLines(), 0)).toEqual([]);
    expect(planPiecewise(realLines(), Number.NaN)).toEqual([]);
  });
});

/**
 * 构造替身（大括号误读成关系符）的边界。
 *
 * 24 题实测的两种读数（run61）：主读数 `f(x,y) = ≥(x +y)…`、备读数
 * `f(x,y) = ∑(x +y)…`。只收关系符替身 —— `∑`/`∏` 语法上可以紧跟 `=`，
 * 收它们会把级数误判成分段函数（备读数就是活例）。
 */
describe('planPiecewise：构造替身的边界（只收语法上不能紧跟 `=` 的关系符）', () => {
  it('备读数 `f(x,y) = ∑…` 不重组（级数可以紧跟 `=`，不能当替身）', () => {
    const anchor = w('f(x,y) = ∑(x +y)e−(x+y), x > 0,y> 0', 90, 60, [284, 1008, 964, 1064]);
    const b1 = w('0，', 99, 36, [527, 1076, 658, 1108]);
    const b2 = w('其他', 99, 36, [777, 1076, 937, 1108]);
    expect(
      planPiecewise(
        [
          { text: '', words: [anchor] },
          { text: '', words: [b1, b2] },
        ],
        REF_FONT,
      ),
    ).toEqual([]);
  });

  it('「先关系符后等号」（`x >= 0`）不会匹配成构造头', () => {
    const anchor = w('x >= 0, y <= 1', 90, 56, [297, 503, 700, 555]);
    const below = w('0, x ≤ 0', 90, 28, [400, 510, 600, 540]);
    expect(
      planPiecewise(
        [
          { text: '', words: [anchor] },
          { text: '', words: [below] },
        ],
        REF_FONT,
      ),
    ).toEqual([]);
  });

  it('`{` 与替身混用 → 整个拒绝（计数判据不允许拼接）', () => {
    const anchor = w('fx(x) = { 0, x ≤ 0, fy(y) = ≥ 1, y ≤ 1', 90, 60, [297, 503, 1085, 555]);
    const below = w('2, y>0', 90, 28, [400, 510, 600, 540]);
    expect(
      planPiecewise(
        [
          { text: '', words: [anchor] },
          { text: '', words: [below] },
        ],
        REF_FONT,
      ),
    ).toEqual([]);
  });

  it('两个构造并排、分支同行且都单独成立 → 逐词处理（不因并起来短就合并）', () => {
    const anchor = w('fx(x) = { 0 fy(y) = { 0', 90, 56, [297, 503, 1085, 555]);
    const b1 = w('1,x>0', 90, 28, [400, 479, 500, 503]);
    const b2 = w('2,y>0', 90, 28, [900, 479, 1000, 503]);
    const plans = planPiecewise(
      [
        { text: '', words: [anchor] },
        { text: '', words: [b1] },
        { text: '', words: [b2] },
      ],
      REF_FONT,
    );
    expect(plans).toHaveLength(1);
    expect(plans[0]?.claimed).toEqual([b1, b2]);
    expect(plans[0]?.latex).toBe(
      'fx(x) =\\begin{cases} 1,x>0 \\\\ 0 \\end{cases}' +
        ' \\qquad fy(y) =\\begin{cases} 2,y>0 \\\\ 0 \\end{cases}',
    );
  });
});

describe('ocrResultToBlocks：分段函数落到独立公式块', () => {
  const blocks = ocrResultToBlocks({ pageNum: 1, words: [...W], avgConfidence: 92 }, 2223);
  const mathBlocks = blocks.filter((b) => b.type === 'math');
  const paragraphText = blocks
    .filter((b) => b.type !== 'math')
    .map((b) => b.content)
    .join('\n');

  it('产出四个 math 块（20 题、21 题、24 题、28 题各一），顺序与页面一致', () => {
    expect(mathBlocks).toHaveLength(4);
    expect(mathBlocks[0]?.content).toContain('fx(x) =\\begin{cases}');
    expect(mathBlocks[0]?.content).toContain('fx(y) =\\begin{cases}');
    expect(mathBlocks[1]?.content).toContain('Z =\\begin{cases}');
    expect(mathBlocks[2]?.content).toBe(
      'f(x,y) =\\begin{cases} (x +y)e-(x+x), x >0,y > 0 \\\\ 0， 其他 \\end{cases}',
    );
    expect(mathBlocks[3]?.content).toContain('fz(z) =\\begin{cases}');

    const idx20 = blocks.findIndex((b) => b.content.includes('20. 设 X和Y是相互独立的随机变量'));
    const idxProse = blocks.findIndex((b) => b.content.includes('其中λ>0，μ>0是常数'));
    const idxFz = blocks.findIndex((b) => b.content.includes('验证随机变量 Z'));
    expect(idx20).toBeGreaterThanOrEqual(0);
    expect(idx20).toBeLessThan(blocks.indexOf(mathBlocks[0]!));
    expect(blocks.indexOf(mathBlocks[0]!)).toBeLessThan(idxProse);
    expect(idxFz).toBeLessThan(blocks.indexOf(mathBlocks[3]!));
  });

  it('分支碎片不再以段落形式出现（防重复显示）', () => {
    expect(paragraphText).not.toContain('(λe−x');
    expect(paragraphText).not.toContain('(µe−');
    expect(paragraphText).not.toContain('_(1，当');
    expect(paragraphText).not.toContain('fx(x) = {');
    expect(paragraphText).not.toContain('Z = {');
    expect(paragraphText).not.toContain('fz(z) = {');
    // 24 题：`≥…` 整段进了 math 块，不再以原文出现在段落里
    expect(paragraphText).not.toContain('f(x,y) = ≥');
    expect(paragraphText).not.toContain('≥(x +y)');
  });

  it('散文与其他题目一字不丢；识别极限造成的错字原样保留（不发明内容）', () => {
    expect(paragraphText).toContain('其中λ>0，μ>0是常数.引入随机变量');
    expect(paragraphText).toContain('验证随机变量 Z = √X2 + Y 的概率密度为');
    expect(paragraphText).toContain('我们称 Z 服从参数 为σ(σ > 0) 的瑞利(Rayleigh) 分布.');
    // 24 题：题干照旧留在段落里；`(x+x)` 这类识别极限的原样保留（不发明内容），
    // 误读的 `≥` 由 cases 大括号取代
    expect(paragraphText).toContain('24. 设随机变量(X,Y)的概率密度为');
    expect(mathBlocks[2]?.content).toContain('(x +y)e-(x+x)');
    expect(paragraphText).toContain('P).');
    // 页眉页脚已被滤掉
    expect(paragraphText).not.toContain('概率论与数理统计习题5');
    expect(paragraphText).not.toContain('单周周一下午2点前交作业');
  });

  it('没有分段函数的页面：段落合并行为与接入前一致（第 17 题两行并一段）', () => {
    const blocks17 = ocrResultToBlocks({ pageNum: 1, words: [W[1]!, W[2]!], avgConfidence: 95 }, 2223);
    expect(blocks17).toHaveLength(1);
    expect(blocks17[0]?.type).toBe('paragraph');
    expect(blocks17[0]?.content).toContain('均为 正');
    expect(blocks17[0]?.content).toContain('整数，问X，Y是否相互独立.');
  });
});
