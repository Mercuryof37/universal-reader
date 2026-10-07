/**
 * 会话级诊断信息：**记录「页面被刷新了几次」和「上次识别进行到哪一页」**。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么需要它
 * ═══════════════════════════════════════════════════════════════
 *
 * 用户报的现象是「扫描完看不到文档、书库里也没有条目」，而且
 * **打不开控制台**（很可能是在手机 / iOS Safari 上，那里根本没有 DevTools）。
 *
 * 这种情况下最关键的两个问题都无法回答：
 *   1. 页面到底有没有被自动刷新？刷新了几次？
 *   2. 如果刷新了，当时识别跑到第几页？
 *
 * 所以把这两件事记进 `sessionStorage`（**刷新不会清空，关标签页才清**），
 * 再由界面**直接显示出来**。这样不需要控制台也能判断故障形态：
 *   - 刷新次数 > 1 → 页面确实在被反复重载，问题在重载而不是识别；
 *   - 记到「第 N 页中断」→ 重载发生在识别途中，且能看出跑到多远；
 *   - 两者都没有 → 页面没重载，问题在识别本身或入库环节。
 *
 * 一律用 try/catch 包住：隐私模式 / 禁用存储时 `sessionStorage`
 * 可能直接抛异常，而**诊断信息永远不该把主流程弄挂**。
 */

const RELOAD_KEY = 'universal-reader:reload-count';
const OCR_KEY = 'universal-reader:ocr-attempt';
const REASON_KEY = 'universal-reader:reload-reason';
const STAGE_KEY = 'universal-reader:ocr-stage';

/** 超过这个时长就不再提示上次中断 —— 避免几天前的记录一直挂在界面上 */
const STALE_MS = 30 * 60 * 1000;

function read(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // 存储不可用就放弃记录，绝不影响正常使用
  }
}

function remove(key: string): void {
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* 同上 */
  }
}

/**
 * 记一次页面加载，返回这是本会话的第几次。
 *
 * 在 `main.tsx` 里、React 挂载之前调用，所以它统计的是**真实的页面加载次数**，
 * 而不是某次组件渲染。第 1 次是正常打开，> 1 就说明页面被重载过。
 */
export function bumpReloadCount(): number {
  const next = Number(read(RELOAD_KEY) ?? '0') + 1;
  write(RELOAD_KEY, String(Math.max(1, next)));
  return Math.max(1, next);
}

/** 本会话内页面已被加载的次数（1 = 从未额外刷新） */
export function getReloadCount(): number {
  return Number(read(RELOAD_KEY) ?? '1') || 1;
}

/** 识别过程中不断记下进度；页面若被刷新，这条记录会留下 */
export interface OcrAttempt {
  pageNum: number;
  total: number;
  at: number;
}

export function noteOcrProgress(pageNum: number, total: number): void {
  write(OCR_KEY, JSON.stringify({ pageNum, total, at: Date.now() }));
}

/** 识别正常收尾时清掉记录 —— 否则下一次打开会误报「上次中断了」 */
export function clearOcrAttempt(): void {
  remove(OCR_KEY);
}

/**
 * 上次识别是否「开始了但没走完」。
 *
 * 只在记录较新时才返回 —— 否则用户几天后打开应用会看到一条莫名其妙的旧提示。
 */
export function getInterruptedOcr(): OcrAttempt | null {
  const raw = read(OCR_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as OcrAttempt;
    if (typeof parsed?.pageNum !== 'number' || typeof parsed?.total !== 'number') return null;
    if (Date.now() - (parsed.at ?? 0) > STALE_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * 重载原因。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么必须记这个
 * ═══════════════════════════════════════════════════════════════
 *
 * 代码里只有三处会重载页面：SW 新版本接管（`pwa.ts`）、
 * chunk 加载失败的自愈（`preloadRecovery.ts`）、以及用户点「立即刷新」。
 * 如果这些都记下来，那么「页面被刷新了」就能立刻区分成：
 *   · 是我这三条路径之一干的（能进一步知道是哪条、当时忙不忙）；
 *   · **哪条都没记 → 刷新不是应用发起的**，那就是浏览器自身
 *     （内存不足回收标签页最典型），此时再怎么改应用逻辑都没用，
 *     必须去降内存占用。
 *
 * 这个区分是靠猜做不到的，而用户又没有控制台可看 —— 所以写进存储、显示在界面上。
 */
export type ReloadReason = 'sw-update' | 'preload-error' | 'manual';

const REASON_LABEL: Record<ReloadReason, string> = {
  'sw-update': '应用检测到新版本并自动刷新（SW 接管）',
  'preload-error': '应用检测到资源加载失败并自动刷新（chunk 自愈）',
  manual: '你点了「立即刷新」',
};

/** 在**真正调用 reload 之前**记下原因 */
export function noteReloadReason(reason: ReloadReason): void {
  write(REASON_KEY, JSON.stringify({ reason, at: Date.now() }));
}

/** 读取上次重载的原因；没有记录说明刷新不是应用发起的 */
export function getLastReloadReason(): { label: string; at: number } | null {
  const raw = read(REASON_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { reason: ReloadReason; at: number };
    if (Date.now() - (parsed.at ?? 0) > STALE_MS) return null;
    return { label: REASON_LABEL[parsed.reason] ?? parsed.reason, at: parsed.at };
  } catch {
    return null;
  }
}

/**
 * OCR 的阶段性里程碑（保留最近若干条）。
 *
 * 内存不足 / 进程被回收时**不会留下任何 JS 痕迹**（没有异常、没有日志），
 * 所以只能靠「最后走到哪一步」反推它死在哪里：
 *   · 死在 render 之前/之中 → 画布太大
 *   · 死在 recognize 之中   → 推理阶段（显存 / 内存 / 后端）
 *   · 死在 save 之后        → 与内存无关，是别的问题
 *
 * **保留多条**而不是只留最后一条：画布尺寸是在 `render` 阶段记的，
 * 一旦被后一条 `recognize` 覆盖，就再也看不到「当时到底是多大的画布」了 ——
 * 那正是判断要不要继续砍内存的关键数字（这个坑已经踩过一次）。
 */
const STAGE_HISTORY = 5;

export function noteOcrStage(stage: string, detail?: string): void {
  const history = getOcrStageHistory();
  history.push({ stage, detail, at: Date.now() });
  write(STAGE_KEY, JSON.stringify(history.slice(-STAGE_HISTORY)));
}

function getOcrStageHistory(): { stage: string; detail?: string; at?: number }[] {
  const raw = read(STAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    // 兼容早期只存单条对象的格式
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object') return [parsed];
    return [];
  } catch {
    return [];
  }
}

/** 最近一次记录的阶段（用于「中断前最后走到」） */
export function getLastOcrStage(): { stage: string; detail?: string } | null {
  const history = getOcrStageHistory();
  const last = history[history.length - 1];
  if (!last) return null;
  if (typeof last.at === 'number' && Date.now() - last.at > STALE_MS) return null;
  return { stage: last.stage, detail: last.detail };
}

/** 完整的阶段轨迹，按时间先后 —— 界面会把它们列出来 */
export function getOcrStageTrail(): { stage: string; detail?: string }[] {
  const history = getOcrStageHistory();
  const fresh = history.filter((h) => typeof h.at !== 'number' || Date.now() - h.at <= STALE_MS);
  return fresh.map((h) => ({ stage: h.stage, detail: h.detail }));
}

/** 识别正常收尾时一并清掉阶段记录 */
export function clearOcrStage(): void {
  remove(STAGE_KEY);
}
