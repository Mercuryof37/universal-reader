/**
 * 处理「动态 import 的 chunk 加载失败」。
 *
 * ═══════════════════════════════════════════════════════════════
 * 这是什么问题，为什么会发生
 * ═══════════════════════════════════════════════════════════════
 *
 * 用户看到的报错：
 *
 *     有 1 个文件未能导入：
 *     习题5-10月19日交(1).pdf：Failed to fetch dynamically imported module:
 *     https://universal-reader.pages.dev/assets/pdfParser-CiRxJgol.js
 *
 * 原因是**旧页面去找新资源**：页面还是上一次构建的 index.html，
 * 它引用 `pdfParser-CiRxJgol.js`；而站点已经重新部署，
 * 那个哈希的文件在服务器上不存在了 —— 于是按需加载的解析器炸掉。
 *
 * 症状极具迷惑性：**页面本身正常、md/txt 也能导入，只有按需加载的
 * pdf/epub 解析器会失败**，所以很容易被当成"这个 PDF 有问题"。
 *
 * ── 两道防线 ──
 *
 * 1. **根因修复在 vite.config.ts**：导航请求改为 NetworkFirst，
 *    在线时始终取最新的 index.html，从源头消除错配。
 * 2. **本文件是兜底**：即便因为浏览器缓存、CDN 边缘节点、或用户
 *    长时间开着旧标签页而仍然发生错配，也要能**自愈**而不是报错给用户。
 *
 * 兜底策略：发现 chunk 加载失败 → 重新加载页面（拿到最新 HTML）→
 * 如果刷新后依然失败，说明不是版本错配，此时才提示用户。
 */

/** 会话级标记：避免"刷新 → 又失败 → 又刷新"的死循环 */
const RELOAD_FLAG = 'universal-reader:chunk-reload';

/** 判断当前是否处于"已经重试过一次"的状态 */
function hasReloaded(): boolean {
  try {
    return sessionStorage.getItem(RELOAD_FLAG) === '1';
  } catch {
    // 隐私模式下 sessionStorage 可能不可用；此时保守地认为已重试过，
    // 宁可少刷新一次，也不要冒无限刷新的风险
    return true;
  }
}

function markReloaded(): void {
  try {
    sessionStorage.setItem(RELOAD_FLAG, '1');
  } catch {
    // 忽略：标记失败只会导致下次不自动刷新，不会造成危害
  }
}

/**
 * 清除标记。
 *
 * 页面成功加载后调用 —— 这样"上一次会话发生过错配"不会影响
 * 用户后续的正常刷新。放在模块顶层执行即可：能跑到这里就说明
 * 入口 chunk 本身加载成功了。
 */
function clearReloadFlag(): void {
  try {
    sessionStorage.removeItem(RELOAD_FLAG);
  } catch {
    // 忽略
  }
}

/** 判定错误是否是 chunk 加载失败 */
export function isChunkLoadError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : typeof error === 'string'
        ? error
        : '';
  const lower = message.toLowerCase();

  return (
    lower.includes('failed to fetch dynamically imported module') ||
    lower.includes('error loading dynamically imported module') ||
    lower.includes('importing a module script failed') ||
    // 部分浏览器在 chunk 404 时给出的是通用的网络错误
    (lower.includes('dynamically imported module') && lower.includes('fetch'))
  );
}

/**
 * 装配自愈逻辑。幂等，重复调用无副作用。
 */
export function installPreloadErrorRecovery(): void {
  if (typeof window === 'undefined') return;

  // Vite 在预加载/动态导入失败时会派发这个事件。
  // 事件名是 Vite 的公开契约（vite:preloadError）。
  window.addEventListener('vite:preloadError', (event) => {
    const detail = (event as Event & { payload?: unknown }).payload;

    if (!isChunkLoadError(detail)) return;

    // 提示里已经明确要刷新页面，因此不需要用户再看到原始报错
    event.preventDefault();

    if (hasReloaded()) {
      // 刷新过一次还是失败 —— 那就不是版本错配，交给用户判断
      console.error(
        '[preloadRecovery] 刷新后仍无法加载模块，可能是网络问题或部署异常。原始错误：',
        detail,
      );
      showNotice('资源加载失败，请检查网络后刷新页面。');
      return;
    }

    markReloaded();
    console.info('[preloadRecovery] 检测到资源版本错配，正在自动刷新以载入最新版本…');
    showNotice('正在载入最新版本…');
    window.location.reload();
  });

  // 入口能执行到这里，说明本次加载是完整的 —— 清零重试计数，
  // 让下一次部署后的错配仍然享有一次自动刷新
  clearReloadFlag();
}

/**
 * 极简提示。
 *
 * 不复用应用里的 Banner 组件：这个模块要在 React 挂载**之前**可用，
 * 而且在刷新的瞬间就要显示，走 DOM 直插比等 React 渲染可靠。
 */
function showNotice(text: string): void {
  if (typeof document === 'undefined') return;

  const el = document.createElement('div');
  el.textContent = text;
  el.setAttribute('role', 'status');
  el.style.cssText = [
    'position:fixed',
    'left:50%',
    'bottom:1rem',
    'transform:translateX(-50%)',
    'z-index:9999',
    'padding:0.5rem 0.9rem',
    'border-radius:0.5rem',
    'font-size:0.75rem',
    'background:#2b2620',
    'color:#ded7c9',
    'box-shadow:0 4px 16px rgba(0,0,0,0.25)',
  ].join(';');

  document.body.appendChild(el);
}
