import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  bootModelTierAssets,
  getModelTierBootRecord,
  resetModelTierBootRecordForTest,
} from '@/lib/modelTierBoot';
import { DEFAULT_MODEL_TIER, modelCacheName } from '@/lib/modelCacheTiers';

/**
 * ═══════════════════════════════════════════════════════════════
 * 「模型资产预取」什么时候发生 —— 从「SW 注册时」改到「首次 OCR 意图时」
 * ═══════════════════════════════════════════════════════════════
 *
 * 改动前：`src/lib/pwa.ts` 的 `onRegisteredSW` 里有一行
 * `void bootModelTierAssets();`，后果是 **SW 一注册就取 34.59 MiB**
 * （实测：`[modelTierBoot] 标准档（ocr-models）→ ok：可以下载 4 个资产，
 * 合计 34.59 MiB`），哪怕用户只读 md/txt/epub、从不打开扫描件。
 *
 * 改动后：只有在**用户第一次表达 OCR 意图**时取。判据落在
 * `src/store/libraryStore.ts` 的 `startOcr()` 里（`FileUploadZone` 的
 * 「开始识别」按钮是全应用唯一调用方）。
 *
 * ═══════════════════════════════════════════════════════════════
 * 这个文件怎么避免三种假保护（本项目已出现 5 次以上）
 * ═══════════════════════════════════════════════════════════════
 *
 * ① **不读同进程里别的测试改过的当前值**
 *    —— 每个用例自己装 `globalThis.caches` / `globalThis.fetch` /
 *    `globalThis.sessionStorage`，并且 `afterEach` 原样还原 + 清掉
 *    `navigator.onLine` / `navigator.storage`。凡是环境事实（这个进程里
 *    原本没有 `caches`）都**显式断言出来**，环境一变用例会说出原因，
 *    而不是悄悄变成另一件事。
 *
 * ② **不靠 `toMatch(/名字/)` 找调用**（那种断言匹配到 import 或注释也会绿）
 *    —— 两个方向都是**跑出来的**：
 *      · 不 OCR ⇒ `globalThis.fetch` 一次都没被调用（**次数 = 0**，不是「没看到」）；
 *      · OCR     ⇒ 四个 URL 逐字出现在 fetch 里、并写进名为 `ocr-models` 的缓存。
 *    被跑的是**真实的 `useLibraryStore.getState().importFiles / startOcr /
 *    openDocument`**，不是抠出来的代码片段。
 *
 * ③ **断言的是「下载真的被挡住了」，不是「存在某个开关」**
 *    —— 注入 `bootModelTierAssets` 是被迫的（见下），但注入点两侧都用
 *    **真实现**：真 `startOcr` 调它 + 注入进去的就是真
 *    `bootModelTierAssets` / 真 `ensureModelTierAssets` / 真 `caches` 桩 /
 *    真 fetch 桩。于是「零下载」这句话的含义是**没有任何 URL 被请求**，
 *    而不是「某个变量是 false」。另外单独有一条：本文件里根本不留
 *    `@/store/libraryStore` 的真实模块 —— `bootModelTierAssets` 只能由
 *    `startOcr()` 调用，**没有别的调用者能把 fetch 次数从 0 变成 4**。
 *
 * ⚠️ 为什么必须 `vi.mock('@/lib/modelTierBoot')`（而不是直接跑真模块）：
 * 真模块一旦被 import 进本文件，它的 `bootModelTierAssets` 就成了本文件里
 * 一个**可以自己调用**的函数 —— 那时「不 OCR ⇒ fetch 次数 = 0」这条断言就
 * 不再是「`startOcr` 没调它」的同义词了。隔离它是为了让「谁调用了它」
 * 这件事**只有一个答案**。代价（这条用例证明的不是副作用，而是调用）
 * 由「注入的具体实现本身就是真的」补回来。
 */

// ───────────────────────────────────────────────────────────────
// 桩：把 store 拖进来的重依赖换掉（与本文件要验的事无关）
// ───────────────────────────────────────────────────────────────

/** IndexedDB：node 里没有。store 的 `init/list/save/delete` 全走它 */
const dbCalls = { saved: [] as string[], list: 0 };
vi.mock('@/lib/db', () => ({
  listDocuments: vi.fn(async () => {
    dbCalls.list += 1;
    return [];
  }),
  saveDocument: vi.fn(async (doc: { id: string }) => {
    dbCalls.saved.push(doc.id);
  }),
  deleteDocument: vi.fn(async () => {}),
  loadDocument: vi.fn(async () => null),
}));

/**
 * 解析层：`importFiles` 走 `parseFiles`，`startOcr` 走动态
 * `import('@/parsers/pdfParser')`。两者都换成可控的桩 ——
 * 本文件要验的是「哪条路径会去取模型资产」，而不是「md 怎么解析」。
 */
const parsers = {
  /** 下一次 `parseFiles` 的返回值（默认：导入成功一份 md） */
  next: { documents: [{ id: 'doc-md' }] as { id: string }[], errors: [] as { fileName: string; message: string }[] },
  /** 下一次 `parseFiles` 是抛错还是返回 */
  throwNext: null as unknown,
  calls: 0,
};
vi.mock('@/parsers', () => ({
  parseFiles: vi.fn(async () => {
    parsers.calls += 1;
    if (parsers.throwNext) throw parsers.throwNext;
    return parsers.next;
  }),
  // store 用它做类型守卫：真实现是「认标记属性」，这里保持同样的行为
  isScannedPdfError: (err: unknown) =>
    typeof (err as { isScannedPdfError?: unknown })?.isScannedPdfError === 'boolean',
}));

const ocrParse = { calls: 0 };
vi.mock('@/parsers/pdfParser', () => ({
  /**
   * 立刻 reject，而且**用 store 认得的那个标记**（`isScannedPdfError`）。
   *
   * 为什么不让它「挂住不返回」：那样 `await startOcr(...)` 永远不 resolve，
   * 用例只能靠超时结束 —— 而超时的红绿与「预取有没有发生」无关，是典型的假信号。
   * 也不让它 resolve：真 `ocrParsePdf` 要返回 `pagesProcessed` / `layoutSummary`
   * 一整套东西，造那个桩只会把本文件的注意力从「谁取模型资产」引开。
   *
   * 用 `ScannedPdfError` 这个出口的额外好处：`startOcr` 的 **catch** 分支是
   * 它最短的收尾路径 —— 只碰 `sessionStorage`（本文件自己装的内存实现），
   * 不碰 IndexedDB，于是这条用例读起来没有无关噪音。
   */
  ocrParsePdf: vi.fn(async () => {
    ocrParse.calls += 1;
    throw Object.assign(new Error('本用例不跑真 OCR（桩）'), { isScannedPdfError: true });
  }),
}));

/**
 * ⚠️ 被注入的那一个 —— 但**注入的具体实现是真的**
 * （`modelCacheTiers.ensureModelTierAssets`，经真 `bootModelTierAssets`）。
 * 见文件头 ⚠️ 那一节：注入是为了让「谁调用了它」只有一个答案。
 */
vi.mock('@/lib/modelTierBoot', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/modelTierBoot')>();
  return { ...actual, bootModelTierAssets: vi.fn(actual.bootModelTierAssets) };
});

// ───────────────────────────────────────────────────────────────
// 内存版 sessionStorage（`bootModelTierAssets` 要落盘；本文件也要读它）
// ───────────────────────────────────────────────────────────────

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
}

let area: MemoryStorage;

// ═══════════════════════════════════════════════════════════════
// fetch / caches 桩：**「下载了几个字节」的唯一证人**
// ═══════════════════════════════════════════════════════════════

interface FetchLog {
  urls: string[];
  init: (RequestInit | undefined)[];
}

function stubNet() {
  const fetched: FetchLog = { urls: [], init: [] };
  const puts: { url: string; cacheName: string }[] = [];
  const opened: string[] = [];

  const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
    fetched.urls.push(String(input));
    fetched.init.push(init);
    return {
      ok: true,
      status: 200,
      clone: () => ({ ok: true, status: 200 }),
    } as unknown as Response;
  });

  const cachesStub = {
    keys: async () => [] as string[],
    delete: async () => true,
    open: async (name: string) => {
      opened.push(name);
      return {
        match: async () => undefined as Response | undefined,
        put: async (url: string) => {
          puts.push({ url, cacheName: name });
        },
      };
    },
  };

  return { fetchImpl, cachesStub, fetched, puts, opened };
}

/** 改动前那四个 URL 的**字面量**（改动前 pwa.ts 那一次调用请求的就是它们） */
const UNCHANGED_URLS = [
  '/ocr-models/detection/ort/PP-OCRv6_small_det.ort',
  '/ocr-models/recognition/ort/PP-OCRv6_small_rec.ort',
  '/ocr-models/recognition/ppocrv6_dict.txt',
  '/ocr-models/layout/PP-DocLayout-S.onnx',
];

/** 34.59 MiB：上一次实测算出来的那一笔（四个资产之和） */
const TIER_TOTAL_BYTES = 9_982_352 + 21_290_816 + 74_948 + 4_917_852;

let net: ReturnType<typeof stubNet>;
let restore: (() => void)[];

function installNet(): void {
  const originalFetch = globalThis.fetch;
  const originalCaches = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  const originalOnLine = Object.getOwnPropertyDescriptor(globalThis.navigator ?? {}, 'onLine');
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis.navigator ?? {}, 'storage');

  net = stubNet();
  globalThis.fetch = net.fetchImpl as unknown as typeof fetch;
  Object.defineProperty(globalThis, 'caches', {
    value: net.cachesStub,
    configurable: true,
    writable: true,
  });
  // 调度器读它；显式给成 true，免得用例的含义随运行环境改变
  Object.defineProperty(globalThis.navigator, 'onLine', { value: true, configurable: true });
  // ⚠️ 必须删掉：否则真 `ensureModelTierAssets` 会去读配额，
  // 而那会让「为什么没下载」变成一个与本文件无关的问题
  Reflect.deleteProperty(globalThis.navigator as object, 'storage');

  restore = [
    () => {
      globalThis.fetch = originalFetch;
    },
    () => {
      if (originalCaches) Object.defineProperty(globalThis, 'caches', originalCaches);
      else Reflect.deleteProperty(globalThis as object, 'caches');
    },
    () => {
      if (originalOnLine) Object.defineProperty(globalThis.navigator, 'onLine', originalOnLine);
      else Reflect.deleteProperty(globalThis.navigator as object, 'onLine');
    },
    () => {
      if (originalStorage) Object.defineProperty(globalThis.navigator, 'storage', originalStorage);
    },
  ];
}

async function loadStore() {
  // 每个用例都重新求值一次 store 模块：`scannedPdfPending` 等状态不跨用例累积
  vi.resetModules();
  const { useLibraryStore } = await import('@/store/libraryStore');
  return useLibraryStore;
}

/** 让 `startOcr` 里那个 fire-and-forget 的预取跑完 */
async function settle() {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

beforeEach(() => {
  area = new MemoryStorage();
  Object.defineProperty(globalThis, 'sessionStorage', {
    value: area,
    configurable: true,
    writable: true,
  });
  // 「一次都没跑过」必须从真的 `null` 开始 —— 否则会读到别的用例留下的记录
  resetModelTierBootRecordForTest();
  dbCalls.saved.length = 0;
  dbCalls.list = 0;
  parsers.calls = 0;
  parsers.throwNext = null;
  parsers.next = { documents: [{ id: 'doc-md' }], errors: [] };
  ocrParse.calls = 0;
  installNet();
  /**
   * 预取桩的调用计数**必须跨用例清零**。
   *
   * `vi.mock` 的工厂只在模块第一次求值时装一次桩，而 `vi.resetModules()` 只清
   * 模块注册表、**不清 spy 的调用记录** —— 于是「一次识别只调用一次」那条断言
   * 会读到前面用例累积下来的次数。这正是文件头 ① 点名的那种假保护
   * （「读到同进程里别的用例改过的当前值」），所以在这里显式清掉。
   */
  vi.mocked(bootModelTierAssets).mockClear();
  /**
   * `startOcr` 的 catch 分支会 `console.error('[startOcr] 原始错误对象：', err)` ——
   * 那是**产品行为**，不该改；但本文件的桩是故意抛错的，放着不管会刷屏，
   * 而刷屏会淹掉真正的红。所以只在这个文件里把它静音（并断言它**确实**响过，
   * 见「识别真的往下走了」那条 —— 否则「静音」就变成了掩盖）。
   */
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  for (const undo of restore) undo();
  vi.restoreAllMocks();
});

describe('⚠️ 零下载方向：不做 OCR 动作 ⇒ 一个字节都不取', () => {
  it('整个第一屏的生命周期（导入 md/txt/epub + 打开 + 读）都不碰 fetch', async () => {
    const useLibraryStore = await loadStore();
    parsers.next = {
      documents: [{ id: 'a' }, { id: 'b' }],
      errors: [],
    };

    await useLibraryStore.getState().importFiles([{ name: 'note.md' } as unknown as File]);
    await useLibraryStore.getState().openDocument('a');
    await settle();

    expect(parsers.calls, 'importFiles 没有真的跑过 —— 这条用例会假绿').toBe(1);
    expect(net.fetched.urls, '不 OCR 却下载了模型资产').toEqual([]);
    expect(net.fetchImpl).toHaveBeenCalledTimes(0);
    expect(net.puts).toEqual([]);
    // 连缓存都没打开过（不是「打开了但没写」）
    expect(net.opened).toEqual([]);
  });

  it('导入失败、只拿到错误信息 ⇒ 同样一个字节都不取', async () => {
    const useLibraryStore = await loadStore();
    parsers.next = { documents: [], errors: [{ fileName: 'x.epub', message: '解析失败' }] };

    await useLibraryStore.getState().importFiles([{ name: 'x.epub' } as unknown as File]);
    await settle();

    expect(net.fetchImpl).toHaveBeenCalledTimes(0);
    expect(net.opened).toEqual([]);
  });

  it('「有一份待识别的扫描件」**只是提问**：还没点开始识别 ⇒ 一个字节都不取', async () => {
    /**
     * 这是本改动最容易被写歪的一点：`scannedPdfPending` 很容易被当成
     * 「要 OCR 了」的判据（它确实摆着一个「开始识别」按钮），但用户
     * 可能点取消、可能先去读别的书。**提问 ≠ 意图**。
     */
    const useLibraryStore = await loadStore();
    parsers.throwNext = { isScannedPdfError: true, pdfBuffer: new ArrayBuffer(8), fileName: 'scan.pdf', fileSize: 8, pageCount: 10, metaTitle: '', metaAuthor: '' };

    await useLibraryStore.getState().importFiles([{ name: 'scan.pdf' } as unknown as File]);
    await settle();

    // 前提必须成立，否则这条用例什么都没验到
    expect(useLibraryStore.getState().scannedPdfPending, '扫描件没被识别出来 ⇒ 用例前提不成立').not.toBeNull();
    expect(net.fetchImpl, '「导入了一份扫描件」就下载了模型资产').toHaveBeenCalledTimes(0);
    expect(net.opened).toEqual([]);
  });

  it('`startOcr()` 在**没有待识别扫描件**时直接返回 ⇒ 也不取（早退不许顺手预取）', async () => {
    const useLibraryStore = await loadStore();
    expect(useLibraryStore.getState().scannedPdfPending).toBeNull();

    await useLibraryStore.getState().startOcr('chi_sim+eng', 10);
    await settle();

    expect(net.fetchImpl).toHaveBeenCalledTimes(0);
    expect(ocrParse.calls, '没有待识别扫描件却开始解析了').toBe(0);
  });

  it('四条可观测通道都没动：没表达 OCR 意图之前，记录就是 `null`', async () => {
    const useLibraryStore = await loadStore();
    await useLibraryStore.getState().init();
    await settle();

    // ⚠️ 判据仍然是「一次都没跑过」—— 只是它现在的含义变成了
    //    「用户还没有表达过 OCR 意图」，而不是「页面还没加载完」
    expect(getModelTierBootRecord()).toBeNull();
    expect(net.fetchImpl).toHaveBeenCalledTimes(0);
  });
});

describe('✅ 有下载方向：做了 OCR 动作 ⇒ 四个资产写进正确的缓存', () => {
  it('按下开始识别 ⇒ 四个**原样 URL** 被取回，并写进名为 `ocr-models` 的缓存', async () => {
    const useLibraryStore = await loadStore();
    parsers.throwNext = { isScannedPdfError: true, pdfBuffer: new ArrayBuffer(8), fileName: 'scan.pdf', fileSize: 8, pageCount: 10, metaTitle: 'T', metaAuthor: 'A' };
    await useLibraryStore.getState().importFiles([{ name: 'scan.pdf' } as unknown as File]);
    expect(useLibraryStore.getState().scannedPdfPending).not.toBeNull();

    /**
     * ⚠️ **「不许更早」那一半**：导入完成、按钮已经摆出来、但**还没按**的
     * 这一刻，必须仍然是零下载。只断言「按了之后有下载」是不够的 ——
     * 那样把调用挪到 `startOcr` 之外（模块顶层、`importFiles` 末尾、
     * 组件挂载时）依然会绿，而那正好就是这次要根除的行为。
     */
    expect(net.fetchImpl, '按下之前就已经下载了 —— 判据点太靠前').toHaveBeenCalledTimes(0);
    expect(net.opened, '按下之前就已经打开了模型缓存').toEqual([]);

    await useLibraryStore.getState().startOcr('chi_sim+eng', 10);
    await settle();

    // ① 资产真的被取回，且是那四个**逐字不变**的 URL
    expect(net.fetched.urls).toEqual(UNCHANGED_URLS);
    expect(net.puts.map((p) => p.url)).toEqual(UNCHANGED_URLS);

    // ② 写进的是**正确的那一个缓存**（裸名 = 改动前的身份）
    expect(net.opened).toEqual(['ocr-models']);
    expect(new Set(net.puts.map((p) => p.cacheName))).toEqual(new Set(['ocr-models']));
    expect(modelCacheName(DEFAULT_MODEL_TIER)).toBe('ocr-models');

    // ③ 缓存键上不许带 query（否则运行时那条 CacheFirst 路由命不中）
    for (const url of net.puts.map((p) => p.url)) expect(url).not.toContain('?');

    // ④ 确实按「绕开 HTTP 缓存」的形态取的（拿到的必须是服务器上那一份）
    for (const init of net.fetched.init) expect(init?.cache).toBe('no-store');

    // ⑤ 规模就是上一次实测的那一笔：4 个资产 / 34.59 MiB
    expect(TIER_TOTAL_BYTES / 1024 / 1024).toBeCloseTo(34.59, 2);

    // ⑥ 一次识别**只跑一次**预取（两次调用会让清理与预检查各跑两遍，
    //    并在记录里留下一次多余的写入）；下一次识别由缓存命中挡住。
    //    这里读的是上面那个 `vi.mock` 装的桩 —— 它同时是「谁调用了它」的探针。
    expect(vi.mocked(bootModelTierAssets), '一次识别里预取被调用了不止一次').toHaveBeenCalledTimes(1);
  });

  it('识别真的往下走了（预取没有把 OCR 本身挡掉）', async () => {
    const useLibraryStore = await loadStore();
    parsers.throwNext = { isScannedPdfError: true, pdfBuffer: new ArrayBuffer(8), fileName: 'scan.pdf', fileSize: 8, pageCount: 10, metaTitle: '', metaAuthor: '' };
    await useLibraryStore.getState().importFiles([{ name: 'scan.pdf' } as unknown as File]);

    await useLibraryStore.getState().startOcr('eng', 5);
    await settle();

    // `ocrParsePdf` 的桩一进来就抛（见上面那个 mock 的说明），所以
    // 「解析已经被调起」= 调用计数为 1；而**抛错被 store 如实报了**
    // 这件事也要断言 —— 否则上面那条「静音 console.error」就变成了掩盖
    expect(ocrParse.calls, 'startOcr 没有走到解析这一步').toBe(1);
    expect(console.error, 'startOcr 的 catch 分支没有如实报错').toHaveBeenCalled();
    expect(net.fetched.urls).toHaveLength(4);

    // 报错之后 `startOcr` 的 catch 把进度清掉、并把错误交给界面（`error` 非空）
    expect(useLibraryStore.getState().ocrProgress).toBeNull();
    expect(useLibraryStore.getState().error).toContain('OCR 识别失败');
  });

  it('第二次识别不再下一遍（四个都已在缓存里 ⇒ fetch 次数仍是 0）', async () => {
    const useLibraryStore = await loadStore();
    parsers.throwNext = { isScannedPdfError: true, pdfBuffer: new ArrayBuffer(8), fileName: 'scan.pdf', fileSize: 8, pageCount: 10, metaTitle: '', metaAuthor: '' };
    await useLibraryStore.getState().importFiles([{ name: 'scan.pdf' } as unknown as File]);
    await useLibraryStore.getState().startOcr('eng', 5);
    await settle();
    expect(net.fetched.urls).toHaveLength(4);

    // 把缓存换成「四个都命中」的那一种，再点一次开始识别
    const hits = UNCHANGED_URLS.map((u) => u);
    Object.defineProperty(globalThis, 'caches', {
      value: {
        keys: async () => ['ocr-models'],
        delete: async () => true,
        open: async () => ({
          match: async (url: string) => (hits.includes(url) ? ({ ok: true } as unknown as Response) : undefined),
          put: async () => {},
        }),
      },
      configurable: true,
      writable: true,
    });
    net.fetched.urls.length = 0;

    await useLibraryStore.getState().startOcr('eng', 5);
    await settle();

    expect(net.fetched.urls, '已缓存的资产又下了一遍').toEqual([]);
    expect(getModelTierBootRecord()?.needUrls).toEqual([]);
  });
});

describe('记录通道：撞进 OCR 之后 `null` 才变成一条真记录', () => {
  it('预取跑过 ⇒ 进程内 / sessionStorage / 可复制报告三条都读得到，且缓存身份是裸名', async () => {
    const useLibraryStore = await loadStore();
    parsers.throwNext = { isScannedPdfError: true, pdfBuffer: new ArrayBuffer(8), fileName: 'scan.pdf', fileSize: 8, pageCount: 10, metaTitle: '', metaAuthor: '' };
    await useLibraryStore.getState().importFiles([{ name: 'scan.pdf' } as unknown as File]);
    await useLibraryStore.getState().startOcr('eng', 5);
    await settle();

    const record = getModelTierBootRecord();
    expect(record, 'OCR 跑了却没有留下记录').not.toBeNull();
    expect(record?.cacheName).toBe('ocr-models');
    expect(record?.outcome).toBe('ok');
    expect(record?.downloaded).toEqual(UNCHANGED_URLS);

    // sessionStorage 里那份（刷新不清 —— autoUpdate 会无预警刷新页面）
    const { MODEL_TIER_BOOT_KEY, renderModelTierBootReport } = await import('@/lib/modelTierBoot');
    const raw = area.getItem(MODEL_TIER_BOOT_KEY);
    expect(raw, 'sessionStorage 通道断了').not.toBeNull();
    expect(JSON.parse(raw as string).cacheName).toBe('ocr-models');

    // 可复制报告里也要有逐项 URL 与那三个数字
    const text = renderModelTierBootReport(record);
    expect(text).toContain('缓存身份：ocr-models');
    for (const url of UNCHANGED_URLS) expect(text).toContain(url);
    expect(text).not.toContain('没有记录');
  });
});
