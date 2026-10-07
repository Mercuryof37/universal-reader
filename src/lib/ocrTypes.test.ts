import { describe, expect, it } from 'vitest';
import {
  OCR_BLANK_LUMA_THRESHOLD,
  OCR_MAX_PIXELS,
  OCR_RENDER_DPI,
  renderScaleFor,
  resolvePageLimit,
} from '@/lib/ocrTypes';

/**
 * OCR 参数与边界计算的测试。
 *
 * 背景：真实故障里，一本页面尺寸达 20.7×27 英寸的扫描书在 300 DPI 下
 * 渲染出 6200×8100 的 50 兆像素画布，超出下游图像库的处理能力，
 * 报 `Error attempting to read image.` 整个任务中止。
 */

describe('OCR 渲染参数', () => {
  it('像素上限必须显著低于实测的失控尺寸（50 MP）', () => {
    // 6200 × 8100 = 50.2 MP —— 这是触发故障的真实尺寸
    const failingPixels = 6200 * 8100;
    expect(OCR_MAX_PIXELS).toBeLessThan(failingPixels);
  });

  it('上限要按**内存**约束来定：单张画布不超过 100MB', () => {
    /**
     * 上限原先只按「不超过下游图像库的处理能力」定（40 MP），
     * 没有把内存算进去。而 40 MP 的画布 = 40e6 × 4 = **160MB**，
     * 再叠加约 30MB 模型、约 28MB ONNX WASM、PNG blob 与 ONNX 张量 ——
     * 结果就是用户实测到的：识别第 1 页时**标签页被浏览器回收**，
     * 没有任何报错，只表现为「页面自己刷新了、结果全没了」。
     *
     * 所以这里把内存约束**写成断言**，避免以后又只按图像库的限制去调大它。
     */
    const worstCaseCanvasBytes = OCR_MAX_PIXELS * 4; // RGBA
    expect(worstCaseCanvasBytes).toBeLessThanOrEqual(100 * 1024 * 1024);
  });

  it('上限也不能小到影响常规页面：A4 @300 DPI 必须碰不到它', () => {
    const a4At300 = Math.round((8.27 * OCR_RENDER_DPI) * (11.69 * OCR_RENDER_DPI));
    // 约 8.7 MP —— 常规页面完全不该被降采样
    expect(a4At300).toBeLessThan(OCR_MAX_PIXELS);
    // 留出足够余量：上限至少是 A4@300 的两倍，否则稍大的书页就会被压
    expect(OCR_MAX_PIXELS).toBeGreaterThan(a4At300 * 2);
  });

  it('空白判定阈值处于合理区间', () => {
    // 太宽松会把浅色正文页误判为空白；太严格则跳不掉真正的空白页
    expect(OCR_BLANK_LUMA_THRESHOLD).toBeGreaterThan(200);
    expect(OCR_BLANK_LUMA_THRESHOLD).toBeLessThanOrEqual(255);
  });
});

/**
 * 渲染缩放必须在**画布分配之前**算好。
 *
 * ═══════════════════════════════════════════════════════════════
 * 这组断言对应「扫描版 PDF 识别时页面自己刷新」的故障
 * ═══════════════════════════════════════════════════════════════
 *
 * 原来 `OCR_MAX_PIXELS` 只在 OCR 引擎内部生效：先把整页按 300 DPI
 * **画出来**，再缩到 40 MP。而那张画布是按原始尺寸分配的 ——
 * 20.7×27 英寸的页面就是 6200×8100 ≈ 50 MP ≈ **200MB**。
 * 峰值内存出现在缩放之前，下采样根本救不了它。
 *
 * 内存受限的设备（手机浏览器最明显）会直接回收标签页，
 * 表现为「页面莫名其妙自己刷新、结果全没了」，而且不会有任何报错。
 */
describe('renderScaleFor：把内存峰值压下来', () => {
  const A4 = { w: 8.27 * 72, h: 11.69 * 72 }; // PDF 点
  const HUGE = { w: 20.7 * 72, h: 27 * 72 }; // 触发过真实故障的尺寸

  it('正常尺寸不降采样 —— 快路径不受影响', () => {
    const scale = renderScaleFor(A4.w, A4.h);
    expect(scale).toBeCloseTo(OCR_RENDER_DPI / 72, 6);
  });

  it('大页面被压到像素上限以内（这是修法的核心）', () => {
    const scale = renderScaleFor(HUGE.w, HUGE.h);
    const pixels = HUGE.w * scale * (HUGE.h * scale);

    expect(pixels).toBeLessThanOrEqual(OCR_MAX_PIXELS);
    // 原来的行为会分配 50 MP ≈ 200MB，现在不能超过上限
    expect(HUGE.w * (OCR_RENDER_DPI / 72) * (HUGE.h * (OCR_RENDER_DPI / 72))).toBeGreaterThan(
      OCR_MAX_PIXELS,
    );
  });

  it('降采样保持等比 —— 不能把页面拉变形', () => {
    const scale = renderScaleFor(HUGE.w, HUGE.h);
    const ratioBefore = HUGE.w / HUGE.h;
    const ratioAfter = (HUGE.w * scale) / (HUGE.h * scale);
    expect(ratioAfter).toBeCloseTo(ratioBefore, 10);
  });

  it('非法尺寸退回理想缩放，而不是算出 NaN/负数把画布搞崩', () => {
    for (const [w, h] of [
      [0, 100],
      [100, 0],
      [-5, 100],
      [Number.NaN, 100],
      [Number.POSITIVE_INFINITY, 100],
    ]) {
      const scale = renderScaleFor(w as number, h as number);
      expect(Number.isFinite(scale)).toBe(true);
      expect(scale).toBeGreaterThan(0);
    }
  });
});

describe('resolvePageLimit', () => {
  it('不传上限时处理全部', () => {
    expect(resolvePageLimit(833)).toBe(833);
  });

  it('上限小于总页数时按上限', () => {
    expect(resolvePageLimit(833, 10)).toBe(10);
  });

  it('上限超过总页数时收敛到总页数', () => {
    expect(resolvePageLimit(20, 100)).toBe(20);
  });

  it('非正值视为不限，而不是一页都不处理', () => {
    // 关键：返回 0 会让"开始识别"按钮看起来坏了，且没有任何报错
    expect(resolvePageLimit(833, 0)).toBe(833);
    expect(resolvePageLimit(833, -5)).toBe(833);
    expect(resolvePageLimit(833, Number.NaN)).toBe(833);
  });

  it('小数上限向下取整', () => {
    expect(resolvePageLimit(833, 10.9)).toBe(10);
  });

  it('总页数非法时返回 0', () => {
    expect(resolvePageLimit(0)).toBe(0);
    expect(resolvePageLimit(-1)).toBe(0);
    expect(resolvePageLimit(Number.NaN)).toBe(0);
  });
});
