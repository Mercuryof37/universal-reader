import { describe, expect, it } from 'vitest';

import { resolveExecutionProviders } from '@/lib/ocrExecutionProvider';

/**
 * OCR 的推理后端选择。
 *
 * ═══════════════════════════════════════════════════════════════
 * 这组断言对应一次「静默进程死亡」
 * ═══════════════════════════════════════════════════════════════
 *
 * 用户实测（应用自带的诊断记录）：
 *   · 「刷新来源：不是应用发起的」——三条应用内刷新路径都没有记录；
 *   · 「中断前最后走到：recognize —— 第 1 页：开始识别」——
 *     画布已经渲染成功，是在**第一次推理**时进程没的，且没有任何 JS 报错。
 *
 * 而 `ppu-paddle-ocr` 在 web 平台上的默认后端是：
 *
 *   if (await isWebGpuAvailable()) return ["webgpu", "wasm"];
 *
 * 也就是**只要浏览器支持 WebGPU 就优先用它**。GPU 侧一旦出问题
 * （着色器编译、显存分配、驱动异常），整个渲染进程会被直接带走 ——
 * 页面上不留异常、不留日志，用户只看到「页面自己刷新了、结果全没了」。
 *
 * 所以默认必须是**只用 wasm**：慢一些，但不会因为显卡驱动把页面弄崩，
 * 出错时也会正常抛异常、能显示成错误横幅。
 */

describe('OCR 推理后端', () => {
  it('默认只用 wasm —— 不碰 WebGPU', () => {
    expect(resolveExecutionProviders(undefined)).toEqual(['wasm']);
    expect(resolveExecutionProviders('')).toEqual(['wasm']);
    expect(resolveExecutionProviders('0')).toEqual(['wasm']);
    expect(resolveExecutionProviders('false')).toEqual(['wasm']);
  });

  it('默认值里绝不能出现 webgpu（否则「识别时页面突然刷新」可能复现）', () => {
    expect(resolveExecutionProviders(undefined)).not.toContain('webgpu');
    expect(resolveExecutionProviders('0')).not.toContain('webgpu');
  });

  it('显式开启时才用 webgpu，且保留 wasm 作为回退', () => {
    expect(resolveExecutionProviders('1')).toEqual(['webgpu', 'wasm']);
    expect(resolveExecutionProviders('true')).toEqual(['webgpu', 'wasm']);
    // wasm 必须在列表里 —— 没有回退的话，WebGPU 建会话失败就直接不可用了
    expect(resolveExecutionProviders('1')).toContain('wasm');
  });

  it('永远返回非空列表（空数组会让 ONNX 用它的默认值，等于绕过我们的选择）', () => {
    for (const v of [undefined, '', '0', 'false', '1', 'true', 'anything']) {
      expect(resolveExecutionProviders(v).length).toBeGreaterThan(0);
    }
  });
});
