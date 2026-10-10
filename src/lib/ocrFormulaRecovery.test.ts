import { describe, expect, it } from 'vitest';
import {
  HOLE_MIN_RATIO,
  buildInkGrid,
  findFragmentWordsInRegion,
  findGarbageWordsInRegion,
  findInkBands,
  foldForMatch,
  foldedContains,
  holeRatio,
  isGarbageWord,
  isPunctuationOnly,
  mergeFormulaRegions,
  planRegionReplacement,
  regionGateDecision,
} from '@/lib/ocrFormulaRecovery';
import type { OcrWord } from '@/lib/ocrTypes';

/**
 * 版面包带式公式恢复的测试。
 *
 * 全部对着**实测数据**标定（习题 5 页面四段大括号公式的行剖面），
 * 像素为合成，不依赖任何真实 PDF。
 */

type Rect = { x: number; y: number; w: number; h: number };

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

const word = (
  text: string,
  bbox: { x0: number; y0: number; x1: number; y1: number },
  confidence = 95,
  fontSize = 20,
): OcrWord => ({ text, confidence, bbox, fontSize });

describe('mergeFormulaRegions：同一段公式的多块区域先并起来', () => {
  it('实测三块重叠区域（f_X‖f_Y 大括号系统）并成一个 [297,471,1082,560]', () => {
    const merged = mergeFormulaRegions([
      { x0: 712, y0: 471, x1: 1082, y1: 560, label: 'formula' },
      { x0: 310, y0: 474, x1: 1081, y1: 559, label: 'formula' },
      { x0: 297, y0: 475, x1: 680, y1: 556, label: 'formula' },
    ]);
    expect(merged).toEqual([{ x0: 297, y0: 471, x1: 1082, y1: 560 }]);
  });

  it('只取公式标签；正文卡片区域被过滤', () => {
    const merged = mergeFormulaRegions([
      { x0: 100, y0: 100, x1: 200, y1: 200, label: 'text' },
      { x0: 300, y0: 300, x1: 400, y1: 400, label: 'formula' },
    ]);
    expect(merged).toEqual([{ x0: 300, y0: 300, x1: 400, y1: 400 }]);
  });

  it('相距很远的两段公式不并组，按上→下、左→右排序', () => {
    const merged = mergeFormulaRegions([
      { x0: 300, y0: 900, x1: 400, y1: 1000, label: 'formula' },
      { x0: 100, y0: 100, x1: 200, y1: 200, label: 'formula' },
    ]);
    expect(merged).toEqual([
      { x0: 100, y0: 100, x1: 200, y1: 200 },
      { x0: 300, y0: 900, x1: 400, y1: 1000 },
    ]);
  });

  it('非法区域（宽高 ≤0、非有限数）不参与', () => {
    const merged = mergeFormulaRegions([
      { x0: 100, y0: 100, x1: 100, y1: 200, label: 'formula' },
      { x0: 0, y0: 0, x1: Number.NaN, y1: 100, label: 'formula' },
    ]);
    expect(merged).toEqual([]);
  });
});

describe('findInkBands：行带切分（跨行大括号的核心）', () => {
  it('两行间距 3 行以上：阈值法直接切成两条带', () => {
    const image = makeImage(200, 200, [
      { x: 10, y: 20, w: 180, h: 24 },
      { x: 10, y: 80, w: 180, h: 28 },
    ]);
    const bands = findInkBands(image, { x0: 0, y0: 0, x1: 200, y1: 200 }, { dominantFontSize: 20 });
    expect(bands).toHaveLength(2);
    expect(bands[0]).toMatchObject({ y0: 20, y1: 44 });
    expect(bands[1]).toMatchObject({ y0: 80, y1: 108 });
  });

  it('间隔只有 1 行仍在同一带内；带内 <3 行的碎点被丢掉', () => {
    const image = makeImage(200, 200, [
      { x: 10, y: 20, w: 180, h: 24 },
      { x: 10, y: 48, w: 180, h: 24 },
      { x: 10, y: 100, w: 180, h: 8 }, // 只有 2 行 → 噪点
    ]);
    const bands = findInkBands(image, { x0: 0, y0: 0, x1: 200, y1: 200 }, { dominantFontSize: 20 });
    expect(bands).toHaveLength(1);
    expect(bands[0]).toMatchObject({ y0: 20, y1: 72 });
  });

  it('大括号把两行连成一条 19 行长带：在腰（墨迹最少行）下刀', () => {
    // 复刻实测剖面：上排 8 行、谷 2 行（2 格墨）、下排 9 行 —— 谷在相对第 8 行
    const ink: Rect[] = [
      { x: 0, y: 0, w: 200, h: 32 }, // 上排
      { x: 100, y: 32, w: 8, h: 8 }, // 大括号腰（2 格墨）
      { x: 0, y: 40, w: 200, h: 36 }, // 下排
    ];
    const image = makeImage(200, 100, ink);
    const bands = findInkBands(image, { x0: 0, y0: 0, x1: 200, y1: 100 }, { dominantFontSize: 36 });
    expect(bands).toHaveLength(2);
    // 刀口 = 谷行上一行的上沿：0+(8-1)*4 = 28
    expect(bands[0]).toMatchObject({ y0: 0, y1: 28 });
    expect(bands[1]).toMatchObject({ y0: 28, y1: 76 });
  });

  it('谷连片两行（27/26 格，深度只有 0.52）仍切：FXFY 例的真谷', () => {
    // 复刻实测 FXFY 例：谷的深度 16/30 = 0.53 —— 只比「一半」深一点点，
    // 强度判据放行它；两行连片（0.75×中位数以下）才是它和分数横线的分别。
    const image = makeImage(200, 100, [
      { x: 0, y: 0, w: 200, h: 32 }, // 上排 8 行
      { x: 0, y: 32, w: 108, h: 4 }, // 谷行一（27 格）
      { x: 0, y: 36, w: 104, h: 4 }, // 谷行二（26 格，最深处）
      { x: 0, y: 40, w: 200, h: 36 }, // 下排 9 行
    ]);
    const bands = findInkBands(image, { x0: 0, y0: 0, x1: 200, y1: 100 }, { dominantFontSize: 36 });
    expect(bands).toHaveLength(2);
    // 刀口 = 最深处上一行的上沿：0+(9-1)*4 = 32（谷的两行都归下带）
    expect(bands[0]).toMatchObject({ y0: 0, y1: 32 });
    expect(bands[1]).toMatchObject({ y0: 32, y1: 76 });
  });

  it('单行矮带（56px < 60px 且 <1.6×36）不切：241 的 1/2(x+y) 一行不是两行', () => {
    const image = makeImage(200, 100, [
      { x: 0, y: 0, w: 200, h: 32 },
      { x: 100, y: 32, w: 8, h: 8 }, // 中段的弱谷
      { x: 0, y: 40, w: 200, h: 16 },
    ]);
    const bands = findInkBands(image, { x0: 0, y0: 0, x1: 200, y1: 100 }, { dominantFontSize: 36 });
    expect(bands).toHaveLength(1);
    expect(bands[0]).toMatchObject({ y0: 0, y1: 56 });
  });

  it('谷太靠边缘（切完一侧不足 0.7 倍正文高）不切', () => {
    const image = makeImage(200, 100, [
      { x: 0, y: 0, w: 200, h: 16 },
      { x: 100, y: 16, w: 8, h: 8 }, // 谷在 16px 处：上侧只剩 16px < 25.2
      { x: 0, y: 24, w: 200, h: 56 },
    ]);
    const bands = findInkBands(image, { x0: 0, y0: 0, x1: 200, y1: 100 }, { dominantFontSize: 36 });
    expect(bands).toHaveLength(1);
  });

  it('谷不够深（>0.55×中位数）不切', () => {
    const image = makeImage(200, 100, [
      { x: 0, y: 0, w: 200, h: 36 },
      { x: 0, y: 36, w: 140, h: 8 }, // 谷仍有 35 格墨，中位数 50 → 0.55×50=27.5 < 35
      { x: 0, y: 44, w: 200, h: 32 },
    ]);
    const bands = findInkBands(image, { x0: 0, y0: 0, x1: 200, y1: 100 }, { dominantFontSize: 36 });
    expect(bands).toHaveLength(1);
  });

  it('谷只有单行宽（分数横线的签名）不切：28 例整行识别反而最好', () => {
    // 实测 28 例：中位数 19、谷 9，深是够了 —— 但两侧邻行是 16/19，
    // 缺口只有一行宽。那是分数横线压出来的缝，切开会把分数线拆成两半。
    const image = makeImage(200, 100, [
      { x: 0, y: 0, w: 200, h: 36 }, // 上排 9 行
      { x: 0, y: 36, w: 180, h: 4 }, // 邻行仍高（45 格 > 0.75×50）
      { x: 100, y: 40, w: 32, h: 4 }, // 单行缺口（8 格，>3% 阈值所以不先断开）
      { x: 0, y: 44, w: 200, h: 24 }, // 下排 6 行
    ]);
    const bands = findInkBands(image, { x0: 0, y0: 0, x1: 200, y1: 100 }, { dominantFontSize: 20 });
    expect(bands).toHaveLength(1);
    expect(bands[0]).toMatchObject({ y0: 0, y1: 68 });
  });

  it('空区域 / 全白区域返回空', () => {
    const blank = makeImage(100, 100, []);
    expect(findInkBands(blank, { x0: 0, y0: 0, x1: 100, y1: 100 })).toEqual([]);
    expect(findInkBands(blank, { x0: 50, y0: 0, x1: 50, y1: 100 })).toEqual([]);
  });

  it('区域坐标超出图像边界时夹取，不越界（带只覆盖有墨行）', () => {
    const image = makeImage(100, 100, [{ x: 10, y: 10, w: 80, h: 40 }]);
    const bands = findInkBands(image, { x0: -50, y0: -50, x1: 500, y1: 500 }, { dominantFontSize: 0 });
    expect(bands).toHaveLength(1);
    expect(bands[0]).toMatchObject({ x0: 0, y0: 8, x1: 100, y1: 52 });
  });
});

describe('垃圾词 / 空洞 / 碎片判据', () => {
  const region = { x0: 294, y0: 622, x1: 610, y1: 703 };

  it('isGarbageWord：置信 <50 一律垃圾；50-80 之间要明显大于正文', () => {
    expect(isGarbageWord(word('x(c) {。', region, 54, 139.7), 36)).toBe(true);
    expect(isGarbageWord(word('Z= 当X>Y', region, 74, 124), 36)).toBe(true);
    expect(isGarbageWord(word('其中λ>0', region, 97, 20), 36)).toBe(false);
    expect(isGarbageWord(word('可疑词', region, 60, 20), 36)).toBe(false);
    expect(isGarbageWord(word('低信词', region, 30, 20), 36)).toBe(true);
  });

  it('findGarbageWordsInRegion：只有落在（留白）区域内的垃圾词才算', () => {
    const inside = word('Z= 当X>Y', { x0: 300, y0: 630, x1: 600, y1: 700 }, 60, 124);
    const outside = word('fz(e)= 0', { x0: 300, y0: 900, x1: 600, y1: 960 }, 54, 121);
    const confidentInside = word('x≤0', { x0: 400, y0: 640, x1: 520, y1: 680 }, 96, 36);
    const found = findGarbageWordsInRegion(region, [inside, outside, confidentInside], 36);
    expect(found).toEqual([inside]);
  });

  it('isPunctuationOnly：`）`、`{` 是碎片；带字母/数字/CJK 的不是', () => {
    expect(isPunctuationOnly('）')).toBe(true);
    expect(isPunctuationOnly('{')).toBe(true);
    expect(isPunctuationOnly('0，')).toBe(false);
    expect(isPunctuationOnly('x≤0')).toBe(false);
    expect(isPunctuationOnly('当')).toBe(false);
  });

  it('findFragmentWordsInRegion：区域内的标点词（大括号下半边的 `）`）', () => {
    const frag = word('）', { x0: 433, y0: 1061, x1: 477, y1: 1097 }, 88, 36);
    const region24 = { x0: 284, y0: 984, x1: 964, y1: 1111 };
    expect(findFragmentWordsInRegion(region24, [frag])).toEqual([frag]);
    const farAway = word('）', { x0: 1300, y0: 1061, x1: 1340, y1: 1097 }, 88, 36);
    expect(findFragmentWordsInRegion(region24, [farAway])).toEqual([]);
  });

  it('holeRatio：墨迹格子被词盖住一半 → 0.5；盖满 → 0', () => {
    const image = makeImage(100, 100, [{ x: 0, y: 0, w: 40, h: 20 }]);
    const grid = buildInkGrid(image, { x0: 0, y0: 0, x1: 100, y1: 100 });
    const half = word('t', { x0: 0, y0: 0, x1: 20, y1: 20 });
    const full = word('t', { x0: 0, y0: 0, x1: 40, y1: 20 });
    expect(holeRatio(grid, [half])).toBeGreaterThan(0.3);
    expect(holeRatio(grid, [full])).toBe(0);
    expect(holeRatio(grid, [])).toBe(1);
  });
});

describe('regionGateDecision：区域是否值得恢复', () => {
  const region = { x0: 294, y0: 622, x1: 610, y1: 703 };
  const inked = makeImage(700, 800, [{ x: 294, y: 622, w: 316, h: 80 }]);
  const grid = buildInkGrid(inked, region);

  it('垃圾词覆盖 → garbage（Z 区域：`Z= 当X>Y` 已认错）', () => {
    const bad = word('Z= 当X>Y', { x0: 300, y0: 630, x1: 600, y1: 700 }, 60, 124);
    const d = regionGateDecision(region, [bad], grid, 36);
    expect(d.fire).toBe(true);
    expect(d.reason).toBe('garbage');
    expect(d.garbageWords).toEqual([bad]);
  });

  it('无垃圾词但墨迹大面积没词覆盖 → hole', () => {
    const d = regionGateDecision(region, [], grid, 36);
    expect(d.fire).toBe(true);
    expect(d.reason).toBe('hole');
    expect(d.hole).toBeGreaterThanOrEqual(HOLE_MIN_RATIO);
  });

  it('区域内 ≥2 个标点碎片词 → fragment', () => {
    const frag1 = word('）', { x0: 400, y0: 650, x1: 440, y1: 690 }, 88, 36);
    const frag2 = word('{', { x0: 460, y0: 650, x1: 480, y1: 690 }, 88, 36);
    const covering = word('t', { x0: 294, y0: 622, x1: 610, y1: 703 }, 95, 36);
    const d = regionGateDecision(region, [frag1, frag2, covering], grid, 36);
    expect(d.fire).toBe(true);
    expect(d.reason).toBe('fragment');
    expect(d.fragmentWords).toEqual([frag1, frag2]);
  });

  it('洁净页面保护：单个标点词（公式里的 `=`）且无空洞 → 不触发', () => {
    // 重认会丢掉这些词已有的字符级坐标（上下标渲染靠它），错的替换比不替换更糟
    const eq = word('=', { x0: 400, y0: 650, x1: 440, y1: 690 }, 96, 36);
    const covering = word('t', { x0: 294, y0: 622, x1: 610, y1: 703 }, 95, 36);
    const d = regionGateDecision(region, [eq, covering], grid, 36);
    expect(d.fire).toBe(false);
    expect(d.reason).toBeNull();
  });

  it('好词覆盖、无碎片、无空洞 → 不触发', () => {
    const good = word('Z = {1, 当X≤Y', { x0: 294, y0: 622, x1: 610, y1: 703 }, 96, 36);
    const d = regionGateDecision(region, [good], grid, 36);
    expect(d.fire).toBe(false);
    expect(d.reason).toBeNull();
  });
});

describe('foldForMatch：全角/空白折叠后再判重复', () => {
  it('全角逗号、空格差异不影响包含判定', () => {
    expect(foldForMatch('0，其他')).toBe('0,其他');
    expect(foldedContains('0，其他', '0,其他')).toBe(true);
    expect(foldedContains('fx(x) = { 0, x ≤ 0', 'x≤0')).toBe(true);
    expect(foldedContains('fz(e)= 0', '0,其他')).toBe(false);
  });
});

describe('planRegionReplacement：恢复结果替换既有词', () => {
  const region = { x0: 294, y0: 622, x1: 610, y1: 703 };
  const opts = { dominantFontSize: 36 };

  it('垃圾词删除、外面的好词保留、救回词准入', () => {
    const garbage = word('Z= 当X>Y', { x0: 300, y0: 630, x1: 600, y1: 700 }, 60, 124);
    const outside = word('其中λ>0，μ>0是常数', { x0: 100, y0: 560, x1: 700, y1: 610 }, 97, 20);
    const recovered = [word('Z = {1, 当X≤Y', { x0: 294, y0: 622, x1: 610, y1: 660 }, 96, 36)];
    const plan = planRegionReplacement(region, [garbage, outside], recovered, opts);
    expect(plan.drops).toEqual([{ word: garbage, reason: 'garbage' }]);
    expect(plan.survivors).toEqual([outside]);
    expect(plan.recovered).toEqual(recovered);
  });

  it('旧词内容被救回文本包含且有交叠 → duplicate 删除（`0,其他` 不重复输出）', () => {
    const dup = word('0,其他', { x0: 566, y0: 1066, x1: 639, y1: 1120 }, 88, 36);
    const recovered = [
      word('0，其他', { x0: 566, y0: 1066, x1: 700, y1: 1120 }, 95, 36),
    ];
    const plan = planRegionReplacement({ x0: 284, y0: 984, x1: 964, y1: 1111 }, [dup], recovered, opts);
    expect(plan.drops).toEqual([{ word: dup, reason: 'duplicate' }]);
    expect(plan.recovered).toEqual(recovered);
  });

  it('救回文本不包含旧词（识别退化）时不得删好词（宁可重复不丢内容）', () => {
    const good = word('x>0,y>0', { x0: 750, y0: 1001, x1: 983, y1: 1049 }, 100, 36);
    const recovered = [word('f (x,y) = (x+y)e−', { x0: 284, y0: 984, x1: 964, y1: 1064 }, 54, 60)];
    const plan = planRegionReplacement({ x0: 284, y0: 984, x1: 964, y1: 1111 }, [good], recovered, { ...opts, garbageWords: [] });
    expect(plan.drops).toEqual([]);
    expect(plan.survivors).toEqual([good]);
  });

  it('区域内的标点碎片词删除（`）`）', () => {
    const frag = word('）', { x0: 433, y0: 1061, x1: 477, y1: 1097 }, 88, 36);
    const recovered = [word('0，其他', { x0: 566, y0: 1066, x1: 700, y1: 1120 }, 95, 36)];
    const plan = planRegionReplacement({ x0: 284, y0: 984, x1: 964, y1: 1111 }, [frag], recovered, { ...opts, garbageWords: [] });
    expect(plan.drops).toEqual([{ word: frag, reason: 'fragment' }]);
  });

  it('救回词与幸存词高度交叠且文本无关 → 不重复准入（救回词弃，重复比缺失更糟）', () => {
    const survivor = word('当X≤Y', { x0: 400, y0: 650, x1: 600, y1: 700 }, 96, 36);
    const recovered = [word('Z = {1, 当', { x0: 294, y0: 622, x1: 610, y1: 690 }, 95, 36)];
    const plan = planRegionReplacement({ x0: 284, y0: 622, x1: 610, y1: 703 }, [survivor], recovered, { ...opts, garbageWords: [] });
    expect(plan.survivors).toEqual([survivor]);
    expect(plan.recovered).toEqual([]);
  });

  it('小碎片幸存词被救回词包含 → 碎片按 duplicate 删除、整行救回准入（实测 FXFY）', () => {
    const survivor = word('x >0', { x0: 581, y0: 476, x1: 689, y1: 504 }, 83, 28);
    const recovered = [word('(λe−λx, x > 0', { x0: 520, y0: 472, x1: 780, y1: 506 }, 89, 34)];
    const plan = planRegionReplacement({ x0: 297, y0: 471, x1: 1082, y1: 560 }, [survivor], recovered, { ...opts, garbageWords: [] });
    expect(plan.drops).toEqual([{ word: survivor, reason: 'duplicate' }]);
    expect(plan.recovered).toEqual(recovered);
  });

  it('没有任何救回词 → 原样返回，不删任何东西', () => {
    const garbage = word('fz(e)= 0', { x0: 300, y0: 1520, x1: 600, y1: 1600 }, 54, 121);
    const plan = planRegionReplacement({ x0: 293, y0: 1505, x1: 708, y1: 1620 }, [garbage], [], opts);
    expect(plan.survivors).toEqual([garbage]);
    expect(plan.drops).toEqual([]);
  });
});
