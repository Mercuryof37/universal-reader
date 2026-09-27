import type { ContentBlock } from '@/types/content';
import { getCachedTranslation, putCachedTranslation } from '@/lib/db';

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

/** 浏览器内置翻译（Chrome 138+ 的 Translator API），无需网络与密钥 */
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

function getBrowserTranslatorApi(): TranslatorApi | null {
  const api = (globalThis as { Translator?: TranslatorApi }).Translator;
  return api ?? null;
}

export function isBrowserTranslationAvailable(): boolean {
  return getBrowserTranslatorApi() !== null;
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
      '当前浏览器不支持内置翻译（需要较新的 Chrome）。请改用云端翻译，或升级浏览器。',
    );
  }

  const sourceLanguage = 'auto';
  const availability = await api.availability({ sourceLanguage, targetLanguage: targetLang });
  if (availability === 'unavailable') {
    throw new Error(`该浏览器暂不支持翻译到「${targetLang}」。`);
  }

  const translator = await api.create({ sourceLanguage, targetLanguage: targetLang });
  try {
    return await translator.translate(text);
  } finally {
    translator.destroy?.();
  }
}

async function translateWithProxy(req: TranslateRequest): Promise<string> {
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
