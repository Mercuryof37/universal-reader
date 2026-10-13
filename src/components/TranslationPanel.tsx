import { AlertTriangle, Languages, Loader2, Zap } from 'lucide-react';
import { useSettingsStore } from '@/store/settingsStore';
import { OutboundPrivacyNoticeLink } from '@/components/OutboundPrivacyNotice';
import {
  TARGET_LANGUAGES,
  isBrowserTranslationAvailable,
} from '@/services/translationService';
import {
  detectBrowserTranslator,
  hasCloudTranslationConfig,
  type TranslationEngineId,
} from '@/lib/outboundPaths';

export interface TranslationControls {
  pending: number;
  translatedCount: number;
  totalCount: number;
  translateAll: () => void;
  cancel: () => void;
  prepareBrowserTranslation: () => void;
}

/**
 * 翻译面板。
 *
 * 界面上刻意区分"自动翻译可见区域"和"翻译全文"：
 * 前者是默认行为（省钱、快），后者是显式动作，
 * 用户点了才知道要花额度，避免误触把免费额度烧光。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么这里要写「为什么不能翻译」而不是在阅读界面弹错误条
 * ═══════════════════════════════════════════════════════════════
 *
 * 这是设置面板 —— **用户主动点进来才会看到的地方**。原来那条
 * 「未配置翻译端点 / 浏览器不支持」的报错出现在阅读界面，
 * 而且是每一段翻译各刷一次：用户既不知道为什么，也不知道能做什么，
 * 唯一的按钮是「知道了」—— 那条错误信息**没有任何可操作性**。
 *
 * 现在分成两处，各司其职：
 * - 阅读界面：不可用就安静降级，不显示译文列、不报错（见
 *   `hooks/useViewportTranslation.ts` 的 `translateRange`）；
 * - 这里：写清**缺什么**、**去哪里配**，并给出能点的出路。
 *
 * 「诚实」在这块界面上的具体含义是：用户看到的每一句话都对应
 * 一个他能做的动作，而不是一句他无法处置的诊断。
 */
export function TranslationPanel({ controls }: { controls: TranslationControls }) {
  const targetLang = useSettingsStore((s) => s.translationTargetLang);
  const setTargetLang = useSettingsStore((s) => s.setTranslationTargetLang);
  const engine = useSettingsStore((s) => s.defaultTranslationEngine);
  const setEngine = useSettingsStore((s) => s.setDefaultTranslationEngine);
  const showTranslation = useSettingsStore((s) => s.showTranslation);
  const setShowTranslation = useSettingsStore((s) => s.setShowTranslation);
  const cloudConsent = useSettingsStore((s) => s.cloudTranslationConsent);
  const setCloudConsent = useSettingsStore((s) => s.setCloudTranslationConsent);

  const browserOk = isBrowserTranslationAvailable();
  const cloudOk = hasCloudTranslationConfig();
  const anyUsable = browserOk || cloudOk;

  return (
    <section className="flex flex-col gap-3 border-b border-[var(--reader-border)] p-4">
      <h2 className="flex items-center gap-2 text-sm font-medium">
        <Languages className="h-4 w-4 text-[var(--reader-accent)]" aria-hidden />
        双语对照
      </h2>

      {/*
        ── 不可用时的说明（可操作） ──
        出现条件：一个可用引擎都没有。这正是「未配代理的部署 + Firefox」
        的真实状态 —— 也就是用户主用的浏览器。以前这个状态没有任何界面表达，
        只有阅读界面里刷不完的报错。
      */}
      {!anyUsable && (
        <div className="flex flex-col gap-2 rounded-md border border-amber-400/60 bg-amber-500/10 p-2.5 text-[11px] leading-relaxed text-amber-800 dark:text-amber-200">
          <span className="flex items-center gap-1.5 font-medium">
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
            这台机器上暂时没有可用的翻译引擎
          </span>
          <span>
            本机翻译（浏览器内置）需要在有 <code>Translator</code> API 的浏览器上运行
            （目前主要是 Chromium 138+），{detectBrowserTranslator() ? '本浏览器已具备' : '本浏览器没有这个 API'}。
            云端翻译需要在部署时配置 <code>VITE_TRANSLATE_ENDPOINT</code>。
          </span>
          <span className="text-amber-900/80 dark:text-amber-100/80">
            所以「显示译文」打开后不会有任何译文，也<b>不会</b>再弹出报错 ——
            我们把它安静地关掉了，而不是让你去撞一条必然失败的路。
          </span>
        </div>
      )}

      <label className="flex items-center justify-between gap-3 text-xs">
        <span className="text-[var(--reader-muted)]">显示译文</span>
        <input
          type="checkbox"
          checked={showTranslation}
          onChange={(e) => {
            if (e.target.checked) controls.prepareBrowserTranslation();
            setShowTranslation(e.target.checked);
          }}
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
          /*
            引擎可能是 null（一个可用的都没有）。用 '' 表示这一档，
            界面显示「无可用引擎」——**不允许**把 null 悄悄显示成
            「浏览器内置」，那正是原来那条死路的起点。
          */
          value={engine ?? ''}
          onChange={(e) => setEngine(e.target.value as TranslationEngineId)}
          className="rounded-md border border-[var(--reader-border)] bg-[var(--reader-bg)] px-2 py-1 text-xs"
        >
          {engine === null && <option value="">无可用引擎</option>}
          <option value="browser" disabled={!browserOk}>
            浏览器内置（本机）{browserOk ? '' : '（本浏览器不支持）'}
          </option>
          <option value="deepl" disabled={!cloudOk}>
            DeepL（代理）{cloudOk ? '' : '（未配置端点）'}
          </option>
          <option value="openai" disabled={!cloudOk}>
            OpenAI（代理）{cloudOk ? '' : '（未配置端点）'}
          </option>
        </select>
      </label>

      {/*
        ── 云端翻译的显式同意（四要素之②） ──
        代价透明（④）就写在同一个勾选框下面：什么内容、发到哪、为什么需要。
        数据上它与引擎偏好分开存（`cloudTranslationConsent`），
        所以「配了端点」永远不会被当成「用户同意」。
      */}
      <label className="flex items-start gap-2 rounded-md border border-[var(--reader-border)] p-2 text-[11px] leading-relaxed">
        <input
          type="checkbox"
          checked={cloudConsent}
          disabled={!cloudOk}
          onChange={(e) => setCloudConsent(e.target.checked)}
          className="mt-0.5 accent-[var(--reader-accent)]"
        />
        <span>
          <span className="font-medium">允许把正文发往云端翻译服务</span>
          <span className="block text-[var(--reader-muted)]">
            默认关闭。开启后，云端翻译会处理正在阅读的段落；选中查译只处理你选中的文字。
            {!cloudOk && ' 当前版本未配置云端翻译服务。'}
          </span>
        </span>
      </label>
      <div className="-mt-2 pl-6"><OutboundPrivacyNoticeLink /></div>

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
          disabled={!showTranslation || !anyUsable}
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
      <p className="text-[11px] leading-relaxed text-[var(--reader-muted)]">
        大段文本可使用浏览器内置翻译；小段文字可在阅读区选中后查译。
      </p>
    </section>
  );
}
