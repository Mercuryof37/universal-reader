import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

import {
  DEFAULT_MODEL_TIER,
  MAX_SINGLE_ASSET_BYTES,
  MAX_SINGLE_ASSET_BYTES_ENV,
  MODEL_ASSETS,
  MODEL_CACHE_PREFIX,
  MODEL_TIERS,
  MODEL_TIER_SPECS,
  SELF_HOSTED_MODEL_ROOT,
  assetIdentityLine,
  cleanupStaleModelCaches,
  ensureModelTierAssets,
  fingerprintAssetSet,
  isModelCacheName,
  modelAssetSetKey,
  modelAssetUrl,
  modelCacheName,
  modelTierUrls,
  preflightBlocksDownload,
  preflightModelTier,
  sameAssetSet,
  tierAssetPaths,
  tierAssets,
  tierTotalBytes,
} from '@/lib/modelCacheTiers';
import { LAYOUT_MODEL_BYTES, LAYOUT_MODEL_FILE } from '@/lib/layoutAnalysis';
import { SELF_HOSTED_MODEL_BASE } from '@/lib/ocrModelSource';

/**
 * 「缓存 × 档位」的三条要求各有一组用例，且**每组都要能变红**：
 *
 *   1. 缓存身份能区分档位；
 *   2. 容量预检查发生在**第一个字节被取之前**；
 *   3. 换档位时旧缓存被清掉，而**别的缓存一个都不许动**。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么这里刻意不用「读源码 + toMatch」来当保护
 * ═══════════════════════════════════════════════════════════════
 *
 * 本项目已经出现过 5 次以上「假保护」用例。两种典型形态本文件都避开：
 *
 * · **`toMatch(/名字/)` 匹配的是 import 而不是调用** ——
 *   源码里有 `ensureModelTierAssets(` 这串字，和它**真的在下载前跑了预检查**
 *   是两件事。所以下面所有关于顺序的断言都是**跑出来的**：
 *   注入桩 fetch / 桩 CacheStorage，看调用顺序与返回的 `downloaded`。
 * · **读到同进程里别的用例改过的值** —— 本文件不读写任何模块级可变状态，
 *   所有桩都通过参数注入，不碰 `globalThis`。
 *
 * 唯一一处读文件是最后那组「构建期脚本契约」：它必须在**构建期**验证，
 * 因为那时没有浏览器、没有 CacheStorage。那里的做法是**逐项解析脚本里的
 * 文件清单并比对字节数**，而不是匹配某个名字出现过 —— 改了数字就会红。
 */

// ═══════════════════════════════════════════════════════════════
// 1 · 档位与资产集合
// ═══════════════════════════════════════════════════════════════
describe('档位 → 资产集合', () => {
  it('默认档位是 standard（= 改动前那一套资产，不变量）', () => {
    expect(DEFAULT_MODEL_TIER).toBe('standard');
  });

  it('默认档位的资产集合与改动前逐项相同：OCR 三件套 + 版面模型', () => {
    expect([...tierAssets(DEFAULT_MODEL_TIER)]).toEqual([
      'detection',
      'recognition',
      'charactersDictionary',
      'layout',
    ]);
  });

  it('默认档位的路径与改动前逐项相同（URL 没变，身份变在缓存名上）', () => {
    expect(tierAssetPaths(DEFAULT_MODEL_TIER)).toEqual([
      'detection/ort/PP-OCRv6_small_det.ort',
      'recognition/ort/PP-OCRv6_small_rec.ort',
      'recognition/ppocrv6_dict.txt',
      'layout/PP-DocLayout-S.onnx',
    ]);
  });

  it('fast 档不含版面模型 —— 这一档必须真的少一个资产，否则「换档位」是空话', () => {
    expect(tierAssets('fast')).not.toContain('layout');
    expect(tierAssets('fast')).toContain('recognition');
  });

  it('每个档位的资产都是本清单里真实存在的 id（没有拼错的档位）', () => {
    for (const tier of MODEL_TIERS) {
      for (const id of MODEL_TIER_SPECS[tier].assets) {
        expect(MODEL_ASSETS[id], `${tier} 引用了不存在的资产 ${id}`).toBeDefined();
        expect(MODEL_ASSETS[id].bytes).toBeGreaterThan(0);
      }
    }
  });

  it('同源模型根路径与 ocrModelSource 的 SELF_HOSTED_MODEL_BASE 一致', () => {
    // 两者不一致的表现是「缓存层往 A 写、运行时从 B 读」—— 离线时静默失效
    expect(SELF_HOSTED_MODEL_ROOT).toBe(SELF_HOSTED_MODEL_BASE);
  });

  it('⚠️ **不变量**：默认档位下四个资产的 URL 与改动前逐字相同', () => {
    /**
     * 这四个 URL 是改动前的字面量（写死在这里，就是为了让它成为
     * 「改动前」的锚点，而不是跟着实现一起浮动）。
     * 一旦有人在 URL 里加档位前缀，运行时那条 CacheFirst 路由与
     * `src/lib/ocrModelSource.ts` / `src/lib/layoutAnalysis.ts` 的取用路径
     * 就会分家 —— 而那两个文件当前不许改，分家的表现是「离线时模型取不到」。
     */
    expect(modelTierUrls('standard', SELF_HOSTED_MODEL_ROOT)).toEqual([
      '/ocr-models/detection/ort/PP-OCRv6_small_det.ort',
      '/ocr-models/recognition/ort/PP-OCRv6_small_rec.ort',
      '/ocr-models/recognition/ppocrv6_dict.txt',
      '/ocr-models/layout/PP-DocLayout-S.onnx',
    ]);
    expect(SELF_HOSTED_MODEL_ROOT).toBe('/ocr-models');
  });
});

// ═══════════════════════════════════════════════════════════════
// 2 · 缓存身份 = 档位名 + 资产集合指纹
// ═══════════════════════════════════════════════════════════════
describe('缓存身份：换了档位就不许命中旧缓存', () => {
  it('默认档位的缓存名保持改动前的裸名 ocr-models（已有缓存不作废）', () => {
    expect(modelCacheName(DEFAULT_MODEL_TIER)).toBe(MODEL_CACHE_PREFIX);
  });

  it('**不同档位的缓存名两两不同** —— 这是「不能换了档位却命中旧缓存」的直接判据', () => {
    const names = MODEL_TIERS.map((tier) => modelCacheName(tier));
    expect(new Set(names).size).toBe(names.length);
  });

  it('非默认档位的缓存名里带着档位名（换档位 ⇒ 换缓存名，不是换别的东西）', () => {
    for (const tier of MODEL_TIERS) {
      if (tier === DEFAULT_MODEL_TIER) continue;
      expect(modelCacheName(tier)).toContain(tier);
    }
  });

  it('指纹对**内容身份的每一项**都敏感：字节数 / 路径 / sha256 任一变化都换指纹', () => {
    /**
     * 这一条是「换了档位却命中旧缓存」的另一半：
     * 同一档位内**路径没变但字节变了**（换模型版本、换量化格式）时，
     * 缓存身份也必须换 —— 否则 CacheFirst 会继续把旧字节递出去。
     *
     * 直接喂输入，而不是只对着一个固定十六进制串比对：
     * 后者证明不了它真的读了 bytes / sha256。
     */
    const base = assetIdentityLine('recognition');
    expect(fingerprintAssetSet(base)).toBe(fingerprintAssetSet(base));
    expect(fingerprintAssetSet(base)).toMatch(/^v1-[0-9a-f]{8}$/);

    const bytesChanged = assetIdentityLine('recognition', {
      ...MODEL_ASSETS.recognition,
      bytes: MODEL_ASSETS.recognition.bytes + 1,
    });
    const pathChanged = assetIdentityLine('recognition', {
      ...MODEL_ASSETS.recognition,
      path: 'recognition/ort/other_rec.ort',
    });
    const shaChanged = assetIdentityLine('recognition', {
      ...MODEL_ASSETS.recognition,
      sha256: 'deadbeef',
    });

    for (const [what, line] of [
      ['字节数', bytesChanged],
      ['路径', pathChanged],
      ['sha256', shaChanged],
    ] as const) {
      expect(line, `${what} 没进指纹输入`).not.toBe(base);
      expect(fingerprintAssetSet(line), `${what} 变了但指纹没变`).not.toBe(fingerprintAssetSet(base));
    }
  });

  it('sha256 缺失的资产用 `-` 占位，不会与「sha256 为空串」撞成同一个指纹', () => {
    const noHash = assetIdentityLine('recognition');
    const emptyHash = assetIdentityLine('recognition', {
      ...MODEL_ASSETS.recognition,
      sha256: '',
    });
    expect(noHash).not.toBe(emptyHash);
  });

  it('fast 与 standard 的指纹不同（资产集合不同 ⇒ 身份不同）', () => {
    expect(modelAssetSetKey('fast')).not.toBe(modelAssetSetKey('standard'));
  });

  it('isModelCacheName 只认模型缓存，不碰别人的缓存', () => {
    expect(isModelCacheName('ocr-models')).toBe(true);
    expect(isModelCacheName('ocr-models-fast-v1-deadbeef')).toBe(true);
    for (const other of ['html-navigation', 'pdfjs-wasm', 'tess-assets', 'onnx-wasm', 'workbox-precache-v2-x']) {
      expect(isModelCacheName(other), other).toBe(false);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 3 · 容量预检查（拿什么数字判断）
// ═══════════════════════════════════════════════════════════════
describe('容量预检查：25 MiB 单文件上限 + 站点配额', () => {
  it('逐个资产都对照 25 MiB 算一遍 —— 四个都在上限内，且最接近上限的是 recognition', () => {
    // 配额数字也给上，这样拿到的是完整报告（不是「查不了」那一档）
    const report = preflightModelTier('standard', {
      estimatedUsage: 0,
      estimatedQuota: 500 * 1024 * 1024,
    });
    expect(report.ok).toBe(true);
    expect(report.reason).toBe('ok');
    expect(report.items).toHaveLength(4);

    // 逐项对照（这也是给报告用的「每个资产与 25 MiB 的对照」）
    for (const id of tierAssets('standard')) {
      const bytes = MODEL_ASSETS[id].bytes;
      expect(bytes, `${id} 超过 25 MiB`).toBeLessThanOrEqual(MAX_SINGLE_ASSET_BYTES);
      // 余量必须为正（不是一个恰好等于上限的巧合）
      expect(MAX_SINGLE_ASSET_BYTES - bytes).toBeGreaterThan(0);
    }

    // 最接近上限的是 recognition（20.30 MiB / 25 MiB = 81.2%）
    const biggest = [...tierAssets('standard')].sort(
      (a, b) => MODEL_ASSETS[b].bytes - MODEL_ASSETS[a].bytes,
    )[0];
    expect(biggest).toBe('recognition');
  });

  it('**单文件超限时必须拦住**（把上限压到比某个资产小，等价于该资产超了 25 MiB）', () => {
    // 这条用「压低上限」而不是「伪造一个 30 MiB 的资产」，
    // 因为后者需要改动清单，而清单是唯一真源、不该被用例改写
    const tinyLimit = MODEL_ASSETS.recognition.bytes - 1;
    const report = preflightModelTier('standard', { maxSingleAssetBytes: tinyLimit });

    expect(report.ok).toBe(false);
    expect(report.reason).toBe('single-file-over-limit');
    expect(preflightBlocksDownload(report)).toBe(true);
    expect(report.detail).toContain('25');
    // 报告里必须带着判断用的那两个数字
    expect(report.numbers.maxSingleAssetBytes).toBe(tinyLimit);
  });

  it('配额不足时必须拦住，且用的是 usage / quota 两个真实数字', () => {
    const need = tierTotalBytes('standard');
    const report = preflightModelTier('standard', {
      estimatedUsage: 900,
      estimatedQuota: 1000,
    });

    expect(report.ok).toBe(false);
    expect(report.reason).toBe('insufficient-storage');
    expect(preflightBlocksDownload(report)).toBe(true);
    expect(report.numbers.estimatedUsage).toBe(900);
    expect(report.numbers.estimatedQuota).toBe(1000);
    // 数字要出现在给人看的那句话里，否则界面上没法解释为什么不让下
    expect(report.detail).toContain((need / 1024 / 1024).toFixed(2));
  });

  it('配额刚好够（相等）时放行 —— 边界不许误拦', () => {
    const report = preflightModelTier('standard', {
      estimatedUsage: 0,
      estimatedQuota: tierTotalBytes('standard'),
    });
    expect(report.ok).toBe(true);
    expect(preflightBlocksDownload(report)).toBe(false);
  });

  it('配额**查不到**时不拦（查不了 ≠ 不够；否则浏览器没实现该 API 就永远下不了模型）', () => {
    const report = preflightModelTier('standard', { estimatedUsage: null, estimatedQuota: null });
    expect(report.reason).toBe('no-storage-api');
    expect(report.ok).toBe(false); // 结论是「没判成 ok」…
    expect(preflightBlocksDownload(report)).toBe(false); // …但不许拦住下载
  });

  it('已缓存的资产不进下载清单，也不计入总量', () => {
    const all = modelTierUrlsForTest();
    const cached = all.slice(0, 3);
    const report = preflightModelTier('standard', { cachedKeys: cached });

    expect(report.items).toHaveLength(1);
    expect(report.items[0].assetId).toBe('layout');
    expect(report.totalBytes).toBe(MODEL_ASSETS.layout.bytes);
  });

  it('fast 档的总量比 standard 少一个版面模型，且差额正好是它', () => {
    expect(tierTotalBytes('standard') - tierTotalBytes('fast')).toBe(MODEL_ASSETS.layout.bytes);
  });

  it('版面模型的字节数与 layoutAnalysis.ts 的 LAYOUT_MODEL_BYTES 一致', () => {
    // 两处不一致的表现：预检查按旧数字放行，实际写盘的是新字节数
    expect(MODEL_ASSETS.layout.bytes).toBe(LAYOUT_MODEL_BYTES);
    expect(MODEL_ASSETS.layout.path).toBe(LAYOUT_MODEL_FILE);
  });
});

function modelTierUrlsForTest(): string[] {
  return tierAssets('standard').map((id) => modelAssetUrl(id));
}

// ═══════════════════════════════════════════════════════════════
// 4 · 旧档位清理
// ═══════════════════════════════════════════════════════════════
describe('换档位时清掉旧缓存', () => {
  function stubStorage(names: string[]) {
    const deleted: string[] = [];
    return {
      deleted,
      storage: {
        keys: async () => [...names],
        delete: async (name: string) => {
          deleted.push(name);
          return true;
        },
      },
    };
  }

  it('删的是别的档位，留的正好是当前档位那一份', async () => {
    const other = modelCacheName('fast');
    const thorough = modelCacheName('thorough');
    const { storage, deleted } = stubStorage([thorough, 'ocr-models', other, 'html-navigation']);

    const result = await cleanupStaleModelCaches('thorough', storage);

    // thorough 是默认档位之外的档位，裸名 ocr-models 那份它不会去读
    // （运行时路由只认 modelCacheName(当前档位)），所以删掉
    expect(result.kept).toEqual([thorough]);
    expect(result.deleted).toEqual(['ocr-models', other]);
    expect(deleted).toEqual(['ocr-models', other]);
  });

  it('**两个方向都成立**：降级删掉 standard 那份，升级删掉 fast 那份', async () => {
    const fast = modelCacheName('fast');
    const { storage, deleted } = stubStorage(['ocr-models', fast]);

    // standard → fast：删掉 standard 那份（裸名）
    const toFast = await cleanupStaleModelCaches('fast', storage);
    expect(toFast.deleted).toEqual(['ocr-models']);
    expect(toFast.kept).toEqual([fast]);

    deleted.length = 0;

    // fast → standard：删掉 fast 那份
    const toStandard = await cleanupStaleModelCaches('standard', storage);
    expect(toStandard.deleted).toEqual([fast]);
    expect(toStandard.kept).toEqual(['ocr-models']);
    expect(deleted).toEqual([fast]);
  });

  it('同一档位内换了资产集合（指纹变）⇒ 旧指纹那份也被清掉', async () => {
    const current = modelCacheName('fast');
    const staleSameTier = `${MODEL_CACHE_PREFIX}-fast-v1-00000000`;
    expect(staleSameTier).not.toBe(current);
    const { storage, deleted } = stubStorage([current, staleSameTier]);

    const result = await cleanupStaleModelCaches('fast', storage);

    expect(result.deleted).toEqual([staleSameTier]);
    expect(result.kept).toEqual([current]);
    expect(deleted).toEqual([staleSameTier]);
  });

  it('sameAssetSet 判的是文件集合，不是名字也不是顺序', () => {
    expect(sameAssetSet('fast', 'standard')).toBe(false); // 少一个版面模型
    expect(sameAssetSet('standard', 'thorough')).toBe(true); // 同一套文件
    expect(sameAssetSet('standard', 'standard')).toBe(true);
    expect(sameAssetSet('thorough', 'standard')).toBe(true); // 对称
  });

  it('别人家的缓存名字长得再像也不动', async () => {
    const { storage, deleted } = stubStorage(['html-navigation', 'ocr-models-notes', 'tess-assets']);

    await cleanupStaleModelCaches('standard', storage);

    // ⚠️ `ocr-models-notes` 确实会被 isModelCacheName 认成模型缓存（前缀匹配），
    // 于是它被删 —— 这是刻意接受的：模型缓存的名字空间就归本模块管，
    // 而真正的三条边界（html-navigation / tess-assets / pdfjs-wasm）
    // 必须一个都不碰。这一条把边界钉在这里，避免以后改前缀时改宽。
    expect(deleted).toEqual(['ocr-models-notes']);
    expect(deleted).not.toContain('html-navigation');
    expect(deleted).not.toContain('tess-assets');
  });

  it('**别人的缓存一个都不许删**（误删 html-navigation 等于把离线能力拆掉）', async () => {
    const others = ['html-navigation', 'pdfjs-wasm', 'tess-assets', 'onnx-wasm'];
    const { storage, deleted } = stubStorage([...others, 'ocr-models']);

    await cleanupStaleModelCaches('standard', storage);

    expect(deleted).toEqual([]);
  });

  it('没有 CacheStorage 时安静返回（Node / SW 未接管），不抛', async () => {
    await expect(cleanupStaleModelCaches('standard', undefined)).resolves.toEqual({
      deleted: [],
      kept: [],
    });
  });

  it('delete 抛错时只告警，不上抛（清理不能反过来挡住加载模型）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await cleanupStaleModelCaches('standard', {
        keys: async () => ['ocr-models-fast-v1-x'],
        delete: async () => {
          throw new Error('QuotaExceededError');
        },
      });
      expect(result).toEqual({ deleted: [], kept: [] });
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 5 · 编排顺序：预检查在第一个字节之前（**跑出来的**，不是读源码读出来的）
// ═══════════════════════════════════════════════════════════════
describe('ensureModelTierAssets：预检查先于下载', () => {
  function stubCacheStorage(names: string[] = []) {
    const puts: { url: string; cacheName: string }[] = [];
    const deleted: string[] = [];
    const opened: string[] = [];

    const storage = {
      keys: async () => [...names],
      delete: async (name: string) => {
        deleted.push(name);
        return true;
      },
      open: async (name: string) => {
        opened.push(name);
        return {
          match: async () => undefined,
          put: async (url: string) => {
            puts.push({ url, cacheName: name });
          },
        };
      },
    };
    return { storage, puts, deleted, opened };
  }

  function okResponse() {
    return { ok: true, status: 200, clone: () => ({ ok: true, status: 200 }) } as unknown as Response;
  }

  it('配额不足 ⇒ **一个字节都不下载**，且返回拦住的理由与原始数字', async () => {
    const { storage, puts } = stubCacheStorage();
    const fetchImpl = vi.fn(async () => okResponse());

    const result = await ensureModelTierAssets('standard', {
      storage,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      readEstimate: async () => ({ usage: 10_000, quota: 11_000 }),
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(puts).toEqual([]); // 一个字节都没写进缓存
    expect(result.downloaded).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.preflight.reason).toBe('insufficient-storage');
    expect(result.preflight.numbers.estimatedQuota).toBe(11_000);
  });

  it('配额充足、四个资产都在 25 MiB 以内 ⇒ 放行并全部下载（不是「一律拦住」）', async () => {
    const { storage } = stubCacheStorage();
    const fetchImpl = vi.fn(async () => okResponse());

    const result = await ensureModelTierAssets('standard', {
      storage,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      readEstimate: async () => ({ usage: 0, quota: Number.MAX_SAFE_INTEGER }),
    });

    // 空间管够 ⇒ 这一条必须靠单文件上限放过，不能靠配额
    expect(result.preflight.ok).toBe(true);
    expect(result.preflight.reason).toBe('ok');
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(result.downloaded).toHaveLength(4);
  });

  it('配额够 ⇒ 按资产清单逐个下载，并写进**本档位那份缓存**', async () => {
    const { storage, puts, opened } = stubCacheStorage();
    const fetchImpl = vi.fn(async () => okResponse());

    const result = await ensureModelTierAssets('fast', {
      storage,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      readEstimate: async () => ({ usage: 0, quota: 500 * 1024 * 1024 }),
    });

    const expectedUrls = modelTierUrlsForTest().filter((u) => !u.endsWith('PP-DocLayout-S.onnx'));
    expect(result.downloaded).toEqual(expectedUrls);
    expect(puts.map((p) => p.url)).toEqual(expectedUrls);
    expect(new Set(puts.map((p) => p.cacheName))).toEqual(new Set([modelCacheName('fast')]));
    expect(opened).toEqual([modelCacheName('fast')]);
    expect(result.preflight.ok).toBe(true);
  });

  it('先清旧档位，再下载（顺序：清理 → 预检查 → 下载）', async () => {
    const order: string[] = [];
    const storage = {
      keys: async () => {
        order.push('keys');
        return ['ocr-models'];
      },
      delete: async () => {
        order.push('delete');
        return true;
      },
      open: async () => {
        order.push('open');
        return { match: async () => undefined, put: async () => {} };
      },
    };
    const fetchImpl = vi.fn(async () => {
      order.push('fetch');
      return okResponse();
    });

    await ensureModelTierAssets('fast', {
      storage,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      readEstimate: async () => ({ usage: 0, quota: 500 * 1024 * 1024 }),
    });

    expect(order[0]).toBe('keys');
    expect(order).toContain('delete');
    // 每个 fetch 都必须排在 delete 之后
    const firstFetch = order.indexOf('fetch');
    expect(firstFetch).toBeGreaterThan(order.indexOf('delete'));
  });

  it('已缓存的资产不重复下载（match 命中即跳过）', async () => {
    const all = modelTierUrlsForTest();
    const cachedUrls = all.slice(0, 2);
    const storage = {
      keys: async () => [] as string[],
      delete: async () => true,
      open: async () => ({
        match: async (url: string) => (cachedUrls.includes(url) ? okResponse() : undefined),
        put: async () => {},
      }),
    };
    const fetchImpl = vi.fn(async () => okResponse());

    const result = await ensureModelTierAssets('standard', {
      storage,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      readEstimate: async () => ({ usage: 0, quota: 500 * 1024 * 1024 }),
    });

    expect(result.preflight.items.map((i) => i.url)).toEqual(all.slice(2));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('没有 CacheStorage 时安静跳过（首次访问就是 SW 还没接管）', async () => {
    const fetchImpl = vi.fn(async () => okResponse());

    const result = await ensureModelTierAssets('standard', {
      storage: undefined,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.skipped).toBe(true);
    expect(result.downloaded).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('单个资产失败不中断其余的，失败项如实记在 failed 里', async () => {
    const { storage } = stubCacheStorage();
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n++;
      if (n === 2) return { ok: false, status: 404 } as unknown as Response;
      return okResponse();
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const result = await ensureModelTierAssets('standard', {
        storage,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        readEstimate: async () => ({ usage: 0, quota: 500 * 1024 * 1024 }),
      });

      expect(result.downloaded).toHaveLength(3);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]).toContain('recognition');
    } finally {
      warn.mockRestore();
    }
  });

  it('配额读失败（抛错）⇒ 当作「查不了」，不拦下载', async () => {
    const { storage } = stubCacheStorage();
    const fetchImpl = vi.fn(async () => okResponse());

    const result = await ensureModelTierAssets('standard', {
      storage,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      readEstimate: async () => {
        throw new Error('SecurityError');
      },
    });

    expect(result.preflight.reason).toBe('no-storage-api');
    expect(result.downloaded).toHaveLength(4);
  });
});

// ═══════════════════════════════════════════════════════════════
// 6 · 构建期脚本契约（唯一读文件的一组：构建期没有浏览器，只能这样验）
// ═══════════════════════════════════════════════════════════════
describe('构建期脚本与运行时清单的契约', () => {
  const SCRIPT = readFileSync(join(process.cwd(), 'scripts', 'fetch-ocr-models.mjs'), 'utf8');
  const VITE_CONFIG = readFileSync(join(process.cwd(), 'vite.config.ts'), 'utf8');

  /**
   * 取出模型那条运行时路由里的 `cacheName`。
   *
   * ⚠️ 判据用的是**整段正则的转义形式**，而不是「源码里出现过某个名字」：
   * `vite.config.ts` 里那段解释档位的注释**自己就写着** cacheName 与
   * ocr-models-fast-… 这样的字面量，而去注释这事又不可靠 —— 实测发现
   * 本仓库常见的那套「按行去 `//` 注释」会把**注释后面那一整行代码**一起吃掉
   * （前导 `\s` 含换行），于是 `globIgnores` 直接消失、断言变成假失败
   * （`pwaOffline.test.ts` 里那份没暴露这个问题，只是因为 `cacheName`
   * 与注释碰巧在同一行）。
   *
   * 所以这里挑了一个**在散文里不可能出现**的锚点：workbox 写进 `sw.js` 的
   * 就是这一串转义形式，`escapeString(RegExp)` 的输出是稳定的。
   */
  function modelRouteCacheName(): string | undefined {
    const anchor = String.raw`(\/ocr-models\/)|(^https:\/\/(huggingface\.co|hf-mirror\.com)\/)`;
    const at = VITE_CONFIG.indexOf(anchor);
    if (at === -1) return undefined;
    const match = /cacheName:\s*([^,\n]+)/.exec(VITE_CONFIG.slice(at));
    return match?.[1].trim();
  }

  it('脚本的下载清单**由运行时清单推导**，不再抄一份字面量', () => {
    // 判据是「推导表达式」而不是「某个名字出现过」：
    // 少任何一环，清单就又能被抄成第二份真源
    expect(SCRIPT).toMatch(/const FILES = tierAssets\('standard'\)\.map\(/);
    expect(SCRIPT).toMatch(/const asset = MODEL_ASSETS\[id\]/);
    expect(SCRIPT).toMatch(/path: asset\.path/);
    expect(SCRIPT).toMatch(/bytes: asset\.bytes/);
  });

  it('脚本里不再抄路径与字节数（抄了就会与运行时清单漂移）', () => {
    // 找的是**带引号的字面量**（`'…'` / `"…"`），不是文件名在注释里被提到 ——
    // 后者只是散文，前者才是第二份真源
    for (const asset of Object.values(MODEL_ASSETS)) {
      expect(SCRIPT, `${asset.path} 在脚本里被写成了字面量`).not.toContain(`'${asset.path}'`);
      expect(SCRIPT, `${asset.path} 在脚本里被写成了字面量`).not.toContain(`"${asset.path}"`);
      const bytes = String(asset.bytes);
      expect(SCRIPT, `${bytes} 在脚本里被写成了字面量`).not.toContain(bytes);
      // 带下划线分隔的写法同样算字面量
      const grouped = bytes.replace(/\B(?=(\d{3})+(?!\d))/g, '_');
      expect(SCRIPT, `${grouped} 在脚本里被写成了字面量`).not.toContain(grouped);
    }
  });

  it('脚本确实 import 了运行时清单（路径写错的话 node 直接起不来，见下一条）', () => {
    expect(SCRIPT).toMatch(/from '\.\.\/src\/lib\/modelCacheTiers\.ts'/);
  });

  it('⚠️ **真的把脚本跑起来**：`--self-check` 在取任何字节之前做预检查并打印逐项对照', () => {
    /**
     * 这是本组里唯一一条**执行**而非读文本的用例，理由是
     * 「`from '../src/lib/modelCacheTiers.ts'` 能不能被 node 解析」
     * 只有跑起来才知道 —— 路径写错时，任何 `toMatch` 都照样绿。
     * `--self-check` 分支在预检查之后就退出，不联网、不下载、不写文件。
     */
    const out = execFileSync(
      process.execPath,
      [join('scripts', 'fetch-ocr-models.mjs'), '--self-check'],
      { cwd: process.cwd(), encoding: 'utf8' },
    );

    expect(out).toContain('容量预检查通过');
    // 逐项对照必须真的打印出来（每个资产一行，含占 25 MiB 的百分比）
    for (const asset of Object.values(MODEL_ASSETS)) {
      expect(out, `${asset.path} 没出现在逐项对照里`).toContain(asset.path);
    }
    expect(out).toMatch(/上限的 \d+\.\d%/);
  });

  it('⚠️ **预检查真的拦住了下载**：造出一个超限情况，跑真脚本，看它有没有去取字节', () => {
    /**
     * 这是「容量预检查发生在第一个字节被取之前」**唯一的真判据**。
     *
     * 为什么不能只读源码：第一版就是读文本 —— 让预检查在一个闭包里
     * `if (preflightBlocksDownload(preflight)) throw …`、把**调用**挪到下载
     * 循环之后，文本断言照样绿（`preflightBlocksDownload(` 这个串还在原处）。
     * 那正是本项目已经吃过 5 次以上的「假保护」。
     *
     * 造的情况：
     *   · 上限压到 **1 字节**（环境变量，运行期不会有人设）；
     *   · 两个来源 base 指向**必然解析失败**的主机
     *     （`.invalid` 是 RFC 2606 保留的 TLD）。
     * 于是「有没有去取字节」变成一个可观测量：预检查在前 ⇒ 报「容量预检查
     * 未通过」，且**不会**出现「需要下载」这种只有走进下载循环才会打印的话。
     *
     * ⚠️ 必须 `--self-check`：不带的话本地 `public/ocr-models/` 那四个文件
     * 全算「已存在」→ `items` 为空 → 预检查无事可查 → 脚本正常退出，
     * 这条断言就变成了假的（第一版正是这样绿的）。
     * `--self-check` 跳过落盘扫描，四个资产全部进入本次要取的范围。
     */
    const run = (args: string[]) => {
      let stdout = '';
      let status = 0;
      try {
        stdout = execFileSync(process.execPath, [join('scripts', 'fetch-ocr-models.mjs'), ...args], {
          cwd: process.cwd(),
          encoding: 'utf8',
          env: {
            ...process.env,
            [MAX_SINGLE_ASSET_BYTES_ENV]: '1',
            OCR_MODEL_SOURCE: 'https://ocr-source.invalid/models',
            OCR_LAYOUT_MODEL_SOURCE: 'https://layout-source.invalid/models',
          },
        });
      } catch (err) {
        const e = err as { status?: number; stdout?: string; stderr?: string };
        status = e.status ?? -1;
        stdout = `${e.stdout ?? ''}${e.stderr ?? ''}`;
      }
      return { status, stdout };
    };

    const { status, stdout } = run(['--self-check']);

    expect(status, '预检查没拦住 —— 脚本正常退出了').not.toBe(0);
    expect(stdout).toContain('容量预检查未通过');
    expect(stdout).toContain('未下载任何文件');
    // 上限用了注入的那个数字（证明判断真的读了这个值，而不是恰好通过）
    expect(stdout).toContain('单文件上限 1 字节');
    // ⚠️ 关键判据：**不许**出现「已经去取过字节」的痕迹
    expect(stdout).not.toContain('需要下载');
    expect(stdout).not.toMatch(/fetch failed|ENOTFOUND|HTTP \d/);
  });

  it('⚠️ 真下载路径也一样：把一个模型文件挪走后跑脚本，它仍然在取字节之前被拦住', () => {
    /**
     * 上一条走的是 `--self-check` 分支。这一条走**真实分支**：
     * 把 `public/ocr-models/` 里的版面模型临时挪走 → 脚本会认为
     * 「有 1 个文件需要下载」→ 在来源不可达、上限 1 字节的条件下，
     * **必须在打印「需要下载」之前就被拦住**。
     *
     * 这一条能杀掉「闸门被挪进闭包、延后到下载之后才执行」那种变异 ——
     * 那时输出里会先出现「需要下载」，然后是网络失败。
     *
     * 安全说明：`public/ocr-models/` 由 `.gitignore` 排除、由 prebuild 重新
     * 取回，所以这里挪走再放回是无害的；文件无论如何都不会被写坏
     * （`download()` 只在 fetch 成功后才写）。
     */
    const layoutRel = MODEL_ASSETS.layout.path; // layout/PP-DocLayout-S.onnx
    const full = join(process.cwd(), 'public', 'ocr-models', layoutRel);
    const parked = `${full}.parked-by-test`;
    if (!existsSync(full)) return; // 没取过模型的环境（CI 单跑测试）跳过

    renameSync(full, parked);
    let result: { status: number; stdout: string };
    try {
      let stdout = '';
      let status = 0;
      try {
        stdout = execFileSync(
          process.execPath,
          [join('scripts', 'fetch-ocr-models.mjs')],
          {
            cwd: process.cwd(),
            encoding: 'utf8',
            env: {
              ...process.env,
              [MAX_SINGLE_ASSET_BYTES_ENV]: '1',
              OCR_MODEL_SOURCE: 'https://ocr-source.invalid/models',
              OCR_LAYOUT_MODEL_SOURCE: 'https://layout-source.invalid/models',
            },
          },
        );
      } catch (err) {
        const e = err as { status?: number; stdout?: string; stderr?: string };
        status = e.status ?? -1;
        stdout = `${e.stdout ?? ''}${e.stderr ?? ''}`;
      }
      result = { status, stdout };
    } finally {
      renameSync(parked, full);
    }

    expect(result.status, '预检查没拦住真实下载路径').not.toBe(0);
    expect(result.stdout).toContain('容量预检查未通过');
    // ⚠️ 关键：脚本**没有**走到下载循环
    expect(result.stdout).not.toContain('需要下载');
    expect(result.stdout).not.toMatch(/fetch failed|ENOTFOUND|HTTP \d/);
    // 挪走的文件原样还在（一个字节都没被重写）
    expect(existsSync(full)).toBe(true);
  });

  it('预检查闸门**在 main() 顶层顺序执行**，没有被包进任何函数', () => {
    /**
     * 与上面两条互补：它们管「真的拦住」，这一条管「拦住的那段代码
     * 不在下载循环里、也没有被延后执行」。
     *
     * 判据是**相对缩进**（而不是写死几个空格）：先量出 `main()` 函数体里
     * 最浅的那一档缩进（= 直接写在函数体里的语句），再要求闸门就在那一档、
     * 且出现在下载循环之前。包进闭包或循环里都会比它更深 —— 至少深两格。
     *
     * ⚠️ 不能只断言「源码里出现过 preflightBlocksDownload」——实测过：
     * 把它包进 `const gate = () => { if (preflightBlocksDownload(…)) throw … }`
     * 再把 `gate()` 调到下载循环之后，那种写法照样匹配得到那个字符串，
     * 而行为测试也可能因为「`--self-check` 分支恰好也抛错」而看不出差别。
     */
    const mainAt = SCRIPT.indexOf('async function main()');
    expect(mainAt).toBeGreaterThan(-1);
    /**
     * 取 `main()` 的函数体：从它那一行之后开始，到**第一个顶格 `}`** 结束。
     *
     * ⚠️ 别去数花括号、也别用 `indexOf('async function', …)` 当右边界 ——
     * `main()` 里会调用 `download(...)`，而 `download` 就是一个
     * `async function`，那样会切在 main 中间（我实测踩了这个坑）。
     * 本文件里 main 之后第一个**顶格**的 `}` 就是它的收尾。
     */
    const endMatch = /\n\}\n/.exec(SCRIPT.slice(mainAt));
    expect(endMatch, '找不到 main() 的收尾').not.toBeNull();
    const body = SCRIPT.slice(mainAt, mainAt + endMatch!.index);

    /**
     * 只取「可能是语句」的行。
     *
     * ⚠️ 必须排除**模板字符串的续行**：本脚本里
     *   `…合计 ${(\n        preflight.totalBytes /`
     * 这类续行是顶格写的（缩进 0），会把「最浅缩进」压成 0，
     * 于是任何语句都比它深，断言变成永远失败（我实测踩了两次）。
     * 模板字符串的续行一定出现在某一行以反引号开头之后。
     */
    const statementLines: string[] = [];
    let insideTemplate = false;
    for (const line of body.split('\n')) {
      const ticks = (line.match(/`/g) ?? []).length;
      const startedInside = insideTemplate;
      if (ticks % 2 === 1) insideTemplate = !insideTemplate;
      if (startedInside) continue; // 上一行就开始的模板字符串的续行
      if (line.trim().length === 0) continue;
      if (/^(async function main|\})/.test(line.trim())) continue; // 签名与收尾花括号
      statementLines.push(line);
    }
    const topLevel = Math.min(
      ...statementLines.map((line) => line.length - line.trimStart().length),
    );

    const gateLine = statementLines.find((line) =>
      line.includes('if (preflightBlocksDownload(preflight))'),
    );
    expect(gateLine, 'main() 里找不到预检查闸门').toBeDefined();
    const gateIndent = gateLine!.length - gateLine!.trimStart().length;
    expect(
      gateIndent,
      `闸门缩进 ${gateIndent} 比 main() 顶层语句的缩进 ${topLevel} 更深 —— 它被包进闭包/循环了`,
    ).toBe(topLevel);

    // 而且在下载循环之前
    const gateAt = body.indexOf('if (preflightBlocksDownload(preflight))');
    const loopAt = body.search(/for \(const f of pending\)/);
    expect(loopAt, 'main() 里找不到下载循环').toBeGreaterThan(-1);
    expect(gateAt).toBeLessThan(loopAt);
  });

  it('vite.config.ts 的模型路由缓存名 = 默认档位那份，且**不是写死的字符串**', () => {
    const expression = modelRouteCacheName();
    expect(
      expression,
      '在 vite.config.ts 里找不到模型路由的 cacheName（测试需要同步更新）',
    ).toBeDefined();
    // 写死的字符串会让「缓存 × 档位」在构建配置这一侧失效：
    // 运行时按档位算名字、路由却永远只认一个名字
    expect(expression).toMatch(/modelCacheName\(/);
    expect(expression).not.toMatch(/^['"]/);
  });

  it('模型路由的 urlPattern 仍然覆盖 /ocr-models/ 与两个第三方主机', () => {
    // 这条防止「改了 cacheName 顺手把 urlPattern 改窄」——
    // 那会让 VITE_OCR_MODEL_BASE 指向镜像的用户失去缓存
    const anchor = String.raw`(\/ocr-models\/)|(^https:\/\/(huggingface\.co|hf-mirror\.com)\/)`;
    expect(VITE_CONFIG).toContain(anchor);
    expect(VITE_CONFIG).toContain('huggingface');
    expect(VITE_CONFIG).toContain('hf-mirror');
  });

  it('模型资产仍在预缓存之外（35MB 不进首访安装体积）', () => {
    // 同样用「散文里不可能出现的锚点」定位：globIgnores 那一段
    const at = VITE_CONFIG.indexOf('globIgnores: [');
    expect(at, '找不到 globIgnores —— 预缓存排除清单被删了？').toBeGreaterThan(-1);
    const block = VITE_CONFIG.slice(at, VITE_CONFIG.indexOf(']', at));
    for (const glob of ['**/tess/**', '**/tess-core/**', '**/tessdata/**', '**/ort-wasm*']) {
      expect(block, `${glob} 不在 globIgnores 里`).toContain(glob);
    }
    // 也不许出现 globPatterns：一旦显式列了 pattern，就等于把模型目录
    // 重新纳进预缓存的候选集，而这里的体积账正是靠「默认 glob 被 ignores 挡掉」算的
    expect(VITE_CONFIG).not.toMatch(/globPatterns\s*:/);
  });

  it('⚠️ 构建产物回归：`dist/sw.js` 里模型路由的 cacheName 仍是 `ocr-models`', () => {
    /**
     * 「默认档位行为与改动前相同」这条不变量，最强的一次核对是**真产物**：
     * 改动前 `dist/sw.js` 里那一段是
     *   `registerRoute(/(\/ocr-models\/)|(^https:\/\/(huggingface\.co|hf-mirror\.com)\/)/,`
     *   `new e.CacheFirst({cacheName:"ocr-models",…`
     * 逐字如此（本机实测，未改动的产物）。
     *
     * 没有构建产物时跳过 —— 这样用例在「只跑单测」的环境里也不会假红。
     */
    const swPath = join(process.cwd(), 'dist', 'sw.js');
    if (!existsSync(swPath)) return;

    const sw = readFileSync(swPath, 'utf8');
    const anchor = String.raw`(\/ocr-models\/)|(^https:\/\/(huggingface\.co|hf-mirror\.com)\/)`;
    const at = sw.indexOf(anchor);
    expect(at, 'dist/sw.js 里没有模型路由 —— 产物过期或配置被改').toBeGreaterThan(-1);
    const after = sw.slice(at);
    const name = /cacheName:"([^"]+)"/.exec(after)?.[1];
    expect(name).toBe('ocr-models');
  });
});
