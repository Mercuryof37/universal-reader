import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_LAYOUT_RELEASE_GATE,
  LAYOUT_LABELS,
  LAYOUT_MODEL_FILE,
  LAYOUT_MODEL_SHA256,
  boxIoU,
  evaluateLayoutPredictions,
  matchRegions,
  renderLayoutEvaluationReport,
  scrambleLabels,
  type LayoutBenchmarkIdentity,
  type LayoutEvalPage,
  type LayoutModelIdentity,
  type LayoutTruthRegion,
} from '@/lib/layoutAnalysis';
import {
  applyLayoutToLines,
  renderLayoutMetricsLine,
  type LayoutPageReport,
} from '@/lib/ocrPostProcess';

/**
 * T2：把「版面精度从未评估」变成**可发版指标**
 *
 * ═══════════════════════════════════════════════════════════════
 * 这一组测的是什么（以及**不**是什么）
 * ═══════════════════════════════════════════════════════════════
 *
 * 它测的是**计分器**：
 *   · 「真值 + 预测 → 逐类别 precision/recall + 发版结论」这条链路；
 *   · 分数必须连**基准标识**与**模型 sha256** 一起产出（MinerU 的
 *     「发版即报分、且分数挂在有名字的基准上」这条纪律）；
 *   · 负向测试：把预测里的 `header` 全改成 `text`，`header` 的 recall
 *     必须掉到 0 —— 证明这个计分器**真的在测量**，不是装饰。
 *
 * 它**不**测、也**不**声称：任何真实精度数字。
 *   ⚠️ 本文件里所有真值都是**合成**的（见下）。`HANDOFF.md` §5.11.7
 *   那条「**版面模型从未在真实数据上跑过推理**」在本任务结束时
 *   **仍然成立** —— 用户那份导出证明模型跑起来了，但它的
 *   `regionCount: 30` 是一个计数，既没有类别也没有坐标，
 *   因此**做不出**逐类别 precision/recall。
 *
 * ⚠️ **标注集还没建**：T2 的原始设计要 `scripts/__fixtures__/layout-truth/
 * *.json` 那样一份人工标注。本任务的文件边界只允许改
 * `layoutAnalysis.ts` / `ocrPostProcess.ts` 与版面相关测试，
 * 所以标注集**不存在**，这里的「真值」是合成页。
 * 一个真实基准的最低要求写在下面 `BENCHMARK` 的注释里。
 */

/**
 * 基准标识 —— **合成基准**，名字里就有 `synthetic`。
 *
 * ⚠️ 名字刻意取得不可能被误读成真实基准。将来真做人工标注时，
 * 应当换一个名字（例如 `ur-layout-bench`）并改 `version`，
 * 因为**同名不同版本的分数不可比**（与 MinerU 每次报分都写明
 * `OmniDocBench v1.5` / `v1.6` 是同一条纪律）。
 *
 * 建立真实基准的最低要求（至少这些，缺一条这份分数就不可比）：
 *   1. 20–30 页**用户痛点文档**（中文扫描习题 + 教材），不是 DocLayNet
 *      那种论文类版面（路线图 已说明版面类型不匹配）；
 *   2. 每页标注**区域类别 + bbox**，类别名取 `LAYOUT_LABELS` 的字符串；
 *   3. 先标「绝不能丢的正文」名单，再标「可以丢的页眉页脚」名单
 *      （与路线图 R10 第 3 步的「两份名单求交集」同一防错手法）；
 *   4. 至少单人双次 / 双人交叉各一遍，否则 `annotatedBy` 那一栏没有意义。
 */
const BENCHMARK: LayoutBenchmarkIdentity = {
  name: 'synthetic-smoke',
  version: 'v0',
  pageCount: 2,
  source: '**合成**（不是真实扫描件）—— 只为验证计分器本身',
  annotatedBy: '本测试文件（非人工标注）',
  annotatedAt: '2026-10-11',
};

/** 模型标识：与前两处常量**同源**，不是手抄的字符串 */
const MODEL: LayoutModelIdentity = {
  file: LAYOUT_MODEL_FILE,
  sha256: LAYOUT_MODEL_SHA256,
  upstreamMap: 70.9,
  upstreamMapBasis: '上游自评 mAP(0.5)，500 张中英文论文/报纸/试卷自建集',
};

const t = (label: string, x0: number, y0: number, x1: number, y1: number): LayoutTruthRegion => ({
  label,
  x0,
  y0,
  x1,
  y1,
});

/** 与仓库既有测试同一个 helper 口径：w(text, x, y, h, width, confidence) */
const w = (text: string, x: number, y: number, h: number, width = 30, confidence = 90) => ({
  text,
  confidence,
  bbox: { x0: x, y0: y, x1: x + width, y1: y + h },
  fontSize: h,
});

const headerBox = t('header', 280, 50, 660, 110);
const footerBox = t('footer', 690, 2080, 1110, 2150);
const textBox = t('text', 90, 200, 1560, 760);
const formulaBox = t('formula', 95, 405, 1450, 510);

/** 合成页：一页真值 + 一页「完美预测」 */
const perfectPages = (): LayoutEvalPage[] => [
  {
    pageId: 'synth-p1',
    width: 1667,
    height: 2223,
    truth: [headerBox, footerBox, textBox, formulaBox],
    predicted: [headerBox, footerBox, textBox, formulaBox].map((r) => ({ ...r })),
  },
];

describe('T2 计分器：真值 + 预测 → 逐类别 precision / recall', () => {
  it('完美预测：四类全中，微平均 = 1，门禁全过、可发版', () => {
    const report = evaluateLayoutPredictions(perfectPages(), BENCHMARK, MODEL);

    expect(report.categories).toHaveLength(23); // 逐类别表覆盖 LAYOUT_LABELS 全部
    expect(report.categories.map((c) => c.label)).toEqual([...LAYOUT_LABELS]); // 顺序固定

    for (const label of ['header', 'footer', 'text', 'formula']) {
      const score = report.categories.find((c) => c.label === label)!;
      expect(score, label).toMatchObject({ tp: 1, fp: 0, fn: 0, precision: 1, recall: 1, f1: 1 });
    }
    expect(report.micro).toEqual({ precision: 1, recall: 1, f1: 1 });
    expect(report.releasable).toBe(true);
    expect(report.gate.every((v) => v.pass)).toBe(true);
    // 匹配口径必须原样带出来 —— 分数脱离口径就不可比
    expect(report.matcher).toContain('IoU ≥ 0.5');
  });

  it('「分母为零」给 `null`，**不是** 0（没报过 ≠ 报错了）', () => {
    const report = evaluateLayoutPredictions(perfectPages(), BENCHMARK, MODEL);

    // 真值里没有、预测里也没有的类别：两个分数都无定义
    const seal = report.categories.find((c) => c.label === 'seal')!;
    expect(seal).toMatchObject({ tp: 0, fp: 0, fn: 0, precision: null, recall: null, f1: null });

    // 只报不中：precision 有定义（0），recall 无定义（真值里没有）
    const onlyFalsePositive: LayoutEvalPage[] = [
      {
        pageId: 'p',
        width: 1667,
        height: 2223,
        truth: [textBox],
        predicted: [{ ...textBox }, t('seal', 1400, 1400, 1500, 1500)],
      },
    ];
    const r2 = evaluateLayoutPredictions(onlyFalsePositive, BENCHMARK, MODEL);
    const seal2 = r2.categories.find((c) => c.label === 'seal')!;
    expect(seal2.precision).toBe(0);
    expect(seal2.recall).toBeNull();
  });

  it('⚠️ 负向测试：把所有 `header` 预测改成 `text` → `header` 的 recall 掉到 0', () => {
    /**
     * 这是 T2 验收标准里那条「证明脚本真的在测量，不是装饰」。
     * 做法与 `scripts/verify-dist.mjs` 的负向测试同形：
     * **人为把预测弄坏，看分数是否如期变坏**。
     *
     * ⚠️ 扰动器只改 `label`、**不动坐标**（见 `scrambleLabels` 的注释）：
     * 坐标一动就会连带改变 IoU 匹配，于是 recall 的下降无法归因。
     */
    const pages = perfectPages();
    const before = evaluateLayoutPredictions(pages, BENCHMARK, MODEL);
    expect(before.categories.find((c) => c.label === 'header')!.recall).toBe(1);

    const scrambled: LayoutEvalPage[] = pages.map((page) => ({
      ...page,
      predicted: scrambleLabels(page.predicted, 'header', 'text'),
    }));
    const after = evaluateLayoutPredictions(scrambled, BENCHMARK, MODEL);
    const afterHeader = after.categories.find((c) => c.label === 'header')!;

    expect(afterHeader.recall).toBe(0); // ← 掉到 0
    expect(afterHeader.fn).toBe(1);
    // 而错标的那一类多出一个 fp（错误**被记录在正确的类上**，不是凭空消失）
    expect(after.categories.find((c) => c.label === 'text')!.fp).toBe(1);
    // 发版门禁必须因此拦住：header recall 门槛 0.8
    expect(after.releasable).toBe(false);
    expect(after.gate.find((v) => v.label === 'header')!.pass).toBe(false);
  });

  it('⚠️ 负向测试②：把所有 `text` 预测改成 `image` → `text` 掉到零预测，门禁拦住', () => {
    const scrambled = perfectPages().map((page) => ({
      ...page,
      predicted: scrambleLabels(page.predicted, 'text', 'image'),
    }));
    const report = evaluateLayoutPredictions(scrambled, BENCHMARK, MODEL);
    const text = report.categories.find((c) => c.label === 'text')!;

    /**
     * ⚠️ 这里**实测**拿到了一个 `null`，而不是我原本以为的 `0` ——
     * 这条断言是本次发现门禁漏洞的现场：
     *
     *   `precision = tp / (tp + fp)`，而 `text` 的 `tp` 与 `fp` **都是 0**
     *   （预测全被改成了 `image`），所以 precision **无定义**。
     *   而 `null` 原来被当成「本轮未被检验 → 通过」。两者叠加 =
     *   **把某一类的预测全删掉，反而更容易过门禁**。
     *
     * 修法见 `LayoutReleaseGate.minPredictedCount`。这条用例现在同时钉住
     * 「分数如实为 `null`」与「门禁照样拦住」两件事。
     */
    expect(text.predictedCount).toBe(0);
    expect(text.precision).toBeNull();
    expect(text.recall).toBe(0);
    expect(text.fn).toBe(1);

    expect(report.releasable).toBe(false);
    const countGate = report.gate.find(
      (v) => v.label === 'text' && v.metric === 'predictedCount',
    )!;
    expect(countGate.pass).toBe(false);
    expect(countGate.note).toContain('都没报出来');
    // precision 那条门禁仍然「未被检验」（分数确实无定义），
    // 但 predictedCount 那条会拦住 —— 两层各说各的事实
    expect(report.gate.find((v) => v.label === 'text' && v.metric === 'precision')!.pass).toBe(
      true,
    );
  });

  it('IoU 门槛真的在起作用：框偏到 IoU = 0 就不算命中', () => {
    // 真值 header 是 [280,50,660,110]（380×60）。
    // 把它右移 380px（整整一个宽度）→ 与真值无交集 → IoU 0
    const shifted = t('header', 660, 50, 1040, 110);
    expect(boxIoU(headerBox, shifted)).toBe(0);

    const report = evaluateLayoutPredictions(
      [{ pageId: 'p', width: 1667, height: 2223, truth: [headerBox], predicted: [shifted] }],
      BENCHMARK,
      MODEL,
    );
    expect(report.categories.find((c) => c.label === 'header')!).toMatchObject({
      tp: 0,
      fp: 1,
      fn: 1,
      precision: 0,
      recall: 0,
    });
  });

  it('类别不同但框完全重合：**不算命中**（同类是硬条件）', () => {
    const report = evaluateLayoutPredictions(
      [
        {
          pageId: 'p',
          width: 1667,
          height: 2223,
          truth: [headerBox],
          predicted: [{ ...headerBox, label: 'footer' }],
        },
      ],
      BENCHMARK,
      MODEL,
    );
    expect(report.categories.find((c) => c.label === 'header')!).toMatchObject({ tp: 0, fn: 1 });
    expect(report.categories.find((c) => c.label === 'footer')!).toMatchObject({ tp: 0, fp: 1 });
  });

  /**
   * ═══════════════════════════════════════════════════════════════
   * ⚠️ 这条用例是**变异测试逼出来的**（M11 第一轮变绿）
   * ═══════════════════════════════════════════════════════════════
   *
   * 把 `matchRegions` 里的 `&& bestIou >= iouThreshold` 删掉
   * （也就是**只要有同类预测就配上，不管框对不对**），第一轮用例
   * **全绿** —— 原来那些「不命中」的例子（完全移位 IoU=0、
   * 类别不同）在新判据下**也**不命中，所以测不出来。
   *
   * 漏掉的正是中间那一段：**同类、有重叠，但 IoU 不够**。
   * 那一段才是 IoU 门槛真正在管的事，也是「框得多准」唯一能被量到的地方。
   */
  it('同类、有重叠但 IoU 不到门槛：**不命中**（这正是 IoU 门槛在管的那一段）', () => {
    // 真值 100×100；预测右移 30px → 交 70×100=7000，并 13000 → IoU ≈ 0.538
    const truth = t('text', 0, 0, 100, 100);
    const near = t('text', 30, 0, 130, 100);
    const iou = boxIoU(truth, near);
    expect(iou).toBeGreaterThan(0);
    expect(iou).toBeLessThan(1);

    // 门槛 0.6 时必须**不命中**，门槛 0.5 时必须命中 —— 同一个框，
    // 只改门槛就能翻转，证明这个参数真的在起作用（而不是被忽略）
    const strict = matchRegions([truth], [near], 0.6);
    expect(strict.tp.get('text') ?? 0).toBe(0);
    expect(strict.fn.get('text')).toBe(1);
    expect(strict.fp.get('text')).toBe(1);

    const loose = matchRegions([truth], [near], 0.5);
    expect(loose.tp.get('text')).toBe(1);
    expect(loose.fn.get('text') ?? 0).toBe(0);

    // 端到端也要能看出门槛：0.6 时这一类全错
    // ⚠️ 第 4 个参数是**门禁**、第 5 个才是 IoU 门槛（第一版把 0.6 传成了门禁，
    // 于是 `Object.entries(undefined)` 抛错 —— 参数位置错不会报类型错，
    // 因为签名是 `(pages, benchmark, model, gate?, iouThreshold?)`）。
    const report = evaluateLayoutPredictions(
      [{ pageId: 'p', width: 200, height: 200, truth: [truth], predicted: [near] }],
      BENCHMARK,
      MODEL,
      DEFAULT_LAYOUT_RELEASE_GATE,
      0.6,
    );
    expect(report.categories.find((c) => c.label === 'text')!).toMatchObject({
      tp: 0,
      fp: 1,
      fn: 1,
      recall: 0,
    });
  });

  it('`matchRegions` 的贪心一对一：一个预测不会被两个真值重复占用', () => {
    const a = t('text', 0, 0, 100, 100);
    const b = t('text', 0, 0, 100, 100); // 与 a 完全重合
    const m = matchRegions([a, b], [{ ...a }]);
    expect(m.tp.get('text')).toBe(1);
    expect(m.fn.get('text')).toBe(1);
    expect(m.fp.get('text') ?? 0).toBe(0);
  });
});

describe('T2 门禁：语义严格限定为「已登记的红线是否被踩」', () => {
  it('默认门禁压的类别与阈值**逐项点明**', () => {
    expect(DEFAULT_LAYOUT_RELEASE_GATE).toEqual({
      minRecall: { header: 0.8, footer: 0.8 },
      minPrecision: { text: 0.9 },
      // ⚠️ 这一条是**实测发现漏洞之后**补的：没有它，
      // 「把某一类的预测全删掉」会让 precision 变成 null 而被静默放行
      minPredictedCount: { text: 1, header: 1, footer: 1 },
    });
  });

  it('本轮没标注的类别：门禁**未被检验**，不算失败（否则会永久堵住发版）', () => {
    const report = evaluateLayoutPredictions(perfectPages(), BENCHMARK, MODEL);
    const pages: LayoutEvalPage[] = [
      { pageId: 'p', width: 100, height: 100, truth: [headerBox], predicted: [headerBox] },
    ];
    const r = evaluateLayoutPredictions(pages, BENCHMARK, MODEL);
    const footerGate = r.gate.find((v) => v.label === 'footer' && v.metric === 'recall')!;
    expect(footerGate.actual).toBeNull();
    expect(footerGate.pass).toBe(true);
    expect(footerGate.note).toContain('未被检验');
    // 而真实基准那一份（有 footer 真值）是检验过的
    expect(
      report.gate.find((v) => v.label === 'footer' && v.metric === 'recall')!.note,
    ).toBeUndefined();
  });

  it('门禁只是一条**红线**：全过不等于「够好」（报告里必须这么说）', () => {
    const markdown = renderLayoutEvaluationReport(
      evaluateLayoutPredictions(perfectPages(), BENCHMARK, MODEL),
    );
    expect(markdown).toContain('可发版');
    expect(markdown).toContain('**不表示模型够好**');
    expect(markdown).toContain('拦的是回归');
  });

  it('空评测集**当场抛错**（一个「全部分母为 0」的假报告比没有报告更糟）', () => {
    expect(() => evaluateLayoutPredictions([], BENCHMARK, MODEL)).toThrow(/至少要有一页真值/);
  });

  it('标注里写错类别名**当场抛错**，并且把页与错名都说出来', () => {
    const pages: LayoutEvalPage[] = [
      { pageId: 'typo-page', width: 100, height: 100, truth: [t('headerr', 0, 0, 10, 10)], predicted: [] },
    ];
    expect(() => evaluateLayoutPredictions(pages, BENCHMARK, MODEL)).toThrow(/typo-page.*headerr/);
  });

  it('画布尺寸非法**当场抛错**（否则 IoU 全 0，看起来像「模型全错」）', () => {
    const pages: LayoutEvalPage[] = [
      { pageId: 'bad', width: 0, height: 100, truth: [], predicted: [] },
    ];
    expect(() => evaluateLayoutPredictions(pages, BENCHMARK, MODEL)).toThrow(/bad.*0×100/);
  });
});

describe('T2 真实运行累积：`layout-metrics` 那一行', () => {
  /**
   * ═══════════════════════════════════════════════════════════════
   * 这一组是**变异测试逼出来的**（M13 第一轮变绿）
   * ═══════════════════════════════════════════════════════════════
   *
   * 第一版把 `JSON.stringify({...})` 直接写在 `console.info(...)` 里，
   * 于是把前缀 `layout-metrics` 改掉、把字段删掉，**都没有用例变红** ——
   * 也就是说「从真实运行里累积数字」这条通道的格式**零覆盖**。
   *
   * 现在它是一段导出纯函数（`renderLayoutMetricsLine`），
   * 于是格式可以被直接断言，不需要去抓控制台。
   */
  const metricsReport = (over: Partial<LayoutPageReport> = {}): LayoutPageReport => ({
    lineCount: 7,
    removedByLayout: 2,
    removedByLabel: { header: 1, footer: 1 },
    reordered: false,
    decisionRows: [],
    decisionSummary: {
      total: 7,
      same: 5,
      differ: 2,
      layoutCaught: 2,
      geometricOnly: 0,
      uncovered: 0,
      layoutByLabel: { header: 1, text: 4, formula: 2 },
    },
    headingUse: { layout_says_not_heading: 2, layout_says_paragraph_title: 1 },
    ...over,
  });

  it('固定前缀 + **单行** JSON（单行才能在真实运行里靠 grep 累积）', () => {
    const line = renderLayoutMetricsLine(metricsReport());
    expect(line.startsWith('[ocrPostProcess] layout-metrics {')).toBe(true);
    expect(line).not.toContain('\n');
    expect(line.split('\n')).toHaveLength(1);
  });

  it('字段名与 `LayoutPageReport` 一一对应（读的人不必猜哪个数是哪个）', () => {
    const json = JSON.parse(
      renderLayoutMetricsLine(metricsReport()).slice('[ocrPostProcess] layout-metrics '.length),
    ) as Record<string, unknown>;

    expect(json).toEqual({
      lineCount: 7,
      removedByLayout: 2,
      removedByLabel: { header: 1, footer: 1 },
      reordered: false,
      same: 5,
      differ: 2,
      layoutCaught: 2,
      uncovered: 0,
      headingUse: { layout_says_not_heading: 2, layout_says_paragraph_title: 1 },
    });
  });

  it('模型缺席时这一行仍然打出来，且**一眼看出什么都没发生**', () => {
    // 「全 0 的统计」与「根本没有模型」必须分得开：
    // 后者的 lineCount 是**真实行数**而版面计数为 0
    const absent = renderLayoutMetricsLine(
      metricsReport({
        removedByLayout: 0,
        removedByLabel: {},
        decisionRows: [],
        decisionSummary: {
          total: 0,
          same: 0,
          differ: 0,
          layoutCaught: 0,
          geometricOnly: 0,
          uncovered: 0,
          layoutByLabel: {},
        },
        headingUse: {},
      }),
    );
    const json = JSON.parse(
      absent.slice('[ocrPostProcess] layout-metrics '.length),
    ) as Record<string, unknown>;
    expect(json.lineCount).toBe(7); // 行数如实
    expect(json.removedByLayout).toBe(0);
    expect(json.removedByLabel).toEqual({});
    expect(json.headingUse).toEqual({});
  });

  it('这一行确实由 `applyLayoutToLines` 打出（不是一段没人调用的死代码）', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      const lines = [{ y: 62, text: '页眉', words: [w('页眉', 300, 62, 42, 344)] }];
      const regions = [
        { label: 'header', classId: 13, score: 0.94, x0: 280, y0: 50, x1: 660, y1: 110 },
      ];
      const applied = applyLayoutToLines(
        lines as unknown as Parameters<typeof applyLayoutToLines>[0],
        regions,
        1667,
      );
      expect(applied.lines).toHaveLength(0); // 那一行被摘掉了

      const line = info.mock.calls
        .map((args) => String(args[0]))
        .find((l) => l.startsWith('[ocrPostProcess] layout-metrics '));
      expect(line, 'applyLayoutToLines 必须打出这一行').toBeDefined();
      const json = JSON.parse(line!.slice('[ocrPostProcess] layout-metrics '.length)) as {
        removedByLayout: number;
        removedByLabel: Record<string, number>;
        layoutCaught: number;
      };
      expect(json.removedByLayout).toBe(1);
      expect(json.removedByLabel).toEqual({ header: 1 });
      expect(json.layoutCaught).toBe(1); // 几何判「留」、版面判「家具」
    } finally {
      info.mockRestore();
    }
  });
});

describe('T2 报告：分数必须挂在**有名字的基准**上', () => {
  const markdown = () =>
    renderLayoutEvaluationReport(evaluateLayoutPredictions(perfectPages(), BENCHMARK, MODEL));

  it('三行标识在最上面：基准名+版本、模型 sha256、匹配口径', () => {
    const lines = markdown().split('\n');
    expect(lines[0]).toContain('可发版');
    expect(lines[2]).toContain('`synthetic-smoke`');
    expect(lines[2]).toContain('**v0**');
    expect(lines[2]).toContain('2 页');
    expect(lines[3]).toContain(LAYOUT_MODEL_FILE);
    expect(lines[3]).toContain(LAYOUT_MODEL_SHA256.slice(0, 16));
    expect(lines[5]).toContain('IoU ≥ 0.5');
  });

  it('上游自评与本次分数**明确标注不可直接比较**', () => {
    // 上游 70.9 挂在它自己的 500 张自建集上；跨口径比较 mAP 是错的
    expect(markdown()).toContain('mAP(0.5) = 70.9');
    expect(markdown()).toContain('**与本表不可直接比较**');
  });

  it('逐类别表 23 行 + 微平均一行，且没有一列留空', () => {
    const lines = markdown().split('\n');

    // ⚠️ 用「**行首**是 `| \`xxx\` |` 且第二列是数字」来数，而不是按行号切片：
    // 切片假设了「表格后面紧跟着门禁表」这个版式，第一版就是这样数错的
    // （微平均被算在第 24 行，实际在第 25 行）。版式会变，行数不会。
    //
    // 也**不能**只用 `^\| \`[a-z_]+\` \|` 去数：门禁表的第一列也是
    // 反引号包起来的类别名（`| \`header\` | recall | …`），会被一起数进来
    // （第一版数出 29 行而不是 23 行）。逐类别的行第二列是**数字**。
    const isCategoryRow = (line: string): boolean => /^\| `[a-z_]+` \| \d+ \|/.test(line);
    const categoryRows = lines.filter(isCategoryRow);
    const microRows = lines.filter((l) => l.startsWith('| **微平均** |'));

    expect(categoryRows).toHaveLength(LAYOUT_LABELS.length); // 23 行
    expect(microRows).toHaveLength(1);

    for (const label of LAYOUT_LABELS) {
      const row = categoryRows.find((l) => l.startsWith(`| \`${label}\` |`));
      expect(row, label).toBeDefined();
      // 「没有定义」显示成 `—`，不是一个空格
      expect(row!.split('|').slice(2, -1).every((c) => c.trim().length > 0), label).toBe(true);
    }
  });

  it('基准标识的每一栏都是必填（缺 source/annotatedBy 的分数不可比）', () => {
    for (const key of ['name', 'version', 'source', 'annotatedBy', 'annotatedAt'] as const) {
      expect(BENCHMARK[key], key).toBeTruthy();
    }
    expect(BENCHMARK.pageCount).toBeGreaterThan(0);
    // 合成基准必须自报家门，不能看起来像真实评测
    expect(BENCHMARK.source).toContain('合成');
    expect(BENCHMARK.annotatedBy).toContain('非人工');
  });
});
