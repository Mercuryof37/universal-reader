/**
 * 版面分析（document layout analysis）—— 用**版面模型**替代几何启发式。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么必须换掉几何启发式
 * ═══════════════════════════════════════════════════════════════
 *
 * 本项目此前用**几何启发式**决定这些语义问题，连续六轮修复都在打同一个
 * 边界情况：合并逻辑 → 行结构 → 段落切分 → 页眉页脚过滤 → 标题判定 → 过度合并。
 * 这些本该由版面分析直接给出答案，靠猜间距与宽度注定一直有反例：
 *
 *   · 页眉「概率论与数理统计习题5」与页脚「单周周一下午2点前交作业」
 *     被当成正文 —— 启发式靠「字号更小」「宽度不到版心 85%」「与相邻行
 *     有 1.4 倍字号的空隙」三条猜（见 `ocrPostProcess.filterHeaderFooter`）；
 *   · 三行公式被误判成大标题 —— 启发式靠「字号 > 中位数 1.3 倍 + 文本像标题」猜；
 *   · 跨行大括号的两个分支与正文行反复错误合并 —— 纯几何无从知道
 *     「这三行是同一个公式区域」。
 *
 * 而版面模型的输出**就是**这些区域及其类别：header / footer / formula /
 * paragraph_title / text / table / figure_title …。语义不需要再猜。
 *
 * ═══════════════════════════════════════════════════════════════
 * 模型选型：为什么是 PP-DocLayout-S 而不是 PP-DocLayoutV2/V3
 * ═══════════════════════════════════════════════════════════════
 *
 * 本方案有**硬性体积门槛**：本站是零后端静态站点，部署在 Cloudflare Pages，
 * 而官方文档写明单个静态资源上限 **25 MiB**
 * （https://developers.cloudflare.com/pages/platform/limits/ ，原文
 *  "The maximum file size for a single Cloudflare Pages site asset is 25 MiB."）。
 * 现有 OCR 三件套正是按这条限制拆成三个文件的
 * （9.52 + 20.30 + 0.07 = 29.90MB）。
 *
 * 实测（HEAD 请求 + HF API 双重核对，`ppu-paddle-ocr-models` 仓库 main 分支）：
 *
 *   | 文件                              | 字节数      | MiB    | 能否同源发布 |
 *   |-----------------------------------|-------------|--------|--------------|
 *   | layout/PP-DocLayoutV2.onnx        | 213,303,073 | 203.42 | ❌ 超 8 倍    |
 *   | layout/PP-DocLayoutV3.onnx        | 129,920,689 | 123.90 | ❌ 超 5 倍    |
 *   | layout/PP-DocLayoutV2.ort         | （不存在，404）        | —      |
 *   | layout/PP-DocLayoutV3.ort         | （不存在，404）        | —      |
 *
 * 也就是说：**原定的 PP-DocLayoutV2/V3 方案在体积上不可行**，
 * 而且该仓库**没有**版面模型的 `.ort` 预转换版本（只有 `.onnx`，
 * 203MB / 124MB 都是原始 ONNX，比同仓库 detection/ort 那些 .ort 大得多）。
 *
 * 于是改用同一族的轻量版 **PP-DocLayout-S**（PicoDet-S / GFL 头，23 类）：
 *   · 体积 **4,917,852 字节 = 4.69 MiB**，是 V3 的 **3.8%**，远在 25MiB 之内；
 *   · 类别表**已经包含**本项目全部痛点类别：header、footer、formula、
 *     paragraph_title、doc_title、table、figure_title、number（页码）……
 *   · 输入 **480×480**，是 V3 的 800×800 的 36% 面积。
 *
 * 代价必须写明（这是**选型取舍**，不是免费午餐）：
 *   · 上游自评 mAP(0.5) = **70.9**（自建评测集，500 张中英文论文/报纸/
 *     试卷等）。V3 精度更高，但它发布不出来 —— 发布不了的精度等于零。
 *   · 480×480 对小字号页眉页脚可能弱于 800×800。
 * 因此本模块**只做加法**：模型给出的判定可以**补充**既有启发式，
 * 但它一旦缺席（下载失败 / 推理抛错 / 结果异常 / 用户关闭），
 * 整条 OCR 链路必须与接入前**逐字节一致**（见 `applyLayoutRegions` 与
 * `ocrPostProcess.ocrResultToBlocks` 的 layoutRegions 参数）。
 *
 * ═══════════════════════════════════════════════════════════════
 * 输入输出契约（**逐字节解析 onnx protobuf 得到，不是抄文档**）
 * ═══════════════════════════════════════════════════════════════
 *
 * 对下载到的 `pp_doclayout_s.onnx`（4,917,852 字节，
 * sha256 = 33688dbee1c23e34b81777e97cb428eb40f24b242c02b5f623484959e830aec8）
 * 直接解析其 protobuf 得到（ir_version=8、opset **17**、1078 个 node）：
 *
 *   graph.input :
 *     image         float32  [N, 3, 480, 480]
 *     scale_factor  float32  [N, 2]
 *   graph.output:
 *     fetch_name_0  float32  [M, 6]     每行 = [class_id, score, x1, y1, x2, y2]
 *     fetch_name_1  int32    [N]        有效行数（其余是 padding，**必须信它**）
 *
 * 预处理（上游 `PaddlePaddle/PP-DocLayout-S` 的 inference.yml，实测抓取）：
 *   Resize 到 **480×480 且 keep_ratio: false**（直接拉伸，不保持长宽比）
 *   → NormalizeImage **is_scale: true**，mean=[0.485,0.456,0.406]、
 *     std=[0.229,0.224,0.225]（即 ImageNet 归一化）
 *   → Permute 成 CHW。后处理 NMS 已烘焙进图内
 *     （score_threshold=0.3、nms_threshold=0.5、keep_top_k=100）。
 *
 * `scale_factor` 传 `[480 / 原图高, 480 / 原图宽]`：检测头会用它把框除回
 * **原图像素坐标系**，所以拿到的框可以直接与 OCR 的词框比较，无需再换算。
 * 这一点很关键 —— 否则所有区域坐标都会错一个比例因子，且**不会报错**，
 * 只会表现为「页眉页脚判得莫名其妙」。`decodeLayoutDetections` 因此
 * 显式校验输出坐标是否落在图像范围内，越界即整体放弃（见下）。
 *
 * ═══════════════════════════════════════════════════════════════
 * 许可与来源
 * ═══════════════════════════════════════════════════════════════
 *
 * 上游 `PaddlePaddle/PP-DocLayout-S` = **Apache-2.0**，
 * 与现有 OCR 模型（`ppu-paddle-ocr-models` 同为 Apache-2.0）同源同许可。
 * ONNX 导出件来自社区仓库 `stefanj0/PP-DocLayout-S-ONNX`（Apache-2.0），
 * 由 `paddle2onnx` 从上游 Paddle 权重导出，仓库内自带 sha256 与字节数声明 ——
 * 下载脚本按这两个值硬校验（见 `scripts/fetch-ocr-models.mjs`）。
 *
 * ⚠️ 诚实说明：`ppu-paddle-ocr-models` 仓库**自己并不提供**任何
 * 「能在 25MiB 内发布」的版面模型，所以这里必须引入第二个来源。
 * 若将来上游补了 PP-DocLayout-S 的官方 `.ort`，把下面的 URL 常量换掉即可，
 * 其余代码无需改动。
 */

import type { OcrWord } from '@/lib/ocrTypes';
import { buildLayoutModelUrl } from '@/lib/ocrModelSource';

/**
 * PP-DocLayout-S 的 23 个类别，**顺序即模型输出的 class_id**
 * （实测抓取上游 `inference.yml` 的 `label_list`，与 ONNX 导出件的类别表一致）。
 *
 * ⚠️ 顺序不能改、不能重排：class_id 是索引，错一位就会把
 * 「页脚」认成「公式」，而且不会报错。
 */
export const LAYOUT_LABELS = [
  'paragraph_title', // 0
  'image', // 1
  'text', // 2
  'number', // 3  页码
  'abstract', // 4
  'content', // 5  目录
  'figure_title', // 6  图注
  'formula', // 7
  'table', // 8
  'table_title', // 9  表注
  'reference', // 10
  'doc_title', // 11 文档标题
  'footnote', // 12
  'header', // 13 页眉
  'algorithm', // 14
  'footer', // 15 页脚
  'seal', // 16 印章
  'chart_title', // 17
  'chart', // 18
  'formula_number', // 19 公式编号
  'header_image', // 20
  'footer_image', // 21
  'aside_text', // 22 侧栏
] as const;

export type LayoutLabel = (typeof LAYOUT_LABELS)[number];

/**
 * 「页面家具」类别 —— 属于版面的**装饰/导航**层，不属于正文流。
 *
 * ═══════════════════════════════════════════════════════════════
 * 这份清单**刻意保守**：只收明确不是正文的类别
 * ═══════════════════════════════════════════════════════════════
 *
 * 判据是「这段文字是否属于文档内容本身」：
 *   · header / footer / header_image / footer_image / number（页码）/ seal：
 *     是页面的**家具**，翻页时重复或不承载内容 → 排除。
 *   · footnote：**不排除**。脚注是内容（习题集里常有关键提示），
 *     而现有启发式也不会删它 —— 排除它会是一次**新的内容丢失**，
 *     方向与本次修复相反。分类只做到「标出来」，交给上层决定。
 *   · aside_text（侧栏）：**不排除**。侧栏可能是正文的一部分（旁注、
 *     例题答案），而它在版面上仍属于内容列。
 *
 * ⚠️ 与既有启发式的**或**关系：这里判为家具的会被标记，
 * 但启发式**已经**判为家具的行不会被本模块「救回来」
 * （那需要一个显式的白名单机制，风险远大于收益）。也就是说本模块
 * 只**减少**误留的页眉页脚，不会新增误删 —— 这是刻意的单向性。
 */
export const FURNITURE_LABELS: ReadonlySet<LayoutLabel> = new Set<LayoutLabel>([
  'header',
  'footer',
  'header_image',
  'footer_image',
  'number',
  'seal',
]);

/**
 * 可能承载**正文内容**的类别。用于阅读顺序：只按内容区域分栏，
 * 家具与页边区域不参与分栏（否则一个居中的页眉会自成「一栏」，
 * 把正文排到它后面）。
 */
export const CONTENT_LABELS: ReadonlySet<LayoutLabel> = new Set<LayoutLabel>([
  'text',
  'content',
  'abstract',
  'reference',
  'paragraph_title',
  'doc_title',
  'figure_title',
  'table_title',
  'chart_title',
  'formula',
  'formula_number',
  'table',
  'image',
  'chart',
  'algorithm',
  'footnote',
  'aside_text',
]);

/** 模型输入分辨率（上游 inference.yml 的 target_size，实测 480×480） */
export const LAYOUT_INPUT_SIZE = 480;

/**
 * 是否把某个类别当页面家具。
 *
 * 单独抽成函数（而不是让调用点直接用 FURNITURE_LABELS）：
 * 未知类别字符串必须一律返回 false —— 宁可漏判也不要误删内容。
 */
export function isFurnitureLabel(label: string): boolean {
  return FURNITURE_LABELS.has(label as LayoutLabel);
}

/** 版面上的一个区域（坐标与传入的页面画布同一坐标系，原点左上） */
export interface LayoutRegion {
  /** 模型类别索引（0–22），对应 `LAYOUT_LABELS` */
  classId: number;
  /** 类别名；`classId` 越界时为 'unknown' —— 不抛错，见 `labelOf` */
  label: string;
  /** 置信度 0–1 */
  score: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** class_id → 类别名。越界返回 'unknown'（不抛错：一个坏行不该毁掉整页判定） */
export function labelOf(classId: number): string {
  if (!Number.isInteger(classId) || classId < 0 || classId >= LAYOUT_LABELS.length) return 'unknown';
  return LAYOUT_LABELS[classId]!;
}

/** 本模块全程使用的保底阈值；与图内烘焙的 score_threshold=0.3 同口径 */
const DEFAULT_SCORE_THRESHOLD = 0.3;

/**
 * 把模型的两路原始输出解码成区域列表。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么解码要单独成一个**纯函数**
 * ═══════════════════════════════════════════════════════════════
 *
 * 推理那一步在本机**跑不起来**（`npx vitest run` 会死在 vite 的
 * `spawn EPERM`，见交付说明）。把「张量 → 区域」这段纯计算从
 * `onnxruntime-web` 里剥出来，就能用合成数据把**全部边界情况**
 * 钉死在单元测试里：坏行、NaN、越界坐标、padding、类别越界、顺序稳定性。
 * 剩下的推理部分只是「喂张量、取输出」，没有可错的逻辑。
 *
 * 两条硬校验（都返回空数组而不是抛错 —— 这条链路跑在用户的长任务里）：
 *
 *  1. **`numDets` 必须可信**：输出张量会 padding 到固定 M 行，
 *     不读 `num_dets` 就会把一堆全零行当成「区域 (0,0)-(0,0)」。
 *     `numDets` 越界时夹到张量实际行数（而不是直接放弃：能救则救）。
 *  2. **坐标必须落在图像内**：`scale_factor` 一旦传错（例如把
 *     `[480/h, 480/w]` 传成 `[h/480, w/480]`），模型仍会返回**看起来
 *     合理的数字**，只是整体缩放错了 —— 那会静默地把所有区域判错。
 *     因此这里要求所有框的中心落在图像范围内，否则整体返回空
 *     （宁可不要版面信息，也不要拿错位的区域去删用户的页眉页脚）。
 *
 * @param detections 形状 [M, 6] 的扁平行优先数组（每行 cls,score,x1,y1,x2,y2）
 * @param numDets    有效行数（标量）；为 undefined 时退化为「按阈值过滤全部行」
 * @param imageWidth  页面画布宽（像素）
 * @param imageHeight 页面画布高（像素）
 */
export function decodeLayoutDetections(
  detections: ArrayLike<number>,
  numDets: number | undefined,
  imageWidth: number,
  imageHeight: number,
  scoreThreshold = DEFAULT_SCORE_THRESHOLD,
): LayoutRegion[] {
  if (!detections || !Number.isFinite(imageWidth) || !Number.isFinite(imageHeight)) return [];
  if (imageWidth <= 0 || imageHeight <= 0) return [];

  const totalRows = Math.floor(detections.length / 6);
  if (totalRows <= 0) return [];

  // num_dets 夹取：坏值不致命，能夹就夹；完全取不到时按全部行处理，
  // 后面还有 score 阈值兜底（padding 行的 score 是 0，必然被滤掉）。
  let rows = totalRows;
  if (typeof numDets === 'number' && Number.isFinite(numDets)) {
    rows = Math.max(0, Math.min(Math.floor(numDets), totalRows));
  }

  const regions: LayoutRegion[] = [];
  for (let i = 0; i < rows; i++) {
    const base = i * 6;
    const classId = detections[base]!;
    const score = detections[base + 1]!;
    const x1 = detections[base + 2]!;
    const y1 = detections[base + 3]!;
    const x2 = detections[base + 4]!;
    const y2 = detections[base + 5]!;

    if (![classId, score, x1, y1, x2, y2].every((v) => Number.isFinite(v))) continue;
    if (score < scoreThreshold) continue;

    // 归一化到左上/右下（模型理论上是 xyxy，但写成 yx 也不该让整页判错）
    const left = Math.min(x1, x2);
    const top = Math.min(y1, y2);
    const right = Math.max(x1, x2);
    const bottom = Math.max(y1, y2);
    if (right <= left || bottom <= top) continue;

    const cx = (left + right) / 2;
    const cy = (top + bottom) / 2;
    if (cx < 0 || cx > imageWidth || cy < 0 || cy > imageHeight) return [];

    regions.push({
      classId: Math.round(classId),
      label: labelOf(Math.round(classId)),
      score,
      // 框可以略微超出画布（模型对贴边区域常给负坐标），夹到画布内即可；
      // 但不能整体落在画布外 —— 那种情况上面已经整体放弃了。
      x0: clamp(left, 0, imageWidth),
      y0: clamp(top, 0, imageHeight),
      x1: clamp(right, 0, imageWidth),
      y1: clamp(bottom, 0, imageHeight),
    });
  }

  // 稳定排序：先上后下、再左后右、最后按 score 降序 ——
  // 同一页两次推理必须得到同一个顺序，否则「阅读顺序」不可复现。
  return regions.sort(
    (a, b) => a.y0 - b.y0 || a.x0 - b.x0 || b.score - a.score || a.classId - b.classId,
  );
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * 把一个词的包围盒映射到「覆盖它最多的那个区域」。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么用「覆盖度最大」而不是「中心点落在哪个框里」
 * ═══════════════════════════════════════════════════════════════
 *
 * 实测那份习题 PDF 上，页脚「单周周一下午2点前交作业」的识别框
 * 与最后一行正文**在纵向几乎没有间隙**；公式区域又常把相邻正文行的
 * 一部分盖进去。用中心点判定时，一个词的归属会随几像素的抖动翻转。
 *
 * 覆盖率（与该词相交的面积 ÷ 该词面积）对「大部分落在区域里」这件事
 * 更稳健，也对区域框略小于词框的情况更宽容。
 *
 * 并列时取**类别更可信**的那个：覆盖率差值在 0.05 以内视为并列，
 * 再比 score，再比 classId（保证与输入顺序无关、结果可复现）。
 *
 * @returns 覆盖度最高的区域；一个都没覆盖到（或覆盖率低于阈值）时返回 undefined
 */
export function regionForWord(
  word: Pick<OcrWord, 'bbox'>,
  regions: readonly LayoutRegion[],
  minCoverage = 0.5,
): LayoutRegion | undefined {
  const box = word?.bbox;
  if (!box) return undefined;
  const area = (box.x1 - box.x0) * (box.y1 - box.y0);
  if (!(area > 0)) return undefined;

  const COVERAGE_TIE = 0.05;
  let best: LayoutRegion | undefined;
  let bestCoverage = 0;

  for (const region of regions) {
    const overlapW = Math.min(box.x1, region.x1) - Math.max(box.x0, region.x0);
    const overlapH = Math.min(box.y1, region.y1) - Math.max(box.y0, region.y0);
    if (overlapW <= 0 || overlapH <= 0) continue;
    const coverage = (overlapW * overlapH) / area;
    if (coverage < minCoverage) continue;

    if (best === undefined) {
      best = region;
      bestCoverage = coverage;
      continue;
    }
    if (coverage > bestCoverage + COVERAGE_TIE) {
      best = region;
      bestCoverage = coverage;
      continue;
    }
    // 并列：按 score 降序，score 再并列则按 classId 升序 —— 三级判据保证确定性
    if (Math.abs(coverage - bestCoverage) <= COVERAGE_TIE) {
      if (region.score > best.score || (region.score === best.score && region.classId < best.classId)) {
        best = region;
        bestCoverage = coverage;
      }
    }
  }
  return best;
}

/** 一「行」在版面判定里需要的最小信息（不依赖 `ocrPostProcess` 的内部类型） */
export interface LayoutLineLike {
  words: Pick<OcrWord, 'bbox'>[];
}

/**
 * 一行是否被版面模型判为**页面家具**（页眉/页脚/页码/印章）。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么按「行内多数词」而不是「任意一个词」
 * ═══════════════════════════════════════════════════════════════
 *
 * 用的判据是**过半数的词**落在家具区域里。取「任意一个词」会把
 * 紧贴页眉的正文行整行删掉（正文行的第一个词偶尔会被页眉区域盖住一角）；
 * 取「全部词」又会让页脚那种被切成十来个单字的行漏判
 * （只要有一个字探出区域就整行不算）。
 *
 * 过半数是这两个极端之间的稳健点，而且与「行」本身的语义一致：
 * 一行要么是家具、要么是正文。
 *
 * 返回判为家具的那个区域（供诊断说明**依据**），否则 undefined。
 */
export function furnitureRegionOfLine(
  line: LayoutLineLike,
  regions: readonly LayoutRegion[],
): LayoutRegion | undefined {
  const words = line?.words ?? [];
  if (!words.length || !regions.length) return undefined;

  const votes = new Map<LayoutRegion, number>();
  for (const word of words) {
    const region = regionForWord(word, regions);
    if (!region) continue;
    votes.set(region, (votes.get(region) ?? 0) + 1);
  }

  const needed = words.length / 2;
  let winner: LayoutRegion | undefined;
  let bestVotes = 0;
  for (const [region, count] of votes) {
    if (!isFurnitureLabel(region.label)) continue;
    if (count <= needed) continue;
    // 票数并列时取 score 更高的那个 —— 否则「哪一个区域成了判定依据」
    // 会随 Map 的插入顺序变化，诊断信息就不可复现了
    if (
      count > bestVotes ||
      (count === bestVotes && winner !== undefined && region.score > winner.score)
    ) {
      winner = region;
      bestVotes = count;
    }
  }
  return winner;
}

/**
 * 版面区域 → **阅读顺序**（返回区间的排序键）。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么不能简单地「先上后下、先左后右」
 * ═══════════════════════════════════════════════════════════════
 *
 * 双栏版面上，纯 y 排序会把左右两栏**逐行交错**读成
 * 「左1 右1 左2 右2」—— 这是教科书级的阅读顺序错误。
 *
 * 但也不能无条件分栏：单栏文档里，一条居中标题的左边界与正文不同，
 * 若按左边界聚类就会把标题判成「另一栏」，读出来标题跑到整篇最后。
 *
 * 因此这里做的是**先判断「这一页到底是不是多栏」**，只有确证多栏才分栏：
 *   1. 只拿**内容类**区域参与（家具与页边不参与：一个居中页眉会自成「一栏」）；
 *   2. 忽略横跨大半个版面的区域（标题、通栏公式）—— 它们天然不属于任何一栏；
 *   3. 剩下的区域按**左边界**聚类（容差取版面宽度的 5%）；
 *   4. 收下的栏必须**至少 2 栏**、每栏**至少 2 个**区域，
 *      且栏与栏的左边界要有**实质分离**（相差超过容差）。
 *
 * 任何一条不满足 → 退回单栏「先上后下、先左后右」。
 * **这个方向是刻意的**：分错栏比不分栏糟得多（会把两栏文字交错拼接），
 * 而单栏排序对单栏文档永远正确。
 *
 * @returns 与 `regions` **等长**的排序键数组（不重排、不改动输入），
 *          调用方按 `keys[i]` 排序即可。键是字典序比较的 `[栏号, 上沿, 左沿]`。
 */
export function readingOrderKeys(
  regions: readonly LayoutRegion[],
  pageWidth: number,
): number[][] {
  const width = Number.isFinite(pageWidth) && pageWidth > 0 ? pageWidth : 0;
  const columns = detectColumns(regions, width);

  return regions.map((region) => {
    const column = columns ? columnIndexOf(region, columns) : 0;
    // 单栏时 column 恒为 0，退化成纯粹的「先上后下、再左后右」
    return [column, region.y0, region.x0];
  });
}

/**
 * 按阅读顺序排列区域（`readingOrderKeys` 的便利封装）。
 *
 * ⚠️ 与 `readingOrderKeys` 一样**不修改输入**，返回新数组。
 */
export function orderRegionsForReading(
  regions: readonly LayoutRegion[],
  pageWidth: number,
): LayoutRegion[] {
  const keys = readingOrderKeys(regions, pageWidth);
  return regions
    .map((region, i) => ({ region, key: keys[i]! }))
    .sort(
      (a, b) =>
        (a.key[0]! - b.key[0]!) || (a.key[1]! - b.key[1]!) || (a.key[2]! - b.key[2]!),
    )
    .map((entry) => entry.region);
}

/** 一栏的左边界（栏内所有区域左沿的最小值） */
export interface Column {
  left: number;
}

/**
 * 判断是否多栏；是则返回各栏的左边界（升序），否则返回 **null**。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么返回值是 `Column[] | null` 而不是「至少一栏」
 * ═══════════════════════════════════════════════════════════════
 *
 * 调用方（`ocrPostProcess.applyLayoutToLines`）需要区分
 * 「确证多栏」与「不是多栏」这两种情况，因为二者的处理**必须不同**：
 *   · 确证多栏 → 按栏号重排阅读顺序；
 *   · 不是多栏 → **一点都不动**，保持既有启发式的原有行序。
 *
 * 若这里用「至少返回一栏」的约定，调用方就无法把「单栏」与
 * 「多栏但只识别出一栏」区分开 —— 而后者一旦走了重排路径，
 * 就会在单栏文档上产生**没有任何收益的额外差异**，
 * 直接破坏「版面不可用时行为与接入前逐字节一致」这条不变量。
 *
 * 判据见 `readingOrderKeys` 的说明 —— 全部条件都满足才认定多栏。
 */
export function detectColumns(
  regions: readonly LayoutRegion[],
  pageWidth: number,
): Column[] | null {
  if (pageWidth <= 0) return null;

  const content = regions.filter(
    (r) => CONTENT_LABELS.has(r.label as LayoutLabel) && !isFurnitureLabel(r.label),
  );
  if (content.length < 4) return null; // 少于 4 个区域时「多栏」没有统计意义

  // 横跨大半个版面的区域（通栏标题、跨栏公式）不属于任何一栏
  const spanning = content.filter((r) => r.x1 - r.x0 >= pageWidth * 0.6);
  const candidates = content.filter((r) => r.x1 - r.x0 < pageWidth * 0.6);
  // 通栏区域太多说明本来就是单栏（每行都横跨）
  if (spanning.length > content.length * 0.5) return null;
  if (candidates.length < 4) return null;

  const tolerance = pageWidth * 0.05;

  // 按左沿聚类：candidates 已按 (y0, x0) 稳定有序，因此聚类结果可复现
  const columns: { left: number; count: number }[] = [];
  for (const region of [...candidates].sort((a, b) => a.x0 - b.x0)) {
    const hit = columns.find((c) => Math.abs(c.left - region.x0) <= tolerance);
    if (hit) {
      hit.count++;
      hit.left = Math.min(hit.left, region.x0);
    } else {
      columns.push({ left: region.x0, count: 1 });
    }
  }

  const solid = columns.filter((c) => c.count >= 2).sort((a, b) => a.left - b.left);
  if (solid.length < 2) return null;

  // 相邻栏必须有实质分离：否则只是同一栏左边界的小抖动被切成了两栏
  for (let i = 1; i < solid.length; i++) {
    if (solid[i]!.left - solid[i - 1]!.left <= tolerance) return null;
  }

  return solid.map((c) => ({ left: c.left }));
}

/** 区域属于哪一栏：取「左沿不超过它的最靠右那栏」 */
function columnIndexOf(region: LayoutRegion, columns: readonly Column[]): number {
  let index = 0;
  for (let i = 0; i < columns.length; i++) {
    // 半个容差的松弛：跨栏区域（比左栏宽但没到 60%）仍归左栏，
    // 避免它被推到右栏去、把阅读顺序打乱
    if (region.x0 >= columns[i]!.left - 1) index = i;
  }
  return index;
}

// ═══════════════════════════════════════════════════════════════
// 推理层：懒加载 + 全程可失败
// ═══════════════════════════════════════════════════════════════

/** 同源发布的版面模型路径（构建时由 scripts/fetch-ocr-models.mjs 落盘） */
export const LAYOUT_MODEL_FILE = 'layout/PP-DocLayout-S.onnx';

/**
 * 模型体积的**权威数字**：4,917,852 字节。
 *
 * 下载脚本按它校验（±1% 容差，与既有三个模型同一口径），
 * `verify-dist.mjs` 也按它拦住「截断的下载」。写在这里是为了让
 * 「体积是否超 25MiB」这件事在源码里就有据可查，而不是只存在于脚本注释。
 *
 * 为什么浏览器侧不校验 sha256：校验需要**整份文件先读进内存**再算哈希，
 * 那是又一份 4.7MB 的常驻内存，而本项目的实测约束正是内存压力会导致
 * 页面被浏览器回收（见 `ocrTypes.OCR_MAX_PIXELS` 的说明）。
 * 因此 sha256 只在**构建期**由 Node 脚本校验（见 scripts/fetch-ocr-models.mjs），
 * 运行期仅由浏览器按 HTTP 缓存使用已校验过的那份文件。
 */
export const LAYOUT_MODEL_BYTES = 4_917_852;

/** 构建期校验用的 sha256（来源仓库自带的声明，已在交付前实测比对通过） */
export const LAYOUT_MODEL_SHA256 =
  '33688dbee1c23e34b81777e97cb428eb40f24b242c02b5f623484959e830aec8';

export interface LayoutAnalysisResult {
  regions: LayoutRegion[];
  width: number;
  height: number;
}

/**
 * 是否启用版面分析。
 *
 * 默认**开启**（这正是本次要做的能力），但必须能被一键关掉：
 * 排查「是不是版面分析把内容弄丢了」时需要一个确定性开关，
 * 而且关掉之后行为必须回到接入前 —— `VITE_OCR_LAYOUT=0` 即可。
 */
export function isLayoutAnalysisEnabled(
  // ⚠️ `?.` 不能省：测试环境（vitest，node）下 `import.meta.env` 可能整体不存在，
  // 直接取属性会抛 TypeError —— 而抛错的副作用是**整条 OCR 链路失败**，
  // 恰好是本次修复最要避免的方向。
  flag = import.meta.env?.VITE_OCR_LAYOUT as string | undefined,
): boolean {
  if (flag === undefined || flag === null || flag === '') return true;
  return !(flag === '0' || flag === 'false' || flag === 'off');
}

/** 模型下载 + 建会话的硬超时；超时后**放弃版面分析**，不阻塞 OCR */
const LAYOUT_INIT_TIMEOUT_MS = 60_000;

let sessionPromise: Promise<import('onnxruntime-web').InferenceSession | null> | null = null;

/**
 * 懒加载版面模型会话。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么失败要缓存成「null」而不是每次重试
 * ═══════════════════════════════════════════════════════════════
 *
 * 一页 OCR 会调用它一次。若某台机器上模型 404 / WASM 建不起来，
 * 每次重试都要付一次网络往返或一次建会话的代价（几百毫秒到数秒），
 * 一本几百页的书会被这件事拖垮。失败一次就记住「本会话内不可用」，
 * 并让**后续所有页**直接走既有启发式。
 *
 * 返回 null 表示「版面分析在本会话内不可用」—— 调用方据此完全回退。
 */
export function loadLayoutSession(): Promise<import('onnxruntime-web').InferenceSession | null> {
  if (sessionPromise) return sessionPromise;

  sessionPromise = (async () => {
    try {
      const ort = await import('onnxruntime-web');

      // ⚠️ 这两条是**实测出来的硬约束**，与 ocrEngine.ts 完全一致，不要改：
      //   · wasmPaths 指向 CDN —— 本地那份 .wasm 约 28MB，超 Pages 的 25MiB；
      //   · numThreads = 1 —— 多线程版依赖 SharedArrayBuffer（需 COOP/COEP，
      //     本站未开）且要从跨源地址 new Worker（被浏览器禁止），
      //     失败时 Emscripten 走 abort() 直接带走页面、连异常都没有。
      ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${
        ort.env.versions.web ?? ort.env.versions.common
      }/dist/`;
      ort.env.wasm.numThreads = 1;

      const url = buildLayoutModelUrl();

      const session = await withTimeout(
        ort.InferenceSession.create(url, {
          // 与 ocrEngine 同一口径：只用 wasm（见 ocrExecutionProvider.ts 的说明）
          executionProviders: ['wasm'],
        }),
        LAYOUT_INIT_TIMEOUT_MS,
        `版面模型加载超时（${LAYOUT_INIT_TIMEOUT_MS / 1000} 秒）`,
      );

      console.info(
        `[layoutAnalysis] 版面模型就绪：${LAYOUT_MODEL_FILE}（${(
          LAYOUT_MODEL_BYTES /
          1024 /
          1024
        ).toFixed(2)}MB，输入 ${LAYOUT_INPUT_SIZE}×${LAYOUT_INPUT_SIZE}，23 类）\n` +
          `  · 用途：阅读顺序、页眉页脚/页码（替代字号与宽度的几何猜测）\n` +
          `  · 不可用时自动回退到既有启发式，不会导致识别失败`,
      );
      return session;
    } catch (err) {
      console.warn(
        '[layoutAnalysis] 版面模型不可用，本会话内将完全回退到既有几何启发式（识别不受影响）：',
        err,
      );
      return null;
    }
  })();

  return sessionPromise;
}

/** 仅供测试：清掉会话缓存，让下一次调用重新尝试加载 */
export function resetLayoutSessionForTest(): void {
  sessionPromise = null;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/**
 * 对一页做版面分析。
 *
 * **任何一步失败都返回 null**（模型不可用、预处理失败、推理抛错、
 * 结果为空、坐标越界）—— 调用方拿到 null 就走既有启发式。
 * 这里刻意**不抛异常**：版面分析是增强能力，不该有能力把整次 OCR 弄失败。
 *
 * @param source 与送入 OCR 的**同一张**画布（坐标系必须一致，否则区域对不上词框）
 */
export async function analyzePageLayout(
  source: ImageData | HTMLCanvasElement | OffscreenCanvas,
): Promise<LayoutAnalysisResult | null> {
  if (!isLayoutAnalysisEnabled()) return null;

  const width = 'width' in source ? source.width : 0;
  const height = 'height' in source ? source.height : 0;
  if (!width || !height) return null;

  try {
    const session = await loadLayoutSession();
    if (!session) return null;

    const ort = await import('onnxruntime-web');

    // ── 预处理：拉伸到 480×480 → ImageNet 归一化 → CHW ──────────
    // keep_ratio: false：上游就是**直接拉伸**（不做 letterbox），
    // 因此这里也必须拉伸。做成 letterbox 会让坐标换算与模型预期不一致，
    // 而且不会报错，只会让区域整体偏移。
    const { data } = readPixels(source);
    const plane = LAYOUT_INPUT_SIZE * LAYOUT_INPUT_SIZE;
    const chw = new Float32Array(3 * plane);
    const MEAN = [0.485, 0.456, 0.406];
    const STD = [0.229, 0.224, 0.225];

    for (let y = 0; y < LAYOUT_INPUT_SIZE; y++) {
      // 最近邻采样：与「先画到 480×480 再用 canvas 取像素」相比，
      // 少一次全图重绘与一份 480×480 的中间画布（内存压力是本项目的实测约束）。
      const srcY = Math.min(height - 1, Math.floor((y * height) / LAYOUT_INPUT_SIZE));
      for (let x = 0; x < LAYOUT_INPUT_SIZE; x++) {
        const srcX = Math.min(width - 1, Math.floor((x * width) / LAYOUT_INPUT_SIZE));
        const p = (srcY * width + srcX) * 4;
        const r = (data[p] ?? 0) / 255;
        const g = (data[p + 1] ?? 0) / 255;
        const b = (data[p + 2] ?? 0) / 255;
        const o = y * LAYOUT_INPUT_SIZE + x;
        chw[o] = (r - MEAN[0]!) / STD[0]!;
        chw[plane + o] = (g - MEAN[1]!) / STD[1]!;
        chw[2 * plane + o] = (b - MEAN[2]!) / STD[2]!;
      }
    }

    const feeds: Record<string, import('onnxruntime-web').Tensor> = {
      image: new ort.Tensor('float32', chw, [1, 3, LAYOUT_INPUT_SIZE, LAYOUT_INPUT_SIZE]),
      // 检测头用它把预测框除回**原图像素坐标系**（见文件顶部契约说明）
      scale_factor: new ort.Tensor(
        'float32',
        new Float32Array([LAYOUT_INPUT_SIZE / height, LAYOUT_INPUT_SIZE / width]),
        [1, 2],
      ),
    };

    const outputs = await session.run(feeds);

    // 输出名以实测 protobuf 为准；用位置兜底以防导出方改名
    const values = Object.values(outputs);
    const detTensor = outputs['fetch_name_0'] ?? values[0];
    const numTensor = outputs['fetch_name_1'] ?? values[1];
    if (!detTensor || !numTensor) return null;

    const numDets = Number((numTensor.data as ArrayLike<number>)[0]);

    const regions = decodeLayoutDetections(
      detTensor.data as ArrayLike<number>,
      numDets,
      width,
      height,
    );
    if (!regions.length) return null;

    const furniture = regions.filter((r) => isFurnitureLabel(r.label)).length;
    console.info(
      `[layoutAnalysis] 版面区域 ${regions.length} 个` +
        (furniture ? `（其中页面家具 ${furniture} 个：${furnitureSummary(regions)}）` : '') +
        ` · 画布 ${width}×${height}`,
    );

    return { regions, width, height };
  } catch (err) {
    console.warn('[layoutAnalysis] 版面分析失败，本页回退到既有几何启发式：', err);
    return null;
  }
}

/** 把家具类别统计成一句可读的摘要，便于在诊断轨迹里追问「到底删了什么」 */
function furnitureSummary(regions: readonly LayoutRegion[]): string {
  const counts = new Map<string, number>();
  for (const region of regions) {
    if (!isFurnitureLabel(region.label)) continue;
    counts.set(region.label, (counts.get(region.label) ?? 0) + 1);
  }
  return [...counts.entries()].map(([label, n]) => `${label}×${n}`).join('、');
}

/**
 * 取出画布像素。
 *
 * ⚠️ `getImageData` 需要 `willReadFrequently`，否则每次调用都会把
 * GPU 纹理读回内存（这个坑在 `ocrEngine.analyzeCanvasInk` 里已经踩过）。
 * 已经在 `willReadFrequently` 上下文里的画布直接复用它的上下文。
 */
function readPixels(source: ImageData | HTMLCanvasElement | OffscreenCanvas): ImageData {
  if (typeof ImageData !== 'undefined' && source instanceof ImageData) return source;

  if (typeof document === 'undefined') {
    throw new Error('无法在无 document 环境下读取画布像素');
  }

  let canvas: HTMLCanvasElement;
  if (source instanceof HTMLCanvasElement) {
    canvas = source;
  } else {
    canvas = document.createElement('canvas');
    canvas.width = source.width;
    canvas.height = source.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('无法创建 2D 上下文');
    ctx.drawImage(source as CanvasImageSource, 0, 0);
  }

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('无法创建 2D 上下文');
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}
