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
