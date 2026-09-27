import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { BilingualLayout, HighlightColor, Theme } from '@/types/content';

/** TTS 引擎偏好；auto = 有云端配置就用云端，否则退回浏览器原生 */
export type TtsPreference = 'auto' | 'browser' | 'cloud';

/**
 * 阅读设置 store。
 *
 * 只放"纯设置"：这些数据量小、变化频繁、需要刷新后立刻可用，
 * 因此用 zustand/persist 直接写 localStorage。
 * 文档、批注、译文这些大数据一律走 IndexedDB（见 lib/db.ts），
 * 混在一起会导致每次改字号都触发一次 IndexedDB 写入。
 */
interface SettingsState {
  theme: Theme;
  fontSize: number;
  lineHeight: number;
  contentWidth: number;
  fontFamily: 'serif' | 'sans';

  primaryLang: string;
  translationTargetLang: string;
  showTranslation: boolean;
  bilingualLayout: BilingualLayout;

  ttsLang: string;
  ttsPreference: TtsPreference;
  ttsRate: number;
  ttsPitch: number;
  ttsVoiceName: string | null;
  /** 自动逐段连读 */
  ttsAutoContinue: boolean;

  defaultHighlightColor: HighlightColor;
  defaultTranslationEngine: TranslationEngineId;

  setTheme: (theme: Theme) => void;
  setFontSize: (size: number) => void;
  setLineHeight: (v: number) => void;
  setContentWidth: (px: number) => void;
  setFontFamily: (v: 'serif' | 'sans') => void;
  setPrimaryLang: (lang: string) => void;
  setTranslationTargetLang: (lang: string) => void;
  setShowTranslation: (show: boolean) => void;
  setBilingualLayout: (layout: BilingualLayout) => void;
  setTtsLang: (lang: string) => void;
  setTtsPreference: (pref: TtsPreference) => void;
  setTtsRate: (rate: number) => void;
  setTtsPitch: (pitch: number) => void;
  setTtsVoiceName: (name: string | null) => void;
  setTtsAutoContinue: (v: boolean) => void;
  setDefaultHighlightColor: (color: HighlightColor) => void;
  setDefaultTranslationEngine: (engine: TranslationEngineId) => void;
  resetReadingSettings: () => void;
}

export type TranslationEngineId = 'deepl' | 'openai' | 'browser';

const READING_DEFAULTS = {
  theme: 'scroll' as Theme,
  fontSize: 18,
  lineHeight: 1.9,
  contentWidth: 720,
  fontFamily: 'serif' as const,
};

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      ...READING_DEFAULTS,

      primaryLang: 'auto',
      translationTargetLang: 'zh',
      showTranslation: false,
      bilingualLayout: 'stacked',

      ttsLang: 'zh-CN',
      ttsPreference: 'auto',
      ttsRate: 1,
      ttsPitch: 1,
      ttsVoiceName: null,
      ttsAutoContinue: true,

      defaultHighlightColor: 'amber',
      defaultTranslationEngine: 'deepl',

      setTheme: (theme) => set({ theme }),
      setFontSize: (fontSize) => set({ fontSize: clamp(fontSize, 12, 32) }),
      setLineHeight: (lineHeight) => set({ lineHeight: clamp(lineHeight, 1.2, 3) }),
      setContentWidth: (contentWidth) => set({ contentWidth: clamp(contentWidth, 480, 1200) }),
      setFontFamily: (fontFamily) => set({ fontFamily }),

      setPrimaryLang: (primaryLang) => set({ primaryLang }),
      setTranslationTargetLang: (translationTargetLang) => set({ translationTargetLang }),
      setShowTranslation: (showTranslation) => set({ showTranslation }),
      setBilingualLayout: (bilingualLayout) => set({ bilingualLayout }),

      setTtsLang: (ttsLang) => set({ ttsLang }),
      setTtsPreference: (ttsPreference) => set({ ttsPreference }),
      setTtsRate: (ttsRate) => set({ ttsRate: clamp(ttsRate, 0.5, 2) }),
      setTtsPitch: (ttsPitch) => set({ ttsPitch: clamp(ttsPitch, 0, 2) }),
      setTtsVoiceName: (ttsVoiceName) => set({ ttsVoiceName }),
      setTtsAutoContinue: (ttsAutoContinue) => set({ ttsAutoContinue }),

      setDefaultHighlightColor: (defaultHighlightColor) => set({ defaultHighlightColor }),
      setDefaultTranslationEngine: (defaultTranslationEngine) =>
        set({ defaultTranslationEngine }),

      resetReadingSettings: () => set({ ...READING_DEFAULTS }),
    }),
    {
      name: 'universal-reader:settings',
      version: 1,
      // 只持久化数据字段，函数不写进 localStorage
      partialize: (state) => {
        const { resetReadingSettings, ...rest } = state;
        void resetReadingSettings;
        return rest as SettingsState;
      },
      onRehydrateStorage: () => (state) => {
        // 字号等数值可能被手工改坏（localStorage 可被直接编辑），读回时统一收敛一次
        if (!state) return;
        state.setFontSize(state.fontSize);
        state.setLineHeight(state.lineHeight);
        state.setContentWidth(state.contentWidth);
      },
    },
  ),
);

function clamp(v: number, min: number, max: number): number {
  if (Number.isNaN(v)) return min;
  return Math.min(max, Math.max(min, v));
}

/** 主题对应的配色令牌，交给 CSS 变量消费 */
export const THEME_TOKENS: Record<Theme, { bg: string; fg: string; label: string }> = {
  scroll: { bg: '#f6f1e4', fg: '#2b2620', label: '宣纸' },
  sepia: { bg: '#efe3cc', fg: '#3a2f22', label: '米黄' },
  dark: { bg: '#1b1a17', fg: '#ded7c9', label: '夜读' },
};
