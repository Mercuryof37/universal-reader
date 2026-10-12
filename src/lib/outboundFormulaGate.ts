/**
 * 「会把页面像素送出本机」的公式候选：**面积闸门** + 被挡下候选的旁挂记录。
 *
 * ═══════════════════════════════════════════════════════════════
 * 这个闸门补的是哪一个洞（实测，不是推测）
 * ═══════════════════════════════════════════════════════════════
 *
 * 公式候选有**两条来源**：
 *   ① 词聚类 `ocrEngine.detectFormulaRegions`；
 *   ② 「有墨迹、却没有词覆盖」的漏识别区域
 *      `ocrInkRegions.detectMissedInkRegions`。
 *
 * ② 那条路的过滤条件只有 `minCells >= 3` 与 `minInkRatio >= 0.03`
 * （`ocrInkRegions.ts` 的 `DEFAULT_MIN_CELLS` / `DEFAULT_MIN_INK_RATIO`），
 * **没有任何面积上限**；`mergeInkCandidates` 也只是把它原样转成候选
 * （`ocrEngine.ts` 的 `mergeInkCandidates`，漏识别区域那一支）。
 *
 * 实测（本次改动前的探针输出，可复跑）：800×1000 的**全墨迹页面** +
 * 一个 16×16 的词框 → 最大区域覆盖 **100.0% 页面**，引擎**真的发出了
 * 那一次请求**（`POST …/api/formula-ocr`），并把返回的 `$x^{2}+y^{2}$`
 * 当成整页的公式替换词。也就是说整页识别失败或整页插图时，交出去的
 * 那块可以就是整页。此前唯一的上界只有字节数
 * （`formulaOcrService.MAX_IMAGE_SIZE = 2_000_000`）。
 *
 * 对照：**本地重试**那条路**有**面积闸门
 * （`ocrEngine.ts` 的 `RETRY_MAX_REGION_AREA_RATIO = 0.3`，注释写明
 * 「那是插图或整页失败」）—— 但那道闸门只作用于本地推理，
 * **不作用于送 SimpleTex 的那条路**。项目已经认识到「整页失败需要
 * 面积上限」，只是没加在会外发的那条路上。本模块把同一判断加到
 * **发送决定**上。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么是**单独**一个常量，而不是复用 RETRY_MAX_REGION_AREA_RATIO
 * ═══════════════════════════════════════════════════════════════
 *
 * **数值一样（0.3），但两者不是同一个东西，所以是两个常量。**
 *
 *  · 一样的部分：「超过三成页面就不再是一个『洞』」这个判断问的是
 *    「这块区域**是什么**」—— 整页插图 / 整页失败 / 一个漏识别的公式。
 *    两条路问的是同一个问题，依据也是同一批实测（跨行大括号那类真实
 *    漏识别块远小于页面的三成）。**没有实测数据支持另一个数字**，
 *    凭空定一个更严的阈值正是本项目反复吃亏的那种「用一个没验证过的
 *    假设去验证另一个假设」，所以这里沿用 0.3，不假装知道更好的数。
 *  · 不一样的部分：**代价**。本地重试超限只是少花一次本地推理
 *    （还有 8MP 总预算兜底），越界是可恢复的；外发超限意味着
 *    **这些像素永久离开本机**，还要付第三方费用，越界不可撤销。
 *    所以两者必须能被**各自**调整：合成一个常量的话，将来有人为了
 *    让本地重试多救一块把 0.3 改成 0.6，会**顺带**把外发上限也放宽
 *    一倍 —— 一个与隐私无关的调优悄悄改掉隐私上界，正是本项目
 *    一再出现的漂移方式（`outboundPaths.ts` 顶部记着同一类教训）。
 *
 * ⚠️ **诚实标注**：0.3 是**沿用**既有口径，不是新测出来的最优值。
 * 想收紧（例如 0.15）需要先拿到「多行公式系统（cases 环境）在真实页面
 * 上占多大」的分布，那个数据目前没有。本次只做一件确定的事：
 * **把缺失的上界补上**。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么闸门在「发送决定」处，而不是 `mergeInkCandidates` 里
 * ═══════════════════════════════════════════════════════════════
 *
 *  1. `mergeInkCandidates` 只看得见「漏识别区域」这一条来源。词聚类那条
 *     同样可能给出接近整页的框（整页低置信度的词会被聚成一个区域），
 *     把闸门放进去会漏掉它。放在合并之后、发送之前，两条来源一起管住。
 *  2. 判据只依赖「候选框 + 页面尺寸」，两者在发送点都已知；判决因此
 *     发生在 `cropCanvas`（分配画布）与 `recognizeFormula`（发请求）
 *     **之前** —— 被挡下的候选不消耗任何编码与网络成本。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么要有旁挂记录（本项目第 5 次以上的同一个教训）
 * ═══════════════════════════════════════════════════════════════
 *
 * 闸门若只写 `console.warn`，用户就**看不到自己少了什么**：他会看到那道
 * 题里的公式仍然没被救回来，却不知道「应用其实找到了它、只是因为它太大
 * 而选择不外发」—— 现象与「公式增强没开」「SimpleTex 没认出来」
 * 完全一样。所以被挡下的候选按 `ocrCharBoxes` 那套**同一形状**记下来
 * （`recordCharBoxSkip` / `getCharBoxSkips` / `clearCharBoxSkips`），
 * 再由 `lib/ocrStructure.ts` 导出（字段 `outboundFormulaSkips`），
 * 随「复制识别结构」一起交到用户手里。
 *
 * 记录里写的是**可读的结论**（占比、上限、这意味着什么），不是需要回源码
 * 查表的码 —— 教训见 `ocrCharBoxes.ts` 里 `recordCharBoxSkip` 上方的
 * 那段说明（原因只写进 `console.warn`，为此连猜两轮）。
 *
 * ⚠️ 本模块**不 import 任何 store、也不发任何网络请求**：它是一个纯判据
 * 加一块旁挂记录，因此可以被 `ocrEngine`（执行方）与 `ocrStructure`
 * （导出方）同时使用，而不会把 ONNX 运行时拖进导出链路。
 */

/**
 * 候选面积占页面的上限（**含**边界，与 `RETRY_MAX_REGION_AREA_RATIO`
 * 的 `<=` 口径一致）。超过它的候选**不外发**。理由见文件顶部。
 */
export const OUTBOUND_FORMULA_MAX_REGION_AREA_RATIO = 0.3;

/** 候选来自哪条路 —— 诊断里必须能区分，因为两条路的后果不同 */
export type OutboundFormulaCandidateSource = 'word-cluster' | 'missed-ink';

/** 被面积闸门挡下的一个候选（可读结论，由 `ocrStructure` 导出） */
export interface OutboundFormulaSkip {
  source: OutboundFormulaCandidateSource;
  /** 候选框 `[x0, y0, x1, y1]`，页面像素坐标（已取整） */
  bbox: [number, number, number, number];
  /** 候选框面积 ÷ 页面面积（3 位小数；量不出来时是 0） */
  coverage: number;
  /** 页面像素尺寸 —— 没有它，「100%」这个数字无法被核对 */
  page: { width: number; height: number };
  /** 判决用的上限（写进记录，免得将来阈值变了、旧记录被误读） */
  limit: number;
  /** 候选原本代表的文本（词聚类才有）；漏识别区域是空串 */
  text: string;
  /** 一句话结论：发生了什么、为什么、这意味着什么 */
  reason: string;
}

/** 一次准入判决 */
export interface OutboundFormulaAdmission {
  allowed: boolean;
  /** 候选框面积 ÷ 页面面积；量不出来时是 0 */
  coverage: number;
  /** 被挡下时：已经写进旁挂记录的那一条（调用方据此记日志） */
  skip?: OutboundFormulaSkip;
}

/**
 * 被挡下的候选记录。
 *
 * ⚠️ 条数**不需要上限**，理由不是「一页的候选有限」这种含糊说法，而是
 * 一个可以算出来的界：这里只记**超过页面 30%** 的候选，而这样的区域
 * 两两之间最多只能有 `1 / 0.3² ≈ 11` 个互相不重叠的框（框再重叠也不会
 * 更多，因为每个框本身就要占掉三成面积）。一页几十条是不可能的规模。
 */
const skipLog: OutboundFormulaSkip[] = [];

/** 取本页被面积闸门挡下的候选（每页开始时由 `ocrEngine` 清空） */
export function getOutboundFormulaSkips(): OutboundFormulaSkip[] {
  return skipLog.map((s) => ({ ...s, bbox: [...s.bbox] as [number, number, number, number] }));
}

/** 每页开始前清空 —— 否则会跨页累积，读出来的就不是这一页的情况 */
export function clearOutboundFormulaSkips(): void {
  skipLog.length = 0;
}

/**
 * 判决一个公式候选能不能发往云端，**不能时顺带记进旁挂记录**。
 *
 * 名字里的「准入」与 `ocrInkRegions.admitRetryWords` 同一用法：
 * 这个函数就是这条路的入口闸门，调用方不需要自己再判一次
 * （判两次就会出现「日志说挡下了、实际却发了」这种最难查的不一致）。
 *
 * ⚠️ 量不出面积时**按不外发处理**（fail closed）：这条闸门管的是隐私，
 * 少发一块最多是「这一页没救回来」，多发一块则是整整一页像素离开本机 ——
 * 两种错误不对等。真实链路上页面尺寸恒为已知（`recognizePage` 传进来的
 * 就是原图），所以这一支只在输入退化的情形下生效。
 */
export function admitOutboundFormulaCandidate(input: {
  bbox: { x0: number; y0: number; x1: number; y1: number };
  source: OutboundFormulaCandidateSource;
  /** 词聚类候选的原文（会截断）；漏识别区域传空串 */
  text?: string;
  pageWidth: number;
  pageHeight: number;
}): OutboundFormulaAdmission {
  const { bbox, source } = input;
  const text = (input.text ?? '').slice(0, 24);
  const pageArea = input.pageWidth * input.pageHeight;
  const area = (bbox.x1 - bbox.x0) * (bbox.y1 - bbox.y0);

  const measurable = pageArea > 0 && area > 0 && Number.isFinite(pageArea) && Number.isFinite(area);
  const coverage = measurable ? area / pageArea : 0;
  const allowed = measurable && coverage <= OUTBOUND_FORMULA_MAX_REGION_AREA_RATIO;
  if (allowed) return { allowed, coverage };

  const page = { width: input.pageWidth, height: input.pageHeight };
  const limit = OUTBOUND_FORMULA_MAX_REGION_AREA_RATIO;
  const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
  const skip: OutboundFormulaSkip = {
    source,
    bbox: [
      Math.round(bbox.x0),
      Math.round(bbox.y0),
      Math.round(bbox.x1),
      Math.round(bbox.y1),
    ],
    coverage: Math.round(coverage * 1000) / 1000,
    page,
    limit,
    text,
    reason: measurable
      ? `候选覆盖页面 ${percent(coverage)}（上限 ${percent(limit)}，页面 ${page.width}×${page.height}）` +
        `：这个尺寸不像一个漏识别的公式，更像整页插图或整页识别失败。` +
        `为不外发接近整页的像素，这一块**没有**送往 SimpleTex。`
      : `量不出候选或页面的面积（页面 ${page.width}×${page.height}，` +
        `候选框 ${Math.round(bbox.x1 - bbox.x0)}×${Math.round(bbox.y1 - bbox.y0)}）` +
        `：按「量不出来就不外发」处理，这一块**没有**送往 SimpleTex。`,
  };
  skipLog.push(skip);
  return { allowed: false, coverage, skip };
}
