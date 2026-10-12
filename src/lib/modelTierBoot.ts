/**
 * 启动路径上的「模型资产就位」：**谁决定档位** + **结果留给谁看**。
 *
 * ═══════════════════════════════════════════════════════════════
 * 这个文件补的是哪一环
 * ═══════════════════════════════════════════════════════════════
 *
 * `src/lib/modelCacheTiers.ts` 已经把「缓存身份 / 容量预检查 / 旧档位清理」
 * 实现齐了（`ensureModelTierAssets`），但它**没有任何运行时调用点** ——
 * 也就是说那三条能力此前只在构建期与单元测试里成立，用户机器上一次都没跑过。
 *
 * 接线点选在**「用户第一次表达 OCR 意图」**那一刻 ——
 * `src/store/libraryStore.ts` 的 `startOcr()` 里一行
 * `void bootModelTierAssets();`（「开始识别」按钮的唯一出口）。
 *
 * ⚠️ 它**曾经**接在 `src/lib/pwa.ts` 的 `useRegisterSW({ onRegisteredSW })` 里，
 * 与 `seedNavigationFallback()` 并列。那个位置的后果是 **SW 一注册就预取
 * 34.59 MiB**，哪怕用户只读 md/txt/epub、从不打开扫描件 —— 对一个阅读器
 * 来说那是首访时替用户花的钱，也与本项目「**不预缓存模型**」的口径冲突
 * （构建期不预取、运行时 CacheFirst，见 `HANDOFF.md` §1 T1）。
 * 因此那次调用已连同它的 import 一起从 `pwa.ts` 移除，且**不许搬回去**：
 * `modelTierBoot.test.ts` 有一组用例同时钉住「`pwa.ts` 不再碰模型资产」
 * 与「`startOcr()` 真的调用了它」。
 *
 * 为什么不把这几行直接写在调用点（而是单独成文件）：
 * 与 `pwaOffline.ts` 同一个理由 —— 调用点所在的模块
 * （`pwa.ts` 顶层 import 了 `virtual:pwa-register/react`，那个虚拟模块只在
 * Vite 构建/开发时存在，vitest 里解析不了；`libraryStore.ts` 则拖着
 * IndexedDB 与解析器）都不是测试能轻松加载的东西。于是「档位怎么推出来」
 * 「结果怎么记下来」这些**真正会出错的部分**放进本文件，测试直接引用。
 *
 * ═══════════════════════════════════════════════════════════════
 * 三条硬约束（本文件的存在理由）
 * ═══════════════════════════════════════════════════════════════
 *
 * 1. **默认档位下行为与改动前逐字节相同**。默认档位是 `standard`，
 *    它的缓存名仍是裸 `ocr-models`、四个资产 URL 一个都没变
 *    （`modelCacheName` 的不变量）。本文件不碰这些值，只调用它们。
 *
 * 2. **不许把应用弄挂**。启动路径上的任何失败都只能变成一条记录：
 *    · 预检查拦住 ⇒ 一个字节都不取，应用照常启动；
 *    · 拿不到存储配额 ⇒ **不拦**（查不了 ≠ 不够，见 `preflightBlocksDownload`）；
 *    · 清理失败 ⇒ `cleanupStaleModelCaches` 内部已只告警不上抛；
 *    · `ensureModelTierAssets` 本身抛异常 ⇒ 本文件兜住（**这一步不是多余的**：
 *      它内部的 `storage.open()` 与 `cache.match()` 并没有包 try/catch，
 *      浏览器在配额耗尽 / SecurityError 时确实会从这里抛出来）。
 *
 * 3. **必须能观测**。本项目反复吃过「诊断信息写进 `console.warn` 等于没写」的亏
 *    （用户多半在手机 / iOS Safari 上，那里没有 DevTools）。所以每次运行都留下
 *    一条 **`ModelTierBootReport`**：
 *    · `getModelTierBootRecord()` —— 进程内可读，`useSyncExternalStore` 可订阅；
 *    · `sessionStorage` 的 `universal-reader:model-tier-boot` —— **刷新不清**，
 *      于是「上一次启动跑没跑、结果是什么」在新页面里还看得到；
 *    · `renderModelTierBootReport()` —— 可复制的逐项报告（含判断用的原始数字）；
 *    · `DocumentLibrary` 的横幅 —— 只有「值得让人知道」的结果才显示，正常路径不打扰。
 *
 * ⚠️ 与「首次访问」的关系：接线之后**首访不再预取任何模型资产**。
 * 那 34.59 MiB 只在用户第一次按下「开始识别」时才取（`startOcr()`）；
 * 在那之前 `getModelTierBootRecord()` 就是 `null`，含义是
 * 「用户还没有表达过 OCR 意图」。已缓存时 `ensureModelTierAssets` 只做
 * `match()`，**不会重下** —— 所以第二次识别不会再把 34.59 MiB 下一遍。
 */

import { describeUnknownError } from '@/lib/diagnostics';
import { isLayoutAnalysisEnabled } from '@/lib/layoutAnalysis';
import {
  DEFAULT_MODEL_TIER,
  MODEL_TIER_SPECS,
  ensureModelTierAssets,
  modelCacheName,
  preflightBlocksDownload,
  type EnsureModelAssetsOptions,
  type EnsureModelAssetsResult,
  type ModelTier,
  type PreflightReason,
} from '@/lib/modelCacheTiers';

// ═══════════════════════════════════════════════════════════════
// 档位怎么推出来（不是用户选的）
// ═══════════════════════════════════════════════════════════════

/**
 * 档位的输入：**版面模型这一档能不能用**。
 *
 * 这是启动时刻唯一能拿到、又不用真去把模型加载一遍的判据 ——
 * 「能不能真的建起 ONNX 会话」只有取回 4.69 MiB 之后才知道，
 * 而那件事恰恰是本次要预取的**结果**，不能拿它当前提。
 */
export interface LayoutCapability {
  readonly layoutModel: boolean;
}

/**
 * 能力 → 档位。
 *
 * ⚠️ 映射只有两条，但**两条都必须对**：
 *   · 版面模型可用 ⇒ `DEFAULT_MODEL_TIER`（`standard`，= 改动前那一套资产）；
 *   · 不可用 ⇒ `fast`，**不请求版面模型**（省 4.69 MiB），页眉页脚与多栏顺序
 *     回到接入版面模型之前的几何启发式 —— 那正是这一档的语义。
 *
 * 写成一个函数而不是在调用点写 `condition ? 'standard' : 'fast'`，
 * 是为了让「关掉版面模型之后到底走哪一档」这件事**有唯一真源、且可被断言**
 * （见 `modelTierBoot.test.ts`：换档位后缓存名与请求的 URL 都会跟着变）。
 */
export function resolveQualityTier(capability: LayoutCapability): ModelTier {
  return capability.layoutModel ? DEFAULT_MODEL_TIER : 'fast';
}

/**
 * 本机的版面分析能力（启动时刻）。
 *
 * 用 `isLayoutAnalysisEnabled()`（`VITE_OCR_LAYOUT` 构建期开关）而不是
 * `loadLayoutSession()`：后者会**真的去取 4.69 MiB 并建 ONNX 会话**，
 * 而在启动时那是本末倒置 —— 我们要预取的正是它。
 *
 * 刻意**不在这里重新读一遍环境变量**：开关的语义只能有一份真源，
 * 抄一份到这里就会漂移，而漂移的表现是「关了版面模型却仍然下 4.69 MiB」。
 */
export function detectLayoutCapability(): LayoutCapability {
  return { layoutModel: isLayoutAnalysisEnabled() };
}

// ═══════════════════════════════════════════════════════════════
// 记录：**这就是「怎么看出来它跑了没有」的答案**
// ═══════════════════════════════════════════════════════════════

/**
 * 记录存在 `sessionStorage` 的哪个键下。
 *
 * 用 `sessionStorage` 而不是 `localStorage`，与 `sessionDiagnostics` 同一口径：
 * 它要回答的是「**这一次会话**里它跑了没有、结果是什么」，
 * 刷新不清（`autoUpdate` 会无预警刷新页面，内存里那份记录会丢），
 * 关掉标签页即清（下一次打开会重新跑一遍，旧结论没有意义）。
 */
export const MODEL_TIER_BOOT_KEY = 'universal-reader:model-tier-boot';

export type ModelTierBootOutcome =
  /** 预检查通过，缺的资产已按清单取回（个别失败见 `failed`） */
  | 'ok'
  /** 预检查拦住：**一个字节都没取**，`downloaded` 必为空 */
  | 'blocked'
  /** 没做事：没有 Cache Storage（非安全上下文 / SW 未接管）或当前离线 */
  | 'skipped'
  /** 编排过程本身抛了异常（已兜住，应用不受影响） */
  | 'error';

export interface ModelTierBootNumbers {
  readonly maxSingleAssetBytes: number;
  readonly estimatedUsage: number | null;
  readonly estimatedQuota: number | null;
}

/**
 * 一次「模型资产就位」的完整结论。
 *
 * ⚠️ 刻意把判断用的**原始数字**（单文件上限、usage / quota）与**逐项 URL 清单**
 * 一起带出来：只写一句「准备失败」等于没写 —— 用户拿它来反馈时，
 * 我们没法从里面反推出是哪一类失败。
 */
export interface ModelTierBootReport {
  /** 记录时刻（`Date.now()`；测试可注入） */
  readonly at: number;
  readonly tier: ModelTier;
  /** 用户可见的档位名（界面上照这个写） */
  readonly tierLabel: string;
  /** 档位是**能力推出来的**还是被调用点显式指定的 —— 排障时这两者要能分开 */
  readonly tierSource: 'capability' | 'explicit';
  /** 本次写入 / 读取的缓存身份（默认档位下就是裸名 `ocr-models`） */
  readonly cacheName: string;
  readonly outcome: ModelTierBootOutcome;
  /** 给人看的一句话（含具体数字），界面直接显示它 */
  readonly detail: string;
  /** `outcome === 'error'` 时的原始异常文本；其余情况为 null */
  readonly error: string | null;
  /** 预检查的结论与数字；`skipped` / `error` 时可能为 null */
  readonly preflight: {
    readonly ok: boolean;
    readonly reason: PreflightReason;
    readonly totalBytes: number;
    readonly numbers: ModelTierBootNumbers;
  } | null;
  /** 本次判定**需要下载**的资产 URL */
  readonly needUrls: readonly string[];
  readonly downloaded: readonly string[];
  readonly failed: readonly string[];
  /** 被清掉的**旧档位**缓存名（换档位 / 资产集合变了才会有） */
  readonly cleaned: readonly string[];
}

/** 记录落盘用的最小接口（结构类型：测试直接喂内存实现，不依赖 DOM 类型） */
export interface TierBootStorageArea {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * 取值一律走 `globalThis` + try/catch。
 *
 * ⚠️ 两条都要：
 *   · `globalThis` 而不是 `window` —— vitest 跑在 node 环境，没有 `window`；
 *   · try/catch —— 隐私模式 / 禁用存储时属性访问本身就可能抛，
 *     而诊断记录**永远不该把启动路径弄挂**。
 */
function storageArea(): TierBootStorageArea | null {
  try {
    const holder = globalThis as unknown as { sessionStorage?: TierBootStorageArea };
    return holder.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function readPersisted(): ModelTierBootReport | null {
  const area = storageArea();
  if (!area) return null;
  try {
    const raw = area.getItem(MODEL_TIER_BOOT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ModelTierBootReport;
    if (!parsed || typeof parsed.tier !== 'string' || typeof parsed.outcome !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * 进程内那一份（`useSyncExternalStore` 要求快照**引用稳定**，
 * 所以落盘那份解析一次就缓存下来，不能每次 `getItem` + `JSON.parse` 出个新对象）。
 */
let cached: ModelTierBootReport | null = null;

const listeners = new Set<(report: ModelTierBootReport) => void>();

/**
 * 最近一次「模型资产就位」的结论。
 *
 * 返回 `null` 只有一种含义：**本次会话里它一次都没跑过**（也没有上一轮的记录）。
 * 这正是「怎么看出它跑了没有」的判据 —— 不需要控制台。
 */
export function getModelTierBootRecord(): ModelTierBootReport | null {
  if (cached) return cached;
  cached = readPersisted();
  return cached;
}

/** 订阅启动结论（界面用 `useSyncExternalStore` 接它）；返回退订函数 */
export function subscribeModelTierBoot(listener: (report: ModelTierBootReport) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 仅供测试：清掉进程内那份（**不清**存储 —— 落盘读取本身就是被测行为） */
export function resetModelTierBootRecordForTest(): void {
  cached = null;
}

/**
 * 这个结论值不值得**打扰用户**。
 *
 * 刻意收得很紧：正常路径（预检查通过、没有资产下载失败、没有旧缓存被清）
 * 一条都不显示 —— 每次打开都弹一个「一切正常」的横幅会让用户学会无视横幅，
 * 而那时真正的警告也就看不见了。安静不等于没有记录：
 * `getModelTierBootRecord()` / `sessionStorage` / `renderModelTierBootReport()`
 * 在任何情况下都拿得到完整结论（包括「已缓存，无需下载」这一次）。
 *
 * 会显示的四类：
 *   · `blocked` —— 预检查拦住了下载，用户此刻**离线用不了 OCR**，必须知道；
 *   · `error`   —— 编排抛了异常（已兜住），我们想知道；
 *   · 有资产下载失败 —— 同上；
 *   · 清掉过旧档位缓存 —— 解释了「为什么模型要重新下」，是信息不是错误。
 *
 * ⚠️ `skipped` **不算**：没有 Cache Storage（非安全上下文）是同源部署问题，
 * 界面上另有「已可离线使用」那套提示；而**离线时跳过**更不该报警 ——
 * 那会把「你现在没网」变成一条吓人的模型错误。
 */
export function modelTierBootNoteworthy(report: ModelTierBootReport | null): boolean {
  if (!report) return false;
  if (report.outcome === 'blocked' || report.outcome === 'error') return true;
  return report.failed.length > 0 || report.cleaned.length > 0;
}

/** 横幅标题（与 `modelTierBootNoteworthy` 的四类一一对应） */
export function modelTierBootBannerTitle(report: ModelTierBootReport): string {
  if (report.outcome === 'blocked') return '离线模型资产没有准备好：容量预检查拦住了下载';
  if (report.outcome === 'error') return '离线模型资产没有准备好：检查过程出错了（已跳过）';
  if (report.failed.length > 0) return `有 ${report.failed.length} 个模型资产没能下载`;
  if (report.cleaned.length > 0) return '已清理旧档位留下的模型缓存';
  return '模型资产就位情况';
}

function mib(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

/**
 * 可复制的逐项报告 —— 「复制给开发者」的那个出口。
 *
 * 判据是 `null` 也要有明确说法：**「没有记录」本身就是一条结论**
 * （它没跑过），不能返回空串让人猜。
 */
export function renderModelTierBootReport(report: ModelTierBootReport | null = getModelTierBootRecord()): string {
  if (!report) {
    return [
      '模型资产就位：**本会话没有记录** —— 说明它一次都没跑过',
      '（正常启动时，Service Worker 注册成功后会跑一次；记录写在 sessionStorage 的',
      `  ${MODEL_TIER_BOOT_KEY} 里）`,
    ].join('\n');
  }

  const lines: string[] = ['模型资产就位（modelTierBoot）'];
  lines.push(`  · 档位：${report.tierLabel}（${report.tier}，来源：${report.tierSource === 'capability' ? '能力检测' : '调用点指定'}）`);
  lines.push(`  · 缓存身份：${report.cacheName}`);
  lines.push(`  · 结论：${report.outcome} —— ${report.detail}`);
  if (report.error) lines.push(`  · 异常：${report.error}`);

  if (report.preflight) {
    const { reason, ok, totalBytes, numbers } = report.preflight;
    lines.push(
      `  · 预检查：reason=${reason} / 放行=${ok} / 本次需要下载 ${report.needUrls.length} 个` +
        `（合计 ${totalBytes} 字节 = ${mib(totalBytes)}）`,
    );
    lines.push(
      `  · 判断用的数字：单文件上限 ${numbers.maxSingleAssetBytes} 字节；` +
        `已用 ${numbers.estimatedUsage ?? '未知'} 字节 / 配额 ${numbers.estimatedQuota ?? '未知'} 字节`,
    );
  } else {
    lines.push('  · 预检查：没有跑到（本次没有做下载判断）');
  }

  const list = (label: string, items: readonly string[]) =>
    lines.push(`  · ${label}（${items.length}）：${items.length ? items.join('、') : '—'}`);

  list('需要下载', report.needUrls);
  list('已下载', report.downloaded);
  list('下载失败', report.failed);
  list('清掉的旧档位缓存', report.cleaned);
  lines.push(`  · 时间：${new Date(report.at).toISOString()}`);
  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════
// 编排：能力 → 档位 → 预检查 / 清理 / 下载 → 记录
// ═══════════════════════════════════════════════════════════════

export interface BootModelTierOptions extends EnsureModelAssetsOptions {
  /** 能力检测结果；默认 `detectLayoutCapability()`（读 `VITE_OCR_LAYOUT`） */
  readonly capability?: LayoutCapability;
  /** 显式指定档位（测试用；将来的用户可见档位开关也走这里） */
  readonly tier?: ModelTier;
  /** 注入时间；默认 `Date.now` */
  readonly now?: () => number;
  /** 注入在线判定；默认读 `navigator.onLine`（**拿不到就当作在线**） */
  readonly isOnline?: () => boolean;
}

/**
 * 在线判定。
 *
 * ⚠️ 口径与 `preflightBlocksDownload` 的 `no-storage-api` 一致：**拿不到就当没事**。
 * 只有浏览器**明确说**离线（`onLine === false`）时才跳过，
 * 因为「以为自己离线」比「以为自己在线」代价小得多。
 */
function defaultIsOnline(): boolean {
  try {
    const holder = globalThis as unknown as { navigator?: { onLine?: boolean } };
    return holder.navigator?.onLine !== false;
  } catch {
    return true;
  }
}

const OFFLINE_DETAIL =
  '当前离线 —— 本次不预取模型资产（联网后由运行时的 CacheFirst 路由按需取，' +
  '不会因为这次跳过而少拿任何东西）';

const NO_STORAGE_DETAIL =
  '没有 Cache Storage（非安全上下文，或 Service Worker 还没接管）—— ' +
  '本次不预取模型资产，交给运行时的 CacheFirst 路由按需取';

function reportOf(
  result: EnsureModelAssetsResult,
  where: { readonly tier: ModelTier; readonly tierSource: 'capability' | 'explicit'; readonly at: number },
): ModelTierBootReport {
  const preflight = result.preflight;
  const outcome: ModelTierBootOutcome = result.skipped
    ? 'skipped'
    : preflightBlocksDownload(preflight)
      ? 'blocked'
      : 'ok';

  return {
    at: where.at,
    tier: where.tier,
    tierLabel: MODEL_TIER_SPECS[where.tier].label,
    tierSource: where.tierSource,
    cacheName: result.cacheName,
    outcome,
    detail: result.skipped ? NO_STORAGE_DETAIL : preflight.detail,
    error: null,
    preflight: {
      ok: preflight.ok,
      reason: preflight.reason,
      totalBytes: preflight.totalBytes,
      numbers: preflight.numbers,
    },
    needUrls: preflight.items.map((item) => item.url),
    downloaded: [...result.downloaded],
    failed: [...result.failed],
    cleaned: [...result.cleaned.deleted],
  };
}

function publish(report: ModelTierBootReport): void {
  cached = report;

  const area = storageArea();
  if (area) {
    try {
      area.setItem(MODEL_TIER_BOOT_KEY, JSON.stringify(report));
    } catch {
      // 存储不可用（隐私模式 / 配额满）就放弃落盘：进程内那份仍然拿得到
    }
  }

  // 订阅者抛错不许带走启动路径，也不许挡住后面的订阅者
  for (const listener of [...listeners]) {
    try {
      listener(report);
    } catch {
      /* 单个订阅者的问题，不上抛 */
    }
  }

  /*
   * 控制台只是**副本**，不是记录本身。
   *
   * 留着它是因为排障时它最省事（开发者一打开 DevTools 就看到结论），
   * 但它的信息量与上面那条报告完全相同 —— 之所以不再像以前那样
   * 「只写 console」，是因为用户没有控制台（见文件头第 3 条）。
   */
  const line = `[modelTierBoot] ${report.tierLabel}档（${report.cacheName}）→ ${report.outcome}：${report.detail}`;
  if (report.outcome === 'blocked' || report.outcome === 'error' || report.failed.length > 0) {
    console.warn(line);
  } else {
    console.info(line);
  }
}

/**
 * 把**当前档位**的模型资产就位，并留下一条可读的结论。**永不 reject。**
 *
 * 这是**「用户第一次表达 OCR 意图」时调用的那一个**
 * （`src/store/libraryStore.ts` 的 `startOcr()` 里 `void bootModelTierAssets();`）：
 * 不 await、不参与任何判定，任何结果都只变成 `ModelTierBootReport`。
 *
 * 顺序由 `ensureModelTierAssets` 保证（清理 → 预检查 → 下载），
 * 本函数**只做三件它会漏掉的事**：
 *   1. 决定档位（能力 → `resolveQualityTier`）；
 *   2. 离线时干脆不跑（否则 4 个资产全部下载失败，界面会报一条假警）；
 *   3. 兜住异常并记录结论 —— `ensureModelTierAssets` 的 `storage.open()` /
 *      `cache.match()` 没有包 try/catch，配额耗尽时真的会抛。
 */
export async function bootModelTierAssets(
  options: BootModelTierOptions = {},
): Promise<ModelTierBootReport> {
  const now = options.now ?? Date.now;
  const at = now();
  const tierSource: 'capability' | 'explicit' = options.tier ? 'explicit' : 'capability';
  const tier = options.tier ?? resolveQualityTier(options.capability ?? detectLayoutCapability());

  let report: ModelTierBootReport;

  if (!(options.isOnline ?? defaultIsOnline)()) {
    report = {
      at,
      tier,
      tierLabel: MODEL_TIER_SPECS[tier].label,
      tierSource,
      cacheName: modelCacheName(tier),
      outcome: 'skipped',
      detail: OFFLINE_DETAIL,
      error: null,
      preflight: null,
      needUrls: [],
      downloaded: [],
      failed: [],
      cleaned: [],
    };
  } else {
    try {
      report = reportOf(await ensureModelTierAssets(tier, options), { tier, tierSource, at });
    } catch (err) {
      const text = describeUnknownError(err);
      report = {
        at,
        tier,
        tierLabel: MODEL_TIER_SPECS[tier].label,
        tierSource,
        cacheName: modelCacheName(tier),
        outcome: 'error',
        detail: `模型资产就位过程中抛出异常（已兜住，不影响使用）：${text}`,
        error: text,
        preflight: null,
        needUrls: [],
        downloaded: [],
        failed: [],
        cleaned: [],
      };
    }
  }

  publish(report);
  return report;
}
