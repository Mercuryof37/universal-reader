import { describe, expect, it } from 'vitest';
import { detectMissedInkRegions, overlapRatio } from '@/lib/ocrInkRegions';

/**
 * 「有墨迹但没有识别词覆盖」区域检测的测试。
 *
 * ═══════════════════════════════════════════════════════════════
 * 这组测试对应的是「整块内容被识别器漏掉」这个真实故障
 * ═══════════════════════════════════════════════════════════════
 *
 * 用户实测：扫描版数学题 PDF 里跨行大括号的主分支
 * `f(x,y) = 1/2(x+y)e^{-(x+y)}` 整块从输出里消失，只剩 `0, 其他`。
 * 核对过块组装（只做字符串拼接，不丢字），所以那块内容不是后处理丢的，
 * 而是识别器对那种形状返回了空串、被 `if (!text) continue` 跳过。
 *
 * 后果是：`detectFormulaRegions()` 靠「已识别出的词」聚类找候选，
 * 那块区域一个词都没有 → 永远进不了公式增强的候选。
 *
 * 所以这里验的是**不依赖识别结果**的那条判据：图像上有没有墨迹。
 * 这些用例全部是**合成像素**，不依赖任何真实 PDF。
 */

type Rect = { x: number; y: number; w: number; h: number };

/** 造一张白底 ImageData，并在给定矩形内画深色像素 */
function makeImage(width: number, height: number, inks: Rect[]): ImageData {
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (const r of inks) {
    for (let y = Math.max(0, r.y); y < Math.min(height, r.y + r.h); y++) {
      for (let x = Math.max(0, r.x); x < Math.min(width, r.x + r.w); x++) {
        const p = (y * width + x) * 4;
        data[p] = 0;
        data[p + 1] = 0;
        data[p + 2] = 0;
        data[p + 3] = 255;
      }
    }
  }
  return { width, height, data, colorSpace: 'srgb' } as ImageData;
}

const wordAt = (x0: number, y0: number, x1: number, y1: number) => ({
  bbox: { x0, y0, x1, y1 },
});

describe('detectMissedInkRegions：有墨迹、没有词覆盖 → 必须被发现', () => {
  it('识别器漏掉的整块内容会被圈出来（本缺陷的核心断言）', () => {
    // 页面上半部分是识别成功的正文，下半部分是一整块「漏掉」的公式
    const image = makeImage(400, 400, [
      { x: 20, y: 20, w: 300, h: 30 }, // 已有词覆盖的正文
      { x: 40, y: 200, w: 320, h: 100 }, // 漏识别的公式块
    ]);
    const words = [wordAt(10, 10, 330, 60)];

    const regions = detectMissedInkRegions(image, words);

    expect(regions).toHaveLength(1);
    const region = regions[0]!;
    // 允许一个格子的量化误差（网格 16px）
    expect(region.y0).toBeGreaterThanOrEqual(180);
    expect(region.y1).toBeLessThanOrEqual(310);
    expect(region.x0).toBeGreaterThanOrEqual(30);
    expect(region.x0).toBeLessThanOrEqual(50);
    expect(region.inkRatio).toBeGreaterThan(0.5);
  });

  it('整页每个词都有覆盖时，不产生任何区域（不能无中生有）', () => {
    const image = makeImage(200, 200, [{ x: 10, y: 10, w: 180, h: 40 }]);
    const words = [wordAt(0, 0, 200, 60)];

    expect(detectMissedInkRegions(image, words)).toEqual([]);
  });

  it('没有词时，所有墨迹都算候选（识别彻底失败的那一页）', () => {
    const image = makeImage(200, 200, [{ x: 20, y: 20, w: 100, h: 60 }]);
    const regions = detectMissedInkRegions(image, []);

    expect(regions).toHaveLength(1);
    expect(regions[0]?.x0).toBeLessThanOrEqual(20);
    expect(regions[0]?.x1).toBeGreaterThanOrEqual(120);
  });

  it('空白页不产生区域', () => {
    expect(detectMissedInkRegions(makeImage(200, 200, []), [])).toEqual([]);
  });
});

describe('detectMissedInkRegions：误报边界', () => {
  it('只有一个格子的零星墨点不算区域（扫描噪点）', () => {
    // 一个落在单个网格内的深色小点（10×10 < 16px 格），低于 minCells=3
    const image = makeImage(200, 200, [{ x: 52, y: 52, w: 10, h: 10 }]);
    expect(detectMissedInkRegions(image, [])).toEqual([]);
  });

  it('词框只压住一部分墨迹时，剩下那部分仍被发现（部分覆盖不等于覆盖）', () => {
    // 墨迹是一整条 300×40，词只盖住它左边 100px
    const image = makeImage(400, 100, [{ x: 0, y: 20, w: 300, h: 40 }]);
    const regions = detectMissedInkRegions(image, [wordAt(0, 0, 100, 80)]);

    expect(regions.length).toBeGreaterThan(0);
    // 区域必须落在没被覆盖的右半部分
    expect(regions[0]!.x0).toBeGreaterThanOrEqual(100);
  });

  it('整页文字都被词覆盖时不产生区域（正常文字页是零误报）', () => {
    // 模拟 20 行文字，每行都有对应的词框
    const rects: Rect[] = [];
    const words = [];
    for (let i = 0; i < 20; i++) {
      const y = 20 + i * 40;
      rects.push({ x: 40, y, w: 600, h: 24 });
      words.push(wordAt(35, y - 5, 645, y + 29));
    }
    const image = makeImage(700, 900, rects);

    expect(detectMissedInkRegions(image, words)).toEqual([]);
  });

  it('墨迹占比过低的区域被过滤（淡淡的水印/污渍）', () => {
    // 400×400 上只有 20 个 2×2 的深色点：若有别的判据把它们并成一块，
    // 墨迹比例也远低于 3% 的下限
    const rects: Rect[] = [];
    for (let i = 0; i < 20; i++) rects.push({ x: 20 + i * 18, y: 100, w: 2, h: 2 });
    const image = makeImage(400, 400, rects);

    expect(detectMissedInkRegions(image, [])).toEqual([]);
  });

  it('两块相距很远的墨迹不会被并成一个区域', () => {
    const image = makeImage(400, 600, [
      { x: 20, y: 20, w: 100, h: 60 },
      { x: 20, y: 400, w: 100, h: 60 },
    ]);
    const regions = detectMissedInkRegions(image, []);

    expect(regions).toHaveLength(2);
    expect(regions[0]!.y1).toBeLessThan(regions[1]!.y0);
  });
});

describe('detectMissedInkRegions：输入健壮性', () => {
  it('尺寸为 0 的图返回空数组而不是抛错', () => {
    const empty = { width: 0, height: 0, data: new Uint8ClampedArray(0) } as ImageData;
    expect(detectMissedInkRegions(empty, [])).toEqual([]);
  });

  it('数据长度与尺寸不匹配时返回空数组（防止越界读取）', () => {
    const broken = { width: 100, height: 100, data: new Uint8ClampedArray(16) } as ImageData;
    expect(detectMissedInkRegions(broken, [])).toEqual([]);
  });

  it('词框坐标是 NaN 时跳过该词而不是整页失效', () => {
    const image = makeImage(200, 200, [{ x: 20, y: 20, w: 100, h: 60 }]);
    const words = [wordAt(Number.NaN, Number.NaN, Number.NaN, Number.NaN)];

    expect(() => detectMissedInkRegions(image, words)).not.toThrow();
  });
});

describe('overlapRatio：候选去重的判据', () => {
  it('完全重合是 1', () => {
    const a = { x0: 0, y0: 0, x1: 100, y1: 100 };
    expect(overlapRatio(a, { ...a })).toBe(1);
  });

  it('不相交是 0', () => {
    expect(
      overlapRatio({ x0: 0, y0: 0, x1: 10, y1: 10 }, { x0: 50, y0: 50, x1: 60, y1: 60 }),
    ).toBe(0);
  });

  it('小框完全落在大框里时是 1（这正是 IoU 会漏判的那种情况）', () => {
    const big = { x0: 0, y0: 0, x1: 200, y1: 100 };
    const small = { x0: 20, y0: 20, x1: 60, y1: 60 };
    // 用「较小者」做分母：小框被完全覆盖 → 1
    expect(overlapRatio(big, small)).toBe(1);
    // 对照：IoU 只有约 0.13，会被 0.5 的阈值判成「不重复」
    const inter = (60 - 20) * (60 - 20);
    const iou = inter / (200 * 100 + 40 * 40 - inter);
    expect(iou).toBeLessThan(0.2);
  });
});
