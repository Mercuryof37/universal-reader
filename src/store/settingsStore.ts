import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { BilingualLayout, HighlightColor, Theme } from '@/types/content';
import {
  detectBrowserTranslator,
  hasCloudTranslationConfig,
  type TranslationEngineId,
} from '@/lib/outboundPaths';

/**
 * 翻译引擎标识从 `lib/outboundPaths.ts` 转出。
 *
 * 为什么定义在那边：`lib/outboundPaths.ts` 需要用它，而这个 store 需要
 * 用那边的能力检测函数。若类型就地定义在这里，两边就形成循环 import
 * （求值顺序决定结果，是那类只在特定打包顺序下才现形的 bug）。
 * 所以类型与能力常量住在叶子里，store 单向依赖它。
 */
export type { TranslationEngineId };


/**
 * TTS 引擎偏好。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么 `'auto'` 被删掉了（而不是保留成别名）
 * ═══════════════════════════════════════════════════════════════
 *
 * 原来有第三个取值 `'auto'`，语义是「构建时配了 VITE_TTS_ENDPOINT 就用云端」。
 * 它的问题不是名字不好，而是**它把「配置」当成了「同意」**：
 * 端点只是一个部署者填的环境变量，与「这个用户同意把正文 POST 到 Azure」
 * 是两件完全不同的事。用户点「朗读」时，他的正文就已经在网线上了，
 * 而界面上一个字都没说 —— 对照 `formulaOcrEnabled`（默认关闭、显式勾选、
 * 代码层第二道防线、界面写清代价），云端朗读**四要素一条都不满足**。
 *
 * 保留 `'auto'` 并让它「变聪明」是错误的修法：只要这个取值还在，
 * 就永远存在一种「用户没做任何动作、内容却外发」的状态。
 * 所以它是被**删除**，而不是被重新解释 —— 云端朗读现在必须由用户
 * 显式选择，且另有 `ttsCloudConsent` 作为第二道防线（见下）。
 */
export type TtsPreference = 'browser' | 'cloud';

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
  /**
   * 是否同意把正文发送到云端语音合成服务。
   *
   * 与 `ttsPreference === 'cloud'` 分开存是**刻意**的：前者是「用户想要什么」，
   * 这个是「用户同意了什么」。两者都在，`createTTSEngine` 才能做第二道防线 ——
   * 即使 `ttsPreference` 被误置（localStorage 可被直接编辑、旧版本残留状态、
   * 将来的新调用方），只要没有显式同意，正文就不会离开本机。
   *
   * ═══════════════════════════════════════════════════════════════
   * 为什么它必须是「一次用户动作」而不是「端点存在」的派生值
   * ═══════════════════════════════════════════════════════════════
   *
   * 这条路径此前是**静默开启**的：`ttsPreference: 'auto'`（原 `:136`）在
   * 构建时配了 `VITE_TTS_ENDPOINT` 的部署上自动走云端，界面上零告知。
   * 而 `vite.config.ts` 的 manifest 当时写着「文档全程留在本机浏览器，
   * 不上传服务器」—— 承诺与代码事实直接冲突。
   *
   * 它与 `formulaOcrEnabled` 是同一类东西，所以采用同一套四要素：
   * 默认 `false` / 由用户勾选 / 外发前再查一次 / 界面写清代价（见
   * `components/TtsVoiceSelector.tsx` 的那段说明）。
   */
  ttsCloudConsent: boolean;
  ttsRate: number;
  ttsPitch: number;
  ttsVoiceName: string | null;
  /** 自动逐段连读 */
  ttsAutoContinue: boolean;

  defaultHighlightColor: HighlightColor;
  /**
   * 初始翻译引擎；`null` = 当前部署下**没有任何可用引擎**。
   *
   * `null` 是一个必须存在、且必须能被界面表达出来的状态：
   * 未配 `VITE_TRANSLATE_ENDPOINT` 的构建 + 不支持 `Translator` 的浏览器
   * （Firefox）就是它。以前这种情况被强行归到 `'browser'`，
   * 于是界面显示「浏览器内置」而每一次翻译都抛错 —— 见 `resolveInitialEngine`。
   */
  defaultTranslationEngine: TranslationEngineId | null;
  /**
   * 是否同意把正文发送到云端翻译服务（DeepL / OpenAI 代理）。
   *
   * 与 `formulaOcrEnabled`、`ttsCloudConsent` 同一套四要素。
   * 注意「配了 `VITE_TRANSLATE_ENDPOINT`」只是**能力**（能不能做），
   * 这个开关才是**许可**（准不准做）—— 二者不可互相替代。
   */
  cloudTranslationConsent: boolean;

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
  /** 用户显式同意/撤回「把正文发往云端语音合成」 */
  setTtsCloudConsent: (consent: boolean) => void;
  setTtsRate: (rate: number) => void;
  setTtsPitch: (pitch: number) => void;
  setTtsVoiceName: (name: string | null) => void;
  setTtsAutoContinue: (v: boolean) => void;
  setDefaultHighlightColor: (color: HighlightColor) => void;
  setDefaultTranslationEngine: (engine: TranslationEngineId | null) => void;
  /** 用户显式同意/撤回「把正文发往云端翻译」 */
  setCloudTranslationConsent: (consent: boolean) => void;
  setFormulaOcrEnabled: (enabled: boolean) => void;
  resetReadingSettings: () => void;
}

/**
 * 决定界面初始的翻译引擎。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么需要这个函数（一个真实的产品缺陷，发作过两次）
 * ═══════════════════════════════════════════════════════════════
 *
 * **第一次发作**：这里原本硬编码 `'deepl'`。`deepl` 与 `openai` 都需要
 * `VITE_TRANSLATE_ENDPOINT` 指向自建代理，该变量为空时 `translateBlock`
 * 会**直接抛错**。于是"未配置代理的部署"上，用户一打开译文开关就收到
 * 「未配置翻译端点」的报错，而他并不知道要先去设置里换引擎。
 * （`.env.example` 还承诺了 `VITE_DEFAULT_TRANSLATE_ENGINE` 可配置，
 * 但代码从未读取它 —— 填了不起任何作用。）
 *
 * **第二次发作**（就是下面这段要防的）：改成「没代理就退到 `'browser'`」，
 * 只解决了「名字指向一个必然失败的云端引擎」，**没有解决「目标引擎本身
 * 是否可用」**。`'browser'` 要求 `globalThis.Translator` 存在，而这个
 * API 在 Firefox 上不存在 —— 而用户主用 Firefox。于是同一条错误链
 * 换了个引擎名继续存在：每一段翻译都抛一次错，错误条刷满屏幕，
 * 用户没有任何出路（`'deepl'` 在这个部署上同样不可用）。
 *
 * ═══════════════════════════════════════════════════════════════
 * 这次是怎么防的，以及为什么不会重演
 * ═══════════════════════════════════════════════════════════════
 *
 * 前两次的共同根因是**同一个错误**：把一个「名字」当成「可用的东西」
 * （先是假定云端可用，后是假定浏览器内置可用）。两次都只改了名字，
 * 没有引入任何**能力事实**，所以病必然再发作一次。
 *
 * 所以这里改成：
 * 1. **先枚举事实**（`detectBrowserTranslator()` / `hasCloudTranslationConfig()`），
 *    再从事实推出候选，最后才谈名字与偏好；
 * 2. **允许 `null`** —— 「一个可用引擎都没有」是一个真实存在的状态，
 *    以前被强行折叠进 `'browser'` 才产生了那条死路。现在它被如实表达，
 *    由界面说清楚「缺什么、去哪里配」（见 `components/TranslationPanel.tsx`），
 *    而不是让用户去撞一条必然失败的路；
 * 3. **自动选择绝不选云端**：没配置 `VITE_DEFAULT_TRANSLATE_ENGINE` 时，
 *    自动结果里**只有** `'browser'` 或 `null`。云端引擎要用户自己选，
 *    且还要 `cloudTranslationConsent` 才真的会发请求（第二道防线在
 *    `services/translationService.ts` 的 `translateWithProxy` 里）。
 *    这条是刻意的：**自动降级只能降级到不外发的那个引擎**。
 *
 * 为什么这次不会重演第三次：任何"再加一个引擎"或"再改一次默认值"的人，
 * 都必须先回答「它在**这台机器**上可用吗」，因为这个函数的签名就是
 * 「从能力事实算出一个候选或 `null`」，没有地方可以写一个裸的引擎名字。
 * 与之配套的测试在两个方向上都有断言（有能力 / 无能力 × 已同意 / 未同意），
 * 见 `store/settingsStore.test.ts` 与 `store/outboundPrivacy.test.ts`。
 */
export function resolveInitialEngine(): TranslationEngineId | null {
  // 1. 先取能力事实
  const cloudOk = hasCloudTranslationConfig();
  const browserOk = detectBrowserTranslator();

  // 2. 显式配置优先 —— 但它同样受能力约束，不能把一个不可用的引擎塞给用户
  const configured = import.meta.env.VITE_DEFAULT_TRANSLATE_ENGINE;
  if (configured === 'deepl' || configured === 'openai') {
    if (cloudOk) return configured;
  } else if (configured === 'browser') {
    if (browserOk) return configured;
    // 显式配了 browser 但这台机器没有这个 API：退回任何可用的，而不是硬塞
    return cloudOk ? 'deepl' : null;
  }

  // 3. 没有显式配置：只往**不外发**的方向降级。
  //    有云端能力也不自动选它 —— 「配了端点」不等于「用户同意上传正文」。
  if (browserOk) return 'browser';
  return null;
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
      // 默认浏览器原生朗读：它免费、离线、不外发任何内容。
      // 「云端」要用户自己选（然后还要 ttsCloudConsent 才会真的发请求）。
      ttsPreference: 'browser',
      ttsCloudConsent: false,
      ttsRate: 1,
      ttsPitch: 1,
      ttsVoiceName: null,
      ttsAutoContinue: true,

      defaultHighlightColor: 'amber',
      // 可能为 null —— 「这台机器上没有任何可用翻译引擎」是必须能被表达的状态
      defaultTranslationEngine: resolveInitialEngine(),
      cloudTranslationConsent: false,
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
      /**
       * 只写偏好，**不动同意位**。
       *
       * 同意只能由界面上那个标注了代价的勾选框写（`setTtsCloudConsent`）。
       * 让下拉框顺手把同意置上会更"顺滑"，但那样「同意」就不再是一个
       * 看得见的动作了 —— 而这次要修的正是「看不见的动作」。
       * 所以：选云端但没勾同意 = 朗读安静地走浏览器原生，
       * 设置面板里会写明为什么（第二道防线见 `services/ttsEngine.ts`）。
       */
      setTtsPreference: (ttsPreference) => set({ ttsPreference }),
      setTtsCloudConsent: (ttsCloudConsent) =>
        set((s) => ({
          ttsCloudConsent,
          // 撤回同意时偏好必须一起收回：否则会留下一个「想用云端、
          // 但没有许可」的矛盾状态，朗读会安静地降级成浏览器原生，
          // 而界面上那个下拉框还写着「云端」—— 那是一种新的不诚实。
          ttsPreference:
            !ttsCloudConsent && s.ttsPreference === 'cloud' ? 'browser' : s.ttsPreference,
        })),
      setTtsRate: (ttsRate) => set({ ttsRate: clamp(ttsRate, 0.5, 2) }),
      setTtsPitch: (ttsPitch) => set({ ttsPitch: clamp(ttsPitch, 0, 2) }),
      setTtsVoiceName: (ttsVoiceName) => set({ ttsVoiceName }),
      setTtsAutoContinue: (ttsAutoContinue) => set({ ttsAutoContinue }),

      setDefaultHighlightColor: (defaultHighlightColor) => set({ defaultHighlightColor }),
      /** 同上：只写引擎偏好，同意由 `setCloudTranslationConsent` 独家负责 */
      setDefaultTranslationEngine: (defaultTranslationEngine) =>
        set({ defaultTranslationEngine }),
      setCloudTranslationConsent: (cloudTranslationConsent) =>
        set((s) => ({
          cloudTranslationConsent,
          // 同 setTtsCloudConsent：撤回同意时不能让界面继续指着云端
          defaultTranslationEngine:
            !cloudTranslationConsent &&
            (s.defaultTranslationEngine === 'deepl' || s.defaultTranslationEngine === 'openai')
              ? detectBrowserTranslator()
                ? 'browser'
                : null
              : s.defaultTranslationEngine,
        })),
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

        /**
         * ═══════════════════════════════════════════════════════════
         * 旧版本残留状态的收敛 —— 「静默升级」必须在这里被掐断
         * ═══════════════════════════════════════════════════════════
         *
         * `localStorage` 里的东西可以是上一个版本写的，而上一版本里
         * `ttsPreference` 有 `'auto'` 这个取值（语义正是「配了端点就用云端」）。
         * 如果放任它读回来，就等于**把一个从未被用户同意过的外发许可
         * 静默升级成了已同意** —— 那正是这次要修的缺陷，只不过换了个入口。
         *
         * 所以两个同意位在**读回时一律归位为 `false`**，无论存的是什么：
         * 同意必须来自本次会话里的一次真实点击。云端偏好本身（用户的偏好）
         * 保留不动 —— 只是没有同意时它不会生效（第二道防线会拦），
         * 界面也会说明原因。`'auto'` 落到 `'browser'`（它已经不是一个合法取值）。
         */
        state.setTtsCloudConsent(false);
        state.setCloudTranslationConsent(false);
        if ((state.ttsPreference as string) === 'auto') state.setTtsPreference('browser');

        /**
         * 引擎的合法性同样收敛一次：旧版本可能存着 `'deepl'` 而本次构建
         * 没有配置 `VITE_TRANSLATE_ENDPOINT`（或存着 `'browser'` 而这台机器
         * 没有 `Translator`）。不收敛的话，用户会撞上「一翻译就报错」。
         */
        const resolved = resolveInitialEngine();
        const current = state.defaultTranslationEngine;
        if (current === 'browser' && !detectBrowserTranslator()) {
          state.setDefaultTranslationEngine(resolved);
        } else if (
          (current === 'deepl' || current === 'openai') &&
          !hasCloudTranslationConfig()
        ) {
          state.setDefaultTranslationEngine(resolved);
        } else if (current && current !== resolved && resolved === null) {
          // 存着一个本次无法满足的偏好，而这次一个可用引擎都没有
          state.setDefaultTranslationEngine(null);
        }
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
