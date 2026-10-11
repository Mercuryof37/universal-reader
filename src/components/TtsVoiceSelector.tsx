import { Headphones, Play, SkipBack, SkipForward, Square } from 'lucide-react';
import { useSettingsStore, type TtsPreference } from '@/store/settingsStore';
import { SPEECH_LANGUAGES } from '@/services/translationService';
import { hasCloudTTSConfig, resolveTtsEngineId } from '@/services/ttsEngine';

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
  const cloudConsent = useSettingsStore((s) => s.ttsCloudConsent);
  const setConsent = useSettingsStore((s) => s.setTtsCloudConsent);
  const rate = useSettingsStore((s) => s.ttsRate);
  const setRate = useSettingsStore((s) => s.setTtsRate);
  const voiceName = useSettingsStore((s) => s.ttsVoiceName);
  const setVoiceName = useSettingsStore((s) => s.setTtsVoiceName);
  const autoContinue = useSettingsStore((s) => s.ttsAutoContinue);
  const setAutoContinue = useSettingsStore((s) => s.setTtsAutoContinue);

  const cloudOk = hasCloudTTSConfig();
  /**
   * 实际生效的引擎 —— 与 `useTtsReader` 用同一个函数算，所以界面显示的
   * 与真正在放音的必然是同一个答案。
   */
  const activeEngine = resolveTtsEngineId(preference);
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
          <option value="browser">浏览器原生（离线、不外发）</option>
          <option value="cloud" disabled={!cloudOk}>
            云端合成{cloudOk ? '' : '（未配置）'}
          </option>
        </select>
      </label>

      {/*
        ── 云端语音的显式同意（四要素之②④） ──
        这里以前什么都没有：`ttsPreference` 的默认值是 `'auto'`，语义是
        「构建时配了 VITE_TTS_ENDPOINT 就用云端」—— 也就是说用户点「朗读」
        时正文已经在发往 Azure 的路上了，而界面零告知。
        「配了端点」（部署侧事实）与「用户同意」（用户动作）是两件事，
        这个勾选框就是让后者真实存在的地方。
      */}
      <label className="flex items-start gap-2 rounded-md border border-[var(--reader-border)] p-2 text-[11px] leading-relaxed">
        <input
          type="checkbox"
          checked={cloudConsent}
          disabled={!cloudOk}
          onChange={(e) => setConsent(e.target.checked)}
          className="mt-0.5 accent-[var(--reader-accent)]"
        />
        <span>
          <span className="font-medium">允许把正文发往云端语音服务</span>
          <span className="block text-[var(--reader-muted)]">
            打开后，正在朗读的<span className="font-medium">段落正文</span>会发到自建
            Worker，再由它转发给 <span className="font-medium">Azure 语音服务</span>
            换音频。需要联网，正文会离开本机。
            {!cloudOk && '（本次构建未配置 VITE_TTS_ENDPOINT，暂时无法开启。）'}
            <span className="block">
              默认关闭 —— 不打开就只用浏览器原生朗读，一个字节都不会外发。
            </span>
          </span>
        </span>
      </label>

      {/*
        实际生效的引擎与下拉框写的不一致时，把真相说出来。
        出现条件：选了云端，但没勾同意 / 端点没配 —— 此时 `createTTSEngine`
        会走浏览器原生。不说的话，用户会以为正文已经发出去了（或反过来），
        两种误解都是我们不该制造的。
      */}
      {preference === 'cloud' && activeEngine === 'browser' && (
        <p className="rounded-md border border-amber-400/60 bg-amber-500/10 p-2 text-[11px] leading-relaxed text-amber-800 dark:text-amber-200">
          你选了云端合成，但{cloudConsent ? '本次构建没有配置云端端点' : '还没有允许把正文发往云端'}
          ，所以现在实际用的是<b>浏览器原生朗读</b>（正文不会离开本机）。
          {!cloudConsent && cloudOk && '勾选上面的同意即可启用云端音色。'}
        </p>
      )}

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
        浏览器原生朗读免费、离线，且<b>不会把正文发出本机</b>；音色取决于操作系统。
        云端合成需要你显式允许（见上面的勾选框）—— 配了端点不等于同意上传正文。
      </p>
    </section>
  );
}
