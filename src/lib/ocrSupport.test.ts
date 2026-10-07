import { afterEach, describe, expect, it, vi } from 'vitest';

import { detectOcrSupport, detectProblemBrowser, describeOcrSupport } from '@/lib/ocrSupport';

/**
 * OCR 支持情况判定。
 *
 * ═══════════════════════════════════════════════════════════════
 * 这组断言对应一次很长的排查，以及第一版实现的失效
 * ═══════════════════════════════════════════════════════════════
 *
 * 用户报告扫描版 PDF 识别时页面会自己消失，而且**没有任何报错**。
 * 查到后来才由用户一句「Firefox、Chrome、Edge 都能用，但 360 不行」收束：
 * 是那个浏览器内核过旧且被魔改，把 ONNX 的 WASM 运行时干掉了。
 *
 * 第一版检测**只查了 WebAssembly 与 SIMD** —— 而 360 基于 Chromium，
 * 这两项很可能都通过，于是检测返回「支持」、提示根本不出现，
 * **对真正出问题的那台机器完全是哑的**。
 *
 * 所以现在要三条证据合起来判：能力、已知问题浏览器、上次是否真的崩过。
 * 下面把每一档的判定条件都钉死，避免再退化成「只查能力」。
 */

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('识别已知的问题浏览器（启发式）', () => {
  it('能认出导致本次故障的那个浏览器', () => {
    const ua =
      'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/86.0.4240.198 Safari/537.36 QIHU 360SE';
    expect(detectProblemBrowser(ua)).toBe('360 浏览器');
  });

  it('常见的其它外壳浏览器也能认出', () => {
    const cases: [string, string][] = [
      ['Mozilla/5.0 QQBrowser/11.0', 'QQ 浏览器'],
      ['Mozilla/5.0 (compatible; MSIE 9.0) MetaSr 1.0', '搜狗浏览器'],
      ['Mozilla/5.0 LBBROWSER', '猎豹浏览器'],
      ['Mozilla/5.0 2345Explorer/10.0', '2345 浏览器'],
      ['Mozilla/5.0 UBrowser/6.0', 'UC 浏览器'],
      ['Mozilla/5.0 Maxthon/5.0', '傲游浏览器'],
    ];
    for (const [ua, expected] of cases) {
      expect(detectProblemBrowser(ua), ua).toBe(expected);
    }
  });

  it('主流浏览器不会被误判', () => {
    expect(detectProblemBrowser(CHROME_UA)).toBeNull();
    expect(
      detectProblemBrowser('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0'),
    ).toBeNull();
    // Edge 的 UA 里有 "Edg"，不该被当成问题浏览器
    expect(
      detectProblemBrowser(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
      ),
    ).toBeNull();
  });

  it('空 UA 不炸，返回 null', () => {
    expect(detectProblemBrowser('')).toBeNull();
  });
});

describe('三档判定', () => {
  it('主流浏览器 + 能力齐备 + 没崩过 → ok，且不显示任何提示', () => {
    const s = detectOcrSupport({ userAgent: CHROME_UA });
    // 前提：测试环境的 Node 支持 WASM SIMD；若将来不支持，这条会失败并提醒我们改测试
    expect(s.details.simd).toBe(true);
    expect(s.level).toBe('ok');
    expect(s.reason).toBe('');
    expect(s.recommendation).toBe('');
  });

  it('能力缺失（无 SIMD）→ unsupported，硬阻断', () => {
    // 模拟旧内核：validate 一律返回 false
    vi.spyOn(WebAssembly, 'validate').mockReturnValue(false);

    const s = detectOcrSupport({ userAgent: CHROME_UA });
    expect(s.level).toBe('unsupported');
    expect(s.reason).toMatch(/内核版本过旧|SIMD/);
    // 无论哪一档，都必须给出可执行的建议
    expect(s.recommendation).toMatch(/Chrome/);
    expect(s.recommendation).toMatch(/Edge/);
    expect(s.recommendation).toMatch(/Firefox/);
  });

  it('能力齐备但是问题浏览器 → risky（提醒但不阻断）', () => {
    const ua = 'Mozilla/5.0 Chrome/86.0.4240.198 Safari/537.36 QIHU 360SE';
    const s = detectOcrSupport({ userAgent: ua });

    expect(s.details.simd).toBe(true); // 能力其实是通过的 —— 这正是第一版漏掉的情形
    expect(s.level).toBe('risky');
    expect(s.problemBrowser).toBe('360 浏览器');
    expect(s.reason).toContain('360 浏览器');
    expect(s.recommendation).toMatch(/Chrome/);
  });

  it('能力齐备、浏览器正常，但上次真的崩过 → risky，且说明是浏览器中断的', () => {
    /**
     * 这是最硬的一条证据：不是推断，而是**本机实测事实**。
     * 即使用户用的是主流浏览器，只要上次中断且刷新不是应用发起的，
     * 也应当提醒 —— 否则用户会反复重试同一件注定失败的事。
     */
    const s = detectOcrSupport({
      userAgent: CHROME_UA,
      hadInterruptedRun: true,
      interruptedByExternal: true,
    });

    expect(s.level).toBe('risky');
    expect(s.reason).toMatch(/上一次识别没有跑完/);
    expect(s.reason).toMatch(/浏览器自己中断/);
    expect(s.recommendation).toMatch(/Chrome/);
  });

  it('崩过但刷新是应用自己发起的 → 不误报（那属于正常更新，不是浏览器的问题）', () => {
    const s = detectOcrSupport({
      userAgent: CHROME_UA,
      hadInterruptedRun: true,
      interruptedByExternal: false,
    });

    expect(s.level).toBe('ok');
  });

  it('问题浏览器 + 崩过 → 仍然是 risky，且优先说明「崩过」这个更硬的事实', () => {
    const ua = 'Mozilla/5.0 Chrome/86.0 Safari/537.36 QIHU 360SE';
    const s = detectOcrSupport({
      userAgent: ua,
      hadInterruptedRun: true,
      interruptedByExternal: true,
    });

    expect(s.level).toBe('risky');
    expect(s.reason).toMatch(/上一次识别没有跑完/);
  });
});

describe('摘要（用于诊断轨迹）', () => {
  it('是一行文本，含档位与能力，且在有浏览器信息时带上浏览器名', () => {
    const text = describeOcrSupport({ userAgent: 'Mozilla/5.0 QQBrowser/11.0' });
    expect(text).not.toMatch(/\n/);
    expect(text).toMatch(/^risky|^ok|^unsupported/);
    expect(text).toMatch(/wasm=/);
    expect(text).toMatch(/simd=/);
    expect(text).toMatch(/QQ 浏览器/);
  });
});
