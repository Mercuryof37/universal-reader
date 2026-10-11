/**
 * 模型资产的**缓存 × 档位**：缓存身份、容量预检查、旧档位清理。
 *
 * ═══════════════════════════════════════════════════════════════
 * 这个文件补的是哪一环
 * ═══════════════════════════════════════════════════════════════
 *
 * 本项目已经确立的模型分发模式是
 * 「**构建时取好 → 同源 `public/ocr-models/` → 运行时 CacheFirst → 不预缓存**」
 * （见 `vite.config.ts` 的 runtimeCaching 与 `scripts/fetch-ocr-models.mjs`）。
 * 它解决的是「**怎么取到**」，没有解决「**取到的是哪一份**」：
 *
 * | 缺口 | 具体表现 |
 * |---|---|
 * | 缓存身份与选项无关 | 四个模型文件的缓存名固定为 `ocr-models`，不管这份结果是在什么条件下产出的 |
 * | 容量只在构建期查 | 25 MiB / 站点配额只在 `verify-dist.mjs`（构建后）与浏览器写盘报错时才暴露 |
 * | 换档位不清理 | 旧档位的模型永久留在 Cache Storage 里，只受 `maxEntries` 间接约束 |
 *
 * MinerU 4.0 把「质量档位」做成了**用户可见契约**并**按 (文档, 档位) 缓存**，
 * 无显式档位时按 `advanced → standard → basic` 优先读缓存；它的 `--force`
 * 只跳过本次缓存、**不删除**旧结果（`--force` 与 `invalidate` 语义分离）。
 * 本项目对应的是同一件事：**同一份扫描件在「版面模型参与」与「不参与」下
 * 产出的东西不是同一样东西**，因此它们的资产缓存也必须分得开。
 *
 * ⚠️ **本文件不做的事（边界要说清）**：
 * · **不改资产路径**。四个文件的 URL 与改动前逐字节相同 ——
 *   `src/lib/ocrModelSource.ts` 与 `src/lib/layoutAnalysis.ts` 按固定路径取模型，
 *   把档位塞进 URL 会牵动它们，而那两个文件不属于本次改动范围。
 *   因此**缓存身份由缓存名承担**，不是由 URL 承担（见 `modelCacheName`）。
 * · **不实现滑动窗口**。本项目的瓶颈是首次下载与每页耗时，不是内存
 *   （单线程 WASM、逐页处理），照抄滑动窗口是无效优化。
 * · **不在导入路径上做任何事**。所有副作用都在显式调用的函数里。
 *
 * ═══════════════════════════════════════════════════════════════
 * ⚠️ 尚未接线：`ensureModelTierAssets` 目前**没有运行时调用点**
 * ═══════════════════════════════════════════════════════════════
 *
 * 状态说清楚，免得读的人以为它已经在跑：
 *
 * | 能力 | 状态 |
 * |---|---|
 * | 缓存身份按档位区分（`modelCacheName`） | ✅ 已生效 —— `vite.config.ts` 的路由直接用它 |
 * | 下载前的容量预检查 | ✅ 构建期已生效（`scripts/fetch-ocr-models.mjs`）；<br>⚠️ 运行期**只实现、未接线** |
 * | 旧档位缓存清理 | ⚠️ **只实现、未接线** |
 *
 * 没接线的原因不是漏了，而是**没有合适的地方**：
 * · 档位取决于「版面模型是否可用」，而那个能力的检测在
 *   `src/lib/layoutAnalysis.ts`（`loadLayoutSession`），该文件本轮**不许改**；
 * · 本项目**没有**设置面板里的档位开关（档位是能力推出来的，不是用户选的）；
 * · `src/lib/pwa.ts` 是唯一现成的启动钩子（它已经在那里调
 *   `seedNavigationFallback()`），但它**不在**本任务允许改动的文件清单里。
 *
 * **接线方式（一行，留给下一轮或档位开关落地时用）**：
 *
 * ```ts
 * // src/lib/pwa.ts 的 useRegisterSW({ onRegisteredSW() { … } }) 里，
 * // 与 seedNavigationFallback() 并列：
 * void ensureModelTierAssets(resolveQualityTier({ layoutModel: <能力检测结果> }));
 * ```
 *
 * 它**不是**「先下载再判断」：`ensureModelTierAssets` 的第一步就是
 * `cleanupStaleModelCaches` + `preflightModelTier`，拦住时一个字节都不取。
 * 在被调用之前，运行期行为与改动前**完全一致**（模型仍由那条 CacheFirst
 * 路由按需取），所以本轮的改动没有引入任何运行期副作用。
 */

/**
 * 浏览器给的那一点点配额信息。
 *
 * ⚠️ 同样是结构类型而不是 `StorageManager`：DOM 类型不保证在每个
 * 编译目标里都在（`vite.config.ts` 会把本模块一起编译，而那个 project
 * 的 `lib` 里没有 DOM）。写成结构类型后两边都能编译，且行为一致。
 */
interface StorageQuotaManager {
  estimate(): Promise<{ usage?: number; quota?: number }>;
}

// ═══════════════════════════════════════════════════════════════
// 档位
// ═══════════════════════════════════════════════════════════════

/**
 * 质量档位。
 *
 * 命名沿用 MinerU 4.0 的 `basic` / `standard`，并保留本项目原有的
 * **不使用版面模型**这一档（本项目在接入 T3 之前就是按几何启发式做的，
 * 那一档必须能被表达出来，否则「版面模型不可用」时没有档位可用 ——
 * MinerU 对这种情况的原文要求是**报 `quality_tier_unavailable`，
 * 不静默降级**）。
 */
export const MODEL_TIERS = ['fast', 'standard', 'thorough'] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

/**
 * 默认档位 = **改动前的行为**。
 *
 * 改动前只有一套资产：OCR 三件套 + 版面模型，缓存名 `ocr-models`。
 * `standard` 必须与它逐项对应，否则「默认档位行为不变」这条不变量就断了
 * （见 `src/lib/modelCacheTiers.test.ts` 里对 `standard` 的断言）。
 */
export const DEFAULT_MODEL_TIER: ModelTier = 'standard';

export interface ModelTierSpec {
  /** 用户可见的档位名（与 MinerU 一样，档位是契约而不是内部枚举） */
  readonly label: string;
  /** 这一档实际会请求的资产 id */
  readonly assets: readonly ModelAssetId[];
  /** 一句话说清代价 —— 界面上要照这句话写 */
  readonly note: string;
}

// ═══════════════════════════════════════════════════════════════
// 资产清单（**唯一真源**）
// ═══════════════════════════════════════════════════════════════

export type ModelAssetId = 'detection' | 'recognition' | 'charactersDictionary' | 'layout';

export interface ModelAsset {
  /** 相对模型根目录的路径 */
  readonly path: string;
  /** 上游声明的字节数（与 `scripts/fetch-ocr-models.mjs` 的 `bytes` 同源） */
  readonly bytes: number;
  /** 声明过 sha256 的资产才有这一项；没有就是上游没给，不是漏了 */
  readonly sha256?: string;
  readonly what: string;
}

/**
 * 资产清单的**版本**。
 *
 * ⚠️ 它是**缓存身份的一部分**，只在「同一路径下的字节换了」时才 +1。
 * 不要绑 `__BUILD_ID__`：那个值每次构建都变，会把整档 30MB 在每个
 * 部署里判为过期，用户每升一次版本就要重下 30MB。
 *
 * 触发 +1 的三种情况：
 *   1. 某个文件的 sha256 变了（换模型版本、换量化格式）；
 *   2. 某个文件的路径变了；
 *   3. 这一档的资产集合变了（增删文件）。
 */
export const MODEL_ASSET_SET_VERSION = '1';

/**
 * 四个资产的路径与体积。
 *
 * ⚠️ 这里的 `path` 与 `bytes` 同时被三处使用，改一处必须四处一起改：
 *   · `vite.config.ts` 的 `/ocr-models/` 运行时路由（按 URL 命中，不认路径内容）；
 *   · `scripts/fetch-ocr-models.mjs`（构建期落盘 + 落盘前预检查）；
 *   · `scripts/verify-dist.mjs`（构建产物的 25 MiB 门禁）。
 * `src/lib/modelCacheTiers.test.ts` 会把脚本里的字节数与本文件逐项对齐。
 */
export const MODEL_ASSETS: Readonly<Record<ModelAssetId, ModelAsset>> = {
  detection: {
    path: 'detection/ort/PP-OCRv6_small_det.ort',
    bytes: 9_982_352,
    what: '文本检测（PP-OCRv6 small det）',
  },
  recognition: {
    path: 'recognition/ort/PP-OCRv6_small_rec.ort',
    bytes: 21_290_816,
    what: '文本识别（PP-OCRv6 small rec）',
  },
  charactersDictionary: {
    path: 'recognition/ppocrv6_dict.txt',
    bytes: 74_948,
    what: '识别字典',
  },
  layout: {
    path: 'layout/PP-DocLayout-S.onnx',
    bytes: 4_917_852,
    sha256: '33688dbee1c23e34b81777e97cb428eb40f24b242c02b5f623484959e830aec8',
    what: '版面分析（PP-DocLayout-S）',
  },
};

/**
 * 档位 → 资产集合。
 *
 * `fast` 用 `V6_TINY_MODEL`（≈6 MB，3–4× 快）的那一天，只需在
 * `MODEL_ASSETS` 加一组 id 并把它挂到这一档上 —— 缓存身份会自动跟着变
 * （`modelAssetSetKey` 覆盖 id **与** sha256/bytes），不会出现
 * 「换了档位却命中旧缓存」。本次不改任何资产文件。
 */
export const MODEL_TIER_SPECS: Readonly<Record<ModelTier, ModelTierSpec>> = {
  fast: {
    label: '快速',
    assets: ['detection', 'recognition', 'charactersDictionary'],
    note: '不加载版面模型（−4.69 MiB），页眉页脚与多栏顺序按几何启发式判断',
  },
  standard: {
    label: '标准',
    assets: ['detection', 'recognition', 'charactersDictionary', 'layout'],
    note: '加载版面模型（+4.69 MiB），页眉页脚 / 多栏顺序由版面模型判定',
  },
  thorough: {
    label: '深度',
    assets: ['detection', 'recognition', 'charactersDictionary', 'layout'],
    note: '与标准档同一套资产，区别只在推理算力（本项目当前不改变资产集合）',
  },
};

/** 这一档实际会请求的资产 id（顺序稳定，便于用例比对） */
export function tierAssets(tier: ModelTier): readonly ModelAssetId[] {
  return MODEL_TIER_SPECS[tier].assets;
}

/** 这一档的路径 → 资产 id */
export function tierAssetPaths(tier: ModelTier): readonly string[] {
  return tierAssets(tier).map((id) => MODEL_ASSETS[id].path);
}

/** 这一档的**总量**（字节） */
export function tierTotalBytes(tier: ModelTier): number {
  return tierAssets(tier).reduce((sum, id) => sum + MODEL_ASSETS[id].bytes, 0);
}

/**
 * 把「资产集合的内容身份」编成一个短指纹。
 *
 * ⚠️ 输入必须包含**内容身份**的全部四项（id / 路径 / 字节数 / sha256）：
 * 少任何一项，「同一路径下换了字节」就会判不出来 ——
 * 那正是 CacheFirst 在「路径没变、内容变了」时的失效模式。
 *
 * 导出它是为了让用例能**直接喂输入**验证「改任何一项都换指纹」，
 * 而不是只能对着固定的十六进制串比对（那种用例改一次模型就要改数字，
 * 而且证明不了它真的读了字节数）。
 */
export function fingerprintAssetSet(text: string): string {
  // FNV-1a 32 位：目的是「内容变了名字就变」，不是抗碰撞。
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `v${MODEL_ASSET_SET_VERSION}-${hash.toString(16).padStart(8, '0')}`;
}

/** 单个资产在指纹里的那一行 */
export function assetIdentityLine(assetId: ModelAssetId, asset: ModelAsset = MODEL_ASSETS[assetId]): string {
  return `${assetId}:${asset.path}:${asset.bytes}:${asset.sha256 ?? '-'}`;
}

/**
 * 这一档的资产集合指纹。
 *
 * ⚠️ 只取**内容身份**（id + 路径 + 字节数 + sha256），**不取构建号** ——
 * 构建号每次部署都变，会把「同源同内容」的缓存判成过期。
 * 它的职责是：只要同一档位下的字节换了，缓存身份就必须跟着换。
 */
export function modelAssetSetKey(tier: ModelTier): string {
  return fingerprintAssetSet(tierAssets(tier).map((id) => assetIdentityLine(id)).join('|'));
}

// ═══════════════════════════════════════════════════════════════
// 缓存身份
// ═══════════════════════════════════════════════════════════════

/** 模型资产的运行时缓存名前缀。`vite.config.ts` 的运行时路由按这个前缀匹配。 */
export const MODEL_CACHE_PREFIX = 'ocr-models';

/**
 * **缓存身份 = 档位名 + 资产集合指纹。**
 *
 * 为什么两者都要：
 * · **档位名** —— 不同档位产出的是不同的东西（版面模型参与与否），
 *   它们的资产缓存不能互相顶掉。只按目录分档（URL 相同）时，两者会命中
 *   同一份缓存，`fast` 档会读到 `standard` 档写下的东西。
 * · **资产集合指纹** —— 同一路径下的字节换了（换模型、换量化）时，
 *   缓存里那份必须被判为过期，而不是「路径一样就继续用」。
 *   这正是 CacheFirst 在**内容变了但路径没变**时的失效模式。
 *
 * ⚠️ `standard` 档**保持改动前的缓存名 `ocr-models`**：默认档位下
 * Cache Storage 里已有的那份不会被改名作废（不变量：默认档位行为不变）。
 */
export function modelCacheName(tier: ModelTier): string {
  if (tier === DEFAULT_MODEL_TIER) return MODEL_CACHE_PREFIX;
  return `${MODEL_CACHE_PREFIX}-${tier}-${modelAssetSetKey(tier)}`;
}

/**
 * 所有**历史**缓存名的形状（含当前默认档位的裸名）。
 *
 * 清理只在这个前缀里做，绝不碰 `html-navigation` / `pdfjs-wasm` /
 * `tess-assets` / `onnx-wasm` 与 Workbox 自己的 precache。
 */
export function isModelCacheName(name: string): boolean {
  return name === MODEL_CACHE_PREFIX || name.startsWith(`${MODEL_CACHE_PREFIX}-`);
}

// ═══════════════════════════════════════════════════════════════
// 模型根路径与 URL
// ═══════════════════════════════════════════════════════════════

/**
 * 同源模型根路径（与 `src/lib/ocrModelSource.ts` 的 `SELF_HOSTED_MODEL_BASE` 同值）。
 *
 * 这里重算而不是 import，是因为 `ocrModelSource.ts` 还带官方源 / 镜像源两份
 * 常量与三个 URL 构造函数，缓存层不需要它们。
 * `src/lib/modelCacheTiers.test.ts` 会把两者钉成同一个字符串。
 *
 * ⚠️ 刻意用字面量而不是 `import.meta.env.BASE_URL`：本模块被
 * `vite.config.ts` 直接 import（Node 侧求值），而 `ImportMeta.env` 只在
 * `vite/client` 的类型里存在 —— `pwaOffline.ts` 的 `html-navigation`
 * 也是同样的处理，理由一样。
 */
export const SELF_HOSTED_MODEL_ROOT = '/ocr-models';

/** 单个资产的完整 URL（档位不改 URL —— 见文件头「本文件不做的事」） */
export function modelAssetUrl(assetId: ModelAssetId, base = SELF_HOSTED_MODEL_ROOT): string {
  return `${base.replace(/\/+$/, '')}/${MODEL_ASSETS[assetId].path}`;
}

/** 这一档全部资产的 URL */
export function modelTierUrls(tier: ModelTier, base = SELF_HOSTED_MODEL_ROOT): string[] {
  return tierAssets(tier).map((id) => modelAssetUrl(id, base));
}

// ═══════════════════════════════════════════════════════════════
// 容量预检查（**必须在第一个字节下载之前**）
// ═══════════════════════════════════════════════════════════════

/**
 * Cloudflare Pages 单个静态资源上限：**25 MiB**。
 *
 * 官方原文："The maximum file size for a single Cloudflare Pages site asset
 * is 25 MiB."（https://developers.cloudflare.com/pages/platform/limits/ ）
 *
 * ⚠️ 为什么在**运行期**也要有这条：`scripts/verify-dist.mjs` 已经在构建后
 * 对产物逐文件查过一遍，但那个门禁看不见两件事 ——
 * （1）`VITE_OCR_MODEL_BASE` 把来源换成自建镜像后，取回的字节可能根本
 * 不是产物里那一份；（2）换档位引入的新资产**在本地 `dist/` 里查不到**。
 * 这两件事的共同表现都是「部署不上去 / 下到的东西不对」，而源码、类型、
 * 单元测试全绿。
 *
 * ⚠️ 构建期脚本用环境变量 `UR_MODEL_MAX_SINGLE_ASSET_BYTES` 覆盖它，
 * **只为让「预检查确实拦住了下载」这条断言可被真实执行**：
 * 把一个不会发生的超限情况造出来，比读到一段「看起来会拦」的代码可靠。
 * 浏览器里没人会设这个变量，所以运行期口径不变。
 */
export const MAX_SINGLE_ASSET_BYTES = 25 * 1024 * 1024;

/** 构建期脚本覆盖上限用的环境变量名（默认 25 MiB，见上） */
export const MAX_SINGLE_ASSET_BYTES_ENV = 'UR_MODEL_MAX_SINGLE_ASSET_BYTES';

/** 解析环境变量里的上限值；非法值一律忽略，回落到 25 MiB */
export function resolveMaxSingleAssetBytes(raw?: string): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : MAX_SINGLE_ASSET_BYTES;
}

export type PreflightReason =
  | 'ok'
  | 'single-file-over-limit'
  | 'insufficient-storage'
  | 'no-storage-api';

/**
 * 哪些结论**真的**该拦住下载。
 *
 * ⚠️ `no-storage-api` 是「查不了」而不是「不够」：浏览器没实现
 * `navigator.storage.estimate`、或调用抛错时都会落到这一档，
 * 而那种情况在真实用户里很常见。**查不了就不拦** —— 否则会出现
 * 「浏览器不给配额数字 ⇒ OCR 永远下不了模型」这种比不检查更糟的结果。
 */
export function preflightBlocksDownload(report: PreflightReport): boolean {
  return report.reason === 'single-file-over-limit' || report.reason === 'insufficient-storage';
}

export interface PreflightItem {
  readonly assetId: ModelAssetId;
  readonly path: string;
  readonly url: string;
  readonly bytes: number;
}

export interface PreflightReport {
  /** `true` = 可以开始下载 */
  readonly ok: boolean;
  readonly reason: PreflightReason;
  readonly tier: ModelTier;
  /** 本次需要下载的那些（未命中缓存的） */
  readonly items: readonly PreflightItem[];
  /** `items` 的字节合计 */
  readonly totalBytes: number;
  /** 判断用的原始数字，报告里要能逐项核对 */
  readonly numbers: {
    readonly maxSingleAssetBytes: number;
    /** `navigator.storage.estimate().usage`；不可用为 null */
    readonly estimatedUsage: number | null;
    /** `navigator.storage.estimate().quota`；不可用为 null */
    readonly estimatedQuota: number | null;
  };
  /** 给人看的一句话（含具体数字） */
  readonly detail: string;
}

export interface PreflightOptions {
  /** 已命中缓存、**不需要**再下载的资产（按请求 URL 比对） */
  readonly cachedKeys?: Iterable<string>;
  /** 已用字节（通常来自 `navigator.storage.estimate()`）；null = 未知 */
  readonly estimatedUsage?: number | null;
  /** 配额字节；null / undefined = 未知，此时**不拦**（宁可不拦，也不要误拦） */
  readonly estimatedQuota?: number | null;
  /** 覆盖单文件上限（构建期脚本用它对齐 25 MiB 这份口径） */
  readonly maxSingleAssetBytes?: number;
}

function bytesToMiB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

/**
 * 下载前的容量预检查。
 *
 * 判断用的两类数字，**逐项都能在报告里核对**：
 *   1. **单文件上限**（25 MiB）—— 逐个资产对照，任一超限即拦。
 *      这是硬约束：超限的资产**部署不上去**，本地构建与单元测试都不会报错。
 *   2. **站点配额**（`navigator.storage.estimate()` 的 usage / quota）——
 *      只在两个数字**都拿得到**时判。拿不到就不拦：宁可不拦，
 *      也不要因为浏览器没实现这个 API 就挡住 OCR。
 *
 * ⚠️ 语义边界：它只**判断**，不下载、不写盘、不抛异常。
 * 调用方（`ensureModelTierAssets`）负责在它返回 `ok: false` 时**一个字节都不取**。
 */
export function preflightModelTier(tier: ModelTier, options: PreflightOptions = {}): PreflightReport {
  const maxSingleAssetBytes = options.maxSingleAssetBytes ?? MAX_SINGLE_ASSET_BYTES;
  const estimatedUsage = options.estimatedUsage ?? null;
  const estimatedQuota = options.estimatedQuota ?? null;
  const cached = new Set(options.cachedKeys ?? []);

  const items: PreflightItem[] = tierAssets(tier)
    .map((assetId) => ({
      assetId,
      path: MODEL_ASSETS[assetId].path,
      url: modelAssetUrl(assetId),
      bytes: MODEL_ASSETS[assetId].bytes,
    }))
    .filter((item) => !cached.has(item.url));

  const numbers = { maxSingleAssetBytes, estimatedUsage, estimatedQuota };
  const totalBytes = items.reduce((sum, item) => sum + item.bytes, 0);

  // ① 单文件上限：逐个算，不只看合计
  for (const item of items) {
    if (item.bytes > maxSingleAssetBytes) {
      return {
        ok: false,
        reason: 'single-file-over-limit',
        tier,
        items,
        totalBytes,
        numbers,
        detail:
          `${item.path} 有 ${bytesToMiB(item.bytes)}，超过 Cloudflare Pages 的` +
          `单文件上限 ${bytesToMiB(maxSingleAssetBytes)}（用的是 25 MiB 口径）` +
          ` —— 这个资产**部署不上去**，本地构建与单元测试都不会报错`,
      };
    }
  }

  // ② 站点配额：两个数字都要有才判
  if (estimatedQuota === null || estimatedUsage === null) {
    return {
      ok: false,
      reason: 'no-storage-api',
      tier,
      items,
      totalBytes,
      numbers,
      detail:
        `浏览器没有给出配额数字（usage=${String(estimatedUsage)} / quota=${String(estimatedQuota)}）` +
        ` —— 不做判断，按原样继续`,
    };
  }

  const available = estimatedQuota - estimatedUsage;
  if (totalBytes > available) {
    return {
      ok: false,
      reason: 'insufficient-storage',
      tier,
      items,
      totalBytes,
      numbers,
      detail:
        `本档位还需要下载 ${bytesToMiB(totalBytes)}，而可用空间只有 ${bytesToMiB(Math.max(available, 0))}` +
        `（已用 ${bytesToMiB(estimatedUsage)} / 配额 ${bytesToMiB(estimatedQuota)}）`,
    };
  }

  return {
    ok: true,
    reason: 'ok',
    tier,
    items,
    totalBytes,
    numbers,
    detail:
      items.length === 0
        ? '所需资产已在缓存中，无需下载'
        : `可以下载 ${items.length} 个资产，合计 ${bytesToMiB(totalBytes)}（可用 ${bytesToMiB(available)}）`,
  };
}

/** 读浏览器的配额数字；拿不到就返回 null（**不抛**） */
export async function readStorageEstimate(): Promise<{
  usage: number | null;
  quota: number | null;
} | null> {
  try {
    const storage = storageQuotaManager();
    if (!storage?.estimate) return null;
    const { usage, quota } = await storage.estimate();
    return { usage: usage ?? null, quota: quota ?? null };
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// 旧档位清理
// ═══════════════════════════════════════════════════════════════

/**
 * 本模块真正用到的那一小撮 Cache Storage API。
 *
 * ⚠️ 刻意**不写成 `Pick<CacheStorage, …>`**：那样 `open()` 必须返回一个
 * 完整的 `Cache`（`add` / `addAll` / `keys` / `matchAll` / `delete` 一个都不能少），
 * 于是用例得造一个大半用不上的假对象 —— 而假的越厚，用例越容易在
 * 「造桩」这一步就写错，反而验不到要验的东西。
 * 这里只声明真正调用的四个方法，真 `CacheStorage` 结构上满足它。
 */
export interface ModelCacheStorage extends ModelCacheCleaner {
  open(cacheName: string): Promise<ModelCache>;
}

/** 清理只需要这两个方法（于是用例不必为它造一个 `open`） */
export interface ModelCacheCleaner {
  keys(): Promise<readonly string[]>;
  delete(cacheName: string): Promise<boolean>;
}

/**
 * 取值用结构类型读 `globalThis.caches`，避免依赖它的全局类型声明：
 * `vite.config.ts` 所在的编译目标没有 DOM lib（见 `StorageQuotaManager` 的说明）。
 */
function cacheStorageGlobal(): ModelCacheStorage | undefined {
  const holder = globalThis as unknown as { caches?: ModelCacheStorage };
  return holder.caches;
}

function storageQuotaManager(): StorageQuotaManager | undefined {
  const nav = globalThis as unknown as { navigator?: { storage?: StorageQuotaManager } };
  return nav.navigator?.storage;
}

export interface ModelCache {
  match(request: string): Promise<Response | undefined>;
  put(request: string, response: Response): Promise<void>;
}

export interface CleanupResult {
  readonly deleted: readonly string[];
  readonly kept: readonly string[];
}

/**
 * 清掉**不是当前档位**的模型缓存。
 *
 * 规则只有两条，但两条都必须对：
 *   1. **只留当前档位那一份**（`modelCacheName(tier)`），别的模型缓存全删 ——
 *      这就是「换档位时旧缓存要能清」；
 *   2. **只删模型缓存** —— `html-navigation` / `tess-assets` / `pdfjs-wasm`
 *      / `onnx-wasm` 与 Workbox 的 precache 都不属于本函数，
 *      误删它们等于把离线能力拆掉（而这一点在联网时**完全看不出来**）。
 *
 * ⚠️ 第 1 条为什么是「全删」而不是「留一份共用」：
 * 我原本想留下裸名 `ocr-models`（默认档位那份），理由是 fast 档也请求
 * 同样三个 OCR 文件、白删了要重下 30MB。**那个理由与本模块的读取契约矛盾**：
 * 运行时那条 CacheFirst 路由只认一个缓存名，按档位算出来的那一个
 * （`vite.config.ts` 的 `cacheName: modelCacheName(DEFAULT_MODEL_TIER)`）。
 * 也就是说 fast 档**根本不会去读**裸名那份 —— 留着它既不省任何下载，
 * 又让「缓存身份 = 当前档位」这句话变成假的。**按需求，宁可删干净。**
 *
 * 由此得到「升级 / 降级」的语义：
 * · 升级：新档位的缓存名与旧的不同 → 旧的那份在这里被清掉；
 * · 降级：同理，被清掉的是高档位那份；
 * · 同一档位内换了资产集合（指纹变）→ 旧指纹那份被清掉。
 *
 * ⚠️ **与 `--force` 的区别**（MinerU 的语义分离，见 `usage/tiers/`）：
 * 本函数是 `invalidate` —— 它**确实删除**旧结果。若只想「本次不吃旧缓存、
 * 但不删」，那是另一个动作，不要复用它。
 *
 * 任何失败都不上抛：清理是帮忙，不能反过来挡住加载模型。
 */
export async function cleanupStaleModelCaches(
  tier: ModelTier = DEFAULT_MODEL_TIER,
  storage: ModelCacheCleaner | undefined = cacheStorageGlobal(),
): Promise<CleanupResult> {
  if (!storage) return { deleted: [], kept: [] };

  const keep = modelCacheName(tier);

  try {
    const names = await storage.keys();
    const deleted: string[] = [];
    const kept: string[] = [];

    for (const name of names) {
      // 不属于模型资产的名字一律不动（它们是别的东西的家）
      if (!isModelCacheName(name)) continue;
      if (name === keep) {
        kept.push(name);
        continue;
      }
      await storage.delete(name);
      deleted.push(name);
    }
    return { deleted, kept };
  } catch (err) {
    console.warn('[modelCache] 旧档位缓存清理失败（不影响使用）：', err);
    return { deleted: [], kept: [] };
  }
}

/**
 * 两档的**文件集合**是否相同（只看路径，不看顺序）。
 *
 * ⚠️ 只看路径、不看字节数：字节数不同是「同一份资产的另一个版本」，
 * 那种情况应该各留各的（它们不会互相顶掉），而不是判成同一集合。
 */
export function sameAssetSet(a: ModelTier, b: ModelTier): boolean {
  const setA = new Set(tierAssetPaths(a));
  const setB = tierAssetPaths(b);
  return setA.size === setB.length && setB.every((path) => setA.has(path));
}

// ═══════════════════════════════════════════════════════════════
// 编排：预检查 → 清理 → 下载
// ═══════════════════════════════════════════════════════════════

export interface EnsureModelAssetsOptions {
  /** 取消（例如用户切了档位）：在每次 fetch 之前检查 */
  readonly signal?: AbortSignal;
  /** 注入用（测试）；默认 `globalThis.fetch` */
  readonly fetchImpl?: typeof fetch;
  /** 注入用（测试）；默认 `globalThis.caches` */
  readonly storage?: ModelCacheStorage;
  /** 注入用（测试）；默认 `readStorageEstimate` */
  readonly readEstimate?: () => Promise<{ usage: number | null; quota: number | null } | null>;
}

export interface EnsureModelAssetsResult {
  readonly tier: ModelTier;
  readonly cacheName: string;
  /** 预检查报告；`ok: false` 时 `downloaded` 必为空 */
  readonly preflight: PreflightReport;
  readonly downloaded: readonly string[];
  readonly failed: readonly string[];
  readonly cleaned: CleanupResult;
  /** SW 未接管 / 没有 Cache Storage —— 本次什么都没做 */
  readonly skipped: boolean;
}

/**
 * 让**当前档位**的模型资产就位。
 *
 * 三步，**顺序是契约**（不是实现细节）：
 *
 *   1. `cleanupStaleModelCaches` —— 先把别的档位腾开；
 *   2. `preflightModelTier` —— **在第一个字节被取之前**算清
 *      「单文件是否超 25 MiB」「配额够不够」；
 *   3. 逐项 `fetch` 并写进**本档位那份缓存**。
 *
 * 第 2 步失败时**一个字节都不下载**（`downloaded` 为空），
 * 并把判断用的数字原样带回给调用方 —— 这正是「必须在开始下载前做容量预检查」
 * 的可验收形态：可断言，而不是只能靠读代码相信。
 *
 * ⚠️ 写缓存时用 `cache: 'no-store'` 取、再用**不带 query 的请求**做键写入，
 * 这样运行时那条 CacheFirst 路由（`vite.config.ts` 的 `/ocr-models/`）
 * 在离线时能直接命中 —— 与 `pwaOffline.ts` 预置导航兜底是同一个手法。
 */
export async function ensureModelTierAssets(
  tier: ModelTier = DEFAULT_MODEL_TIER,
  options: EnsureModelAssetsOptions = {},
): Promise<EnsureModelAssetsResult> {
  const cacheName = modelCacheName(tier);
  const storage = options.storage ?? cacheStorageGlobal();

  if (!storage) {
    // SW 还没接管 / 没有 Cache Storage：什么都不做，交给运行时那条 CacheFirst 路由。
    // 这不是失败 —— 首次访问就是这个状态。
    return {
      tier,
      cacheName,
      preflight: preflightModelTier(tier, { estimatedUsage: null, estimatedQuota: null }),
      downloaded: [],
      failed: [],
      cleaned: { deleted: [], kept: [] },
      skipped: true,
    };
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  // ① 先把别的档位腾开（当前档位那份一定留着）
  const cleaned = await cleanupStaleModelCaches(tier, storage);

  const cache = await storage.open(cacheName);

  // 已有条目 → 不进本次下载清单（预检查只算真的缺的那些）
  const cachedKeys: string[] = [];
  for (const url of modelTierUrls(tier)) {
    if (await cache.match(url)) cachedKeys.push(url);
  }

  // ② 在取第一个字节之前把数字算清
  const readEstimate = options.readEstimate ?? readStorageEstimate;
  let estimatedUsage: number | null = null;
  let estimatedQuota: number | null = null;
  try {
    const numbers = await readEstimate();
    estimatedUsage = numbers?.usage ?? null;
    estimatedQuota = numbers?.quota ?? null;
  } catch {
    // 配额读失败等同于「查不了」，不拦
    estimatedUsage = null;
    estimatedQuota = null;
  }

  const preflight = preflightModelTier(tier, { cachedKeys, estimatedUsage, estimatedQuota });

  if (preflightBlocksDownload(preflight)) {
    console.warn(`[modelCache] 容量预检查拦住本次下载：${preflight.detail}`);
    return { tier, cacheName, preflight, downloaded: [], failed: [], cleaned, skipped: false };
  }

  // ③ 逐项下载并写进**本档位那份缓存**
  const downloaded: string[] = [];
  const failed: string[] = [];

  for (const item of preflight.items) {
    if (options.signal?.aborted) break;
    try {
      // `no-store`：绕开 HTTP 缓存，确保拿到的是服务器上那一份
      const response = await fetchImpl(item.url, { cache: 'no-store', signal: options.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      // 用不带 query 的请求做键写入 —— 运行时 CacheFirst 路由才会命中它
      await cache.put(item.url, response.clone());
      downloaded.push(item.url);
    } catch (err) {
      // 单个失败不中断：运行时那次请求还会再取一遍
      failed.push(item.url);
      console.warn(`[modelCache] 资产下载失败（运行时会再试一次）：${item.url}`, err);
    }
  }

  return { tier, cacheName, preflight, downloaded, failed, cleaned, skipped: false };
}
