/**
 * 版面模型发版评测：**真值 + 预测 → 逐类别 precision/recall → 门禁 → 退出码**。
 *
 * ═══════════════════════════════════════════════════════════════
 * 这个脚本为什么存在
 * ═══════════════════════════════════════════════════════════════
 *
 * 计分器（`evaluateLayoutPredictions`）与报告渲染
 * （`renderLayoutEvaluationReport`）都已经实现并有测试，但它们此前**没有
 * 任何调用点** —— 也就是说「版面模型到底准不准」这个问题，
 * 在真实运行里连一个可执行的问法都没有。这个脚本就是那个调用点：
 * 它本身**不含任何评测逻辑**，只做「读文件 → 调计分器 → 打印 → 定退出码」。
 *
 * 之所以要单独做成脚本而不是塞进测试：测试里的真值是**合成的**
 * （`layoutReleaseMetrics.test.ts` 里写得很清楚），而这份要跑的是
 * **真实标注**。两者的数字绝不能混在一张表里报。
 *
 * ═══════════════════════════════════════════════════════════════
 * ⚠️ 本项目**目前没有任何真实标注集** —— 这不是缺陷，是事实
 * ═══════════════════════════════════════════════════════════════
 *
 * 到本轮为止，仓库里**不存在** `scripts/__fixtures__/layout-truth/`，
 * 因此**没有任何真实精度数字**，一个都没有。那种「跑出 0.87 然后发版」
 * 的场景在本项目里从未发生过。
 *
 * 所以本脚本的第一等公民行为是「**没有基准数据**」，而不是「有数据」。
 * 没有数据时它：
 *   · **不去合成一份假真值**（那会产出看起来完整的假数字，比没有更糟）；
 *   · **不打印任何 precision/recall**（没有数字就没有可以被误读的数字）；
 *   · **不报「通过」**。这里刻意**不使用**「通过」这个词 —— 因为它
 *     退出码非零（2），而 `npm run eval:layout` 因此是**红的**：
 *     「没测过」与「测了且合格」在 CI 上必须长得不一样。
 *
 * 退出码（与 `scripts/verify-dist.mjs` 同一条纪律：门禁不通过必须非零）：
 *   · **0** —— 门禁全过（**只**表示「没有踩到已登记的红线」）
 *   · **1** —— 门禁有一条不通过
 *   · **2** —— 没有基准数据 / 文件读不出来 / 文件格式不对（**不是「通过」**）
 *
 * ⚠️ CI 里若要「必须有基准、没基准就算失败」，用 `--strict`：
 *     node scripts/eval-layout.mjs --strict
 *   它与默认行为的唯一区别是**退出码 2 与 1 的区别被抹平**，
 *   因为「没数据」本来就已经是非零了。
 *
 * ═══════════════════════════════════════════════════════════════
 * 用法
 * ═══════════════════════════════════════════════════════════════
 *
 *   npm run eval:layout                     # 用默认基准目录
 *   npm run eval:layout -- <基准目录>        # 指定基准目录
 *   npm run eval:layout -- --json            # 额外打印一行紧凑 JSON（便于归档/diff）
 *   npm run eval:layout -- --strict          # 没有基准数据时也算失败（其实本来就是）
 *   npm run eval:layout -- --help
 *
 * 基准目录里要有两个文件：
 *   · `benchmark.json`    —— `LayoutBenchmarkIdentity` + 页数组
 *   · `predictions.json`  —— 页数组（或 `{ "pages": [...] }` / `{ "predictions": [...] }`）
 *
 * 页数组的元素形状见 `src/lib/layoutAnalysis.ts` 的 `LayoutEvalPage`：
 *   { pageId, width, height, truth: [{label,x0,y0,x1,y1}], predicted: [...] }
 * `label` 必须取自 `LAYOUT_LABELS`（写错当场抛错，见 `evaluateLayoutPredictions`）。
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

const PREFIX = '[eval-layout]';

/** 默认基准目录。**当前不存在** —— 见文件头「没有真实标注集」那一节。 */
const DEFAULT_BENCHMARK_DIR = resolve(process.cwd(), 'scripts/__fixtures__/layout-truth');

/**
 * 退出码。**2 与 1 必须分开**：
 *   · 1 = 模型没达到已登记的红线（该去看模型）；
 *   · 2 = 根本没有可比的东西（该去看标注集）。
 * 两者都非零，所以 CI 不会把它们误当成成功。
 */
const EXIT = { PASS: 0, GATE_FAILED: 1, NO_BENCHMARK: 2 };

const { dir: benchmarkDir, wantJson, strict } = parseArgs(process.argv.slice(2));

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  printHelp();
  process.exit(EXIT.PASS);
}

await main();

async function main() {
  const benchmarkFile = join(benchmarkDir, 'benchmark.json');
  const predictionsFile = join(benchmarkDir, 'predictions.json');

  console.log(`${PREFIX} 基准目录：${benchmarkDir}`);

  if (!existsSync(benchmarkFile) || !existsSync(predictionsFile)) {
    noBenchmark(benchmarkFile, predictionsFile);
    return;
  }

  // ── 读文件：任何一处读不出来都归到「没有可比的东西」，不装作通过 ──
  let benchmark;
  let predictions;
  try {
    benchmark = JSON.parse(readFileSync(benchmarkFile, 'utf8'));
  } catch (err) {
    fail(`${benchmarkFile} 读不出来或不是合法 JSON：${err.message}`);
    return;
  }
  try {
    predictions = JSON.parse(readFileSync(predictionsFile, 'utf8'));
  } catch (err) {
    fail(`${predictionsFile} 读不出来或不是合法 JSON：${err.message}`);
    return;
  }

  // ── 校验身份字段：缺了它们，分数就是不可比的数字 ──────────────
  const identityProblems = checkBenchmarkIdentity(benchmark);
  if (identityProblems.length) {
    for (const p of identityProblems) console.error(`${PREFIX} ✗ ${p}`);
    fail(
      '基准身份不完整 —— 一个没有名字/版本/来源/标注人的分数，' +
        '下次换标注集之后就变成一串无法解释的数字，因此拒绝出分。',
    );
    return;
  }

  const pages = normalizePages(predictions);
  if (!pages.length) {
    fail(`${predictionsFile} 里一页预测都没有 —— 空评测集只会产出「全部分母为 0」的假报告。`);
    return;
  }

  console.log(`${PREFIX} 基准 \`${benchmark.name}\` ${benchmark.version}，${benchmark.pageCount} 页`);
  console.log(`${PREFIX} 预测 ${pages.length} 页`);
  console.log('');

  // ── 唯一的评测动作：调计分器 ──────────────────────────────────
  //
  // 计分器住在 TS 源码里（`src/lib/layoutAnalysis.ts`），而本脚本是 .mjs。
  // 不能直接 `import`：那个模块链上会用到 Vite 才提供的 `import.meta.env`
  // （见 src/lib/ocrModelSource.ts:48），裸 Node 下读它是 undefined。
  // 走 Vite 的 `ssrLoadModule` 是唯一能让**项目真实的那个计分器**
  // （而不是抄一份）在 Node 里跑起来的办法。它同时解决了 `@/` 别名
  // 与无扩展名 import，也不需要先 `tsc` 出一个中间产物。
  //
  // ⚠️ 必须包 try/catch：计分器对**坏输入**是**抛错**的（空评测集、
  // 未知类别名、画布尺寸为 0 —— 见 `evaluateLayoutPredictions`）。
  // 不接住的话，一份写错的 predictions.json 会变成一段**未捕获异常的
  // 堆栈**，而堆栈里没有任何「这次没有产出分数」的话 ——
  // 退出码虽然仍然非零（Node 未捕获异常退 1），但那个 1 的意思是
  // 「脚本崩了」，不是「门禁不通过」，两者必须能分开读。
  let report;
  try {
    report = await evaluate(benchmark, pages);
  } catch (err) {
    fail(`评测未能完成：${err?.message ?? String(err)}`);
    // 把计分器给的原因原样带出来（它自己会说清是哪一页、哪个类别名写错了）
    for (const line of String(err?.stack ?? '').split('\n').slice(1, 4)) {
      console.error(`${PREFIX}   ${line.trim()}`);
    }
    return;
  }

  console.log(report.markdown);
  console.log('');

  if (wantJson) {
    // 单行、字段与 `LayoutEvaluationReport` 一一对应；基准/模型身份都在里面
    console.log(`${PREFIX} report-json ${JSON.stringify(report.raw)}`);
  }

  // ── 结论 + 退出码 ──────────────────────────────────────────────
  //
  // ⚠️ 措辞严格跟着 `releasable` 的语义走：它**只**回答「门禁是不是全过」，
  // **不**回答「模型够不够好」。这里刻意不在任何地方写「精度合格」之类的话。
  if (report.raw.releasable) {
    console.log(`${PREFIX} 门禁全部通过 —— \`releasable: true\``);
    console.log(`${PREFIX} ⚠️ 这个结论严格限定为「已登记的红线一条都没踩」，`);
    console.log(`${PREFIX}    它**不表示模型够好**，只表示没有回归（与 verify-dist.mjs 同纪律）。`);
    process.exitCode = EXIT.PASS;
    return;
  }

  console.error(`${PREFIX} ✗ 门禁未全部通过 —— \`releasable: false\``);
  for (const verdict of report.raw.gate.filter((v) => !v.pass)) {
    const required =
      verdict.metric === 'predictedCount'
        ? `${verdict.required} 个`
        : `${(verdict.required * 100).toFixed(0)}%`;
    const actual =
      verdict.actual === null
        ? '无定义'
        : verdict.metric === 'predictedCount'
          ? `${verdict.actual} 个`
          : `${(verdict.actual * 100).toFixed(1)}%`;
    console.error(
      `${PREFIX}   ✗ ${verdict.label} 的 ${verdict.metric}：要求 ≥ ${required}，实测 ${actual}` +
        (verdict.note ? `（${verdict.note}）` : ''),
    );
  }
  console.error(`${PREFIX} 门禁是「不许更差」，不是「够好了」；它拦的是回归。`);
  process.exitCode = EXIT.GATE_FAILED;
}

/**
 * 把模型加载交给 Vite，然后调那个**真实的**计分器。
 *
 * 用 `finally` 关服务器：`ssrLoadModule` 会起一个 Vite 实例，
 * 不关它 Node 进程不会退出（脚本会看起来「卡住」而不是报错）。
 */
async function evaluate(benchmark, pages) {
  const { createServer } = await import('vite');
  const server = await createServer({
    // 刻意**不读** `vite.config.ts`：那份配置里有点号链探测、
    // `preserveSymlinks` 等与浏览器构建相关的取舍，本脚本只需要两个能力 ——
    // `@/` 别名与 `import.meta.env`。少读一份配置就少一处会随构建改动而漂移的地方。
    configFile: false,
    root: process.cwd(),
    resolve: { alias: { '@': resolve(process.cwd(), 'src') } },
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'error',
  });

  try {
    const mod = await server.ssrLoadModule('/src/lib/layoutAnalysis.ts');
    const raw = mod.evaluateLayoutPredictions(
      pages,
      {
        name: benchmark.name,
        version: benchmark.version,
        pageCount: benchmark.pageCount,
        source: benchmark.source,
        annotatedBy: benchmark.annotatedBy,
        annotatedAt: benchmark.annotatedAt,
      },
      /**
       * 模型身份**不是**从基准文件里读的，而是从源码常量现取 ——
       * 这样「报的是哪份权重」与「生产里真的加载了哪份权重」不可能对不上
       * （`LAYOUT_MODEL_SHA256` 正是下载脚本与 `verify-dist.mjs` 硬校验的那个值）。
       * 基准文件里若也写了模型身份，只用于**交叉核对**，不能覆盖这里。
       */
      {
        file: mod.LAYOUT_MODEL_FILE,
        sha256: mod.LAYOUT_MODEL_SHA256,
        upstreamMap: benchmark.model?.upstreamMap ?? 70.9,
        upstreamMapBasis:
          benchmark.model?.upstreamMapBasis ??
          '上游自评 mAP(0.5)，500 张中英文论文/报纸/试卷自建集',
      },
    );

    if (benchmark.model?.sha256 && benchmark.model.sha256 !== mod.LAYOUT_MODEL_SHA256) {
      console.error(
        `${PREFIX} ⚠️ 基准文件里记的模型 sha256（${String(benchmark.model.sha256).slice(0, 16)}…）` +
          `与源码里的（${mod.LAYOUT_MODEL_SHA256.slice(0, 16)}…）**不一致** —— ` +
          `这份分数是用**源码里那份**权重口径出的，基准文件那一栏已过期。`,
      );
    }

    return { raw, markdown: mod.renderLayoutEvaluationReport(raw) };
  } finally {
    await server.close();
  }
}

/** 没有基准数据时的**唯一**出口 —— 注意它既不打印分数，也不说「通过」 */
function noBenchmark(benchmarkFile, predictionsFile) {
  console.log('');
  console.log(`${PREFIX} ⓘ 没有基准数据：找不到以下文件`);
  console.log(`${PREFIX}     ${benchmarkFile}`);
  console.log(`${PREFIX}     ${predictionsFile}`);
  console.log('');
  console.log(`${PREFIX} 本项目**至今没有任何真实标注集** —— 这是事实，不是配置问题。`);
  console.log(`${PREFIX} 因此这里**没有**任何 precision/recall 可报：一个都没有，不是 0。`);
  console.log(`${PREFIX} 脚本刻意**不合成假真值**：合成的真值会产出看起来完整的假数字，`);
  console.log(`${PREFIX} 而「版面模型够不够准」这个结论一旦被假数字回答过，就再也没人去建真基准了。`);
  console.log('');
  console.log(`${PREFIX} ✗ 本次运行**没有做任何评测** —— 这不叫通过（退出码 ${EXIT.NO_BENCHMARK}）。`);
  console.log(`${PREFIX}   要建基准，看 src/lib/layoutReleaseMetrics.test.ts 里 BENCHMARK 的注释：`);
  console.log(`${PREFIX}   20–30 页用户痛点文档、逐区域类别 + bbox、两份名单交叉、至少双人/双次标注。`);
  console.log(`${PREFIX}   建好后放进 ${benchmarkDirHint()}，再跑 npm run eval:layout。`);
  if (strict) {
    console.error(`${PREFIX} --strict 已开启：没有基准数据按失败处理。`);
  }
  process.exitCode = EXIT.NO_BENCHMARK;
}

function benchmarkDirHint() {
  return benchmarkDir === DEFAULT_BENCHMARK_DIR ? '默认基准目录' : benchmarkDir;
}

/** 基准身份**逐栏必填** —— 缺哪一栏就点出哪一栏，不返回半个分数 */
function checkBenchmarkIdentity(benchmark) {
  const problems = [];
  if (!benchmark || typeof benchmark !== 'object') {
    return ['benchmark.json 的顶层不是一个对象'];
  }
  for (const key of ['name', 'version', 'source', 'annotatedBy', 'annotatedAt']) {
    if (typeof benchmark[key] !== 'string' || !benchmark[key].trim()) {
      problems.push(`benchmark.json 缺 \`${key}\`（必须是**非空**字符串）`);
    }
  }
  if (!Number.isInteger(benchmark.pageCount) || benchmark.pageCount <= 0) {
    problems.push('benchmark.json 的 `pageCount` 必须是正整数');
  }
  return problems;
}

/** 预测文件允许三层包装，但内部形状必须是页数组 */
function normalizePages(predictions) {
  const pages = Array.isArray(predictions)
    ? predictions
    : predictions?.pages ?? predictions?.predictions ?? [];
  return Array.isArray(pages) ? pages : [];
}

function fail(message) {
  console.error(`${PREFIX} ✗ ${message}`);
  console.error(`${PREFIX} 本次运行**没有产出任何可比的分数**（退出码 ${EXIT.NO_BENCHMARK}）。`);
  process.exitCode = EXIT.NO_BENCHMARK;
}

/**
 * 参数解析写成手写循环而不是引依赖：项目**零新增依赖**是硬性要求，
 * 而这里要解析的只有三个开关。
 */
function parseArgs(argv) {
  let dir = DEFAULT_BENCHMARK_DIR;
  let wantJson = false;
  let strict = false;

  for (const arg of argv) {
    if (arg === '--json') wantJson = true;
    else if (arg === '--strict') strict = true;
    else if (arg === '--help' || arg === '-h') continue;
    else if (arg.startsWith('-')) {
      console.error(`${PREFIX} 未知参数：${arg}（用 --help 看用法）`);
      process.exit(EXIT.NO_BENCHMARK);
    } else {
      // 相对路径按**当前工作目录**解析，与 npm script 的调用方式一致
      const abs = isAbsolute(arg) ? arg : resolve(process.cwd(), arg);
      if (existsSync(abs) && !statSync(abs).isDirectory()) {
        console.error(`${PREFIX} ${abs} 是文件，不是基准**目录**（目录里要有 benchmark.json 与 predictions.json）`);
        process.exit(EXIT.NO_BENCHMARK);
      }
      dir = abs;
    }
  }
  return { dir, wantJson, strict };
}

function printHelp() {
  console.log(`${PREFIX} 版面模型发版评测（真值 + 预测 → 分数 → 门禁 → 退出码）

用法：
  npm run eval:layout                 用默认基准目录
  npm run eval:layout -- <目录>        指定基准目录
  npm run eval:layout -- --json        额外打印一行紧凑 JSON（可归档、可 diff）
  npm run eval:layout -- --strict      没有基准数据时按失败处理
  npm run eval:layout -- --help

基准目录需要两个文件：
  benchmark.json    基准身份（name/version/pageCount/source/annotatedBy/annotatedAt）
                    + 可选 model 一栏，用于与源码里的 sha256 交叉核对
  predictions.json  页数组：[{ pageId, width, height, truth: [...], predicted: [...] }]
                    区域形状：{ label, x0, y0, x1, y1 }，label 取自 LAYOUT_LABELS

退出码：
  0  门禁全过（**只**表示没踩到已登记的红线，不表示模型够好）
  1  门禁有一条不通过
  2  没有基准数据 / 文件坏了（**不是通过**）

⚠️ 本项目目前没有任何真实标注集，所以默认目录不存在，
   直接跑会得到退出码 2 —— 那是「没测过」，不是「合格」。`);
}
