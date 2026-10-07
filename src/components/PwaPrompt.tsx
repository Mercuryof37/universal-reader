import { useEffect, useState } from 'react';
import { Download, RefreshCw, WifiOff, X } from 'lucide-react';
import { subscribeOnline, usePwa } from '@/lib/pwa';
import { useLibraryStore } from '@/store/libraryStore';

/**
 * PWA 状态提示条。
 *
 * 三种提示共用一个位置，**按下面的顺序判断**（代码顺序即优先级）：
 *
 * | 顺序 | 场景 | 文案 | 可关闭 |
 * |---|---|---|---|
 * | 1 | 离线中 | 「已离线，已缓存的内容仍可阅读」 | 否 |
 * | 2 | 新版本就绪、刷新被推迟 | 「新版本已就绪」+「立即刷新」 | 否（会自动消失） |
 * | 3 | 首次可离线使用 | 「已可离线使用」 | 是 |
 *
 * 「离线中」不可关闭是刻意的：它是**状态**而不是通知，
 * 让用户知道这不是网站坏了，同时暗示可以继续读已导入的书。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么这里会有一个「新版本已就绪」条 —— 它和当初删掉的那条不是一回事
 * ═══════════════════════════════════════════════════════════════
 *
 * 本项目是 `registerType: 'autoUpdate'`，所以**没有**「有新版本可用 / 立即更新」
 * 那种需要用户点确认的条：`updateServiceWorker()` 在 autoUpdate 下是空操作、
 * `onNeedRefresh` 也不会触发，那条 UI 属于死代码，已经删掉。
 *
 * 现在这一条是**另一回事**：它不是「请你决定要不要更新」，而是
 * **「更新已经就绪，但我暂时没有刷新，因为你有活儿在跑」**。
 * 它由 `lib/pwa.ts` 的 `onNeedReload` 置位（导入/OCR 期间推迟刷新），
 * 工作一结束就自动刷新、提示条随之消失。
 */
export function PwaPrompt() {
  const { offlineReady, updatePending, dismiss, reloadNow } = usePwa();
  const importing = useLibraryStore((s) => s.importing);
  const scannedPdfPending = useLibraryStore((s) => s.scannedPdfPending);
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );

  useEffect(() => subscribeOnline(setOnline), []);

  /**
   * 新版本已就绪、但刷新被推迟时：等手头的活儿一结束就自动刷新。
   *
   * 「手头的活儿」有两种，与 `lib/pwa.ts` 里推迟刷新时判断的完全一致：
   * 正在导入/识别（`importing`），或者有一份待识别的扫描件等着用户点开始
   * （`scannedPdfPending`）。后者只在内存里，刷新就会丢，所以也必须等。
   *
   * 放在这里而不是在 `onNeedReload` 里轮询，是因为这些是 store 状态，
   * 组件天然会在它们变化时重渲染。之所以要「结束就刷新」而不是一直等用户点：
   * 用户选的就是 autoUpdate，推迟只是为了**不毁掉正在进行的工作**，
   * 工作一结束就该回到原本的自动更新语义。
   * 此时结果已经落盘（第一页起就落 + 每 5 页 + 末页），刷新不会丢东西。
   *
   * ⚠️ **必须同时判断 `online`**：离线时刷新毫无意义，而且此刻界面显示的是
   * 「已离线」那条（优先级更高，见上方表格），用户根本看不到「新版本已就绪」，
   * 突然重载只会莫名其妙。等恢复在线后这个 effect 会再次运行。
   */
  const busy = importing || scannedPdfPending !== null;

  useEffect(() => {
    if (updatePending && !busy && online) {
      console.info('[pwa] 手头的活儿已结束，现在应用新版本并刷新。');
      reloadNow();
    }
  }, [updatePending, busy, online, reloadNow]);

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
