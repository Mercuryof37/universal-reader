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
  SIMPLETEX_API_KEY?: string;
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
        case '/api/formula-ocr':
          return await handleFormulaOcr(body, env, cors);
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

/**
 * 公式 OCR（SimpleTex API）。
 *
 * 接收 base64 编码的图片，返回 LaTeX 字符串。
 * SimpleTex 对中文+数学混合排版的识别准确率远超通用 OCR，
 * 且免费额度足够个人使用（2000 次/天）。
 */
async function handleFormulaOcr(
  body: Record<string, unknown>,
  env: Env,
  cors: Record<string, string>,
): Promise<Response> {
  const imageBase64 = asString(body.image);
  if (!imageBase64) return json({ error: '缺少 image（base64）' }, 400, cors);
  if (!env.SIMPLETEX_API_KEY) {
    return json({ error: '未配置 SIMPLETEX_API_KEY' }, 500, cors);
  }

  // base64 大小上限 ~2MB（编码后约 2.7MB）
  if (imageBase64.length > 2_700_000) {
    return json({ error: '图片过大，请裁剪到公式区域后再试' }, 413, cors);
  }

  const formData = new FormData();
  // 将 base64 转为 Blob
  const binaryStr = atob(imageBase64);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
  formData.append('file', new Blob([bytes], { type: 'image/png' }), 'formula.png');

  const resp = await fetch('https://server.simpletex.cn/api/v1/simpletex_recognize', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.SIMPLETEX_API_KEY}`,
    },
    body: formData,
  });

  if (!resp.ok) {
    const detail = await resp.text();
    return json({ error: `SimpleTex 返回 ${resp.status}`, detail }, resp.status, cors);
  }

  const data = (await resp.json()) as {
    res?: { latex?: string };
    status?: boolean;
    message?: string;
  };

  if (!data.res?.latex) {
    return json(
      { error: data.message || 'SimpleTex 未返回 LaTeX' },
      502,
      cors,
    );
  }

  return json({ latex: data.res.latex }, 200, cors);
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
 *
 * ── 支持配置多个来源与通配符 ──
 *
 * 只允许单一来源在实际使用中不够：Cloudflare Pages 的**每次推送都会生成
 * 新的预览地址**（形如 `1955a0bc.universal-reader.pages.dev`，哈希会变），
 * 只填生产地址会让预览部署无法使用云端功能，只填预览地址则会让生产地址失效，
 * 而且下次推送后预览地址一变又失效。
 *
 * 因此 ALLOWED_ORIGIN 支持逗号分隔的多条规则，每条可用 `*` 通配：
 *
 * ```toml
 * ALLOWED_ORIGIN = "https://universal-reader.pages.dev,https://*.universal-reader.pages.dev"
 * ```
 *
 * **`*` 的语义**：匹配**单个 DNS 标签**（一个或多个非点字符），不跨点。
 * 这个收窄是刻意的：
 *
 * | 规则 | 匹配 | 不匹配 |
 * |---|---|---|
 * | `https://*.universal-reader.pages.dev` | `1955a0bc.universal-reader.pages.dev` | `universal-reader.pages.dev`（写在前面即可）、`a.b.universal-reader.pages.dev` |
 *
 * 若允许跨点，`https://universal-reader.pages.dev.evil.com` 这类
 * 「把你域名当子域」的构造就有机会混进来。
 *
 * **安全约束**：只含通配符的规则（如 `*`、`https://*`）会被**忽略** ——
 * 否则等于放行所有来源，把这个白名单变成装饰。
 */
function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('Origin');

  const base: Record<string, string> = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };

  // 未配置来源白名单，或来源不匹配 → 不发放 CORS 许可
  if (!origin || !isOriginAllowed(origin, env.ALLOWED_ORIGIN)) {
    return base;
  }

  return { ...base, 'Access-Control-Allow-Origin': origin };
}

/**
 * 判断请求来源是否在白名单内。
 *
 * 导出以便单元测试 —— 这是本文件里唯一有分支逻辑的安全判定，
 * 出错的方式（放行所有人 / 挡住自己）都很隐蔽，值得单独测。
 */
export function isOriginAllowed(origin: string, allowedConfig: string | undefined): boolean {
  const patterns = (allowedConfig ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);

  if (!patterns.length) return false;

  for (const pattern of patterns) {
    // 通配符必须配合具体域名 —— 只含 * 的规则会让白名单形同虚设
    const withoutWildcards = pattern.replace(/\*/g, '');
    if (!/[a-z0-9]/i.test(withoutWildcards)) continue;

    if (globToRegExp(pattern).test(origin)) return true;
  }

  return false;
}

/**
 * 把白名单规则转成正则。
 *
 * `*` → `[^.]+`：匹配**一个或多个非点字符**，即单个 DNS 标签。
 * 其余字符按字面量转义，特别是 `.` —— 若把它当通配，
 * `https://universalXreader.pages.dev` 就会被误放行。
 */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^.]+');
  return new RegExp(`^${escaped}$`);
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
