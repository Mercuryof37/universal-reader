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

  /**
   * 扫描件公式识别是否允许调用云端增强（SimpleTex）。
   *
   * ═══════════════════════════════════════════════════════════════
   * 为什么它必须是一个「默认关闭」的开关
   * ═══════════════════════════════════════════════════════════════
   *
   * 公式增强会把页面上裁剪出来的公式区域（一小块 PNG）POST 到自建 Worker，
   * 再由 Worker 转发给第三方 `server.simpletex.cn`。这是整个应用里
   * **唯一会把文档内容送出本机**的路径。
   *
   * 而本应用对外的核心承诺是「文档全程留在本机浏览器，不上传服务器」。
   * 一个会自动触发、无法关闭的上传路径与这句话直接冲突 ——
   * 所以它是**显式选择加入（opt-in）**，默认 `false`：
   * 不打开，就一个字节都不会外发。
   *
   * 关闭时的行为：识别照常进行，只是公式退化为 PaddleOCR 的原始文字结果
   * （可能是一串乱码），并且**完全不发起网络请求**。
   */
  formulaOcrEnabled: boolean;

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
  setFormulaOcrEnabled: (enabled: boolean) => void;
  resetReadingSettings: () => void;
}

export type TranslationEngineId = 'deepl' | 'openai' | 'browser';

/**
 * 决定界面初始的翻译引擎。
 *
 * 优先级：显式配置的环境变量 → 按是否有云端代理自动选择。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么需要这个函数（一个真实的产品缺陷）
 * ═══════════════════════════════════════════════════════════════
 *
 * `deepL` 与 `openai` 都需要 `VITE_TRANSLATE_ENDPOINT` 指向自建代理，
 * 该变量为空时 `translateBlock` 会**直接抛错**。
 *
 * 而这里原本硬编码为 `'deepl'`，于是"未配置代理的部署"会出现一个很差的体验：
 * **用户一打开译文开关就收到「未配置翻译端点」的报错**，
 * 而他并不知道要先去设置里换引擎。
 *
 * 更糟的是 `.env.example` 里已经承诺了 `VITE_DEFAULT_TRANSLATE_ENGINE`
 * 可以配置，但**代码从未读取它** —— 填了不起任何作用。
 *
 * 现在的行为：
 * - 配了代理（VITE_TRANSLATE_ENDPOINT 非空）→ deepl
 * - 没配代理 → browser（浏览器内置翻译，无需密钥）
 * - 显式设置了 VITE_DEFAULT_TRANSLATE_ENGINE → 以它为准
 */
function resolveInitialEngine(): TranslationEngineId {
  const configured = import.meta.env.VITE_DEFAULT_TRANSLATE_ENGINE;
  if (configured === 'deepl' || configured === 'openai' || configured === 'browser') {
    return configured;
  }

  // 没有云端代理时不要默认指向需要代理的引擎，否则用户一开译文就吃报错
  return import.meta.env.VITE_TRANSLATE_ENDPOINT ? 'deepl' : 'browser';
}

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
      defaultTranslationEngine: resolveInitialEngine(),
      // 默认关闭：不显式打开，就不会有任何文档内容离开本机（见 interface 注释）
      formulaOcrEnabled: false,

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
      setFormulaOcrEnabled: (formulaOcrEnabled) => set({ formulaOcrEnabled }),

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
