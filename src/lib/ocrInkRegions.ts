/**
 * 「有墨迹但没有任何识别词覆盖」的区域检测 —— 找出**识别器悄悄漏掉的内容块**。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么必须有这一层：现有的公式候选检测对「整块漏识别」完全无效
 * ═══════════════════════════════════════════════════════════════
 *
 * 用户在扫描版数学题 PDF 上实测到：页面里
 *
 *     24. 设随机变量(X,Y)的概率密度为
 *                 ⎧ 1/2 (x+y) e^{-(x+y)},  x>0, y>0
 *         f(x,y) = ⎨
 *                 ⎩ 0,                      其他
 *
 * 应用输出里主分支整块消失，只剩 `0,  其他`。
 *
 * 已核对 `ocrPostProcess.ts` 的块组装（逐行字符串拼接，不丢字），
 * 所以内容不是后处理丢的 —— **极可能是识别器对那一块返回了空串**：
 * 跨行大括号、堆叠分数、指数上标这些构件的检测框形状怪异。
 * 而 `ocrEngine.ts` 对空文本是 `if (!text) continue` 直接跳过，
 * 于是那块区域在 `words` 里**没有任何痕迹**。
 *
 * 关键的连锁反应在这里：`detectFormulaRegions()` 是靠**已识别出的词**
 * 聚类找候选的（低置信度、数学符号、紧邻性）。公式整个没识别出来
 * → 一个词都没有 → 那个区域永远进不了候选 → 公式增强救不了它。
 *
 * 因此需要一个**不依赖识别结果**的判据：**图像上有没有墨迹**。
 * 把页面按网格采样，标出「有墨迹、却没有词覆盖」的格子，
 * 合并成连通区域 —— 那就是疑似漏识别的内容块（公式 / 图 / 表）。
 *
 * ⚠️ 隐私：本模块**只产出候选区域坐标，不发任何网络请求**。
 * 是否把这些区域送去 SimpleTex 由 `ocrEngine` 的
 * `settingsStore.formulaOcrEnabled`（默认关闭）决定。
 *
 * ⚠️ 诚实说明：这里的判据是**启发式**。它能指出「这块有东西没被认出来」，
 * 但**不能**区分那是公式、插图还是表格 —— 区域类型不参与判定，
 * 只作为候选交出去。
 */

/** 疑似「有墨迹但没被识别」的区域（坐标与传入的 ImageData 同一坐标系） */
export type { MissedInkRegion } from '@/lib/ocrTypes';
import type { MissedInkRegion, OcrWord } from '@/lib/ocrTypes';

export interface InkRegionOptions {
  /** 深色判定阈值：亮度低于它算墨迹。与空白页判定同一口径 */
  inkThreshold?: number;
  /** 采样网格边长（像素）。越小定位越细，但噪声格子也越多 */
  gridSize?: number;
  /**
   * 一个格子算「墨迹格」所需的最低墨迹比例。
   *
   * 定成 0.02 而不是「有 1 个深色像素就算」：扫描件的纸张噪点、
   * JPEG 振铃会在格子边缘留下零星深色像素，不设比例会让整页都是墨迹格。
   */
  cellInkRatio?: number;
  /** 一个区域至少要有多少个墨迹格，低于此不算区域（滤掉零星噪点） */
  minCells?: number;
  /** 区域整体墨迹比例下限，低于此不算区域 */
  minInkRatio?: number;
}

const DEFAULT_INK_THRESHOLD = 250;
const DEFAULT_GRID_SIZE = 16;
const DEFAULT_CELL_INK_RATIO = 0.02;
const DEFAULT_MIN_CELLS = 3;
const DEFAULT_MIN_INK_RATIO = 0.03;

/**
 * 找出「有墨迹但没有任何词覆盖」的连通区域。
 *
 * 算法三步，都是对图像本身的操作，**完全不看识别出了什么**：
 *  1. 按 `gridSize` 把图切成格子，统计每格深色像素比例，标出墨迹格；
 *  2. 标出被词包围盒覆盖的格子（词框**部分压到**格子也算覆盖）；
 *  3. 把既未被覆盖、又相连（八邻域）的墨迹格并成区域，按面积与墨迹比例过滤。
 *
 * 返回顺序稳定（先按行、再按列），便于测试与诊断输出。
 *
 * 对输入宽容：尺寸为 0、数据长度不匹配、参数非法时返回空数组而不是抛错 ——
 * 这条链路跑在用户的长任务里，一个诊断功能不该把整次扫描带崩。
 */
export function detectMissedInkRegions(
  image: ImageData,
  words: { bbox: { x0: number; y0: number; x1: number; y1: number } }[],
  options: InkRegionOptions = {},
): MissedInkRegion[] {
  const width = image?.width ?? 0;
  const height = image?.height ?? 0;
  const data = image?.data;
  if (!width || !height || !data || data.length < width * height * 4) return [];

  const grid = Math.max(2, Math.floor(options.gridSize ?? DEFAULT_GRID_SIZE));
  const inkThreshold = options.inkThreshold ?? DEFAULT_INK_THRESHOLD;
  const cellInkRatio = options.cellInkRatio ?? DEFAULT_CELL_INK_RATIO;
  const minCells = Math.max(1, Math.floor(options.minCells ?? DEFAULT_MIN_CELLS));
  const minInkRatio = options.minInkRatio ?? DEFAULT_MIN_INK_RATIO;

  const cols = Math.ceil(width / grid);
  const rows = Math.ceil(height / grid);
  const cellCount = cols * rows;
  // 每格的深色像素计数，以及每格的总像素数（最后一列/行可能不满）
  const darkCounts = new Int32Array(cellCount);
  const cellPixels = new Int32Array(cellCount);

  for (let y = 0; y < height; y++) {
    const rowOffset = Math.floor(y / grid) * cols;
    for (let x = 0; x < width; x++) {
      const idx = rowOffset + Math.floor(x / grid);
      cellPixels[idx] = (cellPixels[idx] ?? 0) + 1;
      const p = (y * width + x) * 4;
      const luma = 0.299 * (data[p] ?? 0) + 0.587 * (data[p + 1] ?? 0) + 0.114 * (data[p + 2] ?? 0);
      if (luma < inkThreshold) darkCounts[idx] = (darkCounts[idx] ?? 0) + 1;
    }
  }

  const isInk = (idx: number) => {
    const pixels = cellPixels[idx] ?? 0;
    if (!pixels) return false;
    return (darkCounts[idx] ?? 0) / pixels >= cellInkRatio;
  };

  // ── 被词覆盖的格子 ────────────────────────────────────────────
  // 判据刻意宽松（bbox 与格子只要有重叠就算覆盖）：
  // 漏报一个「已识别区域」的后果是**多发一次网络请求**（公式增强开启时），
  // 而误报的后果是候选区域被白算一遍。宽松更安全。
  const covered = new Uint8Array(cellCount);
  for (const word of words) {
    const b = word?.bbox;
    if (!b) continue;
    const c0 = Math.max(0, Math.floor(b.x0 / grid));
    const c1 = Math.min(cols - 1, Math.floor(b.x1 / grid));
    const r0 = Math.max(0, Math.floor(b.y0 / grid));
    const r1 = Math.min(rows - 1, Math.floor(b.y1 / grid));
    if (!Number.isFinite(c0) || !Number.isFinite(c1) || !Number.isFinite(r0) || !Number.isFinite(r1)) {
      continue;
    }
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) covered[r * cols + c] = 1;
    }
  }

  // ── 八邻域并查集，把漏掉的墨迹格并成区域 ──────────────────────
  const parent = new Int32Array(cellCount);
  for (let i = 0; i < cellCount; i++) parent[i] = i;

  const find = (i: number): number => {
    let root = i;
    while ((parent[root] ?? root) !== root) root = parent[root] ?? root;
    // 路径压缩，避免细长区域退化成链表
    let cur = i;
    while ((parent[cur] ?? cur) !== root) {
      const next = parent[cur] ?? cur;
      parent[cur] = root;
      cur = next;
    }
    return root;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      if (covered[idx] || !isInk(idx)) continue;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (!dr && !dc) continue;
          const nr = r + dr;
          const nc = c + dc;
          if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
          const nIdx = nr * cols + nc;
          if (covered[nIdx] || !isInk(nIdx)) continue;
          union(idx, nIdx);
        }
      }
    }
  }

  const components = new Map<
    number,
    { minR: number; maxR: number; minC: number; maxC: number; cells: number; dark: number }
  >();

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      if (covered[idx] || !isInk(idx)) continue;
      const root = find(idx);
      const comp = components.get(root);
      if (comp) {
        comp.minR = Math.min(comp.minR, r);
        comp.maxR = Math.max(comp.maxR, r);
        comp.minC = Math.min(comp.minC, c);
        comp.maxC = Math.max(comp.maxC, c);
        comp.cells++;
        comp.dark += darkCounts[idx] ?? 0;
      } else {
        components.set(root, {
          minR: r,
          maxR: r,
          minC: c,
          maxC: c,
          cells: 1,
          dark: darkCounts[idx] ?? 0,
        });
      }
    }
  }

  const regions: (MissedInkRegion & { cells: number })[] = [];

  for (const comp of components.values()) {
    if (comp.cells < minCells) continue;

    const x0 = comp.minC * grid;
    const y0 = comp.minR * grid;
    // 用「格子右下角」与图像边界取小，保证区域不越出图像
    const x1 = Math.min(width, (comp.maxC + 1) * grid);
    const y1 = Math.min(height, (comp.maxR + 1) * grid);
    const area = (x1 - x0) * (y1 - y0);
    if (area <= 0) continue;

    const inkRatio = comp.dark / area;
    if (inkRatio < minInkRatio) continue;

    regions.push({ x0, y0, x1, y1, inkRatio, cells: comp.cells });
  }

  // 稳定排序：先上后下、先左后右，便于诊断输出与测试断言
  regions.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);

  return regions.map(({ x0, y0, x1, y1, inkRatio }) => ({ x0, y0, x1, y1, inkRatio }));
}

/**
 * 从画布（或 ImageData）检测「有墨迹但没被识别」的区域，坐标还原到原图。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么不直接在整页画布上 getImageData
 * ═══════════════════════════════════════════════════════════════
 *
 * 一页 A4 在 200 DPI 下是约 1654×2339 = 3.9 MP，
 * 一次 `getImageData` 的 RGBA 数组就是约 15MB，而且它是一次性分配、
 * 用完才释放 —— 这条链路（识别 → 检测 → 公式增强）本来就跑在
 * 内存已经很紧张的环境里（见 `ocrTypes.ts` 里关于画布内存的那些注释）。
 *
 * 缩到宽度上限 1000 后数组降到约 5MB，而**判定结果几乎不变**：
 * 我们找的是「整块有墨迹、整块没被覆盖」的区域，最小区域门槛是
 * 3 个 16px 格子 ≈ 48px —— 缩放到 1000 宽时仍有约 30px，
 * 远大于任何笔画宽度。检测出的坐标按缩放比还原，误差在 1-2 px。
 *
 * 传入 `ImageData` 时它本来就是一块已经解好的位图，无法再"缩小画布"，
 * 只能直接检测（调用方若是从画布取的 ImageData，等于放弃了上面那点内存优化，
 * 但结果与从画布走一次**完全不同**：那条路径会先缩小再检测）。
 *
 * 拿不到 2D 上下文 / 没有 document 时返回空数组：这是个诊断与候选功能，
 * 失败不该影响正常识别结果。
 */
export function detectMissedInkRegionsFromCanvas(
  source: ImageData | HTMLCanvasElement | OffscreenCanvas,
  words: { bbox: { x0: number; y0: number; x1: number; y1: number } }[],
  options: InkRegionOptions & { maxProbeWidth?: number } = {},
): MissedInkRegion[] {
  // ImageData 没有"缩放"这一步，直接按原坐标检测
  if (typeof ImageData !== 'undefined' && source instanceof ImageData) {
    return detectMissedInkRegions(source, words, options);
  }

  if (typeof document === 'undefined') return [];
  const canvas = source as HTMLCanvasElement | OffscreenCanvas;
  const width = canvas?.width ?? 0;
  const height = canvas?.height ?? 0;
  if (!width || !height) return [];

  const maxProbeWidth = Math.max(64, Math.floor(options.maxProbeWidth ?? 1000));
  const scale = Math.min(1, maxProbeWidth / width);
  const probeW = Math.max(1, Math.round(width * scale));
  const probeH = Math.max(1, Math.round(height * scale));

  try {
    const probe = document.createElement('canvas');
    probe.width = probeW;
    probe.height = probeH;
    const ctx = probe.getContext('2d', { willReadFrequently: true });
    if (!ctx) return [];

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, probeW, probeH);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas as CanvasImageSource, 0, 0, probeW, probeH);

    const image = ctx.getImageData(0, 0, probeW, probeH);

    // 词框换算到探测图坐标系；格子尺寸也按同一比例缩小，
    // 这样「一个格子代表多少原图像素」保持一致，区域门槛的物理含义不变。
    const gridSize = Math.max(2, Math.round((options.gridSize ?? DEFAULT_GRID_SIZE) * scale));
    const scaledWords = words.map((w) => ({
      bbox: {
        x0: w.bbox.x0 * scale,
        y0: w.bbox.y0 * scale,
        x1: w.bbox.x1 * scale,
        y1: w.bbox.y1 * scale,
      },
    }));

    const regions = detectMissedInkRegions(image, scaledWords, { ...options, gridSize });

    // 还原到原图坐标系并向外取整，避免因缩小采样把区域裁掉一条边
    return regions.map((r) => ({
      x0: Math.floor(r.x0 / scale),
      y0: Math.floor(r.y0 / scale),
      x1: Math.min(width, Math.ceil(r.x1 / scale)),
      y1: Math.min(height, Math.ceil(r.y1 / scale)),
      inkRatio: r.inkRatio,
    }));
  } catch (err) {
    console.warn('[ocrInkRegions] 探测「有墨迹未识别」区域失败（不影响识别结果）：', err);
    return [];
  }
}

/**
 * 两个区域的重叠面积占**较小者**的比例。
 *
 * 用于把「图像候选区域」与「词聚类候选区域」去重：
 * 同一块内容被两条路径同时发现时，只需送去识别一次。
 */
export function overlapRatio(
  a: { x0: number; y0: number; x1: number; y1: number },
  b: { x0: number; y0: number; x1: number; y1: number },
): number {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  if (w <= 0 || h <= 0) return 0;

  const smaller = Math.min((a.x1 - a.x0) * (a.y1 - a.y0), (b.x1 - b.x0) * (b.y1 - b.y0));
  if (smaller <= 0) return 0;
  return (w * h) / smaller;
}

/**
 * 「局部重试」结果的准入：坐标换算回页面坐标系 + 去重。纯函数。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么重试结果不能直接追加
 * ═══════════════════════════════════════════════════════════════
 *
 * 重试是在**裁剪片段**上跑的（裁剪带一圈 padding，给公式留上下文），
 * 于是有两件事必须在准入时处理：
 *
 *  1. **坐标换算**：识别器量到的框是「放大后的裁剪图」坐标。
 *     不换算就追加，救回的文字会出现在错误的位置 —— 比没有更糟；
 *  2. **邻居文字**：padding 会把旁边的正文一起裁进来、一起被识别出来。
 *     与既有词重叠的一律丢弃，否则重试会把内容**复制一遍**
 *     （重复内容属于「更糟」的那一类错误，见文件顶部对空串丢失的说明）。
 *
 * @param items    重试返回的原始结果（坐标在裁剪图上，0-1 置信度）
 * @param frame    裁剪帧：在页面上的原点与放大系数
 * @param existing 已识别出的词（坐标在页面坐标系）
 */
export function admitRetryWords(
  items: readonly {
    text: string;
    confidence: number;
    box: { x: number; y: number; width: number; height: number };
  }[],
  frame: { originX: number; originY: number; scale: number },
  existing: readonly { bbox: { x0: number; y0: number; x1: number; y1: number } }[],
  overlapDrop = 0.5,
): OcrWord[] {
  const scale = frame.scale > 0 ? frame.scale : 1;
  const admitted: OcrWord[] = [];

  for (const item of items) {
    const text = item.text.trim();
    if (!text) continue;

    const x0 = frame.originX + item.box.x / scale;
    const y0 = frame.originY + item.box.y / scale;
    const bbox = {
      x0,
      y0,
      x1: x0 + item.box.width / scale,
      y1: y0 + item.box.height / scale,
    };
    if (!(bbox.x1 > bbox.x0) || !(bbox.y1 > bbox.y0)) continue;

    if (existing.some((w) => overlapRatio(w.bbox, bbox) >= overlapDrop)) continue;
    if (admitted.some((w) => overlapRatio(w.bbox, bbox) >= overlapDrop)) continue;

    admitted.push({
      text,
      // 与主识别路径同一口径：PaddleOCR 给 0-1，`OcrWord.confidence` 存 0-100
      confidence: Math.round(item.confidence * 100),
      bbox,
      fontSize: item.box.height / scale,
    });
  }

  return admitted;
}

/** 裁剪四周的留白比例（漏识别区域坐标来自 16px 网格，边缘是量化过的） */
const RETRY_CROP_PAD_RATIO = 0.08;

/**
 * 「漏识别区域 → 放大裁剪」的几何计划（纯函数，不分配画布）。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么这段算术单独放一个函数
 * ═══════════════════════════════════════════════════════════════
 *
 * 因为**像素预算必须在分配画布之前算出来**：预算要看放大后的面积，
 * 而面积又取决于像素上限对放大倍数的压制。这段算术只留这一处实现，
 * 规划与渲染两步（`ocrEngine` 里的 `renderRetryCrop`）就不会各算各的、
 * 慢慢漂移；放在本模块里也意味着它可以**在没有 DOM 的环境里单测**。
 *
 * 坐标契约：`px/py` 是裁剪矩形在**原图坐标系**里的左上角，
 * `scale` 是放大倍数（≥1）。识别结果映射回原图是
 * `原图 = px + 裁剪坐标 / scale` —— 与 `admitRetryWords` 的 frame 参数一致。
 *
 * 边界处理：区域的一部分越出页面时按页面裁掉（`pw/ph` 只取剩下的部分），
 * 而不是把画布画到页面外。
 */
export interface RetryCropPlan {
  px: number;
  py: number;
  pw: number;
  ph: number;
  scale: number;
  targetW: number;
  targetH: number;
}

export function planRetryCrop(
  sourceWidth: number,
  sourceHeight: number,
  bbox: { x0: number; y0: number; x1: number; y1: number },
  upscale: number,
  maxPixels: number,
  padRatio = RETRY_CROP_PAD_RATIO,
): RetryCropPlan | null {
  if (!(sourceWidth > 0) || !(sourceHeight > 0)) return null;

  const x = Math.max(0, Math.floor(bbox.x0));
  const y = Math.max(0, Math.floor(bbox.y0));
  const w = Math.min(Math.ceil(bbox.x1 - bbox.x0), sourceWidth - x);
  const h = Math.min(Math.ceil(bbox.y1 - bbox.y0), sourceHeight - y);
  if (w < 1 || h < 1) return null;

  // 四周留白：检测器在紧贴笔画的位置切框时容易把大括号的钩切掉。
  // 留白会把旁边的正文带进裁剪（重复词由 `admitRetryWords` 挡掉）。
  const pad = Math.max(2, Math.round(Math.max(w, h) * padRatio));
  const px = Math.max(0, x - pad);
  const py = Math.max(0, y - pad);
  const pw = Math.min(w + pad * 2, sourceWidth - px);
  const ph = Math.min(h + pad * 2, sourceHeight - py);
  if (pw < 1 || ph < 1) return null;

  // 放大受像素上限的压制；**永远不缩小** —— 原尺度虽然是已经失败过的，
  // 但不会更差，而缩小只会让失败的原因（笔画粘连）更严重。
  // 上限不合法（≤0 或非有限值）时按「不放大」处理。
  const fit = maxPixels > 0 && Number.isFinite(maxPixels) ? Math.sqrt(maxPixels / (pw * ph)) : 1;
  const scale = Math.max(1, Math.min(upscale, fit));

  return {
    px,
    py,
    pw,
    ph,
    scale,
    targetW: Math.max(1, Math.round(pw * scale)),
    targetH: Math.max(1, Math.round(ph * scale)),
  };
}
