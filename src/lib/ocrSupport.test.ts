import { describe, expect, it } from 'vitest';

import { describeOcrSupport, detectOcrSupport } from '@/lib/ocrSupport';

/**
 * OCR 的环境能力检测。
 *
 * ═══════════════════════════════════════════════════════════════
 * 这组断言来自一次很长的排查，最后是靠一句话收束的
 * ═══════════════════════════════════════════════════════════════
 *
 * 「Firefox、Chrome、Microsoft Edge 都可以正常使用，但是 360 不行」
 *
 * 在此之前试过并逐一被否掉的假设：刷新逻辑、画布内存、WebGPU、PNG 编码、
 * 渲染 DPI、ONNX 线程数。诊断轨迹最终显示：画布只有 1667×2223（15MB）、
 * **JS 堆 32/1083 MB、设备内存 8GB**，也就是内存完全空闲，
 * 而进程仍死在推理调用里 —— 应用本身没有问题，
 * 是那个浏览器的旧内核把 ONNX 的 WASM 运行时干掉了。
 *
 * 教训：**能力检测要放在开始之前**，而不是等崩溃之后一路排查。
 * 所以这里检测的是「能力」而不是 User-Agent ——
 * UA 可以随便改，而且同一款浏览器的「极速模式」与「兼容模式」内核完全不同。
 */

describe('环境能力检测', () => {
  it('返回结构完整，且各字段类型正确', () => {
    const s = detectOcrSupport();
    expect(typeof s.ok).toBe('boolean');
    expect(typeof s.details.wasm).toBe('boolean');
    expect(typeof s.details.simd).toBe('boolean');
    expect(typeof s.details.crossOriginIsolated).toBe('boolean');
  });

  it('不支持时必须给出原因，且原因里包含可执行的建议', () => {
    const s = detectOcrSupport();
    if (!s.ok) {
      expect(s.reason).toBeTruthy();
      // 光是说"不支持"没用，必须告诉用户下一步做什么
      expect(s.reason).toMatch(/Chrome|Edge|Firefox/);
      // 并且说明只影响 OCR，避免用户以为整个应用都不能用
      expect(s.reason).toMatch(/不受影响/);
    }
  });

  it('检测结果与 ok 判定自洽：说支持就必须具备 wasm', () => {
    const s = detectOcrSupport();
    if (s.ok) {
      expect(s.details.wasm).toBe(true);
      // 支持时绝不能同时说 SIMD 不可用 —— 那正是会被判为不支持的条件
      expect(s.details.simd).toBe(true);
    }
  });

  it('Node（vitest 环境）里也能安全求值，不抛异常', () => {
    // Node 有 WebAssembly 但没有 DOM；检测不能在缺 DOM 的环境里炸掉
    expect(() => detectOcrSupport()).not.toThrow();
    expect(() => describeOcrSupport()).not.toThrow();
  });

  it('摘要是一行可读文本，便于记进诊断轨迹', () => {
    const text = describeOcrSupport();
    expect(text).toMatch(/^(支持|不支持)/);
    expect(text).toMatch(/wasm=/);
    expect(text).toMatch(/simd=/);
    // 不能含换行，否则塞进轨迹那一行会散架
    expect(text).not.toMatch(/\n/);
  });
});
