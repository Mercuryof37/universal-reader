/**
 * Service Worker 注册与更新提示。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么选「提示更新」而不是「自动更新」
 * ═══════════════════════════════════════════════════════════════
 *
 * `registerType: 'prompt'` 配 `skipWaiting: false` 意味着：
 * 新版本装好后处于 waiting 状态，**等用户点确认才接管**。
 *
 * 自动更新（`autoUpdate` / `skipWaiting: true`）看起来更省事，但对本应用有害：
 * 用户可能正在读一份长文档，页面在毫无预警的情况下重载 —— 滚动位置、展开的译文、
 * 正在进行的 OCR 全都会丢。**阅读类应用最不能容忍的就是"读到一半被打断"。**
 *
 * 因此这里把选择权交给用户：提示条出现，他可以选择立刻更新或稍后。
 */

import { useRegisterSW } from 'virtual:pwa-register/react';

import { seedNavigationFallback } from '@/lib/pwaOffline';

export interface PwaState {
  /** 有新版在等待接管 */
  needRefresh: boolean;
  /** 应用已可离线使用 */
  offlineReady: boolean;
  /** 立刻更新并重载 */
  update: () => void;
  /** 关闭提示（本次会话不再询问，直到下次有新版） */
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
      needRefresh: false,
      offlineReady: false,
      update: () => {},
      dismiss: () => {},
    };
  }

  // eslint-disable-next-line react-hooks/rules-of-hooks -- 上面的分支只在非浏览器环境命中
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    offlineReady: [offlineReady, setOfflineReady],
    updateServiceWorker,
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
    needRefresh,
    offlineReady,
    update: () => {
      void updateServiceWorker(true);
    },
    dismiss: () => {
      setNeedRefresh(false);
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
