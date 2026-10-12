import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ocrEngine } from '@/lib/ocrEngine';
import { detectMissedInkRegions } from '@/lib/ocrInkRegions';
import { buildOcrStructure } from '@/lib/ocrStructure';
import {
  admitOutboundFormulaCandidate,
  clearOutboundFormulaSkips,
  getOutboundFormulaSkips,
  OUTBOUND_FORMULA_MAX_REGION_AREA_RATIO,
} from '@/lib/outboundFormulaGate';
import { useSettingsStore } from '@/store/settingsStore';
import type { MissedInkRegion, OcrWord } from '@/lib/ocrTypes';

/**
 * ═══════════════════════════════════════════════════════════════
 * 「会外发的那条公式候选路」的面积闸门
 * ═══════════════════════════════════════════════════════════════
 *
 * 缺口（改动前实测，同一个探针跑两次的原始输出）：公式候选有两条来源，
 * 其中「有墨迹但没有词覆盖」那条（`ocrInkRegions.detectMissedInkRegions`）
 * 只按格子数与墨迹比例过滤，**没有任何面积上限**。800×1000 的全墨迹页面
 * ＋一个 16×16 的词框 → 最大候选覆盖 **100.0% 页面**，引擎**真的把它
 * 发出去了**（`POST …/api/formula-ocr`，请求数 1），还把返回的 LaTeX 当成
 * 整页的公式替换词。加闸门之后同一个探针：覆盖率仍是 100.0%（检测器没动），
 * 但**请求数 0**、返回词表与输入一致。也就是说整页识别失败或整页插图时，
 * 交出去的那块此前可以就是整页。
 *
 * 所以本文件钉两件事，**两个方向都要**：
 *   ① 超限候选**必须被挡下，且一个请求都不发**；
 *   ② 正常大小的候选**必须照常发送**（否则「修好了」可能只是把功能关掉了）。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么断言的是 fetch 调用次数，而不是「有没有这个闸门」
 * ═══════════════════════════════════════════════════════════════
 *
 * 本项目已经出现过 5 次以上的「假保护」，本文件逐个避开：
 *
 *  · **不读同进程里别的测试留下的当前值**：每个用例自己把开关设成它需要的
 *    状态（并在 `afterEach` 复原），断言的是「这次调用真的发了几个请求」。
 *    另有一条用例在**同一个候选**上先关后开，证明计数跟着**调用那一刻**
 *    的状态走，而不是某个被前一个用例写过的模块级变量。
 *  · **不写 `toMatch(/名字/)` 那种会匹配到 import 语句的断言**：本文件的
 *    行为断言全部是运行期抓包；只有两条**结构**断言读源码，且都锚在
 *    **调用形态**上（`admitOutboundFormulaCandidate({` 与
 *    `await recognizeFormula(`，import 语句里没有 `(` 跟着）。
 *  · **不是只验「闸门存在」**：`blocked` 用例断言**请求数为 0**，
 *    `allowed` 用例断言**请求数为 1 且请求体里就是那张 PNG** ——
 *    把闸门改成常量、改错阈值、或者「记了日志但照样发」，两条都会红。
 *
 * ⚠️ 测试替身：node 里没有 `document` / `ImageData` / `HTMLCanvasElement`，
 * 而这条链路要 `createElement('canvas')` + `toBlob`。缺了它们，代码会在
 * 到达闸门之前就抛错，于是「零请求」会因为**完全无关的原因**变绿 ——
 * 那正是本文件要防的假保护，所以下面把替身补齐并让**允许**方向也真的走通。
 */

/**
 * 读源码。
 *
 * ⚠️ 带重试不是防御性编程：Windows 上文件可能被**并发写**（本项目多个任务
 * 共用同一个工作树，本次实测撞到过 `EBUSY: resource busy or locked`）。
 * 重试用尽后**如实抛出**，不静默跳过 —— 跳过等于一条看不见的假绿。
 */
function readText(absPath: string): string {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return readFileSync(absPath, 'utf8');
    } catch (err) {
      lastErr = err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  throw new Error(`读不到源码文件 ${absPath}（被占用？不允许静默跳过）：${String(lastErr)}`);
}

const OCR_ENGINE_SRC = readText(join(process.cwd(), 'src/lib/ocrEngine.ts'));

/** 8 字节 PNG 魔数：这一层只需要它能把「发的是那张 PNG」验证到底 */
const PNG_MAGIC = [137, 80, 78, 71, 13, 10, 26, 10];

class FakeCtx {
  fillStyle = '';
  imageSmoothingEnabled = false;
  imageSmoothingQuality = '';
  fillRect(): void {}
  drawImage(): void {}
  putImageData(): void {}
}

class FakeCanvas {
  width = 0;
  height = 0;
  getContext(): FakeCtx {
    return new FakeCtx();
  }
  toBlob(cb: (blob: unknown) => void): void {
    cb({ arrayBuffer: async () => new Uint8Array(PNG_MAGIC).buffer });
  }
}

class FakeImageData {
  constructor(
    public width: number,
    public height: number,
    public data: Uint8ClampedArray,
  ) {}
}

class FakeOffscreenCanvas {
  width = 0;
  height = 0;
}

/**
 * 本次调用里 `document.createElement('canvas')` 造出来的每一张画布。
 *
 * 为什么要记它：**光看请求数分不出「发的是哪一块」**。同页有大小两个候选时，
 * 「发了一次」既可能是发了该发的那个小块，也可能是发了该挡的那个大块 ——
 * 用分配出来的裁剪尺寸才能把这件事钉死（见「同页混合」那条用例）。
 */
const createdCanvases: FakeCanvas[] = [];

function stubBrowserGlobals(): void {
  vi.stubGlobal('HTMLCanvasElement', FakeCanvas);
  vi.stubGlobal('ImageData', FakeImageData);
  vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
  vi.stubGlobal('document', {
    createElement: () => {
      const canvas = new FakeCanvas();
      createdCanvases.push(canvas);
      return canvas;
    },
  });
}

/** 抓包：记下每一次真的发出去的请求（url + init） */
function startCapture(): { url: string; init?: RequestInit }[] {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return {
        ok: true,
        json: async () => ({ latex: 'x^{2}+y^{2}' }),
      } as unknown as Response;
    }),
  );
  return calls;
}

/** 造一张白底页面，并在给定矩形内画满深色像素 */
function makePage(
  width: number,
  height: number,
  inks: { x: number; y: number; w: number; h: number }[],
): FakeImageData {
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (const r of inks) {
    for (let y = Math.max(0, r.y); y < Math.min(height, r.y + r.h); y++) {
      for (let x = Math.max(0, r.x); x < Math.min(width, r.x + r.w); x++) {
        const p = (y * width + x) * 4;
        data[p] = 0;
        data[p + 1] = 0;
        data[p + 2] = 0;
        data[p + 3] = 255;
      }
    }
  }
  return new FakeImageData(width, height, data);
}

const word = (text: string, x0: number, y0: number, x1: number, y1: number, confidence = 99): OcrWord => ({
  text,
  confidence,
  bbox: { x0, y0, x1, y1 },
  fontSize: y1 - y0,
});

/** 那一个「16×16 的词框」—— 与既有实测用例（outboundExclusions ⑦）同一张图 */
const TINY_WORD = word('A', 0, 0, 16, 16);

/**
 * 800×1000 **全墨迹**页面 + 一个 16×16 的词框。
 *
 * 这是「整页识别失败 / 整页插图」的最坏情形：除了那 4 个被词框盖住的格子，
 * 整页都是墨迹格，于是一个连通区域覆盖整页。改动前实测覆盖率 **100.0%**。
 */
function fullInkPage(extraInk: { x: number; y: number; w: number; h: number }[] = []) {
  const image = makePage(800, 1000, [{ x: 0, y: 0, w: 800, h: 1000 }, ...extraInk]);
  const regions = detectMissedInkRegions(image as unknown as ImageData, [TINY_WORD]);
  return { image, regions };
}

/** 覆盖率最大的那个候选（诊断用；也是「93% 那个场景」的被测对象） */
function biggest(regions: MissedInkRegion[]): MissedInkRegion {
  return regions.reduce((a, b) =>
    (b.x1 - b.x0) * (b.y1 - b.y0) > (a.x1 - a.x0) * (a.y1 - a.y0) ? b : a,
  );
}

function coverageOf(region: MissedInkRegion, image: FakeImageData): number {
  return ((region.x1 - region.x0) * (region.y1 - region.y0)) / (image.width * image.height);
}

/**
 * 走**真实的发送链路**：`enhanceFormulaRegions` 是私有的（`private` 只在
 * TS 层存在，运行期就是普通方法），这里按它的真实签名取出来直接调用。
 * 用 `as unknown as` 而不是 `any`：签名写错时 `tsc -b` 会报错。
 */
type EngineUnderTest = {
  enhanceFormulaRegions(
    words: OcrWord[],
    image: ImageData | HTMLCanvasElement | OffscreenCanvas,
    missedInkRegions?: MissedInkRegion[],
  ): Promise<OcrWord[]>;
};

function enhance(
  words: OcrWord[],
  image: FakeImageData,
  regions: MissedInkRegion[],
): Promise<OcrWord[]> {
  return (ocrEngine as unknown as EngineUnderTest).enhanceFormulaRegions(
    words,
    image as unknown as ImageData,
    regions,
  );
}

beforeEach(() => {
  stubBrowserGlobals();
  createdCanvases.length = 0;
  vi.stubEnv('VITE_TRANSLATE_ENDPOINT', 'https://proxy.test/api/translate');
  // 显式打开：本文件不依赖「默认值」这个事实（那条由 formulaOcrPrivacy.test.ts 守）
  useSettingsStore.getState().setFormulaOcrEnabled(true);
  clearOutboundFormulaSkips();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  useSettingsStore.getState().setFormulaOcrEnabled(false);
  clearOutboundFormulaSkips();
});

// ═══════════════════════════════════════════════════════════════
// ① 超限：必须被挡下，且一个请求都不发
// ═══════════════════════════════════════════════════════════════

describe('① 面积超限的候选：挡下 + 零请求', () => {
  it('整页墨迹那条候选（实测覆盖整页）被挡下，且**没有发出任何请求**', async () => {
    const { image, regions } = fullInkPage();
    const max = biggest(regions);
    const coverage = coverageOf(max, image);

    // 前提先钉住：这个夹具确实是「接近整页」的那种候选 ——
    // 否则下面「零请求」可能是因为候选本来就很小、与闸门无关（假保护）
    expect(coverage, `夹具失效：最大候选只覆盖 ${(coverage * 100).toFixed(1)}%`).toBeGreaterThan(0.85);

    const calls = startCapture();
    const out = await enhance([TINY_WORD], image, regions);

    expect(calls, `超限候选仍然发出了请求：${calls.map((c) => c.url).join(', ')}`).toHaveLength(0);
    // 结果必须与输入一致：被挡下的候选不能留下替换词
    expect(out.map((w) => w.text)).toEqual(['A']);
  });

  it('被挡下的候选进得了导出（用户能看见「找到了、但没发出去」）', async () => {
    const { image, regions } = fullInkPage();
    await enhance([TINY_WORD], image, regions);

    const skips = getOutboundFormulaSkips();
    expect(skips).toHaveLength(1);
    const skip = skips[0]!;
    expect(skip.source).toBe('missed-ink');
    expect(skip.coverage).toBeGreaterThan(0.85);
    expect(skip.limit).toBe(OUTBOUND_FORMULA_MAX_REGION_AREA_RATIO);
    expect(skip.page).toEqual({ width: 800, height: 1000 });
    // 结论必须是**可读的**：占比、上限、以及「没有发出去」这件事实
    expect(skip.reason).toContain('上限');
    expect(skip.reason).toContain('没有');
    expect(skip.reason).toContain('SimpleTex');

    // 而它必须真的出现在用户能复制的那份导出里
    const structure = buildOcrStructure({
      pageNum: 1,
      dominantFontSize: 12,
      words: [],
      lines: [],
      blocks: [],
    });
    const round = JSON.parse(JSON.stringify(structure)) as {
      outboundFormulaSkips?: { coverage: number; reason: string }[];
    };
    expect(round.outboundFormulaSkips).toHaveLength(1);
    expect(round.outboundFormulaSkips?.[0]?.coverage).toBe(skip.coverage);
  });

  it('没有任何候选被挡下时，导出里**不写**这个字段（逐字节不变量不破）', () => {
    // `pageLayoutInvariant.test.ts` 要求「无版面信息时导出与接入前逐字节相同」，
    // 所以这个字段是**条件写出的**：空的时候整个字段缺席（代价见字段注释）。
    const structure = buildOcrStructure({
      pageNum: 1,
      dominantFontSize: 12,
      words: [],
      lines: [],
      blocks: [],
    });
    expect('outboundFormulaSkips' in structure).toBe(false);
  });

  it('词聚类那条来源同样受管（不是只挡「漏识别墨迹」那一条）', async () => {
    // 一页低置信度的词会被聚成**一个**区域 —— 同样可以接近整页
    const image = makePage(800, 1000, []);
    const words = [word('PP', 0, 0, 600, 900, 40), word('QQ', 620, 0, 780, 900, 45)];

    const calls = startCapture();
    const out = await enhance(words, image, []);

    expect(calls, '词聚类给出的整页候选仍然发了出去').toHaveLength(0);
    expect(out.map((w) => w.text)).toEqual(['PP', 'QQ']);
    expect(getOutboundFormulaSkips()[0]?.source).toBe('word-cluster');
  });

  it('阈值是**含**边界（与本地重试同一口径）：正好 30% 放行，超一点就挡', () => {
    const page = { pageWidth: 1000, pageHeight: 1000 };
    const exact = admitOutboundFormulaCandidate({
      bbox: { x0: 0, y0: 0, x1: 600, y1: 500 }, // 300000 / 1000000 = 0.300
      source: 'missed-ink',
      ...page,
    });
    expect(exact.allowed).toBe(true);
    expect(exact.coverage).toBe(0.3);
    expect(getOutboundFormulaSkips(), '放行的候选不该进记录').toHaveLength(0);

    const over = admitOutboundFormulaCandidate({
      bbox: { x0: 0, y0: 0, x1: 601, y1: 500 },
      source: 'missed-ink',
      ...page,
    });
    expect(over.allowed).toBe(false);
    // 判决与记录是**同一个调用**产生的，不可能出现「判了却没记」
    expect(getOutboundFormulaSkips()).toHaveLength(1);
    expect(getOutboundFormulaSkips()[0]?.coverage).toBe(0.301);
  });

  it('页面尺寸量不出来时按「不外发」处理（隐私闸门 fail closed）', () => {
    const decision = admitOutboundFormulaCandidate({
      bbox: { x0: 0, y0: 0, x1: 10, y1: 10 },
      source: 'missed-ink',
      pageWidth: 0,
      pageHeight: 0,
    });
    expect(decision.allowed).toBe(false);
    expect(getOutboundFormulaSkips()[0]?.reason).toContain('量不出');
  });

  /**
   * ⚠️ 这一条是**变异测试逼出来的**（M1 第一轮**存活**）。
   *
   * 把发送循环改回 `regions`（= 闸门只记日志、不真正生效）时，上面
   * 「整页候选」那条**照样是绿的**：那种情形里 `if (!sendable.length) return words;`
   * 已经提前返回，循环体根本没执行 —— 也就是说「**全**被挡下」这个方向
   * 盖不住「**挡一部分**」。这正是本项目反复吃亏的那类假保护：
   * 用例全绿，而代码里的闸门可以整个失效。
   *
   * 所以这里造一页**两个候选**：一个约 80% 的大块（该挡）+ 一个约 0.4%
   * 的小块（该发）。请求数必须是 1，而且发出去的必须是**小的那一块**。
   */
  it('同页混合（一大一小）：只发小的那块，大的那块仍然被挡', async () => {
    const image = makePage(800, 1000, [
      { x: 0, y: 0, w: 700, h: 900 }, // 大块：约 80% 页面 → 该挡
      { x: 720, y: 950, w: 60, h: 40 }, // 小块：约 0.4% 页面 → 该发
    ]);
    const regions = detectMissedInkRegions(image as unknown as ImageData, [TINY_WORD]);
    expect(regions.length, '夹具失效：两个墨迹块必须被分成两个区域').toBe(2);
    const coverages = regions.map((r) => coverageOf(r, image));
    expect(Math.max(...coverages)).toBeGreaterThan(0.5);
    expect(Math.min(...coverages)).toBeLessThan(OUTBOUND_FORMULA_MAX_REGION_AREA_RATIO);

    createdCanvases.length = 0;
    const calls = startCapture();
    await enhance([TINY_WORD], image, regions);

    expect(calls, '同页混合时请求数不对：闸门要么全放行、要么全挡下').toHaveLength(1);
    // #0 是 `ensureCanvas` 的整页画布，#1 是这次真正的裁剪
    expect(createdCanvases, '分配的画布不是「整页一张 + 裁剪一张」').toHaveLength(2);
    const crop = createdCanvases[1]!;
    expect(
      crop.width < 100 && crop.height < 100,
      `被送出去的是 ${crop.width}×${crop.height} 的裁剪 —— 那是**大的**那一块`,
    ).toBe(true);
    // 而记录里正好是大的那一块
    const skips = getOutboundFormulaSkips();
    expect(skips).toHaveLength(1);
    expect(skips[0]?.coverage).toBeGreaterThan(0.5);
  });
});

// ═══════════════════════════════════════════════════════════════
// ② 正常面积：必须照常发送（否则「修好了」只是把功能关掉了）
// ═══════════════════════════════════════════════════════════════

describe('② 正常面积的候选：照常发送', () => {
  it('一小块漏识别墨迹（约 3% 页面）仍然发一次请求，且请求体里就是那张 PNG', async () => {
    const image = makePage(800, 1000, [{ x: 100, y: 200, w: 200, h: 100 }]);
    const regions = detectMissedInkRegions(image as unknown as ImageData, [TINY_WORD]);
    expect(regions, '夹具失效：没检测出任何漏识别区域').toHaveLength(1);
    expect(coverageOf(regions[0]!, image)).toBeLessThan(OUTBOUND_FORMULA_MAX_REGION_AREA_RATIO);

    const calls = startCapture();
    const out = await enhance([TINY_WORD], image, regions);

    expect(calls, '正常大小的候选没有发出去 —— 闸门把功能关掉了').toHaveLength(1);
    expect(calls[0]?.url).toContain('/api/formula-ocr');

    // 「发了」还不够：要证明发的确实是**这次的裁剪图**
    const body = JSON.parse(String(calls[0]?.init?.body)) as { image?: string };
    expect(Object.keys(body)).toEqual(['image']);
    const bytes = Buffer.from(body.image ?? '', 'base64');
    expect([...bytes.subarray(0, 8)]).toEqual(PNG_MAGIC);

    // 并且结果真的用上了返回的 LaTeX（否则「发了」可能发的是别的东西）
    expect(out.map((w) => w.text)).toEqual(['A', '$x^{2}+y^{2}$']);
    expect(getOutboundFormulaSkips(), '正常候选不该留下被挡记录').toHaveLength(0);
  });

  it('词聚类给出的小候选同样照常发送', async () => {
    const image = makePage(800, 1000, []);
    const words = [word('PP', 100, 100, 140, 120, 40), word('QQ', 150, 100, 190, 120, 45)];

    const calls = startCapture();
    await enhance(words, image, []);

    expect(calls).toHaveLength(1);
  });

  it('闸门判的是**调用那一刻**的开关状态（不是别处留下的值）', async () => {
    const image = makePage(800, 1000, [{ x: 100, y: 200, w: 200, h: 100 }]);
    const regions = detectMissedInkRegions(image as unknown as ImageData, [TINY_WORD]);

    // 关 → 零请求（既有防线）
    useSettingsStore.getState().setFormulaOcrEnabled(false);
    const off = startCapture();
    await enhance([TINY_WORD], image, regions);
    expect(off).toHaveLength(0);

    // 开 → 同一个候选这一次真的发出去
    useSettingsStore.getState().setFormulaOcrEnabled(true);
    const on = startCapture();
    await enhance([TINY_WORD], image, regions);
    expect(on).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// ③ 结构：闸门必须在**发送之前**，清空必须在**本页增强之前**
// ═══════════════════════════════════════════════════════════════

describe('③ 源码结构（锚在调用形态上，不匹配 import）', () => {
  it('面积闸门早于 cropCanvas 与 recognizeFormula —— 判决不是发出去以后才补的', () => {
    // ⚠️ 找的是**调用形态**：`admitOutboundFormulaCandidate({` 与
    // `await recognizeFormula(`。import 语句里没有 `(` 跟着标识符，
    // 所以不会像 `toMatch(/名字/)` 那样匹配到 import（本项目出现过的那种假绿）。
    const gate = OCR_ENGINE_SRC.indexOf('admitOutboundFormulaCandidate({');
    const crop = OCR_ENGINE_SRC.indexOf('const crop = cropCanvas(canvas, region.bbox);');
    const send = OCR_ENGINE_SRC.indexOf('await recognizeFormula(');

    expect(gate, 'ocrEngine.ts 里找不到闸门调用').toBeGreaterThan(-1);
    expect(crop, 'ocrEngine.ts 里找不到裁剪调用').toBeGreaterThan(-1);
    expect(send, 'ocrEngine.ts 里找不到发送调用').toBeGreaterThan(-1);

    expect(gate, '闸门在裁剪之后才生效').toBeLessThan(crop);
    expect(gate, '闸门在发送之后才生效 —— 那就不是闸门').toBeLessThan(send);
  });

  it('记录按页清空，且清空发生在本页公式增强之前', () => {
    const clear = OCR_ENGINE_SRC.indexOf('clearOutboundFormulaSkips();');
    const call = OCR_ENGINE_SRC.indexOf('await this.enhanceFormulaRegions(');
    expect(clear, 'ocrEngine.ts 里找不到按页清空（记录会跨页累积）').toBeGreaterThan(-1);
    expect(call, 'ocrEngine.ts 里找不到 enhanceFormulaRegions 调用').toBeGreaterThan(-1);
    expect(clear).toBeLessThan(call);
  });

  it('发送循环迭代的是**过了闸门**的那一批（写成 regions 时这条与「同页混合」都会红）', () => {
    // 冗余的一道：变异 M1（把 `sendable` 改回 `regions`）在「全被挡下」那一支
    // 里是**行为惰性**的（提前返回兜住了），只有「同页混合」那条能靠行为抓住它。
    // 这条直接把代码形态钉住，改回去就红 —— 不是为了好看，是因为我自己
    // 第一轮就是这么写错的（写完只改日志、忘了改循环）。
    expect(OCR_ENGINE_SRC).toMatch(/for \(const region of sendable\) \{/);
  });
});

// ═══════════════════════════════════════════════════════════════
// ④ 那条陈旧口径：不能再写「唯一」
// ═══════════════════════════════════════════════════════════════

describe('④ 「唯一会把文档内容送出本机」这条口径已经作废', () => {
  /** 取锚点**紧前面**的那段文档注释（`/** … *\/`） */
  function docBlockBefore(anchor: string): string {
    const at = OCR_ENGINE_SRC.indexOf(anchor);
    expect(at, `找不到锚点：${anchor}`).toBeGreaterThan(-1);
    const start = OCR_ENGINE_SRC.lastIndexOf('/**', at);
    expect(start, `锚点前面没有文档注释：${anchor}`).toBeGreaterThan(-1);
    return OCR_ENGINE_SRC.slice(start, at);
  }

  it('enhanceFormulaRegions 的文档注释逐一列出了三条外发路径的开关名', () => {
    // ⚠️ 断言的是**那段注释本身**（不是「文件里出现过某个标识符」——
    // 标识符在代码里当然有，那样写等于什么都没验）
    const doc = docBlockBefore('private async enhanceFormulaRegions');
    expect(doc).toContain('默认不外发');
    expect(doc).toContain('formulaOcrEnabled');
    expect(doc).toContain('cloudTranslationConsent');
    expect(doc).toContain('ttsCloudConsent');
    expect(doc, '口径必须指向清单真源').toContain('outboundPaths');
  });

  it('全文件不再把「唯一…会把文档内容送出本机」当成**事实**来写', () => {
    // ⚠️ 不能只写 `not.toMatch(/唯一\*\*会把文档内容送出本机/)`：
    // 上面那段**更正**注释里就引用了这句原文（引号里，说明它已经作废），
    // 一刀切的否定会把正确的注释判成错的（假红）。所以判据是：
    // 这句原文只允许出现在**点明它原本是错的**那一行里。
    const claims = OCR_ENGINE_SRC.split('\n').filter((line) =>
      /唯一\*\*会把文档内容送出本机的路径|全应用唯一会把内容送出本机/.test(line),
    );
    expect(claims.length, '连更正注释都没有了 —— 这条断言会变成空转（假绿）').toBeGreaterThan(0);
    for (const line of claims) {
      expect(line, `这一行又把「唯一」当成事实在写：${line.trim()}`).toMatch(/原本|错的|作废/);
    }
    // 老原文（把「唯一」当事实的那两句）一个字都不许回来
    expect(OCR_ENGINE_SRC).not.toMatch(/这是全应用\*\*唯一\*\*会把文档内容送出本机的路径，因此受/);
    expect(OCR_ENGINE_SRC).not.toMatch(/这是全应用唯一会把内容送出本机的路径，多发一次/);
  });
});
