/**
 * 机制 5（按字符**自身**的预期高度校验）的测试。
 *
 * ═══════════════════════════════════════════════════════════════
 * 这一组要挡住什么（以及为什么要配「数值探针」）
 * ═══════════════════════════════════════════════════════════════
 *
 * 1. **置信度门的原理性缺口**：用户真实导出（`buildId` `2026-10-08T10:13:08.199Z`）
 *    里 3 个 `∼` 被当成上标，而它们的逐字符置信度（0.549 / 0.5816 / 0.5268）
 *    恰好是该词最低的三个 —— 低是因为**字形罕见**，不是因为小。机制 5
 *    换用「比它自己在本页的最大形态小了多少」这个量。
 * 2. 本项目已经出现过 **5 次「假保护」测试**（把逻辑注释掉照样绿）。所以
 *    下面每一条断言都尽量配一个**能把两种算法分开**的输入，并且把
 *    「另一种算法会得出什么」当场算出来（数值探针），而不是只断言行为。
 *
 * ═══════════════════════════════════════════════════════════════
 * 夹具来源：用户真实导出，逐字抄录（单位 = 画布像素）
 * ═══════════════════════════════════════════════════════════════
 *
 * 页面用**像素**高度而不是 `InkMeasurement.h`（归一化高度）：后者逐词
 * 除以本词裁剪高，跨词不可比（详见 `buildCharSizeTable` 的注释：同一个
 * `=` 在紧致框里是 0.226、在被撑大的框里是 0.124，比值会翻面）。
 * 判据本身是比值型的，所以整份夹具统一用像素不影响机制 1 的正确性。
 *
 * ⚠️ 逐字符置信度是**构造**的（真实导出里只有机制 2 需要的那几个能对上）：
 * 需要机制 5 单独受审的地方，把候选的置信度压到门槛之下，让机制 2 放行。
 * 每一处都注明了真实值。
 */
import { describe, expect, it } from 'vitest';
import {
  SCRIPT_MECH5_MIN_WORDS,
  SCRIPT_MECH5_SCALEDOWN_RATIO,
  attachCharsToWord,
  buildCharSizeTable,
  charSizeKey,
  classifyCharsByGeometry,
  isUnicodeScriptChar,
  type InkMeasurement,
} from '@/lib/ocrCharBoxes';
import type { OcrWord } from '@/lib/ocrTypes';

// ───────────────────────────────────────────────────────────────
// 夹具工具
// ───────────────────────────────────────────────────────────────

/** 一行实测：`[字符, y0, y1]`（画布像素） */
type Row = [string, number, number];

/** 判据的输入（与 `AttachedChars` 同形，但整份夹具都是像素量） */
interface WordInput {
  chars: Array<{ char: string; y0: number; y1: number }>;
  measurements: Array<InkMeasurement | null>;
  confidences: number[];
}

function mkWord(rows: Row[], confidences: number[]): WordInput {
  expect(confidences.length).toBe(rows.length);
  return {
    chars: rows.map(([char, y0, y1]) => ({ char, y0, y1 })),
    measurements: rows.map(([, y0, y1]) => ({ y0, y1, h: y1 - y0 })),
    confidences,
  };
}

/** 把若干「词」拼成一页（只用于建表：表只读词上的字符框，不读行结构） */
function pageOf(words: Row[][]): OcrWord[] {
  return words.map((rows, i) => {
    const word = {
      text: rows.map(([c]) => c).join(''),
      confidence: 99,
      bbox: { x0: 0, y0: i * 200, x1: 100, y1: i * 200 + 20 },
      fontSize: 20,
    } as OcrWord;
    attachCharsToWord(word, {
      chars: rows.map(([char, y0, y1]) => ({ char, x0: 0, y0, x1: 10, y1 })),
      measurements: rows.map(([, y0, y1]) => ({ y0, y1, h: y1 - y0 })),
    });
    return word;
  });
}

/** 造 n 个「正文汉字」：墨迹高 h、底边坐在 base 上（只用来定基线/基准高度） */
function bodyRows(chars: string, h: number, base: number): Row[] {
  return [...chars].map((c) => [c, base - h, base] as Row);
}

// ───────────────────────────────────────────────────────────────
// 第 15 词：`N(0，σ²).试` —— 真上标 `²`（U+00B2）走例外
// ───────────────────────────────────────────────────────────────

const W15_ROWS: Row[] = [
  ['N', 1405.9, 1426.1], // h 20.2
  ['(', 1406.8, 1426.1], // h 19.3   conf 0.718
  ['0', 1406.8, 1426.1], // h 19.3   conf 0.7999
  ['，', 1418.8, 1427.0], // h 8.2    conf 0.7469
  ['σ', 1413.3, 1425.2], // h 11.9   conf 0.9992
  ['²', 1404.1, 1414.2], // h 10.1   conf 0.8852  ← 真上标（U+00B2）
  [')', 1408.7, 1425.2], // h 16.5   conf 0.79
];

/** 让机制 2 放行 `²`（真实值是 0.8852；这里压到 0.50 是为了让机制 5 单独受审） */
const W15_CONF = [0.98, 0.98, 0.98, 0.98, 0.98, 0.5, 0.98];

// ───────────────────────────────────────────────────────────────
// 第 16 词：`验证随机变量 Z = √X2 + Y 的概率密度为`
// ───────────────────────────────────────────────────────────────

const W16_ROWS: Row[] = [
  ...bodyRows('验证随机变量概率', 20.1, 1479.6),
  ['Z', 1459.5, 1479.6], // h 20.1
  ['=', 1468.3, 1474.4], // h 6.1   conf 0.9967（真实值）
  ['√', 1456.9, 1477.9], // h 21.0（比基准高 → 不是候选，与既有用例一致）
  ['X', 1459.5, 1479.6], // h 20.1  conf 0.9754
  ['2', 1456.9, 1468.3], // h 11.4  conf 0.7097 ← 真上标
  ['+', 1470.0, 1471.8], // h 1.8   conf 0.9933
  ['Y', 1456.9, 1470.0], // h 13.1  conf 0.9892
];

/** 真实置信度：`2` 低（0.7097）→ 过机制 2；`=`/`+`/`Y` 高 → 机制 2 拒掉它们 */
const W16_CONF_REAL = [...W16_ROWS].map(([c]) =>
  c === '2' ? 0.7097 : c === '=' ? 0.9967 : c === '+' ? 0.9933 : c === 'Y' ? 0.9892 : 0.98,
);

/** 隔离夹具：只把**候选**的置信度压到 0.50，正文仍是高置信度 → 由机制 5 决断 */
const W16_CANDIDATE_CHARS = new Set(['=', '+', '2', 'Y']);
const W16_CONF_LOW = W16_ROWS.map(([c]) => (W16_CANDIDATE_CHARS.has(c) ? 0.5 : 0.98));

const W16_TWO = W16_ROWS.findIndex(([c]) => c === '2');

// ───────────────────────────────────────────────────────────────
// 第 20 词：`X ∼ b(n1,p),Y∼ b(n2,p),…` —— 三个 `∼` 误判的真实来源
// ───────────────────────────────────────────────────────────────

const W20_ROWS: Row[] = [
  ...bodyRows('设相互独立随机变量', 20.4, 1860.8),
  ['X', 1844.8, 1860.8], // h 16（导出给的是 16）
  ['b', 1840.4, 1860.8], // h 20.4
  ['n', 1848.5, 1860.8], // h 12.3
  ['1', 1849.5, 1860.8], // h 11.3  conf 0.9541
  ['₂', 1850.6, 1860.8], // h 10.2  conf 0.5826 ← 真下标（U+2082）
  ['=', 1844.4, 1850.6], // h 6.2   conf 0.9985
  ['∼', 1844.4, 1849.5], // h 5.1   conf 0.549   ← 误判（真实值）
  ['∼', 1845.5, 1850.6], // h 5.1   conf 0.5816  ← 误判（真实值）
  ['∼', 1844.4, 1849.5], // h 5.1   conf 0.5268  ← 误判（真实值）
];

/** 真实置信度：三个 `∼` 都低（0.549/0.5816/0.5268）→ **全部通过机制 2** */
const W20_TILDE_CONF = [0.549, 0.5816, 0.5268];
const W20_CONF_REAL = (() => {
  let seen = 0;
  return W20_ROWS.map(([c]) => (c === '∼' ? W20_TILDE_CONF[seen++]! : 0.98));
})();

const W20_TILDE_INDEXES = W20_ROWS.map(([c], i) => (c === '∼' ? i : -1)).filter((i) => i >= 0);

// ───────────────────────────────────────────────────────────────
// 第 1 词：完整的 53 个字符（像素版）—— `P` 与三个 `=` 必须被拒
// ───────────────────────────────────────────────────────────────

/** 与项目既有夹具 `REAL17_ROWS` 同一份数据（逐字抄录用户导出） */
const REAL17_ROWS: Row[] = [
  ['1', 219.2, 239.6],
  ['7', 219.2, 238.6],
  ['.', 236.6, 240.6],
  ['设', 220.2, 247.8],
  ['随', 220.2, 247.8],
  ['机', 221.3, 246.8],
  ['变', 220.2, 246.8],
  ['量', 220.2, 247.8],
  ['(', 223.3, 245.8],
  ['X', 223.3, 244.7],
  [',', 237.6, 245.8],
  ['Y', 223.3, 244.7],
  [')', 224.3, 245.8],
  ['具', 220.2, 247.8],
  ['有', 220.2, 247.8],
  ['分', 220.2, 247.8],
  ['布', 220.2, 247.8],
  ['律', 220.2, 248.8],
  ['P', 223.3, 234.5], // h 11.2  ← 误判，必须拒
  ['{', 221.3, 246.8],
  ['X', 226.4, 244.7],
  ['=', 231.5, 237.6], // h 6.1   ← 误判
  ['x', 231.5, 244.7],
  [',', 209, 258], // ← 异常框（49 高，必须被建表逻辑丢掉）
  ['Y', 223.3, 244.7],
  ['=', 231.5, 237.6], // h 6.1   ← 误判
  ['y', 231.5, 248.8],
  ['}', 222.3, 246.8],
  ['=', 231.5, 237.6], // h 6.1   ← 误判
  ['p', 227.4, 249.8], // h 22.4
  ['(', 223.3, 245.8],
  ['1', 223.3, 244.7],
  ['-', 209, 258], // ← 异常框（49 高，必须被丢掉）
  ['p', 227.4, 249.8], // h 22.4
  [')', 223.3, 245.8],
  ['x', 225.3, 232.5], // ── 指数 x+y-2（h 7.2）
  ['+', 225.3, 232.5], // h 7.2
  ['y', 225.3, 232.5], // h 7.2
  ['-', 225.3, 232.5], // h 7.2
  ['2', 220.2, 232.5], // h 12.3
  [',', 237.6, 245.8],
  ['0', 224.3, 244.7],
  ['<', 225.3, 243.7],
  ['p', 227.4, 243.7], // h 16.3
  ['<', 225.3, 243.7],
  ['1', 224.3, 244.7],
  [',', 237.6, 245.8],
  ['x', 223.3, 243.7], // h 20.4
  [',', 237.6, 245.8],
  ['y', 223.3, 243.7], // h 20.4
  ['均', 220.2, 247.8],
  ['为', 220.2, 247.8],
  ['正', 221.3, 246.8],
];

const REAL17_P = REAL17_ROWS.findIndex(([c]) => c === 'P');
const REAL17_EQS = REAL17_ROWS.map(([c], i) => (c === '=' ? i : -1)).filter((i) => i >= 0);
const REAL17_EXP = [35, 36, 37, 38, 39]; // x + y - 2

/**
 * 隔离夹具：把 `P` 与三个 `=` 的置信度压到 0.50。
 *
 * ⚠️ 真实值是 **0.9877 / 0.9965 / 0.9983 / 0.9984** —— 在真实数据里它们
 * 是被**机制 2**拒掉的。这里压低，是为了让「机制 5 能不能独立拒掉它们」
 * 这个问题有一个**可证伪**的答案（而不是被机制 2 遮住）。
 */
const REAL17_CONF_ISOLATED = REAL17_ROWS.map(([c]) =>
  c === 'P' || c === '=' || c === 'x' || c === '+' || c === 'y' || c === '-' || c === '2' ? 0.5 : 0.98,
);

// ───────────────────────────────────────────────────────────────
// 页面：第 15 / 16 / 20 / 1 词 + 三个只有 `2` 的词（第 3 / 9 / 22 词）
// ───────────────────────────────────────────────────────────────

const PAGE = pageOf([
  W15_ROWS,
  W16_ROWS,
  W20_ROWS,
  REAL17_ROWS,
  [['2', 0, 21]], // 第 3 词实测 h=21
  [['2', 0, 20.4]], // 第 9 词实测 h=20.4
  [['2', 0, 23]], // 第 22 词实测 h=23
]);

const W15 = mkWord(W15_ROWS, W15_CONF);
const W16 = mkWord(W16_ROWS, W16_CONF_REAL);
const W16_LOW = mkWord(W16_ROWS, W16_CONF_LOW);
const W20 = mkWord(W20_ROWS, W20_CONF_REAL);
const W1 = mkWord(REAL17_ROWS, REAL17_CONF_ISOLATED);

const full = () => buildCharSizeTable(PAGE);
const indexes = (out: Array<{ index: number }>) => out.map((s) => s.index);

// ═══════════════════════════════════════════════════════════════
// 1. 表本身：取最大、丢异常、不折大小写、不把 Unicode 上下标当基准
// ═══════════════════════════════════════════════════════════════

describe('机制 5 的页级字符高度表（真实实测值，逐字抄录）', () => {
  it('取的是**最大**实测高度：`2` → 23（不是 21 / 20.4 / 11.4）', () => {
    const table = full();
    expect(table).not.toBeNull();

    // 页面上 `2` 的实例：第 3 词 21、第 9 词 20.4、第 22 词 23、第 1 词指数 12.3、第 16 词指数 11.4
    expect(table!.get('2')).toBe(23);
    expect(table!.get('2')).toBeGreaterThan(21); // 明显不是「最保守的那个读数」
    expect(table!.get('=')).toBeCloseTo(6.2, 6);
    expect(table!.get('∼')).toBeCloseTo(5.1, 6);
    expect(table!.get('x')).toBeCloseTo(20.4, 6);
    expect(table!.get('y')).toBeCloseTo(20.4, 6);
  });

  it('⭐ 大小写**不合并**：`P`=11.2 与 `p`=22.4 是两个键（合并会让该拒的 `P` 比值变成 0.50）', () => {
    const table = full()!;
    expect(table.get('P')).toBeCloseTo(11.2, 6);
    expect(table.get('p')).toBeCloseTo(22.4, 6);

    /**
     * 数值探针：把两个键合并（= 照 `canonical()` 转小写的做法）会怎样。
     * 真实数字：`P` 11.2 / `p` 22.4 → 比值 **0.500 < 0.8** → **接受**。
     * 也就是说「折大小写」这一个动作会把必须拒掉的 `$^{P}$` 变成接受 ——
     * 这不是风格问题，是判据会翻面。
     */
    const folded = 11.2 / Math.max(11.2, 22.4);
    expect(folded).toBeLessThan(SCRIPT_MECH5_SCALEDOWN_RATIO);
    // 而现在的键分开了，`P` 的基准只能是它自己 → 比值 1.0 → 拒绝
    expect(11.2 / table.get('P')!).toBeGreaterThanOrEqual(SCRIPT_MECH5_SCALEDOWN_RATIO);
  });

  it('⭐ 建表丢掉**异常测量值**：那两个 49 高的坏框不能当基准', () => {
    const table = full()!;
    // 实测：`, ` 的实例有 8.2（×3）与 49（×1）；`-` 有 7.2（指数）与 49（×1）
    expect(table.get(',')).toBeCloseTo(8.2, 6);
    expect(table.get('-')).toBeCloseTo(7.2, 6);
    expect(table.get(',')).toBeLessThan(49);
    expect(table.get('-')).toBeLessThan(49);

    /**
     * 数值探针：不丢这两个坏框会怎样。
     * `-` 的基准会变成 49 → 指数里那个 `-`（7.2）比值 **0.147 < 0.8** →
     * 被判成「确实被缩小了」而**接受** —— 恰好把「天生就矮」与「被缩小」
     * 这两件事搞反。所以「丢异常」不是洁癖，是判据的前提。
     */
    expect(7.2 / 49).toBeLessThan(SCRIPT_MECH5_SCALEDOWN_RATIO);
  });

  it('Unicode 上下标字符**不作为基准**（`²`/`₂` 天生就矮，让它们定义「全尺寸」是错的）', () => {
    const table = full()!;
    expect(isUnicodeScriptChar('²')).toBe(true);
    expect(isUnicodeScriptChar('₂')).toBe(true);
    // 它们不在表里 —— 例外分支在查表之前就接走了它们（见下一条）
    expect(table.has('²')).toBe(false);
    expect(table.has('₂')).toBe(false);
    // 对照：`2` 的基准是 23（第 22 词那个正常数字），不是 10.1 / 10.2
    expect(table.get('2')).toBe(23);
  });

  it('健壮性：`charSizeKey` 只折全角；Unicode 上下标判据的边界不含 `∼`/`=`/`P`/`2`/`x`', () => {
    expect(charSizeKey('（')).toBe('(');
    expect(charSizeKey('X')).toBe('X'); // 不转小写
    for (const ch of ['∼', '=', 'P', '2', 'x', 'y', '+', '-', '√']) {
      expect(isUnicodeScriptChar(ch), `${ch} 不该被当成 Unicode 上下标字符`).toBe(false);
    }
    for (const ch of ['²', '³', '¹', '₂', 'ₙ', '⁺', 'ⁿ', 'ˣ']) {
      expect(isUnicodeScriptChar(ch), `${ch} 应当被当成 Unicode 上下标字符`).toBe(true);
    }
  });

  it('构建时少于两个词就返回 `null`（单词页上 H 退化成恒等式，见 SCRIPT_MECH5_MIN_WORDS）', () => {
    expect(SCRIPT_MECH5_MIN_WORDS).toBe(2);
    // 一个词：表不成立
    expect(buildCharSizeTable(pageOf([W16_ROWS]))).toBeNull();
    // 两个词：成立（第二个词提供一个全尺寸的 `2`）
    const two = buildCharSizeTable(pageOf([W16_ROWS, [['2', 0, 23]]]));
    expect(two).not.toBeNull();
    expect(two!.get('2')).toBe(23);
    // 对照：第 1 词里 `2` 只有指数那一个（12.3），拿它建表得不到 23
    expect(buildCharSizeTable(pageOf([W16_ROWS, REAL17_ROWS]))!.get('2')).toBeCloseTo(12.3, 6);
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. 判据：两个方向 + 例外，全部用真实实测值
// ═══════════════════════════════════════════════════════════════

describe('机制 5 的判定（真实夹具，两个方向都钉住）', () => {
  it('✅ 第 15 词 `σ²` 的 `²`（U+00B2）→ 接受（走「本身即 Unicode 上下标」的例外）', () => {
    const table = full()!;
    // 例外是**载荷**：它的键根本不在表里，没有例外就会走「H 不存在 → 拒绝」
    expect(table.has('²')).toBe(false);

    const out = classifyCharsByGeometry(W15.measurements, W15.chars, W15.confidences, table);
    const sup = W15_ROWS.findIndex(([c]) => c === '²');
    expect(indexes(out)).toContain(sup);
    expect(out.find((s) => s.index === sup)?.kind).toBe('super');
  });

  it('✅ 第 16 词指数里的 `2`（11.4，全尺寸 23）→ 接受', () => {
    const table = full()!;
    const out = classifyCharsByGeometry(W16.measurements, W16.chars, W16.confidences, table);
    expect(indexes(out)).toContain(W16_TWO);

    // 比值 11.4 / 23 = 0.496；即使只认「21+」这个最保守的读数也是 0.543 —— 都远小于 0.8
    expect(11.4 / table.get('2')!).toBeLessThan(SCRIPT_MECH5_SCALEDOWN_RATIO);
    expect(11.4 / 21).toBeLessThan(SCRIPT_MECH5_SCALEDOWN_RATIO);
  });

  it('⭐ 同一个 `2`，把「别处的全尺寸实例」从页面上拿掉 → 立刻被拒（证明接受它的是**页级**证据）', () => {
    // 只留第 16 词自己：它的 `2` 是页面上唯一一个 → H = 11.4 → 比值 1.0 → 拒绝
    const alone = buildCharSizeTable(pageOf([W16_ROWS, [['验', 1459.5, 1479.6]]]));
    // 上面那页的第二个词只提供 `验`，`2` 的唯一实例仍是第 16 词里那个
    expect(alone!.get('2')).toBeCloseTo(11.4, 6);
    expect(11.4 / alone!.get('2')!).toBeGreaterThanOrEqual(SCRIPT_MECH5_SCALEDOWN_RATIO);

    const out = classifyCharsByGeometry(W16.measurements, W16.chars, W16.confidences, alone);
    expect(indexes(out)).not.toContain(W16_TWO);
  });

  it('❌ 第 20 词三个 `∼`（5.1，页内最大也是 5.1）→ 全部拒绝', () => {
    const table = full()!;
    expect(table.get('∼')).toBeCloseTo(5.1, 6);

    /**
     * 真实置信度：0.549 / 0.5816 / 0.5268 —— **全部通过机制 2**
     * （这正是「调 0.93 这个系数解决不了」的实证：它们低是因为字形罕见）。
     */
    const out = classifyCharsByGeometry(W20.measurements, W20.chars, W20.confidences, table);
    for (const i of W20_TILDE_INDEXES) {
      expect(indexes(out), `第 ${i} 位（∼）必须被拒`).not.toContain(i);
    }
    expect(out).toEqual([]);
  });

  it('⭐ 反向对照：同一批 `∼` **不给表**时会被判成上标 —— 挡住它的确实是机制 5', () => {
    const without = classifyCharsByGeometry(W20.measurements, W20.chars, W20.confidences);
    expect(indexes(without)).toEqual(W20_TILDE_INDEXES);
    expect(without.every((s) => s.kind === 'super')).toBe(true);
  });

  it('❌ 第 1 词 `P`（11.2，页内最大也是 11.2）与三个 `=`（6.1 / 6.2）→ 拒绝', () => {
    const table = full()!;
    // 为让机制 5 单独受审，夹具里这四个字符的置信度被压到 0.50
    // （真实值 0.9877 / 0.9965 / 0.9983 / 0.9984 是被机制 2 拒掉的）
    const out = classifyCharsByGeometry(W1.measurements, W1.chars, W1.confidences, table);
    expect(indexes(out)).not.toContain(REAL17_P);
    for (const i of REAL17_EQS) expect(indexes(out)).not.toContain(i);

    // 数值探针：`=` 的比值是 6.1 / 6.2 = 0.984，`P` 是 1.000 —— 都在阈值之上
    expect(6.1 / table.get('=')!).toBeGreaterThan(SCRIPT_MECH5_SCALEDOWN_RATIO);
    expect(11.2 / table.get('P')!).toBeGreaterThanOrEqual(SCRIPT_MECH5_SCALEDOWN_RATIO);
  });

  it('⭐ 反向对照：同一批字符**不给表**时 `P` 与三个 `=` 全会变成上标', () => {
    const without = classifyCharsByGeometry(W1.measurements, W1.chars, W1.confidences);
    expect(indexes(without)).toContain(REAL17_P);
    for (const i of REAL17_EQS) expect(indexes(without)).toContain(i);
  });

  it('⚠️ 如实记录机制 5 挡不住谁：第 1 词指数里的 `+`/`−` 会被它**误拒**（本替代方案的固有缺口）', () => {
    const table = full()!;
    /**
     * 页面上 `+` 只有两个实例：第 1 词指数里的 7.2 与第 16 词的 1.8；
     * `−`（ASCII `-`）只有指数字符 7.2（另一个是 49 的异常框，已丢）。
     * 于是 H = 它自己 → 比值 1.0 → **拒绝**。这是「某字符在整页只以缩小形态
     * 出现时会失败」的实证（Tesseract 有字体度量表，不存在这个缺口）。
     */
    expect(table.get('+')).toBeCloseTo(7.2, 6);
    expect(table.get('-')).toBeCloseTo(7.2, 6);

    const out = classifyCharsByGeometry(W1.measurements, W1.chars, W1.confidences, table);
    const accepted = indexes(out);
    // `x`（7.2/20.4=0.35）、`y`（0.35）、`2`（12.3/23=0.53）留下
    for (const i of [REAL17_EXP[0]!, REAL17_EXP[2]!, REAL17_EXP[4]!]) {
      expect(accepted, `第 ${i} 位应当被接受`).toContain(i);
    }
    // `+`、`-` 被拒（缺口，如实钉住而不是假装没有）
    expect(accepted).not.toContain(REAL17_EXP[1]!);
    expect(accepted).not.toContain(REAL17_EXP[3]!);
    expect(accepted).toEqual([REAL17_EXP[0]!, REAL17_EXP[2]!, REAL17_EXP[4]!]);
  });

  it('⚠️ 如实记录机制 5 挡不住谁：第 16 词的 `+`（1.8/7.2=0.25）与 `Y`（13.1/21.4=0.61）靠机制 2 挡', () => {
    const table = full()!;
    // 真实置信度下：机制 2 先拒掉 `=`(0.9967)、`+`(0.9933)、`Y`(0.9892)，只剩 `2`
    const real = classifyCharsByGeometry(W16.measurements, W16.chars, W16.confidences, table);
    expect(indexes(real)).toEqual([W16_TWO]);

    // 把置信度全部压到 0.50（机制 2 放行）后，机制 5 只能拒掉 `=`；
    // `+` 与 `Y` 会被它**接受** —— 这是它的覆盖面边界，写出来比夸大有用。
    const low = classifyCharsByGeometry(W16_LOW.measurements, W16_LOW.chars, W16_LOW.confidences, table);
    const accepted = indexes(low);
    expect(accepted).toContain(W16_TWO);
    expect(accepted).toContain(W16_ROWS.findIndex(([c]) => c === '+'));
    expect(accepted).toContain(W16_ROWS.findIndex(([c]) => c === 'Y'));
    expect(accepted).not.toContain(W16_ROWS.findIndex(([c]) => c === '='));
    expect(1.8 / table.get('+')!).toBeLessThan(SCRIPT_MECH5_SCALEDOWN_RATIO);
    expect(13.1 / table.get('Y')!).toBeLessThan(SCRIPT_MECH5_SCALEDOWN_RATIO);
  });

  it('✅ `n₂` 的 `₂`（U+2082）在下标位置上 → 接受（走例外）', () => {
    /**
     * 真实导出只给了 `₂` 的**高度**（10.2）与它底边和 `1` 齐平；这里把纵向
     * 位置构造成「一个被排在下标位置的字符」（top 低于基线 3.1px ≈ 0.19 em），
     * 因为机制 1 要求下标候选的顶边低于基线一定量才认它是候选。
     */
    const rows: Row[] = [
      ...bodyRows('正文示例', 20.4, 100),
      ['n', 87.7, 100],
      ['₂', 103.1, 113.3], // h 10.2，顶边在基线下方 3.1
    ];
    // 正文高置信度、候选 `₂` 压到 0.50（否则机制 2 会在它之前插一手）
    const word = mkWord(rows, rows.map(([c]) => (c === '₂' ? 0.5 : 0.98)));
    const table = buildCharSizeTable(pageOf([rows, [['2', 0, 23]]]))!;
    expect(table.has('₂')).toBe(false); // 例外分支是载荷：表里根本没有它

    const out = classifyCharsByGeometry(word.measurements, word.chars, word.confidences, table);
    const sub = rows.findIndex(([c]) => c === '₂');
    expect(indexes(out)).toContain(sub);
    expect(out.find((s) => s.index === sub)?.kind).toBe('sub');
  });

  it('⚠️ 不变量：拿不到表（`undefined` / `null` / 空表）时机制 5 完全不启用', () => {
    // 三个入口必须逐个相同 —— 这是「与改动前逐字节相同」的可证形式
    const bare = classifyCharsByGeometry(W1.measurements, W1.chars, W1.confidences);
    expect(classifyCharsByGeometry(W1.measurements, W1.chars, W1.confidences, undefined)).toEqual(bare);
    expect(classifyCharsByGeometry(W1.measurements, W1.chars, W1.confidences, null)).toEqual(bare);
    // 空表：没有实例的表与没有表在信息量上一样，不能拿它把候选一律拒掉
    expect(classifyCharsByGeometry(W1.measurements, W1.chars, W1.confidences, new Map())).toEqual(bare);

    // 前提：这份夹具在「没有表」时确实包含那些只有机制 5 才能拒掉的字符
    expect(indexes(bare)).toContain(REAL17_P);
    for (const i of REAL17_EQS) expect(indexes(bare)).toContain(i);
  });

  it('取「最大」而不是「中位数」：一个全尺寸实例 + 三个缩小实例，两种算法结论相反', () => {
    /**
     * ═══════════════════════════════════════════════════════════
     * 为什么需要这条夹具（真实数据分不开这两种算法）
     * ═══════════════════════════════════════════════════════════
     *
     * 真实第 16 词那一组里 `2` 有 **3 个**全尺寸实例（21 / 20.4 / 23），
     * 最大值与中位数都能得出「它被缩小了」→ 两种算法**都通过**，
     * 真实数据**证明不了**「取最大」这件事是载荷。
     *
     * 所以这里造一个能把两者分开的输入：页面上 `2` 的实例是
     * `[23, 11.4, 11.4, 11.4]`（一个正常数字 + 三个指数）。
     *   · 取最大：H = 23 → 11.4/23 = **0.496** → 接受 ✔
     *   · 取中位数：H = 11.4 → 11.4/11.4 = **1.000** → 拒绝 ✘
     * 数值探针把「中位数会得出什么」当场算出来，而不是嘴上说说。
     */
    const expRows: Row[] = [
      ...bodyRows('正文示意', 20.4, 100),
      ['2', 77.0, 88.4], // 三个指数（h 11.4，抬高）
      ['2', 77.0, 88.4],
      ['2', 80.0, 91.4], // 第三个略低，保证三处都被判成候选
    ];
    // 正文高置信度、三个候选 `2` 压到 0.50（让机制 2 放行，由机制 5 决断）
    const word = mkWord(expRows, expRows.map(([c]) => (c === '2' ? 0.5 : 0.98)));
    const table = buildCharSizeTable(
      pageOf([expRows, [['2', 0, 23]], [['2', 0, 20.4]], [['2', 0, 21]]]),
    )!;

    expect(table.get('2')).toBe(23);
    const out = classifyCharsByGeometry(word.measurements, word.chars, word.confidences, table);
    const twos = expRows.map(([c], i) => (c === '2' ? i : -1)).filter((i) => i >= 0);
    expect(indexes(out)).toEqual(twos);

    // 数值探针：中位数（= 11.4）作分母时，三个 `2` 全部翻面成拒绝
    const medianTable = new Map(table);
    medianTable.set('2', 11.4);
    expect(classifyCharsByGeometry(word.measurements, word.chars, word.confidences, medianTable)).toEqual([]);
    expect(11.4 / 11.4).toBeGreaterThanOrEqual(SCRIPT_MECH5_SCALEDOWN_RATIO);
  });

  it('阈值本身也必须被实测数据钉住：落在 0.543 与 0.984 之间，两侧余量都为正', () => {
    /**
     * 没有这一条，`SCRIPT_MECH5_SCALEDOWN_RATIO` 就是一个**魔数**：
     * 上面那些用例只证明「阈值落在哪个区间内能用」，证明不了它为什么是 0.8。
     * 这里把两个实测端点写成算式：
     *  · 接受侧最紧的读数：第 16 词指数 `2` 11.4 对**最保守**的全尺寸读数 21 → 0.543；
     *  · 拒绝侧最紧的读数：第 1 词 `=` 6.1 对页内最大 `=` 6.2 → 0.984。
     */
    const acceptSide = 11.4 / 21;
    const rejectSide = 6.1 / 6.2;
    expect(SCRIPT_MECH5_SCALEDOWN_RATIO).toBeGreaterThan(acceptSide);
    expect(SCRIPT_MECH5_SCALEDOWN_RATIO).toBeLessThan(rejectSide);
    // 两侧余量（改常数就会变红）
    expect(SCRIPT_MECH5_SCALEDOWN_RATIO - acceptSide).toBeCloseTo(0.257, 3);
    expect(rejectSide - SCRIPT_MECH5_SCALEDOWN_RATIO).toBeCloseTo(0.184, 3);
  });

  it('表在、但字符**没有像素框**时机制 5 不判（退回机制 1+2，绝不与归一化量混算）', () => {
    const table = full()!;
    // 只给字符身份（不给 y0/y1）—— 机制 5 需要的是**像素**高度
    const identityOnly = W1.chars.map(({ char }) => ({ char }));
    const withTable = classifyCharsByGeometry(W1.measurements, identityOnly, W1.confidences, table);
    expect(withTable).toEqual(classifyCharsByGeometry(W1.measurements, identityOnly, W1.confidences));
    // 不判 = 该拒的没被拒（如实钉住这条降级路径的后果）
    expect(indexes(withTable)).toContain(REAL17_P);
    // 对照：同一份 measurements 换成带像素框的 chars，`P` 立刻被拒
    expect(indexes(classifyCharsByGeometry(W1.measurements, W1.chars, W1.confidences, table))).not.toContain(
      REAL17_P,
    );
    // 连字符身份都不给（chars = null）走同一条降级路径
    expect(classifyCharsByGeometry(W1.measurements, null, W1.confidences, table)).toEqual(withTable);
  });

  it('`H` 不存在 → 拒绝（真实调用里不可达：候选自己的实例必定在表里）', () => {
    // 故意只给 `x`/`y` 的基准，不给 `2` —— 模拟「表里没有这个字符」
    const partial = new Map([
      ['x', 20.4],
      ['y', 20.4],
    ]);
    const withoutTwo = classifyCharsByGeometry(W1.measurements, W1.chars, W1.confidences, partial);
    expect(indexes(withoutTwo)).not.toContain(REAL17_EXP[4]!);

    // 对照：把 `2` 的基准补上（23）→ 同一个字符立刻被接受
    const withTwo = new Map(partial).set('2', 23);
    expect(indexes(classifyCharsByGeometry(W1.measurements, W1.chars, W1.confidences, withTwo))).toContain(
      REAL17_EXP[4]!,
    );
  });

  it('建表跳过「没有墨迹测量值」的条目（它们的框不是字形范围，会污染 H）', () => {
    /**
     * 生产里这类条目来自 `measureCharPixelSpans`：没量到墨迹的字符拿到的是
     * **整个裁剪**的纵向范围（`y0=0, y1=裁剪高`）。这里刻意把那个坏框取成
     * 15px —— 小到**不会**被异常值过滤器（1.5 × 中位数）顺带挡掉，
     * 这样测的就是「没有测量值就不进表」这一条规则本身。
     */
    const rows: Row[] = [
      ['a', 79.6, 100], // 三个正文（h 20.4）—— 让本词的中位数落在正文字高上，
      ['b', 79.6, 100], // 否则「两个条目的中位数」会把 20.4 自己判成异常值
      ['c', 79.6, 100],
      ['X', 79.6, 100], // h 20.4
      ['∼', 88.7, 93.8], // h 5.1
    ];
    const word = {
      text: 'abcX∼?',
      confidence: 99,
      bbox: { x0: 0, y0: 0, x1: 100, y1: 20 },
      fontSize: 20,
    } as OcrWord;
    attachCharsToWord(word, {
      chars: [
        ...rows.map(([char, y0, y1], i) => ({ char, x0: i * 10, y0, x1: i * 10 + 10, y1 })),
        { char: '?', x0: 50, y0: 90, x1: 60, y1: 105 }, // 没有墨迹测量值 → 不是字形范围
      ],
      measurements: [
        ...rows.map(([, y0, y1]) => ({ y0, y1, h: y1 - y0 })),
        null,
      ],
    });

    const table = buildCharSizeTable([word, ...pageOf([W16_ROWS])])!;
    expect(table.has('?')).toBe(false);
    expect(table.get('∼')).toBeCloseTo(5.1, 6);
    expect(table.get('X')).toBeCloseTo(20.4, 6);
  });
});
