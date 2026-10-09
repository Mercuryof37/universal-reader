/**
 * 第二意见救回（`findRescuableRuns` + 证据框 + `classifyCharsByGeometry` 的救回分支）。
 *
 * ═══════════════════════════════════════════════════════════════
 * 夹具来源：用户真实导出 + 真实页面的 tesseract 实测（逐字抄录）
 * ═══════════════════════════════════════════════════════════════
 *
 * 三个词，各自的角色在 `findRescuableRuns` 的文档里已经写死：
 *
 *   · 第 1 词 `…p(1−p)^{x+y−2}…` —— 真指数段，(b)(c) 双双成立 → **必须救回**；
 *   · 第 16 词 `…Z = √X² + Y…`   —— 假段 `2+Y`，(b) 成立但 (c) 为 0 → **不救**；
 *   · 第 20 词 `…X ∼ b(n₁,p)…`   —— 假段 `=∼∼∼`，(c) 成立但 (b) 为 0 → **不救**。
 *
 * 后两条都不是编出来的反例：它们是这份导出里**真实存在的误判**，
 * 也正因为它们，救回机制才必须是「两条条件同时成立」而不是单条。
 *
 * 坐标：整份夹具用**画布像素**（与 `ocrCharBoxes.mech5.test.ts` 同一约定，
 * 理由见那边的说明：`InkMeasurement.h` 是逐词归一化量，跨词不可比，而判据
 * 本身是比值型的，统一用像素不影响机制 1 的正确性）。
 *
 * 证据框的来源是 `.spike/dump-cinfo.mjs` 在 `page-0001.png` 上跑出来的
 * **实测值**（4 倍 + PSM 7 + eng + hocr_char_boxes），页坐标已按
 * `(origin + t / 4)` 换算 —— 与生产代码 `attachTesseractEvidence` 的映射同一公式。
 */
import { describe, expect, it } from 'vitest';
import {
  SCRIPT_RESCUE_COVER_RATIO,
  SCRIPT_RESCUE_MIN_CONFIRM_CHARS,
  SCRIPT_RESCUE_MIN_EVIDENCE_CHARS,
  attachCharsToWord,
  buildCharSizeTable,
  classifyCharsByGeometry,
  findRescuableRuns,
  type InkEvidenceBox,
  type InkMeasurement,
} from '@/lib/ocrCharBoxes';
import type { OcrWord } from '@/lib/ocrTypes';

type Row = [string, number, number];

/** 一行实测：`[字符, y0, y1]`（画布像素） */
interface WordInput {
  chars: Array<{ char: string; y0: number; y1: number; x0?: number; x1?: number }>;
  measurements: Array<InkMeasurement | null>;
  confidences: number[];
}

// ───────────────────────────────────────────────────────────────
// 第 1 词：53 个字符（`ocrCharBoxes.mech5.test.ts` 的同一份数据）
// ───────────────────────────────────────────────────────────────

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
  ['P', 223.3, 234.5],
  ['{', 221.3, 246.8],
  ['X', 226.4, 244.7],
  ['=', 231.5, 237.6],
  ['x', 231.5, 244.7],
  [',', 209, 258], // 异常框（49 高）：建表与机制 1 都要丢掉它
  ['Y', 223.3, 244.7],
  ['=', 231.5, 237.6],
  ['y', 231.5, 248.8],
  ['}', 222.3, 246.8],
  ['=', 231.5, 237.6],
  ['p', 227.4, 249.8],
  ['(', 223.3, 245.8],
  ['1', 223.3, 244.7],
  ['-', 209, 258], // 异常框
  ['p', 227.4, 249.8],
  [')', 223.3, 245.8],
  ['x', 225.3, 232.5], // ── 指数段（35..39）
  ['+', 225.3, 232.5],
  ['y', 225.3, 232.5],
  ['-', 225.3, 232.5],
  ['2', 220.2, 232.5],
  [',', 237.6, 245.8],
  ['0', 224.3, 244.7],
  ['<', 225.3, 243.7],
  ['p', 227.4, 243.7],
  ['<', 225.3, 243.7],
  ['1', 224.3, 244.7],
  [',', 237.6, 245.8],
  ['x', 223.3, 243.7],
  [',', 237.6, 245.8],
  ['y', 223.3, 243.7],
  ['均', 220.2, 247.8],
  ['为', 220.2, 247.8],
  ['正', 221.3, 246.8],
];

const REAL17_EXP = [35, 36, 37, 38, 39];

/**
 * 指数五个字符的**实测横向范围**（`.spike/ink-cols.mjs`，区域 1130–1330 × 205–265）：
 *
 *     1180–1189  `x`      1208–1215  `y`      1235–1241  `2`
 *
 * `+`（≈1199–1200，字形分段只测到 2 列）与 `−`（没测到）**不给横向值** ——
 * 它们的墨迹太淡，逐列分析测不出来。这不是回避：覆盖数必须 ≥ 2，
 * 而 `x`/`y`/`2` 三个已经能给出 3 个覆盖，所以这两个字符的读数不影响结论。
 *
 * ⚠️ 这是**保守**读数：CTC 的字符框含字间距、比墨迹段更宽，
 * 更宽只会让重叠比例更大。用字形段当夹具，等于按最不利的情况判。
 */
const REAL17_EXP_X: Record<number, [number, number]> = {
  35: [1180, 1189],
  37: [1208, 1215],
  39: [1235, 1241],
};

/**
 * 区域 A（第 1 词整行 `p(1−p)^{x+y−2}…`，裁剪 (230,208)-(1600,262)）的**全部**证据框，
 * 实测 4 个（`fullH=170`、`baseline=160`、`n=54` 字符框）：
 *
 *     `*`  页X[1058.0,1065.0] 页Y[219.8,232.8]  ← 其实是被认错的 `2`（在 `p` 之后）
 *     `—`  页X[1109.8,1134.0] 页Y[233.0,235.0]  ← `(1−p)` 里的减号
 *     `"`  页X[1183.5,1216.3] 页Y[225.0,235.8]  ← tesseract 把 `x+y` 认成引号（**正压指数**）
 *     `2`  页X[1235.0,1242.0] 页Y[219.8,232.8]  ← 指数末尾的 `2`
 */
const EVIDENCE_A: InkEvidenceBox[] = [
  { x0: 1058.0, y0: 219.8, x1: 1065.0, y1: 232.8 },
  { x0: 1109.8, y0: 233.0, x1: 1134.0, y1: 235.0 },
  { x0: 1183.5, y0: 225.0, x1: 1216.3, y1: 235.8 },
  { x0: 1235.0, y0: 219.8, x1: 1242.0, y1: 232.8 },
];

/** 真实逐字符置信度（指数五个字符是导出的原值；其余取 0.98 的高置信度） */
const REAL17_CONF = REAL17_ROWS.map((_r, i) =>
  i === 35 ? 0.9953 : i === 36 ? 0.9997 : i === 37 ? 0.9205 : i === 38 ? 0.957 : i === 39 ? 0.9883 : 0.98,
);

// ───────────────────────────────────────────────────────────────
// 第 16 词：`验证随机变量 Z = √X2 + Y 的概率密度为`（15 个字符）
// ───────────────────────────────────────────────────────────────

const W16_ROWS: Row[] = [
  ...[...'验证随机变量概率'].map((c) => [c, 1459.5, 1479.6] as Row),
  ['Z', 1459.5, 1479.6],
  ['=', 1468.3, 1474.4],
  ['√', 1456.9, 1477.9],
  ['X', 1459.5, 1479.6],
  ['2', 1456.9, 1468.3], // h 11.4 ← 真上标（X 的平方）
  ['+', 1470.0, 1471.8], // h 1.8
  ['Y', 1456.9, 1470.0], // h 13.1
];

const W16_TWO = W16_ROWS.findIndex(([c]) => c === '2');
const W16_RUN = { from: W16_TWO, to: W16_TWO + 2 }; // {2, +, Y} —— 连成一串

/** 区域 B（(170,1446)-(790,1494)）实测：**0 个**证据框（21 个字符框，fullH=144） */
const EVIDENCE_B: InkEvidenceBox[] = [];

const W16_CONF = W16_ROWS.map(([c]) =>
  c === '2' ? 0.7097 : c === '=' ? 0.9967 : c === '+' ? 0.9933 : c === 'Y' ? 0.9892 : 0.98,
);

/**
 * ⚠️ **伪造**的证据框（真实测量是 0 个）：只用来回答「(c) 是不是载荷」——
 * 把证据硬盖在 `2+Y` 上，`+Y` 就会被吞进上标。真实路径拿到的是
 * `EVIDENCE_B`（空），所以这件事不会发生。坐标按区域 B 的实测页坐标给
 * （`+` 页X[511.8,534.5]、`Y` 页X[542.3,570.3]）。
 */
const EVIDENCE_B_FAKE: InkEvidenceBox[] = [{ x0: 505, y0: 1456, x1: 575, y1: 1472 }];

/** `2`/`+`/`Y` 的横向范围（区域 B 实测的页坐标量级）——只在伪造探针里用 */
const W16_RUN_X: Record<number, [number, number]> = {
  [W16_TWO]: [478, 500],
  [W16_TWO + 1]: [512, 535],
  [W16_TWO + 2]: [542, 570],
};

// ───────────────────────────────────────────────────────────────
// 第 20 词：`X ∼ b(n1,p),Y∼ b(n2,p),…`（18 个字符）
// ───────────────────────────────────────────────────────────────

const W20_ROWS: Row[] = [
  ...[...'设相互独立随机变量'].map((c) => [c, 1840.4, 1860.8] as Row),
  ['X', 1844.8, 1860.8],
  ['b', 1840.4, 1860.8],
  ['n', 1848.5, 1860.8],
  ['1', 1849.5, 1860.8],
  ['₂', 1850.6, 1860.8],
  ['=', 1844.4, 1850.6],
  ['∼', 1844.4, 1849.5],
  ['∼', 1845.5, 1850.6],
  ['∼', 1844.4, 1849.5],
];

const W20_TILDES = W20_ROWS.map(([c], i) => (c === '∼' ? i : -1)).filter((i) => i >= 0);
const W20_TILDE_COUNT = W20_TILDES.length;

/**
 * 区域 C（(220,1822)-(1510,1874)）实测：**3 个**证据框，全部压在三个 `∼` 上
 * （fullH=128、baseline=148、n=61 个字符框）。这正是「(c) 单独成立、
 * 但 (b) 为 0 → 必须不救」的那组读数。
 */
const EVIDENCE_C: InkEvidenceBox[] = [
  { x0: 753.5, y0: 1843.8, x1: 777.8, y1: 1850.3 },
  { x0: 954.0, y0: 1843.8, x1: 971.5, y1: 1850.3 },
  { x0: 1333.3, y0: 1843.8, x1: 1355.3, y1: 1850.3 },
];

/** 真实逐字符置信度：三个 `∼` 都低（0.549 / 0.5816 / 0.5268）→ 全部通过机制 2 */
const W20_CONF = (() => {
  const weak = [0.549, 0.5816, 0.5268];
  let seen = 0;
  return W20_ROWS.map(([c]) => (c === '∼' ? weak[seen++]! : 0.98));
})();

// ───────────────────────────────────────────────────────────────
// 页面与判据的输入
// ───────────────────────────────────────────────────────────────

const wordOf = (rows: Row[], xs: Record<number, [number, number]>, y: number, text: string): OcrWord => {
  const word = {
    text,
    confidence: 99,
    bbox: { x0: 0, y0: y, x1: 100, y1: y + 20 },
    fontSize: 20,
  } as OcrWord;
  attachCharsToWord(word, {
    chars: rows.map(([char, y0, y1], i) => {
      const x = xs[i];
      return x ? { char, x0: x[0], y0, x1: x[1], y1 } : { char, x0: 0, y0, x1: 0, y1 };
    }),
    measurements: rows.map(([, y0, y1]) => ({ y0, y1, h: y1 - y0 })),
  });
  return word;
};

/**
 * 一页：第 1 / 16 / 20 词，加三个只有一个 `2` 的小词。
 *
 * 那三个小词是**机制 5 的前提**：`2` 的页级「全尺寸」高度来自它们
 * （实测 21 / 20.4 / 23，取最大 = 23）。没有它们，指数里的 `2`
 * 会被判成「它天生就这么矮」，(b) 的计数会从 3 掉到 2。
 */
const PAGE: OcrWord[] = [
  wordOf(REAL17_ROWS, REAL17_EXP_X, 208, '17.设随机变量(X,Y)具有分布律P{X=x,Y=y}=p(1−p)x+y−2,0<p<1,x,y均为正'),
  wordOf(W16_ROWS, {}, 1446, '验证随机变量Z=√X2+Y的概率密度为'),
  wordOf(W20_ROWS, {}, 1822, '设相互独立随机变量X∼b(n1,p),Y∼b(n2,p),'),
  wordOf([['2', 0, 21]], {}, 0, '2'),
  wordOf([['2', 0, 20.4]], {}, 30, '2'),
  wordOf([['2', 0, 23]], {}, 60, '2'),
];

const sizeTable = () => buildCharSizeTable(PAGE);

const mkWord = (rows: Row[], xs: Record<number, [number, number]>, conf: number[]): WordInput => ({
  chars: rows.map(([char, y0, y1], i) => {
    const x = xs[i];
    return x ? { char, y0, y1, x0: x[0], x1: x[1] } : { char, y0, y1 };
  }),
  measurements: rows.map(([, y0, y1]) => ({ y0, y1, h: y1 - y0 })),
  confidences: conf,
});

const W1 = mkWord(REAL17_ROWS, REAL17_EXP_X, REAL17_CONF);
const W16 = mkWord(W16_ROWS, {}, W16_CONF);
const W16_X = mkWord(W16_ROWS, W16_RUN_X, W16_CONF);
const W20 = mkWord(W20_ROWS, {}, W20_CONF);

const run = (w: WordInput, table = sizeTable()) => findRescuableRuns(w.measurements, w.chars, table);
const classify = (
  w: WordInput,
  evidence: ReadonlyArray<InkEvidenceBox> | null | undefined,
  table = sizeTable(),
) => classifyCharsByGeometry(w.measurements, w.chars, w.confidences, table, evidence);
const indexes = (out: Array<{ index: number }>) => out.map((s) => s.index);

// ═══════════════════════════════════════════════════════════════
// 1. 段发现（条件 b）：谁有资格被请第二意见
// ═══════════════════════════════════════════════════════════════

describe('救回段的条件 (b)：≥2 个「确实被缩小的字母数字」', () => {
  it('第 1 词：唯一一段是指数 `x+y−2`（35..39），确认字符 3 个', () => {
    expect(SCRIPT_RESCUE_MIN_CONFIRM_CHARS).toBe(2);
    const runs = run(W1);
    expect(runs).toEqual([{ from: 35, to: 39, confirmChars: 3 }]);

    /**
     * 数值探针：逐一算出五个字符的比值（页级全尺寸来自表）。
     * `+` 与 `−` 不在计数里 —— 它们**不是字母数字**（`\p{L}\p{N}` 之外），
     * 与「表里有没有它们的全尺寸实例」无关。
     */
    const table = sizeTable()!;
    expect(7.2 / (table.get('x') as number)).toBeCloseTo(0.3529, 3);
    expect(7.2 / (table.get('y') as number)).toBeCloseTo(0.3529, 3);
    expect(12.3 / (table.get('2') as number)).toBeCloseTo(0.5348, 3);
    // `+` 即便拿它的实测比值也过不了（页内只有缩小形态 → 比值 1.0），
    // 但它压根不参与计数；这里把两件事都钉住
    expect(7.2 / (table.get('+') as number)).toBeCloseTo(1, 6);
    expect(table.get('2')).toBe(23);
  });

  it('第 16 词：`2+Y` 段 (b) 成立（2 个确认字符）', () => {
    const runs = run(W16);
    expect(runs).toEqual([{ from: W16_RUN.from, to: W16_RUN.to, confirmChars: 2 }]);

    // 数值探针：`2` 11.4/23 = 0.496、`Y` 13.1/21.4 = 0.612 —— 都小于 0.8
    const table = sizeTable()!;
    expect(11.4 / (table.get('2') as number)).toBeCloseTo(0.4957, 3);
    expect(13.1 / (table.get('Y') as number)).toBeCloseTo(0.6121, 3);
  });

  it('第 20 词：`=∼∼∼` 段被 (b) **直接挡掉**（确认字符 0 个，段根本不产生）', () => {
    expect(run(W20)).toEqual([]);

    // 数值探针：两个字符都不在 `\p{L}\p{N}` 里，所以「缩没缩小」无从谈起
    const table = sizeTable()!;
    expect(6.2 / (table.get('=') as number)).toBeCloseTo(1, 6);
    expect(5.1 / (table.get('∼') as number)).toBeCloseTo(1, 6);
  });

  it('汉字与 Unicode 上下标字符**都不是**确认字符（`\\p{L}` 含汉字，必须显式排除）', () => {
    /**
     * 构造：正文旁边跟**两个被缩小的汉字**与一个 Unicode 下标 `₂`，
     * 三者连成一个 3 字符的候选段（`均`/`衡` 上标、`₂` 下标）——
     * 若它们能当确认字符，这个段就够 (b) 了。
     *
     * 两个汉字在页面上**都有全尺寸实例**（表里 `均`/`衡` 各 20，
     * 候选框只有 8：比值 0.4 < 0.8，是货真价实的「被缩小」）——
     * 所以拦住它们的**只能是 CJK 门**，探针见下。
     *
     * `₂` 那一侧的边界如实记录：`buildCharSizeTable` 从不把 Unicode
     * 上下标字符收进表（见那里的第 3 条），因此它在表里必然查不到 ——
     * `isScaledDownLetterOrDigit` 里的 `isUnicodeScriptChar` 门在**生产
     * 路径上是双保险**（真正的拦截来自表规则），只在「调用方手造了一张
     * 含 `₂` 的表」这种 API 误用下才单独起作用。CJK 门则不是双保险：
     * 去掉它，`均`/`衡` 立刻计数为 2，这一段就会被误救。
     */
    const rows: Row[] = [
      ...([...'正文正文正文正文'] as string[]).map((c) => [c, 100, 120] as Row),
      ['均', 108, 116], // 上标候选（h 8 vs 正文 20）
      ['衡', 108, 116], // 上标候选
      ['₂', 124, 134], // 下标候选（h 10；U+2082，天生就矮）
    ];
    const w = mkWord(rows, {}, rows.map(() => 0.98));
    const table = buildCharSizeTable([
      ...PAGE,
      wordOf([...'正文正文正文正文'].map((c) => [c, 100, 120] as Row), {}, 200, '正文正文正文正文'),
      wordOf([['均', 100, 120]], {}, 240, '均'),
      wordOf([['衡', 100, 120]], {}, 260, '衡'),
    ])!;

    expect(run(w, table)).toEqual([]);

    // 数值探针：两个汉字确实被缩小了（都远小于 0.8）——
    // 不是「表里没有它们」把它们挡下的。`均` 的全尺寸实例来自第 1 词
    // （27.6，取 max 的那一条），`衡` 的来自本页新增的 20 —— 两个来源都钉住。
    expect(table.get('均')).toBeCloseTo(27.6, 6);
    expect(table.get('衡')).toBe(20);
    expect(8 / (table.get('均') as number)).toBeCloseTo(0.2899, 3);
    expect(8 / (table.get('衡') as number)).toBeCloseTo(0.4, 6);
    // 而 `₂` 压根不在表里（Unicode 上下标字符从不进表）
    expect(table.get('₂')).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. 第 1 词：救回真的发生，且每一条输入都是载荷
// ═══════════════════════════════════════════════════════════════

describe('第 1 词 `x+y−2`：真实证据框把整段救回来', () => {
  it('⭐ 不变量：没有证据（未传 / null / 空）→ 一个都不救，与引入救回前逐字节相同', () => {
    expect(indexes(classify(W1, undefined))).toEqual([]);
    expect(indexes(classify(W1, null))).toEqual([]);
    expect(indexes(classify(W1, []))).toEqual([]);

    /**
     * 数值探针：为什么「不救」是必然的 —— 五个字符的置信度
     * 0.9953 / 0.9997 / 0.9205 / 0.957 / 0.9883 **全部高于**机制 2 的门槛。
     * 门槛 = 0.93 ×（正常字符置信度的均值，去掉最差的一个）= 0.93 × 0.98。
     */
    expect(0.93 * 0.98).toBeCloseTo(0.9114, 6);
    for (const c of [0.9953, 0.9997, 0.9205, 0.957, 0.9883]) {
      expect(c).toBeGreaterThan(0.93 * 0.98);
    }
  });

  it('⭐ 有实测的 4 个证据框 → 指数整段（35..39）被救回，连成一段', () => {
    const out = classify(W1, EVIDENCE_A);
    expect(indexes(out)).toEqual(REAL17_EXP);
    expect(out.every((s) => s.kind === 'super')).toBe(true);
  });

  it('⭐ 覆盖计数是载荷：只留 `2` 那个框 → 覆盖 1 < 2 → 不救回', () => {
    // 第 4 个框（页X[1235,1242]）只压住指数末尾的 `2`
    expect(SCRIPT_RESCUE_MIN_EVIDENCE_CHARS).toBe(2);
    const onlyTwo = EVIDENCE_A.filter((e) => e.x0 > 1200);
    expect(onlyTwo).toHaveLength(1);
    expect(indexes(classify(W1, onlyTwo))).toEqual([]);
  });

  it('⭐ 一个框可以覆盖两个字符：只留 `"` 那个框 → 覆盖 {x, y} = 2 → 仍救回', () => {
    const onlyQuote = EVIDENCE_A.filter((e) => e.x0 > 1180 && e.x1 < 1220);
    expect(onlyQuote).toHaveLength(1);
    expect(indexes(classify(W1, onlyQuote))).toEqual(REAL17_EXP);

    /**
     * 数值探针（两条轴的重叠比例，阈值 0.5）：
     *   `x` 页X[1180,1189] vs 框 [1183.5,1216.3] → 5.5 / 9   = **0.611**
     *   `y` 页X[1208,1215] vs 框 [1183.5,1216.3] → 7   / 7   = **1.000**
     * 纵向两者都是 1.000（框比字符高）。`x` 是最紧的一个 ——
     * 阈值加到 0.65 才会掉出去，而那时仍有 `y` + `2` 两个覆盖。
     */
    const covX = (1189 - 1183.5) / 9;
    const covY = 7 / 7;
    expect(covX).toBeGreaterThanOrEqual(SCRIPT_RESCUE_COVER_RATIO);
    expect(covY).toBeGreaterThanOrEqual(SCRIPT_RESCUE_COVER_RATIO);
    expect(covX).toBeCloseTo(0.611, 3);
  });

  it('⭐ 比例是载荷：把 `"` 的左边缩到 1204 → 只覆盖 `y` 一个 → 不救回', () => {
    const narrowed = [{ x0: 1204, y0: 225.0, x1: 1216.3, y1: 235.8 }];
    // `x` 的右边界 1189 < 1204 → 横向重叠为 0；`y` 仍被完全覆盖
    expect(indexes(classify(W1, narrowed))).toEqual([]);

    /**
     * 数值探针：抬高阈值 0.25 在这份数据上的**余量**（如实记录，因为它很紧）。
     * `"` 框的底边 111 vs 门槛 160 − 0.25×170 = 117.5 —— 只差 6.5 裁剪像素
     * （= 1.6 页像素）。换成 0.3（门槛 109）它就会掉出去，覆盖数降到 1
     * （只剩 `2` 那个框）→ 救回失败。这条余量来自实测裁剪（区域 A 整行）
     * 与生产裁剪（词框 + 15% 留白）之间的差异，测试钉不住生产端的实际值。
     */
    expect(160 - 0.25 * 170).toBeCloseTo(117.5, 6);
    expect(111).toBeLessThan(117.5);
    expect(111).toBeGreaterThan(160 - 0.3 * 170);
  });

  it('⭐ 表是载荷：拿不到 / 空表时预筛一个词都筛不出来', () => {
    expect(findRescuableRuns(W1.measurements, W1.chars, null)).toEqual([]);
    expect(findRescuableRuns(W1.measurements, W1.chars, new Map())).toEqual([]);
    expect(findRescuableRuns(W1.measurements, undefined, sizeTable())).toEqual([]);
    // 表在、证据在，但判据没拿到表 → 救回同样不启用
    expect(indexes(classifyCharsByGeometry(W1.measurements, W1.chars, W1.confidences, undefined, EVIDENCE_A)))
      .toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. 两个反例：单靠一条条件就会救错
// ═══════════════════════════════════════════════════════════════

describe('第 16 词 `2+Y`：(b) 成立、(c) 为 0 → 不救（条件 c 是载荷）', () => {
  it('真实证据为 0 → 不救回；真上标 `2` 仍走机制 2 单独通过', () => {
    expect(EVIDENCE_B).toEqual([]);
    const out = classify(W16, EVIDENCE_B);
    expect(indexes(out)).toEqual([W16_TWO]);
    // 真上标 `2` 的置信度 0.7097 低于门槛（≈0.9114）→ 机制 2 放行它
    expect(0.7097).toBeLessThan(0.93 * 0.98);
  });

  it('⚠️ 探针（**伪造**证据）：把证据硬盖在 `2+Y` 上，`+Y` 就会被吞进上标', () => {
    /**
     * 这一条证明 (c) 是**载荷**而不是装饰：这批证据是编的，
     * 真实测量（区域 B）是 0 个框。若哪天有人把 (c) 去掉，
     * 第 16 词就会输出 `$^{2+Y}$` —— 这就是那条路会走到的坏输出。
     */
    const out = classify(W16_X, EVIDENCE_B_FAKE);
    expect(indexes(out)).toEqual([W16_RUN.from, W16_RUN.from + 1, W16_RUN.to]);
  });
});

describe('第 20 词 `=∼∼∼`：(c) 成立、(b) 为 0 → 不救（条件 b 是载荷）', () => {
  it('三个证据框正压在 `∼` 上，但一个字符都进不了 (b) → 误判不回来', () => {
    expect(EVIDENCE_C).toHaveLength(3);
    // 三个框的横向位置与 W20 的三个 `∼` 一一对应（实测页坐标）
    expect(W20_TILDE_COUNT).toBe(3);

    const out = classify(W20, EVIDENCE_C);
    expect(indexes(out)).toEqual([]);
    expect(run(W20)).toEqual([]);
  });
});
