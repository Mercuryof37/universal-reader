/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 自建的翻译代理端点，例如 Cloudflare Worker 的公开地址 */
  readonly VITE_TRANSLATE_ENDPOINT?: string;
  /** 自建的 TTS 代理端点 */
  readonly VITE_TTS_ENDPOINT?: string;
  /** 默认翻译引擎，仅作为界面初始值 */
  readonly VITE_DEFAULT_TRANSLATE_ENGINE?: 'deepl' | 'openai' | 'browser';
  /**
   * OCR 模型的下载来源（检测 / 识别 / 字典三个文件的共同 base）。
   *
   * 留空则走国内可用的 `hf-mirror.com` —— 因为包内置预设指向的
   * `huggingface.co` 在国内不可达，会导致 OCR 永远初始化不了。
   * 也可以填 `/ocr-models` 走自托管（把三个文件放进 public/ocr-models/）。
   */
  readonly VITE_OCR_MODEL_BASE?: string;
  /**
   * 是否允许 OCR 使用 WebGPU 推理（默认关闭）。
   *
   * 关着的时候只用 WASM：慢一些，但**不会因为显卡驱动把整个页面弄崩**。
   * 开着会优先 WebGPU（`['webgpu','wasm']`），在稳定的机器上更快，
   * 但若出现过「识别时页面突然刷新、且没有任何报错」，请保持关闭。
   */
  readonly VITE_OCR_USE_WEBGPU?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
