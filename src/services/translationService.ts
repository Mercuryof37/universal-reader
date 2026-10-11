import type { ContentBlock } from '@/types/content';
import { getCachedTranslation, putCachedTranslation } from '@/lib/db';
import { detectLanguage } from '@/lib/utils';
import {
  OUTBOUND_PATH_SPECS,
  outboundPathCapable,
  type OutboundPathStatus,
} from '@/lib/outboundPaths';
import { useSettingsStore } from '@/store/settingsStore';

export type TranslationEngine = 'deepl' | 'openai' | 'browser';

export interface TranslationResult {
  translatedText: string;
  engine: TranslationEngine;
  /** 是否命中本地缓存（命中则不计费、不等待网络） */
  cached: boolean;
}

export interface TranslateRequest {
  text: string;
  targetLang: string;
  /** 前后文，用于消歧；代理端可拼进 prompt，提升长文翻译一致性 */
  context?: string;
  engine?: TranslationEngine;
  signal?: AbortSignal;
}

/** 前端不做任何密钥管理：所有密钥都在代理端点（Cloudflare Worker）的环境变量里 */
function translateEndpoint(): string {
  const endpoint = import.meta.env.VITE_TRANSLATE_ENDPOINT;
  if (!endpoint) {
    throw new Error(
      '未配置翻译端点（VITE_TRANSLATE_ENDPOINT）。请在 .env.local 中填写自建代理地址，或把翻译引擎切成「浏览器内置」。',
    );
  }
  return endpoint;
}

/**
 * 浏览器内置翻译（Chrome 138+ 的 Translator API），无需网络与密钥。
 *
 * ═══════════════════════════════════════════════════════════════
 * 这个 API 有两个「不能假定」的地方，都在下面被显式照顾了
 * ═══════════════════════════════════════════════════════════════
 *
 * 1. **它可能整个不存在**。MDN 把它标为 *Limited availability / Experimental*，
 *    并写明「不是 Baseline，因为在一些最广泛使用的浏览器里不工作」
 *    （<https://developer.mozilla.org/en-US/docs/Web/API/Translator>，本次实测
 *    抓取 HTTP 200）。Firefox 上没有它 —— 而那是本项目用户主用的浏览器。
 *    所以 `getBrowserTranslatorApi()` 返回 `null` 而不是假定存在，
 *    上层据此走「安静降级」而不是抛错刷屏。
 *
 * 2. **它的 `sourceLanguage` 必须是合法的 BCP 47 语言标签**，没有
 *    「自动检测」这种取值。规范原文（WebML CG Draft，2026-08-10，
 *    <https://webmachinelearning.github.io/translation-api/>）：
 *    *"A string specifying the expected language of the input text to be
 *    translated, which should be a valid BCP 47 language tag"*，
 *    且 `TranslatorCreateOptions` 里 `sourceLanguage` 是
 *    **`required DOMString`**（没有省略即自动检测这回事）。
 *
 *    本条是本次核实查出来的**第三个缺陷**，调研没有提到它：
 *    原代码传的是 `sourceLanguage: 'auto'`。用规范自己指定的那套校验算法
 *    （ECMA-402 的 language tag validation）实测，`'auto'` 不是合法标签 ——
 *    Node 25.2.1 实测输出：
 *
 *      node -e "new Intl.Locale('auto')"
 *      → RangeError: Incorrect locale information provided
 *      （同一次实测里 'en' / 'zh' / 'zh-Hans' / 'EN-us' 全部通过，
 *        所以这个 RangeError 不是环境问题）
 *
 *    也就是说：**即使在支持这个 API 的 Chrome 上，浏览器内置翻译也从来
 *    没有成功过一次** —— 它每次都会以 `NotSupportedError`
 *    （"language tags … are invalid"）失败。把死路归因于「Firefox 没有这个
 *    API」是不完整的；真正的事实是**所有浏览器上这条路都是死的**，
 *    只是死法不同。所以下面改用真实的源语言（先 `LanguageDetector`，
 *    退到项目自己的 `detectLanguage` 启发式）。
 */
interface TranslatorInstance {
  translate: (text: string) => Promise<string>;
  destroy?: () => void;
}
interface TranslatorApi {
  availability: (opts: { sourceLanguage: string; targetLanguage: string }) => Promise<string>;
  create: (opts: {
    sourceLanguage: string;
    targetLanguage: string;
  }) => Promise<TranslatorInstance>;
}

/** `Translator` 的姊妹 API（同一份规范）：用来拿到合法的源语言标签 */
interface LanguageDetectorInstance {
  detect: (text: string) => Promise<{ detectedLanguage: string; confidence: number }[]>;
  destroy?: () => void;
}
interface LanguageDetectorApi {
  create: () => Promise<LanguageDetectorInstance>;
}

function getBrowserTranslatorApi(): TranslatorApi | null {
  const api = (globalThis as { Translator?: TranslatorApi }).Translator;
  return api ?? null;
}

function getLanguageDetectorApi(): LanguageDetectorApi | null {
  const api = (globalThis as { LanguageDetector?: LanguageDetectorApi }).LanguageDetector;
  return api ?? null;
}

export function isBrowserTranslationAvailable(): boolean {
  return getBrowserTranslatorApi() !== null;
}

/**
 * 选定一个**合法**的源语言标签。
 *
 * 顺序：浏览器自带的 `LanguageDetector`（同规范、同实现，最准）
 *   → 项目自己的 `detectLanguage` 启发式（`lib/utils.ts:142`，无需任何 API）
 *
 * 为什么要有兜底而不是「拿不到就不用」：启发式只需要文本本身，
 * 所以在能跑 `Translator` 的浏览器上它一定也有值。这样浏览器内置翻译
 * 才真正可用，而不是被一个缺失的检测器挡死。
 *
 * 同语言短路：源语言与目标语言相同时规范会直接返回 `unavailable`
 * （见 `availability()` 的说明），所以这种情况必须提前认出来并如实告知，
 * 而不是发一次注定失败的请求。
 */
async function resolveSourceLanguage(text: string, targetLang: string): Promise<string | null> {
  const target = normalizeLangTag(targetLang);

  const detectorApi = getLanguageDetectorApi();
  if (detectorApi) {
    try {
      const detector = await detectorApi.create();
      try {
        const results = await detector.detect(text);
        const best = results?.[0]?.detectedLanguage;
        if (best) {
          const normalized = normalizeLangTag(best);
          if (normalized && normalized !== target) return normalized;
          if (normalized === target) return null; // 同语言，无需翻译
        }
      } finally {
        detector.destroy?.();
      }
    } catch {
      // 检测器不可用不该让整条翻译路径失效 —— 落到下面的启发式
    }
  }

  const heuristic = normalizeLangTag(detectLanguage(text));
  if (!heuristic || heuristic === target) return null;
  return heuristic;
}

/**
 * 把语言标签收敛成「主标签 + 可选的文字系统」。
 *
 * 为什么不能原样透传：`detectLanguage` 给出的是 `zh` / `en` / `ja` / `ko`
 * 这样的粗标签，而 `Translator` 按 BCP 47 匹配语言弧；`zh` 会被 best-fit
 * 到 `zh-Hans`（规范里明确举过这个例子），这正是我们要的。
 * 这里只做小写主标签校正，不做任何猜测性扩展 —— 猜错文字系统
 * （简体/繁体）比不猜更糟：用户会拿到一堆繁体字还不知道为什么。
 */
function normalizeLangTag(tag: string): string | null {
  const primary = tag.trim().split(/[-_]/)[0]?.toLowerCase();
  if (!primary || !/^[a-z]{2,3}$/.test(primary)) return null;
  try {
    // 用规范自己指定的那套校验（ECMA-402）确认它是合法标签再交出去。
    // 这一步同时挡住 'auto' 这类「看起来像语言、其实不是」的取值。
    return new Intl.Locale(primary).toString();
  } catch {
    return null;
  }
}

/**
 * 单块翻译主入口。
 *
 * 关键设计：缓存优先。
 * 翻译是按字符计费的，而阅读场景里"同一句话被反复看到"极其常见
 * （重开文档、来回翻页、多文档引用同一段落），
 * 所以缓存键只用「原文 + 目标语言」的哈希，不绑文档 id，天然跨文档复用。
 */
export async function translateBlock(
  block: ContentBlock,
  targetLang: string,
  options: { context?: string; engine?: TranslationEngine; signal?: AbortSignal } = {},
): Promise<TranslationResult> {
  const engine = options.engine ?? 'deepl';
  const text = block.content.trim();

  if (!text) return { translatedText: '', engine, cached: false };

  // 1. 内存里已有的译文（当前会话内重复渲染时直接返回）
  const inMemory = block.translations[targetLang];
  if (inMemory) return { translatedText: inMemory, engine, cached: true };

  // 2. IndexedDB 缓存
  const cached = await getCachedTranslation(text, targetLang);
  if (cached) return { translatedText: cached.text, engine: cached.engine as TranslationEngine, cached: true };

  // 3. 真正发起翻译
  const translatedText =
    engine === 'browser'
      ? await translateWithBrowser(text, targetLang)
      : await translateWithProxy({ ...options, text, targetLang, engine });

  await putCachedTranslation(text, targetLang, translatedText, engine);

  return { translatedText, engine, cached: false };
}

async function translateWithBrowser(text: string, targetLang: string): Promise<string> {
  const api = getBrowserTranslatorApi();
  if (!api) {
    throw new Error(
      '当前浏览器不支持内置翻译（需要 Chromium 138+ 的 Translator API）。可在设置里改用云端翻译，或换用支持该 API 的浏览器。',
    );
  }

  const sourceLanguage = await resolveSourceLanguage(text, targetLang);
  if (!sourceLanguage) {
    throw new Error(
      `这段文字看起来已经是「${targetLang}」，无需翻译。（浏览器内置翻译不支持「自动检测」源语言，所以这里先做了语言判定。）`,
    );
  }

  const availability = await api.availability({ sourceLanguage, targetLanguage: targetLang });
  if (availability === 'unavailable') {
    throw new Error(
      `浏览器内置翻译不支持从「${sourceLanguage}」到「${targetLang}」。可以换个目标语言，或改用云端翻译。`,
    );
  }

  /**
   * `create()` 的失败要分类处理，不能一律当成"浏览器不支持"。
   *
   * 规范列出四种异常（`NotAllowedError` / `NotSupportedError` /
   * `NetworkError` / `OperationError`），它们的**出路完全不同**：
   * 把「模型还在下载，网断了」说成「浏览器太旧」，用户就会去换浏览器 ——
   * 换了也没用。这是「诚实」在这个函数里的具体含义。
   */
  let translator: TranslatorInstance;
  try {
    translator = await api.create({ sourceLanguage, targetLanguage: targetLang });
  } catch (err) {
    const name = (err as Error)?.name;
    if (name === 'NotAllowedError') {
      throw new Error(
        '浏览器拒绝了内置翻译（可能需要你点一下页面/允许权限，或站点策略未开放 translator）。可改用云端翻译。',
      );
    }
    if (name === 'NetworkError') {
      throw new Error(
        '内置翻译的模型还没下载完，而当前网络不可用。联网后重试即可，模型只需下载一次。',
      );
    }
    throw new Error(
      `内置翻译初始化失败（${name || '未知错误'}）：${(err as Error)?.message || err}`,
    );
  }

  try {
    return await translator.translate(text);
  } finally {
    translator.destroy?.();
  }
}

/**
 * 走自建代理的云端翻译。
 *
 * ═══════════════════════════════════════════════════════════════
 * 第二道防线：真正发请求的函数自己也要检查「用户同意」
 * ═══════════════════════════════════════════════════════════════
 *
 * 这是三条外发路径之一（另两条见 `services/formulaOcrService.ts` 与
 * `services/ttsEngine.ts`）。三条都遵循同一套四要素：
 * ① 默认关闭 ② 用户显式同意 ③ **代码层第二道防线** ④ 界面写清代价。
 *
 * 为什么第③条不能省：`useViewportTranslation` 会照引擎名调用这里，
 * 而引擎名来自 `localStorage`（可被直接编辑）与旧版本残留状态。
 * 只要没有这道检查，「状态被误置」就直接等于「正文被发出去」。
 * 有了它，误置的后果只是翻译安静地不工作（界面上会说明为什么），
 * 而不是内容外泄 —— **失败的方向必须是安全的那一边**。
 *
 * 这里抛错而不是静默返回原文：静默返回会让上层把「未翻译的原文」
 * 当成译文写进缓存，那是一种更难查的坏。抛错则由 `useViewportTranslation`
 * 收敛成一条设置里的说明。
 */
async function translateWithProxy(req: TranslateRequest): Promise<string> {
  if (!useSettingsStore.getState().cloudTranslationConsent) {
    throw new Error(
      '云端翻译未获同意（cloudTranslationConsent = false），已拒绝发送正文。请在「设置 → 双语对照」中显式开启。',
    );
  }

  const resp = await fetch(translateEndpoint(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: req.text,
      targetLang: req.targetLang,
      context: req.context,
      engine: req.engine,
    }),
    signal: req.signal,
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    if (resp.status === 429) {
      throw new Error('翻译服务限流（429）。免费额度可能已用完，请稍后再试或切换引擎。');
    }
    throw new Error(`翻译请求失败（HTTP ${resp.status}）${detail ? `：${detail}` : ''}`);
  }

  const data = (await resp.json()) as { translatedText?: string };
  if (!data.translatedText) throw new Error('翻译服务返回了空结果。');
  return data.translatedText;
}

/**
 * 把译文写回 block。
 * 注意这里返回新的 block 对象而不是就地修改：
 * zustand 依赖引用变化来触发重渲染，就地改数组元素不会更新界面。
 */
export function withTranslation(
  block: ContentBlock,
  targetLang: string,
  translatedText: string,
): ContentBlock {
  return {
    ...block,
    translations: { ...block.translations, [targetLang]: translatedText },
  };
}

/**
 * 「本机外发记录」：当前有哪些功能会把内容送出本机。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么这份清单必须读实时状态
 * ═══════════════════════════════════════════════════════════════
 *
 * `HANDOFF.md` §1 T2 把公式 OCR 记成「**唯一**会把文档送出本机的路径」，
 * 而实际有**三条**（公式 OCR / 云端翻译 / 云端语音），缺口是三倍。
 * 文档会过期，而这份清单读的是 `useSettingsStore.getState()` ——
 * 所以设置面板显示的就是真实生效的开关，不存在「文档说 A、代码做 B」。
 *
 * 静态文案与能力检测在 `lib/outboundPaths.ts`（叶子模块）；
 * 这里只负责把**实时开关值**贴上去，因此单向依赖 store、无循环。
 */
export function listOutboundPaths(): OutboundPathStatus[] {
  const s = useSettingsStore.getState();
  const enabledOf: Record<string, boolean> = {
    formulaOcrEnabled: s.formulaOcrEnabled,
    // 同意 + （云端翻译没有额外偏好位：同意即生效，但还需要端点能力）
    cloudTranslationConsent: s.cloudTranslationConsent,
    // 语音有额外的偏好位：必须「同意」且「偏好是云端」才真的会发
    ttsCloudConsent: s.ttsCloudConsent && s.ttsPreference === 'cloud',
  };

  return OUTBOUND_PATH_SPECS.map((spec) => ({
    ...spec,
    enabled: enabledOf[spec.key] ?? false,
    capable: outboundPathCapable(spec.key),
  }));
}

/** 是否有任何一条外发路径处于开启状态 */
export function hasAnyOutboundEnabled(): boolean {
  return listOutboundPaths().some((p) => p.enabled);
}

/** 常用目标语言；只列阅读场景里真正会用到的 */
export const TARGET_LANGUAGES: { code: string; label: string }[] = [
  { code: 'zh', label: '中文' },
  { code: 'en', label: 'English' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'es', label: 'Español' },
  { code: 'ru', label: 'Русский' },
];

/** 朗读语言选项 */
export const SPEECH_LANGUAGES: { code: string; label: string }[] = [
  { code: 'zh-CN', label: '普通话' },
  { code: 'zh-TW', label: '國語（台灣）' },
  { code: 'en-US', label: 'English (US)' },
  { code: 'en-GB', label: 'English (UK)' },
  { code: 'ja-JP', label: '日本語' },
  { code: 'ko-KR', label: '한국어' },
  { code: 'fr-FR', label: 'Français' },
  { code: 'de-DE', label: 'Deutsch' },
];
