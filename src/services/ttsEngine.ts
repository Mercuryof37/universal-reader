import { splitForSpeech } from '@/lib/utils';

export interface TTSOptions {
  /** 0.5 - 2.0 */
  rate?: number;
  /** 0 - 2 */
  pitch?: number;
  /** 指定音色；为空则用系统默认 */
  voiceName?: string | null;
  /** 音量 0 - 1 */
  volume?: number;
}

export interface TTSEngine {
  readonly id: 'browser' | 'cloud';
  readonly label: string;
  /** 朗读一段文本，Promise 在朗读结束后 resolve；被 stop() 打断时也 resolve */
  speak(text: string, lang: string, options?: TTSOptions): Promise<void>;
  stop(): void;
  isSpeaking(): boolean;
}

/** 打断当前朗读用的内部信号 */
class StopSignal {
  stopped = false;
  stop() {
    this.stopped = true;
  }
}

/**
 * 浏览器原生 TTS（Web Speech API）。
 *
 * 优点：免费、离线、零延迟、不需要任何配置。
 * 缺点：音色取决于操作系统（Windows 的中文音色与 macOS 差异明显），
 *       且 Chrome 对长文本会在约 15 秒后静默中断。
 *
 * 因此这里主动做了两件事：
 * 1. 把长段落切成短句逐句朗读（同时规避超时中断）；
 * 2. 每句开始前重新设置 lang，避免多语言混排时读错语种。
 */
export class BrowserTTSEngine implements TTSEngine {
  readonly id = 'browser' as const;
  readonly label = '浏览器原生';

  private current: StopSignal | null = null;
  private voicesCache: SpeechSynthesisVoice[] = [];

  static isAvailable(): boolean {
    return typeof window !== 'undefined' && 'speechSynthesis' in window;
  }

  /** 音色列表在部分浏览器是异步填充的，需要监听 voiceschanged */
  async getVoices(): Promise<SpeechSynthesisVoice[]> {
    if (!BrowserTTSEngine.isAvailable()) return [];
    if (this.voicesCache.length) return this.voicesCache;

    const load = () =>
      new Promise<SpeechSynthesisVoice[]>((resolve) => {
        const voices = speechSynthesis.getVoices();
        if (voices.length) return resolve(voices);
        const timer = setTimeout(() => resolve(speechSynthesis.getVoices()), 1200);
        speechSynthesis.addEventListener(
          'voiceschanged',
          () => {
            clearTimeout(timer);
            resolve(speechSynthesis.getVoices());
          },
          { once: true },
        );
      });

    this.voicesCache = await load();
    return this.voicesCache;
  }

  async speak(text: string, lang: string, options: TTSOptions = {}): Promise<void> {
    if (!BrowserTTSEngine.isAvailable()) {
      throw new Error('当前浏览器不支持语音合成（Web Speech API）。');
    }

    this.stop();
    const signal = new StopSignal();
    this.current = signal;

    const voices = await this.getVoices();
    const voice = pickVoice(voices, lang, options.voiceName ?? null);
    const chunks = splitForSpeech(text, 180);

    for (const chunk of chunks) {
      if (signal.stopped) break;
      await this.speakChunk(chunk, lang, voice, options, signal);
    }

    if (this.current === signal) this.current = null;
  }

  private speakChunk(
    text: string,
    lang: string,
    voice: SpeechSynthesisVoice | null,
    options: TTSOptions,
    signal: StopSignal,
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = voice?.lang ?? lang;
      utterance.rate = clamp(options.rate ?? 1, 0.5, 2);
      utterance.pitch = clamp(options.pitch ?? 1, 0, 2);
      utterance.volume = clamp(options.volume ?? 1, 0, 1);
      if (voice) utterance.voice = voice;

      // onend / onerror 在部分浏览器可能都不触发，加一个按文本长度估算的兜底计时器
      const guardMs = Math.max(4000, text.length * 220);
      const timer = setTimeout(finish, guardMs);
      let done = false;

      function finish() {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      }

      utterance.onend = finish;
      utterance.onerror = finish;
      // 被 stop() 打断时 speechSynthesis.cancel() 会触发 onerror/onend，正常 resolve

      if (signal.stopped) {
        finish();
        return;
      }
      speechSynthesis.speak(utterance);
    });
  }

  stop(): void {
    this.current?.stop();
    this.current = null;
    if (BrowserTTSEngine.isAvailable()) speechSynthesis.cancel();
  }

  isSpeaking(): boolean {
    return BrowserTTSEngine.isAvailable() && speechSynthesis.speaking;
  }
}

/**
 * 云端 TTS 引擎。
 *
 * 音频由自建的代理端点返回（见 worker/tts-proxy.ts），
 * 密钥只存在服务端，浏览器拿不到——这是本方案里唯一推荐的密钥保管方式。
 *
 * 内置 Blob 缓存：同一段落重复朗读（比如来回翻页）不会重复计费。
 */
export class CloudTTSEngine implements TTSEngine {
  readonly id = 'cloud' as const;
  readonly label = '云端合成';

  private audio: HTMLAudioElement | null = null;
  private controller: AbortController | null = null;
  private cache = new Map<string, Blob>();
  private objectUrls = new Set<string>();

  constructor(private endpoint = '/api/tts') {}

  async speak(text: string, lang: string, options: TTSOptions = {}): Promise<void> {
    this.stop();
    const chunks = splitForSpeech(text, 220);

    for (const chunk of chunks) {
      const blob = await this.fetchChunk(chunk, lang, options);
      if (!blob) return; // 已被 stop()
      await this.playBlob(blob);
    }
  }

  private async fetchChunk(
    text: string,
    lang: string,
    options: TTSOptions,
  ): Promise<Blob | null> {
    const key = `${lang}|${options.rate ?? 1}|${options.pitch ?? 1}|${options.voiceName ?? ''}|${text}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    this.controller = new AbortController();
    try {
      const resp = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          lang,
          rate: options.rate,
          pitch: options.pitch,
          voice: options.voiceName,
        }),
        signal: this.controller.signal,
      });

      if (!resp.ok) {
        const detail = await resp.text().catch(() => '');
        throw new Error(`云端语音合成失败（HTTP ${resp.status}）${detail ? `：${detail}` : ''}`);
      }

      const blob = await resp.blob();
      // 缓存上限：只留最近 60 段，避免长时间朗读把内存吃满
      if (this.cache.size > 60) {
        const oldest = this.cache.keys().next().value;
        if (oldest) this.cache.delete(oldest);
      }
      this.cache.set(key, blob);
      return blob;
    } catch (err) {
      if ((err as Error).name === 'AbortError') return null;
      throw err;
    }
  }

  private playBlob(blob: Blob): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      this.objectUrls.add(url);
      const audio = new Audio(url);
      this.audio = audio;

      const cleanup = () => {
        URL.revokeObjectURL(url);
        this.objectUrls.delete(url);
      };

      audio.onended = () => {
        cleanup();
        resolve();
      };
      audio.onerror = () => {
        cleanup();
        reject(new Error('音频播放失败，可能是浏览器自动播放策略拦截（需用户先点击页面）。'));
      };
      audio.onpause = () => {
        cleanup();
        resolve();
      };

      void audio.play().catch(reject);
    });
  }

  stop(): void {
    this.controller?.abort();
    this.controller = null;
    if (this.audio) {
      this.audio.pause();
      this.audio = null;
    }
    for (const url of this.objectUrls) URL.revokeObjectURL(url);
    this.objectUrls.clear();
  }

  isSpeaking(): boolean {
    return this.audio !== null && !this.audio.paused;
  }
}

/** 按语言挑选最合适的音色：优先精确匹配 lang，其次匹配语言主标签 */
export function pickVoice(
  voices: SpeechSynthesisVoice[],
  lang: string,
  preferredName: string | null,
): SpeechSynthesisVoice | null {
  if (preferredName) {
    const exact = voices.find((v) => v.name === preferredName);
    if (exact) return exact;
  }

  const target = lang.toLowerCase();
  const primary = target.split('-')[0] ?? target;

  return (
    voices.find((v) => v.lang.toLowerCase() === target) ??
    voices.find((v) => v.lang.toLowerCase().replace('_', '-') === target) ??
    voices.find((v) => v.lang.toLowerCase().startsWith(primary)) ??
    voices.find((v) => v.default) ??
    null
  );
}

/** 云端代理是否已配置（由构建期环境变量决定） */
export function hasCloudTTSConfig(): boolean {
  return Boolean(import.meta.env.VITE_TTS_ENDPOINT);
}

/**
 * 引擎选择策略：把"降级"写在一个地方。
 * auto 模式下有云端配置用云端，否则用浏览器原生——保证功能永远不会因为没配密钥而不可用。
 */
export function createTTSEngine(preference: 'auto' | 'browser' | 'cloud'): TTSEngine {
  if (preference === 'cloud') {
    const endpoint = import.meta.env.VITE_TTS_ENDPOINT;
    if (!endpoint) {
      throw new Error('未配置云端语音端点（VITE_TTS_ENDPOINT），请改用浏览器原生朗读。');
    }
    return new CloudTTSEngine(endpoint);
  }
  if (preference === 'browser') return new BrowserTTSEngine();
  return hasCloudTTSConfig()
    ? new CloudTTSEngine(import.meta.env.VITE_TTS_ENDPOINT)
    : new BrowserTTSEngine();
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}
