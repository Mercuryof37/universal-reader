import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * 翻译缓存走 IndexedDB，而测试环境是 node（没有 IndexedDB）。
 * 与 `outboundPrivacy.test.ts` 同样的理由：不换掉它，`translateBlock`
 * 会在到达外发点之前就抛 `MissingAPIError`，于是「没发请求」的断言会
 * **因为完全无关的原因**变绿 —— 那是假保护。
 */
vi.mock('@/lib/db', () => ({
  getCachedTranslation: vi.fn(async () => undefined),
  putCachedTranslation: vi.fn(async () => undefined),
}));

import { getCachedTranslation } from '@/lib/db';
import { useSettingsStore } from '@/store/settingsStore';
import {
  ENV_VAR_SITE_SPECS,
  EXCLUDED_DATA_SPECS,
  NETWORK_PRIMITIVE_PATTERN,
  NETWORK_SITE_SPECS,
  NOT_EXCLUDED_SPECS,
  OUTBOUND_PATH_SPECS,
  OUTBOUND_PAYLOAD_SPECS,
  REMOTE_URL_SITE_SPECS,
} from '@/lib/outboundPaths';
import { detectMissedInkRegions } from '@/lib/ocrInkRegions';
import { recognizeFormula } from '@/services/formulaOcrService';
import { CloudTTSEngine } from '@/services/ttsEngine';
import { translateBlock } from '@/services/translationService';
import type { ContentBlock } from '@/types/content';

/**
 * ═══════════════════════════════════════════════════════════════
 * 「绝不外发」清单（排除清单）—— 以及它凭什么可信
 * ═══════════════════════════════════════════════════════════════
 *
 * MinerU 的遥测声明是**反过来**写的：逐项枚举「不收集什么」
 * （文档内容、提取出的文本与图像、文件名、文件路径、搜索词、片段、
 * API 密钥、用户名、主机名、原始堆栈、精确硬件标识），
 * 并给出可操作命令。本项目的承诺比它强得多（零遥测），
 * 但表述强度一直不如它 —— 只有一份「什么会外发」的清单，
 * 用户仍然不知道自己导入的文件、写的批注、读到的位置算不算在内。
 *
 * ⚠️ 这个文件要防的是**三种具体的失败**，不是「多写几条断言」：
 *
 * ① **假保护**（本项目已出现 5 次以上）。上一轮抓到的三类，这里逐个避开：
 *    · 读同进程里别的测试改过的当前值 → 本文件凡涉及「默认值」的断言
 *      一律读源码或读清单常量，不读 `getState()` 的当前值；
 *    · `toMatch(/名字/)` 匹配到 import 而非真实调用 → 面板渲染那两条
 *      断言的是**真的被 map 出来**，不是标识符出现过；
 *    · 验「开关默认值」而不是「真实调用被拦住」→ 本文件的抓包用例
 *      **真的把请求体抓下来**，逐个字段比对。
 *
 * ② **清单好看但事实相反**。核实过程中确实查出了这种情形：
 *    **页面像素会外发**（公式增强开启时），而且上传的裁剪块
 *    **没有面积上界**。所以下面有一整块断言专门钉住
 *    「这些**不得**写进排除清单」，而不是把它们悄悄漏掉。
 *
 * ③ **清单是静态的，所以它会过期**。这才是最致命的一种：
 *    只要没人更新，排除清单在「有人加了一条外发路径」之后
 *    **会继续显示为真**。HANDOFF §1 T2 就是这个坑的实例 ——
 *    三条外发路径被记成一条，缺口因此被低估成三分之一。
 *    所以本文件还有第三层：把整个 `src/` 的**网络原语全集**
 *    与**远程地址全集**与**环境变量全集**都钉成封闭清单。
 *    加一条外发路径 → 集合不相等 → **红**。
 *
 * 关于最后一点必须说清楚它**做不到**什么（如实）：
 * 这是**源码级**扫描，不是沙箱。它不能拦住「用已有的 fetch 站点
 * 发新的内容」（那一层由下面的抓包断言与 `forbiddenPayloadKeys`
 * 的非重叠断言来挡），也不能拦住「把远程地址拼在变量里」。
 * 它拦的是最常见的那条路：**新加一处 fetch / 新写一个端点**。
 */

const ROOT = process.cwd();
const TRANSLATION_PANEL = 'src/components/TranslationPanel.tsx';

// ───────────────────────────────────────────────────────────────
// 源码扫描：剥离注释的小型词法扫描器
// ───────────────────────────────────────────────────────────────

/**
 * 剥掉注释，只留代码。
 *
 * ⚠️ 为什么不能像 `outboundPrivacy.test.ts` 那样用两行正则：
 * 那个写法只处理「整块 /* ... *​/」与「以 // 开头的行」，
 * 而本文件的扫描对象是**全部源码**，里面有大量行尾注释与
 * 模板字符串。用那个写法会把 `foo(); // 见 https://…` 这类行
 * 整行留下（URL 混进代码统计），或者反过来把字符串里的
 * 内容当成注释剥掉。
 *
 * 这里的实现按状态机走：code / 行注释 / 块注释 / 单引号 / 双引号 /
 * 反引号。字符串与模板里的内容**保留**（因为请求体与地址就写在那里）。
 *
 * ⚠️ 已知边界（如实）：**不解析正则字面量**。若某个正则字面量里
 * 恰好含 `//` 或 `/*`，该行剩余部分会被误当成注释剥掉。
 * 这会让扫描结果**偏少**（假绿的唯一方向），所以下面所有集合相等
 * 的断言都用「逐文件计数」而不是「有没有」，并且本文件的
 * 存在本身就是提醒：改这里时要看这条注释。
 */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  let state: 'code' | 'line' | 'block' | 'sq' | 'dq' | 'tpl' = 'code';

  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];

    if (state === 'code') {
      if (c === '/' && n === '*') {
        state = 'block';
        i += 2;
        continue;
      }
      if (c === '/' && n === '/') {
        state = 'line';
        i += 2;
        continue;
      }
      if (c === "'") state = 'sq';
      else if (c === '"') state = 'dq';
      else if (c === '`') state = 'tpl';
      out += c;
      i++;
      continue;
    }
    if (state === 'line') {
      if (c === '\n') {
        state = 'code';
        out += c;
      }
      i++;
      continue;
    }
    if (state === 'block') {
      if (c === '*' && n === '/') {
        state = 'code';
        i += 2;
        continue;
      }
      if (c === '\n') out += c;
      i++;
      continue;
    }
    // sq / dq / tpl：保留内容，处理转义
    if (c === '\\') {
      out += c + (n ?? '');
      i += 2;
      continue;
    }
    if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"') || (state === 'tpl' && c === '`')) {
      state = 'code';
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * 读源码文本。
 *
 * ⚠️ 为什么要有重试（不是防御性编程，是本次实测撞到的）：
 * Windows 上文件可能被编辑器 / 杀毒 / 另一个进程**短暂**占用。
 * 本次跑变异测试时真的撞到一次 —— 同仓库另一个任务正在写
 * `src/lib/annotationAnchor.ts`，那一瞬间 `readFileSync` 抛
 * `EBUSY: resource busy or locked`，于是**一条与内容完全无关的用例**
 * 变红（假红）。重试几次足以吸收这种瞬时占用。
 *
 * ⚠️ 但**不能**静默跳过读不到的文件：跳过等于「这个文件没被扫描」，
 * 那是一处看不见的假绿 —— 而这正是本文件要防的东西。
 * 所以重试用尽后**如实抛出**并点名文件。
 */
function readText(absPath: string): string {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return readFileSync(absPath, 'utf8');
    } catch (err) {
      lastErr = err;
      // Node 里没有同步 sleep；Atomics.wait 是最简单可靠的一种（Node 主线程允许）
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  throw new Error(`读不到源码文件 ${absPath}（被占用？不允许静默跳过）：${String(lastErr)}`);
}

/** 非测试源码文件（相对仓库根，正斜杠，已排序） */
function listSourceFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p)) files.push(p);
    }
  };
  walk(join(ROOT, 'src'));
  return files.map((p) => relative(ROOT, p).replace(/\\/g, '/')).sort();
}

function codeOf(file: string): string {
  return stripComments(readText(join(ROOT, file)));
}

/** 每文件里网络原语的出现次数（只统计非零项） */
function scanNetworkPrimitives(): Record<string, number> {
  const actual: Record<string, number> = {};
  for (const file of listSourceFiles()) {
    // 每个文件新建一个正则：带 /g 的正则在多次 match 之间会留 lastIndex 状态
    const hits = codeOf(file).match(new RegExp(NETWORK_PRIMITIVE_PATTERN, 'g'));
    if (hits?.length) actual[file] = hits.length;
  }
  return actual;
}

/** 每文件里写死的远程地址（只统计非零项） */
function scanRemoteUrls(): Record<string, number> {
  const actual: Record<string, number> = {};
  for (const file of listSourceFiles()) {
    const hits = codeOf(file).match(/https?:\/\/[^\s'"`)]+/g);
    if (hits?.length) actual[file] = hits.length;
  }
  return actual;
}

/** 非测试源码里出现过的所有 `VITE_*` 名字（去重、排序） */
function scanEnvNames(): string[] {
  const names = new Set<string>();
  for (const file of listSourceFiles()) {
    for (const m of codeOf(file).matchAll(/VITE_[A-Z0-9_]+/g)) names.add(m[0]);
  }
  return [...names].sort();
}

// ───────────────────────────────────────────────────────────────
// 运行期抓包：把三条路径真实发出的请求体抓下来
// ───────────────────────────────────────────────────────────────

interface CapturedCall {
  url: string;
  init: RequestInit | undefined;
}

function startCapture(): CapturedCall[] {
  const calls: CapturedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, init?: RequestInit) => {
      // 记下来再抛：函数内部对失败的处置（抛错/降级）不该影响我们
      // 对"到底发了什么"的观察 —— 观察点必须在最靠近网线的地方。
      calls.push({ url: String(url), init });
      throw new Error('probe: reached the network layer');
    }),
  );
  return calls;
}

/**
 * 剥掉 JSON 里值为 `undefined` 的键，与 `JSON.stringify` 的真实行为一致。
 *
 * ⚠️ 这一步是这个文件里最容易搞错、且搞错了会变成假保护的地方：
 * `JSON.stringify({ text, context: undefined })` **不会**产出
 * `context` 这个键。如果按"源码里写了几个字段"去断言，
 * 就会把「可能出现的字段」当成「实际出现的字段」——
 * 非重叠断言于是变成一场空谈。所以一律以**抓到的键**为准。
 */
function capturedKeys(call: CapturedCall): string[] {
  const raw = call.init?.body;
  expect(typeof raw, '请求体不是字符串，无法逐字比对字段').toBe('string');
  return Object.keys(JSON.parse(String(raw)) as Record<string, unknown>).sort();
}

/** 假装成 OffscreenCanvas：让 `toPngBuffer` 走「convertToBlob」那一条分支 */
class FakeOffscreenCanvas {
  async convertToBlob(): Promise<{ arrayBuffer: () => Promise<ArrayBuffer> }> {
    // 8 字节的 PNG 魔数就够 —— 这一层只关心「发了什么字段」
    return { arrayBuffer: async () => new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer };
  }
}

function stubCanvasGlobals(): void {
  // node 里既没有 ImageData 也没有 OffscreenCanvas，而 `toPngBuffer`
  // 用 `instanceof` 判分支 —— 不补上这两个全局，它会抛 ReferenceError。
  // 那会让断言因为与「发什么」完全无关的原因失败（假红），
  // 或者更糟：让"一个请求都没发"因为崩得太早而假绿。
  vi.stubGlobal('ImageData', class ImageDataStub {});
  vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
}

const PROBE_BLOCK_TEXT = 'UNIQUE_BODY_TEXT_FOR_PROBE_9f3a4c，只用于抓包。';

function probeBlock(id: string): ContentBlock {
  return { id, type: 'paragraph', content: PROBE_BLOCK_TEXT, translations: {}, metadata: {} };
}

/**
 * 依次触发三条外发路径，把真实请求体全部抓下来。
 *
 * 返回的是**四条**请求（不是三条）：云端翻译与云端语音各抓两次 ——
 * 一次带可选字段、一次不带。理由是 `JSON.stringify` 会丢掉
 * 值为 undefined 的键，所以单次抓包只能看到「字段全集」的一个子集。
 * 两次合起来才能既证明「没有多余字段」（安全的那一侧），
 * 又证明「声明的字段都能真的出现」（声明不是虚胖）。
 */
interface OutboundCapture {
  urls: string[];
  keySets: string[][];
  headers: Record<string, string>[];
}

async function captureOutboundBodies(): Promise<OutboundCapture> {
  const urls: string[] = [];
  const keySets: string[][] = [];
  const headers: Record<string, string>[] = [];

  const record = (calls: CapturedCall[]): void => {
    for (const c of calls) {
      keySets.push(capturedKeys(c));
      headers.push(normalizeHeaders(c.init?.headers));
      urls.push(c.url);
    }
  };

  const s = useSettingsStore.getState();
  vi.stubEnv('VITE_TRANSLATE_ENDPOINT', 'https://proxy.test/api/translate');
  vi.stubEnv('VITE_TTS_ENDPOINT', 'https://proxy.test/api/tts');

  // ── ① 公式增强（1 次）──
  stubCanvasGlobals();
  s.setFormulaOcrEnabled(true);
  const formulaCalls = startCapture();
  await expect(
    recognizeFormula(new FakeOffscreenCanvas() as unknown as OffscreenCanvas),
  ).rejects.toThrow(/probe: reached the network layer/);
  expect(
    formulaCalls.length,
    '公式增强没有发出请求 —— 下面的断言会因为空集合而变成假保护',
  ).toBe(1);
  record(formulaCalls);

  // ── ② 云端翻译（2 次：无 context / 有 context）──
  s.setFormulaOcrEnabled(false);
  s.setDefaultTranslationEngine('deepl');
  s.setCloudTranslationConsent(true);
  const trCalls = startCapture();
  await expect(translateBlock(probeBlock('cap-tr-1'), 'en', { engine: 'deepl' })).rejects.toThrow(
    /probe: reached the network layer/,
  );
  await expect(
    translateBlock(probeBlock('cap-tr-2'), 'en', { engine: 'deepl', context: 'CTX_PROBE' }),
  ).rejects.toThrow(/probe: reached the network layer/);
  expect(trCalls.length, '云端翻译没有发出两次请求').toBe(2);
  record(trCalls);

  // ── ③ 云端语音（2 次：无音色 / 有音色）──
  s.setCloudTranslationConsent(false);
  s.setTtsCloudConsent(true);
  const ttsCalls = startCapture();
  await expect(
    new CloudTTSEngine('https://proxy.test/api/tts').speak('TTS_PROBE_1', 'zh-CN'),
  ).rejects.toThrow(/probe: reached the network layer/);
  await expect(
    new CloudTTSEngine('https://proxy.test/api/tts').speak('TTS_PROBE_2', 'zh-CN', {
      rate: 1,
      pitch: 1,
      voiceName: 'Microsoft Huihui - Chinese (Simplified)',
    }),
  ).rejects.toThrow(/probe: reached the network layer/);
  expect(ttsCalls.length, '云端语音没有发出两次请求').toBe(2);
  record(ttsCalls);

  return { urls, keySets, headers };
}

function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  if (Array.isArray(headers)) return Object.fromEntries(headers.map(([k, v]) => [k.toLowerCase(), v]));
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    return Object.fromEntries([...headers.entries()].map(([k, v]) => [k.toLowerCase(), v]));
  }
  return Object.fromEntries(
    Object.entries(headers as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
  );
}

// ───────────────────────────────────────────────────────────────
// 每个用例前后都把同意位与全局还原，避免污染同进程里的其他文件
// ───────────────────────────────────────────────────────────────

function resetPrivacy() {
  const s = useSettingsStore.getState();
  s.setFormulaOcrEnabled(false);
  s.setCloudTranslationConsent(false);
  s.setTtsCloudConsent(false);
  s.setTtsPreference('browser');
}

beforeEach(resetPrivacy);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.mocked(getCachedTranslation).mockReset();
  // 用 null 而不是 undefined：这个 mock 的类型是真实模块的 TranslationRow | null
  vi.mocked(getCachedTranslation).mockResolvedValue(null);
  resetPrivacy();
});

// ═══════════════════════════════════════════════════════════════
// ① 排除清单本身：每一项都必须可被证伪
// ═══════════════════════════════════════════════════════════════

describe('① 排除清单是机器可读的，且每一项都能被证伪', () => {
  it('每一项都有 声明 / 依据 / 可验证方式，且字段名清单非空', () => {
    expect(EXCLUDED_DATA_SPECS.length, '排除清单不该是空的').toBeGreaterThanOrEqual(8);

    const keys = EXCLUDED_DATA_SPECS.map((e) => e.key);
    expect(new Set(keys).size, '排除清单里有重复的 key').toBe(keys.length);

    for (const item of EXCLUDED_DATA_SPECS) {
      expect(item.claim.length, `${item.key} 的声明太短，等于没说`).toBeGreaterThan(10);
      // 「依据」必须点名具体的代码事实，否则它就是一段无法核对的散文
      expect(item.basis.length, `${item.key} 的依据太短`).toBeGreaterThan(20);
      expect(
        item.basis,
        `${item.key} 的依据没有点名任何文件/表 —— 那就不是依据，是重复了一遍声明`,
      ).toMatch(/\.tsx?|表|store\/|parsers\//);
      // 「可验证方式」必须指向真的存在的测试
      expect(item.verify, `${item.key} 没有给出可验证方式`).toMatch(/outboundExclusions\.test\.ts/);
      expect(
        item.forbiddenPayloadKeys.length,
        `${item.key} 的 forbiddenPayloadKeys 是空的 —— 无法证伪的排除项不能写进清单（T7 验收标准 2）`,
      ).toBeGreaterThan(0);
    }
  });

  it('每一条「声明」都不含绝对化且指代不明的说法（不能用「任何数据」兜底）', () => {
    // 「永不外发任何数据」这种写法是 T7 明确点名的风险：
    // 三条 opt-in 路径确实会外发，一句笼统的绝对化承诺反而会变成假话。
    for (const item of EXCLUDED_DATA_SPECS) {
      expect(item.claim, `${item.key} 用了「任何数据/所有内容」这类无法逐项核对的兜底说法`).not.toMatch(
        /任何数据|所有内容|所有数据|一切数据/,
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// ② 两份清单不重叠 —— 而且是**非平凡**的不重叠
// ═══════════════════════════════════════════════════════════════

describe('② 「绝不外发」与「会外发」两份清单互斥', () => {
  it('同一项不能既在排除清单里、又在「其实会外发」清单里', () => {
    const excluded = new Set<string>(EXCLUDED_DATA_SPECS.map((e) => e.key));
    expect(NOT_EXCLUDED_SPECS.length, '「其实会外发」清单是空的 —— 那条不重叠断言就成了空谈').toBeGreaterThan(
      0,
    );
    for (const item of NOT_EXCLUDED_SPECS) {
      expect(excluded.has(item.key), `${item.key} 同时出现在两份清单里`).toBe(false);
    }
  });

  it('字段维度也不重叠：排除项声明的字段名不会真的出现在请求体里', () => {
    // ⚠️ 这一条是「非重叠」真正有意义的地方。
    // 只在 key 层面比大小写是没用的（两组不同的字符串当然不相交）；
    // 要比的是**请求体里真的会出现什么字段名**。
    const excludedFields = new Set<string>();
    for (const item of EXCLUDED_DATA_SPECS) for (const f of item.forbiddenPayloadKeys) excludedFields.add(f);

    const outgoingFields = new Set<string>();
    for (const spec of OUTBOUND_PAYLOAD_SPECS) for (const f of spec.fields) outgoingFields.add(f);
    for (const item of NOT_EXCLUDED_SPECS) for (const f of item.payloadKeys) outgoingFields.add(f);

    expect(excludedFields.size, '排除清单一个字段名都没声明 —— 不重叠会变成空谈').toBeGreaterThan(0);
    expect(outgoingFields.size, '外发字段集合是空的').toBeGreaterThan(0);

    for (const item of EXCLUDED_DATA_SPECS) {
      const clash = item.forbiddenPayloadKeys.filter((k) => outgoingFields.has(k));
      expect(
        clash,
        `${item.key} 声明的字段名 ${clash.join(', ')} 真的会出现在请求体里 —— 它不能待在排除清单里`,
      ).toEqual([]);
    }
    // 「会外发」那一侧自己也不允许与排除清单重名
    for (const item of NOT_EXCLUDED_SPECS) {
      const clash = item.payloadKeys.filter((k) => excludedFields.has(k));
      expect(clash, `${item.key} 的字段 ${clash.join(', ')} 与排除清单重名`).toEqual([]);
    }
  });

  it('排除清单里**没有**任何一项声称「页面图像 / 像素 / 画布不外发」', () => {
    // ⚠️ 这是本次核实里最重要的一条结论，所以它必须是一条断言。
    // 核实结果：**页面像素确实会外发**（公式增强开启时），
    // 所以任何声称页面图像不外发的条目都是假话。
    for (const item of EXCLUDED_DATA_SPECS) {
      expect(
        `${item.title}${item.claim}`,
        `${item.key} 声称页面图像/像素不外发，但公式增强确实会把页面裁剪块发出去`,
      ).not.toMatch(/页面图像|页面像素|画布像素|整页图像|页面截图/);
    }
    // 反方向：它必须出现在「其实会外发」那一侧，且点名公式增强
    const page = NOT_EXCLUDED_SPECS.find((e) => e.key === 'pageRasterCrop');
    expect(page, '「页面像素会外发」这一项必须显式列出来，不能靠漏掉它来让清单好看').toBeDefined();
    expect(page?.outboundPaths).toEqual(['formulaOcrEnabled']);
    expect(page?.payloadKeys).toEqual(['image']);
  });
});

// ═══════════════════════════════════════════════════════════════
// ③ 运行期抓包：请求体里真的只有声明的那些字段
// ═══════════════════════════════════════════════════════════════

describe('③ 抓真包：三条路径实际发出去的字段与清单逐字一致', () => {
  it('每条路径的请求体：不多一个字段，也不少一个字段', async () => {
    const captured = await captureOutboundBodies();
    // 1 次公式 + 2 次翻译（有/无 context）+ 2 次语音（有/无音色）
    expect(captured.urls).toHaveLength(5);
    expect(captured.keySets).toHaveLength(5);

    // 按路径把抓到的键集合分组（顺序：公式×1、翻译×2、语音×2 … 见 helper）。
    // ⚠️ 这张表是**按路径名手写**的：将来新增第 4 条外发路径时，
    // 这里会取到 `undefined` → `observed.length` 为 0 → 下面的
    // `expect(observed.length).toBeGreaterThan(0)` 直接变红。
    // 也就是说这份表不需要"记得同步"，它会自己报错。
    const byPath: Record<string, string[][]> = {
      formulaOcrEnabled: [captured.keySets[0] ?? []],
      cloudTranslationConsent: [captured.keySets[1] ?? [], captured.keySets[2] ?? []],
      ttsCloudConsent: [captured.keySets[3] ?? [], captured.keySets[4] ?? []],
    };

    for (const spec of OUTBOUND_PAYLOAD_SPECS) {
      const declared = [...spec.fields].sort();
      const observed = byPath[spec.path] ?? [];
      expect(observed.length, `${spec.path} 没抓到足够的请求`).toBeGreaterThan(0);

      const union = new Set<string>();
      for (const keys of observed) {
        // 安全的那一侧：抓到的每一个键都必须是声明过的
        for (const k of keys) {
          expect(
            declared,
            `${spec.path} 发出了声明之外的字段「${k}」—— 清单必须同时更新，否则排除清单会失真`,
          ).toContain(k);
        }
        for (const k of keys) union.add(k);
      }
      // 声明的字段必须真的能出现（否则声明是虚胖的，"没有多余字段"就没有意义）
      expect(
        [...union].sort(),
        `${spec.path} 声明的字段没能全部出现 —— 声明里有多余的字段，或者抓包路径没走通`,
      ).toEqual(declared);
    }
  });

  it('抓到的字段名与排除清单声明的字段名**没有交集**（这才是真正的非重叠）', async () => {
    const captured = await captureOutboundBodies();
    const observed = new Set(captured.keySets.flat());
    expect(observed.size, '一个字段都没抓到 —— 下面的断言会因为空集合而恒真').toBeGreaterThan(0);

    for (const item of EXCLUDED_DATA_SPECS) {
      const clash = item.forbiddenPayloadKeys.filter((k) => observed.has(k));
      expect(
        clash,
        `${item.key} 声称不外发，但请求体里真的出现了字段 ${clash.join(', ')}`,
      ).toEqual([]);
    }
  });

  it('排除清单点名的那些文件里，确实没有网络原语', () => {
    // 「依据」里点名了 annotationsStore / AnnotationSidebar，
    // 那就在这里真的核对一次，而不是只在文案里声明。
    for (const file of [
      'src/store/annotationsStore.ts',
      'src/components/AnnotationSidebar.tsx',
      'src/store/libraryStore.ts',
      'src/lib/db.ts',
      'src/components/DocumentLibrary.tsx',
    ]) {
      const code = codeOf(file);
      expect(code, `${file} 里出现了网络原语 —— 排除清单里点它的名，它就必须是干净的`).not.toMatch(
        new RegExp(NETWORK_PRIMITIVE_PATTERN),
      );
      expect(code, `${file} 里出现了写死的远程地址`).not.toMatch(/https?:\/\//);
    }
  });

  it('外发站点的源码里不出现文件名字段（sourceFile / fileName）', () => {
    // 「文件名与文件路径不外发」这一条的依据里点明了这件事，所以真的核对一次。
    const senders = NETWORK_SITE_SPECS.filter((s) => s.role === 'outbound').map((s) => s.file);
    expect(senders.length, '没有 outbound 站点 —— 这条断言会变成空转').toBeGreaterThan(0);
    for (const file of senders) {
      const code = codeOf(file);
      expect(code, `${file} 里出现了 sourceFile`).not.toMatch(/sourceFile/);
      expect(code, `${file} 里出现了 fileName`).not.toMatch(/\bfileName\b/);
    }
  });

  it('译文缓存命中时**一个请求都不发**', async () => {
    vi.stubEnv('VITE_TRANSLATE_ENDPOINT', 'https://proxy.test/api/translate');
    const s = useSettingsStore.getState();
    s.setCloudTranslationConsent(true);
    vi.mocked(getCachedTranslation).mockResolvedValueOnce({
      id: 'cache-probe',
      targetLang: 'en',
      text: 'CACHED_TRANSLATION',
      engine: 'deepl',
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    const calls = startCapture();
    const result = await translateBlock(probeBlock('cache-hit-probe'), 'en', { engine: 'deepl' });

    expect(result.cached).toBe(true);
    expect(result.translatedText).toBe('CACHED_TRANSLATION');
    expect(calls, '缓存命中却还是发了请求').toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// ④ 前端零密钥
// ═══════════════════════════════════════════════════════════════

describe('④ 前端零密钥', () => {
  it('能读到的构建期变量被钉成封闭清单，里面没有任何 KEY / TOKEN / SECRET', () => {
    const actual = scanEnvNames();
    expect(actual.length, '一个 VITE_* 都没扫到 —— 扫描本身失效了').toBeGreaterThan(0);
    expect(actual, '构建期变量集合变了：新增端点变量就等于新增一条外发路径').toEqual(
      ENV_VAR_SITE_SPECS.map((e) => e.name).sort(),
    );
    for (const name of actual) {
      expect(name, `前端不该有能装密钥的变量：${name}`).not.toMatch(/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/);
    }
  });

  it('抓到的所有请求的请求头里都没有授权字段（密钥只在 Worker 的环境变量里）', async () => {
    const captured = await captureOutboundBodies();
    expect(captured.headers.length).toBeGreaterThan(0);
    for (const headers of captured.headers) {
      const names = Object.keys(headers);
      expect(names, '请求头里出现了 authorization').not.toContain('authorization');
      expect(names, '请求头里出现了 api key 头').not.toContain('x-api-key');
      expect(names, '请求头里出现了 api key 头').not.toContain('api-key');
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// ⑤ ⭐ 这一条就是「新增外发路径会变红」的机制
// ═══════════════════════════════════════════════════════════════

describe('⑤ 网络原语与远程地址是封闭集合：新增一条外发路径会红', () => {
  it('整个 src/ 的网络原语全集 = 清单里那 5 个文件 6 处', () => {
    const actual = scanNetworkPrimitives();
    const declared: Record<string, number> = {};
    for (const site of NETWORK_SITE_SPECS) declared[site.file] = site.count;

    expect(
      Object.keys(actual).sort(),
      '出现了 NETWORK_SITE_SPECS 之外的网络原语站点。' +
        '若这是新加的外发路径：必须同时更新 NETWORK_SITE_SPECS、OUTBOUND_PATH_SPECS、' +
        'OUTBOUND_PAYLOAD_SPECS，并检查 EXCLUDED_DATA_SPECS 是否还有效。' +
        '若这只是下载/同源探测：把它登记进 NETWORK_SITE_SPECS 并写明 role。',
    ).toEqual(Object.keys(declared).sort());

    for (const [file, count] of Object.entries(declared)) {
      expect(actual[file], `${file} 里的网络原语数量从 ${count} 变成了 ${actual[file] ?? 0}`).toBe(count);
    }
  });

  it('每条外发路径都有且只有一个实际执行外发的站点（两个方向都查）', () => {
    const specKeys = OUTBOUND_PATH_SPECS.map((s) => s.key).sort();
    const outboundSites = NETWORK_SITE_SPECS.filter((s) => s.role === 'outbound');

    // 方向一：清单里加了外发路径 ⇒ 必须同时登记执行外发的站点
    expect(
      outboundSites.map((s) => s.path).sort(),
      'OUTBOUND_PATH_SPECS 与 NETWORK_SITE_SPECS 里的 outbound 站点对不上 —— ' +
        '新加一条外发路径却没有登记它实际在哪里发请求（或反之）',
    ).toEqual(specKeys);

    for (const site of outboundSites) {
      expect(site.path, `${site.file} 是 outbound 却没写明属于哪条路径`).toBeDefined();
      expect(specKeys).toContain(site.path);
    }
    // 方向二：非 outbound 站点不许带 path（否则可以把外发挂在"下载"名下蒙混过关）
    for (const site of NETWORK_SITE_SPECS.filter((s) => s.role !== 'outbound')) {
      expect(site.path, `${site.file} 不是 outbound，不该有 path`).toBeUndefined();
    }
    // 每条路径都必须有逐字字段清单，且一一对应
    expect(OUTBOUND_PAYLOAD_SPECS.map((p) => p.path).sort()).toEqual(specKeys);
    for (const p of OUTBOUND_PAYLOAD_SPECS) {
      expect(p.fields.length, `${p.path} 的字段清单是空的`).toBeGreaterThan(0);
    }
  });

  it('写死的远程地址只有清单里那三个文件的 6 处（新增一个 CDN/端点会红）', () => {
    const actual = scanRemoteUrls();
    const declared: Record<string, number> = {};
    for (const site of REMOTE_URL_SITE_SPECS) declared[site.file] = site.count;

    expect(
      Object.keys(actual).sort(),
      '出现了清单之外的写死远程地址 —— 新写一个端点/镜像就会走到这里',
    ).toEqual(Object.keys(declared).sort());
    for (const [file, count] of Object.entries(declared)) {
      expect(actual[file], `${file} 里的远程地址数量变了`).toBe(count);
    }
  });

  it('清单里的网络站点文件都真实存在（防止清单自己变成僵尸）', () => {
    const files = new Set(listSourceFiles());
    for (const site of [...NETWORK_SITE_SPECS, ...REMOTE_URL_SITE_SPECS]) {
      expect(files.has(site.file), `${site.file} 不存在了 —— 清单需要同步`).toBe(true);
      expect(site.what.length, `${site.file} 没写清这一处是干什么的`).toBeGreaterThan(5);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// ⑥ 零遥测
// ═══════════════════════════════════════════════════════════════

describe('⑥ 零遥测：没有任何"发了就不管"的通道', () => {
  it('src/ 里没有 sendBeacon / WebSocket / EventSource / XMLHttpRequest', () => {
    /**
     * ⚠️ 清单文件 `src/lib/outboundPaths.ts` 必须排除在**子串**扫描之外：
     * 它正是靠「提到这些名字」来禁止它们的（`NETWORK_PRIMITIVE_PATTERN`
     * 与 `forbiddenPayloadKeys` 里就写着 sendBeacon / WebSocket 这些词）。
     * 对它改用**调用形态**的断言 —— 提到名字不算，能真的建立连接才算。
     * 这一条本身也是"假红"的样例：第一次跑这条断言时它就是这么红的。
     */
    const MANIFEST = 'src/lib/outboundPaths.ts';
    for (const file of listSourceFiles()) {
      if (file === MANIFEST) continue;
      const code = codeOf(file);
      expect(code, `${file} 里出现了 sendBeacon`).not.toMatch(/sendBeacon/);
      expect(code, `${file} 里出现了 WebSocket`).not.toMatch(/new\s+WebSocket/);
      expect(code, `${file} 里出现了 EventSource`).not.toMatch(/new\s+EventSource/);
      expect(code, `${file} 里出现了 XMLHttpRequest`).not.toMatch(/XMLHttpRequest/);
    }

    const manifestCode = codeOf(MANIFEST);
    expect(manifestCode, '清单文件里出现了 sendBeacon 调用').not.toMatch(
      /navigator\s*\.\s*sendBeacon\s*\(/,
    );
    expect(manifestCode, '清单文件里出现了 WebSocket 调用').not.toMatch(/new\s+WebSocket\s*\(/);
    expect(manifestCode, '清单文件里出现了 EventSource 调用').not.toMatch(/new\s+EventSource\s*\(/);
    expect(manifestCode, '清单文件里出现了 XMLHttpRequest 调用').not.toMatch(
      /new\s+XMLHttpRequest\s*\(/,
    );
  });

  it('生产依赖里没有任何分析/上报类库', () => {
    const pkg = JSON.parse(readText(join(ROOT, 'package.json'))) as {
      dependencies?: Record<string, string>;
    };
    const deps = Object.keys(pkg.dependencies ?? {});
    expect(deps.length, '读不到生产依赖 —— 这条断言会变成空转').toBeGreaterThan(0);
    for (const banned of [
      '@sentry/browser',
      '@sentry/react',
      'posthog-js',
      'mixpanel-browser',
      '@vercel/analytics',
      'plausible-tracker',
      'umami',
      'matomo',
      'react-ga',
    ]) {
      expect(deps, `生产依赖里出现了分析类库 ${banned}`).not.toContain(banned);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// ⑦ 排除清单的边界：核实出来的「其实会外发」
// ═══════════════════════════════════════════════════════════════

describe('⑦ 边界：以为不会外发、核实后发现有的事', () => {
  it('「页面像素会外发」的被裁剪面积**没有上界**（实测，不是推测）', () => {
    /**
     * 这一条钉的是一个**核实出来的、对用户有意义的坏消息**：
     * 公式增强上传的不是"一小块公式"，而是「漏识别墨迹区域」——
     * 而 `detectMissedInkRegions` 只按「格子数 ≥3」与「墨迹比例 ≥0.03」
     * 过滤，**没有任何面积上限**。于是整页识别失败或整页插图时，
     * 交出去的那块裁剪可以覆盖接近整页。
     *
     * 上界只有一个：`formulaOcrService.MAX_IMAGE_SIZE = 2_000_000` 字节（PNG）。
     *
     * ⚠️ 若将来有人给候选区域加了面积上限，这条会变红 —— 那是**预期的**：
     * 请按新的真实上界更新下面的数字，并重新考虑是否可以把
     * 「页面图像」加进 `EXCLUDED_DATA_SPECS`。不要直接删掉这条。
     */
    const w = 800;
    const h = 1000;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      data[i * 4] = 0;
      data[i * 4 + 1] = 0;
      data[i * 4 + 2] = 0;
      data[i * 4 + 3] = 255;
    }
    // node 里没有 ImageData；`detectMissedInkRegions` 只读 width/height/data
    const image = { width: w, height: h, data } as unknown as ImageData;

    // 只用一个极小的词框盖住左上角，模拟「整页除了一处之外全都没被识别」
    const regions = detectMissedInkRegions(image, [{ bbox: { x0: 0, y0: 0, x1: 16, y1: 16 } }]);
    expect(regions.length, '没有检测出任何漏识别区域').toBeGreaterThan(0);

    const biggest = regions.reduce((a, b) =>
      (b.x1 - b.x0) * (b.y1 - b.y0) > (a.x1 - a.x0) * (a.y1 - a.y0) ? b : a,
    );
    const ratio = ((biggest.x1 - biggest.x0) * (biggest.y1 - biggest.y0)) / (w * h);

    expect(
      ratio,
      `实测最大候选区域只覆盖页面的 ${(ratio * 100).toFixed(1)}%。` +
        '若这是因为有人加了面积上界：请按新上界更新本断言，并重新评估排除清单。',
    ).toBeGreaterThan(0.85);
  });

  it('「系统音色名」也会外发，所以「不外发任何设备信息」这句话不能写', () => {
    const voice = NOT_EXCLUDED_SPECS.find((e) => e.key === 'systemVoiceName');
    expect(voice, '系统音色名会随云端语音的 voice 字段外发，必须显式列出来').toBeDefined();
    expect(voice?.payloadKeys).toEqual(['voice']);
    expect(voice?.outboundPaths).toEqual(['ttsCloudConsent']);
  });

  it('「其实会外发」清单里每一项都点名了真实存在的外发路径', () => {
    const specKeys = OUTBOUND_PATH_SPECS.map((s) => s.key);
    for (const item of NOT_EXCLUDED_SPECS) {
      expect(item.outboundPaths.length, `${item.key} 没点名它属于哪条外发路径`).toBeGreaterThan(0);
      for (const p of item.outboundPaths) {
        expect(specKeys, `${item.key} 指向了不存在的外发路径 ${p}`).toContain(p);
      }
      expect(item.why.length, `${item.key} 没写清为什么它不能进排除清单`).toBeGreaterThan(20);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// ⑧ 设置面板渲染的就是这两份清单
// ═══════════════════════════════════════════════════════════════

describe('⑧ 设置面板渲染排除清单（界面与代码事实同一出处）', () => {
  it('两份清单都是**真的被 map 出来渲染**，不是只 import 进来了事', () => {
    const src = readText(join(ROOT, TRANSLATION_PANEL));

    // ⚠️ 不能写 `toMatch(/EXCLUDED_DATA_SPECS/)` —— 那会匹配到 import 语句。
    // 上一轮实测（变异 M14）正是这样被"假绿"骗过一次。
    expect(src, '必须真的把 EXCLUDED_DATA_SPECS 渲染成行').toMatch(/EXCLUDED_DATA_SPECS\.map\(/);
    expect(src, '必须真的把 NOT_EXCLUDED_SPECS 渲染成行（边界要同屏）').toMatch(
      /NOT_EXCLUDED_SPECS\.map\(/,
    );
    expect(src, '渲染排除清单的组件必须真的被挂上去').toMatch(/<ExcludedDataList\s*\/>/);
  });

  it('每一项的「依据」与「怎么验证」也被渲染出来（不只是声明）', () => {
    // MinerU 给的是「不收集什么」；这里多给一层「凭什么这么说」。
    const src = readText(join(ROOT, TRANSLATION_PANEL));
    expect(src).toMatch(/item\.basis/);
    expect(src).toMatch(/item\.verify/);
    expect(src).toMatch(/item\.claim/);
  });

  it('排除清单**没有**开关（这些项本来就没有"关掉"这个动作）', () => {
    const src = readText(join(ROOT, TRANSLATION_PANEL));
    const listStart = src.indexOf('export function ExcludedDataList');
    expect(listStart, '找不到 ExcludedDataList').toBeGreaterThan(-1);
    const listSrc = src.slice(listStart, src.indexOf('function ExcludedDataRow'));
    expect(listSrc, '排除清单里出现了 checkbox —— 那会暗示"默认是开的"').not.toMatch(
      /type="checkbox"|<input/,
    );
  });
});
