/**
 * 翻译 / 语音合成的边缘代理（Cloudflare Worker）。
 *
 * 存在的唯一理由：API 密钥绝对不能进浏览器。
 * 前端代码、构建产物、localStorage 对用户都是完全可见的，
 * 任何写在前端的密钥都等同于公开。因此所有付费调用统一走这个 Worker，
 * 密钥只存在于 Worker 的加密环境变量中。
 *
 * 部署：
 *   npx wrangler secret put DEEPL_API_KEY
 *   npx wrangler secret put OPENAI_API_KEY
 *   npx wrangler secret put AZURE_SPEECH_KEY
 *   npx wrangler deploy
 *
 * 另需在 wrangler.toml 里配置 ALLOWED_ORIGIN，把跨域限制锁到自己的站点，
 * 否则你的代理会成为任何人都能白嫖的免费翻译接口。
 */

export interface Env {
  DEEPL_API_KEY?: string;
  OPENAI_API_KEY?: string;
  AZURE_SPEECH_KEY?: string;
  AZURE_SPEECH_REGION?: string;
  /** 允许的前端来源，例如 https://reader.example.com */
  ALLOWED_ORIGIN?: string;
  /** 简单的每日配额，防止密钥被刷爆 */
  RATE_LIMITER?: { limit: (options: { key: string }) => Promise<{ success: boolean }> };
}

const MAX_TEXT_LENGTH = 4000;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    if (request.method !== 'POST') {
      return json({ error: '只接受 POST 请求' }, 405, cors);
    }

    // 限流：以来源 IP 为键。生产环境建议换成 Cloudflare 的 Rate Limiting 绑定
    if (env.RATE_LIMITER) {
      const key = request.headers.get('cf-connecting-ip') ?? 'anonymous';
      const { success } = await env.RATE_LIMITER.limit({ key });
      if (!success) return json({ error: '请求过于频繁，请稍后再试' }, 429, cors);
    }

    try {
      const body = (await request.json()) as Record<string, unknown>;

      switch (url.pathname) {
        case '/api/translate':
          return await handleTranslate(body, env, cors);
        case '/api/tts':
          return await handleTts(body, env, cors);
        default:
          return json({ error: `未知端点 ${url.pathname}` }, 404, cors);
      }
    } catch (err) {
      return json({ error: `代理内部错误：${(err as Error).message}` }, 500, cors);
    }
  },
};

async function handleTranslate(
  body: Record<string, unknown>,
  env: Env,
  cors: Record<string, string>,
): Promise<Response> {
  const text = asString(body.text);
  const targetLang = asString(body.targetLang);
  const engine = asString(body.engine) || 'deepl';
  const context = asString(body.context);

  if (!text || !targetLang) return json({ error: '缺少 text 或 targetLang' }, 400, cors);
  if (text.length > MAX_TEXT_LENGTH) {
    return json({ error: `单次翻译不超过 ${MAX_TEXT_LENGTH} 字符` }, 413, cors);
  }

  if (engine === 'openai') {
    if (!env.OPENAI_API_KEY) return json({ error: '未配置 OPENAI_API_KEY' }, 500, cors);
    const translatedText = await translateWithOpenAI(text, targetLang, context, env.OPENAI_API_KEY);
    return json({ translatedText, engine: 'openai' }, 200, cors);
  }

  if (!env.DEEPL_API_KEY) return json({ error: '未配置 DEEPL_API_KEY' }, 500, cors);

  // DeepL 免费版与付费版域名不同，用 key 后缀自动判断，避免部署时踩坑
  const host = env.DEEPL_API_KEY.endsWith(':fx')
    ? 'https://api-free.deepl.com'
    : 'https://api.deepl.com';

  const resp = await fetch(`${host}/v2/translate`, {
    method: 'POST',
    headers: {
      Authorization: `DeepL-Auth-Key ${env.DEEPL_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text: [text],
      target_lang: normalizeDeepLTarget(targetLang),
      // 保留原文的换行结构，否则译文段落会被合并
      preserve_formatting: true,
    }),
  });

  if (!resp.ok) {
    const detail = await resp.text();
    return json({ error: `DeepL 返回 ${resp.status}`, detail }, resp.status, cors);
  }

  const data = (await resp.json()) as { translations?: { text: string }[] };
  const translatedText = data.translations?.[0]?.text;
  if (!translatedText) return json({ error: 'DeepL 未返回译文' }, 502, cors);

  return json({ translatedText, engine: 'deepl' }, 200, cors);
}

/**
 * 用 OpenAI 翻译。
 *
 * 单独走一个 prompt 而不是直接给句子：带上前后文与"只输出译文"的约束，
 * 实测能显著减少模型自作主张加解释、加引号的情况，
 * 也避免译文比原文长好几倍把版面撑开。
 */
async function translateWithOpenAI(
  text: string,
  targetLang: string,
  context: string,
  apiKey: string,
): Promise<string> {
  const system = [
    'You are a translation engine.',
    `Translate the user's text into ${targetLang}.`,
    'Output ONLY the translation, with no explanation, no quotes, no preamble.',
    'Preserve the original paragraph breaks and inline punctuation style.',
    context ? `For context only, the surrounding text is: ${context.slice(0, 500)}` : '',
  ]
    .filter(Boolean)
    .join(' ');

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: text },
      ],
    }),
  });

  if (!resp.ok) {
    const detail = await resp.text();
    throw new Error(`OpenAI 返回 ${resp.status}：${detail.slice(0, 200)}`);
  }

  const data = (await resp.json()) as { choices?: { message?: { content?: string } }[] };
  const out = data.choices?.[0]?.message?.content?.trim();
  if (!out) throw new Error('OpenAI 未返回译文');
  return out;
}

/**
 * 语音合成（Azure Speech）。
 * 返回音频二进制而不是 JSON：前端拿到 Blob 直接交给 <audio> 播放，
 * 省掉 base64 编码带来的 33% 体积膨胀。
 */
async function handleTts(
  body: Record<string, unknown>,
  env: Env,
  cors: Record<string, string>,
): Promise<Response> {
  const text = asString(body.text);
  const lang = asString(body.lang) || 'zh-CN';
  const rate = Number(body.rate ?? 1);

  if (!text) return json({ error: '缺少 text' }, 400, cors);
  if (text.length > MAX_TEXT_LENGTH) {
    return json({ error: `单次合成不超过 ${MAX_TEXT_LENGTH} 字符` }, 413, cors);
  }
  if (!env.AZURE_SPEECH_KEY || !env.AZURE_SPEECH_REGION) {
    return json({ error: '未配置 Azure 语音密钥或区域' }, 500, cors);
  }

  const voice = pickAzureVoice(lang, asString(body.voice));
  // Azure 用百分比表示语速，前端传的是倍数
  const ratePercent = `${Math.round((clamp(rate, 0.5, 2) - 1) * 100)}%`;

  const ssml = `<speak version='1.0' xml:lang='${escapeXml(lang)}'>
  <voice name='${escapeXml(voice)}'>
    <prosody rate='${ratePercent}'>${escapeXml(text)}</prosody>
  </voice>
</speak>`;

  const resp = await fetch(
    `https://${env.AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`,
    {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': env.AZURE_SPEECH_KEY,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
        'User-Agent': 'universal-reader',
      },
      body: ssml,
    },
  );

  if (!resp.ok) {
    const detail = await resp.text();
    return json({ error: `语音合成失败 ${resp.status}`, detail }, resp.status, cors);
  }

  return new Response(resp.body, {
    status: 200,
    headers: { ...cors, 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' },
  });
}

function pickAzureVoice(lang: string, preferred: string): string {
  if (preferred) return preferred;
  const map: Record<string, string> = {
    'zh-CN': 'zh-CN-XiaoxiaoNeural',
    'zh-TW': 'zh-TW-HsiaoChenNeural',
    'en-US': 'en-US-AriaNeural',
    'en-GB': 'en-GB-SoniaNeural',
    'ja-JP': 'ja-JP-NanamiNeural',
    'ko-KR': 'ko-KR-SunHiNeural',
    'fr-FR': 'fr-FR-DeniseNeural',
    'de-DE': 'de-DE-KatjaNeural',
  };
  return map[lang] ?? 'zh-CN-XiaoxiaoNeural';
}

/** DeepL 对部分语言要求带地区变体（如 EN-US / PT-BR） */
function normalizeDeepLTarget(lang: string): string {
  const upper = lang.toUpperCase();
  const map: Record<string, string> = {
    EN: 'EN-US',
    ZH: 'ZH-HANS',
    PT: 'PT-BR',
  };
  return map[upper.split('-')[0] ?? upper] ?? upper;
}

/**
 * 构造 CORS 响应头。
 *
 * ═══════════════════════════════════════════════════════════════
 * 安全要点：未配置 ALLOWED_ORIGIN 时**拒绝一切跨域请求**
 * ═══════════════════════════════════════════════════════════════
 *
 * 这个函数的初版有个危险的默认行为：未配置 ALLOWED_ORIGIN 时
 * **反射请求方的 Origin**，也就是"允许任何人调用"。
 *
 * 后果很实际：这个 Worker 里放着 DeepL / OpenAI / Azure 的付费密钥，
 * 一旦部署就成了**公开的免费翻译接口** —— 任何知道地址的人都能消耗你的额度，
 * 而且是按量计费。部署后忘记配置 ALLOWED_ORIGIN 是很容易发生的事。
 *
 * 现在的策略是 fail-closed（默认拒绝）：
 *
 * | ALLOWED_ORIGIN | 行为 |
 * |---|---|
 * | 未配置 | **不返回任何 CORS 头** → 浏览器拒绝跨域请求 |
 * | 已配置且匹配 | 回显该来源 |
 * | 已配置但不匹配 | **不返回任何 CORS 头** → 浏览器拒绝 |
 *
 * 为什么用"省略头部"而不是返回 `'null'`：`Access-Control-Allow-Origin: null`
 * 并非合法取值（`null` 是给沙箱 iframe 与 data: URL 用的特殊来源），
 * 某些浏览器会因此报出难以理解的 CORS 错误。省略头部是标准做法。
 *
 * 注意：CORS 只约束**浏览器**。直接发起的服务端请求不受影响，
 * 因此它防的是"别人网页白嫖"，不能替代限流。
 * 生产环境建议同时启用 Cloudflare 的 Rate Limiting。
 */
function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('Origin');
  const allowed = env.ALLOWED_ORIGIN?.trim();

  const base: Record<string, string> = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };

  // 未配置来源白名单，或来源不匹配 → 不发放 CORS 许可
  if (!allowed || !origin || origin !== allowed) {
    return base;
  }

  return { ...base, 'Access-Control-Allow-Origin': origin };
}

function json(data: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function clamp(v: number, min: number, max: number): number {
  if (Number.isNaN(v)) return 1;
  return Math.min(max, Math.max(min, v));
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
