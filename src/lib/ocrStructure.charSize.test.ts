/**
 * 「导出识别结构」里**机制 5 的三个量**（`inkHeight` / `pageMaxHeight` /
 * `heightRatio`）的测试。
 *
 * ═══════════════════════════════════════════════════════════════
 * 这一组要挡住什么
 * ═══════════════════════════════════════════════════════════════
 *
 * 1. **纯增量的三个字段必须真的出现**，而且必须与机制 5 用的是**同一张
 *    页级表**、**同一个像素口径**。所以下面不是「断言有个数字」，
 *    而是拿真实导出里的数字逐个对：
 *      · 第 16 词指数里的 `2`：11.4 / 23 = **0.496**（全页最大 `2` 在第 22 词）；
 *      · 第 20 词的 `∼`：5.1 / 5.1 = **1.000**（它在本页只有缩小形态）；
 *      · 空白位：三个字段都是 `null`；
 *      · 第 15 词的 `²`（U+00B2）：`inkHeight` 有值，但表里**没有**它的基准
 *        （建表刻意排除「本身即 Unicode 上下标」的字符）→ 后两个是 `null`；
 *      · 第 1 词那个 **49 高的坏框**：`inkHeight` 有值，但它被
 *        `SCRIPT_OUTLIER_RATIO` 丢掉了 → 表里也没有它 → 后两个是 `null`。
 *    最后两条正是「导出必须与建表口径一致」的证据：**量到了却没有基准**，
 *    与「没量到」是两件不同的事，而字段能分开它们。
 *
 * 2. **导出内容变了，识别结果必须逐字节不变**（本任务的硬性不变量）。
 *    加字段是纯增量：`blocks` / `lines[].hasScripts` 必须与**加字段之前
 *    冻结下来的字面量**完全一致。这条用例是「下次改判据」的安全网 ——
 *    它只在判据真的动了的时候才红。
 *
 * 3. **新测试不是假保护**：把三个字段从导出里拿掉，下面这些用例必须变红
 *    （实测过，见交付说明里的原始输出）。既有测试一条都不该红 ——
 *    这正是「纯增量」的含义：旧用例本来就不覆盖它。
 *
 * ═══════════════════════════════════════════════════════════════
 * 夹具来源：用户真实导出（`buildId 2026-10-08T10:13:08.199Z`），逐字抄录
 * ═══════════════════════════════════════════════════════════════
 *
 * 纵向范围（`y0`/`y1`）与由它算出的高度**全部是真实的**，来源与
 * `ocrCharBoxes.mech5.test.ts` 的同一份导出（那组用例也逐字抄了同一批数）。
 *
 * ⚠️ 三类**构造**的部分，逐条写在这里，不藏：
 *   1. **横向坐标**（`x0`/`x1`）：导出里给全的只有第 16 词与第 15 词的 `²`
 *      （后者是 `[1176,1192]`，那一个是逐字抄的）。其余字符的横向范围是
 *      **排布脚手架** —— 字符级判据一个横向量都不用（`x` 只在
 *      「第二意见证据覆盖」里用到，本组用例不传证据），所以它不影响任何断言；
 *   2. **逐字符置信度**：只有第 15/16/20 词那几个（导出里机制 2 需要的）
 *      是真实值，逐条注在夹具里；其余按 `mech5.test.ts` 的同一处理给 0.98，
 *      并且 `²` 被**刻意压到 0.50**（真实值 0.8852）—— 否则机制 2 会先一步
 *      拒掉它，这份夹具就产不出 `$^{²}$`，「逐字节不变」那条用例会失去牙齿；
 *   3. 第 20 词的 `=` 与三个 `∼` 在导出里是与别的字同词的，这里按字符
 *      **各成一个词**（表按字符统计，词怎么切不影响 `H`）。
 *
 * `measurements` 用的是**像素**值本身（`h = y1 - y0`）：机制 1 是比值型
 * 判据，整份夹具统一用像素不改变它的结论 —— 与 `mech5.test.ts` 同一做法。
 * 而**导出**里那三个字段是另一回事：它们就该是像素（理由见
 * `ocrStructure.ts` 里 `inkHeight` 的注释）。
 */
import { describe, expect, it } from 'vitest';
import {
  SCRIPT_MECH5_SCALEDOWN_RATIO,
  attachCharsToWord,
  buildCharSizeTable,
  charSizeKey,
} from '@/lib/ocrCharBoxes';
import { ocrResultToBlocks } from '@/lib/ocrPostProcess';
import { buildOcrStructure, type OcrStructure } from '@/lib/ocrStructure';
import type { OcrWord } from '@/lib/ocrTypes';

// ───────────────────────────────────────────────────────────────
// 夹具工具
// ───────────────────────────────────────────────────────────────

/** 一个字符的实测框：`[字符, x0, y0, x1, y1]`（画布像素） */
type CharRow = [string, number, number, number, number];

interface WordSpec {
  text: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
  fontSize: number;
  confidence: number;
  rows: CharRow[];
  /** 与 `rows` 逐位对齐；`null` = 这一位没有置信度（空白位，与真实对账一致） */
  confidences: Array<number | null>;
}

/** 造一个挂了字符框的词（与 `attachCharBoxes` 存进 `WeakMap` 的形状相同） */
function mkWord(spec: WordSpec): OcrWord {
  expect(spec.rows.length, `${spec.text} 的字符框必须与文本逐位对齐`).toBe(spec.text.length);
  expect(spec.confidences.length).toBe(spec.rows.length);
  const word: OcrWord = {
    text: spec.text,
    confidence: spec.confidence,
    bbox: { ...spec.bbox },
    fontSize: spec.fontSize,
  };
  attachCharsToWord(word, {
    chars: spec.rows.map(([char, x0, y0, x1, y1]) => ({ char, x0, y0, x1, y1 })),
    // 空白位没有墨迹可言 —— 与 `measureCharPixelSpans` 的 `hasInk = false`
    // 走同一条路：测量值为 `null`（建表与导出都按这个标志判）
    measurements: spec.rows.map(([char, , y0, , y1]) => (char.trim() ? { y0, y1, h: y1 - y0 } : null)),
    confidences: spec.confidences.map((c) => (c === null ? Number.NaN : c)),
  });
  return word;
}

// ───────────────────────────────────────────────────────────────
// 第 15 词：`N(0，σ²)` —— 真上标 `²`（U+00B2）走「本身即 Unicode 上下标」的例外
// ───────────────────────────────────────────────────────────────

const W15 = mkWord({
  text: 'N(0，σ²)',
  bbox: { x0: 1100, y0: 1404.1, x1: 1202, y1: 1427.0 },
  fontSize: 20.2,
  confidence: 95,
  rows: [
    ['N', 1100, 1405.9, 1119, 1426.1], // h 20.2
    ['(', 1119, 1406.8, 1128, 1426.1], // h 19.3   conf 0.718（真实）
    ['0', 1128, 1406.8, 1147, 1426.1], // h 19.3   conf 0.7999（真实）
    ['，', 1147, 1418.8, 1157, 1427.0], // h 8.2    conf 0.7469（真实）
    ['σ', 1157, 1413.3, 1176, 1425.2], // h 11.9   conf 0.9992（真实）
    ['²', 1176, 1404.1, 1192, 1414.2], // h 10.1   ← 横向也是真实值 [1176,1192]
    [')', 1192, 1408.7, 1202, 1425.2], // h 16.5   conf 0.79（真实）
  ],
  confidences: [0.98, 0.718, 0.7999, 0.7469, 0.9992, 0.5, 0.79],
});

// ───────────────────────────────────────────────────────────────
// 第 16 词：`验证随机变量 Z = √X2 + Y 的概率密度为`（这里取带空格的那一段）
// ───────────────────────────────────────────────────────────────

const W16 = mkWord({
  text: 'Z = √X2 + Y',
  bbox: { x0: 392, y0: 1456.9, x1: 640, y1: 1479.6 },
  fontSize: 20.1,
  confidence: 95,
  rows: [
    ['Z', 392, 1459.5, 420, 1479.6], // h 20.1
    [' ', 420, 1479.6, 420, 1479.6], // 空白位（对账给的就是退化框 + 测量值 null）
    ['=', 436, 1468.3, 458, 1474.4], // h 6.1    conf 0.9967（真实）
    [' ', 458, 1479.6, 458, 1479.6], // 空白位
    ['√', 486, 1456.9, 512, 1477.9], // h 21.0
    ['X', 512, 1459.5, 536, 1479.6], // h 20.1   conf 0.9754（真实）
    ['2', 536, 1456.9, 554, 1468.3], // h 11.4   conf 0.7097（真实）← 真上标
    [' ', 554, 1479.6, 554, 1479.6], // 空白位
    ['+', 570, 1470.0, 596, 1471.8], // h 1.8    conf 0.9933（真实）
    [' ', 596, 1479.6, 596, 1479.6], // 空白位
    ['Y', 596, 1456.9, 640, 1470.0], // h 13.1   conf 0.9892（真实）
  ],
  confidences: [0.98, null, 0.9967, null, 0.98, 0.9754, 0.7097, null, 0.9933, null, 0.9892],
});

/** 第 16 词里 `2` 的那一位（下标 6）—— 本组用例的主角 */
const W16_TWO_INDEX = 6;
/** 第 16 词里 `=` 的那一位（下标 2）—— 拒绝侧最紧的那个数（0.984） */
const W16_EQ_INDEX = 2;

// ───────────────────────────────────────────────────────────────
// 第 20 词：`X ∼ b(n1,p),Y∼ b(n2,p),…` 里的 `=` 与三个 `∼`
// ───────────────────────────────────────────────────────────────

const W20_EQ = mkWord({
  text: '=',
  bbox: { x0: 700, y0: 1844.4, x1: 712, y1: 1850.6 },
  fontSize: 6.2,
  confidence: 95,
  rows: [['=', 700, 1844.4, 712, 1850.6]], // h 6.2  conf 0.9985（真实）
  confidences: [0.9985],
});

/** 三个 `∼` 的实测框（`y` 逐字抄录）与**真实**置信度 0.549 / 0.5816 / 0.5268 */
const W20_TILDES = [
  mkWord({
    text: '∼',
    bbox: { x0: 720, y0: 1844.4, x1: 732, y1: 1849.5 },
    fontSize: 5.1,
    confidence: 95,
    rows: [['∼', 720, 1844.4, 732, 1849.5]], // h 5.1
    confidences: [0.549],
  }),
  mkWord({
    text: '∼',
    bbox: { x0: 736, y0: 1845.5, x1: 748, y1: 1850.6 },
    fontSize: 5.1,
    confidence: 95,
    rows: [['∼', 736, 1845.5, 748, 1850.6]], // h 5.1
    confidences: [0.5816],
  }),
  mkWord({
    text: '∼',
    bbox: { x0: 752, y0: 1844.4, x1: 764, y1: 1849.5 },
    fontSize: 5.1,
    confidence: 95,
    rows: [['∼', 752, 1844.4, 764, 1849.5]], // h 5.1
    confidences: [0.5268],
  }),
];

// ───────────────────────────────────────────────────────────────
// 第 22 词（只给出高度）：全页最大的 `2` —— 机制 5 的分母就是它
// ───────────────────────────────────────────────────────────────

/**
 * ⚠️ 导出里只给了**高度 23**（`mech5.test.ts` 的夹具同样只给了高度），
 * 位置是排布脚手架。表只读字符框的高度，位置不影响任何断言。
 */
const W22_TWO = mkWord({
  text: '2',
  bbox: { x0: 1480, y0: 1650, x1: 1496, y1: 1673 },
  fontSize: 23,
  confidence: 95,
  rows: [['2', 1480, 1650, 1496, 1673]], // h 23  ← 全页最大
  confidences: [0.99],
});

// ───────────────────────────────────────────────────────────────
// 第 1 词的一段连续子串：`P{X=x,Y=y}` —— 里面那个 49 高的坏框是重点
// ───────────────────────────────────────────────────────────────

/**
 * `y` 逐字抄录自第 1 词（`ocrCharBoxes.mech5.test.ts` 的 `REAL17_ROWS`
 * 第 19–28 项），横向是脚手架。
 *
 * `,` 的框是 **209–258（h 49）**：混进相邻行墨迹的坏框，实测里正体字高
 * 只有 20 上下 —— 它在建表时会被 `SCRIPT_OUTLIER_RATIO`（1.5）丢掉，
 * 于是它的 `pageMaxHeight` / `heightRatio` 必须是 `null`，而 `inkHeight`
 * 必须照实写出 49。**这三者同时成立，才说明导出与建表是同一套口径。**
 */
const W1_SUB = mkWord({
  text: 'P{X=x,Y=y}',
  bbox: { x0: 225, y0: 212, x1: 600, y1: 255 },
  fontSize: 43,
  confidence: 95,
  rows: [
    ['P', 225, 223.3, 245, 234.5], // h 11.2
    ['{', 245, 221.3, 258, 246.8], // h 25.5
    ['X', 258, 226.4, 275, 244.7], // h 18.3
    ['=', 275, 231.5, 290, 237.6], // h 6.1
    ['x', 290, 231.5, 305, 244.7], // h 13.2
    [',', 305, 209, 315, 258], //     h 49   ← 异常框（超出词框，真实形态）
    ['Y', 315, 223.3, 335, 244.7], // h 21.4
    ['=', 335, 231.5, 350, 237.6], // h 6.1
    ['y', 350, 231.5, 365, 248.8], // h 17.5
    ['}', 365, 222.3, 378, 246.8], // h 24.5
  ],
  confidences: [0.98, 0.98, 0.98, 0.98, 0.98, 0.98, 0.98, 0.98, 0.98, 0.98],
});

const W1_COMMA_INDEX = 5;

// ───────────────────────────────────────────────────────────────
// 一个**没有**字符框的词：`chars` 字段必须整个不出现（既有行为，别改）
// ───────────────────────────────────────────────────────────────

const W_NO_CHARS: OcrWord = {
  text: '均',
  confidence: 95,
  bbox: { x0: 40, y0: 900, x1: 60, y1: 920 },
  fontSize: 20,
};

/** 整页：8 个有字符框的词 + 1 个没有的（第 15/16/20/22/1 词的真实实测值） */
const PAGE: OcrWord[] = [W15, W16, W20_EQ, ...W20_TILDES, W22_TWO, W1_SUB, W_NO_CHARS];

/** 抓取一次识别里交出来的结构（与 `ocrStructure.test.ts` 同一手法） */
function capture(words: OcrWord[]): { blocks: ReturnType<typeof ocrResultToBlocks>; structure: OcrStructure } {
  let captured: OcrStructure | undefined;
  const blocks = ocrResultToBlocks(
    { pageNum: 1, words, avgConfidence: 95 },
    undefined,
    (s) => {
      captured = s;
    },
  );
  if (!captured) throw new Error('结构没有被交出来');
  return { blocks, structure: captured };
}

/** 导出里第 `wordIndex` 个词的第 `charIndex` 个字符框（缺了就直接炸，别静默） */
function charAt(structure: OcrStructure, wordIndex: number, charIndex: number) {
  const entry = structure.words[wordIndex]?.chars?.[charIndex];
  if (!entry) throw new Error(`导出里没有 words[${wordIndex}].chars[${charIndex}]`);
  return entry;
}

/** 导出里某个词的字符框（按词文本找，比下标稳） */
function wordEntry(structure: OcrStructure, text: string) {
  const entry = structure.words.find((w) => w.text === text);
  if (!entry) throw new Error(`导出里没有词「${text}」`);
  return entry;
}

const { blocks, structure } = capture(PAGE);
const sizeTable = buildCharSizeTable(PAGE);

/**
 * ═══════════════════════════════════════════════════════════════
 * 冻结的识别结果：与那三个字段**无关**的一份字面量，逐字节抄录
 * ═══════════════════════════════════════════════════════════════
 *
 * 这几个常量是本任务的**安全网**：加字段只许改导出，不许动判据。
 *
 * 它们是从**加字段之后**的代码上抄下来的 —— 但那不等于「自己验自己」：
 * 「加字段没有改变判据」这件事被**反方向**证过。把三个字段从
 * `ocrStructure.ts` 里删掉（还原成 HEAD 那一版）再跑一遍：
 *   · 下面这几条断言**照样全绿**（判据的结论一个字都没变）；
 *   · 而三个字段的那些断言 **12/17 全红**（新测试不是假保护）。
 * 一次「删掉字段」的实测同时钉住了两件事。
 */
const FROZEN_BLOCKS = [
  {
    type: 'paragraph',
    content: 'P{X=x,Y=y}',
    translations: {},
    metadata: { pageNumber: 1, ocrConfidence: 95 },
  },
  {
    type: 'paragraph',
    content: '均',
    translations: {},
    metadata: { pageNumber: 1, ocrConfidence: 95 },
  },
  {
    type: 'paragraph',
    content: 'N(0，σ$^{²}$)',
    translations: {},
    metadata: { pageNumber: 1, ocrConfidence: 95, hasInlineMath: true },
  },
  {
    type: 'paragraph',
    content: 'Z = √X2 + Y',
    translations: {},
    metadata: { pageNumber: 1, ocrConfidence: 95 },
  },
  { type: 'paragraph', content: '2', translations: {}, metadata: { pageNumber: 1, ocrConfidence: 95 } },
  {
    type: 'paragraph',
    content: '=∼∼∼',
    translations: {},
    metadata: { pageNumber: 1, ocrConfidence: 95 },
  },
];

/** 导出里的 `blocks`（`hasInlineMath` 是 `metadata.hasInlineMath === true`） */
const FROZEN_STRUCTURE_BLOCKS = [
  { type: 'paragraph', content: 'P{X=x,Y=y}', hasInlineMath: false },
  { type: 'paragraph', content: '均', hasInlineMath: false },
  { type: 'paragraph', content: 'N(0，σ$^{²}$)', hasInlineMath: true },
  { type: 'paragraph', content: 'Z = √X2 + Y', hasInlineMath: false },
  { type: 'paragraph', content: '2', hasInlineMath: false },
  { type: 'paragraph', content: '=∼∼∼', hasInlineMath: false },
];

/** 只有第 15 词那一行判出了上下标（`²`）；其余行都是 false */
const FROZEN_HAS_SCRIPTS = [false, false, true, false, false, false];

const FROZEN_LINE_TEXTS = [
  'P{X=x,Y=y}',
  '均',
  'N(0，σ$^{²}$)',
  'Z = √X2 + Y',
  '2',
  '=∼∼∼',
];

// ═══════════════════════════════════════════════════════════════
// 1. 真实数字：三个字段逐字对上
// ═══════════════════════════════════════════════════════════════

describe('机制 5 的三个量：真实导出上的取值', () => {
  it('⭐ 第 16 词指数里的 `2`：11.4 / 23 = 0.496（分母是全页最大的那个 `2`）', () => {
    // 整个字符框逐字对上 —— 六个字段一个都不许少、一个都不许错
    expect(charAt(structure, 1, W16_TWO_INDEX)).toEqual({
      char: '2',
      bbox: [536, 1456.9, 554, 1468.3],
      confidence: 0.7097,
      inkHeight: 11.4,
      pageMaxHeight: 23,
      heightRatio: 0.496,
    });
  });

  it('⭐ 两个**待定读数**在导出里是可区分的（0.496 vs 0.543）—— 1 位小数就分不开了', () => {
    const two = charAt(structure, 1, W16_TWO_INDEX);
    // 分子是这一个字符自己的墨迹高；分母是**全页最大**的 `2`（第 22 词 23），
    // 不是第 3/9 词的 21 / 20.4 —— 取最大值而不是某个中间读数，见
    // `SCRIPT_MECH5_SCALEDOWN_RATIO`（「只以缩小形态出现」的字符必须得到 1）。
    expect(two.inkHeight).toBe(11.4);
    expect(two.pageMaxHeight).toBe(23);

    // 数值探针：若只认「21+」那个最保守的读数，比值是 0.543。
    // 两个读数都 < 0.8（所以「接受」这个结论不靠卡边界），但它们**不同** ——
    // 而这正是下次要看的那个量（离阈值还有多远），不能被舍入抹掉。
    const conservative = Math.round((11.4 / 21) * 1000) / 1000;
    expect(conservative).toBe(0.543);
    expect(conservative).toBeGreaterThan(two.heightRatio!);
    expect(conservative).toBeLessThan(SCRIPT_MECH5_SCALEDOWN_RATIO);
    expect(two.heightRatio!).toBeLessThan(SCRIPT_MECH5_SCALEDOWN_RATIO);

    // 反例：1 位小数会把两者都写成 0.5
    const round1 = (v: number): number => Math.round(v * 10) / 10;
    expect(round1(two.heightRatio!)).toBe(round1(conservative));
  });

  it('⭐ 第 20 词的 `∼`：5.1 / 5.1 = 1.0（它在本页只有缩小形态 → H 就是它自己）', () => {
    // `PAGE` 里三个 `∼` 是三个词，下标 3/4/5 —— 逐个查，别只看第一个
    for (let i = 3; i <= 5; i++) {
      expect(charAt(structure, i, 0)).toMatchObject({
        char: '∼',
        inkHeight: 5.1,
        pageMaxHeight: 5.1,
        heightRatio: 1,
      });
    }
    // 表里 `∼` 就是 5.1（三个实例一样高；没有任何一个全尺寸实例）
    expect(sizeTable!.get('∼')).toBeCloseTo(5.1, 6);
    // 机制 5 的方向：比值 1.0 **不**小于 0.8 → 它不算「被缩小了」→ 拒绝。
    // 这一条正是三个 `∼` 误判被挡住的依据（改判据时别把它改反）。
    expect(1).toBeGreaterThanOrEqual(SCRIPT_MECH5_SCALEDOWN_RATIO);
  });

  it('拒绝侧最紧的那个数也一致：第 16 词的 `=` 是 6.1 / 6.2 = 0.984（第 20 词提供分母）', () => {
    expect(charAt(structure, 1, W16_EQ_INDEX)).toMatchObject({
      char: '=',
      inkHeight: 6.1,
      pageMaxHeight: 6.2,
      heightRatio: 0.984,
    });
    // 0.984 > 0.8 → 拒绝；这正是源码注释里「门槛必须落在 0.543 与 0.984 之间」
    // 的那个上界，导出里现在能直接读到它
    expect(0.984).toBeGreaterThan(SCRIPT_MECH5_SCALEDOWN_RATIO);
  });

  it('空白位：三个字段**都写出来**，值都是 `null`（不是缺字段，也不是 0）', () => {
    // 第 16 词的 4 个空格（下标 1/3/7/9）
    for (const i of [1, 3, 7, 9]) {
      const entry = charAt(structure, 1, i);
      expect(entry.char).toBe(' ');
      expect(entry.inkHeight).toBeNull();
      expect(entry.pageMaxHeight).toBeNull();
      expect(entry.heightRatio).toBeNull();
      // 「写出来」这件事本身要能验证：键必须在
      expect(Object.keys(entry)).toEqual(
        expect.arrayContaining(['inkHeight', 'pageMaxHeight', 'heightRatio']),
      );
      // 与它对照：同一位置既没有墨迹、也没有置信度（两件事各自独立地如实）
      expect(entry.confidence).toBeNull();
    }
  });

  it('第 15 词的 `²`（U+00B2）：`inkHeight` 有值，但**没有基准** → 后两个是 `null`', () => {
    const entry = charAt(structure, 0, 5);
    expect(entry.char).toBe('²');
    expect(entry.bbox).toEqual([1176, 1404.1, 1192, 1414.2]); // 横向也是真实值
    expect(entry.inkHeight).toBe(10.1);
    // 建表刻意排除「本身即 Unicode 上下标」的字符（让天生就矮的形态去定义
    // 「全尺寸」是语义错误）—— 所以表里没有 `²` 这个键
    expect(sizeTable!.has('²')).toBe(false);
    expect(entry.pageMaxHeight).toBeNull();
    expect(entry.heightRatio).toBeNull();
  });

  it('⭐ 49 高的坏框：`inkHeight` 照实写 49，但**没有成为基准**（`SCRIPT_OUTLIER_RATIO` 丢掉了它）', () => {
    const entry = charAt(structure, 7, W1_COMMA_INDEX);
    expect(entry.char).toBe(',');
    expect(entry.inkHeight).toBe(49);

    /**
     * 建表规则：超过**本词**像素高度中位数（17.9）1.5 倍的条目直接丢掉，
     * 所以坏框 49 进不了表 —— 表里的 `,` 是 8.2。
     *
     * ⚠️ 那 8.2 来自第 15 词的**全角** `，`：`charSizeKey` 会把全角折成
     * 半角（实测同一张图两次识别一次给 `（`、一次给 `(`，语义相同不该
     * 因此找不到基准）。这一条在这里顺带被验到了 —— 键的算法是判据用的
     * 那一个，导出没有另写一套。
     */
    expect(sizeTable!.get(',')).toBeCloseTo(8.2, 6);
    expect(sizeTable!.get(',')).not.toBe(49);
    expect(entry.pageMaxHeight).toBe(8.2);
    // 49 / 8.2 = 5.976：远大于 0.8 → 机制 5 判「它没有被缩小」→ 拒绝。
    // 方向是对的：一个量错位置的坏框不该被当成「被缩小的角标」。
    expect(entry.heightRatio).toBe(5.976);

    /**
     * 数值探针（同页、同一时刻的对照，不是推演）：第 15 词那个**正常**的
     * 全角逗号（h 8.2）比值是 8.2 / 8.2 = **1.000** → 拒绝 ✔。
     * 若坏框没被丢掉，表里的 `,` 会是 **49** → 同一个逗号的比值变成
     * 8.2 / 49 = **0.167 < 0.8** → 被放行 —— 恰好把「天生就矮」与
     * 「被缩小了」两件事搞反。所以「丢异常」不是洁癖，是判据的前提。
     */
    expect(charAt(structure, 0, 3)).toMatchObject({
      char: '，',
      inkHeight: 8.2,
      pageMaxHeight: 8.2,
      heightRatio: 1,
    });
    expect(Math.round((8.2 / 49) * 1000) / 1000).toBe(0.167);
    expect(8.2 / 49).toBeLessThan(SCRIPT_MECH5_SCALEDOWN_RATIO);
  });

  it('`inkHeight` 非空 ⟹ 一定是正数（量到墨迹才写值，`measureCharPixelSpans` 保证 `y1 > y0`）', () => {
    for (const word of structure.words) {
      for (const entry of word.chars ?? []) {
        if (entry.inkHeight === null) continue;
        expect(entry.inkHeight).toBeGreaterThan(0);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. 复用同一张表（不是另建一份统计）
// ═══════════════════════════════════════════════════════════════

describe('导出与机制 5 用的是**同一张**页级表', () => {
  it('导出里每个字符的 `pageMaxHeight` 都等于 `buildCharSizeTable` 里那个键的值', () => {
    expect(sizeTable).not.toBeNull();
    let checked = 0;
    for (const word of structure.words) {
      for (const entry of word.chars ?? []) {
        const expected = sizeTable!.get(charSizeKey(entry.char));
        expect(entry.pageMaxHeight, `字符「${entry.char}」的基准`).toBe(
          expected === undefined ? null : Math.round(expected * 10) / 10,
        );
        checked++;
      }
    }
    // 夹具真的覆盖到了字符框（否则这条用例是空转）
    expect(checked).toBeGreaterThan(20);
  });

  it('比值自洽：`heightRatio × pageMaxHeight` 就是 `inkHeight`（三个数能互相复核）', () => {
    for (const word of structure.words) {
      for (const entry of word.chars ?? []) {
        if (entry.heightRatio === null) continue;
        expect(Math.round(entry.heightRatio * entry.pageMaxHeight! * 10) / 10).toBe(entry.inkHeight);
      }
    }
  });

  it('整页只有一个词提供字符框时**没有表**：`inkHeight` 仍有值，后两个一律 `null`', () => {
    // `SCRIPT_MECH5_MIN_WORDS = 2`：单词页上 `H = h` 是恒等式而不是测量，
    // 所以表为 null、机制 5 不启用 —— 导出要如实反映这件事
    expect(buildCharSizeTable([W16])).toBeNull();

    const single = buildOcrStructure({
      pageNum: 1,
      dominantFontSize: 20,
      words: [W16],
      lines: [],
      blocks: [],
    });
    expect(single.words[0]?.chars).toHaveLength(W16.text.length);
    for (const entry of single.words[0]!.chars!) {
      if (entry.char.trim()) expect(entry.inkHeight).toBeGreaterThan(0);
      expect(entry.pageMaxHeight).toBeNull();
      expect(entry.heightRatio).toBeNull();
    }
    // 对照：同一份词放进这一页就该有基准（`2` → 23）
    expect(charAt(structure, 1, W16_TWO_INDEX).pageMaxHeight).toBe(23);
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. 可见性规则与既有做法一致
// ═══════════════════════════════════════════════════════════════

describe('字段的可见性：没有字符框 ≠ 字符框为空', () => {
  it('拿不到字符框的词**不写** `chars`（既有行为，加字段没有改变它）', () => {
    const entry = wordEntry(structure, '均');
    expect('chars' in entry).toBe(false);
    expect(entry.chars).toBeUndefined();
  });

  it('有字符框的词：三个字段在**每一位**上都写出来（含空白位）', () => {
    const withChars = structure.words.filter((w) => w.chars?.length);
    // `PAGE` 里有字符框的是 8 个词（＋1 个没有字符框的 `均`）
    expect(withChars).toHaveLength(8);
    expect(structure.wordsWithChars).toBe(8);
    expect(structure.wordsTotal).toBe(9);
    for (const word of withChars) {
      for (const entry of word.chars!) {
        expect(Object.keys(entry)).toEqual(
          expect.arrayContaining(['inkHeight', 'pageMaxHeight', 'heightRatio']),
        );
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. 不变量：导出内容变了，识别结果逐字节不变
// ═══════════════════════════════════════════════════════════════

describe('纯增量：加了三个字段，识别结果逐字节不变', () => {
  it('这份夹具真的判出了上下标（否则下面那条不变量没有牙齿）', () => {
    // 第 15 词的 `²` 走「本身即 Unicode 上下标」的例外 → 应当被包成 `$^{²}$`
    expect(blocks.some((b) => b.content.includes('$^{²}$'))).toBe(true);
    expect(blocks.some((b) => b.metadata.hasInlineMath === true)).toBe(true);
  });

  it('⭐ `blocks` 与冻结下来的字面量完全一致', () => {
    expect(blocks).toEqual(FROZEN_BLOCKS);
    expect(structure.blocks).toEqual(FROZEN_STRUCTURE_BLOCKS);
  });

  it('`lines[].hasScripts` 与冻结值一致（判据的结论没有动）', () => {
    expect(structure.lines.map((l) => l.hasScripts)).toEqual(FROZEN_HAS_SCRIPTS);
    expect(structure.lines.map((l) => l.text)).toEqual(FROZEN_LINE_TEXTS);
  });

  it('带回调与不带回调得到的内容块完全一致（导出仍然是纯旁路）', () => {
    const withoutCallback = ocrResultToBlocks({ pageNum: 1, words: PAGE, avgConfidence: 95 });
    expect(blocks).toEqual(withoutCallback);
  });
});
