import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 版面分析的**失败契约**测试：每个降级码都要能被真实触发、且彼此可区分。
 *
 * ═══════════════════════════════════════════════════════════════
 * 这组测试要解决的是什么问题
 * ═══════════════════════════════════════════════════════════════
 *
 * `analyzePageLayout()` 改动前**七处 `return null`**（HEAD `f505a11` 的
 * 696/736/740/744/791/801/813），七种原因对上层完全不可区分。后果是
 * 用户看到「页眉被多滤掉一行」时，无法判断那是版面模型干的还是几何
 * 启发式干的 —— 而 `HANDOFF.md` §5.11.7 记着**版面模型从未在真实数据上
 * 跑过推理**（一个未验证的组件在正文链路里，出错时连「是不是它」都问不出来）。
 *
 * 所以这里的每一条都必须**真的把那个出口走一遍**，而不是断言
 * 「枚举里存在这个字符串」—— 后者在码被删掉、判定分支被注释掉时照样绿。
 *
 * ═══════════════════════════════════════════════════════════════
 * 怎么做到「真的触发」（在本机跑不了浏览器推理的前提下）
 * ═══════════════════════════════════════════════════════════════
 *
 * `layoutAnalysis.ts` 用静态 `import type` + 动态 `import('onnxruntime-web')`
 * 拿运行库。`vi.mock` 对**两者都生效**（已实测：探针用例确认动态 import
 * 与静态 import 拿到同一个 mock 模块）—— 所以这里能精确摆布
 * 「会话建不起来 / 输出张量缺一路 / 推理抛错」这些真实分支，
 * 而不需要浏览器、不需要 ONNX 运行时、不需要 4.7MB 模型文件。
 *
 * ⚠️ 两个必须防的**假保护**（本项目已出现 5 次「注释掉逻辑照样绿」）：
 *
 *  1. **不要断言同进程里别的用例改过的当前值。** 每个用例前都调
 *     `resetLayoutSessionForTest()` + `clearPageLayoutAnalysis()`，
 *     把「会话缓存」与「旁挂记录」两处跨用例状态清干净；断言的对象
 *     一律取自**本用例自己的返回值**，不读模块级变量当证据。
 *  2. **不要让 `toMatch(/名字/)` 匹配到 import 语句。** 这里不用正则匹配
 *     源码文本，只断言运行期返回的 `outcome.code`。唯一读源码的地方是
 *     「七处出口逐一对上」那条，它读的是 `layoutAnalysis.ts` 的**文本**，
 *     所以它显式排除了 import 行并锚定 `layoutSkip(` 调用形态。
 */

/**
 * 可摆布的 ONNX 假实现。
 *
 * `vi.mock` 会被提升到 import 之前，所以共享状态必须用 `vi.hoisted` 建。
 */
const ortMock = vi.hoisted(() => {
  /** 每个用例按需改这几个字段；`reset()` 把它恢复成「一切正常」 */
  const state = {
    /** `InferenceSession.create` 的行为：'ok' 直接给会话；'throw' 抛错 */
    createMode: 'ok' as 'ok' | 'throw',
    createError: new Error('模型取不到（模拟 404）'),
    /** 会话 `run()` 的行为 */
    runMode: 'ok' as 'ok' | 'throw',
    runError: new Error('模拟推理抛错'),
    /** `run()` 的返回值（直接就是 outputs 对象） */
    outputs: {} as Record<string, { data: ArrayLike<number> }>,
  };

  const reset = () => {
    state.createMode = 'ok';
    state.createError = new Error('模型取不到（模拟 404）');
    state.runMode = 'ok';
    state.runError = new Error('模拟推理抛错');
    state.outputs = {};
  };

  return { state, reset };
});

vi.mock('onnxruntime-web', () => {
  const { state } = ortMock;
  return {
    env: { wasm: { wasmPaths: '', numThreads: 0 }, versions: { web: 'test', common: 'test' } },
    Tensor: class {
      constructor(
        public type: string,
        public data: unknown,
        public dims: unknown,
      ) {}
    },
    InferenceSession: {
      create: async () => {
        if (state.createMode === 'throw') throw state.createError;
        return {
          run: async () => {
            if (state.runMode === 'throw') throw state.runError;
            return state.outputs;
          },
        };
      },
    },
  };
});

import {
  analyzePageLayout,
  clearPageLayoutAnalysis,
  getPageLayoutAnalysis,
  getLayoutSessionLoadError,
  LAYOUT_OUTCOME_CODES,
  LAYOUT_SKIP_CATALOG,
  LAYOUT_SKIP_CODES,
  layoutSkipCodesAreUnique,
  resetLayoutSessionForTest,
  setPageLayoutAnalysisForTest,
  type LayoutSkipCode,
} from '@/lib/layoutAnalysis';

/** 造一路模型输出（张量数据的实际形状是扁平行优先数组） */
const tensorOf = (rows: number[][]) => ({ data: Float32Array.from(rows.flat()) });

/** 一行 [class_id, score, x1, y1, x2, y2] */
const det = (cls: number, score: number, x1: number, y1: number, x2: number, y2: number) => [
  cls,
  score,
  x1,
  y1,
  x2,
  y2,
];

/**
 * 一个「尺寸正常、但读不出像素」的源。
 *
 * ⚠️ 必须用**普通对象**而不是 `ImageData`：`readPixels` 会先判
 * `source instanceof ImageData`，而 vitest 的 node 环境里 `ImageData`
 * 是 `undefined`（已实测），于是走到 `typeof document === 'undefined'`
 * 那一句抛错 —— 这正是真实无 DOM 环境下的行为，不是人为造的假象。
 *
 * 断言用 `as unknown as` 是有意的：这个对象**不满足** `HTMLCanvasElement`
 * 的类型（它没有 `getContext`），而「上游塞进来一个形状不对的画布」
 * 恰恰就是要测的那种输入。用真 canvas 类型来满足编译器反而测不到它。
 */
const canvasLike = (width: number, height: number) =>
  ({ width, height }) as unknown as ImageData;

/**
 * 一个**能被读出像素**的源：给全局补一个最小的 `ImageData`。
 *
 * 为什么必须这么做才能测到正常路径：`readPixels` 的两个分支分别是
 * 「`source instanceof ImageData` 就直接用」与「没有 `document` 就抛错」。
 * node 环境里 `ImageData` 不存在，于是**任何**输入都会落到抛错那一支 ——
 * 不补它，`inference_failed` 之后的每一条都是死代码，测试只会在
 * `canvas_unreadable` 上原地打转（第一版就是这样，9 条全红）。
 *
 * ⚠️ 补的是一个**最小的真实现**（只需 `data`/`width`/`height`），
 * 而不是把 `readPixels` 也 mock 掉 —— mock 掉它等于把「预处理」整段
 * 从被测路径里摘出去，那就测不到「读像素 → 归一化 → 喂张量」这段了。
 */
class FakeImageData {
  readonly data: Uint8ClampedArray;
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.data = new Uint8ClampedArray(width * height * 4);
    // 填一个确定性的非零图案：全 0 也能跑通，但「参数传错」这类问题
    // 在归一化上不会体现出来，有图案更接近真实画布。
    for (let i = 0; i < this.data.length; i++) this.data[i] = (i * 37) % 256;
  }
}

/** 造一张能被 `readPixels` 读出的画布 */
const readableCanvas = (
  width = 1000,
  height = 1400,
): ImageData => new FakeImageData(width, height) as unknown as ImageData;

/** 正常一路输出的张量：一行 header（class_id 13）、一行 footer（class_id 15） */
function healthyOutputs() {
  return {
    fetch_name_0: tensorOf([
      det(13, 0.92, 300, 20, 700, 60),
      det(15, 0.88, 300, 1300, 700, 1340),
    ]),
    fetch_name_1: { data: Int32Array.from([2]) },
  };
}

beforeEach(() => {
  // 跨用例状态一共两处：会话缓存 与 失败原因 与 旁挂记录。全部清掉 ——
  // 「读别的用例留下的值」是本项目吃过亏的假保护形态之一。
  ortMock.reset();
  resetLayoutSessionForTest();
  clearPageLayoutAnalysis();
  // 补上 `ImageData`，让「能读出像素」这条路径存在（见 `FakeImageData` 的说明）
  vi.stubGlobal('ImageData', FakeImageData);
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetLayoutSessionForTest();
  clearPageLayoutAnalysis();
});

// ═══════════════════════════════════════════════════════════════
// 码表本身：每个码都有含义与下一步动作，且没有重复
// ═══════════════════════════════════════════════════════════════

describe('码表：每个码都必须有「含义」与「下一步动作」', () => {
  it('七个失败码，且没有重复（重复会让「按码区分」再次失效）', () => {
    expect(LAYOUT_SKIP_CODES).toHaveLength(7);
    expect(layoutSkipCodesAreUnique()).toBe(true);
    expect(new Set(LAYOUT_SKIP_CODES).size).toBe(7);
  });

  it('每个码都有非空的中文含义与下一步动作（类型已保证键完整，这里保证内容非空）', () => {
    for (const code of LAYOUT_OUTCOME_CODES) {
      const info = LAYOUT_SKIP_CATALOG[code];
      expect(info, `缺 ${code} 的说明`).toBeDefined();
      expect(info.meaning.length, `${code}.meaning 是空的`).toBeGreaterThan(8);
      expect(info.nextAction.length, `${code}.nextAction 是空的`).toBeGreaterThan(8);
      // 含义不能只是把码名抄一遍 —— 那等于没有含义
      expect(info.meaning).not.toBe(code);
    }
  });

  it('`none` 是**成功**，不是失败码 —— 它不在这七个里', () => {
    expect(LAYOUT_OUTCOME_CODES).toContain('none');
    expect(LAYOUT_SKIP_CODES as readonly string[]).not.toContain('none');
    expect(LAYOUT_SKIP_CATALOG.none.meaning).toContain('成功');
  });

  it('`no_regions_detected` 覆盖三个失败点，必须逐个列在 sites 里（否则无法分辨）', () => {
    const sites = LAYOUT_SKIP_CATALOG.no_regions_detected.sites;
    expect(sites).toBeDefined();
    expect(sites!.length).toBe(3);
    // 三个来源的关键词都要出现，否则「列了但列不全」照样绿
    expect(sites!.join('|')).toMatch(/0 行有效检测/);
    expect(sites!.join('|')).toMatch(/所有行都被丢弃/);
    expect(sites!.join('|')).toMatch(/中心落在画布外/);
  });

  it('源码里每个失败码都恰好有一条出口（逐一对上，不靠人记得）', async () => {
    const fs = await import('node:fs');
    const url = await import('node:url');
    const here = url.fileURLToPath(new URL('./layoutAnalysis.ts', import.meta.url));
    const source = fs.readFileSync(here, 'utf8');

    /**
     * ⚠️ 只数**调用点**（`layoutSkip('xxx'` 这种形态），不数 import、
     * 不数注释、不数类型别名 —— 这正是「`toMatch(/名字/)` 匹配到 import
     * 语句」那类假保护的防法：把匹配锚定成调用形态而不是裸名字。
     * 先剥掉块注释，`LAYOUT_SKIP_CATALOG` 里每个码的说明文字就不会被误数。
     */
    const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const code of LAYOUT_SKIP_CODES) {
      const callForm = new RegExp(`layoutSkip\\('${code}'`, 'g');
      const n = (withoutComments.match(callForm) ?? []).length;
      expect(n, `码 ${code} 的出口数不是 1（实际 ${n}）`).toBe(1);
    }
  });

  it('枚举数组里写的每个码都能在源码里找到出口（防止「加了码但没接」）', async () => {
    const fs = await import('node:fs');
    const url = await import('node:url');
    const here = url.fileURLToPath(new URL('./layoutAnalysis.ts', import.meta.url));
    const withoutComments = fs
      .readFileSync(here, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    for (const code of LAYOUT_SKIP_CODES) {
      expect(withoutComments, `${code} 没有对应的 layoutSkip 调用`).toContain(`layoutSkip('${code}'`);
    }
  });

  /**
   * ⚠️ 这条是**接线**测试，不是判定测试。
   *
   * `pdfParser` 里那一行是把「本次结果」交给导出的**唯一**通道
   * （`layoutOutcome` 从 `analyzePageLayout` 的解构直接传到
   * `ocrResultToBlocks` 的第 5 个参数）。如果哪天它被换成一个新构造的对象、
   * 或传成 `getPageLayoutAnalysis()`（时序产物）、或干脆不传，
   * 上面所有「能触发」的测试**照样全绿**，而用户导出里又会回到
   * 「不知道是不是版面模型干的」。这就是本项目出现过 5 次的那类假保护，
   * 所以这里把那一行钉住。
   *
   * 只断言「同一个标识符从解构传到调用」这一件事，不管格式与换行。
   */
  it('接线：`pdfParser` 必须把本次解构出的 outcome 直接交给导出', async () => {
    const fs = await import('node:fs');
    const url = await import('node:url');
    const parserPath = url.fileURLToPath(new URL('../parsers/pdfParser.ts', import.meta.url));
    const source = fs.readFileSync(parserPath, 'utf8');
    const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    // ① 从 `analyzePageLayout` 的解构里取 `outcome`
    expect(withoutComments).toMatch(
      /const\s*\{\s*result:\s*layout\s*,\s*outcome:\s*layoutOutcome\s*\}\s*=\s*await\s+analyzePageLayout\(/,
    );
    // ② 把那**同一个** `layoutOutcome` 交给 `ocrResultToBlocks`
    expect(withoutComments).toMatch(/ocrResultToBlocks\(/);
    const callSite = withoutComments.slice(withoutComments.indexOf('ocrResultToBlocks('));
    expect(callSite.slice(0, 600)).toContain('layoutOutcome');
    // ③ 不允许从旁挂记录里现取一个（那是时序产物，不是本次结果）
    expect(callSite.slice(0, 600)).not.toContain('getPageLayoutAnalysis()');
  });
});

// ═══════════════════════════════════════════════════════════════
// 方向一：每个码都要能被**真实触发**，并且能被区分
// ═══════════════════════════════════════════════════════════════

describe('七种降级：逐一真实触发', () => {
  /** 一个便于断言「结果为空」的共用检查 */
  const expectSkipped = async (
    source: Parameters<typeof analyzePageLayout>[0],
  ): Promise<LayoutSkipCode> => {
    const { result, outcome } = await analyzePageLayout(source);
    expect(result, '降级时 result 必须是 null').toBeNull();
    expect(outcome.ok, '降级时 outcome.ok 必须是 false').toBe(false);
    return outcome.code as LayoutSkipCode;
  };

  it('① feature_disabled：开关关着时压根不尝试（用户自己关的，不是故障）', async () => {
    // 直接构造：走真实出口 `isLayoutAnalysisEnabled()` 读的是
    // `import.meta.env.VITE_OCR_LAYOUT`，本机是 undefined（= 默认开）
    // 所以这里用 vi.stubEnv 把它设成 '0'，走的是与生产同一条判定。
    vi.stubEnv('VITE_OCR_LAYOUT', '0');
    try {
      const code = await expectSkipped(readableCanvas());
      expect(code).toBe('feature_disabled');
      expect(getPageLayoutAnalysis()?.code).toBe('feature_disabled');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('② canvas_unreadable：尺寸正常但读不出像素（无 document 环境）', async () => {
    // ⚠️ 这里要用**普通对象**：`readPixels` 只有在 `source instanceof ImageData`
    // 不成立时才会去碰 `document`，也才会抛出「读不到像素」。
    // 传 `readableCanvas()` 会走到推理，那是另一条路（对比 ④ 与正常路径）。
    const code = await expectSkipped(canvasLike(1000, 1400));
    expect(code).toBe('canvas_unreadable');
    // detail 必须说出真实原因，否则「环境问题」与「图片问题」仍不可分辨
    expect(getPageLayoutAnalysis()).toMatchObject({ ok: false, code: 'canvas_unreadable' });
    const detail = (getPageLayoutAnalysis() as { detail?: string }).detail ?? '';
    expect(detail).toContain('document');
  });

  it('③ geometry_unusable：画布尺寸为 0（这一页的重试没有意义）', async () => {
    const code = await expectSkipped(canvasLike(0, 1400));
    expect(code).toBe('geometry_unusable');
    expect((getPageLayoutAnalysis() as { detail?: string }).detail).toContain('0×1400');

    // 高为 0 走同一条出口；NaN 也是（`!NaN` 为真）
    resetLayoutSessionForTest();
    clearPageLayoutAnalysis();
    expect(await expectSkipped(canvasLike(1000, 0))).toBe('geometry_unusable');
    resetLayoutSessionForTest();
    clearPageLayoutAnalysis();
    expect(await expectSkipped(canvasLike(Number.NaN, 1400))).toBe('geometry_unusable');
  });

  it('④ session_load_failed：会话建不起来，且**真实原因进 detail**', async () => {
    ortMock.state.createMode = 'throw';
    ortMock.state.createError = new Error('Failed to fetch … PP-DocLayout-S.onnx');
    const code = await expectSkipped(readableCanvas());
    expect(code).toBe('session_load_failed');

    const outcome = getPageLayoutAnalysis() as { code: string; detail?: string };
    expect(outcome.code).toBe('session_load_failed');
    // 「模型 404」与「WASM 建不起来」与「超时」必须能分开 ——
    // 它们的下一步动作完全不同（查同源模型 / 查 CDN / 查网络）
    expect(outcome.detail).toContain('Failed to fetch');
    expect(outcome.detail).toContain('PP-DocLayout-S.onnx');
    expect(getLayoutSessionLoadError()).toContain('Failed to fetch');
  });

  it('④b 失败被缓存：同一页之后的所有页都报 session_load_failed（不再重试）', async () => {
    ortMock.state.createMode = 'throw';
    ortMock.state.createError = new Error('第一次就失败了');
    expect(await expectSkipped(readableCanvas())).toBe('session_load_failed');

    // 第二次调用：会话缓存里那个 rejected→null 的 promise 被复用，
    // **不会再调 create**（把 create 改成会成功也没用）
    ortMock.state.createMode = 'ok';
    ortMock.state.outputs = healthyOutputs();
    clearPageLayoutAnalysis();
    expect(await expectSkipped(readableCanvas())).toBe('session_load_failed');
  });

  it('⑤ inference_failed：会话在、张量在，但 run() 抛错（本页个例，可重试）', async () => {
    ortMock.state.runMode = 'throw';
    ortMock.state.runError = new Error('模拟 ONNX 运行期错误');
    const code = await expectSkipped(readableCanvas());
    expect(code).toBe('inference_failed');
    expect((getPageLayoutAnalysis() as { detail?: string }).detail).toContain('模拟 ONNX 运行期错误');
  });

  it('⑥ model_output_missing：两路输出取不到（导出件与契约不符，重试无用）', async () => {
    // 只有一路输出 —— 位置兜底 `values[1]` 拿不到 num 张量
    ortMock.state.outputs = { fetch_name_0: tensorOf([det(13, 0.9, 10, 20, 100, 60)]) };
    const code = await expectSkipped(readableCanvas());
    expect(code).toBe('model_output_missing');
    expect((getPageLayoutAnalysis() as { detail?: string }).detail).toContain('fetch_name_0');
  });

  it('⑦ no_regions_detected / 来源 A：模型报 0 行有效检测（合法结论，不必动作）', async () => {
    ortMock.state.outputs = {
      fetch_name_0: tensorOf([det(13, 0.9, 10, 20, 100, 60)]),
      fetch_name_1: { data: Int32Array.from([0]) },
    };
    const code = await expectSkipped(readableCanvas());
    expect(code).toBe('no_regions_detected');
    expect((getPageLayoutAnalysis() as { detail?: string }).detail).toContain('0 行有效检测');
  });

  it('⑦ no_regions_detected / 来源 B：行都在但全被丢弃（要调阈值，与 A 相反）', async () => {
    // 两行分数都低于 0.3 阈值 —— 行存在、被逐行丢掉
    ortMock.state.outputs = {
      fetch_name_0: tensorOf([det(13, 0.1, 10, 20, 100, 60), det(14, 0.2, 10, 30, 100, 70)]),
      fetch_name_1: { data: Int32Array.from([2]) },
    };
    const code = await expectSkipped(readableCanvas());
    expect(code).toBe('no_regions_detected');
    expect((getPageLayoutAnalysis() as { detail?: string }).detail).toContain('所有行都被丢弃');
  });

  it('⑦ no_regions_detected / 来源 C：框的中心落在画布外（查 scale_factor，最危险的一种）', async () => {
    // 画布只有 1000×1400，模型却给出 (5000,6000)-(5100,6050) ——
    // 正是 scale_factor 传反时会出现的形态
    ortMock.state.outputs = {
      fetch_name_0: tensorOf([det(13, 0.9, 5000, 6000, 5100, 6050)]),
      fetch_name_1: { data: Int32Array.from([1]) },
    };
    const code = await expectSkipped(readableCanvas());
    expect(code).toBe('no_regions_detected');
    expect((getPageLayoutAnalysis() as { detail?: string }).detail).toContain('中心落在画布外');
  });

  it('三个来源共用同一个码，但 detail 各不相同 —— 这才叫「能分辨」', async () => {
    const detailOf = async (outputs: Record<string, { data: ArrayLike<number> }>) => {
      ortMock.state.outputs = outputs;
      resetLayoutSessionForTest();
      clearPageLayoutAnalysis();
      await analyzePageLayout(readableCanvas());
      return (getPageLayoutAnalysis() as { detail?: string }).detail;
    };

    const a = await detailOf({
      fetch_name_0: tensorOf([det(13, 0.9, 10, 20, 100, 60)]),
      fetch_name_1: { data: Int32Array.from([0]) },
    });
    const b = await detailOf({
      fetch_name_0: tensorOf([det(13, 0.1, 10, 20, 100, 60)]),
      fetch_name_1: { data: Int32Array.from([1]) },
    });
    const c = await detailOf({
      fetch_name_0: tensorOf([det(13, 0.9, 5000, 6000, 5100, 6050)]),
      fetch_name_1: { data: Int32Array.from([1]) },
    });

    expect(new Set([a, b, c]).size, `三个 detail 必须互不相同：${a} / ${b} / ${c}`).toBe(3);
    // 每个 detail 都必须非空 —— 空 detail 等于回到「不可区分」
    for (const d of [a, b, c]) expect(d && d.length).toBeGreaterThan(4);
  });
});

// ═══════════════════════════════════════════════════════════════
// 方向二：正常路径不得产生任何失败码
// ═══════════════════════════════════════════════════════════════

describe('正常路径：不产生任何失败码', () => {
  it('推理成功时 outcome 是 none + 区域数，且**不是**任何一个失败码', async () => {
    ortMock.state.outputs = healthyOutputs();
    const { result, outcome } = await analyzePageLayout(readableCanvas());

    expect(outcome.ok).toBe(true);
    expect(outcome.code).toBe('none');
    expect(LAYOUT_SKIP_CODES as readonly string[]).not.toContain(outcome.code);

    // 区域真的解出来了（两行：header 与 footer）
    expect(result).not.toBeNull();
    expect(result!.regions).toHaveLength(2);
    expect(result!.regions.map((r) => r.label).sort()).toEqual(['footer', 'header']);
    expect(result!.width).toBe(1000);
    expect(result!.height).toBe(1400);

    // 成功时也要带上规模信息 —— 只写「none」回答不了「看出来几个区域」
    expect(outcome).toMatchObject({ ok: true, code: 'none', regionCount: 2, width: 1000, height: 1400 });

    // 旁挂记录与返回值必须一致（不一致会让导出说一套、判定做一套）
    expect(getPageLayoutAnalysis()).toEqual(outcome);
  });

  it('成功路径上没有任何 detail / 失败理由泄漏', async () => {
    ortMock.state.outputs = healthyOutputs();
    const { outcome } = await analyzePageLayout(readableCanvas());
    expect(outcome.ok).toBe(true);
    expect('detail' in outcome).toBe(false);
  });

  it('成功后再失败：旁挂记录必须换成失败（不会留着上一次的成功）', async () => {
    ortMock.state.outputs = healthyOutputs();
    await analyzePageLayout(readableCanvas());
    expect(getPageLayoutAnalysis()?.code).toBe('none');

    // 同一会话内第二次调用：这次推理抛错
    ortMock.state.runMode = 'throw';
    const { result, outcome } = await analyzePageLayout(readableCanvas());
    expect(result).toBeNull();
    expect(outcome.code).toBe('inference_failed');
    // ⚠️ 这一条专防「导出拿一个早已作废的成功记录去解释这一页」
    expect(getPageLayoutAnalysis()?.code).toBe('inference_failed');
  });

  /**
   * 旁挂记录**实际**的保证：每一条出口都会覆盖它。
   *
   * ⚠️ 这条用例是为一个**实测发现**写的：原先 `analyzePageLayout` 入口处
   * 有一行 `lastOutcome = undefined`，我原以为它负责「不残留上一页的结论」。
   * 变异测试把那行删掉后 **21 条用例全绿** —— 因为每一条 return 都经过
   * `done()`，而 `done()` 无条件写记录，于是「入口清空」在所有可达路径上
   * 都是死代码。那行已经删掉（连同 `ocrEngine` 里那次跨页清空），
   * 这条用例钉住的是**真正**在起作用的机制：`done()` 覆盖。
   */
  it('旁挂记录：先塞一个假值，任何一次调用都必须把它覆盖掉', async () => {
    // 塞一个**不可能由本次调用产生**的值。若记录不是每次都被覆盖，
    // 下面的断言就会读到它。
    setPageLayoutAnalysisForTest({ ok: false, code: 'model_output_missing', detail: '假值' });

    ortMock.state.runMode = 'throw';
    ortMock.state.runError = new Error('用来区分是不是本次调用写的');
    const { outcome } = await analyzePageLayout(readableCanvas());

    expect(outcome.code).toBe('inference_failed');
    // 记录必须等于**本次**结果，而不是那个假值
    expect(getPageLayoutAnalysis()).toEqual(outcome);
    expect(getPageLayoutAnalysis()?.code).not.toBe('model_output_missing');
  });

  it('旁挂记录：失败之后再一次成功，也要被覆盖（两个方向都覆盖）', async () => {
    ortMock.state.runMode = 'throw';
    await analyzePageLayout(readableCanvas());
    expect(getPageLayoutAnalysis()?.code).toBe('inference_failed');

    ortMock.state.runMode = 'ok';
    ortMock.state.outputs = healthyOutputs();
    const { outcome } = await analyzePageLayout(readableCanvas());
    expect(outcome.code).toBe('none');
    expect(getPageLayoutAnalysis()).toEqual(outcome);
  });
});
