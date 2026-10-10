import { describe, expect, it } from 'vitest';
import {
  admitRetryWords,
  detectMissedInkRegions,
  overlapRatio,
  planRetryCrop,
} from '@/lib/ocrInkRegions';

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

/**
 * 「本地重试」救回的词如何并进词表。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么这两条判据缺一不可
 * ═══════════════════════════════════════════════════════════════
 *
 * 救回的词是**放大裁剪**上识别出来的，坐标全在裁剪坐标系里，
 * 不映射回原图就是「贴错地方的文字」—— 比没有更糟，因为用户
 * 无法分辨哪些字是错的。所以坐标映射是第一条判据。
 *
 * 第二条是去重：裁剪四周留了白（否则大括号的钩会被切掉），
 * 于是靠近区域的**邻居正文**也会被一起认出来 —— 不过滤的话
 * 同一句话会在正文里出现两遍。重复内容同样是「错」而不是「多」。
 */

/** 造一个「裁剪坐标系里的识别结果」 */
const retryItem = (
  text: string,
  x: number,
  y: number,
  width: number,
  height: number,
  confidence = 0.9,
) => ({ text, confidence, box: { x, y, width, height } });

describe('admitRetryWords：放大裁剪上的识别结果映射回原图', () => {
  it('坐标按「原点 + 裁剪坐标 ÷ 放大倍数」映射（真实故障页的几何）', () => {
    // 真实几何：漏识别的跨行大括号区域在页面 (225, 460) 附近，
    // 裁剪时向外扩了留白（px=201, py=455）、放大 3 倍
    const frame = { originX: 201, originY: 455, scale: 3 };
    // 被救回的主分支在裁剪上是 ((225-201)*3, (460-455)*3) = (72, 15)
    const admitted = admitRetryWords([retryItem('f(x,y)', 72, 15, 180, 72)], frame, []);

    expect(admitted).toHaveLength(1);
    const word = admitted[0]!;
    expect(word.text).toBe('f(x,y)');
    // 映射回原图：201 + 72/3 = 225，455 + 15/3 = 460
    expect(word.bbox).toEqual({ x0: 225, y0: 460, x1: 285, y1: 484 });
    // 字号是原图尺度的高度（不是放大后画布上的 72）
    expect(word.fontSize).toBe(24);
    // 置信度按全站口径转成 0-100 的整数
    expect(word.confidence).toBe(90);
  });

  it('置信度保留一位精度后四舍五入（0.935 → 94）', () => {
    const admitted = admitRetryWords(
      [retryItem('p', 0, 0, 30, 30, 0.935)],
      { originX: 0, originY: 0, scale: 1 },
      [],
    );
    expect(admitted[0]!.confidence).toBe(94);
  });

  it('scale 传 0 时按 1 处理（防御：绝不会除零）', () => {
    const admitted = admitRetryWords(
      [retryItem('x', 10, 20, 30, 40)],
      { originX: 5, originY: 5, scale: 0 },
      [],
    );
    expect(admitted).toHaveLength(1);
    expect(admitted[0]!.bbox).toEqual({ x0: 15, y0: 25, x1: 45, y1: 65 });
  });
});

describe('admitRetryWords：重复词必须被挡掉（留白会带进邻居正文）', () => {
  it('与已有词重叠的新结果被丢弃', () => {
    // 已有正文词覆盖 x∈[100,200]、y∈[100,140]
    const existing = [{ bbox: { x0: 100, y0: 100, x1: 200, y1: 140 } }];
    // 裁剪留白把它也带了进来，识别结果几乎完全落在同一个位置
    const duplicate = retryItem('邻', 110, 105, 80, 30);

    const admitted = admitRetryWords([duplicate], { originX: 0, originY: 0, scale: 1 }, existing);

    expect(admitted).toEqual([]);
  });

  it('同一批救回的词之间也不许重复', () => {
    const items = [retryItem('f', 50, 50, 60, 24), retryItem('f', 52, 51, 60, 24)];
    const admitted = admitRetryWords(items, { originX: 0, originY: 0, scale: 1 }, []);

    expect(admitted).toHaveLength(1);
  });

  it('与已有词不重叠时保留 —— 去重不能误伤真正救回的内容', () => {
    const existing = [{ bbox: { x0: 100, y0: 100, x1: 200, y1: 140 } }];
    const rescued = retryItem('f(x,y)', 210, 100, 120, 40);

    const admitted = admitRetryWords([rescued], { originX: 0, originY: 0, scale: 1 }, existing);

    expect(admitted).toHaveLength(1);
    expect(admitted[0]!.text).toBe('f(x,y)');
  });

  it('相邻但只擦到一点边（重叠占比较小者不足一半）不算重复', () => {
    // 已有词与救回词在 x 上只重叠 20px，而救回词的宽度是 100px
    const existing = [{ bbox: { x0: 100, y0: 100, x1: 180, y1: 140 } }];
    const rescued = retryItem('y', 160, 100, 100, 40);

    const admitted = admitRetryWords([rescued], { originX: 0, originY: 0, scale: 1 }, existing);

    expect(admitted).toHaveLength(1);
  });
});

/**
 * 裁边碎片：裁剪边恰好切过一行正文时，半截笔画会被读成一段假文本。
 *
 * run61 实测：③ 的重试裁剪顶边（y=955）切过页眉行 [211,931,756,974] 的
 * 下缘，识别器把残余笔画读成 `.议随机变量(A，1)的概率出度为`。假行与
 * 原词的重叠占比只有 0.486 —— 差 0.014 就能被 0.5 的重复阈值挡掉，
 * 于是垃圾词混进了正文。判据必须换成几何的：框从裁剪边伸进来、
 * 且与跨过该边的既有词有 x 交叠。
 */
describe('admitRetryWords：裁边碎片（裁剪边切过邻居正文时读出的假行）', () => {
  /** run61 的裁剪矩形：③ 的重试裁剪 (247,955) 起，524×144，放大 3 倍 */
  const crop = { x0: 247, y0: 955, x1: 771, y1: 1099 };
  const frame = { originX: 247, originY: 955, scale: 3 };
  /** 页眉行：纵向跨过裁剪顶边 y=955，与假行 x 交叠 509px */
  const header = { bbox: { x0: 211, y0: 931, x1: 756, y1: 974 } };

  it('真实几何：贴顶边的假行与页眉重叠 0.486（不足 0.5）—— 由几何判据丢弃', () => {
    // 识别器输出整行框 (0,0,1572×114)，映射回原图 = (247,955)-(771,993)
    const garbage = retryItem('.议随机变量(A，1)的概率出度为', 0, 0, 1572, 114);
    expect(overlapRatio(header.bbox, { x0: 247, y0: 955, x1: 771, y1: 993 })).toBeLessThan(0.5);

    const admitted = admitRetryWords([garbage], frame, [header], crop);

    expect(admitted).toEqual([]);
  });

  it('不传 cropRect 时行为与改动前一致（公式恢复路径不启用这条判据）', () => {
    const garbage = retryItem('.议随机变量(A，1)的概率出度为', 0, 0, 1572, 114);
    const admitted = admitRetryWords([garbage], frame, [header]);

    expect(admitted).toHaveLength(1);
    expect(admitted[0]!.text).toBe('.议随机变量(A，1)的概率出度为');
  });

  it('下边对称：贴底边、且与跨过底边的词有 x 交叠的碎片被丢弃', () => {
    // 裁剪底边 y=1099 切过下方词 [300,1090,700,1130] 的上缘
    const below = { bbox: { x0: 300, y0: 1090, x1: 700, y1: 1130 } };
    // 碎片框贴底边：映射后 y1 = 1099
    const fragment = retryItem('假行', 159, 144, 1530, 288); // (300,1003)-(810,1099)

    const admitted = admitRetryWords([fragment], frame, [below], crop);

    expect(admitted).toEqual([]);
  });

  it('救回词在裁剪中部、不贴边 → 保留（页眉跨过顶边也不牵连它）', () => {
    const rescued = retryItem('f(x,y)', 159, 144, 510, 90); // (300,1003)-(470,1033)
    const admitted = admitRetryWords([rescued], frame, [header], crop);

    expect(admitted).toHaveLength(1);
    expect(admitted[0]!.text).toBe('f(x,y)');
  });

  it('贴边碎片与跨边词的 x 不相交 → 保留（宁可少丢，不误伤分栏内容）', () => {
    const disjoint = retryItem('右侧一栏', 1590, 0, 300, 114); // (777,955)-(877,993)
    const admitted = admitRetryWords([disjoint], frame, [header], crop);

    expect(admitted).toHaveLength(1);
  });

  it('离裁剪边超过容差（1.5px）→ 不算裁边碎片', () => {
    // 框顶离裁剪边 2px（> 1.5px 容差）；比页眉行矮一截，去重占比 0.395 < 0.5
    const nearEdge = retryItem('x>0', 459, 6, 300, 129); // (400,957)-(500,1000)
    const admitted = admitRetryWords([nearEdge], frame, [header], crop);

    expect(admitted).toHaveLength(1);
    expect(admitted[0]!.text).toBe('x>0');
  });
});

describe('admitRetryWords：脏输入', () => {
  it('空白文本被丢弃（识别器偶尔会给出空串）', () => {
    const items = [retryItem('   ', 0, 0, 50, 30), retryItem('', 60, 0, 50, 30)];
    expect(admitRetryWords(items, { originX: 0, originY: 0, scale: 1 }, [])).toEqual([]);
  });

  it('文本两端的空白被去掉', () => {
    const admitted = admitRetryWords(
      [retryItem('  f(x,y)  ', 0, 0, 50, 30)],
      { originX: 0, originY: 0, scale: 1 },
      [],
    );
    expect(admitted[0]!.text).toBe('f(x,y)');
  });

  it('宽或高为 0 的框被丢弃（不是可用的词框）', () => {
    const items = [retryItem('a', 0, 0, 0, 30), retryItem('b', 0, 0, 30, 0)];
    expect(admitRetryWords(items, { originX: 0, originY: 0, scale: 1 }, [])).toEqual([]);
  });

  it('没有候选时返回空数组', () => {
    expect(admitRetryWords([], { originX: 0, originY: 0, scale: 1 }, [])).toEqual([]);
  });
});

/**
 * 放大裁剪的几何计划。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么这些算术值得单测
 * ═══════════════════════════════════════════════════════════════
 *
 * 这段算术同时决定三件事：裁剪**裁到哪里**（错了就裁到别的内容）、
 * 结果**坐标怎么换算回去**（错了就贴错位置），以及**要花多少推理**
 * （错了就可能把一页的等待时间翻几倍）。而且它全是边界运算 ——
 * 贴边、超像素上限、上限非法，正是最容易写出静默错误的地方。
 *
 * 于是这段逻辑放在纯模块里（无 DOM 也能跑），渲染画布那一步留给
 * `ocrEngine`。
 */

/** 真实页面量级：2000×3000 的原图（约 200 DPI 的 A4） */
const PAGE_W = 2000;
const PAGE_H = 3000;

describe('planRetryCrop：裁剪几何与放大倍数', () => {
  it('基本几何：留白 8%（至少 2px）、放大到指定倍数', () => {
    // 100×50 的区域 → 留白 max(2, round(100*0.08)) = 8
    const plan = planRetryCrop(PAGE_W, PAGE_H, { x0: 30, y0: 40, x1: 130, y1: 90 }, 3, 2_500_000);

    expect(plan).not.toBeNull();
    expect({ px: plan!.px, py: plan!.py, pw: plan!.pw, ph: plan!.ph }).toEqual({
      px: 22,
      py: 32,
      pw: 116,
      ph: 66,
    });
    expect(plan!.scale).toBe(3);
    expect({ targetW: plan!.targetW, targetH: plan!.targetH }).toEqual({ targetW: 348, targetH: 198 });
  });

  it('贴左上角的区域：留白不越出页面（px/py 夹到 0）', () => {
    const plan = planRetryCrop(PAGE_W, PAGE_H, { x0: 0, y0: 0, x1: 100, y1: 50 }, 3, 2_500_000);

    expect(plan!.px).toBe(0);
    expect(plan!.py).toBe(0);
    // 右上、下方照常留白
    expect(plan!.pw).toBe(116);
    expect(plan!.ph).toBe(66);
  });

  it('贴右下角的区域：宽高按剩下的页面裁掉，不画到页面外', () => {
    // 区域本身越出页面（x1=210 > 200）：只取页面内的 20×20
    const plan = planRetryCrop(200, 200, { x0: 180, y0: 180, x1: 210, y1: 230 }, 3, 2_500_000);

    expect(plan!.px).toBe(178);
    expect(plan!.py).toBe(178);
    expect(plan!.pw).toBe(22);
    expect(plan!.ph).toBe(22);
    expect(plan!.px + plan!.pw).toBeLessThanOrEqual(200);
    expect(plan!.py + plan!.ph).toBeLessThanOrEqual(200);
  });

  it('像素上限压制放大：大区域只放大到装得下为止', () => {
    // 1000×800 的区域留白后 1160×960 ≈ 1.11MP，上限 2.5MP → 只能放大 √2.245 ≈ 1.498 倍
    const plan = planRetryCrop(PAGE_W, PAGE_H, { x0: 100, y0: 100, x1: 1100, y1: 900 }, 3, 2_500_000);
    const fit = Math.sqrt(2_500_000 / (1160 * 960));

    expect(plan!.scale).toBeCloseTo(fit, 5);
    expect(plan!.scale).toBeGreaterThan(1);
    expect(plan!.scale).toBeLessThan(3);
    // 放大后的面积必须落在上限内（这正是预算判定的依据）
    expect(plan!.targetW * plan!.targetH).toBeLessThanOrEqual(2_500_000 + 4096);
  });

  it('永远不缩小：装不下时按原尺寸裁剪（scale 保持 1）', () => {
    // 3000×1500 的区域被页面宽度夹到 2000×1820 ≈ 3.6MP，仍超过 2.5MP 上限
    const plan = planRetryCrop(PAGE_W, PAGE_H, { x0: 0, y0: 0, x1: 3000, y1: 1500 }, 3, 2_500_000);

    expect(plan!.scale).toBe(1);
    expect(plan!.targetW).toBe(plan!.pw);
    expect(plan!.targetH).toBe(plan!.ph);
  });

  it('像素上限非法（0 / NaN）时退化为「不放大」，不抛错也不除零', () => {
    for (const maxPixels of [0, Number.NaN, -100]) {
      const plan = planRetryCrop(PAGE_W, PAGE_H, { x0: 30, y0: 40, x1: 130, y1: 90 }, 3, maxPixels);
      expect(plan!.scale).toBe(1);
    }
  });

  it('退化输入返回 null：空图、倒置的框、完全在页面外的框', () => {
    expect(planRetryCrop(0, 0, { x0: 0, y0: 0, x1: 50, y1: 50 }, 3, 2_500_000)).toBeNull();
    expect(planRetryCrop(PAGE_W, PAGE_H, { x0: 100, y0: 100, x1: 100, y1: 100 }, 3, 2_500_000)).toBeNull();
    expect(planRetryCrop(PAGE_W, PAGE_H, { x0: 3000, y0: 100, x1: 3200, y1: 200 }, 3, 2_500_000)).toBeNull();
  });

  it('坐标换算闭环：裁剪坐标 ÷ scale + 原点 = 原图坐标（救回词贴对位置的前提）', () => {
    const region = { x0: 225, y0: 460, x1: 525, y1: 520 };
    const plan = planRetryCrop(PAGE_W, PAGE_H, region, 3, 2_500_000)!;
    // 区域内任意一点在裁剪图上的位置，映射回来必须与原点一致
    const probe = { x: 300, y: 480 };
    const onCrop = { x: (probe.x - plan.px) * plan.scale, y: (probe.y - plan.py) * plan.scale };
    expect(plan.px + onCrop.x / plan.scale).toBeCloseTo(probe.x, 6);
    expect(plan.py + onCrop.y / plan.scale).toBeCloseTo(probe.y, 6);
  });
});
