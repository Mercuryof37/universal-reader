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
  SCRIPT_OUTLIER_RATIO,
  SCRIPT_WORSE_CERTAINTY,
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
  type InkMeasurement,
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

  /**
   * ═══════════════════════════════════════════════════════════════
   * 每字符置信度（重写上下标判定的直接输入）
   * ═══════════════════════════════════════════════════════════════
   *
   * 口径写死在 `decodeCtcWithSteps` 的注释里：**该字符所有触发时间步上
   * argmax 概率的平均值**。下面三条把它钉住：
   *  1. 单步字符 → 就等于那一步的概率；
   *  2. 跨多步字符 → 是**算术平均**，不是峰值、也不是"逐步收敛"的那个值
   *     （时序位置用的是后者，两者必须分开记，否则互相污染）；
   *  3. 与 `confidence`（词级平均）口径一致。
   */
  it('每字符置信度 = 该字符所有触发步的 argmax 概率均值（不是峰值）', () => {
    // 帧：blank a a a b b blank —— 'a' 占三步、'b' 占两步
    const { data } = makeLogits([null, 1, 1, 1, 2, 2, null], n, 7);
    const d = decodeCtcWithSteps(data, 7, n, dict);
    expect(d.confidences).toHaveLength(2);
    // 假 logits 里 argmax 概率都是 0.9，所以均值也是 0.9
    expect(d.confidences[0]).toBeCloseTo(0.9, 6);
    expect(d.confidences[1]).toBeCloseTo(0.9, 6);
    // 与词级平均同口径
    expect(d.confidence).toBeCloseTo(0.9, 6);
  });

  it('低置信度的字符必须能在**逐字符**上区分出来（词级平均做不到这件事）', () => {
    /**
     * 这是「机制 2」在数据上的最小证据：同一串里，两个字符的置信度不同，
     * 而词级平均只会给一个数。
     *
     * 造法：'a' 的三步概率 0.9，'b' 的两步概率 0.4（低置信度的模糊块）。
     */
    const frames = 5;
    const data = new Float32Array(frames * n);
    const fill = (t: number, cls: number, p: number) => {
      for (let c = 0; c < n; c++) data[t * n + c] = c === cls ? p : (1 - p) / (n - 1);
    };
    fill(0, 1, 0.9);
    fill(1, 1, 0.9);
    fill(2, 2, 0.4);
    fill(3, 2, 0.4);
    fill(4, CTC_BLANK_INDEX, 0.99);

    const d = decodeCtcWithSteps(data, frames, n, dict);
    expect(d.text).toBe('ab');
    expect(d.confidences[0]).toBeCloseTo(0.9, 6);
    expect(d.confidences[1]).toBeCloseTo(0.4, 6);
    // 词级平均会把 0.9 与 0.4 抹成一个数（0.65）—— 判据要的正是那个差值
    expect(d.confidence).toBeCloseTo(0.65, 6);
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
    /**
     * ⚠️ 位移**上限**已经退出判定（原因见源码里那段实测：它只挡对的、
     * 不挡错的）。这里仍然钉住它的取值：谁想恢复它，得先看一眼为什么删。
     */
    expect(SCRIPT_CHAR_MAX_SHIFT_RATIO).toBe(0.5);
    /**
     * ⭐ 机制 2 的门槛（Tesseract `superscript_worse_certainty` 的对应物）。
     *
     * ⚠️ 值已从 **0.8 改为 0.93**。0.8 是拿**构造**置信度定出来的，
     * 真实置信度首次拿到后它被证伪：按 0.8 算门槛约 0.78，
     * **连真上标 `σ²` 的 `²`（0.8852）一起拒掉**。
     *
     * 真实数据给出的分界（`buildId 2026-10-08T10:01:55.267Z`）：
     *   真上标 `²` 0.8852   ← 必须接受
     *   误判 `P`   0.9877   ← 必须拒绝
     *   误判 `=`   0.9965 / 0.9983 / 0.9984
     * 门槛必须落在 0.8852 ~ 0.989 之间，0.93 居中。
     * 想再改这个数，请先看源码注释里那组实测值。
     */
    expect(SCRIPT_WORSE_CERTAINTY).toBe(0.93);
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
     * 数值核对：位移单位 = 高度中位数 = 0.72、基线 0.72、
     * minShift = 0.15 × 0.72 = 0.108。
     * 这里 down = 0.85 − 0.72 = **0.13** ≥ 0.108 ✔
     * （up = 0.72 − 1.15 = −0.43，不可能被当成上标）
     *
     * ⚠️ 重写后**没有位移上限**了（原因见源码里那段实测），所以这里不再
     * 需要核对上界 —— 这条用例的形状与数值一个字没改，含义收窄成「方向判对」。
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

  it('位移正好卡在下限（0.15 倍位移单位）时仍然认 —— 浮点误差不能把正确结果翻掉', () => {
    /**
     * ═══════════════════════════════════════════════════════════
     * 这条对应一次**实测抓到的边界失败**，不是凑出来的用例
     * ═══════════════════════════════════════════════════════════
     *
     * 位移单位 0.72、位移正好等于某个门槛时，浮点减法会给出
     * `0.3600000000000001` 这种值 —— 严格的 `<=` / `>=` 会把一个
     * 完全正确的位移判反。判定里加了 1e-9 的容差（见 `SHIFT_EPSILON`），
     * 这条把它钉住。
     *
     * ⚠️ 重写后**上限已经取消**（原因见源码里那段实测），所以这条现在钉的
     * 是下限（0.15）这一侧；下面第一组数值（抬高 0.36）在新判据下是
     * 「远高于下限」，仍然必须认 —— 它同时守住了「上限没有被误加回来」。
     */
    const mk = (y0: number, y1: number, h: number) => ({ y0, y1, h });
    const base = [mk(0, 0.72, 0.72), mk(0, 0.72, 0.72), mk(0, 0.72, 0.72)];

    /**
     * 上标抬高 0.36（= 旧上限）：底边比基线高 0.36、高 0.36
     * → y0 = 0.72 − 0.36 − 0.36 = 0，y1 = 0.72 − 0.36 = 0.36
     * up = 0.72 − 0.36 = 0.3600000000000001（浮点）
     */
    expect(
      classifyCharsByGeometry([...base, mk(0, 0.36, 0.36)]),
    ).toEqual([{ index: 3, kind: 'super' }]);

    // 下标低 0.36：顶边 = 0.72 + 0.36 = 1.08，高 0.36 → 底边 1.44
    expect(
      classifyCharsByGeometry([...base, mk(1.08, 1.44, 0.36)]),
    ).toEqual([{ index: 3, kind: 'sub' }]);

    // 上标正好抬高 0.15 倍位移单位（下限 0.108）：底边 = 0.72 − 0.108 = 0.612
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

  it('误判防线 2：抬高量必须相对**基线**算 —— 底边没高出基线就不算上标', () => {
    /**
     * ═══════════════════════════════════════════════════════════════
     * ⚠️ 这条用例的**判据换了**（断言原样保留，含义随判据更新）
     * ═══════════════════════════════════════════════════════════════
     *
     * 旧实现这条叫「位移超过 0.5 倍主字高的一律不认（下一行的小字）」——
     * 靠一条**位移上限**挡住。重写后上限被删掉了，实测理由是它**只挡对的**：
     *
     *   · 真实第 1 词的指数 `x+y−2` 抬高 0.3694 = 0.62 × 中位字高，
     *     超过 0.5 的上限 → 会被上限拒掉；
     *   · 而旧代码真正误判的 `7`/`P` 只抬高 0.18/0.21 → 上限对它们无效。
     *
     * 这条防线改由**基线**承担。下面这组是它的最小可判形式：
     * 四个字符的底边都在 0.72，基线就是 0.72，没有任何字符的底边
     * 高出基线 —— 哪怕第 4 个比别的矮一大截，它也只是「小一号的字」。
     */
    const measurements = [
      { y0: 0, y1: 0.72, h: 0.72 },
      { y0: 0, y1: 0.72, h: 0.72 },
      { y0: 0, y1: 0.72, h: 0.72 },
      // 更矮，但底边仍然落在基线上（`y0 = y1 − h`）
      { y0: 0.36, y1: 0.72, h: 0.36 },
    ];
    expect(classifyCharsByGeometry(measurements)).toEqual([]);

    /**
     * ⚠️ 对照：只把这一个字符**整体上移** 0.15 × 位移单位（= 0.108），
     * 它就变成上标了 —— 说明「认不认」确实由**基线**这一个量决定，
     * 而不是由「比别的字矮」决定。
     */
    expect(
      classifyCharsByGeometry([
        measurements[0]!,
        measurements[1]!,
        measurements[2]!,
        { y0: 0.252, y1: 0.612, h: 0.36 },
      ]),
    ).toEqual([{ index: 3, kind: 'super' }]);
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

  it('识别**多出**字符 → 放行（跳过多余的，目标每个字符仍然都有框）', () => {
    // ⚠️ 这条此前是「字符数不一致 → null」。规则已按实测改成**不对称**的：
    // 多识别只影响被跳过的那一个字符，漏识别才会让它后面全部错位。
    // 实测依据：含指数的第 1 词被识别成 `…=p²(1−p)x+y−2…`，
    // 比期望多一个 `²`、其余逐个吻合；旧规则因此丢掉了整行。
    const r = reconcileWithWordText(charsOf('ABCD'), measOf(4), 'ABCD', 'ABC');
    expect(r?.chars.map((c) => c.char).join('')).toBe('ABC');
  });

  it('识别**漏掉**目标字符 → null（从那一点起对应关系已不可靠）', () => {
    // 反向防线：实测 `μ>0` 被读成 `μ0`（漏了 `>`），必须继续拒绝。
    // 放行会让字符框对到别的字上 —— 错位的框比没有框更糟。
    expect(reconcileWithWordText(charsOf('ABD'), measOf(3), 'ABD', 'ABCD')).toBeNull();
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
/**
 * 用**用户真实文档的测量值**做回归保护：中线符号不得被判成上标。
 *
 * ═══════════════════════════════════════════════════════════════
 * 这条用例来自一次真实的错误输出
 * ═══════════════════════════════════════════════════════════════
 *
 * 用户导出的结构里出现了：
 *
 *   "text": "(2) 求 Z $^{=}$ X + Y 的概率密度.",  "hasScripts": true
 *
 * **等号被包成了上标。** 原始测量值（第 14 个词，逐字符墨迹框）：
 *
 *   求  bbox [296, 1174.3, 320, 1202.8]  高 28.5  底边 1202.8
 *   =  bbox [378, 1186.3, 398, 1193.6]  高  7.3  底边 1193.6
 *
 * 等号的墨迹天生只占中线那两条横杠：**又矮、底边又高**。
 * 只看底边的判据于是判它为「升起来了」，可它的**中心比正文还低 1.4px** ——
 * 它根本没有升高，只是矮。
 *
 * 任何墨迹位于基线上方的中线符号（`=`、`≈`、`≡`、`~`）都会这样，
 * 所以这不是打补丁，而是判据缺了一条：**升起来的字，中心不该低于正文中心**。
 *
 * 下面把真实像素按主字高归一化（基准：正文底边 = 0.72），
 * 数值不是编的，是从上面那两组 bbox 直接换算来的。
 */
describe('真实回归：中线符号（等号）不得被判成上标', () => {
  /** 真实换算：主字高 28.5px → 归一化 0.72，比例 0.02526/px */
  const PX = 0.72 / 28.5;
  const y = (px: number) => (px - 1202.8) * PX + 0.72;

  /**
   * ═══════════════════════════════════════════════════════════════
   * ⚠️ 这条用例的**判据来源变了**，断言没变（重写后仍然必须拒掉等号）
   * ═══════════════════════════════════════════════════════════════
   *
   * 旧实现靠「中心位移」这条几何判据挡等号：等号的墨迹天生只占中线，
   * 底边高于基线但**中心并不上移**。
   *
   * 重写后这条几何判据被**删掉**了：在真实第 1 词上它会把真正的指数
   * 一起挡掉（`x+y−2` 的 `x` 中心只上移 0.52 × 位移单位，
   * 而它旁边的 `设` 因为汉字探到基线以下、中心被拉低，
   * 于是「中心上移」这条在中英混排里判不准）。挡等号这件事改由
   * **Tesseract 的机制 2**（置信度）承担 —— 实测里等号是被**高置信度**
   * 认出来的普通符号，过不了 `unlikely_threshold` 那道门。
   *
   * 所以这里的夹具补上真实的置信度取值；下面同时钉住
   * 「去掉置信度就挡不住了」这个事实（否则这条测试会变成假保护）。
   */
  it('真实测量的等号：底边高于基线，但置信度正常 → 不是上标', () => {
    const measurements = [
      // 正文：求 / 的 / 概，真实高度 26–28.5px
      { y0: 0, y1: 0.72, h: 0.72 },
      { y0: 0, y1: 0.72, h: 0.72 },
      { y0: 0, y1: 0.72, h: 0.72 },
      // 等号：真实 bbox [378, 1186.3, 398, 1193.6]
      { y0: y(1186.3), y1: y(1193.6), h: (1193.6 - 1186.3) * PX },
    ];
    const chars = [...'求的概='].map((char) => ({ char }));
    // 四个字符都是被高置信度认出来的普通字（真实识别里等号的置信度也在这一档）
    const confidences = [0.98, 0.97, 0.98, 0.96];

    expect(classifyCharsByGeometry(measurements, chars, confidences)).toEqual([]);
  });

  it('⚠️ 同一组几何、**不给置信度**时等号仍然是几何候选（机制 2 才是挡住它的那条）', () => {
    const measurements = [
      { y0: 0, y1: 0.72, h: 0.72 },
      { y0: 0, y1: 0.72, h: 0.72 },
      { y0: 0, y1: 0.72, h: 0.72 },
      { y0: y(1186.3), y1: y(1193.6), h: (1193.6 - 1186.3) * PX },
    ];

    // 没有置信度 → 机制 2 不可用 → 退回纯几何 → 等号作为「更小 + 底边更高」被选中。
    // 这正是「关掉新判据会变红」的可观测形式：这条与上一条只差一个 confidences 参数。
    expect(classifyCharsByGeometry(measurements)).toEqual([{ index: 3, kind: 'super' }]);
  });

  it('同一条判据不能误伤真的指数 —— 抬高且中心上移的仍要认', () => {
    /**
     * 这是上面那条的**反面防线**：如果为了挡等号把判据收得过头，
     * 真的指数就会被一起挡掉，那种"修复"是把问题换了个方向。
     * 夹具取典型指数形态：自身高 0.6 × 主字高、底边抬高 0.3 × 主字高。
     */
    const measurements = [
      { y0: 0, y1: 0.72, h: 0.72 },
      { y0: 0, y1: 0.72, h: 0.72 },
      { y0: 0, y1: 0.72, h: 0.72 },
      // 底边 0.72 − 0.216 = 0.504，高 0.432 → y0 = 0.072
      { y0: 0.072, y1: 0.504, h: 0.432 },
    ];

    expect(classifyCharsByGeometry(measurements)).toEqual([{ index: 3, kind: 'super' }]);
  });
});
/**
 * 用**用户真实文档的数据**做回归保护：对账只该放过「格式差异」。
 *
 * ═══════════════════════════════════════════════════════════════
 * 这组用例来自 15 条真实的失败记录
 * ═══════════════════════════════════════════════════════════════
 *
 * 用户那份习题导出后，23 个词里 **15 个**卡在「字符序列与词文本不一致」，
 * 而这 15 条的原因**几乎全是格式** —— 同一张图识别两次，
 * 一次给半角括号、一次给全角，汉字之间的空格时有时无，大小写也不稳定。
 *
 * 但其中有两条是**真的认错了字**，必须继续拒绝：
 * 放行会让字符框对到别的字上，比没有字符框更糟。
 * 所以这组用例**两个方向都有**：该放的放，该拦的拦。
 */
const mkChars = (text: string) =>
  [...text].map((char, i) => ({
    char,
    x0: i * 10,
    y0: 0,
    x1: i * 10 + 9,
    y1: 10,
  }));

const mkMeas = (n: number) =>
  Array.from({ length: n }, () => ({ y0: 0, y1: 10, h: 10 }));

const reconcile = (recognized: string, expected: string) =>
  reconcileWithWordText(mkChars(recognized), mkMeas(recognized.length), recognized, expected);

describe('真实回归：对账必须容忍格式差异', () => {
  it('半角括号 vs 全角括号 —— 实测第 7 词', () => {
    // 期望 `(1） 求 条件 概率 密度 f x|Y(x |y).`，得到 `（1）求条件概率密度 f x|Y(x |y).`
    expect(reconcile('（1）求条件概率密度 f x|Y(x |y).', '(1） 求 条件 概率 密度 f x|Y(x |y).')).not.toBeNull();
  });

  it('半角逗号/括号变全角 —— 实测第 9 词', () => {
    expect(reconcile('24. 设随机变量(X，Y）的概率密度为', '24. 设随机变量(X,Y)的概率密度为')).not.toBeNull();
  });

  it('空格时有时无 + 全角括号 —— 实测第 13 词', () => {
    expect(reconcile('（1）问 X 和 Y是否相互独立？', '(1)问 X 和 Y 是否相互独立？')).not.toBeNull();
  });

  it('半角逗号变全角 —— 实测第 18 词', () => {
    expect(reconcile('0，其他', '0, 其他')).not.toBeNull();
  });

  it('大小写不一致 —— 实测第 21 词', () => {
    expect(reconcile('p).', 'P).')).not.toBeNull();
  });

  it('⚠️ 真的认错了字必须继续拒绝 —— 实测第 10 词（`）` 被认成 `1`）', () => {
    // 字符数相同（1/1），只有归一化后的内容不同 —— 正是这条闸存在的意义
    expect(reconcile('1', '）')).toBeNull();
  });

  it('⚠️ 数字被认成字母也必须继续拒绝 —— 实测第 11 词（`0` 被认成 `O`）', () => {
    expect(reconcile('O，', '0，')).toBeNull();
  });

  it('⚠️ 漏掉一个运算符也必须继续拒绝 —— 实测第 4 词（`μ>0` 少了 `>`）', () => {
    // 期望 19 字符、得到 18 —— 少的是 `>`，不是格式问题
    expect(reconcile('其中λ>0，μ0是常数.引入随机变量', '其中λ>0，μ>0是常数.引入随机变量')).toBeNull();
  });

  it('归一化不能把完全不相干的文本放过', () => {
    expect(reconcile('完全不同的内容', '这一行文字明显长得多')).toBeNull();
  });
});

describe('真实回归：序列对齐必须救回含指数的第 1 词', () => {
  const reconcileReal = (recognized: string, expected: string) =>
    reconcileWithWordText(mkChars(recognized), mkMeas(recognized.length), recognized, expected);

  it('第 1 词：识别多出一个 `²`，其余吻合 → 放行，且 `x+y−2` 五个字符都拿到框', () => {
    /**
     * 真实数据（用户导出）：
     *   识别 `17. 设随机变量(X,Y) 具有分布律 P{ X = x ,Y = y} = p² (1− p )x+y−2 ,0 < p < 1,x ,y 均为正`
     *   期望 `17. 设 随机 变量 (X ,Y) 具有 分 布律 P {X = x ,Y = y} = p (1 − p )x+y−2 ,0 < p < 1,x ,y 均为 正`
     *
     * 差别只有 `p²` 与 `p` —— 识别**多**一个 `²`。旧规则要求逐字符相同，
     * 于是整行被丢弃，而这一行正是唯一需要判上标的地方。
     */
    const recognized =
      '17. 设随机变量(X,Y) 具有分布律 P{ X = x ,Y = y} = p² (1− p )x+y−2 ,0 < p < 1,x ,y 均为正';
    const expected =
      '17. 设 随机 变量 (X ,Y) 具有 分 布律 P {X = x ,Y = y} = p (1 − p )x+y−2 ,0 < p < 1,x ,y 均为 正';

    const r = reconcileReal(recognized, expected);
    expect(r, '必须能对齐').not.toBeNull();

    // 对齐后的字符序列必须**恰好等于期望文本**（不含空白），逐字符一一对应
    const got = r!.chars.map((c) => c.char).join('');
    expect(got.replace(/\s+/g, '')).toBe(expected.replace(/\s+/g, ''));

    // 与 `word.text` 逐位对齐；**每个非空白字符都必须有测量值**
    // （空白位是 null —— 没有墨迹就没有几何，这是契约的一部分）
    expect(r!.measurements).toHaveLength(r!.chars.length);
    const blank = r!.chars.filter((c) => !c.char.trim()).length;
    expect(r!.measurements.filter((m) => m !== null)).toHaveLength(r!.chars.length - blank);

    // 指数 `x+y−2` 那五个字符必须都在，且横向位置递增（说明框没串位）
    const xs = r!.chars.filter((c) => c.char.trim()).map((c) => c.x0);
    for (let i = 1; i < xs.length; i++) {
      expect(xs[i], `第 ${i} 个字符的横坐标必须递增`).toBeGreaterThan(xs[i - 1]!);
    }
  });

  it('第 20 词：Unicode 下标 `n₂` 与普通 `n2` 必须视为同一字符', () => {
    const recognized =
      '35. 设 X,Y是相互独立的随机变量,X ∼ b(n1,p),Y ∼b(n2,p),证明Z = X +Y∼b(n1 +n2，';
    const expected =
      '35. 设 X,Y是相互独立的随机变量,X ∼ b(n1,p),Y∼ b(n2,p),证明Z = X +Y∼b(n1+n₂,';

    const r = reconcileReal(recognized, expected);
    expect(r, '`n₂`(U+2082) 与 `n2` 是同一张图的两次识别结果，不该因此丢弃').not.toBeNull();
  });

  it('⚠️ 反向：实测那些**真的漏字/认错字**的必须继续拒绝', () => {
    // 漏掉 `>`（实测第 4 词）
    expect(reconcileReal('其中λ>0，μ0是常数.引入随机变量', '其中λ>0，μ>0是常数.引入随机变量')).toBeNull();
    // 漏掉开头的 `=`（实测第 6 词）
    expect(reconcileReal('10, 当X>Y', '=10, 当X>Y')).toBeNull();
    // `）` 被认成 `1`（实测第 10 词）
    expect(reconcileReal('1', '）')).toBeNull();
    // `0` 被认成 `O`（实测第 11 词）
    expect(reconcileReal('O，', '0，')).toBeNull();
    // 整段认错（实测第 5 词）
    expect(reconcileReal('2-, Mx', 'Z= 当X>Y')).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// 6. 按 Tesseract 重写后的上下标判定：真实第 1 词（两个方向都钉住）
// ═══════════════════════════════════════════════════════════════
//
// 参照实现：`ccmain/superscript.cpp`（David Eger, 2012, Apache-2.0）
// https://tesseract-ocr.github.io/tessapi/3.05.02/a00149_source.html#l00253
//
// 这一组用的是**用户导出的真实字符框**，逐字抄录，不掺合成比例：
//
//   词 1: "17. 设 随机 变量 (X ,Y) 具有 分 布律 P {X = x ,Y = y}
//          = p (1 − p )x+y−2 ,0 < p < 1,x ,y 均为 正"
//          bbox [225, 212, 1604, 255]   fontSize 43
//
// 旧判据在这份数据上的实测输出（我用同一张表跑过）：
//   候选 = `7@1`、`P@18`  ← **都是误判**
//   真正的指数 `x+y−2` 一个都没进
// 重写后：候选多了三个 `=`（中线符号）与真正的指数，而机制 2 的置信度门
// 把误判全部拒掉，只留下 `x+y−2` 那五个字符。
//
// ⚠️ 表格是**按出现顺序**与正文配对的，配错一位整组就失去意义，
// 所以下面第一条断言就是「张数必须相等」。

/** 与真实词文本逐字对齐的 `[字符, y0, y1]`（y 为画布像素，来自导出 bbox） */
const REAL17_ROWS: Array<[string, number, number]> = [
  ['1', 219.2, 239.6],
  ['7', 219.2, 238.6],
  ['.', 236.6, 240.6],
  ['设', 220.2, 247.8],
  ['随', 220.2, 247.8],
  ['机', 221.3, 246.8],
  ['变', 220.2, 246.8],
  ['量', 220.2, 247.8],
  ['(', 223.3, 245.8],
  ['X', 223.3, 244.7],
  [',', 237.6, 245.8],
  ['Y', 223.3, 244.7],
  [')', 224.3, 245.8],
  ['具', 220.2, 247.8],
  ['有', 220.2, 247.8],
  ['分', 220.2, 247.8],
  ['布', 220.2, 247.8],
  ['律', 220.2, 248.8],
  ['P', 223.3, 234.5],
  ['{', 221.3, 246.8],
  ['X', 226.4, 244.7],
  ['=', 231.5, 237.6],
  ['x', 231.5, 244.7],
  // ⚠️ 下面四个 `[209, 258]` 是**超出整行**的异常框（行 yRange 是 [212,255]）：
  // crop 带 padding，切片列混进了相邻行的墨迹。保留它们，
  // 因为「基准必须抗异常值」这条正是被它们逼出来的。
  [',', 209, 258],
  ['Y', 223.3, 244.7],
  ['=', 231.5, 237.6],
  ['y', 231.5, 248.8],
  ['}', 222.3, 246.8],
  ['=', 231.5, 237.6],
  ['p', 227.4, 249.8],
  ['(', 223.3, 245.8],
  ['1', 223.3, 244.7],
  ['-', 209, 258],
  ['p', 227.4, 249.8],
  [')', 223.3, 245.8],
  // ── 指数：真实墨迹高 7.2px、底边比正文高 12.2px ──
  ['x', 225.3, 232.5],
  ['+', 225.3, 232.5],
  ['y', 225.3, 232.5],
  ['-', 225.3, 232.5],
  ['2', 220.2, 232.5],
  [',', 237.6, 245.8],
  ['0', 224.3, 244.7],
  ['<', 225.3, 243.7],
  ['p', 227.4, 243.7],
  ['<', 225.3, 243.7],
  ['1', 224.3, 244.7],
  [',', 237.6, 245.8],
  ['x', 223.3, 243.7],
  [',', 237.6, 245.8],
  ['y', 223.3, 243.7],
  ['均', 220.2, 247.8],
  ['为', 220.2, 247.8],
  ['正', 221.3, 246.8],
];

const REAL17_TEXT =
  '17. 设 随机 变量 (X ,Y) 具有 分 布律 P {X = x ,Y = y} = p (1 - p )x+y-2 ,0 < p < 1,x ,y 均为 正';

/**
 * 真实词框高度 36px（不是被公式撑大的 43）、基线 244.7 —— 都是导出里的原值。
 *
 * 归一化口径与生产一致（见 `InkMeasurement`）：纵向**相对基线**，
 * 分母用词框高。这样 `y1 = 0.72` 就是「底边坐在基线上」。
 */
const REAL17_MAIN = 36;
const REAL17_BASELINE = 244.7;

/** 指数的字符下标区间（真实文本里 `x+y-2` 的位置） */
const REAL17_EXP_FROM = 35;
const REAL17_EXP_TO = 39;

function buildReal17(): {
  chars: Array<{ char: string }>;
  measurements: Array<InkMeasurement | null>;
} {
  const chars = [...REAL17_TEXT].filter((c) => c.trim()).map((char) => ({ char }));
  expect(chars.length, '字符表必须与正文的非空白字符一一对应').toBe(REAL17_ROWS.length);
  const measurements: Array<InkMeasurement | null> = REAL17_ROWS.map(([ch, y0, y1], i) => {
    expect(ch, `第 ${i} 个字符`).toBe(chars[i]!.char);
    return {
      y0: (y0 - REAL17_BASELINE) / REAL17_MAIN + 0.72,
      y1: (y1 - REAL17_BASELINE) / REAL17_MAIN + 0.72,
      h: (y1 - y0) / REAL17_MAIN,
    };
  });
  return { chars, measurements };
}

/**
 * 真实第二遍识别的**每字符置信度**。
 *
 * ═══════════════════════════════════════════════════════════════
 * ⚠️ 这一份是**构造的**，不是从模型里导出的 —— 如实说明
 * ═══════════════════════════════════════════════════════════════
 *
 * 用户导出的是**词级**置信度，逐字符置信度当时没有出口（这正是本次改动
 * 要补的东西），所以拿不到那份真值。下面这组数按**两条已知事实**构造：
 *
 *  1. 被误判的 `7`、`P`、`p`、`=` 都是被**高置信度**认出来的普通字
 *     （它们在正文里、字形清晰、也在词级置信度 92 的那一档里）；
 *  2. 指数 `x+y−2` 是**小而模糊**的块 —— 同一张图两遍识别一次给 `x+y−2`、
 *     一次给 `p²`（多出一个 `²`），说明识别器在这里本来就不确定。
 *
 * 取值刻意**不对称**：普通字 0.97–0.99、指数 0.58–0.66。
 * 判据的门槛落在 0.8 × 平均（≈0.78），两侧各留 0.12 以上，不靠卡边界。
 */
function real17Confidences(): number[] {
  const weak = [0.62, 0.65, 0.61, 0.58, 0.66];
  return REAL17_ROWS.map((_row, i) =>
    i >= REAL17_EXP_FROM && i <= REAL17_EXP_TO ? weak[i - REAL17_EXP_FROM]! : 0.97 + ((i * 7) % 5) * 0.005,
  );
}

describe('真实第 1 词：重写后的上下标判定（Tesseract 机制 1 / 2 / 3）', () => {
  it('夹具自身：字符表与正文逐位对齐，指数落在 35..39', () => {
    const { chars } = buildReal17();
    expect(REAL17_ROWS.length).toBe(53);
    expect(chars[REAL17_EXP_FROM]!.char).toBe('x');
    expect(chars[REAL17_EXP_TO]!.char).toBe('2');
    expect(chars.map((c) => c.char).join('')).toBe(REAL17_TEXT.replace(/\s+/g, ''));
  });

  it('机制 1（只看几何）：真指数进了候选，但 `P` 与三个中线 `=` 也进了 —— 所以必须再加一条', () => {
    const { chars, measurements } = buildReal17();
    const scripts = classifyCharsByGeometry(measurements, chars);
    const picked = scripts.map((s) => `${chars[s.index]!.char}@${s.index}`);

    // ✅ 真指数五个字符全部被位置判据选中（旧实现这里是**零个**）
    for (let i = REAL17_EXP_FROM; i <= REAL17_EXP_TO; i++) {
      expect(picked, `指数第 ${i} 个字符必须进候选`).toContain(`${chars[i]!.char}@${i}`);
    }
    // ⚠️ 误判同样存在：几何分不开它们 —— 这正是机制 2 存在的理由
    expect(picked).toContain('P@18');
  });

  it('⭐ 机制 2：加上置信度门后，`P` 被拒、`x+y−2` 五个字符全部留下', () => {
    const { chars, measurements } = buildReal17();
    const scripts = classifyCharsByGeometry(measurements, chars, real17Confidences());

    expect(scripts.map((s) => s.index)).toEqual([35, 36, 37, 38, 39]);
    expect(scripts.every((s) => s.kind === 'super')).toBe(true);
    expect(scripts.map((s) => chars[s.index]!.char).join('')).toBe('x+y-2');
  });

  it('⭐ 机制 2 反向：把指数那五个字符的置信度换成高置信度 → 一个都不判（判据真的在看这个数）', () => {
    const { chars, measurements } = buildReal17();
    const confident = real17Confidences().map(() => 0.98);

    expect(classifyCharsByGeometry(measurements, chars, confident)).toEqual([]);
  });

  it('机制 3：`√` 与 `Y` 哪怕是低置信度的小块也不认（第 4 词 `Z = √X2 + Y` 的真实误判）', () => {
    /**
     * 实测误判（用户导出）：`验证随机变量 Z = $^{√}$X2 + $^{Y}$ 的概率密度为`
     * —— 根号与 `Y` 被包成了上标。
     *
     * 这里把它们放进**同一行正文**里、位置照真实给（`√` 底边抬得高、`Y` 坐着基线），
     * 并故意给**最低的置信度**（0.5）：机制 2 放行不了它们，得靠别的判据。
     *
     *   · `√`（`U+221A`，类别 Sm）—— 它**不是**标点，机制 3 拦不住；
     *     真正拦住它的是**高度门**：它的墨迹与汉字同高（根号要罩住被开方数），
     *     `h > 0.8 × mainHeight` → 直接不是候选；
     *   · `Y` 坐着基线，位置判据本身就不认它。
     *
     * ⚠️ 如实说明：这里验的是「这两个字符不会被判成上标」，
     * **不能**证明机制 3 抓到了它们（机制 3 抓的是标点）。
     */
    const measurements: Array<InkMeasurement | null> = [
      { y0: 0, y1: 0.72, h: 0.72 }, // 汉字的量级
      { y0: 0, y1: 0.72, h: 0.72 },
      { y0: 0, y1: 0.72, h: 0.72 },
      { y0: 0, y1: 0.72, h: 0.72 },
      // `√`：墨迹从顶到底罩住整个字身（真实根号就是这么高）
      { y0: -0.05, y1: 0.74, h: 0.79 },
      // `Y`：坐在基线上
      { y0: 0, y1: 0.72, h: 0.72 },
    ];
    const chars = [...'验证变量√Y'].map((char) => ({ char }));
    const lowest = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5];

    expect(classifyCharsByGeometry(measurements, chars, lowest)).toEqual([]);
  });

  it('机制 3：标点一律不是上下标（`）` 就是被这条挡住的）', () => {
    const measurements: Array<InkMeasurement | null> = [
      { y0: 0, y1: 0.72, h: 0.72 },
      { y0: 0, y1: 0.72, h: 0.72 },
      { y0: 0, y1: 0.72, h: 0.72 },
      // 一个又小又高的 `）`（实测 `）` 墨迹高只有 9px —— 天生满足上标几何）
      { y0: 0.36, y1: 0.6, h: 0.24 },
    ];
    /**
     * ⚠️ 字符数组必须与测量数组**等长**，否则那一格会取到 undefined、
     * 所有字符判据（标点/汉字）静默落空 —— 这次就是这么写错过的。
     * 所以下面先断言长度，再断言行为。（中间那格给空格，它按契约是「无墨迹」。）
     */
    const chars = [...'正文 )'].map((char) => ({ char }));
    const low = [0.9, 0.9, 0.9, 0.5];
    expect(chars).toHaveLength(measurements.length);

    // 不给字符本身 → 不做标点拒绝 → 它会作为几何+置信度都合格的候选被选中
    expect(classifyCharsByGeometry(measurements, null, low)).toEqual([{ index: 3, kind: 'super' }]);
    // 给了字符 → 机制 3 命中，拒掉
    expect(classifyCharsByGeometry(measurements, chars, low)).toEqual([]);
  });

  it('机制 3：汉字不是上下标（实测坏输出 `(1$^{)问}$` 里那个 `问`）', () => {
    const measurements: Array<InkMeasurement | null> = [
      { y0: 0, y1: 0.72, h: 0.72 },
      { y0: 0, y1: 0.72, h: 0.72 },
      { y0: 0, y1: 0.72, h: 0.72 },
      // 「一个标点带一个汉字」的检测框：两者都被切得很小、都抬高
      { y0: 0.34, y1: 0.58, h: 0.24 },
      { y0: 0.34, y1: 0.58, h: 0.24 },
    ];
    const chars = [...'正文 ）问'].map((char) => ({ char }));
    const low = [0.9, 0.9, 0.9, 0.5, 0.5];
    expect(chars).toHaveLength(measurements.length);

    // 中文标点 `）` 与汉字 `问` 一起被拒：前者走机制 3，后者走「汉字不是上下标」
    expect(classifyCharsByGeometry(measurements, chars, low)).toEqual([]);

    // 反证：把最后那个位置换成**非汉字**（同一组几何、同一个置信度），
    // `）` 仍被机制 3 拒掉，而换上去的 `X` 会被判成上标 ——
    // 说明挡住 `问` 的确实是「汉字」这条判据本身，而不是几何或置信度。
    const swapped = [...'正文 ）X'].map((char) => ({ char }));
    expect(classifyCharsByGeometry(measurements, swapped, low)).toEqual([
      { index: 4, kind: 'super' },
    ]);
  });

  it('机制 1：基准取**中位数**而不是「高大字」—— 同一组数据只有中位数判得出指数', () => {
    /**
     * ═══════════════════════════════════════════════════════════════
     * 这条是补「假保护」补出来的，说明必须写清，否则很容易被当成凑数
     * ═══════════════════════════════════════════════════════════════
     *
     * **只靠真实第 1 词那组数据，分辨不出基准的两种算法** —— 我实测过：
     *   · 取全体高度中位数 → 0.5944；取上四分位数（旧实现）→ 0.7083；
     *   · 把代码换回旧口径，真实数据那一组用例**照样全绿**。
     * 因为真正区分对错的是**置信度门**，而它在两种基准下都判对了
     * （基准偏大只让门槛更松，高置信度的 `P` 仍被门挡住）。
     *
     * 所以要一条能把两者分开的夹具。判别条件很明确：**位移单位要在
     * 两种口径下不同**，而指数的抬升量落在两者之间。
     *
     *   四个参考字（高度 0.48 / 0.55 / 0.50 / 0.55，底边都在基线 0.72）
     *   + 指数（高 0.32、底边抬升 0.08）—— 高度都按真实小写排版给：
     *   x 高度 0.5、上伸部 0.55、下标档 0.48。
     *
     *   · **中位数**：高度排序 [0.32, 0.48, 0.50, 0.55, 0.55] → 0.50；
     *     位移单位 0.50、minShift = 0.075；指数抬升 **0.08** ✔ 判得出；
     *   · **上四分位数**（旧实现）：→ 0.55；minShift = 0.0825；
     *     同一个抬升 0.08 ✘ 判不出。
     *
     * 抬升量 0.08 落在缝隙正中（0.075 与 0.0825 之间，两侧各留 0.0025），
     * 不是靠卡边界通过的。
     */
    const mk = (y0: number, y1: number) => ({ y0, y1, h: y1 - y0 });
    const head = [mk(0.24, 0.72), mk(0.17, 0.72), mk(0.22, 0.72), mk(0.17, 0.72)];
    const chars = [...'bdlo2'].map((char) => ({ char }));

    // 判别：抬升 0.08 → 只有中位数口径判得出
    expect(classifyCharsByGeometry([...head, mk(0.32, 0.64)], chars)).toEqual([
      { index: 4, kind: 'super' },
    ]);

    // 对照一：抬升 0.13（远超两种口径的门槛）→ 都判得出
    expect(classifyCharsByGeometry([...head, mk(0.27, 0.59)], chars)).toEqual([
      { index: 4, kind: 'super' },
    ]);

    // 对照二：底边落到基线**下方** 0.03（`down` 为负、`up` 也够不着）→ 都不判
    expect(classifyCharsByGeometry([...head, mk(0.36, 0.75)], chars)).toEqual([]);

    // 对照三：直接压在基线上 → 都不判（这是「上标」与「小一号的字」的分界）
    expect(classifyCharsByGeometry([...head, mk(0.4, 0.72)], chars)).toEqual([]);

    /**
     * ═══════════════════════════════════════════════════════════════
     * 第二个判别点：**整行字符都矮**时仍要判得出（旧口径的失败模式）
     * ═══════════════════════════════════════════════════════════════
     *
     * 旧实现的基线只取「正常高度」（`h ≥ 0.8 × mainHeight`）字符的底边，
     * 而 `mainHeight` 取上四分位数 —— 当整行高度都很接近时，四分位数
     * 与中位数几乎相同，于是「正常字」的门槛把**绝大多数**字符排除在外，
     * 基线只由个位数字符决定（下标很多的行上尤其明显）。
     *
     * 下面的夹具把这条差异摆出来：四个参考字高度都是 0.45、指数 0.34 且抬升 0.085。
     *
     * ⚠️ **诚实说明**：这一条**不足以**把两种基线算法分开。我逐个数值试过
     * （见 `.dsh-tmp` 里的复算脚本），结论是：
     *   · 只要 `mainHeight` 由 ≥ 2 个同档字符给出，那么这 ≥ 2 个字符本身
     *     就满足 `h ≥ 0.8 × mainHeight`，旧口径的"正常字"集合永远 ≥ 2 ——
     *     两边的基线**逐位相同**；
     *   · 二者只在「正常字只有 0 或 1 个」时不同，而那要求整行里只有一个
     *     远高于其余的字符（其余全矮），真实排版里很罕见。
     * 所以这条用例钉的是**行为**（整行都矮也要判得出），不是两种算法的差异；
     * 把这个区别写出来，比含糊地声称「覆盖了」有用。
     */
    const shortLine = [mk(0.27, 0.72), mk(0.27, 0.72), mk(0.27, 0.72), mk(0.27, 0.72)];
    expect(classifyCharsByGeometry([...shortLine, mk(0.38, 0.72)], chars)).toEqual([]); // 抬升 0
    expect(classifyCharsByGeometry([...shortLine, mk(0.3, 0.64)], chars)).toEqual([
      { index: 4, kind: 'super' },
    ]);
  });

  it('机制 1：基准取**中位数**，两个 49px 的异常框挪不动它（旧实现在这里翻车）', () => {
    const { chars, measurements } = buildReal17();
    const heights = measurements.map((m) => m!.h).sort((a, b) => a - b);
    const p75 = heights[Math.round((heights.length - 1) * 0.75)]!;
    const median = heights[Math.floor((heights.length - 1) / 2)]!;
    const max = heights[heights.length - 1]!;

    // 真实分布：中位 0.5944、p75 只有 0.7083（拉丁数字的自然高度）、max 到 1.3611（异常框）
    expect(median).toBeCloseTo(0.5944, 3);
    expect(p75).toBeCloseTo(0.7083, 3);
    expect(max).toBeCloseTo(1.3611, 3);
    // 中位数**离异常值很远**（不到它的一半）—— 这就是它抗污染的可观测形式
    expect(median).toBeLessThan(max * 0.5);

    /**
     * 反证（把两条门槛各数一遍，数字都是实测）：
     *  · 取中位数：异常值门槛 = 0.5944 × 1.5 = 0.8917 → 只有那 **2 个** 1.3611 被丢弃，
     *    剩下 **51 个**字符参与判定；
     *  · 取 max（旧实现取上四分位数，方向上一样）：「正常高度」门槛 = 1.3611 × 0.8 = 1.0889，
     *    整行只有那 **2 个异常框**够得着 —— 其余 51 个全部落到门槛之下，
     *    于是**每一个正常字符都会被当成上标候选**。这正是旧实现的翻车方式。
     */
    const kept = heights.filter((h) => h <= median * SCRIPT_OUTLIER_RATIO);
    expect(kept.length).toBe(51);
    expect(heights.filter((h) => h >= median * SCRIPT_CHAR_MAX_HEIGHT_RATIO).length).toBe(37);
    expect(heights.filter((h) => h >= max * SCRIPT_CHAR_MAX_HEIGHT_RATIO).length).toBe(2);

    /**
     * ═══════════════════════════════════════════════════════════════
     * ⚠️⚠️ 锚点必须是**载荷**，不能只是「说得通」—— 这条是补漏补出来的
     * ═══════════════════════════════════════════════════════════════
     *
     * 上面那几条分位数断言只能证明「基准量出来是多少」，**证明不了
     * 判据真的在用这个量**。实测：把 `mainHeight` 换回旧口径（上四分位数
     * 0.7083），整套测试**照样全绿** —— 那几条断言就是假保护。
     * （信度门兜住了后果：基准一偏，门槛松了，高置信度的 `P` 反而被放行、
     *   真指数被判成正文，两边的量正好错开，于是没有任何用例翻红。）
     *
     * 所以这里补一条**行为**断言：同一批字符框、同一批置信度，
     * 只把基准从「中位数」换回「上四分位数」（`mainHeight → 0.7083`，
     * 位移单位随之从 0.0891 抬到 0.1062），真指数 `x+y−2` 就必须留下、
     * 高置信度的 `P` 必须被拒。任何一条不成立，基准这件事就还没被钉住。
     */
    const scripts = classifyCharsByGeometry(measurements, chars, real17Confidences());
    expect(
      scripts.map((s) => s.index),
      '真指数必须留下（基准若被旧口径换掉，这里会先塌）',
    ).toEqual([35, 36, 37, 38, 39]);
    expect(
      scripts.map((s) => chars[s.index]!.char).join(''),
      '高置信度的 `P` 必须被拒',
    ).toBe('x+y-2');
  });
});

/**
 * ═══════════════════════════════════════════════════════════════
 * 真实回归：置信度**有洞**时那道门必须仍然生效
 * ═══════════════════════════════════════════════════════════════
 *
 * 数据是用户导出的**第 14 词**（`(2) 求 Z = X + Y 的概率密度.`，`buildId`
 * `2026-10-08T09:42:56.578Z`）——17 个有字符框的词里**唯一一个置信度完全齐备
 * 且含 `=` 的**，也是启用版里**输出干净、没有误判**的那一行。
 *
 * 它的 `=` 置信度 **0.9993**，而该词正常字符调整后的平均约 **0.975**，
 * 门槛 `0.8 × 0.975 ≈ 0.780` —— `0.9993 > 0.780`，**门应当拒绝它**。
 *
 * ⚠️ 这个 bug 的形态非常隐蔽：原来 **缺一个置信度就整条不启用**，
 * 而实测 17 个词里 **11 个缺值**，**所有出误判的词（1/15/16/20）都在那 11 个里**。
 * 也就是说那道门在该用它的地方**从未运行**，我却一度据此得出
 * 「置信度这个维度没用」的结论 —— 那是从输出倒推的，前提没验证过。
 *
 * 所以下面第三条是关键：**只挖掉一个洞**，门槛必须照算、`=` 必须照样被拒。
 * 在修复前它会退回纯几何、把 `=` 判成上标，**这条测试因此会变红**。
 */
describe('真实回归：置信度有洞时门仍生效（第 14 词）', () => {
  // [字符, y0, y1, confidence] —— 逐字抄录用户导出
  const W14: Array<[string, number, number, number | null]> = [
    ['(', 1178, 1200, 0.668],
    ['2', 1178, 1199.1, 1],
    [')', 1178, 1200, 0.7274],
    ['求', 1174.3, 1202.8, 0.9999],
    ['Z', 1177.1, 1199.1, 0.9971],
    ['=', 1186.3, 1193.6, 0.9993], // ← 又矮又靠上，几何合格
    ['X', 1177.1, 1199.1, 0.9979],
    ['+', 1178, 1200.9, 0.9876],
    ['Y', 1177.1, 1199.1, 0.9927],
    ['的', 1175.3, 1201.8, 0.9993],
    ['概', 1176.2, 1201.8, 1],
    ['率', 1173.4, 1202.8, 1],
    ['密', 1174.3, 1201.8, 1],
    ['度', 1174.3, 1201.8, 1],
  ];

  const meas = (): Array<{ y0: number; y1: number; h: number }> =>
    W14.map(([, y0, y1]) => ({ y0, y1, h: y1 - y0 }));
  const chars = () => W14.map(([c]) => ({ char: c }));
  const eqIndex = W14.findIndex(([c]) => c === '=');

  it('置信度齐备时：几何合格但置信度高的 `=` 必须被拒（机制 2）', () => {
    const out = classifyCharsByGeometry(
      meas(),
      chars(),
      W14.map(([, , , c]) => c),
    );
    expect(out.map((s) => s.index)).not.toContain(eqIndex);
  });

  it('⚠️ 只挖掉**一个**洞时，门槛仍需照算、`=` 仍需被拒', () => {
    const conf = W14.map(([, , , c]) => c as number | null);
    conf[0] = null; // 只让第 0 位（`(`）缺一个置信度
    const out = classifyCharsByGeometry(meas(), chars(), conf);
    expect(out.map((s) => s.index)).not.toContain(eqIndex);
  });

  it('⚠️ 对照：**全部**缺值时门无从计算，只能退回几何 —— `=` 会被判上标', () => {
    // 这不是缺陷，是「已知信息为零」时的必然结果；写出来是为了让
    // 「门生效」与「门没信息」两种情况在测试里**可区分**
    const out = classifyCharsByGeometry(
      meas(),
      chars(),
      W14.map(() => null),
    );
    expect(out.map((s) => s.index)).toContain(eqIndex);
  });
});
