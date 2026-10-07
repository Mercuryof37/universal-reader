/**
 * 字符级坐标（`lib/ocrCharBoxes.ts`）的测试。
 *
 * ═══════════════════════════════════════════════════════════════
 * 这组测试要挡住什么
 * ═══════════════════════════════════════════════════════════════
 *
 * 1. **与库的前处理参数不对齐** → CTC 解码全错。所以逐项断言
 *    高度 48、宽度公式、`R/127.5−1` 三通道同值（依据见
 *    `ocrCharBoxes.ts` 文件顶部那张表，每个数字都指向库里的具体文件）。
 * 2. **CTC 解码写错** → 文本与位置全错。用一个「自己就知道答案」的
 *    假 logits 把合并重复、去 blank、空格类、位置单调这几条钉死。
 * 3. **纵向墨迹分析写错** → 上下标判据退化回猜。用合成像素图
 *    （大字 + 抬高的小字）验证「量出来的高度确实不同、底边确实更高」。
 * 4. **上下标阈值被放宽** → 正常字符被误包进 `^{}`。用**真实词框几何**的
 *    三个场景钉住：真上标要认出来、同基线的小字**不能**认成上标、
 *    位移太大的不能认。
 * 5. **渐进增强破功** → 拿不到字符框时输出必须与改动前逐字符一致。
 *
 * ⚠️ 这里**不跑** ONNX 推理：那要 21MB 模型 + 28MB WASM，单测里代价太大。
 * 真实模型的端到端验收见 `ocrCharBoxes.real.test.ts`（由环境变量开关），
 * 以及 `charbox-tools/verify-real-model.mjs`（用真实模型解码已知字符串）。
 */
import { describe, expect, it } from 'vitest';
import {
  CHAR_INK_LUMA_THRESHOLD,
  CTC_BLANK_INDEX,
  DEFAULT_SEQ_DOWNSAMPLE,
  REC_IMAGE_HEIGHT,
  REC_MIN_CROP_WIDTH,
  SCRIPT_CHAR_MAX_HEIGHT_RATIO,
  SCRIPT_CHAR_MAX_SHIFT_RATIO,
  SCRIPT_CHAR_MIN_SHIFT_RATIO,
  alignDictToClasses,
  attachCharBoxes,
  attachCharsToWord,
  buildWordCharBoxes,
  canvasToRecTensor,
  classifyCharsByGeometry,
  decodeCtcWithSteps,
  getAttachedChars,
  groupScriptFragments,
  measureCharPixelSpans,
  preprocessRecCrop,
  reconcileWithWordText,
  sequenceLengthForWidth,
  type OcrCanvasLike,
} from '@/lib/ocrCharBoxes';
import type { OcrChar, OcrWord } from '@/lib/ocrTypes';

// ───────────────────────────────────────────────────────────────
// 最小画布替身（与浏览器 canvas 的语义一致：黑字白底、RGBA）
// ───────────────────────────────────────────────────────────────

function createCanvas(width: number, height: number): OcrCanvasLike & { __data: Uint8ClampedArray } {
  const data = new Uint8ClampedArray(width * height * 4);
  data.fill(255);
  const ctx = {
    fillStyle: '#fff',
    fillRect(x: number, y: number, w: number, h: number) {
      for (let j = y; j < y + h; j++) {
        for (let i = x; i < x + w; i++) {
          if (i < 0 || j < 0 || i >= width || j >= height) continue;
          const p = (j * width + i) * 4;
          data[p] = data[p + 1] = data[p + 2] = 0;
          data[p + 3] = 255;
        }
      }
    },
    drawImage(
      src: OcrCanvasLike,
      sx: number,
      sy: number,
      sw: number,
      sh: number,
      dx: number,
      dy: number,
      dw: number,
      dh: number,
    ) {
      const sd = (src as OcrCanvasLike & { __data: Uint8ClampedArray }).__data;
      const sW = src.width;
      for (let j = 0; j < dh; j++) {
        // 最近邻：验证的是坐标映射与归一化，不是插值质量
        const syy = Math.min(sh - 1, Math.floor((j * sh) / dh));
        for (let i = 0; i < dw; i++) {
          const sxx = Math.min(sw - 1, Math.floor((i * sw) / dw));
          const sp = ((sy + syy) * sW + (sx + sxx)) * 4;
          const dp = ((dy + j) * width + (dx + i)) * 4;
          data[dp] = sd[sp] ?? 255;
          data[dp + 1] = sd[sp + 1] ?? 255;
          data[dp + 2] = sd[sp + 2] ?? 255;
          data[dp + 3] = 255;
        }
      }
    },
    getImageData(x: number, y: number, w: number, h: number) {
      const out = new Uint8ClampedArray(w * h * 4);
      for (let j = 0; j < h; j++) {
        for (let i = 0; i < w; i++) {
          const sp = ((y + j) * width + (x + i)) * 4;
          const dp = (j * w + i) * 4;
          out[dp] = data[sp] ?? 255;
          out[dp + 1] = data[sp + 1] ?? 255;
          out[dp + 2] = data[sp + 2] ?? 255;
          out[dp + 3] = 255;
        }
      }
      return { data: out, width: w, height: h };
    },
  };
  return { width, height, __data: data, getContext: () => ctx };
}

/** 在一张画布上画一个实心墨块（模拟一个字符的笔画范围） */
function ink(
  canvas: ReturnType<typeof createCanvas>,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): void {
  // 替身的 getContext 永远返回同一个上下文，这里断言非空即可
  canvas.getContext('2d')!.fillRect(x0, y0, x1 - x0, y1 - y0);
}

// ───────────────────────────────────────────────────────────────
// 假 logits 构造
// ───────────────────────────────────────────────────────────────

/** 造字典：`['', 'a', 'b', ..., ' ']`（首项 blank，末项空格类，与库同口径） */
function makeDict(glyphs: string[]): string[] {
  return ['', ...glyphs, ' '];
}

/**
 * 按「时间步 → 类别」造 logits。
 *
 * @param steps 每个时间步的类别下标；null 表示这一步是 blank
 * @param frames 时间步总数（多出来的补 blank）
 */
function makeLogits(
  steps: Array<number | null>,
  numClasses: number,
  frames: number,
): { data: Float32Array; dims: number[] } {
  const total = frames * numClasses;
  const data = new Float32Array(total);
  for (let t = 0; t < frames; t++) {
    const cls = t < steps.length ? steps[t] : null;
    const argmax = cls === null || cls === undefined ? CTC_BLANK_INDEX : cls;
    for (let c = 0; c < numClasses; c++) {
      data[t * numClasses + c] = c === argmax ? 0.9 : 0.1 / Math.max(1, numClasses - 1);
    }
  }
  return { data, dims: [1, frames, numClasses] };
}

// 真实数字：识别字典 `ppocrv6_dict.txt` 用 `split('\n')` 得到 **18710** 项
// （18709 行 + 末尾换行留下的空项），而模型输出最后一维也是 **18710**
// —— 由 `charbox-tools/verify-real-model.mjs` 从会话元数据实测得到：
//   outputMetadata = [["DynamicDimension.0","Reshape_471_o0__d2",18710]]
const REAL_DICT_LEN = 18710;

// ───────────────────────────────────────────────────────────────
// 第 17 题的真实几何（用户导出，可直接采信）
// ───────────────────────────────────────────────────────────────

const REAL_LINE_BBOX = { x0: 225, y0: 212, x1: 1604, y1: 255 };
/** 内部真正生效的词高众数（不是被公式撑大的 43） */
const REAL_MAIN_FONT = 36;

/**
 * 用**真实的页级几何**造一个词的字符框。
 *
 * 每个字符的纵向范围按真实排版比例给：
 *  · 正文字符：高度 = 36px 的 0.72（实测点阵/汉字墨迹约占字号的 0.7）；
 *  · 上标字符：高度 = 0.48（= 0.67 倍正文），底边比基线高 0.14。
 * 横向按字符顺序均匀铺开，宽度取 `bbox` 宽度除以字符数。
 */
function buildRealLineChars(text: string, superscriptFrom: number, superscriptTo: number): {
  chars: OcrChar[];
  measurements: Array<{ y0: number; y1: number; h: number } | null>;
} {
  const chars = [...text];
  const charW = (REAL_LINE_BBOX.x1 - REAL_LINE_BBOX.x0) / chars.length;
  const baselineY1 = 0.72;
  const out: OcrChar[] = [];
  const meas: Array<{ y0: number; y1: number; h: number } | null> = [];

  for (let i = 0; i < chars.length; i++) {
    const x0 = REAL_LINE_BBOX.x0 + i * charW;
    const isScript = i >= superscriptFrom && i <= superscriptTo;
    const h = isScript ? 0.48 : 0.72;
    const y1 = isScript ? baselineY1 - 0.14 : baselineY1;
    const y0 = y1 - h;
    const px = 40; // 该词所在的裁剪高度（像素），只用于像素框
    out.push({
      char: chars[i] ?? '',
      x0,
      y0: REAL_LINE_BBOX.y0 + y0 * px,
      x1: x0 + charW,
      y1: REAL_LINE_BBOX.y0 + y1 * px,
    });
    meas.push({ y0, y1, h });
  }
  return { chars: out, measurements: meas };
}

function makeWord(text: string, over: Partial<OcrWord> = {}): OcrWord {
  return {
    text,
    confidence: 90,
    bbox: { ...REAL_LINE_BBOX },
    fontSize: REAL_MAIN_FONT,
    ...over,
  };
}

// ═══════════════════════════════════════════════════════════════
// 1. 前处理：必须与库逐项一致
// ═══════════════════════════════════════════════════════════════

describe('识别前处理：与 ppu-paddle-ocr 逐项对齐', () => {
  it('输入高度就是库的 imageHeight=48（constants.js 的 DEFAULT_RECOGNITION_OPTIONS）', () => {
    // 这个数字错了，positions 的纵向换算就全错；库改了这个值得有人知道
    expect(REC_IMAGE_HEIGHT).toBe(48);
    expect(REC_MIN_CROP_WIDTH).toBe(8);
    expect(CTC_BLANK_INDEX).toBe(0);
    expect(DEFAULT_SEQ_DOWNSAMPLE).toBe(8);
  });

  it('宽度公式与库一致：max(8, round(48 × 原宽/原高))', () => {
    const cases = [
      { w: 400, h: 100, expect: 192 },
      { w: 60, h: 36, expect: 80 },
      { w: 156, h: 36, expect: 208 },
      { w: 2400, h: 36, expect: 3200 },
      // 极窄的裁剪必须被 MIN_CROP_WIDTH 兜住，否则张量宽可能是 0
      { w: 3, h: 100, expect: REC_MIN_CROP_WIDTH },
      { w: 1, h: 200, expect: REC_MIN_CROP_WIDTH },
    ];
    for (const c of cases) {
      const pre = preprocessRecCrop(createCanvas(c.w, c.h), DEFAULT_SEQ_DOWNSAMPLE, createCanvas);
      expect(pre, `${c.w}×${c.h}`).not.toBeNull();
      expect(pre?.tensorHeight).toBe(48);
      expect(pre?.tensorWidth, `${c.w}×${c.h}`).toBe(c.expect);
      // 换算系数必须自洽：tensorX × widthScale 回到原图横向尺度
      expect(pre!.widthScale).toBeCloseTo(c.w / c.expect, 6);
      expect(pre!.heightScale).toBeCloseTo(c.h / 48, 6);
    }
  });

  it('尺寸为 0 的裁剪返回 null（不让 0 除进后续计算）', () => {
    expect(preprocessRecCrop(createCanvas(0, 10), DEFAULT_SEQ_DOWNSAMPLE, createCanvas)).toBeNull();
    expect(preprocessRecCrop(createCanvas(10, 0), DEFAULT_SEQ_DOWNSAMPLE, createCanvas)).toBeNull();
  });

  it('张量归一化是 R/127.5−1 且三通道同值（createImageTensorFromCanvas 的做法）', () => {
    const canvas = createCanvas(4, 2);
    // 画一个纯黑块 + 一个纯白区
    ink(canvas, 0, 0, 2, 2);
    const tensor = canvasToRecTensor(canvas);
    expect(tensor).not.toBeNull();
    const channelSize = 2 * 4;
    expect(tensor!.length).toBe(3 * channelSize);

    // 黑 → −1；白 → +1。注意取的是 **R 通道**，与库一致。
    expect(tensor![0]).toBeCloseTo(-1, 5);
    expect(tensor![2]).toBeCloseTo(1, 5);
    // 三通道同值
    expect(tensor![channelSize + 0]).toBeCloseTo(tensor![0]!, 6);
    expect(tensor![channelSize * 2 + 0]).toBeCloseTo(tensor![0]!, 6);
    // 中灰 128 → 128/127.5−1 ≈ 0.00392
    const gray = createCanvas(1, 1);
    gray.__data[0] = 128;
    gray.__data[1] = 128;
    gray.__data[2] = 128;
    const g = canvasToRecTensor(gray);
    expect(g![0]).toBeCloseTo(128 / 127.5 - 1, 6);
  });

  it('张量宽度→时间步数与库的 validSeq 同口径（向上取整）', () => {
    expect(sequenceLengthForWidth(208, 8)).toBe(26);
    expect(sequenceLengthForWidth(1, 8)).toBe(1);
    expect(sequenceLengthForWidth(80, 8)).toBe(10);
    // 下采样倍率非法时退回默认值，而不是除零
    expect(sequenceLengthForWidth(80, 0)).toBe(10);
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. CTC 贪心解码
// ═══════════════════════════════════════════════════════════════

describe('CTC 贪心解码：合并重复、去 blank、保住时间步', () => {
  const dict = makeDict(['a', 'b', 'c', 'x', 'y']); // '' + 5 + ' ' = 7 类
  const n = dict.length;

  it('字典对齐：18710 项对 18710 类时原样返回', () => {
    const big = Array.from({ length: REAL_DICT_LEN }, (_, i) => (i === 0 ? '' : `g${i}`));
    expect(alignDictToClasses(big, REAL_DICT_LEN)).toBe(big);
  });

  it('字典对齐：末项空行被丢掉后再比', () => {
    const withTrailing = ['', 'a', 'b', ''];
    expect(alignDictToClasses(withTrailing, 3)).toEqual(['', 'a', 'b']);
  });

  it('字典对齐：缺一位时补齐空项（错一格会让全部输出错位）', () => {
    // 库的规则：开头若不是空项就补一个空项（blank）
    expect(alignDictToClasses(['a', 'b'], 3)).toEqual(['', 'a', 'b']);
    // 空项在开头、但总长度差 1 → 末尾补一个（空格类）
    expect(alignDictToClasses(['', 'a', 'b'], 4)).toEqual(['', 'a', 'b', '']);
  });

  it('合并在连续多个时间步上重复触发的同一个字符', () => {
    // 类别：0=blank 1='a' 2='b' 3='c' 4='x' 5='y' 6='空格类'
    // 帧：  blank a a a b b blank
    const { data } = makeLogits([null, 1, 1, 1, 2, 2, null], n, 7);
    const d = decodeCtcWithSteps(data, 7, n, dict);
    expect(d.text).toBe('ab');
    expect(d.steps).toHaveLength(2);
    // 重复步取**平均值**，但必须按「逐步收敛」而不是整段算术平均：
    // 第 1 步被 2 拉成 1.5，第 2 步取 (1.5+3)/2 = 2.25，第 3 步因类别变化不参与。
    // 用「首次触发步」（库的做法）会得到 1；取值落在字形中心附近才是我们要的。
    expect(d.steps[0]).toBeCloseTo(2.25, 6);
    // 'b' 只在第 4、5 步触发：第 5 步取 (4+5)/2 = 4.5
    expect(d.steps[1]).toBeCloseTo(4.5, 6);
    // 无论怎么平均，先后顺序必须保持
    expect(d.steps[0]!).toBeLessThan(d.steps[1]!);
  });

  it('「a blank a」必须解出两个 a（CTC 的 blank 就是用来分隔重复字符的）', () => {
    const { data } = makeLogits([1, null, 1], n, 3);
    expect(decodeCtcWithSteps(data, 3, n, dict).text).toBe('aa');
  });

  it('「a a」只解出一个 a（相邻同类被合并）', () => {
    const { data } = makeLogits([1, 1], n, 2);
    expect(decodeCtcWithSteps(data, 2, n, dict).text).toBe('a');
  });

  it('首尾都是 blank 时不产生前导/尾随字符', () => {
    const { data } = makeLogits([null, null, 3, null, null], n, 5);
    const d = decodeCtcWithSteps(data, 5, n, dict);
    expect(d.text).toBe('c');
    expect(d.steps).toEqual([2]);
  });

  it('全 blank 时文本为空、置信度为 0（而不是 NaN）', () => {
    const { data } = makeLogits([], n, 4);
    const d = decodeCtcWithSteps(data, 4, n, dict);
    expect(d.text).toBe('');
    expect(d.steps).toEqual([]);
    expect(d.confidence).toBe(0);
  });

  it('字典最后一项解成空格（库用 lastDictIndex 当空格类）', () => {
    const { data } = makeLogits([1, null, n - 1, null, 2], n, 5);
    const d = decodeCtcWithSteps(data, 5, n, dict);
    expect(d.text).toBe('a b');
    expect(d.steps).toEqual([0, 2, 4]);
  });

  it('每个字符的时间步**严格递增**（位置单调是「切片不重叠」的前提）', () => {
    // 模拟一句真实输出：字符交替 + 中间若干 blank
    const seq: Array<number | null> = [null, 1, null, 2, 2, null, 3, null, 4, 5, null, null];
    const { data } = makeLogits(seq, n, seq.length);
    const d = decodeCtcWithSteps(data, seq.length, n, dict);
    expect(d.text).toBe('abcxy');
    for (let i = 1; i < d.steps.length; i++) {
      expect(d.steps[i]!).toBeGreaterThan(d.steps[i - 1]!);
    }
    expect(d.steps.every((s) => s >= 0 && s < seq.length)).toBe(true);
  });

  it('平均置信度落在 (0,1]，且等于各字符 argmax 概率的均值', () => {
    const { data } = makeLogits([1, null, 2], n, 3);
    const d = decodeCtcWithSteps(data, 3, n, dict);
    expect(d.confidence).toBeCloseTo(0.9, 6);
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. 逐列墨迹分析：纵向范围只能靠它
// ═══════════════════════════════════════════════════════════════

describe('逐列墨迹分析：量出每个字符真实的纵向范围', () => {
  /**
   * 造一张「已缩放到识别输入尺寸」的画布：宽 64、高 48。
   * 左右各一个大字（同一基线）、右侧上方再画一个抬高的小字不好做，
   * 所以拆成两个断言组：范围测量 + 归一化。
   */
  const buildStrip = (): ReturnType<typeof createCanvas> => {
    const c = createCanvas(64, 48);
    // 字 1：x[4,20) 纵向 y[8,40)
    ink(c, 4, 8, 20, 40);
    // 字 2：x[24,40) 同一基线，但**更矮**（y[18,40)）
    ink(c, 24, 18, 40, 40);
    // 字 3：x[44,60) 更矮且**抬高**（y[4,26)）
    ink(c, 44, 4, 60, 26);
    return c;
  };

  const crop = {
    canvas: buildStrip(),
    tensorWidth: 64,
    tensorHeight: 48,
    widthScale: 2,
    heightScale: 1.5,
    originalWidth: 128,
    originalHeight: 72,
    downsample: 8,
  };

  it('把时间步映射成横向切片，并量出各自的纵向范围', () => {
    // 三个字符，时间步放在各自的中心：字 1 中心 x=12、字 2 x=32、字 3 x=52
    // 张量宽 64 / 时间步 8 → 每步 8px → 步中心 (t+0.5)*8
    // t=1 → 12；t=3 → 28（比 32 略偏左，仍在字 2 的墨迹列带内）；t=6 → 52
    const steps = [1, 3, 6];
    const measured = measureCharPixelSpans(crop.canvas, steps, 8, crop);
    expect(measured).toHaveLength(3);
    expect(measured.every((m) => m.span.hasInk)).toBe(true);

    // 字 1：y[8,40) → 高度 32 张量像素 × heightScale 1.5 = 48 原图像素
    expect(measured[0]!.span.y0).toBeCloseTo(8 * 1.5, 6);
    expect(measured[0]!.span.y1).toBeCloseTo(40 * 1.5, 6);
    // 字 2 更矮：y[18,40)
    expect(measured[1]!.span.y0).toBeCloseTo(18 * 1.5, 6);
    expect(measured[1]!.span.y1).toBeCloseTo(40 * 1.5, 6);
    // 字 3 更矮且更高
    expect(measured[2]!.span.y0).toBeCloseTo(4 * 1.5, 6);
    expect(measured[2]!.span.y1).toBeCloseTo(26 * 1.5, 6);

    // 归一化墨迹：横向用**有墨迹的列**、纵向用真实范围
    const ink1 = measured[0]!.ink!;
    expect(ink1.h).toBeCloseTo(48 / 72, 4); // 48 原图像素 / 72 原图高
    expect(ink1.y0).toBeCloseTo(12 / 72, 4);
    expect(ink1.y1).toBeCloseTo(60 / 72, 4);
    // 字 3 的高度明显更小
    expect(measured[2]!.ink!.h).toBeLessThan(measured[0]!.ink!.h);
  });

  it('横向切片按相邻字符中心的中点划分，且首尾不外扩到负宽度', () => {
    const measured = measureCharPixelSpans(crop.canvas, [1, 3, 6], 8, crop);
    expect(measured[0]!.span.x0).toBeGreaterThanOrEqual(0);
    for (let i = 0; i < measured.length; i++) {
      expect(measured[i]!.span.x1).toBeGreaterThan(measured[i]!.span.x0);
      if (i > 0) expect(measured[i]!.span.x0).toBeGreaterThanOrEqual(measured[i - 1]!.span.x1 - 1);
    }
  });

  it('空白列带不出墨迹：hasInk=false、不给归一化框（避免拿整块高度去比）', () => {
    const blank = createCanvas(64, 48);
    const m = measureCharPixelSpans(blank, [0, 4], 8, crop);
    expect(m[0]!.span.hasInk).toBe(false);
    expect(m[0]!.ink).toBeUndefined();
    expect(m[1]!.ink).toBeUndefined();
  });

  it('单列噪点不算墨迹（MIN_INK_PER_COLUMN / MIN_INKED_COLUMNS 两道闸）', () => {
    const noisy = createCanvas(64, 48);
    ink(noisy, 12, 20, 13, 21); // 只有 1 列、1 个像素
    const m = measureCharPixelSpans(noisy, [1], 8, crop);
    expect(m[0]!.span.hasInk).toBe(false);
  });

  it('亮度阈值之下的浅灰不算墨迹、之上才算（阈值 160 的两侧）', () => {
    expect(CHAR_INK_LUMA_THRESHOLD).toBe(160);
    const light = createCanvas(64, 48);
    // 159 → 算墨迹
    light.__data.fill(255);
    for (let y = 10; y < 30; y++) {
      for (let x = 8; x < 24; x++) {
        const p = (y * 64 + x) * 4;
        light.__data[p] = light.__data[p + 1] = light.__data[p + 2] = 159;
      }
    }
    expect(measureCharPixelSpans(light, [1], 8, crop)[0]!.span.hasInk).toBe(true);

    // 161 → 不算
    const pale = createCanvas(64, 48);
    for (let y = 10; y < 30; y++) {
      for (let x = 8; x < 24; x++) {
        const p = (y * 64 + x) * 4;
        pale.__data[p] = pale.__data[p + 1] = pale.__data[p + 2] = 161;
      }
    }
    expect(measureCharPixelSpans(pale, [1], 8, crop)[0]!.span.hasInk).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. 上下标判定：真实几何 + 两条「误判防线」
// ═══════════════════════════════════════════════════════════════

describe('上下标判定：只用「更小 + 更高/更低」这两个可测事实', () => {
  it('常量保持保守方向（放宽它们会让正常字符被误包成上下标）', () => {
    expect(SCRIPT_CHAR_MAX_HEIGHT_RATIO).toBe(0.8);
    expect(SCRIPT_CHAR_MIN_SHIFT_RATIO).toBe(0.15);
    expect(SCRIPT_CHAR_MAX_SHIFT_RATIO).toBe(0.5);
  });

  /**
   * 真实第 17 题的形态：主线字高 0.72（36px / 50px 词框），
   * 指数 `x+y-2` 高 0.48（0.67 倍正文）、底边抬高 0.14。
   */
  const lineWithExponent = () => {
    const text = 'p(1-p)' + 'x+y-2';
    const from = 6;
    const to = 10;
    const { chars, measurements } = buildRealLineChars(text, from, to);
    return { text, from, to, chars, measurements };
  };

  it('真实场景：`p(1-p)x+y-2` 里指数的 5 个字符全部判为上标', () => {
    const { from, to, chars, measurements } = lineWithExponent();
    const scripts = classifyCharsByGeometry(measurements);
    // 指数是**下标 6..10** 这五个字符（`x`、`+`、`y`、`-`、`2`）
    expect(scripts.map((s) => s.index)).toEqual([6, 7, 8, 9, 10]);
    expect(from).toBe(6);
    expect(to).toBe(10);
    expect(scripts.every((s) => s.kind === 'super')).toBe(true);
    expect(scripts.map((s) => chars[s.index]!.char).join('')).toBe('x+y-2');
  });

  it('真下标：更小且顶边落在基线上 → sub（而不是 super）', () => {
    /**
     * `X` + 下标 `1` 的真实比例：下标字高约 0.4 倍正文（正文 0.72 → 下标 0.30），
     * 顶边落在基线上、整体再往下探一点。
     *
     * 数值核对：主字高 0.72、基线 0.72、minShift = 0.15×0.72 = 0.108、
     * maxShift = 0.5×0.72 = 0.36。
     * 这里 down = 0.85 − 0.72 = **0.13** ∈ [0.108, 0.36] ✔
     * （up = 0.72 − 1.15 = −0.43，不可能被当成上标）
     */
    const measurements = [
      { y0: 0, y1: 0.72, h: 0.72 },
      { y0: 0, y1: 0.72, h: 0.72 },
      { y0: 0, y1: 0.72, h: 0.72 },
      { y0: 0.85, y1: 1.15, h: 0.3 },
    ];
    const scripts = classifyCharsByGeometry(measurements);
    expect(scripts).toEqual([{ index: 3, kind: 'sub' }]);
  });

  it('位移正好卡在上下限（0.15 / 0.5 倍主字高）时仍然认 —— 浮点误差不能把正确结果翻掉', () => {
    /**
     * ═══════════════════════════════════════════════════════════
     * 这条对应一次**实测抓到的边界失败**，不是凑出来的用例
     * ═══════════════════════════════════════════════════════════
     *
     * 主字高 0.72、位移正好等于上限 0.5×0.72 = 0.36 时：
     *     0.72 − 1.08 = −0.3600000000000001
     *     0.36
     * 严格的 `<=` 判**假** —— 一个完全正确的位移被判据拒之门外。
     * 判定里加了 1e-9 的容差（见 `SHIFT_EPSILON`），这条把它钉住。
     */
    const mk = (y0: number, y1: number, h: number) => ({ y0, y1, h });
    const base = [mk(0, 0.72, 0.72), mk(0, 0.72, 0.72), mk(0, 0.72, 0.72)];

    /**
     * 上标正好抬高 0.5 倍主字高：底边比基线高 0.36、高 0.36
     * → y0 = 0.72 − 0.36 − 0.36 = 0，y1 = 0.72 − 0.36 = 0.36
     * up = 0.72 − 0.36 = 0.3600000000000001（浮点），上限 0.36
     */
    expect(
      classifyCharsByGeometry([...base, mk(0, 0.36, 0.36)]),
    ).toEqual([{ index: 3, kind: 'super' }]);

    // 下标正好低 0.5 倍主字高：顶边 = 0.72 + 0.36 = 1.08，高 0.36 → 底边 1.44
    expect(
      classifyCharsByGeometry([...base, mk(1.08, 1.44, 0.36)]),
    ).toEqual([{ index: 3, kind: 'sub' }]);

    // 上标正好抬高 0.15 倍主字高（下限 0.108）：底边 = 0.72 − 0.108 = 0.612
    expect(
      classifyCharsByGeometry([...base, mk(0.072, 0.612, 0.54)]),
    ).toEqual([{ index: 3, kind: 'super' }]);
  });

  it('误判防线 1：**同一基线上**的小字一律不是上下标（位移为 0）', () => {
    // 小一号的排在同一基线上（例如正文里的英文小写、或另一处小字注释）
    const measurements = [
      { y0: 0, y1: 0.72, h: 0.72 },
      { y0: 0, y1: 0.72, h: 0.72 },
      { y0: 0, y1: 0.72, h: 0.72 },
      { y0: 0.24, y1: 0.72, h: 0.48 }, // 更小，但底边与基线齐平
    ];
    expect(classifyCharsByGeometry(measurements)).toEqual([]);
  });

  it('误判防线 2：位移超过 0.5 倍主字高的一律不认（下一行的小字）', () => {
    const measurements = [
      { y0: 0, y1: 0.72, h: 0.72 },
      { y0: 0, y1: 0.72, h: 0.72 },
      { y0: 0, y1: 0.72, h: 0.72 },
      // 底边比基线高 0.5 倍主字高（0.18/0.72 = 0.25 倍…这里是 0.36 > 0.5×0.72=0.36 的边界外）
      { y0: -0.4, y1: -0.04, h: 0.36 },
    ];
    expect(classifyCharsByGeometry(measurements)).toEqual([]);
  });

  it('误判防线 3：高度不到 0.8 倍但只抬高了一点点 → 不认（阈值下方）', () => {
    const measurements = [
      { y0: 0, y1: 0.72, h: 0.72 },
      { y0: 0, y1: 0.72, h: 0.72 },
      { y0: 0, y1: 0.72, h: 0.72 },
      // 抬高 0.06 / 主字高 0.72 = 0.083 倍 < 0.15 倍阈值
      { y0: 0.18, y1: 0.66, h: 0.48 },
    ];
    expect(classifyCharsByGeometry(measurements)).toEqual([]);
  });

  it('误判防线 4：可测字符少于 3 个时不下结论', () => {
    expect(classifyCharsByGeometry([])).toEqual([]);
    expect(classifyCharsByGeometry([null, null])).toEqual([]);
    expect(
      classifyCharsByGeometry([
        { y0: 0, y1: 0.72, h: 0.72 },
        { y0: -0.4, y1: -0.04, h: 0.36 },
      ]),
    ).toEqual([]);
  });

  it('误判防线 5：正常字不足 2 个（全是大字/全是小字）时不下结论', () => {
    // 只有一个正常字 + 两个候选 → 基线无从谈起
    expect(
      classifyCharsByGeometry([
        { y0: 0, y1: 0.72, h: 0.72 },
        { y0: -0.4, y1: -0.04, h: 0.36 },
        { y0: -0.4, y1: -0.04, h: 0.36 },
      ]),
    ).toEqual([]);
  });

  it('没量到墨迹的字符（null）不参与，也不会被误判', () => {
    const measurements = [
      { y0: 0, y1: 0.72, h: 0.72 },
      null,
      { y0: 0, y1: 0.72, h: 0.72 },
      { y0: 0, y1: 0.72, h: 0.72 },
      { y0: 0.06, y1: 0.54, h: 0.48 },
    ];
    expect(classifyCharsByGeometry(measurements)).toEqual([{ index: 4, kind: 'super' }]);
  });

  it('连续同类上下标并成**一个**片段（`x+y-2` 不能拆成五个公式）', () => {
    const { chars, measurements } = lineWithExponent();
    const scripts = classifyCharsByGeometry(measurements);
    const frags = groupScriptFragments(chars, scripts);
    expect(frags).toHaveLength(1);
    expect(frags[0]).toMatchObject({ kind: 'super', text: 'x+y-2', from: 6, to: 10 });
  });

  it('片段被正文打断：`a` + 指数 `2` + 正文 `b` + 指数 `3` 要成两段', () => {
    const chars = [...'a2b3'].map((char) => ({ char }));
    const scripts = [
      { index: 1, kind: 'super' as const },
      { index: 3, kind: 'super' as const },
    ];
    const frags = groupScriptFragments(chars, scripts);
    expect(frags.map((f) => f.text)).toEqual(['2', '3']);
  });

  it('空格打断片段（`x + y` 里的空格不算指数的一部分）', () => {
    const chars = [...'1 2'].map((char) => ({ char }));
    const scripts = [
      { index: 0, kind: 'super' as const },
      { index: 2, kind: 'super' as const },
    ];
    const frags = groupScriptFragments(chars, scripts);
    expect(frags.map((f) => f.text)).toEqual(['1', '2']);
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. 端到端（假 logits）：裁剪 → 张量 → 解码 → 字符框
// ═══════════════════════════════════════════════════════════════

describe('buildWordCharBoxes：从裁剪到字符框的完整链路', () => {
  const dict = makeDict(['H']); // '' + 'H' + ' ' = 3 类

  it('解出文本、按时间步给出字符框，且横向单调递增', async () => {
    // 裁剪 64×48 → 张量宽 64 → 时间步 8（下采样 8）
    const crop = createCanvas(64, 48);
    ink(crop, 4, 10, 20, 42); // 第一个字的墨迹
    ink(crop, 40, 10, 56, 42); // 第二个字的墨迹

    // 两个 'H'（类别 1）落在步 1 与 6；blank 分隔，避免被合并
    const logits = makeLogits([null, 1, null, null, null, null, 1, null], 3, 8);
    const boxes = await buildWordCharBoxes(
      crop,
      async () => logits,
      dict,
      DEFAULT_SEQ_DOWNSAMPLE,
      createCanvas,
    );

    expect(boxes).not.toBeNull();
    expect(boxes!.text).toBe('HH');
    expect(boxes!.chars.map((c) => c.char)).toEqual(['H', 'H']);
    expect(boxes!.tensorWidth).toBe(64);
    expect(boxes!.sequenceLength).toBe(8);
    expect(boxes!.downsample).toBe(8);

    const [a, b] = boxes!.chars;
    expect(a!.x1).toBeLessThanOrEqual(b!.x0 + 1);
    // 字符框必须落在各自的墨迹上（步 1 中心 x=12，落在第一个墨块 [4,20) 内）
    expect((a!.x0 + a!.x1) / 2).toBeGreaterThan(4);
    expect((a!.x0 + a!.x1) / 2).toBeLessThan(21);
    expect((b!.x0 + b!.x1) / 2).toBeGreaterThan(39);
    expect((b!.x0 + b!.x1) / 2).toBeLessThan(57);
    // 纵向范围取真实墨迹：y[10,42)
    expect(a!.y0).toBeCloseTo(10, 6);
    expect(a!.y1).toBeCloseTo(42, 6);
    expect(boxes!.measurements[0]!.h).toBeCloseTo((42 - 10) / 48, 4);
  });

  it('输出没有 dims[2]（类别数不可知）时返回 null —— 绝不猜类别数', async () => {
    const crop = createCanvas(64, 48);
    ink(crop, 4, 10, 20, 42);
    const bad = { data: new Float32Array(8 * 3), dims: [1, 8] as number[] };
    expect(
      await buildWordCharBoxes(crop, async () => bad, dict, 8, createCanvas),
    ).toBeNull();
  });

  it('解出空文本时返回空字符框（而不是 null，让上层能区分）', async () => {
    const crop = createCanvas(64, 48);
    const blanks = makeLogits([], 3, 8);
    const boxes = await buildWordCharBoxes(crop, async () => blanks, dict, 8, createCanvas);
    expect(boxes).not.toBeNull();
    expect(boxes!.text).toBe('');
    expect(boxes!.chars).toEqual([]);
  });

  it('推理抛异常时向上抛（由 attachCharBoxes 逐词兜住）', async () => {
    const crop = createCanvas(64, 48);
    await expect(
      buildWordCharBoxes(
        crop,
        async () => {
          throw new Error('模拟推理失败');
        },
        dict,
        8,
        createCanvas,
      ),
    ).rejects.toThrow('模拟推理失败');
  });
});

/**
 * 对账与挂载：拿不到字符框时行为必须与改动前一致。
 */
describe('对账与挂载：拿不到字符框时行为必须与改动前一致', () => {
  const charsOf = (text: string): OcrChar[] =>
    [...text].map((char, i) => ({ char, x0: i * 10, y0: 0, x1: i * 10 + 10, y1: 10 }));
  const measOf = (n: number) => Array.from({ length: n }, () => ({ y0: 0, y1: 10, h: 10 }));

  it('完全一致时原样返回（并去掉首尾空白）', () => {
    const r = reconcileWithWordText(charsOf('ABC'), measOf(3), 'ABC', 'ABC');
    expect(r?.chars.map((c) => c.char).join('')).toBe('ABC');
    const padded = reconcileWithWordText(charsOf(' ABC '), measOf(5), ' ABC ', 'ABC');
    expect(padded?.chars.map((c) => c.char).join('')).toBe('ABC');
  });

  it('字符数不一致 → null（错位的字符框比没有更糟）', () => {
    expect(reconcileWithWordText(charsOf('ABCD'), measOf(4), 'ABCD', 'ABC')).toBeNull();
  });

  it('逐字符内容不一致 → null（不能用错的坐标去判上下标）', () => {
    expect(reconcileWithWordText(charsOf('ABD'), measOf(3), 'ABD', 'ABC')).toBeNull();
  });

  it('只在空白上分歧时可以放行（库那边有 injectGapSpaces，两次识别的空格本来就可能不同）', () => {
    const r = reconcileWithWordText(charsOf('A B'), measOf(3), 'A B', 'AB');
    expect(r?.chars.map((c) => c.char).join('')).toBe('AB');
    expect(r?.measurements).toHaveLength(2);
  });

  it('空词文本 → null（没有可对齐的目标）', () => {
    expect(reconcileWithWordText(charsOf('A'), measOf(1), 'A', '   ')).toBeNull();
  });

  it('挂载用 WeakMap 旁挂：没有字符框的词**一个额外属性都不加**', () => {
    const word = makeWord('abc');
    expect(getAttachedChars(word)).toBeUndefined();
    // 键集合与 OcrWord 定义完全一致 —— 这就是「渐进增强」的可观测形式
    expect(Object.keys(word).sort()).toEqual(['bbox', 'confidence', 'fontSize', 'text']);

    attachCharsToWord(word, { chars: charsOf('abc'), measurements: measOf(3) });
    expect(getAttachedChars(word)?.chars).toHaveLength(3);
    // 挂上之后键集合仍然不变
    expect(Object.keys(word).sort()).toEqual(['bbox', 'confidence', 'fontSize', 'text']);
  });

  it('recognizer 为 null（会话建不起来）时返回 0，且不碰任何词', async () => {
    const words = [makeWord('abc')];
    const n = await attachCharBoxes(words, null, {
      canvas: createCanvas(100, 40),
      createCanvas,
    });
    expect(n).toBe(0);
    expect(getAttachedChars(words[0]!)).toBeUndefined();
  });

  it('单个词识别失败不影响其余词（逐词独立 try/catch）', async () => {
    const canvas = createCanvas(400, 60);
    ink(canvas, 10, 10, 90, 50);
    ink(canvas, 110, 10, 190, 50);
    ink(canvas, 210, 10, 290, 50);
    const words = [
      makeWord('AB', { bbox: { x0: 10, y0: 10, x1: 90, y1: 50 } }),
      makeWord('CD', { bbox: { x0: 110, y0: 10, x1: 190, y1: 50 } }),
      makeWord('EF', { bbox: { x0: 210, y0: 10, x1: 290, y1: 50 } }),
    ];

    let call = 0;
    /**
     * 返回**该词自己的**字符（对账是按 `word.text` 逐字符比的，
     * 返回别的字会被 `reconcileWithWordText` 判成不一致而放弃 ——
     * 那正是它该做的事，不能用来测「一个词炸了不影响别的词」）。
     */
    const recognizer = async (crop: OcrCanvasLike) => {
      call++;
      if (call === 2) throw new Error('第二个词炸了');
      // 按裁剪宽度猜是哪个词：第 1、3 个词的词文本分别是 AB / EF
      const text = crop.width > 0 && call === 1 ? 'AB' : 'EF';
      const chars: OcrChar[] = [...text].map((char, i) => ({
        char,
        x0: i * 10,
        y0: 0,
        x1: i * 10 + 10,
        y1: 30,
      }));
      return {
        chars,
        measurements: measOf(2),
        text,
        confidence: 0.9,
        tensorWidth: 64,
        sequenceLength: 8,
        downsample: 8,
      };
    };

    const attached = await attachCharBoxes(words, recognizer, { canvas, createCanvas });
    expect(attached).toBe(2);
    expect(getAttachedChars(words[0]!)).toBeDefined();
    expect(getAttachedChars(words[1]!)).toBeUndefined();
    expect(getAttachedChars(words[2]!)).toBeDefined();
  });

  it('无 DOM 环境（Node）里不注入画布工厂时，逐词失败但**不抛**', async () => {
    // 这正是渐进增强要保证的形态：attachCharBoxes 不能因为
    // 「Node 里没有 canvas」把整页识别带崩
    const words = [makeWord('AB', { bbox: { x0: 10, y0: 10, x1: 90, y1: 50 } })];
    const skips: string[] = [];
    const n = await attachCharBoxes(words, async () => null, {
      canvas: createCanvas(100, 40),
      onSkip: (_w, reason) => skips.push(reason),
    });
    expect(n).toBe(0);
    expect(skips.length).toBeGreaterThan(0);
    expect(getAttachedChars(words[0]!)).toBeUndefined();
  });

  it('字符框会被映射回画布坐标（裁剪原点 + 缩放系数都要算对）', async () => {
    const canvas = createCanvas(400, 60);
    const word = makeWord('AB', { bbox: { x0: 100, y0: 20, x1: 180, y1: 50 } });
    const recognizer = async () => ({
      chars: [
        { char: 'A', x0: 0, y0: 2, x1: 10, y1: 30 },
        { char: 'B', x0: 10, y0: 2, x1: 20, y1: 30 },
      ] as OcrChar[],
      measurements: measOf(2),
      text: 'AB',
      confidence: 0.9,
      tensorWidth: 80,
      sequenceLength: 10,
      downsample: 8,
    });

    // scale=0.5：词框是在缩放一半的画布上量的
    await attachCharBoxes([word], recognizer, { canvas, scale: 0.5, createCanvas });
    const attached = getAttachedChars(word);
    expect(attached).toBeDefined();
    /**
     * 坐标链：**词框坐标** → ×scale 得到画布像素 → 裁剪（含 8% 纵向留白）
     * → 识别返回裁剪内坐标 → 加回裁剪原点 → ÷scale 回到词框坐标系。
     *
     *  · 裁剪原点 x = floor(100×0.5) = 50，裁剪宽 40
     *  · 裁剪原点 y：sy=10、ey=25、h=15 → padY = max(1, round(15×0.08)) = 1 → cy = 9
     *  · 字符框 x0=0、y0=2 →
     *      x = (50+0)/0.5 = 100
     *      y = (9+2)/0.5 = 22
     */
    expect(attached!.chars[0]!.x0).toBeCloseTo(100, 6);
    // 识别里 B 的 x0=10 → (50+10)/0.5 = 120
    expect(attached!.chars[1]!.x0).toBeCloseTo(120, 6);
    expect(attached!.chars[0]!.y0).toBeCloseTo(22, 6);
    // 1/0.5 = 2 倍放大回原坐标：宽度也要跟着还原（识别里 A 的宽是 10）
    expect(attached!.chars[0]!.x1 - attached!.chars[0]!.x0).toBeCloseTo(20, 6);
  });
});
