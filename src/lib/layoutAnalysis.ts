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
 * 解码「一个区域也没解出来」时的**确切原因**。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么解码器必须把「为什么是空的」说出来
 * ═══════════════════════════════════════════════════════════════
 *
 * 拿到空数组的调用方原先只知道「没有区域」，而这个结果有三个**下一步
 * 动作完全不同**的来源：
 *
 *   · `degenerate_input` —— 张量本身是空的、或画布尺寸非法。这是**管道坏了**，
 *     要查的是画布/张量从哪来；
 *   · `no_rows`         —— 模型说「这一页有效检测 0 行」。这是**合法结论**
 *     （空白页、纯图页），不该重试，也不该报警；
 *   · `rejected_rows`   —— 模型给了行，但每一行都被丢掉了（低于 0.3 阈值、
 *     NaN、零面积、类别越界到 unknown）。这是**模型与阈值的口径问题**，
 *     要去调阈值或查导出件；
 *   · `center_out_of_bounds` —— 张量看起来正常，但框的中心落在画布外。
 *     这是**最危险的一种**：`scale_factor` 传反（`[h/480, w/480]` 而不是
 *     `[480/h, 480/w]`）时模型仍会返回看起来合理的数字，只是整体缩放错了。
 *     它必须能被单独指出来，因为它的下一步动作是「查坐标换算」，
 *     而不是上面任何一条。
 *
 * 这个区分**不能靠数区域个数反推**：`no_rows` 与 `rejected_rows` 都会
 * 得到「0 个区域」，而它们的处置完全相反（一个不用管，一个要调阈值）。
 *
 * ⚠️ 本类型**只描述「为什么是空的」**，不是错误枚举：它由纯函数产出、
 * 不进入导出。对外那套稳定的机器可读 code 见 `LAYOUT_SKIP_CODES`。
 */
export type LayoutDecodeReason =
  | 'degenerate_input'
  | 'no_rows'
  | 'rejected_rows'
  | 'center_out_of_bounds';

/** `decodeLayoutDetectionsDetailed` 的返回：区域 + 「为什么一个都没有」 */
export interface LayoutDecodeDetail {
  regions: LayoutRegion[];
  /** 仅当 `regions` 为空时才有意义；`regions` 非空时它总是 `null` */
  reason: LayoutDecodeReason | null;
}

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
  return decodeLayoutDetectionsDetailed(
    detections,
    numDets,
    imageWidth,
    imageHeight,
    scoreThreshold,
  ).regions;
}

/**
 * 与 `decodeLayoutDetections` **同一套判定**，额外交出空结果的原因。
 *
 * 刻意做成「薄包装 + 单一实现」而不是让两边各写一遍判定：
 * 判据一旦漂移，导出里的原因就会「证明」一件解码器并没有做的事 ——
 * 那比没有原因更糟（同 `ocrStructure` 里 `buildCharSizeTable` 那条注释的理由）。
 * 因此 `decodeLayoutDetections` 现在只是它的 `.regions`。
 */
export function decodeLayoutDetectionsDetailed(
  detections: ArrayLike<number>,
  numDets: number | undefined,
  imageWidth: number,
  imageHeight: number,
  scoreThreshold = DEFAULT_SCORE_THRESHOLD,
): LayoutDecodeDetail {
  if (!detections || !Number.isFinite(imageWidth) || !Number.isFinite(imageHeight)) {
    return { regions: [], reason: 'degenerate_input' };
  }
  if (imageWidth <= 0 || imageHeight <= 0) return { regions: [], reason: 'degenerate_input' };

  const totalRows = Math.floor(detections.length / 6);
  if (totalRows <= 0) return { regions: [], reason: 'degenerate_input' };

  // num_dets 夹取：坏值不致命，能夹就夹；完全取不到时按全部行处理，
  // 后面还有 score 阈值兜底（padding 行的 score 是 0，必然被滤掉）。
  let rows = totalRows;
  if (typeof numDets === 'number' && Number.isFinite(numDets)) {
    rows = Math.max(0, Math.min(Math.floor(numDets), totalRows));
  }

  const regions: LayoutRegion[] = [];
  /** 被逐行丢掉的条数。只为「为什么一个都没解出来」服务，不参与任何判定 */
  let rejected = 0;

  for (let i = 0; i < rows; i++) {
    const base = i * 6;
    const classId = detections[base]!;
    const score = detections[base + 1]!;
    const x1 = detections[base + 2]!;
    const y1 = detections[base + 3]!;
    const x2 = detections[base + 4]!;
    const y2 = detections[base + 5]!;

    if (![classId, score, x1, y1, x2, y2].every((v) => Number.isFinite(v))) {
      rejected++;
      continue;
    }
    if (score < scoreThreshold) {
      rejected++;
      continue;
    }

    // 归一化到左上/右下（模型理论上是 xyxy，但写成 yx 也不该让整页判错）
    const left = Math.min(x1, x2);
    const top = Math.min(y1, y2);
    const right = Math.max(x1, x2);
    const bottom = Math.max(y1, y2);
    if (right <= left || bottom <= top) {
      rejected++;
      continue;
    }

    const cx = (left + right) / 2;
    const cy = (top + bottom) / 2;
    // ⚠️ 这里**必须**保持「整页放弃」（return 空），不能改成 continue：
    // 理由见上面第 2 条硬校验（宁可不要版面信息，也不要拿错位区域删页眉页脚）。
    // 下面 caller 侧再跑一次同样的判断，只为把原因说成 `center_out_of_bounds`。
    if (cx < 0 || cx > imageWidth || cy < 0 || cy > imageHeight) {
      return { regions: [], reason: 'center_out_of_bounds' };
    }

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
  regions.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0 || b.score - a.score || a.classId - b.classId);

  // `regions` 非空时 reason 恒为 null —— 「空」与「有」不会同时成立，
  // 读的人不必再判断哪个字段优先。
  if (!regions.length && rejected > 0) return { regions, reason: 'rejected_rows' };
  if (!regions.length) return { regions, reason: 'no_rows' };
  return { regions, reason: null };
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

// ═══════════════════════════════════════════════════════════════
// 降级原因：结构化、可机读、**用户看得见**
// ═══════════════════════════════════════════════════════════════

/**
 * 版面分析「没给出区域」时，对外报出的**稳定失败码**。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么要有这套码（真实教训，本项目的第 N 次）
 * ═══════════════════════════════════════════════════════════════
 *
 * 本函数此前**任何一步失败都 `return null`**，于是上层的世界里只有
 * 「版面信息不可用」这一个事实。而用户的报告是「页眉被多滤掉一行」——
 * 要判断这是版面模型干的还是几何启发式干的，本来只需要知道
 * 「这一页到底有没有跑出版面区域」；但因为原因不可分辨，连这一步都做不到。
 *
 * `HANDOFF.md` §5.11.7 记着一条更难看的事实：**版面模型从未在真实数据上
 * 跑过推理**（提交信息自己写「no real inference has been run against this model」）。
 * 一个未验证的组件被放进了正文链路，而它出错时连「是不是它」都问不出来 ——
 * 这正是这套码要修的东西。它**不提高**模型的精度，只让它的缺席不再无声。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么写成 `as const` 数组 + 派生联合类型（而不是裸字符串）
 * ═══════════════════════════════════════════════════════════════
 *
 * 裸字符串的失败模式是「拼错一个字母，全部测试照样绿，只有导出的 JSON
 * 里多了一个没人认识的码」。这里让 `LayoutSkipCode` **由数组派生**，
 * 于是任何使用点写错码在 `tsc -b` 就报错。
 *
 * 同时派生 `LayoutOutcomeCode`（多一个 `'none'`）—— `'none'` 表示
 * **成功**，不是失败码：把成功塞进「失败码枚举」是这一行代码里最容易
 * 犯的语义错误，而它会让下游的 `switch` 少一个分支且不报错。
 * 也因此下面用两条 `Record<..., ...>` 把「每个码都必须有说明」
 * 变成**编译期**约束：漏写一个键，`tsc -b` 直接失败。
 *
 * ═══════════════════════════════════════════════════════════════
 * 设计参照：MinerU 的三条做法（只借鉴设计，未引入其任何代码）
 * ═══════════════════════════════════════════════════════════════
 *
 * 出处均为其官方文档（2026-10 实测抓取）：
 *
 *  1. **无档位时报 `quality_tier_unavailable`，不静默降级** —— 原文：
 *     「PDF/图片默认优先 Standard，其次 Basic；不可用时报
 *     `quality_tier_unavailable`，不会静默降为 Flash 或上传到官网。」
 *     出处：https://opendatalab.github.io/MinerU/zh/usage/tiers/
 *     （英文页同句：“If neither is available, it returns
 *     `quality_tier_unavailable` rather than silently choosing Flash or
 *     uploading to the official service.”）
 *     → 本模块照搬这条：拿不到版面信息时**照旧回退几何启发式**（那是
 *       本项目刻意的渐进增强策略，且由不变量测试守着），但必须**说出**
 *       是哪一种不可用，而不是让上层只看到 `null`。
 *  2. **稳定的机器可读码 + 每个码配「含义」与「下一步动作」** —— 其 V1
 *     HTTP API 文档给出一张「退出码 → 含义」的定值表（`0` 完成 / `1` 传输
 *     或写入失败 / `2` partial / `3` failed / `4` canceled / `124` 轮询预算
 *     耗尽），并注明「退出码面向自动化保持稳定」。出处：
 *     https://opendatalab.github.io/MinerU/zh/usage/http_api/
 *     → 对应下面的 `LAYOUT_SKIP_CATALOG`：`meaning` 是含义，
 *       `nextAction` 是下一步动作。⚠️ 诚实说明：那张表是**示例脚本**的
 *       退出码，不是 API 响应体的 `error.code` 枚举；我没有在其官方文档里
 *       找到一份完整的 `error.code` 清单（其它来源只有间接线索，未采信）。
 *       本条借鉴的是「码 + 含义 + 稳定承诺」这个形状，不是某个具体清单。
 *  3. **明文要求调用方按码分支，不要按散文分支** —— 官方文档里没有逐字
 *     等到这句话；最接近的是其 V1 HTTP API 的「**HTTP 200 不等于合法响应**」
 *     一节：脚本在每一步**校验 JSON 结构**（ID 必须是非空字符串、状态必须
 *     属于支持集合），「否则立即失败，而不是带着 null ID 进入轮询」。出处同上。
 *     → 所以本文件与 `ocrStructure` 的注释里都明确写着：**按 `code` 分支，
 *       不要把 `meaning`/`nextAction`/`detail` 当作判断依据**——
 *       那三样是给人看的散文，措辞随时可能改。
 *
 * ⚠️ 许可说明：MinerU 是 AGPL-3.0 系许可（仓库内另有自定义条款），
 * 与本项目不兼容。以上**只借鉴公开文档描述的设计思路**，
 * **没有复制其任何代码、字符串常量或枚举成员**（下面的码名均为本项目自拟）。
 *
 * ═══════════════════════════════════════════════════════════════
 * ⚠️ 保持要求：新增码时必须同时补 `LAYOUT_SKIP_CATALOG`
 * ═══════════════════════════════════════════════════════════════
 *
 * 用错码 → `tsc` 报错；漏写说明 → `tsc` 报错。这两条都由类型系统保证，
 * 不靠人记得。至于「这个码在真实数据上到底会不会出现」，由
 * `layoutFailure.test.ts` 逐码触发来守（**不是**只断言枚举存在）。
 */
export const LAYOUT_SKIP_CODES = [
  // ── 1. 开关关闭 ──────────────────────────────────────────────
  'feature_disabled',
  // ── 2. 画布本身不可读 ────────────────────────────────────────
  'canvas_unreadable',
  // ── 3. 画布尺寸非法（0 / NaN）────────────────────────────────
  'geometry_unusable',
  // ── 4. 模型会话建不起来（本会话内不可用）────────────────────
  'session_load_failed',
  // ── 5. 推理抛错（本页个例）──────────────────────────────────
  'inference_failed',
  // ── 6. 输出张量缺失（导出件与代码契约不符）──────────────────
  'model_output_missing',
  // ── 7. 一个区域也没解出来（三来源，靠 detail 区分）──────────
  'no_regions_detected',
] as const;

/** 稳定的失败码。用错码在 `tsc -b` 就报错（而不是变成一个没人认识的字符串） */
export type LayoutSkipCode = (typeof LAYOUT_SKIP_CODES)[number];

/** 一次版面分析尝试的**完整**结果码：`'none'` 表示成功，其余都是失败 */
export const LAYOUT_OUTCOME_CODES = ['none', ...LAYOUT_SKIP_CODES] as const;

/** 含成功在内的结果码（用于导出与两条完整性检查） */
export type LayoutOutcomeCode = (typeof LAYOUT_OUTCOME_CODES)[number];

/** 一个失败码的「含义」与「下一步动作」 */
export interface LayoutSkipCodeInfo {
  /** 中文含义：这个码在说发生了什么 */
  meaning: string;
  /** 下一步动作：看到它应该去做什么 */
  nextAction: string;
  /**
   * 无法用 `detail` 区分的「多个失败点」时，在这里点明是哪几个 ——
   * 满足「不同失败点不得混成一个码且无法分辨」这条要求。
   */
  sites?: readonly string[];
}

/**
 * 码表：**每个码都必须有含义与下一步动作**。
 *
 * 类型是 `Record<LayoutOutcomeCode, LayoutSkipCodeInfo>`，所以：
 *   · 少写一个码 → `tsc -b` 报「缺少属性」；
 *   · 多写一个不存在的码 → `tsc -b` 报「不在类型里」。
 * 这就是把「不许有没写说明的码」变成编译期约束，而不是靠人记得。
 */
export const LAYOUT_SKIP_CATALOG: Record<LayoutOutcomeCode, LayoutSkipCodeInfo> = {
  none: {
    meaning: '版面分析**成功**，这一页的区域来自版面模型（不是失败码）。',
    nextAction: '不需要动作。若要核对，看同一字段里的 regionCount 与画布尺寸。',
  },
  feature_disabled: {
    meaning: '开关关着（`VITE_OCR_LAYOUT=0/false/off`），压根没尝试版面分析。',
    nextAction:
      '这是**用户自己关的**，不是故障：去设置里打开（或构建时不传该变量）即可。不要当成模型问题排查。',
  },
  canvas_unreadable: {
    meaning:
      '画布尺寸正常，但读不到像素（无 `document`/2D 上下文，或 `getImageData` 抛错）。',
    nextAction:
      '检查运行环境能否建 2D 上下文（无 document 的环境必然走这一条）；这是**环境问题**，不是模型问题。',
  },
  geometry_unusable: {
    meaning: '传入画布的宽或高为 0（或 NaN）—— 不满足 `!width || !height`。',
    nextAction:
      '检查图片尺寸：上游渲染出的画布是不是空的。**这一页的重试没有意义**，要修的是渲染那一步。',
  },
  session_load_failed: {
    meaning:
      '模型会话在本会话内建不起来：`onnxruntime-web` 导入失败、模型取不到（首次使用要联网）、或建会话超时。失败一次就被记住，**本次会话后续所有页都不再重试**。',
    nextAction:
      '检查网络/模型是否同源可取（`layout/PP-DocLayout-S.onnx`），以及 ONNX WASM（jsDelivr）是否可达。**刷新页面才会重试**——在会话内反复重跑 OCR 不会变好。',
  },
  inference_failed: {
    meaning: '会话在、张量也喂进去了，但 `session.run()` 抛错（或预处理里出了别的意外）。',
    nextAction:
      '**这是本页个例，可以重试**：同一本书的下一页大概率正常。若每页都这样，才去查 ONNX 版本与执行后端。',
  },
  model_output_missing: {
    meaning:
      '推理返回了，但取不到 `fetch_name_0`/`fetch_name_1` 两路输出（**导出件与代码里逐字节解析出的契约不符**）。',
    nextAction:
      '检查模型文件是不是被换成了别的版本（契约见本文件顶部 `graph.output` 那一段，来自实测 protobuf）。这是**部署问题**，重试无用。',
  },
  no_regions_detected: {
    meaning:
      '推理跑通、张量也齐，但**一个区域也没解出来**。三个来源含义完全不同，靠 `detail` 区分（见 `sites`）。',
    nextAction:
      '先看 `detail` 里的来源：`模型报 0 行有效检测` → 这一页可能真的没有版面内容（空白/纯图），不需要动作；`所有行都被丢弃` → 去调 score 阈值或查导出件；`框的中心落在画布外` → **查 `scale_factor` 的坐标换算**（传反时不会报错，只会整体错位）。',
    sites: [
      '`模型报 0 行有效检测` —— num_dets 为 0 或张量行数不足，属模型的**合法结论**',
      '`所有行都被丢弃` —— 行存在但全被丢弃（低于 0.3 阈值 / NaN / 零面积 / 未知类别全是 unknown）',
      '`框的中心落在画布外` —— scale_factor 传错，**最危险的一种**，必须与上面两种分开看',
    ],
  },
};

/**
 * 成功时随码带出的**规模信息**。
 *
 * 为什么成功也要带字段：导出里只说「`code: 'none'`（成功了）」回答不了
 * 「模型到底看出来了几个区域」—— 而「成功了但只有 1 个区域」与
 * 「成功了、12 个区域」对判断「页眉被多滤掉一行」是完全不同的证据。
 *
 * 为什么不直接放整个 `LayoutAnalysisResult`：区域数组每页几百个框，
 * 导出里已经有一份词表了；结论要留，原始数据不必再抄一份。
 */
export interface LayoutSuccessInfo {
  /** 模型给出的区域个数 */
  regionCount: number;
  /** 区域坐标所在画布的宽（与送入 OCR 的画布同一坐标系） */
  width: number;
  height: number;
}

/**
 * 一次尝试的结果。
 *
 * 判别联合：`ok` 为 true 时**没有** `code` 字段可读（读它 `tsc` 会报错），
 * 于是「成功却还在看失败码」这种错在编译期就挡住。
 */
export type LayoutAnalysisOutcome =
  | ({ ok: true; code: 'none' } & LayoutSuccessInfo)
  | { ok: false; code: LayoutSkipCode; detail?: string };

/**
 * 最近一次 `analyzePageLayout` 的结果（旁挂记录）。
 *
 * ═══════════════════════════════════════════════════════════════
 * ⚠️ 先说清它**不是**什么（写这段时改过一次口，原文是错的）
 * ═══════════════════════════════════════════════════════════════
 *
 * **导出不读这个记录。** `ocr-structure` 里的 `layout` 字段走的是
 * **显式入参**那条路：`pdfParser` 从 `analyzePageLayout` 的解构里拿到
 * `outcome`（`pdfParser.ts:621`），原样传给 `ocrResultToBlocks` 的第 5 个
 * 参数，再传进 `buildOcrStructure`。理由写在 `buildOcrStructure` 的
 * `layout` 入参注释里：本函数是**纯函数**，一旦去读全局，它「纯」这条
 * 性质就没了，而那正是它全部测试能成立的前提；而且读全局会让
 * 「导出的是哪一次」变成**时序的产物**而不是事实。
 *
 * 所以这个记录目前的读点只有测试与诊断。它存在有两个理由，都不是
 * 「给导出供数」：
 *
 *  1. **与既有机制同形。** `ocrCharBoxes` 的 `recordCharBoxSkip` /
 *     `getCharBoxSkips` / `clearCharBoxSkips`（`ocrCharBoxes.ts:2298-2311`）
 *     已经证明这个形状在本项目里能用、能被测 —— 同一件事不再造第二套读法。
 *  2. **给「本页最后一次尝试」一个不与返回值耦合的读点。**
 *     将来若要把版面结论写进别的诊断（例如会话诊断轨迹）而那条路
 *     拿不到 `outcome`，这里已经有一个确定的地方可读。
 *
 * ⚠️ **诚实标注**：`getPageLayoutAnalysis()` 目前在**生产代码里没有任何
 * 读点**（只有 `layoutFailure.test.ts` 读它）。它是有意留下的可读出口，
 * 不是当前功能所必需的一环 —— 别把它当成「导出靠它」。
 *
 * ═══════════════════════════════════════════════════════════════
 * 「最近一次」到底是哪一次
 * ═══════════════════════════════════════════════════════════════
 *
 * `analyzePageLayout` 里**每一条 return 都经过 `done()`**，而 `done()`
 * 无条件写这个记录 —— 所以「最后一次调用」与「记录里的值」恒等，
 * 不存在「记录了但返回值不一样」的中间态。页内多次调用时以最后一次为准。
 *
 * ⚠️ 这也意味着：**函数入口处再写一遍 `lastOutcome = undefined` 是多余的**
 * （每一条出口都会覆盖它，包括失败出口）。变异测试实测确认了这一点 ——
 * 把那行删掉，21 条用例全绿。所以这里**不再放那行**，而且
 * `ocrEngine.recognizePage` 也**不再**调用 `clearPageLayoutAnalysis()`：
 * 页面开始时的清空同样被本页那次调用覆盖，留着只会让人以为
 * 「不清就会残留上一页的结论」。真正保证不残留的是 `done()` 本身。
 */
let lastOutcome: LayoutAnalysisOutcome | undefined;

/** 读取本页最近一次版面分析的结果；一次都还没调用过时返回 `undefined` */
export function getPageLayoutAnalysis(): LayoutAnalysisOutcome | undefined {
  return lastOutcome;
}

/**
 * 清空记录（**仅供测试与将来的诊断读点使用**，生产链路不依赖它）。
 *
 * ⚠️ 它不是「每页必须调一次」的东西：每页的结论由 `analyzePageLayout`
 * 的 `done()` 无条件写入，调用它与否都不改变任何一页的导出结果。
 * 测试里用它做用例间的隔离（`setPageLayoutAnalysisForTest(undefined)` 同理）。
 */
export function clearPageLayoutAnalysis(): void {
  lastOutcome = undefined;
}

/** 仅供测试：把记录设成指定值（用来验证「每次调用都会覆盖它」） */
export function setPageLayoutAnalysisForTest(outcome: LayoutAnalysisOutcome | undefined): void {
  lastOutcome = outcome;
}

/**
 * 结果 → 导出用的 `code`（成功是 `'none'`）。
 *
 * 单独抽出来是因为「成功时写 `'none'` 而不是 `null`」这个决定要在
 * 导出侧和记录侧**同源**：两边各写一次迟早会漂移，而漂移的表现是
 * 「导出说 none、界面说失败」这种最难查的不一致。
 */
export function layoutOutcomeCode(outcome: LayoutAnalysisOutcome): LayoutOutcomeCode {
  return outcome.code;
}

/**
 * 结果 → 导出用的 `detail`；没有细节时返回 `undefined`（**字段就不写**）。
 *
 * `ok === true` 时没有 `detail` 字段可读，所以先窄化再取 —— 这样
 * 「成功路径上顺手读了失败字段」在 `tsc` 就报错，而不是运行期得到 undefined。
 */
export function layoutOutcomeDetail(outcome: LayoutAnalysisOutcome): string | undefined {
  return outcome.ok ? undefined : outcome.detail;
}

/**
 * 枚举里有没有重复项 —— 由测试钉住（重复码会让「按码区分」再次失效）。
 * 写成导出函数是为了让测试断言的是**同一份枚举**，而不是抄一份字符串表。
 */
export function layoutSkipCodesAreUnique(): boolean {
  return new Set<string>(LAYOUT_SKIP_CODES).size === LAYOUT_SKIP_CODES.length;
}

/** 把任意异常写成一句可读的 detail（截断，避免把整个堆栈塞进导出） */
function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`.slice(0, 200);
  return String(err).slice(0, 200);
}

/** 建一条失败记录；没有 detail 时**不带该字段**（不是空字符串） */
function layoutSkip(code: LayoutSkipCode, detail?: string): LayoutAnalysisOutcome {
  return detail ? { ok: false, code, detail } : { ok: false, code };
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
 * 建会话失败时**真实的原因文本**（本会话内一直留着）。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么必须在这里存一份
 * ═══════════════════════════════════════════════════════════════
 *
 * 失败的 `err` 原先只进 `console.warn` —— 而**用户看不到控制台**，
 * 于是「模型 404」与「WASM 建不起来」与「60 秒超时」在导出里长得一模一样。
 * 这三者的下一步动作完全不同（查同源模型 / 查 CDN / 查网络），
 * 所以 `err` 必须被留下来交给 `analyzePageLayout` 写进导出。
 *
 * 与 `sessionPromise` 同一生命周期：**失败一次记住一次**，
 * 且后续页读到的都是同一条（因为会话缓存本身就不会再重试，
 * 见下面「为什么失败要缓存成 null」那段）。
 */
let sessionLoadError: string | null = null;

/** 仅供测试：连失败原因一起清掉（避免用例之间互相读到对方的错误文本） */
export function resetLayoutSessionForTest(): void {
  sessionPromise = null;
  sessionLoadError = null;
}

/**
 * 本会话内建会话失败的原因；成功或还没尝试过时返回 `null`。
 *
 * ⚠️ 它与 `resetLayoutSessionForTest` 同步清空 —— 否则测试之间会串味，
 * 而「读同进程里别的用例留下的值」正是本项目已经吃过亏的假保护形态。
 */
export function getLayoutSessionLoadError(): string | null {
  return sessionLoadError;
}

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
      sessionLoadError = describeError(err);
      console.warn(
        '[layoutAnalysis] 版面模型不可用，本会话内将完全回退到既有几何启发式（识别不受影响）：',
        err,
      );
      return null;
    }
  })();

  return sessionPromise;
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
 * ═══════════════════════════════════════════════════════════════
 * 返回值形状：为什么是 (a) 判别联合 + (b) 旁挂记录，**两个都要**
 * ═══════════════════════════════════════════════════════════════
 *
 * 任务给了两个候选，这里的选择是 **(a) 为主、(b) 为辅**，理由是它们在
 * 两个不同的约束上各自最优，而这两条约束都必须满足：
 *
 *  · **(a) 判别联合 `{ result, outcome }`（主）** —— 因为失败原因必须在
 *    **调用点**就能拿到。`pdfParser` 紧接着要做的事（公式恢复、块组装）
 *    都取决于「这一页有没有版面信息」，让它在同一个 `await` 的返回里
 *    同时拿到区域与原因，就不需要任何「全局里查一下上次怎么样」的时序推理。
 *    代价：返回类型从 `| null` 变成判别联合，`pdfParser` 的
 *    `layout?.regions` 要改成 `layout.ok ? layout.result.regions : undefined`。
 *    这次改动的全部风险都在这一步，所以下面第 3 条专门说明为什么不变量没破。
 *
 *  · **(b) 旁挂记录 `getPageLayoutAnalysis()`（辅）** —— 因为**导出点在另一个
 *    模块里**（`ocrPostProcess` → `buildOcrStructure`，`ocrPostProcess.ts:778`），
 *    把那一条 `outcome` 再穿三层参数只为写一个字段，会让签名变脏且更易漂移。
 *    旁挂记录与 `ocrCharBoxes` 的 `getCharBoxSkips()` **同形**
 *    （`ocrCharBoxes.ts:2298-2311`），本项目已经有一套读法，不再造第二套。
 *
 * ⚠️ **不变量优先**：选 (a) 而不是让调用点改走「null 表示失败、另查记录」
 * 的路线，正是为了**让不变量在结构上成立**：
 *
 *   · 改动前：`layout` 是 `LayoutAnalysisResult | null`；调用点写 `layout?.regions`。
 *   · 改动后：`layout.ok === false` 时**仍然**把 `undefined` 交给下游；
 *     `ok === true` 时交出**同一个** `result` 对象。下游看到的字节完全一样。
 *
 *   也就是说「拿不到版面信息 → 输出与改动前逐字节相同」不是靠测试守出来的
 *   一个巧合，而是**同样的 `undefined` 走同样的既有分支**这一条结构事实。
 *   测试（`layoutFailure.test.ts`）守的是这个结构事实没有被将来的改动破坏。
 *
 * ═══════════════════════════════════════════════════════════════
 * 七种失败，七条互不相同的出口
 * ═══════════════════════════════════════════════════════════════
 *
 * 改动前这里有 **7 处 `return null`**（行号为改动前的 HEAD `f505a11`，
 * 已用 `grep -n "return null"` 逐处核对：696 / 736 / 740 / 744 / 791 / 801 / 813）。
 * 现在每一处写一个**不同的**码，且**没有任何两处共用一个码**
 * （唯一的例外是 `no_regions_detected` 的三种来源，它靠 `detail` 区分，
 * 见 `LAYOUT_SKIP_CATALOG` 的 `sites`）：
 *
 *   | 改动前 | 条件                                   | 现在的码                  |
 *   |--------|----------------------------------------|---------------------------|
 *   | :696   | `loadLayoutSession()` 内部 catch       | `session_load_failed`     |
 *   | :736   | `!isLayoutAnalysisEnabled()`           | `feature_disabled`        |
 *   | :740   | `!width || !height`                    | `geometry_unusable`       |
 *   | :744   | `!session`                             | `session_load_failed`     |
 *   | :791   | `!detTensor || !numTensor`             | `model_output_missing`    |
 *   | :801   | `!regions.length`                      | `no_regions_detected`     |
 *   | :813   | 外层 catch                             | `inference_failed`        |
 *
 * ⚠️ `:744` 那一处的**判定方式变了但结果没变**：改动前是 `if (!session) return null`，
 * 现在是同一个 `null` 判断下 `return done(null, layoutSkip('session_load_failed', ...))`。
 * 之所以要保留 `!session` 这个判据而不是改成读 `ok`，就是为了让「拿不到会话」
 * 继续走**同一条**代码路径 —— 不变量靠路径不变，不靠新标志位。
 * 与「7 处」的**两处出入**（如实记在这里，代码按实际情况写）：
 *
 *  1. `:696` 与 `:744` **本来就是同一个事件的两种走法**（失败被缓存成
 *     `null` 的 `sessionPromise`，后续页只能从 `:744` 看到 `null`）。
 *     它们共用 `session_load_failed` 是**正确的**：对上层是同一种不可用、
 *     同一个下一步动作。真实原因写在 `detail` 里（`getLayoutSessionLoadError()`
 *     存的那句），所以「模型 404」与「超时」仍然分得开。
 *  2. 另外新增了一个改动前**没有**的观察点：`:813` 的 catch 同时兜住了
 *     `readPixels`（读画布像素）抛错。它发生在「几何尺寸已经合法」之后，
 *     与 `geometry_unusable` 的下一步动作完全不同（查运行环境 vs 查图片尺寸），
 *     因此单独立一个码 `canvas_unreadable` —— 这是**第 8 条出口**，
 *     不是把原来 7 处里的某一处换了个名字。
 *     触发条件：`typeof document === 'undefined'`，或 canvas 建不出 2D 上下文
 *     （见 `readPixels`，`layoutAnalysis.ts:1262` 起）。
 *
 * 这里刻意**不抛异常**：版面分析是增强能力，不该有能力把整次 OCR 弄失败。
 *
 * @param source 与送入 OCR 的**同一张**画布（坐标系必须一致，否则区域对不上词框）
 * @returns `result` 是**区域数据**（可空，`null` = 这一页没有版面信息可用）；
 *   `outcome` 是**这次尝试的结论**（永远有值，`code: 'none'` 表示成功）。
 *   两者由**同一处出口**赋值（见函数内 `done()`），因此不会互相矛盾；
 *   分工是「数据走 `result`、结论走 `outcome`」——
 *   调用点继续用 `layout?.regions` 那种可空写法（与改动前逐字相同），
 *   导出则读 `outcome` 的码。**不要**用 `outcome.ok` 去替代对 `result` 的
 *   判空：那会多出一个可能与数据不一致的标志位，而不变量要求这行不变。
 */
export async function analyzePageLayout(
  source: ImageData | HTMLCanvasElement | OffscreenCanvas,
): Promise<{ result: LayoutAnalysisResult | null; outcome: LayoutAnalysisOutcome }> {
  /**
   * ⚠️ 这里**曾经**有一行 `lastOutcome = undefined`（函数入口清空），
   * 现在删掉了 —— 变异测试实测证明它是**死代码**：
   *
   * 本函数每一条 return 都走下面这个 `done()`，而 `done()` 无条件写记录。
   * 于是「入口清空」与「什么都不做」在**所有可达路径上**产生同一个结果，
   * 把它删掉 21 条用例全绿。留着它只会让注释声称一个并不存在的作用
   * （「不清就会残留上一页的结论」—— 不会，`done()` 已经覆盖了）。
   * 真正保证不残留的是 `done()` 自己。
   */
  /** 每次出口都从这里取一次结果，避免「记录写了但返回值忘了改」这种不一致 */
  const done = (
    result: LayoutAnalysisResult | null,
    outcome: LayoutAnalysisOutcome,
  ): { result: LayoutAnalysisResult | null; outcome: LayoutAnalysisOutcome } => {
    lastOutcome = outcome;
    return { result, outcome };
  };

  if (!isLayoutAnalysisEnabled()) {
    return done(null, layoutSkip('feature_disabled'));
  }

  const width = 'width' in source ? source.width : 0;
  const height = 'height' in source ? source.height : 0;
  if (!width || !height) {
    return done(null, layoutSkip('geometry_unusable', `画布尺寸 ${width}×${height}`));
  }

  try {
    const session = await loadLayoutSession();
    if (!session) {
      // 原因由 `loadLayoutSession` 留在这里（用户看不到 console.warn，
      // 所以那句真实错误必须进导出，否则「404 / 超时 / WASM」不可分辨）
      return done(null, layoutSkip('session_load_failed', getLayoutSessionLoadError() ?? undefined));
    }

    const ort = await import('onnxruntime-web');

    // ── 预处理：拉伸到 480×480 → ImageNet 归一化 → CHW ──────────
    // keep_ratio: false：上游就是**直接拉伸**（不做 letterbox），
    // 因此这里也必须拉伸。做成 letterbox 会让坐标换算与模型预期不一致，
    // 而且不会报错，只会让区域整体偏移。
    //
    // ⚠️ 单独包一层 try：读像素与建张量失败，与「推理抛错」是两件事，
    // 而它们在改动前共用外层那一个 catch（都记成同一句 console.warn）。
    // 包起来的代价是零（不多一次数据拷贝），收益是导出里能分清
    // 「环境读不出画布」与「本页推理挂了」—— 后者的下一步动作是重试，
    // 前者重试一万次也不会好。
    let feeds: Record<string, import('onnxruntime-web').Tensor>;
    try {
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

      feeds = {
        image: new ort.Tensor('float32', chw, [1, 3, LAYOUT_INPUT_SIZE, LAYOUT_INPUT_SIZE]),
        // 检测头用它把预测框除回**原图像素坐标系**（见文件顶部契约说明）
        scale_factor: new ort.Tensor(
          'float32',
          new Float32Array([LAYOUT_INPUT_SIZE / height, LAYOUT_INPUT_SIZE / width]),
          [1, 2],
        ),
      };
    } catch (err) {
      // 读画布像素 / 建张量失败。与下面「推理抛错」分开记：
      // 这一条几乎总是环境问题（无 document、无 2D 上下文、ONNX 张量建不起来），
      // **重试同一页不会变好**，所以要能与 `inference_failed` 分辨。
      console.warn('[layoutAnalysis] 版面分析预处理失败，本页回退到既有几何启发式：', err);
      return done(null, layoutSkip('canvas_unreadable', describeError(err)));
    }

    const outputs = await session.run(feeds);

    // 输出名以实测 protobuf 为准；用位置兜底以防导出方改名
    const values = Object.values(outputs);
    const detTensor = outputs['fetch_name_0'] ?? values[0];
    const numTensor = outputs['fetch_name_1'] ?? values[1];
    if (!detTensor || !numTensor) {
      return done(
        null,
        layoutSkip('model_output_missing', `输出张量名 ${Object.keys(outputs).join('、') || '（无）'}`),
      );
    }

    const numDets = Number((numTensor.data as ArrayLike<number>)[0]);

    /**
     * ⚠️ 用 `decodeLayoutDetectionsDetailed` 而不是 `decodeLayoutDetections`：
     * 前者额外交出「为什么一个区域也没解出来」，那正是导出里
     * `no_regions_detected` 的 `detail` 要写的东西。**区域本身完全一样**
     * （前者内部就是后者的同一个实现，见该函数的注释）。
     */
    const decoded = decodeLayoutDetectionsDetailed(
      detTensor.data as ArrayLike<number>,
      numDets,
      width,
      height,
    );
    const regions = decoded.regions;

    if (!regions.length) {
      /**
       * 三种来源在这里必须被写成**三句不同的话** —— 它们的下一步动作
       * 完全相反（不用管 / 调阈值 / 查坐标换算），而改动前它们全都是
       * `return null`，一个字都没有。
       */
      const why: Record<LayoutDecodeReason, string> = {
        degenerate_input: `张量为空或画布尺寸非法（画布 ${width}×${height}）`,
        no_rows: `模型报 ${numDets} 行有效检测（这一页可能真的没有版面内容）`,
        rejected_rows: '所有行都被丢弃（低于阈值 / NaN / 零面积）',
        center_out_of_bounds: '框的中心落在画布外 —— 查 scale_factor 的坐标换算',
      };
      return done(null, layoutSkip('no_regions_detected', why[decoded.reason ?? 'no_rows']));
    }

    const furniture = regions.filter((r) => isFurnitureLabel(r.label)).length;
    console.info(
      `[layoutAnalysis] 版面区域 ${regions.length} 个` +
        (furniture ? `（其中页面家具 ${furniture} 个：${furnitureSummary(regions)}）` : '') +
        ` · 画布 ${width}×${height}`,
    );

    return done({ regions, width, height }, {
      ok: true,
      code: 'none',
      regionCount: regions.length,
      width,
      height,
    });
  } catch (err) {
    console.warn('[layoutAnalysis] 版面分析失败，本页回退到既有几何启发式：', err);
    return done(null, layoutSkip('inference_failed', describeError(err)));
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
