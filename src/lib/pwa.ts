/**
 * Service Worker 注册与更新提示。
 *
 * ═══════════════════════════════════════════════════════════════
 * 更新策略：autoUpdate（已决策）
 * ═══════════════════════════════════════════════════════════════
 *
 * `vite.config.ts` 用 `registerType: 'autoUpdate'` + `skipWaiting: true`：
 * 新版本装好后立即接管，页面自动重载。**本项目曾按 `prompt` 模式设计
 * （弹提示条、由用户点「立即更新」），那套 UI 在 autoUpdate 下永远不会触发** ——
 * 因为 `updateServiceWorker()` 在 autoUpdate 模式里编译成空操作，
 * `onNeedRefresh` 也不会被调用（见 vite-plugin-pwa 的 client/build/react.js）。
 * 所以那些代码已被删除，而不是留着装作能用。
 *
 * 这个选择的代价必须说清楚：**页面会在无预警的情况下重载**，
 * 正在读的滚动位置、展开的译文、进行中的 OCR 都会丢。
 * 之所以接受，是因为「陈旧 HTML 引用已删除 chunk」这类故障在
 * autoUpdate 下能自愈；而导航本身已走 NetworkFirst（见 vite.config.ts），
 * 在线时拿到的始终是服务器上最新的 HTML。
 *
 * 若将来想减少打扰，vite-plugin-pwa 提供了 `onNeedReload` 钩子
 * （`registerSW({ onNeedReload })`），可以自己决定何时调用 `window.location.reload()`。
 */

import { useRegisterSW } from 'virtual:pwa-register/react';

import { seedNavigationFallback } from '@/lib/pwaOffline';

export interface PwaState {
  /** 应用已可离线使用 */
  offlineReady: boolean;
  /** 关闭「已可离线使用」提示（本次会话不再询问，直到下次有新版） */
  dismiss: () => void;
}

/**
 * Service Worker 注册。
 *
 * 在非浏览器环境（Node 测试）里 `virtual:pwa-register/react` 不可用，
 * 因此这里用一个 no-op 兜底 —— 让 store / 组件的测试不必为它写桩。
 */
export function usePwa(): PwaState {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    return {
      offlineReady: false,
      dismiss: () => {},
    };
  }

  // eslint-disable-next-line react-hooks/rules-of-hooks -- 上面的分支只在非浏览器环境命中
  const {
    offlineReady: [offlineReady, setOfflineReady],
  } = useRegisterSW({
    onRegisterError(error: unknown) {
      // 注册失败不影响使用，只是没有离线能力 —— 不打扰用户，但要留痕
      console.warn('[pwa] Service Worker 注册失败：', error);
    },
    onRegisteredSW() {
      // 注册成功后趁在线把页面骨架写进导航缓存，补上离线冷启动的空档
      void seedNavigationFallback();
    },
  });

  return {
    offlineReady,
    dismiss: () => {
      setOfflineReady(false);
    },
  };
}

/**
 * 监听在线/离线状态。
 *
 * 独立于 PWA 提示条：断网本身就需要告知用户，
 * 否则他会以为是网站坏了，而不是「你现在离线，但已缓存的内容仍可读」。
 */
export function subscribeOnline(onChange: (online: boolean) => void): () => void {
  if (typeof window === 'undefined') return () => {};

  const handleOnline = () => onChange(true);
  const handleOffline = () => onChange(false);

  window.addEventListener('online', handleOnline);
  window.addEventListener('offline', handleOffline);

  return () => {
    window.removeEventListener('online', handleOnline);
    window.removeEventListener('offline', handleOffline);
  };
}
