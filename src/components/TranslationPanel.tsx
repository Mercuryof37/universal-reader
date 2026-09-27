import { Languages, Loader2, Zap } from 'lucide-react';
import { useSettingsStore } from '@/store/settingsStore';
import { TARGET_LANGUAGES, isBrowserTranslationAvailable } from '@/services/translationService';
import type { TranslationEngineId } from '@/store/settingsStore';

export interface TranslationControls {
  pending: number;
  translatedCount: number;
  totalCount: number;
  translateAll: () => void;
  cancel: () => void;
}

/**
 * 翻译面板。
 *
 * 界面上刻意区分"自动翻译可见区域"和"翻译全文"：
 * 前者是默认行为（省钱、快），后者是显式动作，
 * 用户点了才知道要花额度，避免误触把免费额度烧光。
 */
export function TranslationPanel({ controls }: { controls: TranslationControls }) {
  const targetLang = useSettingsStore((s) => s.translationTargetLang);
  const setTargetLang = useSettingsStore((s) => s.setTranslationTargetLang);
  const engine = useSettingsStore((s) => s.defaultTranslationEngine);
  const setEngine = useSettingsStore((s) => s.setDefaultTranslationEngine);
  const showTranslation = useSettingsStore((s) => s.showTranslation);
  const setShowTranslation = useSettingsStore((s) => s.setShowTranslation);

  const browserOk = isBrowserTranslationAvailable();

  return (
    <section className="flex flex-col gap-3 border-b border-[var(--reader-border)] p-4">
      <h2 className="flex items-center gap-2 text-sm font-medium">
        <Languages className="h-4 w-4 text-[var(--reader-accent)]" aria-hidden />
        双语对照
      </h2>

      <label className="flex items-center justify-between gap-3 text-xs">
        <span className="text-[var(--reader-muted)]">显示译文</span>
        <input
          type="checkbox"
          checked={showTranslation}
          onChange={(e) => setShowTranslation(e.target.checked)}
          className="h-4 w-4 accent-[var(--reader-accent)]"
        />
      </label>

      <label className="flex items-center justify-between gap-3 text-xs">
        <span className="text-[var(--reader-muted)]">目标语言</span>
        <select
          value={targetLang}
          onChange={(e) => setTargetLang(e.target.value)}
          className="rounded-md border border-[var(--reader-border)] bg-[var(--reader-bg)] px-2 py-1 text-xs"
        >
          {TARGET_LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.label}
            </option>
          ))}
        </select>
      </label>

      <label className="flex items-center justify-between gap-3 text-xs">
        <span className="text-[var(--reader-muted)]">翻译引擎</span>
        <select
          value={engine}
          onChange={(e) => setEngine(e.target.value as TranslationEngineId)}
          className="rounded-md border border-[var(--reader-border)] bg-[var(--reader-bg)] px-2 py-1 text-xs"
        >
          <option value="deepl">DeepL（代理）</option>
          <option value="openai">OpenAI（代理）</option>
          <option value="browser" disabled={!browserOk}>
            浏览器内置{browserOk ? '' : '（不可用）'}
          </option>
        </select>
      </label>

      <div className="flex items-center justify-between gap-2 pt-1 text-xs">
        <span className="text-[var(--reader-muted)]">
          已译 {controls.translatedCount}/{controls.totalCount}
          {controls.pending > 0 && (
            <span className="ml-2 inline-flex items-center gap-1 text-[var(--reader-accent)]">
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
              {controls.pending} 段进行中
            </span>
          )}
        </span>
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={controls.translateAll}
          disabled={!showTranslation}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-[var(--reader-border)] px-3 py-1.5 text-xs transition-colors hover:bg-[var(--reader-panel)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Zap className="h-3.5 w-3.5" aria-hidden />
          翻译全文
        </button>
        {controls.pending > 0 && (
          <button
            type="button"
            onClick={controls.cancel}
            className="rounded-lg border border-[var(--reader-border)] px-3 py-1.5 text-xs hover:bg-[var(--reader-panel)]"
          >
            取消
          </button>
        )}
      </div>

      <p className="text-[11px] leading-relaxed text-[var(--reader-muted)]">
        默认只翻译你正在看的段落（± 缓冲），滚动到哪里翻到哪里，可随时停止以节省额度。
      </p>
    </section>
  );
}
