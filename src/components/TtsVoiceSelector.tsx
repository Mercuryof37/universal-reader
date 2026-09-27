import { Headphones, Play, SkipBack, SkipForward, Square } from 'lucide-react';
import { useSettingsStore, type TtsPreference } from '@/store/settingsStore';
import { SPEECH_LANGUAGES } from '@/services/translationService';
import { hasCloudTTSConfig } from '@/services/ttsEngine';

interface TtsControls {
  isSpeaking: boolean;
  progress: number;
  voices: SpeechSynthesisVoice[];
  onStop: () => void;
  onNext: () => void;
  onPrev: () => void;
  onResume: () => void;
}

/**
 * 朗读控制面板。
 *
 * 音色列表只展示与当前朗读语言匹配的项：
 * 系统里通常装着几十种语言的音色，全部列出会让人无法选择。
 */
export function TtsVoiceSelector({ controls }: { controls: TtsControls }) {
  const ttsLang = useSettingsStore((s) => s.ttsLang);
  const setTtsLang = useSettingsStore((s) => s.setTtsLang);
  const preference = useSettingsStore((s) => s.ttsPreference);
  const setPreference = useSettingsStore((s) => s.setTtsPreference);
  const rate = useSettingsStore((s) => s.ttsRate);
  const setRate = useSettingsStore((s) => s.setTtsRate);
  const voiceName = useSettingsStore((s) => s.ttsVoiceName);
  const setVoiceName = useSettingsStore((s) => s.setTtsVoiceName);
  const autoContinue = useSettingsStore((s) => s.ttsAutoContinue);
  const setAutoContinue = useSettingsStore((s) => s.setTtsAutoContinue);

  const cloudOk = hasCloudTTSConfig();
  const primary = ttsLang.split('-')[0]?.toLowerCase() ?? '';
  const matchingVoices = controls.voices.filter((v) =>
    v.lang.toLowerCase().replace('_', '-').startsWith(primary),
  );

  return (
    <section className="flex flex-col gap-3 border-b border-[var(--reader-border)] p-4">
      <h2 className="flex items-center gap-2 text-sm font-medium">
        <Headphones className="h-4 w-4 text-[var(--reader-accent)]" aria-hidden />
        语音朗读
      </h2>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={controls.onPrev}
          disabled={!controls.isSpeaking}
          aria-label="上一段"
          className="rounded-lg border border-[var(--reader-border)] p-1.5 hover:bg-[var(--reader-panel)] disabled:opacity-40"
        >
          <SkipBack className="h-4 w-4" aria-hidden />
        </button>
        <button
          type="button"
          onClick={controls.isSpeaking ? controls.onStop : controls.onResume}
          aria-label={controls.isSpeaking ? '停止朗读' : '从当前位置开始朗读'}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-[var(--reader-accent)] px-3 py-1.5 text-xs font-medium text-[var(--reader-bg)] hover:opacity-90"
        >
          {controls.isSpeaking ? (
            <>
              <Square className="h-3.5 w-3.5" aria-hidden />
              停止
            </>
          ) : (
            <>
              <Play className="h-3.5 w-3.5" aria-hidden />
              开始朗读
            </>
          )}
        </button>
        <button
          type="button"
          onClick={controls.onNext}
          disabled={!controls.isSpeaking}
          aria-label="下一段"
          className="rounded-lg border border-[var(--reader-border)] p-1.5 hover:bg-[var(--reader-panel)] disabled:opacity-40"
        >
          <SkipForward className="h-4 w-4" aria-hidden />
        </button>
      </div>

      {controls.isSpeaking && (
        <div className="h-1 w-full overflow-hidden rounded-full bg-[var(--reader-border)]">
          <div
            className="h-full bg-[var(--reader-accent)] transition-[width] duration-300"
            style={{ width: `${Math.round(controls.progress * 100)}%` }}
          />
        </div>
      )}

      <label className="flex items-center justify-between gap-3 text-xs">
        <span className="text-[var(--reader-muted)]">朗读语言</span>
        <select
          value={ttsLang}
          onChange={(e) => {
            setTtsLang(e.target.value);
            setVoiceName(null);
          }}
          className="rounded-md border border-[var(--reader-border)] bg-[var(--reader-bg)] px-2 py-1 text-xs"
        >
          {SPEECH_LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.label}
            </option>
          ))}
        </select>
      </label>

      <label className="flex items-center justify-between gap-3 text-xs">
        <span className="text-[var(--reader-muted)]">合成引擎</span>
        <select
          value={preference}
          onChange={(e) => setPreference(e.target.value as TtsPreference)}
          className="rounded-md border border-[var(--reader-border)] bg-[var(--reader-bg)] px-2 py-1 text-xs"
        >
          <option value="auto">自动（推荐）</option>
          <option value="browser">浏览器原生</option>
          <option value="cloud" disabled={!cloudOk}>
            云端合成{cloudOk ? '' : '（未配置）'}
          </option>
        </select>
      </label>

      {preference !== 'cloud' && matchingVoices.length > 0 && (
        <label className="flex items-center justify-between gap-3 text-xs">
          <span className="text-[var(--reader-muted)]">音色</span>
          <select
            value={voiceName ?? ''}
            onChange={(e) => setVoiceName(e.target.value || null)}
            className="max-w-[9rem] truncate rounded-md border border-[var(--reader-border)] bg-[var(--reader-bg)] px-2 py-1 text-xs"
          >
            <option value="">系统默认</option>
            {matchingVoices.map((v) => (
              <option key={v.name} value={v.name}>
                {v.name}
              </option>
            ))}
          </select>
        </label>
      )}

      <label className="flex items-center gap-3 text-xs">
        <span className="w-12 shrink-0 text-[var(--reader-muted)]">语速</span>
        <input
          type="range"
          min={0.5}
          max={2}
          step={0.05}
          value={rate}
          onChange={(e) => setRate(Number(e.target.value))}
          className="flex-1 accent-[var(--reader-accent)]"
        />
        <span className="w-8 text-right tabular-nums">{rate.toFixed(2)}</span>
      </label>

      <label className="flex items-center justify-between gap-3 text-xs">
        <span className="text-[var(--reader-muted)]">读完自动下一段</span>
        <input
          type="checkbox"
          checked={autoContinue}
          onChange={(e) => setAutoContinue(e.target.checked)}
          className="h-4 w-4 accent-[var(--reader-accent)]"
        />
      </label>

      <p className="text-[11px] leading-relaxed text-[var(--reader-muted)]">
        浏览器原生朗读免费且离线可用，音色取决于操作系统；若已配置云端代理，会自动优先使用云端音色。
      </p>
    </section>
  );
}
