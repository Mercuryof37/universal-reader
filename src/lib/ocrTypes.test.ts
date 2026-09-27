import { describe, expect, it } from 'vitest';
import {
  OCR_BLANK_LUMA_THRESHOLD,
  OCR_MAX_PIXELS,
  OCR_RENDER_DPI,
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
    // 但也不能小到影响识别率：OCR 在 200 DPI 左右接近上限，
    // 40 MP 相当于 A4 上约 550 DPI，余量充足
    expect(OCR_MAX_PIXELS).toBeGreaterThan(20_000_000);
  });

  it('300 DPI 下 A4 尺寸不触发降采样（正常文档走快路径）', () => {
    const a4At300 = Math.round((8.27 * OCR_RENDER_DPI) * (11.69 * OCR_RENDER_DPI));
    expect(a4At300).toBeLessThan(OCR_MAX_PIXELS);
  });

  it('空白判定阈值处于合理区间', () => {
    // 太宽松会把浅色正文页误判为空白；太严格则跳不掉真正的空白页
    expect(OCR_BLANK_LUMA_THRESHOLD).toBeGreaterThan(200);
    expect(OCR_BLANK_LUMA_THRESHOLD).toBeLessThanOrEqual(255);
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
