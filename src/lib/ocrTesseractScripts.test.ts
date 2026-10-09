/**
 * 第二意见模块（`ocrTesseractScripts`）：hOCR 解析、证据判断、坐标映射、
 * 接线口的不变量。
 *
 * ═══════════════════════════════════════════════════════════════
 * 夹具 = 用户真实页（`page-0001.png`）三个区域的 tesseract 实测
 * ═══════════════════════════════════════════════════════════════
 *
 * 由 `.spike/dump-cinfo.mjs` 逐字抄录（4 倍 + PSM 7 + eng +
 * `hocr_char_boxes=1`），每个 `ocrx_cinfo` 的 `x_bboxes` 原样保留。
 * 三个区域的角色见 `findRescuableRuns` 的文档：
 *
 *   · 区域 A（第 1 词整行）→ 恰好 4 个证据框，其中两个正压在指数上；
 *   · 区域 B（第 16 词）   → **0 个**（假段 `2+Y` 的证据为空）；
 *   · 区域 C（第 20 词）   → 3 个，全部压在三个 `∼` 上（假段 `=∼∼∼`）。
 *
 * 坐标是**裁剪内（放大 4 倍后）像素** —— 与 `computeEvidenceBoxes` 的输入
 * 同一坐标系；转成词框坐标由 `mapCropBoxToWord` 负责，单独钉住。
 *
 * 这些读数用生产函数重算过：A 的 fullH/baseline = **170/160**、
 * B = **144/146.5**、C = **128/148**（`baseline` 用生产版 `medianOf` ——
 * 偶数个取中间两个的均值，所以 B 是 146.5 而不是脚本里的 147），
 * 与 `ocrCharBoxes.rescue.test.ts` 的 `EVIDENCE_A/B/C`（按页坐标、四舍五入到 0.1）
 * 逐值吻合。
 */
import { describe, expect, it } from 'vitest';
import {
  attachTesseractEvidence,
  clearTesseractEvidence,
  computeEvidenceBoxes,
  getTesseractEvidence,
  mapCropBoxToWord,
  parseHocrCharBoxes,
  resetScriptSecondOpinion,
  type HocrCharBox,
} from '@/lib/ocrTesseractScripts';
import { attachCharsToWord } from '@/lib/ocrCharBoxes';
import type { OcrWord } from '@/lib/ocrTypes';

type CropRow = [number, number, number, number];
const boxes = (rows: CropRow[]): HocrCharBox[] =>
  rows.map(([x0, y0, x1, y1]) => ({ x0, y0, x1, y1 }));

/** 区域 A：(230,208)-(1600,262)，4 倍 → 5480×216，n=54 */
const REGION_A: CropRow[] = [
  [21, 44, 61, 128], [79, 44, 136, 128], [147, 112, 167, 133], [230, 48, 335, 159],
  [342, 47, 414, 160], [356, 47, 471, 160], [485, 47, 1265, 160], [782, 17, 853, 187],
  [909, 47, 967, 160], [966, 47, 1066, 160], [1065, 47, 1137, 160], [1136, 47, 1207, 160],
  [1207, 47, 1265, 160], [1377, 49, 1428, 162], [1445, 47, 1558, 161], [1580, 47, 1698, 161],
  [1715, 47, 1817, 161], [1887, 47, 1963, 162], [2001, 60, 2085, 148], [2117, 53, 2145, 159],
  [2156, 17, 2185, 187], [2173, 59, 2265, 149], [2321, 91, 2417, 121], [2460, 95, 2531, 149],
  [2579, 117, 2601, 154], [2625, 59, 2706, 148], [2749, 91, 2845, 121], [2890, 95, 2956, 170],
  [2992, 55, 3019, 158], [3075, 91, 3170, 121], [3222, 76, 3291, 170], [3312, 47, 3340, 99],
  [3380, 61, 3416, 153], [3444, 62, 3483, 148], [3519, 100, 3616, 108], [3645, 76, 3713, 170],
  [3745, 60, 3812, 152], [3814, 68, 3945, 111], [4020, 47, 4048, 99], [4094, 117, 4118, 154],
  [4144, 64, 4198, 148], [4235, 62, 4350, 152], [4389, 77, 4457, 170], [4503, 62, 4618, 153],
  [4664, 62, 4702, 148], [4741, 117, 4763, 154], [4785, 95, 4856, 149], [4903, 117, 4928, 154],
  [4951, 95, 5017, 170], [5102, 47, 5174, 161], [5145, 17, 5202, 187], [5197, 47, 5305, 160],
  [5301, 47, 5372, 161], [5330, 54, 5443, 155],
];

/** 区域 A 的 4 个证据框（裁剪坐标）——`computeEvidenceBoxes` 的实测产出 */
const REGION_A_EVIDENCE: CropRow[] = [
  [3312, 47, 3340, 99], // "*" —— tesseract 的小方块读数（与指数同型：y 47..99）
  [3519, 100, 3616, 108], // "—" —— `(1−p)` 里的减号
  [3814, 68, 3945, 111], // "&quot;" —— tesseract 把 `x+y` 认成引号（正压指数）
  [4020, 47, 4048, 99], // "2" —— 指数末尾的 `2`
];

/** 区域 B：(170,1446)-(790,1494)，4 倍 → 2480×192，n=21 */
const REGION_B: CropRow[] = [
  [24, 43, 129, 147], [128, 43, 200, 147], [145, 47, 256, 143], [272, 43, 320, 147],
  [273, 43, 377, 146], [391, 44, 498, 145], [517, 43, 862, 146], [548, 32, 632, 176],
  [632, 32, 728, 176], [812, 32, 884, 176], [917, 87, 1004, 114], [1092, 46, 1169, 143],
  [1188, 43, 1319, 136], [1367, 55, 1458, 144], [1489, 43, 1601, 135], [1685, 43, 1781, 146],
  [1803, 43, 1909, 146], [1926, 42, 2032, 149], [2049, 42, 2151, 147], [2169, 43, 2396, 148],
  [2324, 32, 2396, 176],
];

/** 区域 C：(220,1822)-(1510,1874)，4 倍 → 5160×208，n=61 */
const REGION_C: CropRow[] = [
  [23, 58, 79, 140], [70, 54, 114, 157], [88, 59, 173, 144], [256, 41, 286, 158],
  [260, 45, 369, 150], [324, 41, 373, 158], [413, 55, 502, 140], [539, 111, 560, 142],
  [579, 55, 659, 139], [731, 46, 796, 151], [813, 45, 920, 150], [935, 52, 1014, 144],
  [1075, 44, 1168, 151], [1190, 49, 1294, 148], [1252, 40, 1295, 165], [1336, 45, 1418, 151],
  [1388, 40, 1420, 165], [1450, 44, 1549, 151], [1502, 40, 1566, 165], [1564, 46, 1674, 149],
  [1627, 40, 1712, 165], [1688, 44, 1784, 151], [1836, 40, 1857, 165], [1836, 46, 1919, 150],
  [1954, 111, 1977, 144], [2023, 55, 2087, 140], [2134, 87, 2231, 113], [2269, 58, 2320, 139],
  [2344, 54, 2380, 143], [2398, 87, 2451, 140], [2479, 109, 2495, 156], [2544, 111, 2565, 145],
  [2590, 75, 2655, 165], [2681, 54, 2714, 143], [2752, 111, 2774, 145], [2794, 55, 2858, 139],
  [2936, 87, 3006, 113], [3045, 58, 3093, 139], [3120, 54, 3154, 143], [3172, 88, 3225, 140],
  [3247, 111, 3272, 156], [3317, 111, 3340, 145], [3360, 76, 3427, 165], [3454, 54, 3488, 143],
  [3558, 48, 3683, 147], [3633, 41, 3729, 169], [3704, 45, 3793, 150], [3857, 55, 3916, 140],
  [3964, 86, 4051, 117], [4097, 55, 4185, 140], [4219, 56, 4311, 146], [4330, 55, 4399, 139],
  [4453, 87, 4541, 113], [4579, 58, 4630, 139], [4659, 53, 4692, 143], [4710, 87, 4761, 140],
  [4790, 110, 4805, 156], [4851, 57, 4944, 145], [4971, 88, 5021, 140], [5047, 111, 5070, 156],
  [5117, 111, 5140, 145],
];

// ═══════════════════════════════════════════════════════════════
// 1. hOCR 解析：只认 ocrx_cinfo 的 x_bboxes
// ═══════════════════════════════════════════════════════════════

describe('parseHocrCharBoxes', () => {
  it('真实片段（第 1 词开头的两个汉字）逐个解出', () => {
    const hocr =
      `<span class='ocrx_cinfo' title='x_bboxes 663 47 695 78; x_conf 99.521721'>概</span>` +
      `<span class='ocrx_cinfo' title='x_bboxes 696 47 726 77; x_conf 99.003265'>率</span>`;
    expect(parseHocrCharBoxes(hocr)).toEqual([
      { x0: 663, y0: 47, x1: 695, y1: 78 },
      { x0: 696, y0: 47, x1: 726, y1: 77 },
    ]);
  });

  it('词框（`ocrx_word` 的 `bbox`）**不**算字符框 —— 拿它当证据等于把整个词当成一个字', () => {
    const hocr = `<span class='ocrx_word' id='word_1_1' title='bbox 663 47 726 78; x_wconf 93'>概率</span>`;
    expect(parseHocrCharBoxes(hocr)).toEqual([]);
  });

  it('缺 `x_bboxes` / 退化的框（x1≤x0 或 y1≤y0）直接丢掉；空串不抛', () => {
    const hocr = [
      `<span class='ocrx_cinfo' title='x_conf 99.0'>概</span>`,
      `<span class='ocrx_cinfo' title='x_bboxes 700 47 700 78'>率</span>`,
      `<span class='ocrx_cinfo' title='x_bboxes 800 47 790 78'>论</span>`,
      `<span class='ocrx_cinfo' title='x_bboxes 810 47 850 40'>与</span>`,
    ].join('');
    expect(parseHocrCharBoxes(hocr)).toEqual([]);
    expect(parseHocrCharBoxes('')).toEqual([]);
  });

  it('文本内容是 HTML 实体（`&quot;`）也不影响 —— 这里从来不读文本', () => {
    const hocr = `<span class='ocrx_cinfo' title='x_bboxes 3814 68 3945 111; x_conf 81.43'>&quot;</span>`;
    expect(parseHocrCharBoxes(hocr)).toEqual([{ x0: 3814, y0: 68, x1: 3945, y1: 111 }]);
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. 证据判断：三个区域的真实读数（4 / 0 / 3）
// ═══════════════════════════════════════════════════════════════

describe('computeEvidenceBoxes 在三个真实区域上的产出', () => {
  it('区域 A（第 1 词整行）：54 个字符框 → 恰好 4 个证据框', () => {
    const list = boxes(REGION_A);
    expect(list).toHaveLength(54);
    expect(Math.max(...list.map((b) => b.y1 - b.y0))).toBe(170); // fullH

    const ev = computeEvidenceBoxes(list);
    expect(ev.map((b) => [b.x0, b.y0, b.x1, b.y1])).toEqual(REGION_A_EVIDENCE);

    /**
     * 数值探针（`baseline` = 160、`limit` = 117.5）：
     *   · `"` 框底边 111 ≤ 117.5 —— 余量 6.5 裁剪像素（≈1.6 页像素），
     *     它是「x+y 被读成引号」的那一条，也是三条里最紧的一条；
     *     把抬升比例从 0.25 放到 0.3（limit 109）它就会掉出去，
     *     覆盖数从 3 掉到 1 → 第 1 词的救回失败（见 rescue 测试）。
     *   · 三个 `=` 框（底边 121 的 `h=30`）离 limit 只差 3.5 裁剪像素，
     *     但即便被收进来也**不影响覆盖**（它们不在指数上）。
     */
    expect(160 - 0.25 * 170).toBeCloseTo(117.5, 6);
    expect(111).toBeLessThan(117.5);
    expect(111).toBeGreaterThan(160 - 0.3 * 170);
    expect(121).toBeGreaterThan(117.5);
  });

  it('区域 B（第 16 词）：0 个 —— 「问过了、答的是没有」的那组读数', () => {
    const list = boxes(REGION_B);
    expect(list).toHaveLength(21);
    expect(Math.max(...list.map((b) => b.y1 - b.y0))).toBe(144); // fullH

    expect(computeEvidenceBoxes(list)).toEqual([]);

    /**
     * 数值探针：全区域只有 `=` 一个框算「小」（h=27 ≤ 0.6×144 = 86.4），
     * 而它被挡在**抬升**那一步上：底边 114 vs limit = 146.5 − 0.25×144 = 110.5
     * —— 差 3.5 裁剪像素（0.875 页像素）。就是它让 (c) 在第 16 词上为 0，
     * 从而挡住 `2+Y` 那段假候选。
     */
    expect(144 * 0.6).toBeCloseTo(86.4, 6);
    expect(27).toBeLessThanOrEqual(86.4);
    expect(146.5 - 0.25 * 144).toBeCloseTo(110.5, 6);
    expect(114).toBeGreaterThan(110.5);
  });

  it('区域 C（第 20 词）：3 个，全部压在三个 `∼` 上', () => {
    const list = boxes(REGION_C);
    expect(list).toHaveLength(61);
    expect(Math.max(...list.map((b) => b.y1 - b.y0))).toBe(128); // fullH

    const ev = computeEvidenceBoxes(list);
    expect(ev.map((b) => [b.x0, b.y0, b.x1, b.y1])).toEqual([
      [2134, 87, 2231, 113],
      [2936, 87, 3006, 113],
      [4453, 87, 4541, 113],
    ]);

    // 探针：limit = 148 − 0.25×128 = 116；三个 `~` 的底边都是 113（余量 3 裁剪像素）
    expect(148 - 0.25 * 128).toBeCloseTo(116, 6);
    expect(113).toBeLessThan(116);
  });

  it('少于 2 个框直接返回空 —— 一个框连「比较」都不成立', () => {
    expect(computeEvidenceBoxes([])).toEqual([]);
    expect(computeEvidenceBoxes(boxes([[0, 0, 10, 10]]))).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. 坐标映射：裁剪内（放大后）→ 词框坐标
// ═══════════════════════════════════════════════════════════════

describe('mapCropBoxToWord', () => {
  it('区域 A 的读数：origin (230,208)、4 倍、scale 1 → 页坐标', () => {
    /**
     * 与 `ocrCharBoxes.rescue.test.ts` 的 `EVIDENCE_A` 是同一批框 ——
     * 那边是这里算出来、四舍五入到 0.1 的抄录（219.8 = 219.75、232.8 = 232.75）。
     * 这条测试是那条契约的**唯一**直接看守：少乘/多除任何一步，
     * 覆盖计数会静默归零（词不救回、不报错）。
     */
    expect(boxes(REGION_A_EVIDENCE).map((b) => mapCropBoxToWord(b, 230, 208, 4, 1))).toEqual([
      { x0: 1058, y0: 219.75, x1: 1065, y1: 232.75 },
      { x0: 1109.75, y0: 233, x1: 1134, y1: 235 },
      { x0: 1183.5, y0: 225, x1: 1216.25, y1: 235.75 },
      { x0: 1235, y0: 219.75, x1: 1242, y1: 232.75 },
    ]);
  });

  it('scale ≠ 1：先除以放大倍数、再加原点、最后除以 scale', () => {
    // 词框是在 0.5 倍画布上量的：字符框回到同一坐标系要再乘 2
    expect(mapCropBoxToWord({ x0: 0, y0: 0, x1: 4, y1: 4 }, 10, 20, 4, 0.5)).toEqual({
      x0: 20,
      y0: 40,
      x1: 22,
      y1: 42,
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. 接线口的不变量（fail-closed）
// ═══════════════════════════════════════════════════════════════

describe('attachTesseractEvidence 的预筛与登记处', () => {
  const fakeCanvas = { width: 100, height: 100, getContext: () => null };
  const word = (text: string): OcrWord =>
    ({ text, confidence: 99, bbox: { x0: 0, y0: 0, x1: 200, y1: 40 }, fontSize: 40 }) as OcrWord;

  it('空输入 / 没有字符框 / 没有可救段 → 0，且一个回调都不发生（全部在预筛处返回）', async () => {
    const calls: string[] = [];
    const options = {
      canvas: fakeCanvas,
      onInfo: (m: string) => calls.push(`info:${m}`),
      onSkip: (_w: OcrWord, r: string) => calls.push(`skip:${r}`),
    };

    await expect(attachTesseractEvidence([], options)).resolves.toBe(0);
    await expect(attachTesseractEvidence([word('x')], options)).resolves.toBe(0);

    const withChars = word('abc');
    attachCharsToWord(withChars, {
      chars: [
        { char: 'a', x0: 0, y0: 0, x1: 10, y1: 20 },
        { char: 'b', x0: 11, y0: 0, x1: 21, y1: 20 },
        { char: 'c', x0: 22, y0: 0, x1: 32, y1: 20 },
      ],
      measurements: [
        { y0: 0, y1: 0.5, h: 0.5 },
        { y0: 0, y1: 0.5, h: 0.5 },
        { y0: 0, y1: 0.5, h: 0.5 },
      ],
    });

    // 空表：`findRescuableRuns` 按「没有表」处理
    await expect(
      attachTesseractEvidence([withChars], { ...options, sizeTable: new Map() }),
    ).resolves.toBe(0);
    // 有表但这个词没有任何候选段（三个字符几何完全相同 → 全 normal）
    await expect(
      attachTesseractEvidence([withChars], { ...options, sizeTable: new Map([['a', 10]]) }),
    ).resolves.toBe(0);

    /**
     * ⭐ 以上四条路径都必须在**预筛处**返回，一个回调都不该发生。
     * 若哪天预筛被删掉，这些词会走到 `ensureTessWorker()` —— 测试环境里
     * 自托管资产不存在，worker 建不起来，`onInfo('第二意见不可用…')`
     * 就会被记录，这条断言立刻失败（而不是等到线上才发现每个词都白跑一次）。
     */
    expect(calls).toEqual([]);
  });

  it('clear / reset 在没有 worker 时也可安全调用，且不残留证据', () => {
    const w = word('x');
    expect(getTesseractEvidence(w)).toBeUndefined();
    clearTesseractEvidence();
    expect(getTesseractEvidence(w)).toBeUndefined();
    resetScriptSecondOpinion();
    resetScriptSecondOpinion(); // 幂等：连调两次不出错
    expect(getTesseractEvidence(w)).toBeUndefined();
  });
});
