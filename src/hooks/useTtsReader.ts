import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ContentBlock } from '@/types/content';
import { describeUnknownError } from '@/lib/diagnostics';
import {
  BrowserTTSEngine,
  createTTSEngine,
  resolveTtsEngineId,
  type TTSEngine,
  type TTSOptions,
} from '@/services/ttsEngine';
import { useSettingsStore } from '@/store/settingsStore';

/**
 * 朗读控制器。
 *
 * 状态机的关键点：
 * - 引擎实例只创建一次并复用（每次 speak 都 new 一个会导致旧的音频无法停止）；
 * - playingBlockIndex 用下标而不是 block 对象，避免文档更新后引用失效；
 * - 自动连读用 ref 读取最新下标：onEnd 回调是闭包，直接读 state 会读到旧值，
 *   这是这类"连播"功能最常见的 bug 来源。
 */
export function useTtsReader(blocks: ContentBlock[]) {
  const preference = useSettingsStore((s) => s.ttsPreference);
  const cloudConsent = useSettingsStore((s) => s.ttsCloudConsent);
  const rate = useSettingsStore((s) => s.ttsRate);
  const pitch = useSettingsStore((s) => s.ttsPitch);
  const voiceName = useSettingsStore((s) => s.ttsVoiceName);
  const autoContinue = useSettingsStore((s) => s.ttsAutoContinue);
  const ttsLang = useSettingsStore((s) => s.ttsLang);

  const [playingIndex, setPlayingIndex] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const engineRef = useRef<TTSEngine | null>(null);
  const sessionRef = useRef(0);
  const playingIndexRef = useRef<number | null>(null);
  const blocksRef = useRef(blocks);
  const autoContinueRef = useRef(autoContinue);

  blocksRef.current = blocks;
  autoContinueRef.current = autoContinue;
  playingIndexRef.current = playingIndex;

  /** 引擎按偏好懒创建（`createTTSEngine` 内部会再过一次同意位） */
  const getEngine = useCallback((): TTSEngine => {
    if (!engineRef.current) {
      engineRef.current = createTTSEngine(preference);
    }
    return engineRef.current;
  }, [preference]);

  // 切换引擎偏好或**撤回/给出同意**时销毁旧实例。
  //
  // `cloudConsent` 必须在依赖里：撤回同意会让 `createTTSEngine` 改走浏览器
  // 原生，而旧实例是云端引擎 —— 不销毁就会出现「界面说已关闭外发，
  // 而云端引擎还在放上一段音频」，那是一种新的不诚实。
  useEffect(() => {
    return () => {
      engineRef.current?.stop();
      engineRef.current = null;
    };
  }, [preference, cloudConsent]);

  const stop = useCallback(() => {
    sessionRef.current += 1;
    engineRef.current?.stop();
    setPlayingIndex(null);
    playingIndexRef.current = null;
  }, []);

  const speakIndex = useCallback(
    async (index: number) => {
      const block = blocksRef.current[index];
      if (!block) return;

      const session = ++sessionRef.current;
      const engine = getEngine();
      const options: TTSOptions = { rate, pitch, voiceName };

      setPlayingIndex(index);
      playingIndexRef.current = index;

      try {
        await engine.speak(block.content, ttsLang, options);
      } catch (err) {
        if (session === sessionRef.current) setError(describeUnknownError(err));
        return;
      }

      // 被 stop() 或新的 speak 打断时 session 已变，不应继续连读
      if (session !== sessionRef.current) return;
      setPlayingIndex(null);
      playingIndexRef.current = null;

      if (!autoContinueRef.current) return;
      const next = index + 1;
      const nextBlock = blocksRef.current[next];
      if (nextBlock && nextBlock.type !== 'image') {
        await speakIndex(next);
      }
    },
    [getEngine, pitch, rate, ttsLang, voiceName],
  );

  const toggle = useCallback(
    (index: number) => {
      setError(null);
      if (playingIndexRef.current === index || engineRef.current?.isSpeaking()) {
        stop();
        return;
      }
      void speakIndex(index);
    },
    [speakIndex, stop],
  );

  const playFrom = useCallback(
    (index: number) => {
      setError(null);
      stop();
      void speakIndex(index);
    },
    [speakIndex, stop],
  );

  const next = useCallback(() => {
    const current = playingIndexRef.current;
    if (current === null) return;
    playFrom(current + 1);
  }, [playFrom]);

  const prev = useCallback(() => {
    const current = playingIndexRef.current;
    if (current === null || current === 0) return;
    playFrom(current - 1);
  }, [playFrom]);

  const isSpeaking = playingIndex !== null;

  /** 可用音色列表（仅浏览器原生引擎需要展示） */
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  useEffect(() => {
    // 与 `createTTSEngine` 同口径：只有**真的**会走云端时才不取原生音色。
    // 以前这里只看 preference，于是「选了云端但没配端点/没同意」时
    // 音色列表是空的 —— 而实际播放的是浏览器原生，用户选不了音色。
    if (resolveTtsEngineId(preference) === 'cloud') return;
    const engine = new BrowserTTSEngine();
    void engine.getVoices().then(setVoices).catch(() => setVoices([]));
  }, [preference, cloudConsent]);

  /**
   * 此刻实际会用的引擎。
   *
   * 目前只有测试直接消费它 —— 界面侧由 `TtsVoiceSelector` 用**同一个函数**
   * （`resolveTtsEngineId`）自己算一遍，所以两边不可能给出不同答案。
   * 保留在返回值里是为了让「界面显示的引擎」这条事实**可以被断言**，
   * 而不必去渲染组件。
   */
  const activeEngine = resolveTtsEngineId(preference);

  const progress = useMemo(
    () => (playingIndex === null || !blocks.length ? 0 : (playingIndex + 1) / blocks.length),
    [playingIndex, blocks.length],
  );

  return {
    playingIndex,
    isSpeaking,
    progress,
    voices,
    error,
    /** 实际生效的引擎（= 'browser' 时不会外发任何内容） */
    activeEngine,
    clearError: () => setError(null),
    toggle,
    playFrom,
    stop,
    next,
    prev,
  };
}
