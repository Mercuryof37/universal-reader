import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 翻译缓存走 IndexedDB，而测试环境是 node（没有 IndexedDB）。
 * 这里把它换成内存实现 —— 不这么做的话 `translateBlock` 会在
 * 到达第二道防线之前就抛 `MissingAPIError`，于是断言"没发请求"
 * 会**因为完全无关的原因**变绿，那是典型的假保护。
 */
vi.mock('@/lib/db', () => ({
  getCachedTranslation: vi.fn(async () => undefined),
  putCachedTranslation: vi.fn(async () => undefined),
}));

import { useSettingsStore } from '@/store/settingsStore';
import { OUTBOUND_PATH_SPECS, detectBrowserTranslator } from '@/lib/outboundPaths';
import { createTTSEngine, CloudTTSEngine, resolveTtsEngineId } from '@/services/ttsEngine';
import { listOutboundPaths, translateBlock } from '@/services/translationService';
import type { ContentBlock } from '@/types/content';

/**
 * 三条外发路径的共同不变量。
 *
 * ═══════════════════════════════════════════════════════════════
 * 这个文件守的是 manifest 里那句话
 * ═══════════════════════════════════════════════════════════════
 *
 * `vite.config.ts` 的 PWA manifest 对用户承诺：
 *
 *   「文档全程留在本机浏览器，不上传服务器。」
 *
 * 而代码里共有**三条**能把文档内容送出本机的路径。此前它们的状态是：
 *
 * | 路径 | 当时默认 | 当时告知 |
 * |---|---|---|
 * | 公式识别增强 | `false`（已是 opt-in） | 有，且有第二道防线 |
 * | 云端翻译 | 配了端点就自动选 DeepL | **零告知** |
 * | 云端语音 | `ttsPreference: 'auto'` ⇒ 配了端点就自动发 Azure | **零告知** |
 *
 * 后两条**不需要用户做任何动作**就会外发 —— 于是承诺与代码事实冲突。
 * 处理方式是**改代码让承诺成立**（不是把承诺改小），做法是把
 * `formulaOcrEnabled` 那套四要素推广成不变量，三条全都要满足：
 *
 *   ① 默认关闭   ② 用户显式同意   ③ 代码层第二道防线   ④ 界面写清代价
 *
 * 下面的断言逐条对应这四个要素，并且**每个方向都测**：
 * 有能力/无能力 × 已同意/未同意。只测一个方向的断言在 Firefox、
 * 在未配端点的部署上都会变成假保护。
 */

const RENDERER_SRC = {
  translationPanel: readFileSync(
    join(process.cwd(), 'src/components/TranslationPanel.tsx'),
    'utf8',
  ),
  ttsPanel: readFileSync(join(process.cwd(), 'src/components/TtsVoiceSelector.tsx'), 'utf8'),
  viteConfig: readFileSync(join(process.cwd(), 'vite.config.ts'), 'utf8'),
  translationService: readFileSync(
    join(process.cwd(), 'src/services/translationService.ts'),
    'utf8',
  ),
  ttsEngine: readFileSync(join(process.cwd(), 'src/services/ttsEngine.ts'), 'utf8'),
};

/** 还原三个同意位，避免污染同进程里的其他测试文件 */
function resetConsent() {
  const s = useSettingsStore.getState();
  s.setFormulaOcrEnabled(false);
  s.setCloudTranslationConsent(false);
  s.setTtsCloudConsent(false);
  s.setTtsPreference('browser');
}

beforeEach(resetConsent);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetConsent();
});

// ───────────────────────────────────────────────────────────────
// ① 默认关闭：三条全部
// ───────────────────────────────────────────────────────────────

describe('① 默认关闭 —— 不显式打开就不外发', () => {
  it('三条外发路径的默认值全部是「不外发」', () => {
    const paths = listOutboundPaths();

    // 清单本身必须覆盖三条（少一条就是那个"缺口是三倍"的复发）
    expect(paths).toHaveLength(3);
    expect(paths.map((p) => p.key).sort()).toEqual([
      'cloudTranslationConsent',
      'formulaOcrEnabled',
      'ttsCloudConsent',
    ]);

    for (const p of paths) {
      expect(p.enabled, `${p.key} 默认竟然是开启的`).toBe(false);
    }
  });

  it('默认状态与是否配置了端点**无关**（配了端点也不自动开）', () => {
    // 「构建时配了 VITE_TTS_ENDPOINT」曾经等价于「用户同意上传正文」。
    // 这条断言钉的是：能力位（capable）与许可位（enabled）是两件事。
    const paths = listOutboundPaths();
    for (const p of paths) {
      if (p.capable) expect(p.enabled, `${p.key}：有能力不等于已同意`).toBe(false);
    }
  });

  it('云端语音：默认偏好不是 cloud，且没有同意', () => {
    const s = useSettingsStore.getState();
    expect(s.ttsCloudConsent).toBe(false);
    expect(s.ttsPreference).not.toBe('cloud');
    // 旧版那个"配了端点就用云端"的取值必须已经不存在
    expect(s.ttsPreference).not.toBe('auto');
  });

  /**
   * ⭐ 默认值必须**读源码**断言，不能只读 `getState()`。
   *
   * 实测（变异 M5）：把 `settingsStore.ts` 里的默认值改回 `'auto'`，
   * 上面那条 `expect(s.ttsPreference).not.toBe('auto')` **依然绿** ——
   * 因为同进程里别的测试早就调用过 setter，store 的当前值早已不是
   * 模块初值了。也就是说它当时验的是「别的测试留下的值」，
   * 而不是它声称在验的「默认值」。这是「假保护」的另一种形态：
   * 断言的对象错了，而不是断言错了。
   *
   * 默认值是模块求值那一刻定下的字面量，所以对它的断言只能落在源码上。
   */
  /**
   * 找某个 store 字段的**默认值那一行**。
   *
   * 有两类干扰必须排掉，否则断言的对象就不是"默认值"：
   * 1. **注释行** —— `settingsStore.ts` 的注释里大量提到这些字段名
   *    （例如 `ttsPreference` 的注释就有一大段），`includes(key)`
   *    会先命中注释，于是断言的是文档而不是代码；
   * 2. **interface 里的类型声明** —— 同一个 key 在 `SettingsState` 里
   *    还有一行 `ttsPreference: TtsPreference;`，它没有值。
   *
   * 所以只认「`key:` 后面**紧跟一个字面量**」的行 —— 也就是
   * `key: 'browser',` / `key: false,` 这种初始化写法。
   * 这个模式本身就排掉了注释与类型声明两类。
   */
  function defaultValueLine(src: string, key: string): string | undefined {
    return src
      .split('\n')
      .find((l) => new RegExp(`^${key}\\s*:\\s*('|"|true|false|\\d|null)`).test(l.trim()));
  }

  it('源码里的 ttsPreference 默认值是 browser（不是 auto，也不是 cloud）', () => {
    const src = readFileSync(join(process.cwd(), 'src/store/settingsStore.ts'), 'utf8');
    const line = defaultValueLine(src, 'ttsPreference');
    expect(line, 'settingsStore.ts 里找不到 ttsPreference 默认值那一行').toBeDefined();
    expect(line).toMatch(/'browser'/);
    expect(line, '默认值不能是 auto —— 它把「配置端点」当成「用户同意」').not.toMatch(/'auto'/);
    expect(line).not.toMatch(/'cloud'/);
  });

  it('三个外发开关的默认值在源码里都是 false', () => {
    const src = readFileSync(join(process.cwd(), 'src/store/settingsStore.ts'), 'utf8');
    for (const key of ['ttsCloudConsent', 'cloudTranslationConsent', 'formulaOcrEnabled']) {
      const line = defaultValueLine(src, key);
      expect(line, `找不到 ${key} 的默认值那一行`).toBeDefined();
      expect(line, `${key} 的默认值必须是 false`).toMatch(/false/);
      expect(line, `${key} 的默认值不能是 true`).not.toMatch(/true/);
    }
  });
});

// ───────────────────────────────────────────────────────────────
// ② 显式 opt-in：用户动作真的能打开
// ───────────────────────────────────────────────────────────────

describe('② 显式 opt-in —— 开关不是写死的', () => {
  it('云端翻译可以打开也可以关掉', () => {
    const s = useSettingsStore.getState();
    s.setCloudTranslationConsent(true);
    expect(useSettingsStore.getState().cloudTranslationConsent).toBe(true);
    expect(listOutboundPaths().find((p) => p.key === 'cloudTranslationConsent')?.enabled).toBe(
      true,
    );

    s.setCloudTranslationConsent(false);
    expect(useSettingsStore.getState().cloudTranslationConsent).toBe(false);
    expect(listOutboundPaths().find((p) => p.key === 'cloudTranslationConsent')?.enabled).toBe(
      false,
    );
  });

  it('云端语音可以打开也可以关掉', () => {
    const s = useSettingsStore.getState();
    s.setTtsCloudConsent(true);
    s.setTtsPreference('cloud');
    expect(useSettingsStore.getState().ttsCloudConsent).toBe(true);
    expect(listOutboundPaths().find((p) => p.key === 'ttsCloudConsent')?.enabled).toBe(true);

    s.setTtsCloudConsent(false);
    // 撤回同意必须把偏好一起收回，否则会留下「想用云端但没有许可」的
    // 矛盾状态，而界面上还写着「云端」—— 那是另一种不诚实
    expect(useSettingsStore.getState().ttsPreference).toBe('browser');
    expect(listOutboundPaths().find((p) => p.key === 'ttsCloudConsent')?.enabled).toBe(false);
  });

  it('撤回云端翻译同意时，界面上的引擎不会继续指着云端', () => {
    const s = useSettingsStore.getState();
    s.setDefaultTranslationEngine('deepl');
    s.setCloudTranslationConsent(true);
    s.setCloudTranslationConsent(false);

    const eng = useSettingsStore.getState().defaultTranslationEngine;
    expect(eng === 'deepl' || eng === 'openai').toBe(false);
  });

  it('引擎偏好与同意位是分开的字段（选引擎不等于同意）', () => {
    const s = useSettingsStore.getState();
    s.setDefaultTranslationEngine('deepl');
    // 只选引擎，不勾同意 —— 这时**不允许**外发
    expect(useSettingsStore.getState().cloudTranslationConsent).toBe(false);
    expect(listOutboundPaths().find((p) => p.key === 'cloudTranslationConsent')?.enabled).toBe(
      false,
    );
  });

  it('语音偏好与同意位也是分开的（选云端不等于同意）', () => {
    const s = useSettingsStore.getState();
    s.setTtsPreference('cloud');
    expect(useSettingsStore.getState().ttsCloudConsent).toBe(false);
    // 偏好是云端、但没有同意 ⇒ 实际生效的引擎必须是浏览器原生
    expect(resolveTtsEngineId('cloud')).toBe('browser');
    expect(listOutboundPaths().find((p) => p.key === 'ttsCloudConsent')?.enabled).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────
// ③ 代码层第二道防线：状态被误置也不外发
// ───────────────────────────────────────────────────────────────

describe('③ 第二道防线：云端翻译在未同意时拒绝发请求', () => {
  it('未同意时 translateBlock 抛错，且**一个网络请求都没发出**', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('不该被调用：未同意却发出了请求');
    });
    vi.stubGlobal('fetch', fetchSpy);

    const s = useSettingsStore.getState();
    // 直接置成云端引擎，模拟"状态被误置"（localStorage 可被直接编辑）
    s.setDefaultTranslationEngine('deepl');
    s.setCloudTranslationConsent(false);
    expect(useSettingsStore.getState().cloudTranslationConsent).toBe(false);

    const block: ContentBlock = {
      id: 'b1',
      type: 'paragraph',
      content: '这是一段需要翻译的正文，用来验证未同意时不会外发。',
      translations: {},
      metadata: {},
    };

    await expect(
      translateBlock(block, 'en', { engine: 'deepl' }),
    ).rejects.toThrow(/未获同意|cloudTranslationConsent/);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('同意之后才会真的走到 fetch（证明上面的"没发请求"不是因为代码根本不通）', async () => {
    // 这是"探针"：没有它，上面那条的绿也可能只是"这段代码从来不 fetch"。
    // 需要把端点也补上 —— 否则会先撞上「未配置翻译端点」，
    // 那同样是一条与"同意"无关的失败（假保护的另一副面孔）。
    vi.stubEnv('VITE_TRANSLATE_ENDPOINT', 'https://proxy.test/api/translate');

    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => {
      throw new Error('probe: reached the network layer');
    });
    vi.stubGlobal('fetch', fetchSpy);

    const s = useSettingsStore.getState();
    s.setDefaultTranslationEngine('deepl');
    s.setCloudTranslationConsent(true);

    const block: ContentBlock = {
      id: 'b2',
      type: 'paragraph',
      content: '同意之后这一段应该会走到网络层。',
      translations: {},
      metadata: {},
    };

    await expect(
      translateBlock(block, 'en', { engine: 'deepl' }),
    ).rejects.toThrow(/probe: reached the network layer/);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // 顺手确认发出去的目标是端点本身（不是别的地方）
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe('https://proxy.test/api/translate');
  });

  it('源码里同意检查早于 fetch —— 不能先发出去再检查', () => {
    const src = RENDERER_SRC.translationService;
    const guard = src.indexOf('cloudTranslationConsent');
    const post = src.indexOf('await fetch(translateEndpoint()');
    expect(guard, 'translationService.ts 里找不到同意检查').toBeGreaterThan(-1);
    expect(post, 'translationService.ts 里找不到 fetch 调用').toBeGreaterThan(-1);
    expect(guard).toBeLessThan(post);
  });
});

describe('③ 第二道防线：云端语音在未同意时不会外发', () => {
  it('点名要 cloud 但没同意 ⇒ 拿到浏览器原生引擎（不是抛错、也不是云端）', () => {
    const s = useSettingsStore.getState();
    s.setTtsCloudConsent(false);
    const engine = createTTSEngine('cloud');
    expect(engine.id).toBe('browser');
  });

  /**
   * ⭐⭐ 这条是上面那条的**探针**，因为它一开始是「假保护」。
   *
   * 实测（变异 M4）：把 `createTTSEngine` 里的 `if (!consented) return
   * new BrowserTTSEngine();` 整行删掉，上面那条断言**依然是绿的** ——
   * 因为测试环境根本没配 `VITE_TTS_ENDPOINT`，`if (!endpoint)` 那一支
   * 会独立地返回浏览器引擎。也就是说它当时验的是「端点没配」，
   * 而不是它声称在验的「没有同意」。
   *
   * 修法是**把端点显式补上**，让「同意」成为唯一还在起作用的变量：
   * 端点已配置 = 能力具备。此时
   *   · 未同意 → 必须仍然是 browser（这条断言只可能被同意检查满足）
   *   · 已同意 → 必须变成 cloud（证明"降级"不是因为代码根本建不出来）
   */
  it('端点已配置时：未同意仍是 browser，同意后才变成 cloud', () => {
    vi.stubEnv('VITE_TTS_ENDPOINT', 'https://proxy.test/api/tts');
    const s = useSettingsStore.getState();

    // 能力已具备，但未同意 —— 唯一能把它挡回 browser 的就是同意检查
    s.setTtsCloudConsent(false);
    expect(createTTSEngine('cloud').id).toBe('browser');
    expect(resolveTtsEngineId('cloud')).toBe('browser');

    // 给出同意 —— 同一个端点、同一个偏好，此时必须变成云端
    s.setTtsCloudConsent(true);
    expect(createTTSEngine('cloud').id).toBe('cloud');
    expect(resolveTtsEngineId('cloud')).toBe('cloud');
  });

  it('端点在、偏好是 browser 时不会因为同意过就走云端', () => {
    // 反方向：同意是**必要**条件，不是**充分**条件。用户得同时选了云端。
    vi.stubEnv('VITE_TTS_ENDPOINT', 'https://proxy.test/api/tts');
    const s = useSettingsStore.getState();
    s.setTtsCloudConsent(true);
    s.setTtsPreference('browser');
    expect(resolveTtsEngineId('browser')).toBe('browser');
    expect(createTTSEngine('browser').id).toBe('browser');
  });

  it('源码里的同意检查在 CloudTTSEngine 内部、早于 fetch', () => {
    const src = RENDERER_SRC.ttsEngine;
    // 只看 CloudTTSEngine 这个类的那一段，避免匹配到工厂函数里那处
    const classStart = src.indexOf('export class CloudTTSEngine');
    expect(classStart, 'ttsEngine.ts 里找不到 CloudTTSEngine').toBeGreaterThan(-1);
    const classSrc = src.slice(classStart);

    const guard = classSrc.indexOf('ttsCloudConsent');
    const post = classSrc.indexOf('await fetch(this.endpoint');
    expect(guard, 'CloudTTSEngine 里找不到同意检查（第二道防线）').toBeGreaterThan(-1);
    expect(post, 'CloudTTSEngine 里找不到 fetch 调用').toBeGreaterThan(-1);
    expect(guard).toBeLessThan(post);
  });

  it('第二道防线真的会拦住：直接 new CloudTTSEngine 且未同意时 must throw', async () => {
    // 这条是上一条源码断言的**行为验证** —— 只有源码断言的话，
    // 把检查写在一个永远不执行的 if 里也能骗过它。
    const s = useSettingsStore.getState();
    s.setTtsCloudConsent(false);

    const engine = new CloudTTSEngine('/api/tts');
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => {
      throw new Error('probe: 不该走到这里');
    });
    vi.stubGlobal('fetch', fetchSpy);

    await expect(engine.speak('一段正文', 'zh-CN')).rejects.toThrow(
      /未获同意|ttsCloudConsent/,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('给出同意后同一个 CloudTTSEngine 会走到 fetch（探针）', async () => {
    const s = useSettingsStore.getState();
    s.setTtsCloudConsent(true);

    const engine = new CloudTTSEngine('https://proxy.test/api/tts');
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => {
      throw new Error('probe: reached the network layer');
    });
    vi.stubGlobal('fetch', fetchSpy);

    await expect(engine.speak('一段正文', 'zh-CN')).rejects.toThrow(
      /probe: reached the network layer/,
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('`auto` 这个取值已经从 TtsPreference 里删除（它本身就是那个洞）', () => {
    // 只改默认值是不够的：只要 'auto' 还在，"配了端点就用云端"这条规则
    // 就还在，下一个把它设回默认值的人会重新打开同一个洞。
    const src = RENDERER_SRC.ttsEngine;
    expect(src).not.toMatch(/preference === 'auto'/);
    const storeSrc = readFileSync(join(process.cwd(), 'src/store/settingsStore.ts'), 'utf8');
    expect(storeSrc).not.toMatch(/TtsPreference = 'auto'/);
    // 类型定义里只应有 browser / cloud
    expect(storeSrc).toMatch(/export type TtsPreference = 'browser' \| 'cloud'/);
  });
});

describe('③ 第二道防线：公式 OCR（既有实现，回归）', () => {
  it('source 里仍然保留第二道防线，且早于编码与上传', () => {
    const src = readFileSync(join(process.cwd(), 'src/services/formulaOcrService.ts'), 'utf8');
    const guard = src.indexOf('formulaOcrEnabled');
    const post = src.indexOf('await fetch(');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(post);
  });
});

// ───────────────────────────────────────────────────────────────
// ④ 代价透明：界面写清「什么内容、发到哪、为什么需要」
// ───────────────────────────────────────────────────────────────

describe('④ 代价透明：三条路径的说明都写在同一处、并可被断言', () => {
  it('每条路径的说明都回答了「什么内容 / 发到哪 / 为什么需要」', () => {
    for (const spec of OUTBOUND_PATH_SPECS) {
      expect(spec.detail, `${spec.key} 没写"为什么需要"`).toMatch(/为什么需要/);
      // 「发到哪」：必须点名具体的目的地，而不是含糊的"云端"
      expect(spec.detail, `${spec.key} 没说清发到哪`).toMatch(
        /SimpleTex|DeepL|OpenAI|Azure/,
      );
    }
  });

  it('设置面板渲染的就是这份清单（界面与代码事实同一出处）', () => {
    /**
     * ⚠️ 断言不能只写 `toMatch(/listOutboundPaths/)`。
     *
     * 实测（变异 M14）：把面板里真正的调用换成 `[] as ...`（保留 import）
     * 之后，那条断言**依然是绿的** —— 它匹配到的是 `import` 语句里的
     * 函数名，而不是"真的用它来渲染"。这是"读源码断言"最容易掉进去的坑：
     * 断言一个标识符出现过，而不是断言它被**使用**。
     *
     * 也不要用"调用点与 .map 的距离"那种写法：本次这段代码中间正好夹着
     * 一大段说明为什么必须订阅的注释，距离会长到让断言变红 ——
     * 而那是注释长度决定的，不是代码结构决定的（脆弱的假红）。
     *
     * 所以拆成两条**语义**断言：真的调用了它，且它的返回值被渲染出来。
     */
    const src = RENDERER_SRC.translationPanel;
    expect(src, '必须真的调用 listOutboundPaths()，不能只 import').toMatch(
      /=\s*useMemo\(\s*\(\)\s*=>\s*listOutboundPaths\(\)/,
    );
    expect(src, '外发清单必须被渲染出来（把返回值 map 成行）').toMatch(/paths\.map\(/);
  });

  it('设置面板订阅了三个开关位（否则清单会停在打开设置那一刻）', () => {
    const src = RENDERER_SRC.translationPanel;
    expect(src).toMatch(/formulaOcrEnabled/);
    expect(src).toMatch(/cloudTranslationConsent/);
    expect(src).toMatch(/ttsCloudConsent/);
  });

  it('云端翻译与云端语音的勾选框都在界面上，且都写了"发往哪里"', () => {
    expect(RENDERER_SRC.translationPanel).toMatch(/允许把正文发往云端翻译服务/);
    expect(RENDERER_SRC.translationPanel).toMatch(/DeepL 或 OpenAI/);
    expect(RENDERER_SRC.ttsPanel).toMatch(/允许把正文发往云端语音服务/);
    expect(RENDERER_SRC.ttsPanel).toMatch(/Azure 语音服务/);
  });

  it('旧文案「已配置云端代理就自动优先使用云端音色」必须已经不存在', () => {
    // 那句话描述的是被删掉的行为；留着它就是新的"文案说 A、代码做 B"
    expect(RENDERER_SRC.ttsPanel).not.toMatch(/自动优先使用云端音色/);
  });
});

// ───────────────────────────────────────────────────────────────
// manifest 的承诺
// ───────────────────────────────────────────────────────────────

describe('manifest 那句承诺与代码事实一致', () => {
  it('承诺原句保留（因为默认状态下它字面为真）', () => {
    expect(RENDERER_SRC.viteConfig).toMatch(/文档全程留在本机浏览器，不上传服务器/);
  });

  it('manifest 旁边的注释写明了三条例外路径 —— 不能只写"唯一"那条', () => {
    const src = RENDERER_SRC.viteConfig;
    expect(src).toMatch(/公式识别增强/);
    expect(src).toMatch(/云端翻译/);
    expect(src).toMatch(/云端语音/);
    expect(src).toMatch(/三条/);
  });
});

// ───────────────────────────────────────────────────────────────
// 安静降级：不可用时错误不能出现在阅读界面
// ───────────────────────────────────────────────────────────────

describe('翻译不可用时安静降级（不在阅读界面报错）', () => {
  /**
   * 这组断言针对的是「错误条刷屏」那个具体症状：
   * 原实现里 `useViewportTranslation` 的 catch 会把每一段的失败都
   * `setError(...)`，而 `ReaderView` 把 `translation.error` 渲染成
   * 一条常驻的错误条 —— 一段一条，滚到哪里刷到哪里，唯一的按钮是
   * 「知道了」。用户既不知道为什么，也不知道能做什么。
   *
   * 测试环境是 node（没有 DOM、没有 React 渲染器，见
   * `vitest.config.ts` 的 `environment: 'node'`），所以这里**不能**
   * 用组件测试来验，只能做源码级断言。这一点必须如实说明：
   * 它验的是"代码结构上没有这条路径"，不是"渲染出来确实看不到"。
   */
  const HOOK_SRC = readFileSync(
    join(process.cwd(), 'src/hooks/useViewportTranslation.ts'),
    'utf8',
  );
  const READER_SRC = readFileSync(join(process.cwd(), 'src/components/ReaderView.tsx'), 'utf8');

  /**
   * 把源码里的注释整段剥掉，只留代码。
   *
   * 为什么要这么做：本次修改恰好在 `ReaderView.tsx` 里写了一段注释解释
   * "这里以前把 translation.error 渲染出来"，于是朴素的
   * `not.toMatch(/translation\.error/)` **会因为解释性注释而变红** ——
   * 一个正确的实现被判成失败。这是"读源码断言"这种手法的固有代价：
   * 注释与代码在同一个字符串里，所以必须先分开。
   */
  function stripComments(src: string): string {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, '') // 整块 /* … */ 与 JSDoc
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');
  }

  it('阅读界面不再渲染 translation.error（错误条只留给朗读）', () => {
    const codeOnly = stripComments(READER_SRC);

    expect(codeOnly, 'ReaderView 不能再把 translation.error 渲染出来').not.toMatch(
      /translation\.error/,
    );
    // 朗读的错误仍然要报（用户刚点了播放，这时候安静才是错的）
    expect(codeOnly).toMatch(/tts\.error/);
  });

  it('朗读错误条有一个可操作的出路（不是只有「知道了」）', () => {
    expect(READER_SRC).toMatch(/去设置/);
    expect(READER_SRC).toMatch(/setPanel\('settings'\)/);
  });

  it('translateRange 在引擎不可用时直接返回，不入队（刷屏的根因就在这里）', () => {
    const guard = HOOK_SRC.indexOf('if (!engineUsable) return;');
    expect(guard, 'useViewportTranslation 里找不到 engineUsable 守卫').toBeGreaterThan(-1);

    // 守卫必须早于入队（queueRef.current.push）
    const enqueue = HOOK_SRC.indexOf('queueRef.current.push(block.id)');
    expect(enqueue).toBeGreaterThan(-1);
    expect(guard, '守卫必须早于入队').toBeLessThan(enqueue);
  });

  it('「翻译中…」占位也受 engineUsable 约束（否则会永远转下去）', () => {
    expect(READER_SRC).toMatch(/translation\.engineUsable/);
  });

  it('hook 把 engineUsable 暴露出来（界面靠它决定画不画译文列）', () => {
    expect(HOOK_SRC).toMatch(/engineUsable,/);
  });

  it('engineUsable 同时要求「有能力」与「已同意」', () => {
    // 云端那支必须同时看端点与同意位；只看端点就是"配置即同意"复发
    const memo = HOOK_SRC.slice(HOOK_SRC.indexOf('const engineUsable'));
    const body = memo.slice(0, memo.indexOf('}, ['));
    expect(body).toMatch(/hasCloudTranslationConfig\(\)/);
    expect(body).toMatch(/cloudConsent/);
    expect(body).toMatch(/detectBrowserTranslator\(\)/);
  });
});

// ───────────────────────────────────────────────────────────────
// 能力检测本身：两个方向
// ───────────────────────────────────────────────────────────────

/**
 * ⭐⭐ 浏览器内置翻译的 `sourceLanguage` 必须是**真的**语言标签。
 *
 * ═══════════════════════════════════════════════════════════════
 * 这是本次核实查出来的第三个缺陷，调研没有提到它
 * ═══════════════════════════════════════════════════════════════
 *
 * 原代码写的是 `sourceLanguage: 'auto'`。但规范（WebML CG Draft，
 * <https://webmachinelearning.github.io/translation-api/>）里
 * `TranslatorCreateOptions.sourceLanguage` 是 **`required DOMString`**，
 * 且要求"should be a valid BCP 47 language tag"——**没有自动检测这回事**。
 *
 * 用规范自己指定的校验算法（ECMA-402 language tag validation）实测：
 *
 *   node -e "new Intl.Locale('auto')"
 *   → RangeError: Incorrect locale information provided
 *   （同一次实测里 'en' / 'zh' / 'zh-Hans' / 'EN-us' 都通过）
 *
 * 所以 `create()` 必然以 `NotSupportedError` 失败 —— 亦即
 * **即使在支持这个 API 的 Chrome 上，浏览器内置翻译也从来没有成功过一次**。
 *
 * 下面这组测试不做源码匹配，而是**把参数抓下来看**：给一个假的
 * `Translator`，记录 `availability` / `create` 实际收到了什么。
 * 这样"把 'auto' 改回去"会立刻变红（实测变异 M6 正是这样被抓住的）。
 */
describe('浏览器内置翻译：传给 API 的源语言必须是真的 BCP 47 标签', () => {
  /** 装一个会记录调用参数的假 Translator，返回记录数组 */
  function installRecordingTranslator() {
    const calls: { availability: unknown[]; create: unknown[] } = {
      availability: [],
      create: [],
    };
    const g = globalThis as Record<string, unknown>;
    g.Translator = {
      availability: async (opts: unknown) => {
        calls.availability.push(opts);
        return 'available';
      },
      create: async (opts: unknown) => {
        calls.create.push(opts);
        return { translate: async (t: string) => `[译]${t}` };
      },
    };
    return calls;
  }

  /** 判断一个标签是否真的合法 —— 用规范指定的那套算法（ECMA-402） */
  function isValidLanguageTag(tag: unknown): boolean {
    if (typeof tag !== 'string' || !tag) return false;
    try {
      new Intl.Locale(tag);
      return true;
    } catch {
      return false;
    }
  }

  it('传给 availability/create 的 sourceLanguage 是合法标签，且不是 "auto"', async () => {
    const calls = installRecordingTranslator();
    try {
      // 用唯一的正文，避免命中同进程里别的测试留下的译文缓存
      const block: ContentBlock = {
        id: 'bcp47-probe',
        type: 'paragraph',
        content: 'The quick brown fox jumps over the lazy dog, uniquely for this probe.',
        translations: {},
        metadata: {},
      };

      const result = await translateBlock(block, 'zh', { engine: 'browser' });
      expect(result.translatedText).toContain('[译]');

      expect(calls.availability).toHaveLength(1);
      expect(calls.create).toHaveLength(1);

      for (const opts of [calls.availability[0], calls.create[0]]) {
        const src = (opts as { sourceLanguage?: unknown }).sourceLanguage;
        const tgt = (opts as { targetLanguage?: unknown }).targetLanguage;

        expect(src, 'sourceLanguage 不能是 "auto"（那不是合法 BCP 47 标签）').not.toBe('auto');
        expect(isValidLanguageTag(src), `sourceLanguage=${String(src)} 不是合法语言标签`).toBe(
          true,
        );
        expect(isValidLanguageTag(tgt), `targetLanguage=${String(tgt)} 不是合法语言标签`).toBe(
          true,
        );
        // 规范：源语言与目标语言相同会返回 unavailable，所以必须不同
        expect(src).not.toBe(tgt);
      }
    } finally {
      delete (globalThis as Record<string, unknown>).Translator;
    }
  });

  it('源语言与目标语言相同的文本会被如实识别，而不是发一次注定失败的请求', async () => {
    const calls = installRecordingTranslator();
    try {
      const block: ContentBlock = {
        id: 'bcp47-same-lang',
        type: 'paragraph',
        content: '这一段本来就是中文，目标语言也是中文，不该发出去翻译。',
        translations: {},
        metadata: {},
      };

      await expect(translateBlock(block, 'zh', { engine: 'browser' })).rejects.toThrow(
        /无需翻译|已经是/,
      );
      // 关键：一个 API 调用都不该发生
      expect(calls.availability).toHaveLength(0);
      expect(calls.create).toHaveLength(0);
    } finally {
      delete (globalThis as Record<string, unknown>).Translator;
    }
  });

  it('源语言取自文本本身（英文文本 → en），不是写死的', async () => {
    const calls = installRecordingTranslator();
    try {
      const block: ContentBlock = {
        id: 'bcp47-en',
        type: 'paragraph',
        // 足够的拉丁字母，让启发式判为 en
        content:
          'This paragraph is written entirely in English so the detector should report en for it.',
        translations: {},
        metadata: {},
      };

      await translateBlock(block, 'zh', { engine: 'browser' });

      expect((calls.create[0] as { sourceLanguage?: string }).sourceLanguage).toBe('en');
    } finally {
      delete (globalThis as Record<string, unknown>).Translator;
    }
  });
});

describe('能力检测：不假定 Translator 存在，也不假定它不存在', () => {  it('没有 Translator 时检测为 false', () => {
    const g = globalThis as Record<string, unknown>;
    const had = 'Translator' in g;
    const prev = g.Translator;
    delete g.Translator;
    try {
      expect(detectBrowserTranslator()).toBe(false);
    } finally {
      if (had) g.Translator = prev;
    }
  });

  it('有 Translator（构造函数形态）时检测为 true', () => {
    const g = globalThis as Record<string, unknown>;
    const had = 'Translator' in g;
    const prev = g.Translator;
    g.Translator = function Translator() {};
    try {
      expect(detectBrowserTranslator()).toBe(true);
    } finally {
      if (had) g.Translator = prev;
      else delete g.Translator;
    }
  });

  it('有 Translator（命名空间对象形态）时也检测为 true', () => {
    // 不同实现暴露方式不同：只认一种形态会在某个浏览器上
    // 把「可用」误判成「不可用」
    const g = globalThis as Record<string, unknown>;
    const had = 'Translator' in g;
    const prev = g.Translator;
    g.Translator = { availability: () => {}, create: () => {} };
    try {
      expect(detectBrowserTranslator()).toBe(true);
    } finally {
      if (had) g.Translator = prev;
      else delete g.Translator;
    }
  });
});
