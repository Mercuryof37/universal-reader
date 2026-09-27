/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 自建的翻译代理端点，例如 Cloudflare Worker 的公开地址 */
  readonly VITE_TRANSLATE_ENDPOINT?: string;
  /** 自建的 TTS 代理端点 */
  readonly VITE_TTS_ENDPOINT?: string;
  /** 默认翻译引擎，仅作为界面初始值 */
  readonly VITE_DEFAULT_TRANSLATE_ENGINE?: 'deepl' | 'openai' | 'browser';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
