import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ContentBlock } from '@/types/content';
import { describeUnknownError } from '@/lib/diagnostics';
import {
  BrowserTTSEngine,
  createTTSEngine,
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

  /** 引擎按偏好懒创建；创建失败时降级到浏览器原生 */
  const getEngine = useCallback((): TTSEngine => {
    if (!engineRef.current) {
      engineRef.current = createTTSEngine(preference);
    }
    return engineRef.current;
  }, [preference]);

  // 切换引擎偏好时销毁旧实例，避免"云端引擎还在放音，浏览器引擎又开始读"
  useEffect(() => {
    return () => {
      engineRef.current?.stop();
      engineRef.current = null;
    };
  }, [preference]);

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
    if (preference === 'cloud') return;
    const engine = new BrowserTTSEngine();
    void engine.getVoices().then(setVoices).catch(() => setVoices([]));
  }, [preference]);

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
    clearError: () => setError(null),
    toggle,
    playFrom,
    stop,
    next,
    prev,
  };
}
