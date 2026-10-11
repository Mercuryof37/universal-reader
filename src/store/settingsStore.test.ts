import { describe, expect, it } from 'vitest';
import { resolveInitialEngine, useSettingsStore } from '@/store/settingsStore';
import { detectBrowserTranslator } from '@/lib/outboundPaths';

/**
 * 翻译引擎的初始值。
 *
 * ═══════════════════════════════════════════════════════════════
 * 这组测试对应一个真实的产品缺陷 —— 它**发作过两次**
 * ═══════════════════════════════════════════════════════════════
 *
 * **第一次**：`deepL` / `openai` 都需要 `VITE_TRANSLATE_ENDPOINT` 指向
 * 自建代理，该变量为空时 `translateBlock` **直接抛错**。而初始引擎原本
 * 硬编码为 `'deepl'`，导致**未配置代理的部署**上：用户一打开译文开关就
 * 收到「未配置翻译端点」—— 他并不知道要先去设置里换引擎。
 * （`.env.example` 还承诺 `VITE_DEFAULT_TRANSLATE_ENGINE` 可配置，
 * 但代码从未读取它，填了不起作用。）
 *
 * **第二次**：上一轮的修法是「没代理就退到 `'browser'`」。这只解决了
 * 「默认值指向一个必然失败的引擎」，**没有解决「目标引擎本身可用吗」**：
 * `'browser'` 要求 `globalThis.Translator` 存在（实验性 API，MDN 标为
 * Limited availability / 非 Baseline），而 Firefox 上没有 —— 用户主用
 * Firefox。于是同一条错误链换了个引擎名继续存在，**每一段翻译各刷一条
 * 红字**，而用户没有任何出路。
 *
 * ═══════════════════════════════════════════════════════════════
 * 所以下面钉的是「能力」，不是「名字」
 * ═══════════════════════════════════════════════════════════════
 *
 * 前两次共同的根因是同一个错误：**把一个「名字」当成「可用的东西」**。
 * 只改名字，病必然再发作（这正是它发作了两次的原因）。
 * 因此这组断言的形状是「**实测能力** → 默认值」，而且**两个方向都测**：
 * 有 `Translator` / 没有 `Translator`。这样任何一次「只改名字」的回归
 * 都会立刻变红，而不是继续绿着骗人。
 */

/** 装/卸 `Translator` 全局对象，跑完必然复原 */
function withTranslator<T>(present: boolean, fn: () => T): T {
  const g = globalThis as Record<string, unknown>;
  const had = 'Translator' in g;
  const prev = g.Translator;
  if (present) {
    g.Translator = {
      availability: async () => 'available',
      create: async () => ({ translate: async (t: string) => t }),
    };
  } else {
    delete g.Translator;
  }
  try {
    return fn();
  } finally {
    if (had) g.Translator = prev;
    else delete g.Translator;
  }
}

/** 这个测试环境等价于「零配置部署」吗 */
const zeroConfig =
  !import.meta.env.VITE_TRANSLATE_ENDPOINT && !import.meta.env.VITE_DEFAULT_TRANSLATE_ENGINE;

describe('翻译引擎初始值：由能力决定，不由名字决定', () => {
  const engine = useSettingsStore.getState().defaultTranslationEngine;

  it('在没有云端代理的部署上，不默认指向需要代理的引擎', () => {
    // 测试环境没有设置任何 VITE_* 变量，等价于「零配置部署」。
    // 此时若默认是 deepl，用户一开译文就会撞上「未配置翻译端点」的报错。
    if (!import.meta.env.VITE_TRANSLATE_ENDPOINT) {
      expect(engine).not.toBe('deepl');
      expect(engine).not.toBe('openai');
    }
  });

  it('默认值只会是合法引擎之一或者 null（null = 一个可用的都没有）', () => {
    expect(['deepl', 'openai', 'browser', null]).toContain(engine);
  });

  /**
   * ⭐ 这条是「Firefox 死路」的直接回归 —— 无能力方向。
   *
   * 没有 `Translator` + 没有云端端点 ⇒ **必须是 `null`**，而不是 `'browser'`。
   *
   * 以前 `settingsStore.test.ts:40-43` 断言的是 `toBe('browser')`。
   * 那条断言在 Firefox 上**等于断言了一个必然失败的状态**：
   * 测试是绿的，用户的路是死的。这是「假保护」最典型的样子 ——
   * 它保护的不是用户，是「上一轮那个改法看起来对」这个印象。
   */
  it('没有 Translator 又没有云端端点时，解析结果是 null（不再指向 browser）', () => {
    withTranslator(false, () => {
      expect(detectBrowserTranslator()).toBe(false);
      // 直接调用 store 初始化用的同一个函数 —— 不复制它的逻辑
      expect(resolveInitialEngine()).toBeNull();
    });
  });

  /** ⭐ 同一件事的另一个方向：有能力时必须是 browser（不能一律返回 null） */
  it('有 Translator 时，零配置部署落到浏览器内置翻译', () => {
    withTranslator(true, () => {
      expect(detectBrowserTranslator()).toBe(true);
      expect(resolveInitialEngine()).toBe('browser');
    });
  });

  it('自动选择永远不会选到会外发的云端引擎（除非部署方显式指定）', () => {
    // 「配了端点」只是能力，不是许可。自动降级只能降级到**不外发**的那个
    // 引擎，否则「零配置部署」会退回成「默认把正文发给 DeepL」——
    // 那正是本轮要修的第二类缺陷。
    const resolved = resolveInitialEngine();
    expect(resolved === 'deepl' || resolved === 'openai').toBe(
      Boolean(import.meta.env.VITE_DEFAULT_TRANSLATE_ENGINE),
    );
  });

  it('引擎可以被置为 null（「无可用引擎」是一个必须能表达的状态）', () => {
    const before = useSettingsStore.getState().defaultTranslationEngine;
    useSettingsStore.getState().setDefaultTranslationEngine(null);
    expect(useSettingsStore.getState().defaultTranslationEngine).toBeNull();
    useSettingsStore.getState().setDefaultTranslationEngine(before);
  });

  it('用户仍可在界面上改动引擎（默认值不锁死）', () => {
    const before = useSettingsStore.getState().defaultTranslationEngine;
    useSettingsStore.getState().setDefaultTranslationEngine('openai');
    expect(useSettingsStore.getState().defaultTranslationEngine).toBe('openai');

    // 复原，避免影响同一进程内的其他测试文件
    useSettingsStore.getState().setDefaultTranslationEngine(before);
  });

  it('在没有 Translator 的环境里，零配置部署的 store 初值不是 browser', () => {
    // store 初值是在模块求值时算的，那台机器上有 Translator 与否无从改变；
    // 这里断言的是**不变量**：这个环境没有 Translator 时，初值必定不是 browser。
    if (zeroConfig && !detectBrowserTranslator()) {
      expect(engine).not.toBe('browser');
    }
  });
});
