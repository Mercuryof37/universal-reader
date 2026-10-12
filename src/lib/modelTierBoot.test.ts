import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  DEFAULT_MODEL_TIER,
  MAX_SINGLE_ASSET_BYTES,
  MODEL_ASSETS,
  modelCacheName,
  tierAssets,
  tierTotalBytes,
} from '@/lib/modelCacheTiers';
import {
  MODEL_TIER_BOOT_KEY,
  bootModelTierAssets,
  detectLayoutCapability,
  getModelTierBootRecord,
  modelTierBootBannerTitle,
  modelTierBootNoteworthy,
  renderModelTierBootReport,
  resetModelTierBootRecordForTest,
  resolveQualityTier,
  subscribeModelTierBoot,
  type ModelTierBootReport,
} from '@/lib/modelTierBoot';

/**
 * 「把 `ensureModelTierAssets` 接到运行期」这一件事的可验收形态。
 *
 * ═══════════════════════════════════════════════════════════════
 * 这组用例要防的是什么（以及刻意避开的两种假保护）
 * ═══════════════════════════════════════════════════════════════
 *
 * 上一轮的状态是：`ensureModelTierAssets` 实现齐了、49 条用例全绿，
 * 但**运行期一次都没跑过** —— 源码里有那个名字，和它真的在用户机器上
 * 跑起来、并且跑出正确结果，是两件事。
 *
 * 所以这一轮的三组断言都必须**跑出来**：
 *
 *   1. **零副作用**：默认档位下缓存名仍是裸 `ocr-models`、四个 URL 逐字不变
 *      —— 断言的是 `bootModelTierAssets()` **真的写进了哪个缓存、请求了哪些 URL**
 *      （桩 CacheStorage + 桩 fetch），不是 `modelCacheName()` 的返回值。
 *   2. **不许把应用弄挂**：预检查拦住 ⇒ 一个字节都不取；配额查不到 ⇒ 不拦；
 *      编排内部抛异常 ⇒ boot 仍然 resolve；清理失败 ⇒ 只告警。
 *   3. **必须能观测**：「跑了没有、结果是什么」要能在**没有控制台**的前提下读出来。
 *
 * ⚠️ 两种刻意避开的假保护（本项目已经吃过 5 次以上）：
 *
 *   · **`toMatch(/名字/)` 匹配的是 import 而不是调用** ——
 *     所以「`pwa.ts` 到底调没调」这一条走的是**把回调体取出来真跑一遍**
 *     （`new Function` + 注入两个桩），删掉那一行调用就会红；
 *     而「那个名字是不是真的存在」另有一条独立的断言（名字 ↔ 导出的对应关系）。
 *   · **读到同进程里别的用例改过的当前值** —— 所有依赖都从参数注入
 *     （桩 CacheStorage / 桩 fetch / 桩时钟 / 桩在线判定），
 *     唯一用到的全局是 `sessionStorage`，而它是本文件 `beforeEach` 里
 *     **自己装**的内存实现（理由见 `sessionDiagnostics.test.ts`：本地 Node 有、
 *     CI 的 Node 没有，不自己装就会「本地绿、CI 红」）。
 */

// ═══════════════════════════════════════════════════════════════
// 依赖自带：内存版 sessionStorage（与 sessionDiagnostics.test.ts 同一手法）
// ═══════════════════════════════════════════════════════════════

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

beforeEach(() => {
  area = new MemoryStorage();
  Object.defineProperty(globalThis, 'sessionStorage', {
    value: area,
    configurable: true,
    writable: true,
  });
  // 每个用例都从「没跑过」开始 —— 否则会读到上一个用例留下的记录
  resetModelTierBootRecordForTest();
});

// ═══════════════════════════════════════════════════════════════
// 桩
// ═══════════════════════════════════════════════════════════════

/** 桩 CacheStorage：记下打开了哪个缓存、写进了哪些 URL、删了哪些缓存 */
function stubCaches(existing: string[] = []) {
  const puts: { url: string; cacheName: string }[] = [];
  const opened: string[] = [];
  const deleted: string[] = [];

  const storage = {
    keys: async () => [...existing],
    delete: async (name: string) => {
      deleted.push(name);
      return true;
    },
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

  return { storage, puts, opened, deleted };
}

function okResponse(): Response {
  return { ok: true, status: 200, clone: () => ({ ok: true, status: 200 }) } as unknown as Response;
}

/** 桩 fetch：只记录被请求的 URL，一律返回 200 */
function stubFetch() {
  const urls: string[] = [];
  const impl = vi.fn(async (input: unknown) => {
    urls.push(String(input));
    return okResponse();
  });
  return { impl: impl as unknown as typeof fetch, urls, spy: impl };
}

/** 配额充足（500 MiB 可用）—— 让判断只能落在单文件上限那一侧 */
function healthyQuota() {
  return { usage: 0, quota: 500 * 1024 * 1024 };
}

/** 改动前那四个 URL 的**字面量**（写死在这里，才是「改动前」的锚点） */
const UNCHANGED_URLS = [
  '/ocr-models/detection/ort/PP-OCRv6_small_det.ort',
  '/ocr-models/recognition/ort/PP-OCRv6_small_rec.ort',
  '/ocr-models/recognition/ppocrv6_dict.txt',
  '/ocr-models/layout/PP-DocLayout-S.onnx',
];

// ═══════════════════════════════════════════════════════════════
// 1 · 档位由能力推出来（不是用户选的，也不在调用点写死）
// ═══════════════════════════════════════════════════════════════

describe('档位由「版面模型能不能用」推出来', () => {
  it('版面模型可用 ⇒ 默认档位（= 改动前那一档）', () => {
    expect(resolveQualityTier({ layoutModel: true })).toBe(DEFAULT_MODEL_TIER);
  });

  it('版面模型不可用 ⇒ 换到**另一档**，且那一档真的不请求版面模型', () => {
    const tier = resolveQualityTier({ layoutModel: false });

    // 「换了一档」必须真的成立：档位不同、缓存身份不同
    expect(tier).not.toBe(DEFAULT_MODEL_TIER);
    expect(modelCacheName(tier)).not.toBe(modelCacheName(DEFAULT_MODEL_TIER));
    // 少的东西正好是版面模型那一个（4.69 MiB），不是少一堆
    expect(tierAssets(tier)).not.toContain('layout');
    expect(tierTotalBytes(DEFAULT_MODEL_TIER) - tierTotalBytes(tier)).toBe(MODEL_ASSETS.layout.bytes);
  });

  it('不传 capability 时用的那份能力检测 ⇒ 默认档位（没人关掉版面分析就是改动前的行为）', () => {
    // 这是「接线之后默认行为不变」的前提条件本身：
    // 只要 `detectLayoutCapability()` 说可用，跑的就是 standard 那一套资产
    expect(resolveQualityTier(detectLayoutCapability())).toBe(DEFAULT_MODEL_TIER);
  });
});

// ═══════════════════════════════════════════════════════════════
// 2 · ⚠️ 不变量：默认档位下缓存身份与改动前逐字相同
// ═══════════════════════════════════════════════════════════════

describe('⚠️ 零副作用：默认档位下写进的缓存名与请求的 URL 与改动前逐字相同', () => {
  it('按 pwa.ts 里那次调用的形态跑（只多三个测试桩）⇒ 裸名 ocr-models + 四个原样 URL', async () => {
    const { storage, puts, opened } = stubCaches();
    const { impl } = stubFetch();

    /**
     * ⚠️ 这里**不传** `capability`，也不传 `tier` —— 与
     * `src/lib/pwa.ts` 里那句 `void bootModelTierAssets();` 的唯一差别
     * 就是这三个桩（缓存 / 网络 / 配额）。也就是说这条用例跑的
     * 正是用户机器上会跑的那条路径。
     */
    const report = await bootModelTierAssets({
      storage,
      fetchImpl: impl,
      readEstimate: async () => healthyQuota(),
    });

    expect(report.tier).toBe(DEFAULT_MODEL_TIER);
    expect(report.tierSource).toBe('capability');

    // ① 缓存身份：仍是裸名，不是 `ocr-models-standard-v1-…`
    expect(report.cacheName).toBe('ocr-models');
    expect(opened).toEqual(['ocr-models']);
    expect(new Set(puts.map((p) => p.cacheName))).toEqual(new Set(['ocr-models']));

    // ② 四个资产的 URL 逐字不变（字面量锚点，不跟着实现浮动）
    expect(puts.map((p) => p.url)).toEqual(UNCHANGED_URLS);
    expect(report.downloaded).toEqual(UNCHANGED_URLS);
    expect(report.outcome).toBe('ok');
  });

  it('换档位（版面模型不可用）⇒ 缓存身份跟着换，且不请求版面模型那 4.69 MiB', async () => {
    const { storage, puts, opened } = stubCaches();
    const { impl } = stubFetch();

    const report = await bootModelTierAssets({
      capability: { layoutModel: false },
      storage,
      fetchImpl: impl,
      readEstimate: async () => healthyQuota(),
    });

    expect(report.tier).not.toBe(DEFAULT_MODEL_TIER);
    expect(opened).toEqual([modelCacheName(report.tier)]);
    expect(opened[0]).not.toBe('ocr-models');
    // OCR 三件套照旧，只是不再要版面模型
    expect(puts.map((p) => p.url)).toEqual(UNCHANGED_URLS.filter((u) => !u.endsWith('PP-DocLayout-S.onnx')));
    expect(puts).toHaveLength(3);
  });

  it('已在缓存里的资产不重复下载（第二次启动不会把 34.6 MiB 再下一遍）', async () => {
    const { storage } = stubCaches();
    const { impl, spy } = stubFetch();

    // 第一次：四个都缺
    const first = await bootModelTierAssets({
      storage,
      fetchImpl: impl,
      readEstimate: async () => healthyQuota(),
    });
    expect(first.downloaded).toHaveLength(4);

    // 第二次：四个都已在缓存里（match 命中）
    const cachedStorage = {
      keys: async () => [] as string[],
      delete: async () => true,
      open: async () => ({
        match: async () => okResponse() as Response | undefined,
        put: async () => {},
      }),
    };
    spy.mockClear();
    const second = await bootModelTierAssets({
      storage: cachedStorage,
      fetchImpl: impl,
      readEstimate: async () => healthyQuota(),
    });

    expect(spy).not.toHaveBeenCalled();
    expect(second.downloaded).toEqual([]);
    expect(second.needUrls).toEqual([]);
    expect(second.outcome).toBe('ok');
  });
});

// ═══════════════════════════════════════════════════════════════
// 3 · 不许把应用弄挂
// ═══════════════════════════════════════════════════════════════

describe('启动路径的安全边界', () => {
  it('**预检查拦住 ⇒ 一个字节都不取**（fetch 一次都没被调用，缓存里什么都没写）', async () => {
    const { storage, puts } = stubCaches();
    const { impl, spy } = stubFetch();

    const report = await bootModelTierAssets({
      storage,
      fetchImpl: impl,
      readEstimate: async () => ({ usage: 10_000, quota: 11_000 }),
    });

    expect(report.outcome).toBe('blocked');
    expect(spy).not.toHaveBeenCalled();
    expect(puts).toEqual([]);
    expect(report.downloaded).toEqual([]);
    expect(report.preflight?.reason).toBe('insufficient-storage');
    expect(report.preflight?.numbers.estimatedQuota).toBe(11_000);
  });

  it('配额**查不到**时不拦（查不了 ≠ 不够；否则该 API 缺失的浏览器永远下不了模型）', async () => {
    const { storage } = stubCaches();
    const { impl } = stubFetch();

    /**
     * 刻意**不传** `readEstimate`：走 `ensureModelTierAssets` 的默认实现，
     * 也就是真的去读 `navigator.storage`。node 里没有它 ⇒ 两个数字都是 null。
     *
     * ⚠️ 这条用例依赖「这个进程里没有 `navigator.storage`」，
     * 所以把它显式断言出来 —— 依赖是环境事实时要说清楚，
     * 否则将来环境一变，用例的含义会悄悄变成另一件事。
     */
    expect((globalThis as { navigator?: { storage?: unknown } }).navigator?.storage).toBeUndefined();

    const report = await bootModelTierAssets({ storage, fetchImpl: impl });

    expect(report.preflight?.reason).toBe('no-storage-api');
    expect(report.outcome).toBe('ok'); // 没判成 ok…
    expect(report.downloaded).toHaveLength(4); // …但一个都没拦
  });

  it('配额读取抛错时同样不拦', async () => {
    const { storage } = stubCaches();
    const { impl } = stubFetch();

    const report = await bootModelTierAssets({
      storage,
      fetchImpl: impl,
      readEstimate: async () => {
        throw new Error('SecurityError: 存储被策略禁用');
      },
    });

    expect(report.preflight?.reason).toBe('no-storage-api');
    expect(report.downloaded).toHaveLength(4);
  });

  it('**编排内部抛异常 ⇒ boot 仍然 resolve**（启动路径不许被它带走）', async () => {
    const { impl } = stubFetch();
    const storage = {
      keys: async () => [] as string[],
      delete: async () => true,
      // `ensureModelTierAssets` 内部的 `storage.open()` 没有包 try/catch ——
      // 配额耗尽 / SecurityError 时真的会从这里抛出来
      open: async () => {
        throw new Error('QuotaExceededError: 写盘失败');
      },
    };

    const report = await bootModelTierAssets({
      storage,
      fetchImpl: impl,
      readEstimate: async () => healthyQuota(),
    });

    expect(report.outcome).toBe('error');
    expect(report.error).toContain('QuotaExceededError');
    expect(report.downloaded).toEqual([]);
    // 本来该写进哪个缓存，报告里仍然要有
    expect(report.cacheName).toBe('ocr-models');
  });

  it('清理失败只告警：删不掉旧档位也照样往下走', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const storage = {
        keys: async () => ['ocr-models-fast-v1-deadbeef'],
        delete: async () => {
          throw new Error('InvalidStateError');
        },
        open: async () => ({ match: async () => undefined, put: async () => {} }),
      };
      const { impl } = stubFetch();

      const report = await bootModelTierAssets({
        storage,
        fetchImpl: impl,
        readEstimate: async () => healthyQuota(),
      });

      expect(report.outcome).toBe('ok');
      expect(report.downloaded).toHaveLength(4);
      // 判据是**那一条**告警（而不是「有谁 warn 过」）：清理失败必须留痕
      expect(warn.mock.calls.flat().join(' ')).toContain('旧档位缓存清理失败');
    } finally {
      warn.mockRestore();
    }
  });

  it('没有 Cache Storage ⇒ 安静跳过（不抛、不 fetch）', async () => {
    // 同样是显式声明环境依赖（pwaOffline.test.ts 也会碰 globalThis.caches，
    // 但那是另一个文件 —— vitest 按文件隔离，这里读到的一定是本文件的初始值）
    expect((globalThis as { caches?: unknown }).caches).toBeUndefined();
    const { impl, spy } = stubFetch();

    const report = await bootModelTierAssets({ fetchImpl: impl });

    expect(report.outcome).toBe('skipped');
    expect(spy).not.toHaveBeenCalled();
    expect(report.cacheName).toBe('ocr-models');
  });

  it('浏览器说离线 ⇒ 干脆不跑（否则四个资产全失败，界面会报一条假警）', async () => {
    const { storage, puts } = stubCaches();
    const { impl, spy } = stubFetch();

    const report = await bootModelTierAssets({
      isOnline: () => false,
      storage,
      fetchImpl: impl,
      readEstimate: async () => healthyQuota(),
    });

    expect(report.outcome).toBe('skipped');
    expect(spy).not.toHaveBeenCalled();
    expect(puts).toEqual([]);
    expect(report.detail).toContain('离线');
    // 而且**不算值得报警的事**：把「你现在没网」变成模型错误是误报
    expect(modelTierBootNoteworthy(report)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// 4 · 可观测：「它跑了没有、结果是什么」在**没有控制台**时也读得到
// ═══════════════════════════════════════════════════════════════

describe('可观测：跑了没有、结果是什么', () => {
  it('一次都没跑过 ⇒ 报告里明说「没有记录」，而不是空串或 undefined', () => {
    resetModelTierBootRecordForTest();
    expect(getModelTierBootRecord()).toBeNull();
    expect(renderModelTierBootReport()).toContain('没有记录');
  });

  it('跑过之后：进程内读得到、订阅者收得到、**刷新之后（存储里）还在**', async () => {
    const seen: ModelTierBootReport[] = [];
    const off = subscribeModelTierBoot((r) => seen.push(r));
    const { storage } = stubCaches();
    const { impl } = stubFetch();

    let report: ModelTierBootReport;
    try {
      report = await bootModelTierAssets({
        storage,
        fetchImpl: impl,
        readEstimate: async () => ({ usage: 10_000, quota: 11_000 }),
      });
    } finally {
      off();
    }

    // ① 进程内（界面 `useSyncExternalStore` 走的就是这条）
    expect(getModelTierBootRecord()).toBe(report);
    expect(report.outcome).toBe('blocked');

    // ② 订阅者收到了这一次的结论
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(report);

    // ③ 落盘了：把进程内那份丢掉，**只从存储里读**，结论仍然完整
    //    （这正是「刷新之后还看得出来」的那条通道；`autoUpdate` 会无预警刷新）
    expect(area.getItem(MODEL_TIER_BOOT_KEY)).not.toBeNull();
    resetModelTierBootRecordForTest();
    const restored = getModelTierBootRecord();
    expect(restored?.outcome).toBe('blocked');
    expect(restored?.preflight?.numbers.estimatedQuota).toBe(11_000);
    expect(restored?.cacheName).toBe('ocr-models');

    // ④ 快照引用稳定（`useSyncExternalStore` 要求：不能每次返回新对象）
    expect(getModelTierBootRecord()).toBe(restored);

    // ⑤ 退订之后不再收到（界面卸载时必须真的退得掉）
    await bootModelTierAssets({
      storage,
      fetchImpl: impl,
      readEstimate: async () => healthyQuota(),
    });
    expect(seen).toHaveLength(1);
  });

  it('报告里带着判断用的**原始数字**与逐项 URL，而不是一句「失败了」', async () => {
    const { storage } = stubCaches();
    const { impl } = stubFetch();

    const report = await bootModelTierAssets({
      storage,
      fetchImpl: impl,
      readEstimate: async () => ({ usage: 4096, quota: 8192 }),
    });

    const text = renderModelTierBootReport(report);

    expect(text).toContain('档位：标准（standard');
    expect(text).toContain('缓存身份：ocr-models');
    expect(text).toContain('reason=insufficient-storage');
    expect(text).toContain(`单文件上限 ${MAX_SINGLE_ASSET_BYTES} 字节`);
    expect(text).toContain('已用 4096 字节 / 配额 8192 字节');
    // 逐项 URL 都要在（否则「卡在哪个资产上」无从判断）
    for (const url of UNCHANGED_URLS) expect(text).toContain(url);
    // 「没跑」与「跑了但被拦住」必须能分开
    expect(text).not.toContain('没有记录');
  });

  it('订阅者抛错不影响启动路径，也不挡住后面的订阅者', async () => {
    const seen: string[] = [];
    const off1 = subscribeModelTierBoot(() => {
      throw new Error('订阅者自己炸了');
    });
    const off2 = subscribeModelTierBoot((r) => seen.push(r.outcome));
    const { storage } = stubCaches();
    const { impl } = stubFetch();

    let report: ModelTierBootReport | null = null;
    try {
      report = await bootModelTierAssets({
        storage,
        fetchImpl: impl,
        readEstimate: async () => healthyQuota(),
      });
    } finally {
      off1();
      off2();
    }

    expect(report.outcome).toBe('ok');
    expect(seen).toEqual(['ok']);
  });

  it('sessionStorage 抛异常（隐私模式）时 boot 仍然 resolve，进程内那份照样有', async () => {
    Object.defineProperty(globalThis, 'sessionStorage', {
      get() {
        throw new Error('SecurityError: 存储在隐私模式下被禁用');
      },
      configurable: true,
    });
    const { storage } = stubCaches();
    const { impl } = stubFetch();

    const report = await bootModelTierAssets({
      storage,
      fetchImpl: impl,
      readEstimate: async () => healthyQuota(),
    });

    expect(report.outcome).toBe('ok');
    expect(getModelTierBootRecord()).toBe(report);
  });

  it('**两个方向**：正常路径不打扰用户，出问题才有东西可显示', async () => {
    const { storage } = stubCaches();
    const { impl } = stubFetch();

    // 方向一：一切正常 + 没有旧缓存要清 ⇒ 不显示（否则横幅会被学会无视）
    const quiet = await bootModelTierAssets({
      storage,
      fetchImpl: impl,
      readEstimate: async () => healthyQuota(),
    });
    expect(quiet.cleaned).toEqual([]);
    expect(quiet.failed).toEqual([]);
    expect(modelTierBootNoteworthy(quiet)).toBe(false);

    // 方向二：预检查拦住 ⇒ 必须显示，而且标题要说清是「拦住」而不是「失败」
    const blocked = await bootModelTierAssets({
      storage,
      fetchImpl: impl,
      readEstimate: async () => ({ usage: 10_000, quota: 11_000 }),
    });
    expect(modelTierBootNoteworthy(blocked)).toBe(true);
    expect(modelTierBootBannerTitle(blocked)).toContain('预检查');

    // 方向三：清掉过旧档位缓存 ⇒ 也要说（它解释了「为什么要重下」）
    const { storage: withStale } = stubCaches(['ocr-models-fast-v1-deadbeef']);
    const cleaned = await bootModelTierAssets({
      storage: withStale,
      fetchImpl: impl,
      readEstimate: async () => healthyQuota(),
    });
    expect(cleaned.cleaned).toEqual(['ocr-models-fast-v1-deadbeef']);
    expect(modelTierBootNoteworthy(cleaned)).toBe(true);

    // 方向四：单个资产下载失败 ⇒ 显示（fetch 半路 404 是最常见的一种）
    const flaky = vi.fn(async (input: unknown) =>
      String(input).includes('PP-OCRv6_small_rec') ? ({ ok: false, status: 404 } as unknown as Response) : okResponse(),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const partial = await bootModelTierAssets({
        storage,
        fetchImpl: flaky as unknown as typeof fetch,
        readEstimate: async () => healthyQuota(),
      });
      expect(partial.outcome).toBe('ok');
      expect(partial.failed).toHaveLength(1);
      expect(modelTierBootNoteworthy(partial)).toBe(true);
      expect(modelTierBootBannerTitle(partial)).toContain('1 个');
    } finally {
      warn.mockRestore();
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 5 · 接线本身：`pwa.ts` 的 SW 注册回调里真的调用了它
// ═══════════════════════════════════════════════════════════════

const PWA_SRC = readFileSync(join(process.cwd(), 'src/lib/pwa.ts'), 'utf8');

/**
 * 取出 `onRegisteredSW` 的**回调体源码**，好把它单独跑一遍。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么要这么绕，而不是 `expect(PWA_SRC).toMatch(/bootModelTierAssets\(/)`
 * ═══════════════════════════════════════════════════════════════
 *
 * 因为那种断言**匹配到 import 也会绿**：源码里有 `bootModelTierAssets` 这串字，
 * 和这个回调真的会去调它，是两件事（本项目记过 5 次以上的「假保护」）。
 * `pwa.ts` 顶层 import 了 `virtual:pwa-register/react`，vitest 解析不了，
 * 没法直接 import 它 —— 那么退而求其次的正确形态是：
 * **把回调体抠出来，注入两个桩，真的执行一次**。删掉那一行调用，
 * 桩就不会被调用，用例当场变红。
 *
 * ⚠️ 去注释**只去块注释**。刻意不用本仓库常见的那套「按行去 `//` 注释」：
 * 实测过它会把注释后面一整行代码一起吃掉（见 `modelCacheTiers.test.ts`
 * 里对这件事的记录），而这里少吃一行就变成「桩没被调用」这种**假红**。
 */
function onRegisteredSwBody(src: string): string {
  const at = src.indexOf('onRegisteredSW');
  expect(at, 'pwa.ts 里找不到 onRegisteredSW').toBeGreaterThan(-1);

  const open = src.indexOf('{', at);
  expect(open, 'onRegisteredSW 后面没有函数体').toBeGreaterThan(-1);

  const from = src.slice(open).replace(/\/\*[\s\S]*?\*\//g, '');
  let depth = 0;
  for (let i = 0; i < from.length; i++) {
    if (from[i] === '{') depth++;
    else if (from[i] === '}') {
      depth--;
      if (depth === 0) return from.slice(1, i);
    }
  }
  throw new Error('onRegisteredSW 的函数体没有收尾 —— 这段抠源码的逻辑要跟着更新');
}

/** 用两个桩把回调体跑起来 */
function runRegisteredSwHandler() {
  const body = onRegisteredSwBody(PWA_SRC);
  const seedNavigationFallback = vi.fn(async () => {});
  const bootModelTierAssetsMock = vi.fn(async (_options?: unknown) => {});

  // eslint-disable-next-line no-new-func -- 只有把回调体取出来执行，才能验到「真的调用了」
  const handler = new Function('seedNavigationFallback', 'bootModelTierAssets', body) as (
    seed: unknown,
    boot: unknown,
  ) => unknown;

  return { handler, seedNavigationFallback, bootModelTierAssetsMock, body };
}

/** 取某个模块说明符上 import 进来的具名绑定 */
function importedBindings(src: string, from: string): string[] {
  const re = /import\s*\{([\s\S]*?)\}\s*from\s*'([^']+)'/g;
  for (const match of src.matchAll(re)) {
    if (match[2] === from) {
      return match[1]
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean);
    }
  }
  return [];
}

describe('接线：SW 注册成功后会去跑「模型资产就位」', () => {
  it('回调体里**真的调用**了两个启动钩子（跑出来的，不是读出来的）', () => {
    const { handler, seedNavigationFallback, bootModelTierAssetsMock } = runRegisteredSwHandler();

    const returned = handler(seedNavigationFallback, bootModelTierAssetsMock);

    expect(seedNavigationFallback, '导航兜底那一路被删了？').toHaveBeenCalledTimes(1);
    expect(bootModelTierAssetsMock, '模型资产就位没有被调用 —— 接线断了').toHaveBeenCalledTimes(1);
    // 不 await：注册回调不许被一次 34.6 MiB 的下载挡住
    expect(returned).toBeUndefined();
  });

  it('调用点**不许写死档位**（写死会让「缓存身份 = 当前档位」变成假的）', () => {
    const { handler, seedNavigationFallback, bootModelTierAssetsMock } = runRegisteredSwHandler();
    handler(seedNavigationFallback, bootModelTierAssetsMock);

    const arg = bootModelTierAssetsMock.mock.calls[0]?.[0] as { tier?: unknown } | undefined;
    expect(arg?.tier, 'pwa.ts 里写死了档位 —— 档位必须由能力推出来').toBeUndefined();
  });

  it('引入的名字确实指向 `modelTierBoot` 的导出（不是拼错的名字 / 本地同名函数）', () => {
    // ① pwa.ts 从哪个模块、引入了哪些名字
    expect(importedBindings(PWA_SRC, '@/lib/modelTierBoot')).toContain('bootModelTierAssets');
    // ② 那个名字在模块里**真的存在**（本文件顶部那个 import 就是它）
    expect(typeof bootModelTierAssets).toBe('function');
    // ③ pwa.ts 里没有自己定义一份同名的东西（否则调用会悄悄走到本地那份）
    expect(PWA_SRC).not.toMatch(/function\s+bootModelTierAssets\b/);
    expect(PWA_SRC).not.toMatch(/(const|let|var)\s+bootModelTierAssets\s*=/);
  });

  it('端到端：按 pwa.ts 的**真实调用形态**跑真实实现 ⇒ 裸名 ocr-models + 四个原样 URL', async () => {
    /**
     * 上面那条把 `bootModelTierAssets` 换成了桩（只能证明「调用了」）。
     * 这一条换成**真函数**：回调体 → `bootModelTierAssets()`（无参数，
     * 与 pwa.ts 里逐字相同的调用）→ `ensureModelTierAssets` → 真的打开缓存、
     * 真的去 fetch。于是「接线之后到底写进了哪个缓存、取了哪些 URL」
     * 是端到端跑出来的，而不是分段推断的。
     *
     * ⚠️ 这里确实碰了 `globalThis.caches` / `globalThis.fetch`
     * （`ensureModelTierAssets` 的默认值就取它们），所以**用完立刻还原**，
     * 并且不去读任何别人可能改过的值 —— 读到的只有本用例自己装的桩。
     */
    const body = onRegisteredSwBody(PWA_SRC);
    // eslint-disable-next-line no-new-func -- 同上：只有执行回调体才验得到端到端
    const handler = new Function('seedNavigationFallback', 'bootModelTierAssets', body) as (
      seed: unknown,
      boot: unknown,
    ) => unknown;

    // 这个进程不能处于「浏览器说离线」那一档，否则真实实现会直接跳过
    expect((globalThis as { navigator?: { onLine?: boolean } }).navigator?.onLine).not.toBe(false);

    const opened: string[] = [];
    const puts: string[] = [];
    const fetches: string[] = [];
    const cachesStub = {
      keys: async () => [] as string[],
      delete: async () => true,
      open: async (name: string) => {
        opened.push(name);
        return {
          match: async () => undefined as Response | undefined,
          put: async (url: string) => {
            puts.push(url);
          },
        };
      },
    };

    const originalCaches = Object.getOwnPropertyDescriptor(globalThis, 'caches');
    const originalFetch = globalThis.fetch;
    Object.defineProperty(globalThis, 'caches', {
      value: cachesStub,
      configurable: true,
      writable: true,
    });
    globalThis.fetch = (async (input: unknown) => {
      fetches.push(String(input));
      return okResponse();
    }) as unknown as typeof fetch;

    try {
      handler(vi.fn(async () => {}), bootModelTierAssets); // ← 第二个是真函数
      // 回调体是 fire-and-forget（不 await），所以等它把四个都写完
      await vi.waitFor(() => expect(puts, '接线之后一个字节都没写进缓存').toHaveLength(4), {
        timeout: 3000,
      });

      expect(opened).toEqual(['ocr-models']);
      expect(fetches).toEqual(UNCHANGED_URLS);
      expect(getModelTierBootRecord()?.outcome).toBe('ok');
      expect(getModelTierBootRecord()?.cacheName).toBe('ocr-models');
    } finally {
      if (originalCaches) Object.defineProperty(globalThis, 'caches', originalCaches);
      else delete (globalThis as { caches?: unknown }).caches;
      globalThis.fetch = originalFetch;
    }
  });
});
