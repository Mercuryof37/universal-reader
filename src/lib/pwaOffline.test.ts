import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { NAVIGATION_CACHE_NAME, seedNavigationFallback } from '@/lib/pwaOffline';

/**
 * 离线冷启动兜底的「跨文件契约」。
 *
 * ═══════════════════════════════════════════════════════════════
 * 这组测试要防的是什么
 * ═══════════════════════════════════════════════════════════════
 *
 * 导航请求走 NetworkFirst 以消除「旧 HTML 引用已删除 chunk」的故障，
 * 代价是它只会回退自己的 `html-navigation` 缓存 —— 而这个缓存
 * 只在「SW 接管后的某次导航」里才会被写入。首次访问后直接断网
 * 再冷启动就会白屏，所以 `seedNavigationFallback()` 主动写一份进去。
 *
 * 这一步靠一个**字符串**和构建配置耦合：`NAVIGATION_CACHE_NAME`
 * 必须等于 vite.config.ts 里导航路由的 `cacheName`。
 * 两者一旦写岔，代码照常编译、测试照常通过、离线时静默失效 ——
 * 正是本项目记录过的「看着对、跑起来不对」。所以这里直接读配置
 * 把两者钉死。
 */

const VITE_CONFIG = readFileSync(join(process.cwd(), 'vite.config.ts'), 'utf8');

/**
 * 去掉注释后的配置源码。
 *
 * 必要性：vite.config.ts 里那段解释「为什么不能设 navigateFallback」的
 * 注释本身**就写着** `navigateFallback: '/index.html'`。
 * 不去注释的话，断言会被自己的说明文字绊倒（第一次写就踩了）。
 */
const VITE_CONFIG_CODE = VITE_CONFIG.replace(/\/\*[\s\S]*?\*\//g, '').replace(
  /(^|\s)\/\/[^\n]*/g,
  '$1',
);

describe('离线兜底缓存名与构建配置的一致性', () => {
  it('NAVIGATION_CACHE_NAME 与 vite.config.ts 的导航路由 cacheName 相同', () => {
    // 取出导航路由那一段（NetworkFirst + navigate 判定）里的 cacheName
    const navRoute = /request\.mode === 'navigate'[\s\S]*?cacheName:\s*'([^']+)'/;
    const match = VITE_CONFIG_CODE.match(navRoute);

    expect(match, 'vite.config.ts 里没有找到导航路由的 cacheName，测试需要同步更新').not.toBeNull();
    expect(match?.[1]).toBe(NAVIGATION_CACHE_NAME);
  });

  it('导航路由用的是 NetworkFirst（在线取新 HTML，消除旧 chunk 引用）', () => {
    expect(VITE_CONFIG_CODE).toMatch(/handler:\s*'NetworkFirst'/);
  });

  it('导航路由配了 networkTimeoutSeconds（弱网下不至于一直白屏）', () => {
    expect(VITE_CONFIG_CODE).toMatch(/networkTimeoutSeconds:\s*\d+/);
  });

  it('刻意不设 navigateFallback —— 它会抢先截获导航请求，让 NetworkFirst 失效', () => {
    /**
     * workbox-build 的 sw-template.js 里，navigateFallback 生成的
     * NavigationRoute 注册在 runtimeCaching 路由**之前**，而 Workbox
     * 按注册顺序匹配。也就是说只要设了它，导航就永远走预缓存，
     * 在线也拿旧 HTML —— 这正是用户报的 pdfParser chunk 404 的成因。
     */
    expect(VITE_CONFIG_CODE).toMatch(/navigateFallback:\s*undefined/);
    expect(VITE_CONFIG_CODE).not.toMatch(/navigateFallback:\s*['"]/);
  });
});

describe('seedNavigationFallback 在非浏览器环境下安全退出', () => {
  it('没有 caches 全局对象时（Node/vitest）不抛错', async () => {
    // Node 里没有 Cache Storage：函数必须安静返回，而不是让 SW 注册流程炸掉
    expect(typeof caches).toBe('undefined');
    await expect(seedNavigationFallback()).resolves.toBeUndefined();
  });

  it('fetch 失败时只告警、不上抛（离线兜底不能反过来影响正常使用）', async () => {
    const originalCaches = (globalThis as { caches?: unknown }).caches;
    const originalFetch = globalThis.fetch;

    const put = vi.fn();
    (globalThis as { caches?: unknown }).caches = {
      open: async () => ({ put }),
    };
    globalThis.fetch = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    try {
      await expect(seedNavigationFallback()).resolves.toBeUndefined();
      expect(put).not.toHaveBeenCalled();
    } finally {
      (globalThis as { caches?: unknown }).caches = originalCaches;
      globalThis.fetch = originalFetch;
    }
  });

  it('在线时把根路径写进导航缓存（这就是离线冷启动的兜底）', async () => {
    const originalCaches = (globalThis as { caches?: unknown }).caches;
    const originalFetch = globalThis.fetch;

    const put = vi.fn().mockResolvedValue(undefined);
    const open = vi.fn().mockResolvedValue({ put });
    (globalThis as { caches?: unknown }).caches = { open };

    const response = { ok: true, clone: () => 'cloned' } as unknown as Response;
    globalThis.fetch = (async () => response) as unknown as typeof fetch;

    try {
      await seedNavigationFallback();

      expect(open).toHaveBeenCalledWith(NAVIGATION_CACHE_NAME);
      expect(put).toHaveBeenCalledWith('/', 'cloned');
    } finally {
      (globalThis as { caches?: unknown }).caches = originalCaches;
      globalThis.fetch = originalFetch;
    }
  });

  it('响应非 2xx 时不写入（避免把错误页当成离线兜底）', async () => {
    const originalCaches = (globalThis as { caches?: unknown }).caches;
    const originalFetch = globalThis.fetch;

    const put = vi.fn();
    (globalThis as { caches?: unknown }).caches = { open: async () => ({ put }) };
    globalThis.fetch = (async () => ({ ok: false, status: 500 })) as unknown as typeof fetch;

    try {
      await seedNavigationFallback();
      expect(put).not.toHaveBeenCalled();
    } finally {
      (globalThis as { caches?: unknown }).caches = originalCaches;
      globalThis.fetch = originalFetch;
    }
  });
});
