import { describe, expect, it } from 'vitest';
import { useSettingsStore } from '@/store/settingsStore';

/**
 * 翻译引擎的初始值。
 *
 * ═══════════════════════════════════════════════════════════════
 * 这组测试对应一个真实的「零配置部署体验」缺陷
 * ═══════════════════════════════════════════════════════════════
 *
 * `deepL` / `openai` 都需要 `VITE_TRANSLATE_ENDPOINT` 指向自建代理，
 * 该变量为空时 `translateBlock` **直接抛错**。
 *
 * 而初始引擎原本硬编码为 `'deepl'`，导致**未配置代理的部署**上：
 * 用户一打开译文开关就收到「未配置翻译端点」——
 * 他并不知道要先去设置里换引擎。
 *
 * 同时 `.env.example` 承诺 `VITE_DEFAULT_TRANSLATE_ENGINE` 可配置，
 * 但代码从未读取它，填了不起作用。
 *
 * 下面几条断言把「默认值必须与部署形态匹配」这条规则钉死。
 */

describe('翻译引擎初始值', () => {
  const engine = useSettingsStore.getState().defaultTranslationEngine;

  it('在没有云端代理的部署上，不默认指向需要代理的引擎', () => {
    // 测试环境没有设置任何 VITE_* 变量，等价于「零配置部署」。
    // 此时若默认是 deepl，用户一开译文就会撞上「未配置翻译端点」的报错。
    if (!import.meta.env.VITE_TRANSLATE_ENDPOINT) {
      expect(engine).not.toBe('deepl');
      expect(engine).not.toBe('openai');
    }
  });

  it('默认值是三个合法引擎之一', () => {
    expect(['deepl', 'openai', 'browser']).toContain(engine);
  });

  it('零配置时落到浏览器内置翻译（它不需要密钥与网络端点）', () => {
    if (!import.meta.env.VITE_TRANSLATE_ENDPOINT && !import.meta.env.VITE_DEFAULT_TRANSLATE_ENGINE) {
      expect(engine).toBe('browser');
    }
  });

  it('用户仍可在界面上改动引擎（默认值不锁死）', () => {
    const before = useSettingsStore.getState().defaultTranslationEngine;
    useSettingsStore.getState().setDefaultTranslationEngine('openai');
    expect(useSettingsStore.getState().defaultTranslationEngine).toBe('openai');

    // 复原，避免影响同一进程内的其他测试文件
    useSettingsStore.getState().setDefaultTranslationEngine(before);
  });
});
