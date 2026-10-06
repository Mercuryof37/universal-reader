import { useEffect, useState } from 'react';
import { Download, RefreshCw, WifiOff, X } from 'lucide-react';
import { subscribeOnline, usePwa } from '@/lib/pwa';
import { useLibraryStore } from '@/store/libraryStore';

/**
 * PWA 状态提示条。
 *
 * 两种提示共用一个位置，按优先级显示：
 *
 * | 优先级 | 场景 | 文案 | 可关闭 |
 * |---|---|---|---|
 * | 1 | 离线中 | 「已离线，已缓存的内容仍可阅读」 | 否 |
 * | 2 | 首次可离线使用 | 「已可离线使用」 | 是 |
 *
 * 「离线中」不可关闭是刻意的：它是**状态**而不是通知，
 * 让用户知道这不是网站坏了，同时暗示可以继续读已导入的书。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么没有「有新版本可用 / 立即更新」
 * ═══════════════════════════════════════════════════════════════
 *
 * 本项目采用 `registerType: 'autoUpdate'`（见 `vite.config.ts` 与 `lib/pwa.ts`）。
 * 该模式下 `updateServiceWorker()` 是空操作，`onNeedRefresh` 也不会被触发，
 * 所以「有新版本」提示条**永远不会出现** —— 那段 UI 已被删除，
 * 而不是留在这里装作能用。代价是页面会在无预警时自动重载。
 */
export function PwaPrompt() {
  const { offlineReady, updatePending, dismiss, reloadNow } = usePwa();
  const importing = useLibraryStore((s) => s.importing);
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );

  useEffect(() => subscribeOnline(setOnline), []);

  /**
   * 新版本已就绪、但刷新被推迟时：等导入/OCR 一结束就自动刷新。
   *
   * 放在这里而不是在 `onNeedReload` 里轮询，是因为 `importing` 是 store 状态，
   * 组件天然会在它变化时重渲染。之所以要「结束就刷新」而不是一直等用户点：
   * 用户选的就是 autoUpdate，推迟只是为了**不毁掉正在进行的工作**，
   * 工作一结束就该回到原本的自动更新语义。
   * 此时结果已经落盘（中途检查点 + 最终保存），刷新不会丢东西。
   */
  useEffect(() => {
    if (updatePending && !importing) reloadNow();
  }, [updatePending, importing, reloadNow]);

  // 离线状态优先于其他提示：它描述的是此刻能不能用
  if (!online) {
    return (
      <Banner tone="offline" icon={<WifiOff className="h-4 w-4" aria-hidden />}>
        已离线 — 已缓存的页面与已导入的文档仍可正常阅读
      </Banner>
    );
  }

  // 优先于「已可离线使用」：正在等的是刷新，用户需要知道为什么还没刷新
  if (updatePending) {
    return (
      <Banner tone="ready" icon={<Download className="h-4 w-4" aria-hidden />}>
        <span>新版本已就绪</span>
        <button
          type="button"
          onClick={reloadNow}
          className="ml-2 inline-flex items-center gap-1 rounded-md bg-[var(--reader-accent)] px-2 py-0.5 text-xs font-medium text-[var(--reader-bg)]"
        >
          <RefreshCw className="h-3 w-3" aria-hidden />
          立即刷新
        </button>
        <span className="ml-2 text-[var(--reader-muted)]">
          正在识别，完成后会自动刷新
        </span>
      </Banner>
    );
  }

  if (offlineReady) {
    return (
      <Banner tone="ready" icon={<Download className="h-4 w-4" aria-hidden />} onClose={dismiss}>
        已可离线使用 — 断网后打开本网址仍能阅读
      </Banner>
    );
  }

  return null;
}

function Banner({
  tone,
  icon,
  children,
  onClose,
}: {
  tone: 'offline' | 'ready';
  icon: React.ReactNode;
  children: React.ReactNode;
  onClose?: () => void;
}) {
  const color =
    tone === 'offline'
      ? 'border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-100'
      : 'border-[var(--reader-accent)]/40 bg-[var(--reader-panel)] text-[var(--reader-fg)]';

  return (
    <div
      className={`no-print fixed bottom-4 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-lg border px-3 py-2 text-xs shadow-lg backdrop-blur ${color}`}
      role="status"
      aria-live="polite"
    >
      {icon}
      <span>{children}</span>
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭提示"
          className="ml-1 rounded p-0.5 opacity-70 hover:opacity-100"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      )}
    </div>
  );
}
