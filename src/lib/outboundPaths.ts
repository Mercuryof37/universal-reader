/**
 * 外发路径的**能力检测与代价文案**（本文件是叶子模块，不 import 任何 store）。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么要有这个文件，以及为什么它必须是叶子
 * ═══════════════════════════════════════════════════════════════
 *
 * 这个应用对外的核心承诺是「文档全程留在本机浏览器，不上传服务器」
 * （`vite.config.ts` 的 PWA manifest）。承诺要成立，就必须能回答一个问题：
 * **现在有哪些功能会把文档内容送出本机？** 而答案必须是机器可读的、
 * 与实际生效的开关一致的东西 —— 不能是一段会过期的文档。
 *
 * 背景：`HANDOFF.md` §1 的 T2 把公式 OCR 记成「**唯一**会把文档内容送出
 * 本机的路径」，而实际有**三条**。文档口径与代码事实差了两倍，
 * 于是「本机外发记录」那个审计缺口的真实大小也是三倍。
 * 这就是把清单放进代码、并由设置面板直接渲染的理由：
 * 声明与实现之间没有可以各自漂移的空隙。
 *
 * ⚠️ **本文件不能 import `@/store/*`**。理由是可验证的，不是洁癖：
 * `store/settingsStore.ts` 要用这里的类型与能力常量来决定**初始状态**，
 * 如果这里反过来 import store，就形成 `store ⇄ lib` 的循环依赖。
 * 在 ESM 里那会得到一个「按模块求值顺序而定」的初始化结果 ——
 * 一个只在某些打包顺序下才出现的、极难复现的 bug。
 * 所以这里只放**纯函数与常量**；需要读实时开关状态的
 * `listOutboundPaths()` 放在 `services/translationService.ts`（那里
 * 单向依赖 store，没有环）。
 */

/** 翻译引擎标识。定义在这里而不是 store 里，正是为了打断上面说的那个环。 */
export type TranslationEngineId = 'deepl' | 'openai' | 'browser';

/** 浏览器内置翻译 API 的全局名字。检测与文档用同一个出处。 */
export const BROWSER_TRANSLATOR_GLOBAL = 'Translator';

/** 云端翻译代理是否已配置（构建期环境变量）—— 这是**能力**，不是**许可** */
export function hasCloudTranslationConfig(): boolean {
  return Boolean(import.meta.env.VITE_TRANSLATE_ENDPOINT);
}

/** 云端语音代理是否已配置 —— 同样是**能力**，不是**许可** */
export function hasCloudTtsConfig(): boolean {
  return Boolean(import.meta.env.VITE_TTS_ENDPOINT);
}

/**
 * 浏览器是否具备内置翻译能力（`Translator` API）。
 *
 * `Translator` 是**实验性、非 Baseline** 的 API —— MDN 页面顶部标着
 * 「Limited availability / Experimental」，并写明
 * *"This feature is not Baseline because it does not work in some of the
 * most widely-used browsers."*
 * （<https://developer.mozilla.org/en-US/docs/Web/API/Translator>，
 * 本次实测抓取 HTTP 200）。Firefox 上没有它，而那是本项目用户主用的浏览器。
 *
 * 反过来也**不能假定它不存在**：Chromium 系上有，将来别的浏览器也可能实现。
 * 所以这里既不是 `true` 也不是 `false`，而是每次实地读一次全局对象，
 * 并且是 `typeof === 'function'`（静态方法挂在构造函数上）或 `'object'`
 * （不同实现对命名空间的暴露方式不同）两种形态都接受 —— 只认一种，
 * 会在某个浏览器上把「可用」误判成「不可用」。
 */
export function detectBrowserTranslator(): boolean {
  if (typeof globalThis === 'undefined') return false;
  const api = (globalThis as Record<string, unknown>)[BROWSER_TRANSLATOR_GLOBAL];
  return typeof api === 'function' || (typeof api === 'object' && api !== null);
}

/** `Translator` 的姊妹 API（同一份规范），用于拿到合法的源语言标签 */
export function detectLanguageDetector(): boolean {
  if (typeof globalThis === 'undefined') return false;
  const api = (globalThis as Record<string, unknown>).LanguageDetector;
  return typeof api === 'function' || (typeof api === 'object' && api !== null);
}

/**
 * 三条外发路径的静态说明。
 *
 * `key` 与 `store/settingsStore.ts` 里的字段名逐字一致 —— 测试会拿它去
 * `getState()` 里取真实值，所以「清单里写的」与「实际生效的」不可能不一致。
 */
export interface OutboundPathSpec {
  key: OutboundPathKey;
  title: string;
  /** ③ 代价透明：什么内容、发到哪、为什么需要 */
  detail: string;
}

export type OutboundPathKey =
  | 'formulaOcrEnabled'
  | 'cloudTranslationConsent'
  | 'ttsCloudConsent';

/**
 * 顺序即显示顺序。三条都必须满足四要素：
 * ① 默认关闭 ② 用户显式同意 ③ 代码层第二道防线 ④ 代价透明。
 */
export const OUTBOUND_PATH_SPECS: readonly OutboundPathSpec[] = [
  {
    key: 'formulaOcrEnabled',
    title: '公式识别增强',
    detail:
      '把页面上裁剪出的公式区域（一小块 PNG）发到自建 Worker，再转发给第三方 SimpleTex 换 LaTeX。为什么需要：本地模型认不出公式，只能得到乱码。',
  },
  {
    key: 'cloudTranslationConsent',
    title: '云端翻译',
    detail:
      '把正在阅读的段落正文发到自建 Worker，再转发给 DeepL 或 OpenAI 换取译文。为什么需要：浏览器内置翻译在多数浏览器上不可用，且质量不如云端。',
  },
  {
    key: 'ttsCloudConsent',
    title: '云端语音合成',
    detail:
      '把正在朗读的段落正文发到自建 Worker，再转发给 Azure 语音服务换音频。为什么需要：浏览器原生音色取决于操作系统，长文本还会被截断。',
  },
] as const;

/** 某条路径在此部署上是否具备能力（端点已配置 / 浏览器有该 API） */
export function outboundPathCapable(key: OutboundPathKey): boolean {
  switch (key) {
    case 'formulaOcrEnabled':
      // 公式 OCR 与翻译共用同一个 Worker 端点（见 worker/api-proxy.ts 的路由）
      return hasCloudTranslationConfig();
    case 'cloudTranslationConsent':
      return hasCloudTranslationConfig();
    case 'ttsCloudConsent':
      return hasCloudTtsConfig();
  }
}

/** 「本机外发记录」清单里的一项（含**实时**开关状态） */
export interface OutboundPathStatus extends OutboundPathSpec {
  /** 此刻是否真的会外发 */
  enabled: boolean;
  /** 该路径在此部署上是否具备能力 */
  capable: boolean;
}
