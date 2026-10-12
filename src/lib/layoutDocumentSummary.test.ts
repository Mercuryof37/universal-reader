import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  createLayoutSummaryAccumulator,
  ocrResultToBlocks,
  renderLayoutSummaryLine,
  renderLayoutMetricsLine,
  type LayoutPageReport,
} from '@/lib/ocrPostProcess';

/**
 * T2 文档级汇总：把逐页的 `LayoutPageReport` 累加成一个文档总数
 *
 * ═══════════════════════════════════════════════════════════════
 * 这一组测的是什么（以及**不**是什么）
 * ═══════════════════════════════════════════════════════════════
 *
 * 它测**累加**这一层：逐页报告 → 文档级总数，以及这个总数的**出口**
 * （单行 JSON，界面上可复制）。
 *
 * 它**不**测版面精度。本文件里所有页面都是合成的，与
 * `layoutReleaseMetrics.test.ts` 同一条纪律：**本项目没有任何真实标注集**，
 * 因此这里一个真实精度数字都没有（要那个看 `npm run eval:layout`）。
 *
 * ⚠️ 「一页都没接入」与「接入了但什么都没改」必须分得开：
 * 前者是 `pages === 0`（下一步查模型有没有加载），
 * 后者是 `pages > 0` 且各项为 0（下一步查模型判得对不对）。
 * 下面有专门的用例钉住这个区分。
 */

/**
 * 与 `layoutReleaseMetrics.test.ts` 同一个 helper 口径。
 *
 * ⚠️ `decisionSummary.total` 刻意跟着 `lineCount` 走（默认 0 行 → total 0）：
 * `total > 0` 正是「这一页真的接入过版面」的判据（见
 * `createLayoutSummaryAccumulator` 里的 `layoutApplied`）。
 * helper 若把 total 恒定为 0，下面所有用例都会落在「模型缺席」那一路，
 * 于是它们测的其实是别的东西 —— 那种绿是假的。
 */
const pageReport = (over: Partial<LayoutPageReport> = {}): LayoutPageReport => {
  const lineCount = over.lineCount ?? 0;
  return {
    lineCount,
    removedByLayout: 0,
    removedByLabel: {},
    reordered: false,
    decisionRows: [],
    decisionSummary: {
      total: lineCount,
      same: 0,
      differ: 0,
      layoutCaught: 0,
      geometricOnly: 0,
      uncovered: 0,
      layoutByLabel: {},
    },
    headingUse: {},
    ...over,
  };
};

describe('T2 文档级汇总：逐页报告 → 一个总数', () => {
  it('空累加器的初值**逐项钉死**，且不会读到别的用例改过的值', () => {
    /**
     * ⚠️ 这条断言刻意写全：`createLayoutSummaryAccumulator` 每次都必须
     * 返回**全新**的累加器。若它误用了模块级单例，本文件里先跑的用例
     * 会把页数/行数留在那个对象里，这条就会红 —— 也就是说
     * 「读同进程里别的测试改过的当前值」这类问题在这里是被**主动检查**的。
     */
    const { summary } = createLayoutSummaryAccumulator(() => 1);

    expect(summary).toEqual({
      pages: 0,
      pagesWithLayout: 0,
      lastPageNum: null,
      lines: 0,
      removedByLayout: 0,
      removedByLabel: {},
      reorderedAny: false,
      reorderedPages: 0,
      decisions: { same: 0, differ: 0, layoutCaught: 0, geometricOnly: 0, uncovered: 0 },
      headingUse: {},
    });
  });

  it('两个累加器**互不影响**（不是共享的模块级状态）', () => {
    const a = createLayoutSummaryAccumulator(() => 1);
    const b = createLayoutSummaryAccumulator(() => 2);

    a.onPage(pageReport({ lineCount: 5, removedByLayout: 2 }));

    expect(a.summary.pages).toBe(1);
    expect(a.summary.lines).toBe(5);
    expect(b.summary.pages).toBe(0); // b 一个数都不该被 a 影响
    expect(b.summary.lines).toBe(0);
  });

  it('逐页累加：行数、摘掉的行、逐类别都求和', () => {
    const { onPage, summary } = createLayoutSummaryAccumulator(() => 1);
    let page = 1;

    onPage(pageReport({ lineCount: 7, removedByLayout: 2, removedByLabel: { header: 1, footer: 1 } }));
    page = 2;
    onPage(pageReport({ lineCount: 5, removedByLayout: 1, removedByLabel: { header: 1 } }));

    expect(summary.pages).toBe(2);
    expect(summary.lines).toBe(12);
    expect(summary.removedByLayout).toBe(3);
    // 同一类别跨页要**相加**，不是被后一页覆盖
    expect(summary.removedByLabel).toEqual({ header: 2, footer: 1 });
    expect(page).toBe(2);
  });

  it('`lastPageNum` 取**回调那一刻**的页码，而不是建累加器时的页码', () => {
    /**
     * ⚠️ 这正是 `pageNumOf` 做成**函数**而不是值的理由：
     * 累加器建在页面循环外面，若把 `pageNum` 的**值**捕获进来，
     * 整份文档都会被记成第一页 —— 而那种数看起来完全正常。
     */
    let current = 1;
    const { onPage, summary } = createLayoutSummaryAccumulator(() => current);

    onPage(pageReport({ lineCount: 3 }));
    expect(summary.lastPageNum).toBe(1);

    current = 9;
    onPage(pageReport({ lineCount: 3 }));
    expect(summary.lastPageNum).toBe(9); // 跟着走
  });

  it('`reordered`：记录「有没有」也记录「几页」（影响面）', () => {
    const { onPage, summary } = createLayoutSummaryAccumulator(() => 1);

    onPage(pageReport({ lineCount: 1 }));
    expect(summary.reorderedAny).toBe(false);
    expect(summary.reorderedPages).toBe(0);

    onPage(pageReport({ lineCount: 1, reordered: true }));
    onPage(pageReport({ lineCount: 1, reordered: true }));

    expect(summary.reorderedAny).toBe(true);
    expect(summary.reorderedPages).toBe(2);
  });

  it('`decisionSummary` 与 `headingUse` 逐项跨页求和', () => {
    const { onPage, summary } = createLayoutSummaryAccumulator(() => 1);

    onPage(
      pageReport({
        lineCount: 7,
        decisionSummary: {
          total: 7,
          same: 5,
          differ: 2,
          layoutCaught: 2,
          geometricOnly: 0,
          uncovered: 0,
          layoutByLabel: { header: 1, text: 4, formula: 2 },
        },
        headingUse: { layout_says_not_heading: 2 },
      }),
    );
    onPage(
      pageReport({
        lineCount: 3,
        decisionSummary: {
          total: 3,
          same: 1,
          differ: 2,
          layoutCaught: 1,
          geometricOnly: 0,
          uncovered: 1,
          layoutByLabel: { text: 3 },
        },
        headingUse: { layout_says_not_heading: 1, layout_says_paragraph_title: 1 },
      }),
    );

    expect(summary.decisions).toEqual({
      same: 6,
      differ: 4,
      layoutCaught: 3,
      geometricOnly: 0,
      uncovered: 1,
    });
    expect(summary.headingUse).toEqual({
      layout_says_not_heading: 3,
      layout_says_paragraph_title: 1,
    });
    // `layoutByLabel` **刻意不累加**：它就是逐行对照表按类别的分解，
    // 与 `decisionSummary` 是同一件事的两种切法。汇总里再放一份，
    // 读的人会以为它是另一个数。
    expect(summary).not.toHaveProperty('decisions.layoutByLabel');
  });

  it('⚠️ 「一次都没接入」与「接入了但什么都没改」必须分得开', () => {
    /**
     * ⚠️ 这条用例的**第一版是错的**，而且是被实测纠正的：
     * 原本假设「模型缺席 → 回调根本不进」，于是断死 `pages === 0`。
     * 实跑得到 `pages === 1` —— 因为 `applyLayoutToLines` 的**每一条**
     * 出口都会交出报告，包括「没有区域」那条短路（它交的是一份全 0 报告）。
     *
     * 所以「有没有接入」必须靠 `pagesWithLayout`（由
     * `decisionSummary.total > 0` 判出来），**不能**靠 `pages`、
     * 更不能靠 `removedByLayout === 0` 这种**结果**反推。
     */
    // ① 模型缺席：短路交出一份全 0 报告（`total` 恒为 0）
    const absent = createLayoutSummaryAccumulator(() => 1);
    absent.onPage(
      pageReport({
        lineCount: 12,
        decisionSummary: {
          total: 0,
          same: 0,
          differ: 0,
          layoutCaught: 0,
          geometricOnly: 0,
          uncovered: 0,
          layoutByLabel: {},
        },
      }),
    );
    // ② 真的接入了，但版面一行都没摘
    const applied = createLayoutSummaryAccumulator(() => 1);
    applied.onPage(pageReport({ lineCount: 12 }));

    // ⚠️ `pages` 两者**相同**（都是 1）—— 它就是分不开这两个情况的那个数
    expect(absent.summary.pages).toBe(1);
    expect(applied.summary.pages).toBe(1);
    // 而 `pagesWithLayout` 分得开：这才是判据
    expect(absent.summary.pagesWithLayout).toBe(0); // ← 「模型根本没跑」
    expect(applied.summary.pagesWithLayout).toBe(1);
    // 两者在**结果**上完全一样，所以只能靠上面那个字段区分
    expect(absent.summary.removedByLayout).toBe(applied.summary.removedByLayout);
    // 短路那一路的 `uncovered` 是 0（不是「覆盖得很全」），因此它的
    // 逐行对照计数**不进**汇总 —— 否则「没跑」会被读成「覆盖全」
    expect(absent.summary.decisions.uncovered).toBe(0);
  });
});

describe('T2 文档级汇总的出口：单行 JSON', () => {
  const summary = () => {
    const acc = createLayoutSummaryAccumulator(() => 4);
    acc.onPage(
      pageReport({
        lineCount: 7,
        removedByLayout: 2,
        removedByLabel: { header: 1, footer: 1 },
        reordered: true,
        decisionSummary: {
          total: 7,
          same: 5,
          differ: 2,
          layoutCaught: 2,
          geometricOnly: 0,
          uncovered: 0,
          layoutByLabel: { header: 1, text: 4, formula: 2 },
        },
        headingUse: { layout_says_not_heading: 2 },
      }),
    );
    return acc.summary;
  };

  it('固定前缀 + **单行**（单行才能在真实运行里靠 grep 累积）', () => {
    const line = renderLayoutSummaryLine(summary());
    expect(line.startsWith('[ocrPostProcess] layout-summary {')).toBe(true);
    expect(line).not.toContain('\n');
    expect(line.split('\n')).toHaveLength(1);
  });

  it('前缀与**逐页**那一行不同（两级日志不能靠字段猜层级）', () => {
    const docLine = renderLayoutSummaryLine(summary());
    const pageLine = renderLayoutMetricsLine(
      pageReport({ lineCount: 7, removedByLayout: 2, removedByLabel: { header: 1 } }),
    );

    expect(docLine.startsWith('[ocrPostProcess] layout-summary ')).toBe(true);
    expect(pageLine.startsWith('[ocrPostProcess] layout-metrics ')).toBe(true);
    // 一个 `grep layout-metrics` 不该捞到文档级那行，反之亦然
    expect(docLine).not.toContain('layout-metrics');
    expect(pageLine).not.toContain('layout-summary');
  });

  it('字段名与 `LayoutDocumentSummary` 一一对应（读的人不必猜哪个数是哪个）', () => {
    const json = JSON.parse(
      renderLayoutSummaryLine(summary()).slice('[ocrPostProcess] layout-summary '.length),
    ) as Record<string, unknown>;

    expect(json).toEqual({
      pages: 1,
      pagesWithLayout: 1,
      lastPageNum: 4,
      lines: 7,
      removedByLayout: 2,
      removedByLabel: { header: 1, footer: 1 },
      reorderedAny: true,
      reorderedPages: 1,
      decisions: { same: 5, differ: 2, layoutCaught: 2, geometricOnly: 0, uncovered: 0 },
      headingUse: { layout_says_not_heading: 2 },
    });
  });

  it('一次都没接入时这一行**如实**是全 0 与 `null`，不伪装成有数据', () => {
    const json = JSON.parse(
      renderLayoutSummaryLine(createLayoutSummaryAccumulator(() => 1).summary).slice(
        '[ocrPostProcess] layout-summary '.length,
      ),
    ) as Record<string, unknown>;

    expect(json.pages).toBe(0);
    expect(json.pagesWithLayout).toBe(0); // ← 「一次都没接入」的判据
    expect(json.lastPageNum).toBeNull(); // ← 不是 0：没有「第 0 页」这种东西
  });
});

/**
 * ═══════════════════════════════════════════════════════════════
 * 接线：`ocrResultToBlocks` 的第 6 个参数（`pdfParser.ts` 传的就是它）
 * ═══════════════════════════════════════════════════════════════
 *
 * `pdfParser.ts` 里那一行 `layoutTotals.onPage` 是**回调**，没法用
 * 「读某个值」的方式断言它被传对了。这里从**另一端**证明接线成立：
 * 用真实的 `ocrResultToBlocks` 走一遍，看累加器有没有真的收到逐页报告。
 *
 * ⚠️ 走的是 `ocrResultToBlocks` 而不是 `ocrParsePdf`：后者要真的 PDF、
 * 真的 OCR 引擎与真的版面模型（浏览器里才跑得起来），而这条链路
 * （回调 → 累加器）与推理无关。用合成词框就能把它钉死。
 */
describe('接线：第 6 个参数（回调）真的会被调用', () => {
  /** 与仓库既有测试同一个 helper 口径：w(text, x, y, h, width, confidence) */
  const w = (text: string, x: number, y: number, h: number, width = 30, confidence = 90) => ({
    text,
    confidence,
    bbox: { x0: x, y0: y, x1: x + width, y1: y + h },
    fontSize: h,
  });

  /** 一页：页眉 + 两行正文（页眉那行会被版面判为家具而摘掉） */
  const pageWords = (pageNum: number) => ({
    pageNum,
    words: [w('概率论与数理统计习题5', 300, 62, 42, 344), w('设随机变量X与Y', 100, 300, 42, 700)],
    avgConfidence: 90,
  });

  const headerRegion = {
    label: 'header',
    classId: 13,
    score: 0.94,
    x0: 280,
    y0: 50,
    x1: 660,
    y1: 110,
  };

  it('有区域时：逐页报告被交出来，且能累加成文档级总数', () => {
    const acc = createLayoutSummaryAccumulator(() => 1);

    ocrResultToBlocks(
      pageWords(1) as unknown as Parameters<typeof ocrResultToBlocks>[0],
      2223,
      undefined,
      [headerRegion],
      undefined,
      acc.onPage, // ← 与 `pdfParser.ts` 传的是同一个形状
    );

    // 回调真的被调用了（不是一段没人调用的死代码）
    expect(acc.summary.pages).toBe(1);
    expect(acc.summary.pagesWithLayout).toBe(1); // ← 真的接入了
    expect(acc.summary.lastPageNum).toBe(1);
    expect(acc.summary.removedByLayout).toBe(1); // 几何漏掉的那行页眉
    expect(acc.summary.removedByLabel).toEqual({ header: 1 });
  });

  it('⚠️ 模型缺席时回调**照样会进**，但 `pagesWithLayout` 必须是 0', () => {
    /**
     * ⚠️ 这条用例的**第一版断言是错的**（写的是 `pages === 0`），
     * 而它红了 —— 红的原因不是接线错了，是我的**假设**错了：
     * `applyLayoutToLines` 在没有区域时不会静默跳过，它会交出
     * 一份 `decisionSummary.total === 0` 的「全 0」报告，而
     * `ocrResultToBlocks` 的每一条出口都调用这个回调。
     *
     * 所以这里钉的是**真实**语义：回调会进，但汇总必须能把它
     * 与「真的接入了」分开 —— 否则界面会把「模型没跑」说成
     * 「模型跑了但没改动」，而这两句话指向完全相反的下一步动作。
     */
    const acc = createLayoutSummaryAccumulator(() => 1);

    const blocks = ocrResultToBlocks(
      pageWords(1) as unknown as Parameters<typeof ocrResultToBlocks>[0],
      2223,
      undefined,
      undefined, // ← 模型缺席
      undefined,
      acc.onPage,
    );

    expect(blocks.length).toBeGreaterThan(0); // 这一页照常出结果
    expect(acc.summary.pages).toBe(1); // 报告确实交出来了
    expect(acc.summary.lines).toBe(2); // 行数如实
    expect(acc.summary.pagesWithLayout).toBe(0); // ⭐ 但一次都没接入
    expect(acc.summary.removedByLayout).toBe(0);
    expect(acc.summary.reorderedPages).toBe(0);
    expect(acc.summary.decisions.uncovered).toBe(0); // 短路的 uncovered 不被累加
  });

  it('不传第 6 个参数：与接线前完全一样（参数是可选的）', () => {
    // 五个参数的既有调用点一个都不用改 —— 这是本次接线的兼容性底线
    const blocks = ocrResultToBlocks(
      pageWords(1) as unknown as Parameters<typeof ocrResultToBlocks>[0],
      2223,
      undefined,
      [headerRegion],
    );
    expect(blocks.length).toBeGreaterThan(0);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════
 * `scripts/eval-layout.mjs` 的**端到端**测试
 * ═══════════════════════════════════════════════════════════════
 *
 * 为什么要在单元测试里 `spawnSync` 一个子进程：
 *
 *   退出码是这个脚本**唯一的产出**（`npm run eval:layout` 靠它决定红绿），
 *   而退出码只存在于**进程**层面 —— 直接 `import` 那个模块是测不到的。
 *   所以这里真的把脚本跑起来，读它的**真实退出码与真实输出**。
 *
 * ⚠️ 这一步需要真的起一个 Vite 实例（脚本靠 `ssrLoadModule` 加载 TS 计分器），
 * 因此比本文件其它用例慢（实测约 2–4 秒）。这是刻意的取舍：
 * 「门禁不通过必须非零」这条纪律如果没有一条端到端用例守着，
 * 下一次把 `process.exitCode` 改掉不会有任何东西变红。
 *
 * ⚠️ 三个目录都用 `mkdtempSync` **各建各的**，跑完删掉：
 * 固定在 `tmpdir()` 下一个共用目录名会让并行跑的两份测试互相覆盖数据，
 * 而那种红是**假红**（数据被对面改了），排查成本极高。
 */
describe('scripts/eval-layout.mjs：退出码与「不许谎报通过」', () => {
  const SCRIPT = join(process.cwd(), 'scripts/eval-layout.mjs');

  const region = (label: string, x0: number, y0: number, x1: number, y1: number) => ({
    label,
    x0,
    y0,
    x1,
    y1,
  });

  const HEADER = region('header', 280, 50, 660, 110);
  const FOOTER = region('footer', 690, 2080, 1110, 2150);
  const TEXT = region('text', 90, 200, 1560, 760);

  /** 建一个基准目录；`predictions` 由调用方给，便于造「门禁必挂」的情形 */
  const makeBenchmarkDir = (predicted: unknown[]): string => {
    const dir = mkdtempSync(join(tmpdir(), 'ur-eval-layout-'));
    writeFileSync(
      join(dir, 'benchmark.json'),
      JSON.stringify({
        name: 'unit-test-bench',
        version: 'v0',
        pageCount: 1,
        source: '**合成**（单元测试，不是真实扫描件）',
        annotatedBy: '本测试文件（非人工标注）',
        annotatedAt: '2026-10-11',
      }),
      'utf8',
    );
    writeFileSync(
      join(dir, 'predictions.json'),
      JSON.stringify([
        { pageId: 'p1', width: 1667, height: 2223, truth: [HEADER, FOOTER, TEXT], predicted },
      ]),
      'utf8',
    );
    return dir;
  };

  const run = (args: string[]) =>
    spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: process.cwd(),
      encoding: 'utf8',
      // Windows 上 npm 脚本与 node 的默认输出编码可能不一致，显式钉成 utf8
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });

  it('没有基准数据：退出码 2，且**绝不**打印任何 precision/recall', () => {
    const empty = mkdtempSync(join(tmpdir(), 'ur-eval-layout-none-'));
    try {
      const r = run([empty]);
      const out = `${r.stdout}${r.stderr}`;

      // ⭐ 核心：不许谎报通过。0 是「门禁全过」，没有数据时**不能**是 0
      expect(r.status).toBe(2);
      // 「没有做过评测」这件事本身必须被说出来
      expect(out).toContain('没有做任何评测');
      // 一个分数行都不许出现：报告表头与门禁表都不该被打印
      expect(out).not.toContain('微平均');
      expect(out).not.toContain('发版门禁');
      expect(out).not.toContain('可发版');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('门禁全过：退出码 0，并带上基准标识与模型 sha256', () => {
    const dir = makeBenchmarkDir([{ ...HEADER }, { ...FOOTER }, { ...TEXT }]);
    try {
      const r = run([dir]);
      const out = `${r.stdout}${r.stderr}`;

      expect(r.status).toBe(0);
      // 报告**强制**携带基准身份（缺了它分数就不可比）
      expect(out).toContain('unit-test-bench');
      expect(out).toContain('**v0**');
      expect(out).toContain('合成'); // 合成基准必须自报家门
      // 模型身份：sha256 必须是源码里钉的那个值，不是随便一个字符串
      expect(out).toMatch(/sha256 `[0-9a-f]{16}…`/);
      // `releasable` 的语义必须原样带出来，不能被读成「模型够好」
      expect(out).toContain('不表示模型够好');
      expect(out).toContain('门禁全部通过');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('⚠️ 门禁不通过：退出码 **1**（与「没有数据」的 2 区分开）', () => {
    /**
     * 扰动与 `layoutReleaseMetrics.test.ts` 的 `scrambleLabels` 同一手法：
     * 把 `header` 预测改判成 `text`、坐标**一个都不动** ——
     * 于是 `header` 的 recall 掉到 0（门槛 0.8），
     * 同时 `header.predictedCount` 掉到 0（门槛 1）。
     */
    const dir = makeBenchmarkDir([
      { ...HEADER, label: 'text' },
      { ...FOOTER },
      { ...TEXT },
    ]);
    try {
      const r = run([dir]);
      const out = `${r.stdout}${r.stderr}`;

      expect(r.status).toBe(1);
      expect(out).toContain('不可发版');
      expect(out).toContain('门禁未全部通过');
      // 不通过的那几条要逐条点出来，不能只说一句「失败了」
      expect(out).toContain('header 的 recall');
      expect(out).toContain('header 的 predictedCount');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('`--json` 多打一行紧凑 JSON，且里面带着基准与模型身份', () => {
    const dir = makeBenchmarkDir([{ ...HEADER }, { ...FOOTER }, { ...TEXT }]);
    try {
      const r = run([dir, '--json']);
      const line = r.stdout
        .split('\n')
        .find((l) => l.startsWith('[eval-layout] report-json '));

      expect(line).toBeDefined();
      const json = JSON.parse(line!.slice('[eval-layout] report-json '.length)) as {
        releasable: boolean;
        benchmark: { name: string };
        model: { sha256: string };
        categories: unknown[];
      };
      expect(json.releasable).toBe(true);
      expect(json.benchmark.name).toBe('unit-test-bench');
      expect(json.model.sha256.length).toBe(64);
      expect(json.categories).toHaveLength(23);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('预测文件是**空数组**：退出码 2 且不抛堆栈（清零了分母，不是「全错」）', () => {
    /**
     * ⚠️ 这条用例是**变异测试逼出来的**：第一版脚本里这个守卫
     * （`if (!pages.length)`）**没有任何用例覆盖** —— 把整段删掉，
     * 全部用例依然绿。而它的真实表现是：空预测被直接送进计分器，
     * 计分器当场抛错（`至少要有一页真值`），于是脚本以一段**未捕获
     * 异常的堆栈**收场。
     *
     * 退出码虽然仍非零，但那个 1 的意思是「脚本崩了」而不是
     * 「门禁不通过」—— 读日志的人会去查脚本，而该查的是数据。
     */
    const dir = mkdtempSync(join(tmpdir(), 'ur-eval-layout-empty-'));
    try {
      writeFileSync(
        join(dir, 'benchmark.json'),
        JSON.stringify({
          name: 'empty-preds-bench',
          version: 'v0',
          pageCount: 1,
          source: '**合成**（单元测试，不是真实扫描件）',
          annotatedBy: '本测试文件（非人工标注）',
          annotatedAt: '2026-10-11',
        }),
        'utf8',
      );
      writeFileSync(join(dir, 'predictions.json'), '[]', 'utf8');

      const r = run([dir]);
      const out = `${r.stdout}${r.stderr}`;

      expect(r.status).toBe(2); // ← 不是 1（1 是「脚本崩了」）
      expect(out).toContain('一页预测都没有');
      expect(out).toContain('没有产出任何可比的分数');
      // 堆栈一个字符都不该出现（那说明错误没被接住）
      expect(out).not.toMatch(/\n\s+at /);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('标注里写错类别名：当场非零退出，且把页与错名都说出来', () => {
    // 计分器会抛错（见 `evaluateLayoutPredictions`）；脚本必须把它变成
    // **非零退出码**而不是一次未捕获的异常后「退出 0」
    const dir = makeBenchmarkDir([region('headerr', 0, 0, 10, 10)]);
    try {
      const r = run([dir]);
      expect(r.status).not.toBe(0);
      expect(`${r.stdout}${r.stderr}`).toMatch(/headerr/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
