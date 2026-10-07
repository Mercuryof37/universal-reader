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

import { useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';

import { seedNavigationFallback } from '@/lib/pwaOffline';
import { noteReloadReason } from '@/lib/sessionDiagnostics';
import { useLibraryStore } from '@/store/libraryStore';

export interface PwaState {
  /** 应用已可离线使用 */
  offlineReady: boolean;
  /**
   * 新版本已就绪，但因为正在导入/OCR 而**推迟了自动刷新**。
   *
   * 有这个状态是因为 `autoUpdate` 的默认行为会直接 `location.reload()` ——
   * 而导入与 OCR 的结果在完成前只存在内存里，刷新即全部丢失，
   * 用户看到的是「扫描完了，但什么都没有」。见 `onNeedReload` 的说明。
   */
  updatePending: boolean;
  /** 关闭「已可离线使用」提示（本次会话不再询问，直到下次有新版） */
  dismiss: () => void;
  /** 立刻刷新以应用新版本（仅在 updatePending 时由用户主动触发） */
  reloadNow: () => void;
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
      updatePending: false,
      dismiss: () => {},
      reloadNow: () => {},
    };
  }

  // eslint-disable-next-line react-hooks/rules-of-hooks -- 上面的分支只在非浏览器环境命中
  const [updatePending, setUpdatePending] = useState(false);

  // eslint-disable-next-line react-hooks/rules-of-hooks -- 同上
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
    /**
     * 新版本接管时的刷新时机。
     *
     * 不传这个回调，`vite-plugin-pwa` 在 `autoUpdate` 下会直接
     * `window.location.reload()` —— **无预警**。
     *
     * 这正是用户报过的故障：扫描版 PDF 识别到一半，新版本部署上线，
     * 页面被自动刷新，而 OCR 结果当时还只在内存里，于是
     * 「扫描完了，看不到文档，书库里也没有新条目，而且没有任何报错」。
     *
     * 所以：**正在导入或 OCR 时推迟刷新**，交给界面提示 + 空闲后再刷新。
     * 其余情况保持 autoUpdate 原有的立即刷新语义。
     */
    onNeedReload() {
      const state = useLibraryStore.getState();

      /**
       * 两种「有活儿在内存里」的状态都必须拦住刷新：
       *
       * 1. `importing` —— 正在导入或正在 OCR，结果还没（或只落了一部分）到 IndexedDB；
       * 2. `scannedPdfPending` —— **已导入的扫描件正等着用户点「开始识别」**。
       *    这份 PDF 的 buffer 只在内存里，刷新即丢失，用户得重新导入一次。
       *    之前只判断了第 1 种，于是「识别对话框开着的时候来了一次部署」
       *    依然会把页面刷掉 —— 用户看到的就是「仍然会自动刷新」。
       */
      const busy = state.importing || state.scannedPdfPending !== null;

      if (busy) {
        const why = state.importing ? '正在导入/识别' : '有一份待识别的扫描件';
        console.info(`[pwa] 新版本已接管，但${why}，已推迟刷新（完成后自动刷新）。`);
        setUpdatePending(true);
        return;
      }

      console.info('[pwa] 新版本已接管，当前空闲，立即刷新。');
      noteReloadReason('sw-update');
      window.location.reload();
    },
  });

  return {
    offlineReady,
    updatePending,
    dismiss: () => {
      setOfflineReady(false);
    },
    reloadNow: () => {
      noteReloadReason('manual');
      window.location.reload();
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
