import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  LAYOUT_LABELS,
  compareLayoutAndGeometricDecisions,
  furnitureRegionOfLine,
  lineLabelFromWords,
  renderLayoutDecisionTable,
  summarizeLayoutDecisions,
  type LayoutDecisionRow,
  type LayoutRegion,
} from '@/lib/layoutAnalysis';

/**
 * ⓪ 「拿真实区域与几何启发式逐行对照」—— **合成对照**
 *
 * ═══════════════════════════════════════════════════════════════
 * ⚠️ 先说清楚：真实那 30 个区域上的对照**未做**，因为缺完整导出
 * ═══════════════════════════════════════════════════════════════
 *
 * 用户那份导出里 `layout` 字段第一次报了成功：
 *
 *     { "used": true, "code": "none", "regionCount": 30,
 *       "width": 1667, "height": 2223 }
 *
 * 这**确实**证明版面模型第一次真的跑起来了（`HANDOFF.md` §5.11.7 一直
 * 写着「从未在真实数据上跑过推理」）。但它**不足以**做逐行对照，因为：
 *
 *   1. `OcrStructureLayout` **只有那五个字段** —— 它**既没有类别名，
 *      也没有坐标**（见 `src/lib/ocrStructure.ts`，本任务不许改）。
 *      「30 个区域」是一个**计数**，不是 30 条数据；
 *   2. 因此「这 30 个区域分别是什么类别、盖住哪些行」**无从得知**。
 *      本文件**绝不**替它们编一套类别 —— 编出来的表看起来会很像结论，
 *      而那正是最危险的假证据（本项目已经吃过 5 次「假保护」的亏）。
 *
 * 所以本文件做两件事，两件都**不假装有真实数据**：
 *
 *   · **A. 合成对照**（下面 `SYNTHETIC_*`）：用**结构上与用户那页同形**
 *     的合成页（同一画布 1667×2223、页眉在版心内、页脚与正文同字号）
 *     把对照口径**逐行钉死**。它证明的是「这个对照本身可靠」；
 *   · **B. 取数路径**（文件末尾的 `describe`）：写清做完真实对照还需要
 *     什么数据、从哪取 —— 其中一条已经在本次改动里补上了
 *     （`[layoutAnalysis] layout-dump` 那一行）。
 *
 * ⚠️ **合成数据的边界（这一段必须留着）**：下面这 30 个区域是**按用户
 * 那页的实测特征构造的**（画布尺寸取自用户的导出原文；页眉 y=[50,110]、
 * 页脚 y≈[2080,2150] 的位置取自 `ocrPostProcess.layout.test.ts` 里
 * 已存在的同名坐标）。它们**不是**用户那 30 个区域。任何把本文件的数字
 * 当成「真实精度」的读法都是错的 —— 文件里每一个数字都由断言钉住，
 * **没有一个是手抄的**。
 */

/**
 * ═══════════════════════════════════════════════════════════════
 * 让「成功推理」这条路在本机可走（与 `layoutFailure.test.ts` 同一套手法）
 * ═══════════════════════════════════════════════════════════════
 *
 * `analyzePageLayout` 用**动态** `import('onnxruntime-web')` 拿运行库；
 * `vi.mock` 对它同样生效（`layoutFailure.test.ts` 已实测确认）。因此不需要
 * 浏览器、不需要 ONNX 运行时、不需要那 4.7MB 模型文件，就能把
 * 「模型真的给出了 3 个区域」这条路径走完 —— 而 `layout-dump` 那一行
 * **只在成功路径上**打印，所以这是测它的唯一办法。
 */
const ortMock = vi.hoisted(() => ({
  outputs: {} as Record<string, { data: ArrayLike<number> }>,
}));

vi.mock('onnxruntime-web', () => ({
  env: { wasm: { wasmPaths: '', numThreads: 0 }, versions: { web: 'test', common: 'test' } },
  Tensor: class {
    constructor(
      public type: string,
      public data: unknown,
      public dims: unknown,
    ) {}
  },
  InferenceSession: {
    create: async () => ({ run: async () => ortMock.outputs }),
  },
}));

/** 一路模型输出（扁平行优先数组）：header、formula、footer 各一个 */
function healthyOutputs() {
  const rows = [
    // [class_id, score, x1, y1, x2, y2]
    [13, 0.94, 300, 20, 700, 60],
    [7, 0.88, 95, 400, 900, 560],
    [15, 0.9, 300, 1300, 700, 1340],
  ];
  return {
    fetch_name_0: { data: Float32Array.from(rows.flat()) },
    fetch_name_1: { data: Int32Array.from([rows.length]) },
  };
}

/**
 * 一个**能被读出像素**的源：给全局补一个最小的 `ImageData`。
 *
 * ⚠️ 必须补，否则 `readPixels` 的两个分支在 node 环境里只剩
 * 「`typeof document === 'undefined'` → 抛错」这一条，成功路径根本不可达
 * （`layoutFailure.test.ts` 的第一版就是这样，9 条全红）。
 */
class FakeImageData {
  readonly data: Uint8ClampedArray;
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < this.data.length; i++) this.data[i] = (i * 37) % 256;
  }
}

const canvasLike = (width: number, height: number): ImageData =>
  new FakeImageData(width, height) as unknown as ImageData;

beforeEach(() => {
  ortMock.outputs = healthyOutputs();
  vi.stubGlobal('ImageData', FakeImageData);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 与仓库既有测试同一个 helper 口径：w(text, x, y, h, width, confidence) */
const w = (text: string, x: number, y: number, h: number, width = 30, confidence = 90) => ({
  text,
  confidence,
  bbox: { x0: x, y0: y, x1: x + width, y1: y + h },
  fontSize: h,
});

/** 用户那份导出的**真实画布尺寸**（不是猜的：`layout.width/height` 原文） */
const CANVAS = { width: 1667, height: 2223 };

/** 那页的正文字号（与 `ocrPostProcess.layout.test.ts` 的既有用例同口径） */
const BODY = 42;

/** 构造一个区域（坐标与词框同一坐标系） */
const r = (
  label: string,
  classId: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  score = 0.9,
): LayoutRegion => ({ label, classId, score, x0, y0, x1, y1 });

/**
 * ═══════════════════════════════════════════════════════════════
 * 合成页的 7 行 —— 每一行都对应一个**已登记的已知缺陷**
 * ═══════════════════════════════════════════════════════════════
 *
 *  1. `概率论与数理统计习题5` —— 用户在 `3d4a2ad` 报障的**页眉**：
 *     字号 42 = 正文（不满足「更小」），位置 y=62 落在 5% 上边距内；
 *  2/3. 两行正文续行；
 *  4. `Z= 当X>Y …` —— **`HANDOFF.md` §5.11.1 表里「三行公式被误判成
 *     大标题」的第 1 行**（实测字号 78.7 > 中位数 42 × 1.3 = 54.6）；
 *  5. `fz(e)= 0 0, 其他` —— 同上第 2 行（实测字号 87.5）；
 *  6. 一行正文；
 *  7. `单周周一下午2点前交作业` —— 用户在 `3d4a2ad` 报障的**页脚**：
 *     字号 42 = 正文，且 y=2090 **不在** 5% 下边距里（门槛 2111.85）。
 */
const SYNTHETIC_LINES = [
  { text: '概率论与数理统计习题5', x: 300, y: 62, h: BODY, width: 344 },
  { text: '设随机变量X与Y相互独立', x: 100, y: 212, h: BODY, width: 700 },
  { text: '且都服从参数为p的几何分布', x: 100, y: 300, h: BODY, width: 700 },
  {
    text: 'Z= 当X>Y 其中λ>0，μ>0是常数.引入随机变量=10, 当X>Y',
    x: 100,
    y: 420,
    h: 78.7,
    width: 1300,
  },
  { text: 'fz(e)= 0 0, 其他', x: 100, y: 560, h: 87.5, width: 600 },
  { text: '求P 的值。', x: 100, y: 700, h: BODY, width: 300 },
  { text: '单周周一下午2点前交作业', x: 700, y: 2090, h: BODY, width: 401 },
];

const syntheticWords = () =>
  SYNTHETIC_LINES.map((l) => w(l.text, l.x, l.y, l.h, l.width));

/**
 * 合成页的**行结构**（`LayoutDecisionLineLike`）。
 *
 * ⚠️ 本合成页**一行一个词** —— 中文习题页的实测形态就是这种
 * （一整行落在同一个检测框里）。所以 `words: [word]` 不是简化，
 * 而是与那页的真实形态一致。「一行多个词」的票数口径在下面单独测。
 *
 * ⚠️ 必须带上 `y` 与 `text`：第一版只给了 `words`，结果对照表的
 * 「行文本」整列是空的、y 全是 0（判定列却全对）—— 那是最坏的一种错，
 * 因为表看起来是完整的。所以下面**逐行取回原文**，让这张表能对上页面。
 */
const syntheticLines = () => {
  const words = syntheticWords();
  return SYNTHETIC_LINES.map((l, i) => ({ y: l.y, text: l.text, words: [words[i]!] }));
};

/**
 * ═══════════════════════════════════════════════════════════════
 * 合成区域：**30 个** —— 与用户导出里的 `regionCount: 30` 同规模
 * ═══════════════════════════════════════════════════════════════
 *
 * ⚠️ **这 30 个是我构造的，不是用户那 30 个。** 构造依据只有两条：
 *   ① 官方 `PP-DocLayout-S` 的 23 类里，一份中文扫描习题页**合理**会出现
 *      哪些（页眉/页脚/页码/正文/公式/图/图注/表/表注/脚注/侧栏/印章）；
 *   ② 用户那页的实测特征（画布 1667×2223、页眉在版心内、页脚同字号）。
 *
 * `classId` 逐条对齐 `LAYOUT_LABELS` 的顺序 —— 错一位就会把页脚认成公式
 * 且**不报错**，所以下一组用例会逐条验证这个对齐。
 */
const SYNTHETIC_REGIONS: LayoutRegion[] = [
  // ── 页眉带（y ≈ 50–110）：3 个 ────────────────────────────────
  r('header_image', 20, 60, 50, 260, 110, 0.55),
  r('header', 13, 280, 50, 660, 110, 0.94),
  r('header_image', 20, 1420, 50, 1620, 110, 0.51),
  // ── 正文带（y ≈ 200–780）：含两行被误判成大标题的公式 ──────────
  r('text', 2, 90, 200, 1560, 260, 0.96),
  r('text', 2, 90, 288, 1560, 348, 0.96),
  r('paragraph_title', 0, 90, 380, 700, 418, 0.81),
  r('formula', 7, 95, 405, 1450, 510, 0.88),
  r('formula', 7, 95, 545, 760, 655, 0.9),
  r('formula_number', 19, 1470, 545, 1560, 655, 0.72),
  r('text', 2, 90, 688, 460, 748, 0.95),
  r('figure_title', 6, 90, 800, 620, 840, 0.77),
  r('image', 1, 90, 860, 800, 1240, 0.93),
  r('chart', 18, 860, 860, 1560, 1240, 0.86),
  r('chart_title', 17, 860, 1258, 1560, 1298, 0.74),
  r('table', 8, 90, 1350, 1560, 1700, 0.89),
  // ── 表注 / 脚注带：4 个 ──────────────────────────────────────
  r('table_title', 9, 90, 1718, 700, 1758, 0.71),
  r('footnote', 12, 90, 1790, 900, 1860, 0.83),
  r('abstract', 4, 950, 1790, 1560, 1860, 0.69),
  r('reference', 10, 90, 1880, 900, 1940, 0.76),
  // ── 页脚带：3 个 ─────────────────────────────────────────────
  r('aside_text', 22, 60, 1990, 240, 2060, 0.58),
  r('footer', 15, 690, 2080, 1110, 2150, 0.92),
  r('number', 3, 800, 2170, 870, 2210, 0.9),
  // ── 页边零散区域（把总数凑到与用户导出相同的 30）：8 个 ────────
  r('seal', 16, 1500, 1800, 1620, 1920, 0.66),
  r('figure_title', 6, 860, 1308, 1560, 1340, 0.7),
  r('text', 2, 90, 1960, 1560, 1990, 0.82),
  r('paragraph_title', 0, 90, 1300, 500, 1330, 0.68),
  r('text', 2, 100, 1000, 130, 1020, 0.5),
  r('formula', 7, 100, 1050, 130, 1070, 0.5),
  r('content', 5, 1400, 1400, 1560, 1440, 0.64),
  r('text', 2, 100, 1150, 130, 1170, 0.5),
];

/** 对照表的一次调用（口径在 `compareLayoutAndGeometricDecisions` 的注释里） */
const decisionRows = (): LayoutDecisionRow[] =>
  compareLayoutAndGeometricDecisions(
    syntheticLines(),
    SYNTHETIC_REGIONS,
    CANVAS,
    // 进入 `applyLayoutToLines` 的行**都已经通过** `filterHeaderFooter`，
    // 所以几何判定在这条链路上恒为 `'kept'`。这是口径，不是简化。
    () => 'kept',
  );

describe('⓪ 逐行对照：合成页（**不是**用户那 30 个区域）', () => {
  it('合成数据自洽：30 个区域，且 classId 与 LAYOUT_LABELS 逐条对得上', () => {
    // ⚠️ 这条不是凑数：`classId` 与类别名错位是**不会报错**的错误
    // （HANDOFF §5.11.3 明文：「顺序不能改，错一位会把页脚认成公式且不报错」）。
    // 合成数据也必须守这条，否则整张对照表都是错的。
    expect(SYNTHETIC_REGIONS).toHaveLength(30);
    for (const region of SYNTHETIC_REGIONS) {
      expect(LAYOUT_LABELS[region.classId], `classId ${region.classId} 与类别名不符`).toBe(
        region.label,
      );
    }
  });

  it('对照表逐行给出两个判定（7 行，无一遗漏、顺序按 y）', () => {
    const table = decisionRows();
    expect(table).toHaveLength(7);
    expect(table.map((row) => row.text)).toEqual(SYNTHETIC_LINES.map((l) => l.text));
    expect(table.map((row) => row.index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(table.map((row) => row.y)).toEqual(SYNTHETIC_LINES.map((l) => l.y));
  });

  it('页眉行：几何判「留」、版面判「家具」→ `differ`，约定上更可能是版面对', () => {
    const header = decisionRows()[0]!;
    expect(header.geometric).toBe('kept');
    expect(header.layout).toBe('furniture');
    expect(header.layoutLabel).toBe('header');
    expect(header.agreement).toBe('differ');
    expect(header.preferred).toBe('layout');
    // 票数是**证据**：过半数词落在 header 区域（x∈[280,660]）
    expect(header.layoutVotes).toBeGreaterThan(header.wordCount / 2);
    expect(header.layoutTotal).toBe(header.wordCount);
    expect(header.layoutScore).toBeCloseTo(0.94, 5);
  });

  it('页脚行：几何判「留」（**不在 5% 边距里**）、版面判「家具」→ `differ`', () => {
    const footer = decisionRows()[6]!;
    // 这条断言就是本对照表存在的理由：画布高 2223 的 5% 门槛是 2111.85，
    // 而这一行 y=2090 **在门槛之上** —— 字号判据也无效（与正文同字号）。
    expect(2090).toBeLessThan(CANVAS.height * 0.95);
    expect(footer.geometric).toBe('kept');
    expect(footer.layout).toBe('furniture');
    expect(footer.layoutLabel).toBe('footer');
    expect(footer.agreement).toBe('differ');
    expect(footer.preferred).toBe('layout');
  });

  it('公式行：几何判「留」、版面判 `content`（`formula`）→ `same`', () => {
    /**
     * ⚠️ 这一条是**重要的负面事实**，必须留着：T3 那个「公式免判大标题」
     * 的判据**不会**在这张表里显示为 `differ`，因为 `formula` 属于内容
     * 类别 —— 在「该不该丢」这个问题上，它与几何（留）**结论相同**。
     *
     * 也就是说：**这张对照表量不出 T3 的效果**。T3 改的是「块类型
     * （heading / paragraph）」，不是「行去留」。把这条写下来，
     * 是为了不让后来的人拿这张表当 T3 的证据（那是
     * `layoutCategoryUse.test.ts` 的事）。
     */
    const formula = decisionRows()[3]!;
    expect(formula.layout).toBe('content');
    expect(formula.layoutLabel).toBe('formula');
    expect(formula.agreement).toBe('same');
    expect(formula.preferred).toBeUndefined();
    expect(decisionRows()[4]!.layoutLabel).toBe('formula');
  });

  it('统计汇总与逐行表**恒等**（同一份数据，两种读法）', () => {
    const table = decisionRows();
    const summary = summarizeLayoutDecisions(table);

    expect(summary.total).toBe(table.length);
    expect(summary.same + summary.differ).toBe(summary.total);
    expect(summary.same).toBe(table.filter((x) => x.agreement === 'same').length);
    expect(summary.differ).toBe(table.filter((x) => x.agreement === 'differ').length);
    // 「版面额外摘掉的行」= 几何留、版面丢 —— 正是本次接入的收益面
    expect(summary.layoutCaught).toBe(
      table.filter((x) => x.geometric === 'kept' && x.layout === 'furniture').length,
    );
    // 反方向在**这条链路**上恒为 0：几何摘掉的行到不了 `applyLayoutToLines`。
    // 这个 0 的含义是「本层看不到」，不是「不存在」。
    expect(summary.geometricOnly).toBe(0);
    expect(summary.uncovered).toBe(0);

    // 逐类别计数必须与逐行表相加相同（同一份数据不能有两种答案）
    const fromRows: Record<string, number> = {};
    for (const row of table) {
      if (row.layout === 'uncovered') continue;
      fromRows[row.layoutLabel!] = (fromRows[row.layoutLabel!] ?? 0) + 1;
    }
    expect(summary.layoutByLabel).toEqual(fromRows);
  });

  it('两行分歧（页眉、页脚），其余 5 行一致 —— 数字全部由逐行表算出', () => {
    const table = decisionRows();
    const summary = summarizeLayoutDecisions(table);
    expect(summary.same).toBe(5);
    expect(summary.differ).toBe(2);
    expect(summary.layoutCaught).toBe(2);
    expect(table.filter((x) => x.agreement === 'differ').map((x) => x.index)).toEqual([0, 6]);
  });

  it('Markdown 表格能贴进 HANDOFF，且**表头写明「谁更可能对」是约定**', () => {
    const markdown = renderLayoutDecisionTable(decisionRows());
    const lines = markdown.split('\n');

    expect(lines[0]).toContain('几何判定');
    expect(lines[0]).toContain('版面判定');
    expect(lines[0]).toContain('是否一致');
    // ⚠️ 这句话必须跟着表走：一张看起来像判决书的表比没有表更危险
    expect(lines[0]).toContain('约定，非真值');
    expect(lines).toHaveLength(2 + 7); // 表头 + 分隔行 + 7 行数据
    expect(lines[2]).toContain('概率论与数理统计习题5');
    expect(lines[2]).toContain('| header |');
    expect(lines[8]).toContain('| footer |');
    // 每一行的列数必须与表头一致（否则 Markdown 会渲染错位）
    const columns = lines[0]!.split('|').length;
    for (const line of lines.slice(2)) expect(line.split('|').length).toBe(columns);
  });

  it('没有区域时对照表是**空表**（而不是「全部一致」）', () => {
    // ⚠️ 「没有模型」与「模型说全都一致」是完全不同的两件事。
    // 返回「全部 same」会让统计显示一次**虚假的完全一致**。
    expect(
      compareLayoutAndGeometricDecisions(syntheticLines(), undefined, CANVAS, () => 'kept'),
    ).toEqual([]);
    expect(compareLayoutAndGeometricDecisions(syntheticLines(), [], CANVAS, () => 'kept')).toEqual(
      [],
    );
    expect(renderLayoutDecisionTable([])).toContain('没有版面区域');
  });

  /**
   * ═══════════════════════════════════════════════════════════════
   * ⚠️ 这条用例是**变异测试逼出来的**（M10 第一轮变绿）
   * ═══════════════════════════════════════════════════════════════
   *
   * 把 `agree` 里的 `layout !== 'uncovered' && …` 删掉（也就是
   * **把「模型没框住这一行」当成「与几何一致」**），第一轮 65 条用例
   * **全绿** —— 也就是说原来没有任何用例真的覆盖那个条件。
   *
   * 为什么它值得一条专门的用例：`uncovered` 被算成 `same` 之后，
   * 汇总里的「一致行数」会把**模型根本没覆盖到的行**也算成一致，
   * 于是一页 7 行里 5 行没被覆盖时，报告会显示「5 行一致」——
   * 那是一个**看起来很好、实际什么都没测到**的数字。
   */
  it('模型没框住的行算 `differ`（不能算成「一致」）', () => {
    // 一行落在所有区域之外：y=1900 在两个带之间（页脚带从 2080 开始，
    // 而覆盖它的那些 region 只到 y=1990）
    const outside = { y: 2020, text: '这一行没有任何区域盖住', words: [w('这一行没有任何区域盖住', 100, 2020, 42, 400)] };
    const table = compareLayoutAndGeometricDecisions(
      [...syntheticLines(), outside],
      SYNTHETIC_REGIONS,
      CANVAS,
      () => 'kept',
    );
    const last = table[table.length - 1]!;

    expect(last.text).toBe('这一行没有任何区域盖住');
    expect(last.layout).toBe('uncovered');
    expect(last.layoutLabel).toBeUndefined();
    // 关键断言：**不是** same
    expect(last.agreement).toBe('differ');
    expect(last.preferred).toBe('unknown');

    // 而汇总必须如实计数（`uncovered` 与 `same` 是两个不同的桶）
    const summary = summarizeLayoutDecisions(table);
    expect(summary.uncovered).toBe(1);
    expect(summary.same).toBe(5); // 仍然只有那 5 行真的一致
    expect(summary.differ).toBe(3); // 页眉 + 页脚 + 这行未覆盖
  });

  it('行文本里的 `|` 与换行不会截断 Markdown 表格', () => {
    const lines = [
      { y: 200, text: '含|竖线', words: [w('含|竖线', 100, 200, 40, 300)] },
      { y: 300, text: '含\n换行', words: [w('含\n换行', 100, 300, 40, 300)] },
    ];
    const markdown = renderLayoutDecisionTable(
      compareLayoutAndGeometricDecisions(lines, SYNTHETIC_REGIONS, CANVAS, () => 'kept'),
    );
    const all = markdown.split('\n');

    /**
     * ⚠️ 数分隔符必须**跳过转义过的 `\|`**。
     *
     * 本用例第一版直接用 `line.split('|').length` 数列数，于是
     * 「含\|竖线」那一行数出来 13 列、别的行 12 列 —— 断言红了，
     * 但**红的原因是量法错了**，不是转义错了。这类「量错的仪器」
     * 正是本项目反复吃过亏的东西，所以这里把量法本身写清楚。
     */
    const delimiterCount = (line: string): number => {
      let count = 0;
      for (let i = 0; i < line.length; i++) {
        if (line[i] !== '|') continue;
        // 前置反斜杠数为奇数 → 这个 `|` 是转义的，不算分隔符
        let backslashes = 0;
        for (let j = i - 1; j >= 0 && line[j] === '\\'; j--) backslashes++;
        if (backslashes % 2 === 1) continue;
        count++;
      }
      return count;
    };

    const expected = delimiterCount(all[0]!);
    for (const line of all.slice(2)) expect(delimiterCount(line)).toBe(expected);
    // 竖线被转义（所以不会截断表格），而换行被压平在同一个单元格里
    expect(markdown).toContain('含\\|竖线');
    expect(markdown).not.toContain('含\n换行');
  });

  /**
   * ═══════════════════════════════════════════════════════════════
   * 对照表与**真正生效的判据**必须同源
   * ═══════════════════════════════════════════════════════════════
   *
   * 这张表若自己另算一套「哪一行落在哪个区域里」，它就会变成一份**关于
   * 它自己**的报告 —— 看起来很像证据，实际与生产判定毫无关系。
   *
   * 下面这条把两者钉在一起：表里判为 `furniture` 的行数，必须与
   * `furnitureRegionOfLine`（生产里真正用来摘行的那个函数）判为家具的
   * 行数**完全相等**。
   */
  it('对照表与生产判据同源：`furniture` 行数 = `furnitureRegionOfLine` 的行数', () => {
    const fromProduction = syntheticLines().filter((line) =>
      furnitureRegionOfLine(line, SYNTHETIC_REGIONS),
    ).length;
    const fromTable = decisionRows().filter((row) => row.layout === 'furniture').length;

    expect(fromProduction).toBe(2);
    expect(fromTable).toBe(fromProduction);
  });

  it('`lineLabelFromWords` 的票数口径：**过半数**才算，恰好一半不算', () => {
    const region = [r('formula', 7, 0, 0, 1000, 1000)];
    // 2 个词都在区域里 → 2/2 过半数
    expect(
      lineLabelFromWords({ words: [w('a', 10, 10, 20, 30), w('b', 50, 10, 20, 30)] }, region)?.votes,
    ).toBe(2);

    // 1/2 = 恰好一半 → **不算**（`count <= needed`，与生产判据同一口径）
    expect(
      lineLabelFromWords(
        { words: [w('a', 10, 10, 20, 30), w('b', 5000, 5000, 20, 30)] },
        region,
      ),
    ).toBeUndefined();

    // 3 个词里 2 个在区域里 → 2/3 过半数
    const match = lineLabelFromWords(
      {
        words: [w('a', 10, 10, 20, 30), w('b', 50, 10, 20, 30), w('c', 9000, 9000, 20, 30)],
      },
      region,
    );
    expect(match?.votes).toBe(2);
    expect(match?.total).toBe(3);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════
 * 取数路径：**真实那 30 个区域上要做完对照，还缺什么**
 * ═══════════════════════════════════════════════════════════════
 *
 * 这一组是**可执行的文档**：把「要什么数据、怎么取」钉成断言，
 * 于是将来真做了那次对照的人会看到自己是否满足前置条件。
 */
describe('⓪ 真实对照的前置条件（**未完成** —— 这里只写清门槛）', () => {
  it('已补上的取数通道：成功时控制台打出**全部类别与坐标**（单行 JSON）', async () => {
    /**
     * 本次改动在 `analyzePageLayout` 的成功分支加了一行
     * `[layoutAnalysis] layout-dump {…}`（单行 JSON，含 `byLabel` 与每个
     * 区域的 `label/classId/score/box`）。有了它，**用户只要再跑一次同一页、
     * 把控制台那行给我们**，真实对照就能做 —— 不需要改导出契约
     * （那是 T5 的事，本任务不许动那个文件）。
     *
     * ⚠️ 这条**真的走一遍成功推理**（只 mock `onnxruntime-web` 与
     * `ImageData`，与 `layoutFailure.test.ts` 同一套手法），
     * 而不是断言「源码里有这个字符串」—— 后者在函数被改成空实现时照样绿。
     */
    const { analyzePageLayout, resetLayoutSessionForTest, clearPageLayoutAnalysis } =
      await import('@/lib/layoutAnalysis');
    resetLayoutSessionForTest();
    clearPageLayoutAnalysis();

    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      const outcome = await analyzePageLayout(canvasLike(CANVAS.width, CANVAS.height));
      expect(outcome.outcome.code).toBe('none');

      const dumpLine = info.mock.calls
        .map((args) => String(args[0]))
        .find((line) => line.startsWith('[layoutAnalysis] layout-dump '));
      expect(dumpLine, '成功路径上必须打出 layout-dump').toBeDefined();

      const json = JSON.parse(dumpLine!.slice('[layoutAnalysis] layout-dump '.length)) as {
        count: number;
        byLabel: Record<string, number>;
        regions: { label: string; classId: number; score: number; box: number[] }[];
      };
      // mock 的三路输出：header、formula、footer（见 healthyOutputs）
      expect(json.count).toBe(3);
      expect(json.byLabel).toEqual({ header: 1, formula: 1, footer: 1 });
      // **坐标**是这张转储存在的理由之一（导出里没有它）。
      // 顺序是 (y0, x0)：header y=20 → formula y=400 → footer y=1300。
      expect(json.regions.map((x) => x.box)).toEqual([
        [300, 20, 700, 60],
        [95, 400, 900, 560],
        [300, 1300, 700, 1340],
      ]);
      // classId 与类别名必须一致 —— 错位不会报错，所以在这里钉住
      for (const region of json.regions) {
        expect(LAYOUT_LABELS[region.classId]).toBe(region.label);
      }
      // 单行 JSON：多一个换行就没法用 grep / 脚本累积
      expect(dumpLine).not.toContain('\n');
    } finally {
      info.mockRestore();
    }
  });

  it('现有导出**不足以**做逐行对照：`layout` 没有类别、也没有坐标', async () => {
    /**
     * 这条断言的是 `ocrStructure` 的**现状**（本任务不许改它）。
     * 「为什么真实对照做不了」在这里变成一个**可核对的事实**：
     * `OcrStructureLayout` 的字段里没有任何一个能回答
     * 「第 7 个区域是什么类别、盖住哪几行」。
     *
     * ⚠️ 若哪天 **T5** 把区域明细加进 `layout`，本用例会失败 ——
     * 而那次失败正好提醒接手者「现在可以做真实对照了」。
     */
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('./ocrStructure.ts', import.meta.url), 'utf8');
    const start = source.indexOf('export interface OcrStructureLayout');
    expect(start, '找不到 OcrStructureLayout —— 导出契约变了，本用例要重写').toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf('\n}', start));
    const fields = [...body.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]);

    // 现状：五个对外字段 + detail + 两个散文副本 + sites。**没有**区域明细。
    expect(fields).toEqual([
      'used',
      'code',
      'regionCount',
      'width',
      'height',
      'detail',
      'meaning',
      'nextAction',
      'sites',
    ]);
    for (const absent of ['labels', 'regions', 'boxes', 'byLabel']) {
      expect(fields).not.toContain(absent);
    }
    // 而 `regionCount` 是一个**计数**：它连「有几个页眉」都答不了
    expect(fields).toContain('regionCount');
  });
});
