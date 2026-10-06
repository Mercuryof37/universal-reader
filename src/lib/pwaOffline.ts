/**
 * 离线兜底：预置「断网冷启动」所需的页面骨架。
 *
 * 单独成文件（而不是放在 `pwa.ts` 里）是为了可测：
 * `pwa.ts` 顶层 import 了 `virtual:pwa-register/react`，
 * 那个虚拟模块只在 Vite 构建/开发时存在，vitest 里解析不了。
 * 把纯逻辑摘出来，测试就能直接引用，不必给测试环境造桩。
 */

/**
 * 导航请求的运行时缓存名。
 *
 * ⚠️ 必须与 vite.config.ts 里导航路由的 `cacheName` 完全一致 ——
 * 下面会直接往这个缓存里写。改动其一而忘了另一个，
 * 兜底会静默失效（SW 找不到条目，离线冷启动依然打不开）。
 * `src/lib/pwaOffline.test.ts` 会读配置文件把两者钉在一起。
 */
export const NAVIGATION_CACHE_NAME = 'html-navigation';

/**
 * 预置离线兜底页面。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么需要这一步
 * ═══════════════════════════════════════════════════════════════
 *
 * 导航请求走 NetworkFirst（在线拿最新 HTML，避免旧 HTML 引用已删除的
 * chunk —— 见 vite.config.ts 里那段长注释）。但它**只回退自己的
 * `html-navigation` 缓存**，而这个缓存只有在「SW 接管之后的某次导航」
 * 里才会被写入。
 *
 * 于是有一个很窄但很致命的空档：
 *
 *   首次访问（SW 装好了，但这一次导航不是它处理的）
 *     → 用户直接断网
 *     → 打开已安装的应用（这是一次导航）
 *     → 网络失败 + 缓存里什么都没有
 *     → **白屏 / 打不开**
 *
 * 「装上就能断网读」正是本应用的核心卖点，所以这个空档必须补。
 * 补法很直接：SW 注册成功后，趁还在线，主动把页面骨架存进那个缓存。
 *
 * 页面与 SW 同源，共享同一套 Cache Storage，因此直接写入合法且可靠。
 *
 * 任何失败都只告警、不上抛：兜底是为了帮忙，不能反过来影响正常使用。
 */
export async function seedNavigationFallback(): Promise<void> {
  if (typeof caches === 'undefined') return;

  try {
    const response = await fetch('/', { cache: 'no-store' });
    // 只存成功响应，避免把错误页当成离线兜底
    if (!response.ok) return;

    const cache = await caches.open(NAVIGATION_CACHE_NAME);
    await cache.put('/', response.clone());
  } catch (err) {
    console.warn('[pwa] 离线兜底页面预置失败：', err);
  }
}
