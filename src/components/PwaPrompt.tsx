import { useEffect, useState } from 'react';
import { Download, RefreshCw, WifiOff, X } from 'lucide-react';
import { subscribeOnline, usePwa } from '@/lib/pwa';

/**
 * PWA 状态提示条。
 *
 * 三种提示共用一个位置，按优先级显示：
 *
 * | 优先级 | 场景 | 文案 | 可关闭 |
 * |---|---|---|---|
 * | 1 | 有新版本在等待 | 「有新版本可用」+ 立即更新 | 是 |
 * | 2 | 离线中 | 「已离线，已缓存的内容仍可阅读」 | 否 |
 * | 3 | 首次可离线使用 | 「已可离线使用」 | 是 |
 *
 * 「离线中」不可关闭是刻意的：它是**状态**而不是通知，
 * 让用户知道这不是网站坏了，同时暗示可以继续读已导入的书。
 */
export function PwaPrompt() {
  const { needRefresh, offlineReady, update, dismiss } = usePwa();
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );

  useEffect(() => subscribeOnline(setOnline), []);

  // 离线状态优先于「可离线使用」提示：后者在离线时已经没有意义
  if (!online) {
    return (
      <Banner tone="offline" icon={<WifiOff className="h-4 w-4" aria-hidden />}>
        已离线 — 已缓存的页面与已导入的文档仍可正常阅读
      </Banner>
    );
  }

  if (needRefresh) {
    return (
      <Banner
        tone="update"
        icon={<Download className="h-4 w-4" aria-hidden />}
        onClose={dismiss}
      >
        <span>有新版本可用</span>
        <button
          type="button"
          onClick={update}
          className="ml-2 inline-flex items-center gap-1 rounded-md bg-[var(--reader-accent)] px-2 py-0.5 text-xs font-medium text-[var(--reader-bg)]"
        >
          <RefreshCw className="h-3 w-3" aria-hidden />
          立即更新
        </button>
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
  tone: 'update' | 'offline' | 'ready';
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
