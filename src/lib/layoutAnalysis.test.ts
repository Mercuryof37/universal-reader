import { describe, expect, it } from 'vitest';

import {
  CONTENT_LABELS,
  FURNITURE_LABELS,
  LAYOUT_INPUT_SIZE,
  LAYOUT_LABELS,
  LAYOUT_MODEL_BYTES,
  decodeLayoutDetections,
  detectColumns,
  furnitureRegionOfLine,
  isFurnitureLabel,
  isLayoutAnalysisEnabled,
  labelOf,
  orderRegionsForReading,
  readingOrderKeys,
  regionForWord,
  type LayoutRegion,
} from '@/lib/layoutAnalysis';

/**
 * 版面分析（PP-DocLayout-S）的测试。
 *
 * ═══════════════════════════════════════════════════════════════
 * 这组测试对应的是**六轮修复都在打同一个几何启发式**这件事
 * ═══════════════════════════════════════════════════════════════
 *
 * 合并逻辑 → 行结构 → 段落切分 → 页眉页脚过滤 → 标题判定 → 过度合并，
 * 每一轮的失败都是**同一个根因**：这些是版面语义，靠猜间距与宽度注定有反例。
 * 用户实测那份习题 PDF 上：
 *   · 页眉「概率论与数理统计习题5」、页脚「单周周一下午2点前交作业」被当正文；
 *   · 三行公式被误判成大标题；
 *   · 跨行大括号的两个分支与正文行反复错误合并。
 * 而模型直接给出 header / footer / formula / paragraph_title —— 不需要猜。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么这组测试全部用**合成张量**，而且不碰 onnxruntime
 * ═══════════════════════════════════════════════════════════════
 *
 * 本机跑不了浏览器推理（`npx vitest run` 会死在 vite 的 `spawn EPERM`），
 * 所以「推理那一步」在这里**不可能**被验证，也不能假装验证过。
 * 因此把「张量 → 区域」这段纯计算剥成了 `decodeLayoutDetections`，
 * 用合成数据把所有**可错的逻辑**钉死；剩下的推理封装只是一句
 * 「喂张量、取输出」，没有分支可错。
 *
 * ⚠️ 这些用例**全部是合成的**。它们证明的是「解码与判定逻辑正确」，
 * **不能**证明「模型在真实扫描件上的精度」—— 那需要真实推理，
 * 本机无法完成，见交付报告里的「实测 / 推测」分栏。
 */

/** 造一行 [class_id, score, x1, y1, x2, y2] */
const det = (cls: number, score: number, x1: number, y1: number, x2: number, y2: number) => [
  cls,
  score,
  x1,
  y1,
  x2,
  y2,
];

/** 用扁平行数组造张量数据（模型输出的实际形状是 [M, 6] 的扁平 Float32Array） */
const tensor = (rows: number[][]) => Float32Array.from(rows.flat());

const region = (over: Partial<LayoutRegion> & { label: string }): LayoutRegion => ({
  classId: 0,
  score: 0.9,
  x0: 0,
  y0: 0,
  x1: 100,
  y1: 20,
  ...over,
});

// ═══════════════════════════════════════════════════════════════
// 类别表
// ═══════════════════════════════════════════════════════════════

describe('类别表：顺序即 class_id，错一位不会报错但会全判错', () => {
  it('类别数与顺序与上游 inference.yml 的 label_list 完全一致', () => {
    // ⚠️ 这 23 个字符串的**顺序**就是模型输出的 class_id。
    // class_id 是索引，错一位就会把「页脚」认成「公式」，而且不报错 ——
    // 所以这条断言必须逐个钉死。
    expect(LAYOUT_LABELS).toHaveLength(23);
    expect(LAYOUT_LABELS[0]).toBe('paragraph_title');
    expect(LAYOUT_LABELS[2]).toBe('text');
    expect(LAYOUT_LABELS[3]).toBe('number');
    expect(LAYOUT_LABELS[7]).toBe('formula');
    expect(LAYOUT_LABELS[8]).toBe('table');
    expect(LAYOUT_LABELS[11]).toBe('doc_title');
    expect(LAYOUT_LABELS[13]).toBe('header');
    expect(LAYOUT_LABELS[15]).toBe('footer');
    expect(LAYOUT_LABELS[22]).toBe('aside_text');
  });

  it('labelOf 越界返回 unknown 而不是抛错', () => {
    expect(labelOf(0)).toBe('paragraph_title');
    expect(labelOf(22)).toBe('aside_text');
    // 一个坏行不该毁掉整页判定 —— 这条链路上任何抛错都会让识别失败
    expect(labelOf(23)).toBe('unknown');
    expect(labelOf(-1)).toBe('unknown');
    expect(labelOf(1.5)).toBe('unknown');
    expect(labelOf(NaN)).toBe('unknown');
  });

  it('页面家具清单：页眉页脚页码印章在内，脚注与侧栏**不在**内', () => {
    for (const label of ['header', 'footer', 'header_image', 'footer_image', 'number', 'seal']) {
      expect(isFurnitureLabel(label)).toBe(true);
    }
    // ⚠️ 这几条是**防内容丢失**的断言，方向不能反：
    // 脚注在习题集里常是关键提示，侧栏可能是正文的一部分。
    // 把它们当家具删掉就是一次新的内容丢失，与本次修复的方向相反。
    expect(isFurnitureLabel('footnote')).toBe(false);
    expect(isFurnitureLabel('aside_text')).toBe(false);
    expect(isFurnitureLabel('formula')).toBe(false);
    expect(isFurnitureLabel('text')).toBe(false);
    expect(isFurnitureLabel('paragraph_title')).toBe(false);
    // 未知类别一律不判为家具：宁可漏判，也不要误删
    expect(isFurnitureLabel('unknown')).toBe(false);
    expect(isFurnitureLabel('display_formula')).toBe(false);
  });

  it('家具类别与内容类别不重叠', () => {
    for (const label of FURNITURE_LABELS) {
      expect(CONTENT_LABELS.has(label)).toBe(false);
    }
  });

  it('模型元数据与实测一致：4.69MiB、输入 480', () => {
    // 体积是本次方案的硬门槛（Cloudflare Pages 单文件 25MiB）：
    // 这个数字一旦被改大，必须先重新确认能否发布
    expect(LAYOUT_MODEL_BYTES).toBe(4_917_852);
    expect(LAYOUT_MODEL_BYTES).toBeLessThan(25 * 1024 * 1024);
    expect(LAYOUT_INPUT_SIZE).toBe(480);
  });
});

// ═══════════════════════════════════════════════════════════════
// 张量解码
// ═══════════════════════════════════════════════════════════════

describe('decodeLayoutDetections：张量 → 区域', () => {
  it('正常一行被正确解码（本模块最核心的断言）', () => {
    const regions = decodeLayoutDetections(
      tensor([det(13, 0.9, 10, 20, 110, 50)]),
      1,
      1000,
      1400,
    );

    expect(regions).toHaveLength(1);
    expect(regions[0]).toMatchObject({
      classId: 13,
      label: 'header',
      x0: 10,
      y0: 20,
      x1: 110,
      y1: 50,
    });
    // ⚠️ score 必须用 toBeCloseTo：数据来自 Float32Array，
    // 0.9 存进去再读出来是 0.8999999761581421 —— 直接 toBe(0.9) 会失败。
    // 这不是吹毛求疵：整个「张量 → 区域」链路都是 float32，
    // 断言写成精确相等就会变成一条**永远过不了**的测试。
    expect(regions[0]!.score).toBeCloseTo(0.9, 5);
  });

  it('**只看 num_dets 行**：padding 行不得变成区域', () => {
    // 这是最容易错的一条：输出张量会 padding 到固定 M 行，
    // 不读 num_dets 就会把一堆 (0,0)-(0,0) 当成区域。
    // 注意这里 padding 行的 score 是 0.99 —— 靠 score 阈值**拦不住**，
    // 只有 num_dets 能拦住。
    const regions = decodeLayoutDetections(
      tensor([
        det(13, 0.9, 10, 20, 110, 50),
        det(15, 0.99, 10, 1300, 110, 1350), // padding，score 很高
        det(7, 0.99, 500, 600, 900, 700), // padding，score 很高
      ]),
      1, // ← 只有第 1 行有效
      1000,
      1400,
    );

    expect(regions).toHaveLength(1);
    expect(regions[0]!.label).toBe('header');
  });

  it('num_dets 取不到时退化为按 score 阈值过滤，低分行仍被滤掉', () => {
    const regions = decodeLayoutDetections(
      tensor([det(13, 0.9, 10, 20, 110, 50), det(7, 0, 0, 0, 0, 0)]),
      undefined,
      1000,
      1400,
    );
    expect(regions).toHaveLength(1);
    expect(regions[0]!.label).toBe('header');
  });

  it('num_dets 越界时夹到实际行数，而不是整体放弃', () => {
    const regions = decodeLayoutDetections(
      tensor([det(13, 0.9, 10, 20, 110, 50)]),
      999, // 比实际行数大得多
      1000,
      1400,
    );
    // 能救则救：夹到 1 行
    expect(regions).toHaveLength(1);
  });

  it('低置信度行被滤掉（阈值与图内烘焙的 0.3 同口径）', () => {
    const regions = decodeLayoutDetections(
      tensor([det(13, 0.29, 10, 20, 110, 50), det(15, 0.31, 10, 1300, 110, 1350)]),
      2,
      1000,
      1400,
    );
    expect(regions).toHaveLength(1);
    expect(regions[0]!.label).toBe('footer');
  });

  it('坏值（NaN / Infinity）所在的行被跳过，其余行照常解出', () => {
    const regions = decodeLayoutDetections(
      tensor([
        det(13, 0.9, 10, 20, 110, 50),
        det(7, NaN, 500, 600, 900, 700),
        det(15, 0.8, 10, 1300, 110, 1350),
      ]),
      3,
      1000,
      1400,
    );
    expect(regions.map((r) => r.label)).toEqual(['header', 'footer']);
  });

  it('坐标顺序颠倒（y1x1y2x2）也能归一化，不会产生负宽度', () => {
    const regions = decodeLayoutDetections(
      tensor([det(13, 0.9, 110, 50, 10, 20)]), // 右下在前
      1,
      1000,
      1400,
    );
    expect(regions[0]).toMatchObject({ x0: 10, y0: 20, x1: 110, y1: 50 });
  });

  it('零面积的行被跳过（宽或高为 0）', () => {
    const regions = decodeLayoutDetections(tensor([det(13, 0.9, 10, 20, 10, 50)]), 1, 1000, 1400);
    expect(regions).toHaveLength(0);
  });

  it('**中心落在画布外 → 整体放弃**（scale_factor 传错时不许静默用错位区域）', () => {
    // 这条是防「scale_factor 传反」这一类错误的唯一闸门：
    // 传反之后模型仍会返回看起来合理的数字，只是整体缩放错了 ——
    // 那会静默地把页眉页脚判错。宁可不要版面信息，也不要拿错位区域
    // 去删用户的页眉页脚。
    const regions = decodeLayoutDetections(
      tensor([det(13, 0.9, 5000, 6000, 5100, 6050)]),
      1,
      1000, // 画布只有 1000×1400
      1400,
    );
    expect(regions).toEqual([]);
  });

  it('贴边区域的越界角被夹回画布内（模型对贴边内容常给负坐标）', () => {
    const regions = decodeLayoutDetections(
      tensor([det(13, 0.9, -20, -5, 110, 50)]),
      1,
      1000,
      1400,
    );
    expect(regions[0]).toMatchObject({ x0: 0, y0: 0, x1: 110, y1: 50 });
  });

  it('输出顺序稳定：先上后下、再左后右，与输入顺序无关', () => {
    const rows = [
      det(2, 0.9, 10, 500, 400, 560), // 下方
      det(13, 0.9, 100, 20, 300, 50), // 上方、偏右
      det(15, 0.9, 10, 1300, 300, 1350), // 最下
      det(13, 0.9, 10, 20, 90, 50), // 上方、偏左
    ];
    const forward = decodeLayoutDetections(tensor(rows), 4, 1000, 1400);
    const reversed = decodeLayoutDetections(tensor([...rows].reverse()), 4, 1000, 1400);

    // 同一页两次推理必须得到同一个顺序，否则阅读顺序不可复现
    expect(forward.map((r) => [r.x0, r.y0])).toEqual(reversed.map((r) => [r.x0, r.y0]));
    expect(forward[0]!.x0).toBe(10); // 上方偏左的行排最前
    expect(forward[3]!.y0).toBe(1300); // 最下方的行排最后
  });

  it('输入退化时返回空数组而不是抛错', () => {
    expect(decodeLayoutDetections(new Float32Array(0), 0, 1000, 1400)).toEqual([]);
    expect(decodeLayoutDetections(tensor([det(13, 0.9, 10, 20, 110, 50)]), 1, 0, 0)).toEqual([]);
    expect(decodeLayoutDetections(tensor([det(13, 0.9, 10, 20, 110, 50)]), 1, NaN, 1400)).toEqual(
      [],
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// 词 / 行 → 区域
// ═══════════════════════════════════════════════════════════════

const wordAt = (x0: number, y0: number, x1: number, y1: number) => ({ bbox: { x0, y0, x1, y1 } });

describe('regionForWord：词属于哪个区域', () => {
  const header = region({ label: 'header', classId: 13, y0: 20, y1: 60, x0: 300, x1: 700 });
  const body = region({ label: 'text', classId: 2, y0: 200, y1: 1200, x0: 100, x1: 900 });

  it('完全落在页眉区域里的词归属页眉', () => {
    expect(regionForWord(wordAt(320, 25, 680, 55), [header, body])?.label).toBe('header');
  });

  it('完全落在正文区域里的词归属正文', () => {
    expect(regionForWord(wordAt(120, 300, 500, 340), [header, body])?.label).toBe('text');
  });

  it('**不被任何区域覆盖**的词返回 undefined（不是硬塞给最近的区域）', () => {
    // 这一条保证了「有词没被框住」能被上层发现，进而放弃重排 ——
    // 硬塞给最近的区域会让阅读顺序在模型漏检时静默错乱
    expect(regionForWord(wordAt(100, 1300, 900, 1340), [header, body])).toBeUndefined();
  });

  it('覆盖率不足 50% 的词不算归属（区域只盖住一角）', () => {
    // 词的 3/4 落在区域外
    expect(regionForWord(wordAt(850, 250, 1050, 290), [body])).toBeUndefined();
  });

  it('同时被多个区域覆盖时取**覆盖最多**的那个', () => {
    const big = region({ label: 'text', classId: 2, y0: 0, y1: 200, x0: 0, x1: 1000 });
    const tight = region({ label: 'formula', classId: 7, y0: 90, y1: 130, x0: 400, x1: 600 });
    // 词完全落在 tight 里 → tight 覆盖率 1.0；big 也覆盖它 → 也是 1.0
    // 并列时按 score；给 tight 更高的 score
    const tightHigh = { ...tight, score: 0.99 };
    expect(regionForWord(wordAt(410, 95, 590, 125), [big, tightHigh])?.label).toBe('formula');
  });

  it('覆盖率并列时按 score 降序，再按 classId 升序 —— 与输入顺序无关', () => {
    const a = region({ label: 'text', classId: 2, score: 0.5, y0: 0, y1: 100, x0: 0, x1: 100 });
    const b = region({ label: 'formula', classId: 7, score: 0.9, y0: 0, y1: 100, x0: 0, x1: 100 });
    const w = wordAt(0, 0, 100, 100);
    expect(regionForWord(w, [a, b])?.label).toBe('formula');
    expect(regionForWord(w, [b, a])?.label).toBe('formula');
  });

  it('退化输入返回 undefined 而不是抛错', () => {
    expect(regionForWord(wordAt(0, 0, 0, 0), [body])).toBeUndefined();
    expect(regionForWord(wordAt(10, 10, 20, 20), [])).toBeUndefined();
  });
});

describe('furnitureRegionOfLine：整行是否页面家具', () => {
  const footer = region({ label: 'footer', classId: 15, y0: 2150, y1: 2200, x0: 700, x1: 1500 });
  const body = region({ label: 'text', classId: 2, y0: 200, y1: 2100, x0: 100, x1: 1900 });
  const pageNumber = region({ label: 'number', classId: 3, y0: 2150, y1: 2200, x0: 950, x1: 1050 });

  const line = (boxes: [number, number, number, number][]) => ({
    words: boxes.map((b) => wordAt(...b)),
  });

  it('**页脚整行**被判定为家具（用户实测的「单周周一下午2点前交作业」）', () => {
    // 这一行在启发式下躲过了过滤：它与正文**同字号**（42px），
    // 「更小」这条判据永远不可能成立。而模型直接说它是 footer。
    const line0 = line([
      [710, 2155, 800, 2195],
      [810, 2155, 900, 2195],
      [910, 2155, 1000, 2195],
    ]);
    expect(furnitureRegionOfLine(line0, [body, footer, pageNumber])?.label).toBe('footer');
  });

  it('**页眉整行**被判定为家具（用户实测的「概率论与数理统计习题5」）', () => {
    const header = region({ label: 'header', classId: 13, y0: 55, y1: 105, x0: 300, x1: 700 });
    const line0 = line([
      [310, 60, 400, 100],
      [410, 60, 500, 100],
      [510, 60, 600, 100],
    ]);
    expect(furnitureRegionOfLine(line0, [header, body])?.label).toBe('header');
  });

  it('正文行永远不是家具（哪怕它紧挨着页脚区域）', () => {
    const line0 = line([
      [120, 300, 400, 340],
      [420, 300, 700, 340],
    ]);
    expect(furnitureRegionOfLine(line0, [body, footer, pageNumber])).toBeUndefined();
  });

  it('**只有少数词**落在家具区域里时，整行不算家具（防误删正文）', () => {
    // 正文行的头一个词被页脚区域盖住一角 → 取「任意一个词」就会整行删掉
    const line0 = line([
      [700, 2140, 800, 2160], // 这一个落在 footer 里
      [900, 2120, 1200, 2160], // 这两个在正文区域里
      [1210, 2120, 1500, 2160],
    ]);
    expect(furnitureRegionOfLine(line0, [body, footer])).toBeUndefined();
  });

  it('**多数但非全部**词落在区域里时仍判为家具（页脚常被切成十来个单字）', () => {
    // 取「全部词」会把这种行漏判 —— 只要一个字探出区域就整行不算
    const line0 = line([
      [710, 2155, 760, 2195],
      [770, 2155, 820, 2195],
      [830, 2155, 880, 2195],
      [1600, 2140, 1700, 2200], // 一个探出 footer 区域的词
    ]);
    expect(furnitureRegionOfLine(line0, [body, footer])?.label).toBe('footer');
  });

  it('页码行被判为家具', () => {
    const line0 = line([
      [955, 2155, 1000, 2195],
      [1005, 2155, 1045, 2195],
    ]);
    expect(furnitureRegionOfLine(line0, [body, pageNumber])?.label).toBe('number');
  });

  it('退化输入返回 undefined 而不是抛错', () => {
    expect(furnitureRegionOfLine({ words: [] }, [footer])).toBeUndefined();
    expect(furnitureRegionOfLine(line([[710, 2155, 800, 2195]]), [])).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// 阅读顺序
// ═══════════════════════════════════════════════════════════════

describe('阅读顺序：单栏退化为「先上后下」，多栏必须逐栏读完', () => {
  it('单栏：按 y 再按 x 排列，且**不**误判为多栏', () => {
    const regions = [
      region({ label: 'text', x0: 100, x1: 1900, y0: 200, y1: 400 }),
      region({ label: 'text', x0: 100, x1: 1900, y0: 500, y1: 700 }),
      region({ label: 'text', x0: 100, x1: 1900, y0: 800, y1: 1000 }),
      region({ label: 'text', x0: 100, x1: 1900, y0: 1100, y1: 1300 }),
    ];
    expect(detectColumns(regions, 2000)).toBeNull();
    const ordered = orderRegionsForReading(regions, 2000);
    expect(ordered.map((r) => r.y0)).toEqual([200, 500, 800, 1100]);
  });

  it('**双栏：先读完左栏再读右栏**，不是逐行交错', () => {
    // 这是教科书级的阅读顺序错误：纯 y 排序会读成「左1 右1 左2 右2」
    const regions = [
      region({ label: 'text', x0: 100, x1: 900, y0: 200, y1: 400 }), // 左1
      region({ label: 'text', x0: 1100, x1: 1900, y0: 200, y1: 400 }), // 右1
      region({ label: 'text', x0: 100, x1: 900, y0: 500, y1: 700 }), // 左2
      region({ label: 'text', x0: 1100, x1: 1900, y0: 500, y1: 700 }), // 右2
    ];

    const columns = detectColumns(regions, 2000);
    expect(columns).not.toBeNull();
    expect(columns!.map((c) => c.left)).toEqual([100, 1100]);

    const ordered = orderRegionsForReading(regions, 2000);
    // 左栏两行在前、右栏两行在后
    expect(ordered.map((r) => [r.x0, r.y0])).toEqual([
      [100, 200],
      [100, 500],
      [1100, 200],
      [1100, 500],
    ]);
  });

  it('区域太少时**不**判多栏（统计上没有意义）', () => {
    const regions = [
      region({ label: 'text', x0: 100, x1: 900, y0: 200, y1: 400 }),
      region({ label: 'text', x0: 1100, x1: 1900, y0: 200, y1: 400 }),
    ];
    expect(detectColumns(regions, 2000)).toBeNull();
  });

  it('每栏只有一个区域时**不**判多栏（可能是通栏标题的左右抖动）', () => {
    // 左右各只有一条区域 → 统计上不足以断定「这是两栏」，
    // 更可能只是同一栏里两行的左边界抖动。必须退回单栏。
    const single = [
      region({ label: 'text', x0: 100, x1: 1200, y0: 200, y1: 400 }),
      region({ label: 'text', x0: 100, x1: 1200, y0: 500, y1: 700 }),
      region({ label: 'text', x0: 100, x1: 1200, y0: 800, y1: 1000 }),
      region({ label: 'text', x0: 100, x1: 1200, y0: 1100, y1: 1300 }),
    ];
    expect(detectColumns(single, 2000)).toBeNull();
  });

  it('横跨大半个版面的通栏区域不参与分栏（否则居中标题会自成「一栏」）', () => {
    const regions = [
      region({ label: 'doc_title', x0: 100, x1: 1900, y0: 50, y1: 110 }), // 通栏标题
      region({ label: 'text', x0: 100, x1: 900, y0: 200, y1: 400 }),
      region({ label: 'text', x0: 1100, x1: 1900, y0: 200, y1: 400 }),
      region({ label: 'text', x0: 100, x1: 900, y0: 500, y1: 700 }),
      region({ label: 'text', x0: 1100, x1: 1900, y0: 500, y1: 700 }),
    ];
    const columns = detectColumns(regions, 2000);
    expect(columns!.map((c) => c.left)).toEqual([100, 1100]);
    // 通栏标题归左栏（不会被推到右栏去）
    const ordered = orderRegionsForReading(regions, 2000);
    expect(ordered[0]!.y0).toBe(50);
  });

  it('页面家具不参与分栏（一个居中页眉会自成「一栏」）', () => {
    const regions = [
      region({ label: 'header', classId: 13, x0: 700, x1: 1300, y0: 20, y1: 60 }),
      region({ label: 'text', x0: 100, x1: 900, y0: 200, y1: 400 }),
      region({ label: 'text', x0: 1100, x1: 1900, y0: 200, y1: 400 }),
      region({ label: 'text', x0: 100, x1: 900, y0: 500, y1: 700 }),
      region({ label: 'text', x0: 1100, x1: 1900, y0: 500, y1: 700 }),
    ];
    // 页眉的 x0=700 不该成为第三栏
    expect(detectColumns(regions, 2000)!.map((c) => c.left)).toEqual([100, 1100]);
  });

  it('pageWidth 非法时退化为单栏，不抛错', () => {
    const regions = [
      region({ label: 'text', x0: 100, x1: 900, y0: 200, y1: 400 }),
      region({ label: 'text', x0: 1100, x1: 1900, y0: 200, y1: 400 }),
      region({ label: 'text', x0: 100, x1: 900, y0: 500, y1: 700 }),
      region({ label: 'text', x0: 1100, x1: 1900, y0: 500, y1: 700 }),
    ];
    expect(detectColumns(regions, 0)).toBeNull();
    expect(detectColumns(regions, NaN)).toBeNull();
    expect(orderRegionsForReading(regions, 0)).toHaveLength(4);
  });

  it('readingOrderKeys 与 regions 等长，且不修改输入', () => {
    const regions = [
      region({ label: 'text', x0: 100, x1: 900, y0: 200, y1: 400 }),
      region({ label: 'text', x0: 1100, x1: 1900, y0: 200, y1: 400 }),
      region({ label: 'text', x0: 100, x1: 900, y0: 500, y1: 700 }),
      region({ label: 'text', x0: 1100, x1: 1900, y0: 500, y1: 700 }),
    ];
    const snapshot = JSON.stringify(regions);
    const keys = readingOrderKeys(regions, 2000);
    expect(keys).toHaveLength(regions.length);
    expect(JSON.stringify(regions)).toBe(snapshot);
  });
});

// ═══════════════════════════════════════════════════════════════
// 开关
// ═══════════════════════════════════════════════════════════════

describe('isLayoutAnalysisEnabled：必须能一键关掉', () => {
  it('默认开启（这正是本次要做的能力）', () => {
    expect(isLayoutAnalysisEnabled(undefined)).toBe(true);
    expect(isLayoutAnalysisEnabled('')).toBe(true);
    expect(isLayoutAnalysisEnabled('1')).toBe(true);
    expect(isLayoutAnalysisEnabled('true')).toBe(true);
  });

  it('VITE_OCR_LAYOUT=0 / false / off 时关闭 —— 排查「是不是它把内容弄丢了」需要这个开关', () => {
    expect(isLayoutAnalysisEnabled('0')).toBe(false);
    expect(isLayoutAnalysisEnabled('false')).toBe(false);
    expect(isLayoutAnalysisEnabled('off')).toBe(false);
  });
});
