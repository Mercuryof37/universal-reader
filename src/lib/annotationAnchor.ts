/**
 * 批注锚点升级：**块 ID + 块内字符偏移**。
 *
 * ═══════════════════════════════════════════════════════════════════
 * 一、为什么要有这个模块
 * ═══════════════════════════════════════════════════════════════════
 *
 * 旧锚点（`StableAnchor`）只记"块内偏移 + 前后 15 字指纹"，还原位置靠
 * `utils.resolveAnchor` 的**文本匹配三级降级**。文本匹配有两个固有弱点：
 *
 * 1. **纯搜索会静默跳错位置**：`indexOf(selectedText, offset - 40)` 从**偏移附近**
 *    开始找，找到的第一个匹配就认。段内出现两次同样的文字、或选区前被删掉一段，
 *    批注就会跳到另一处 —— 而调用方无法区分"找到了"和"找错了"。
 * 2. **没有可回跳的稳定标识**：批注只能说"在某个块里"，说不出"在第几页第几块第几个字符"。
 *
 * 本模块的做法是把锚点变成**两层**：
 *
 * - 第一层 `Annotation.locator` —— 块序号 + 块内字符偏移的字符串，跨解析稳定；
 * - 第二层 `Annotation.anchor` —— **原样保留**，作为失配时的降级路径。
 *
 * ═══════════════════════════════════════════════════════════════════
 * 二、定位符的 base 约定（写死，改这里必须同步改测试）
 * ═══════════════════════════════════════════════════════════════════
 *
 * ```
 * doc:{documentId}/page:{pageIdx}/block:{blockIdx}/char:{offset}+{length}
 * ```
 *
 * | 段 | base | 依据 |
 * |---|---|---|
 * | `doc` | 原样 | `DocDocument.id`（`documents` 表主键） |
 * | `page` | **1-based** | 与 `BlockMetadata.pageNumber` 同源，与用户看到的页码一致 |
 * | `block` | **0-based** | `DocDocument.blocks` 数组下标 |
 * | `char` | **0-based** | `block.content` 内的字符偏移（UTF-16 code unit，`\n` 计 1） |
 *
 * ⚠️ **三种格式没有页概念**（md / txt / epub）：`makeLocator` **整段省略** `page:`，
 * 而不是补一个假的 `page:1` —— 定位符是要被用户看见、被导出的字符串，
 * 不能在第 3 段就写一句假话。解析时缺段 → `pageIdx` 返回 `null`。
 *
 * ═══════════════════════════════════════════════════════════════════
 * 三、解析策略：先验证，再修复，最后降级；**错的坐标比没有坐标更糟**
 * ═══════════════════════════════════════════════════════════════════
 *
 * `resolveAnnotationAnchor` 的顺序是：
 *
 * 1. **定位符原位命中** —— 块的 `id` 相同、且 `char` 处**确实**是原文。逐字验证，
 *    不信偏移本身。这一步在"重新解析同一份文档"时必然命中，
 *    且**同一段文字出现两次也能各自锚对**（文本匹配做不到）。
 * 2. **块内小幅修复** —— 文字前后被增删时，找"新旧文本在旧偏移处被切开后
 *    仍然成立"的位置：**左侧是旧前缀、右侧是选区尾部**（见 `collectCandidates`
 *    的前缀边界规则）。证据强度分档，弱证据必须达到阈值（见 `MIN_REPAIR_GAIN`），
 *    分不出高下时**弃权**（见 `AMBIGUITY_MARGIN`）。
 * 3. **旧锚点降级** —— 完整保留迁移前行为（`utils.resolveAnchor`）。
 *    定位符**坏掉**（读不出 / 属于别的文档）也走这一档：那是数据问题，
 *    不该让一条本来能显示的批注变成失锚。
 * 4. **明确报告失锚** —— 返回 `resolved:false`，绝不返回一个猜的位置。
 *
 * `options.searchOtherBlocks` 只给**迁移**用：块序号会在重新解析后整体错位
 * （块 5 的文字变成了块 6），渲染期不做跨块搜索（那会让"跳错块"重新变成可能），
 * 但迁移期允许带证据地重挂块，并把新块 id 一起落盘。
 */

import type {
  Annotation,
  AnnotationLocator,
  ContentBlock,
} from '@/types/content';
import { resolveAnchor } from '@/lib/utils';

// ═══════════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════════

/**
 * 修复量下限（字符）。**只作用于弱证据层（rank 2，仅尾部起点）**。
 *
 * 为什么需要它：只靠"选区尾部出现在这里"定位时，尾部在块内到处都是，
 * 任何一个巧合都会被当成"修复"。要求挪动量达到一个下限，
 * 才能把"真的挪了一段"与"尾部恰好撞上"分开。
 *
 * ⚠️ 为什么**不**把它压在强证据层（前缀边界）上：那一层要求左侧整段旧前缀
 * 逐字对上，证据本身已经足够强。实测教训 —— 一段文字前面插入 5 个字符
 * （挪动量 5 < 8）恰恰是最该命中的情形，若也受阈值限制就会白白失锚。
 *
 * 定值 8 的依据：真实文档里"段首插入编者按 / 页眉被去掉 / OCR 多认一个字"
 * 都远大于 8 个字符；而小于 8 字符的差值更可能是**巧合**而不是真的挪位。
 * ⚠️ 这是**工程判决，不是实测标定值** —— 与 T4 其它数字一样，
 * 需要真实语料才能收紧或放宽。
 */
export const MIN_REPAIR_GAIN = 8;

/**
 * 两份弱证据"分不出高下"的距离上限（字符）。
 *
 * 用途：**只有弱证据（仅尾部）时，如果最近的两个候选离旧位置一样近，就必须弃权。**
 *
 * 为什么：短选区（比如 5 个字的短语）在块内出现两次、且两处离旧位置的距离相同时，
 * 没有任何证据能指出是哪一处 —— 此时选"更近的那个"是**掷硬币**，
 * 而掷错的后果正是本项目 R10 禁止的「错的坐标」。宁可报失锚让用户自己重锚。
 *
 * ⚠️ 只作用于弱证据层：前缀边界是逐字证据，不受这条限制。
 */
const AMBIGUITY_MARGIN = 2;

/** 竞争校验长度：另一处候选右侧这一段必须也像旧选区的开头，才算真正的竞争者 */
const SUFFIX_VERIFY_LEN = 4;

// ═══════════════════════════════════════════════════════════════
// 定位符：构造与解析
// ═══════════════════════════════════════════════════════════════

/** 解析结果：`pageIdx` 为 `null` 表示这份格式没有页概念（不是 0，也不是 1） */
export interface ParsedLocator {
  docId: string;
  /** **1-based**；`null` 表示定位符里没有 `page:` 段（md / txt / epub） */
  pageIdx: number | null;
  /** **0-based**，`blocks` 数组下标 */
  blockIdx: number;
  /** **0-based**，块内字符偏移 */
  charOffset: number;
  /** 选区长度；0 表示点锚点 */
  charLength: number;
}

export interface MakeLocatorInput {
  docId: string;
  /** 1-based 页码；非 PDF 等没有页概念的格式传 `undefined` */
  pageIdx?: number | null;
  /** 0-based 块下标 */
  blockIdx: number;
  /** 0-based 块内字符偏移 */
  charOffset: number;
  charLength: number;
}

/** 页码未知就不写 `page:` 段 —— 见头注释第 2 节 */
function pageSegment(pageIdx: number | null | undefined): string {
  if (pageIdx === null || pageIdx === undefined) return '';
  if (!Number.isFinite(pageIdx)) return '';
  return `/page:${Math.trunc(pageIdx)}`;
}

/** 构造定位符。`doc:` 永远是第 1 段，`page:` 只有拿得到真页码时才出现 */
export function makeLocator(input: MakeLocatorInput): AnnotationLocator {
  const block = Number.isFinite(input.blockIdx) ? Math.trunc(input.blockIdx) : -1;
  const offset = Number.isFinite(input.charOffset) ? Math.max(0, Math.trunc(input.charOffset)) : 0;
  const length = Number.isFinite(input.charLength) ? Math.max(0, Math.trunc(input.charLength)) : 0;
  return `doc:${input.docId}${pageSegment(input.pageIdx)}/block:${block}/char:${offset}+${length}`;
}

/**
 * 解析定位符。**解析不出来一律返回 `null`，不猜、不补默认值。**
 *
 * `char` 段接受两种写法：`char:12+3`（偏移+长度）与 `char:12-15`（起-止，含前不含后），
 * 后者只为读得懂手写/外部工具生成的定位符 —— 本模块自己只写前一种。
 */
export function parseLocator(locator: string | undefined | null): ParsedLocator | null {
  if (typeof locator !== 'string' || !locator.startsWith('doc:')) return null;

  const at = (name: string): string | null => {
    const m = new RegExp(`(?:^|/)${name}:([^/]*)`).exec(locator);
    return m ? m[1]! : null;
  };

  const docId = at('doc');
  if (!docId) return null;

  const blockRaw = at('block');
  if (blockRaw === null || !/^\d+$/.test(blockRaw)) return null;
  const pageRaw = at('page');
  if (pageRaw !== null && !/^\d+$/.test(pageRaw)) return null;

  const charRaw = at('char');
  if (charRaw === null) return null;
  const plus = /^(\d+)\+(\d+)$/.exec(charRaw);
  const minus = /^(\d+)-(\d+)$/.exec(charRaw);
  const bare = /^(\d+)$/.exec(charRaw);
  let charOffset = 0;
  let charLength = 0;
  if (plus) {
    charOffset = Number(plus[1]);
    charLength = Number(plus[2]);
  } else if (minus) {
    // `12-15` 是 [12, 15)，所以长度是差；差为 0 时退化成点锚点
    charOffset = Number(minus[1]);
    charLength = Math.max(0, Number(minus[2]) - Number(minus[1]));
  } else if (bare) {
    charOffset = Number(bare[1]);
    charLength = 0;
  } else {
    return null;
  }

  const pageIdx = pageRaw === null ? null : Number(pageRaw);

  return { docId, pageIdx, blockIdx: Number(blockRaw), charOffset, charLength };
}

// ═══════════════════════════════════════════════════════════════
// 文档侧的小工具
// ═══════════════════════════════════════════════════════════════

/** 1-based 页码；拿不到就是 `undefined`（**绝不返回假页码**） */
export function pageOf(block: ContentBlock | undefined): number | undefined {
  const n = block?.metadata?.pageNumber;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined;
}

/** 块下标；找不到返回 -1 */
export function indexOfBlock(blocks: readonly ContentBlock[], blockId: string): number {
  return blocks.findIndex((b) => b.id === blockId);
}

/** 块内偏移是否是可发送给渲染层的合法区间 */
function isValidRange(start: number, end: number, content: string): boolean {
  return Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start && end <= content.length;
}

/**
 * 只为"调用方只给了一段文本"这条旧路径造块（见 `resolveAnnotationAnchor`）。
 * ⚠️ **不要**把它当成"凭空造一个块"的许可证 —— 生产路径必须传真实块列表。
 */
function syntheticBlock(id: string, content: string): ContentBlock {
  return { id, type: 'paragraph', content, translations: {}, metadata: {} };
}

// ═══════════════════════════════════════════════════════════════
// 构造批注锚点
// ═══════════════════════════════════════════════════════════════

export interface AnchorSource {
  docId: string;
  blocks: readonly ContentBlock[];
  /** 0-based 块下标 */
  blockIdx: number;
  /** 0-based 块内偏移 */
  start: number;
  end: number;
  /**
   * 显式覆盖页码（1-based）。
   *
   * 存在的唯一理由：store 的 `add()` 手里只有"这一块的文本"，没有整篇文档，
   * 拿不到 `metadata.pageNumber`。**不要用它往定位符里塞一个猜的页码** ——
   * 传 `undefined` 就是不写 `page:` 段（这是诚实的写法）。
   */
  pageIdx?: number | null;
  /**
   * 显式覆盖**写进定位符**的块下标（0-based）。
   *
   * 同样只为 `add()` 存在：那里传给 `blocks` 的是一个"只含目标块、下标为 0"
   * 的合成数组（因为手上只有这一块的文本），而定位符里的 `block` 段必须是
   * **文档级**下标 —— 不覆盖的话每条批注都会写成 `block:0`
   * （实测抓到的错误：第二段的批注被写成 `block:0`，重新打开就指到第一段）。
   */
  locatorBlockIdx?: number;
}

/**
 * 由选区生成定位符。**唯一的构造入口** —— store 与迁移都必须走这里，
 * 否则"定位符格式"会在多处各写一遍，改一处漏一处（本项目已有先例）。
 *
 * 返回 `undefined` 的两种情况：块不存在、区间非法。调用方必须能接受"没有锚点"。
 *
 * ⚠️ `locatorBlockIdx` 只是覆盖**写出去的那个数字**；`blocks[blockIdx]` 仍然是
 * 取值来源。两者不一致时以显式值为准 —— 见 `AnchorSource.locatorBlockIdx`。
 */
export function makeAnnotationAnchor(source: AnchorSource): AnnotationLocator | undefined {
  const block = source.blocks[source.blockIdx];
  if (!block) return undefined;
  const content = block.content;
  if (!Number.isFinite(source.start) || !Number.isFinite(source.end)) return undefined;
  if (source.start < 0 || source.end <= source.start || source.end > content.length) return undefined;

  return makeLocator({
    docId: source.docId,
    pageIdx: source.pageIdx ?? pageOf(block),
    blockIdx: source.locatorBlockIdx ?? source.blockIdx,
    charOffset: source.start,
    charLength: source.end - source.start,
  });
}

// ═══════════════════════════════════════════════════════════════
// 还原位置
// ═══════════════════════════════════════════════════════════════

/** 命中方式：定位符原位 / 定位符修复 / 旧锚点文本匹配 */
export type AnchorStrategy = 'exact' | 'repaired' | 'legacy';

export interface AnchorResolution {
  resolved: boolean;
  start: number;
  end: number;
  strategy: AnchorStrategy | null;
  /** 相对旧偏移挪了多少字符（负数 = 往前挪） */
  shiftedBy: number;
  /** 未命中原因，用于侧栏文案 */
  reason: AnchorFailure | null;
}

/**
 * 失锚原因（**用户能看懂的一句话的键**，不是内部错误码）：
 * - `parse-failed` —— 定位符读不出来（外部改过 / 版本不认识）
 * - `doc-mismatch` —— 定位符属于别的文档
 * - `block-missing` —— 所属块在新解析结果里不存在
 * - `stale-offset` —— 定位符的块/偏移都对不上，且块内修复的证据不足或分不出高下
 * - `text-missing` —— 新旧锚点都找不到原文
 * - `no-anchor` —— 这条批注本来就没有选区（整段笔记）
 */
export type AnchorFailure =
  | 'parse-failed'
  | 'doc-mismatch'
  | 'block-missing'
  | 'stale-offset'
  | 'text-missing'
  | 'no-anchor';

const FAIL_MESSAGES: Record<AnchorFailure, string> = {
  'parse-failed': '锚点字符串无法识别，已退回文本匹配',
  'doc-mismatch': '锚点属于另一份文档，已退回文本匹配',
  'block-missing': '原文这一段已不存在',
  'stale-offset': '原文已改动，锚点位置对不上（未强行落位）',
  'text-missing': '原文已改动，无法定位到具体位置',
  'no-anchor': '整段批注（没有选区）',
};

/** 给人看的一句话 */
export function anchorFailureMessage(reason: AnchorFailure): string {
  return FAIL_MESSAGES[reason];
}

const fail = (reason: AnchorFailure): AnchorResolution => ({
  resolved: false,
  start: -1,
  end: -1,
  strategy: null,
  shiftedBy: 0,
  reason,
});

const ok = (
  start: number,
  end: number,
  strategy: AnchorStrategy,
  shiftedBy = 0,
): AnchorResolution => ({ resolved: true, start, end, strategy, shiftedBy, reason: null });

export interface SavedEvidence {
  selectedText: string;
  prefix: string;
  tail: string;
  savedOffset: number;
  /**
   * **推算接点位移**：`候选起点 = savedOffset + derivedShift`。
   *
   * 只从"前缀 + 尾部"在新文本里出现的位置算出来 —— 这是**唯一**允许的位移来源，
   * 因为它完全来自逐字比对，不是一个可以随手调的自由参数。
   * 没有找到这种接点时为 0（表示"假设没挪过"）。
   */
  derivedShift: number;
}

/**
 * 推算"锚点整体挪了多少"。只看一个量：**`旧前缀 ⊕ 尾部` 在新文本里出现的位置**。
 *
 * 为什么这是可靠的：`prefix` 在原文里**恰好结束于选区起点**，所以这段拼接文本
 * 出现在新文本的第 `p` 位时，选区起点就是 `p + prefix.length`，位移随之确定。
 * 找不到（前缀自己被改了、或文字整段没了）就返回 0，交给后面的候选规则。
 *
 * 取**最靠近原位置**的那一次出现：同一段拼接文本可能出现多次，
 * 而"最靠近旧位置"是这里唯一不需要额外假设的选择。
 */
function deriveShift(content: string, prefix: string, tail: string, savedOffset: number): number {
  if (!prefix) return 0;
  let best: number | null = null;
  let from = content.indexOf(prefix);
  while (from !== -1) {
    const at = from + prefix.length;
    if (content.startsWith(tail, at)) {
      const shift = at - savedOffset;
      if (best === null || Math.abs(shift) < Math.abs(best)) best = shift;
    }
    from = content.indexOf(prefix, from + 1);
  }
  return best ?? 0;
}

/** 一个位置候选：位置 + 挪动量 + 证据强度 */
interface Candidate {
  start: number;
  end: number;
  delta: number;
  /**
   * 证据强度（数字越小越强）：
   * - `0` —— **前缀边界**：左侧整段旧前缀逐字对上、右侧接上尾部，且接点与推算位移一致；
   * - `1` —— **仅尾部起点**：只靠尾部本身定位，证据最弱。
   */
  rank: 0 | 1;
}

/**
 * 找出所有"看起来像这条批注原文"的位置（**未按证据强度筛选**）。
 *
 * 两条候选规则，**都是逐字比较**，不用任何模糊匹配：
 *
 * ① **前缀边界**（rank 0）：`新文本在 X 处切开 = 旧前缀 ⊕ 尾部`，
 *    且 `X = savedOffset + derivedShift`（推算位移，见 `deriveShift`）。
 * ② **仅尾部起点**（rank 1）：尾部恰好在 X 处**开始**。
 *
 * ⚠️ 这里**曾经**还有第三条"容差前缀边界"（允许接点偏离推算位置 ±4 个字）。
 * 变异测试把它关掉后 **46 条用例全绿** —— 追下去发现它根本**不可达**：
 * `derivedShift` 就是"前缀在新文本里结束的位置"减旧偏移，所以按定义
 * `content.startsWith(prefix, at - prefix.length)` 在 `at = savedOffset + derivedShift`
 * 处必然成立；再给它加容差只会得到同一个位置。**测不到的分支就是死代码，删掉。**
 *
 * ⚠️ 为什么**不能**用"尾部结束在 X 处、选区从 X 开始"这种错位锚定
 * （这里曾经就是这么写的，是一个**实测抓到的真缺陷**）：
 * 那样选区的尾部可以滑到**选区内部**去 —— 实测中一段文字前面被插入 5 个字符后，
 * 修复判据给出的是"偏差 9"（少算了 4），因为它是拿选区的**最后一个字**去和
 * "选区末尾"对齐的。前缀边界从定义上就排除了这种错位：它要求左侧**整段前缀**
 * 逐字对上，而不只是尾部那几个字。
 */
function collectCandidates(ev: SavedEvidence, content: string): Candidate[] {
  const out: Candidate[] = [];
  const savedOffset = ev.savedOffset;

  if (ev.tail) {
    /*
      ① 前缀边界：前缀在新文本里出现，**且它的结束位置 X 与推算接点一致**
      （`X = savedOffset + derivedShift`）。

      为什么要限定这个接点：`prefix` 只是选区前 15 个字，同一段文字在块内出现
      两次时，这块前缀可能同时出现在**两处**。真正把位置钉死的不是"前缀出现过"，
      而是"前缀在**与位移量相符**的地方接上了尾部"。不限定接点就会出现两个
      都自称精确的候选，然后靠"谁近"随手选一个 —— 那正是本模块要消灭的猜测。
    */
    if (ev.prefix) {
      const at = savedOffset + ev.derivedShift;
      if (
        at >= ev.prefix.length &&
        at <= content.length &&
        content.startsWith(ev.prefix, at - ev.prefix.length) &&
        content.startsWith(ev.tail, at)
      ) {
        out.push({ start: at, end: at + ev.tail.length, delta: ev.derivedShift, rank: 0 });
      }
    }

    // ② 仅尾部起点
    let from = content.indexOf(ev.tail);
    while (from !== -1) {
      out.push({ start: from, end: from + ev.tail.length, delta: from - savedOffset, rank: 1 });
      from = content.indexOf(ev.tail, from + 1);
    }
  }

  return out;
}

/** 同一处可能被多条规则各命中一次，这里合并并保留**最强**的那一条 */
function mergeByStart(candidates: Candidate[]): Candidate[] {
  const byStart = new Map<number, Candidate>();
  for (const c of candidates) {
    const seen = byStart.get(c.start);
    if (!seen) {
      byStart.set(c.start, c);
      continue;
    }
    if (c.rank < seen.rank) seen.rank = c.rank;
  }
  return [...byStart.values()];
}

/**
 * 从证据里挑出**最可信**的位置。
 *
 * 取舍的关键是：**证据强度优先，其次才是"离旧位置多近"，最后才轮到"能不能区分"**。
 *
 * - **rank 0（前缀边界）**：左侧是整段旧前缀、右侧是选区尾部，这是"这两段文字
 *   接在这里"的逐字证据，本身已经足够强 —— 所以**不受 `MIN_REPAIR_GAIN` 限制**。
 *   实测教训：把阈值压在这一层时，一段文字前面插入 5 个字符（挪动量 5 < 8）
 *   会被判成"证据不足"，而它恰恰是最该命中的那种情形。
 * - **rank 1（仅尾部起点）**：只靠尾部（短选区时就是整条选区）定位，证据弱得多，
 *   所以必须挪动量达到 `MIN_REPAIR_GAIN`。
 * - **并列时才弃权**：先挑出"离旧位置最近"的那一个；如果这一组里还有**另一处
 *   同样说得通**的候选（距离差 ≤ `AMBIGUITY_MARGIN`），就没有任何依据选谁 ——
 *   返回 `null`。这是短文字在块内出现两次时的正确行为：**不掷硬币**，
 *   让用户自己重锚。
 *
 * 返回"相对原偏移差了多少"；没有任何候选可用就返回 `null`（调用方报失锚）。
 */
function pickCandidate(ev: SavedEvidence, content: string): { start: number; end: number; delta: number } | null {
  const strong: Candidate[] = [];
  const weak: Candidate[] = [];
  for (const c of mergeByStart(collectCandidates(ev, content))) {
    if (c.rank === 1) {
      if (Math.abs(c.delta) >= MIN_REPAIR_GAIN) weak.push(c);
      continue;
    }
    strong.push(c);
  }

  /** 从一组候选里取"离旧位置最近"的；并列时返回最靠前的那个（顺序确定） */
  const nearest = (list: Candidate[]): Candidate | null => {
    let best: Candidate | null = null;
    for (const c of list) {
      if (!best || Math.abs(c.delta) < Math.abs(best.delta)) best = c;
    }
    return best;
  };

  // 前缀边界（强证据）：不受阈值限制
  const strongBest = nearest(strong);
  if (strongBest) return { start: strongBest.start, end: strongBest.end, delta: strongBest.delta };

  // 仅尾部（弱证据）：必须挪够了；最近的那一处若被另一处几乎同样近的候选追平，就弃权
  const weakBest = nearest(weak);
  if (!weakBest) return null;
  /*
    ⚠️ 这一段是**防御性代码，已知不可达**，写清楚免得后人以为它有测试保护：

    设两处候选为 A < B（尾部都从那里开始），旧偏移为 T。若 B ≤ T，则 A 处候选的
    距离是 0（因为 T 本身就在这段旧文字里），连 `MIN_REPAIR_GAIN` 都过不了、
    根本进不了 weak 列表；若 B > T，则 A ≤ T，A 处候选的距离恰好是 0，
    同样被门槛挡掉。**所以 weak 列表里永远只剩一个候选，不存在"并列"。**

    实测佐证：把这一行注释掉（等于关掉判据）后**全绿**，我尝试了四版夹具都无法
    造出真实可达的并列（能造出来的"并列"都需要旧偏移落在不存在的位置上，
    而那与 `anchor.selectedText` 自身的约束矛盾）。

    留着它的理由：它是 O(候选数) 的纯本地判断，代价可以忽略；而一旦将来的候选
    规则放宽（例如真的引入模糊匹配），它就会重新变成有意义的那道闸。
    **但它现在没有、也无法有测试覆盖 —— 不要把它当成"已被验证的行为"。**
  */
  const rival = weak.find(
    (c) =>
      c !== weakBest &&
      Math.abs(Math.abs(c.delta) - Math.abs(weakBest.delta)) <= AMBIGUITY_MARGIN &&
      // 只有"右边文字也像旧选区"的另一处才算真正的竞争者
      content.slice(c.start, c.start + SUFFIX_VERIFY_LEN) === ev.tail.slice(0, SUFFIX_VERIFY_LEN),
  );
  if (rival) return null;
  return { start: weakBest.start, end: weakBest.end, delta: weakBest.delta };
}

export interface ResolveOptions {
  /**
   * 允许在**别的块**里找原文（只给迁移用）。
   *
   * ⚠️ 渲染期必须留 `false`：跨块搜索会让"批注跳到另一个块"重新成为可能，
   * 而那正是本模块要消灭的行为。迁移期允许，是因为迁移有 `selectedText`
   * 逐字证据、并且会把新块 id 一起写回去（用户下次打开时是一致的）。
   */
  searchOtherBlocks?: boolean;
  /** 当前块之外可搜索的块数上限，防止病态文档把打开动作拖住 */
  maxOtherBlocks?: number;
}

/**
 * 把一条批注还原成当前内容里的区间。
 *
 * `content` 是可选的第 4 个参数，只为兼容"只拿到一段文本"的旧调用方式
 * （`buildStyledSegments` 的旧签名）——见下面合成块那段注释。
 * **生产路径一律传 `blocks`。**
 *
 * **绝不返回"猜的"位置**：所有命中都必须通过逐字验证；
 * 拿不到证据就返回 `resolved:false` + 原因，由调用方标记为失锚。
 */
export function resolveAnnotationAnchor(
  ann: Annotation,
  blocks: readonly ContentBlock[],
  options: ResolveOptions = {},
  content?: string,
): AnchorResolution {
  const selectedText = ann.anchor?.selectedText ?? '';

  // 没有可锚定的文字（整段笔记、或空选区）：在碰定位符之前就下结论 ——
  // 零长度区间绝不能送到渲染层（那会画出一个 0 字符的高亮）
  if (!selectedText) return fail('no-anchor');

  // 走到这里就一定有 anchor（上面那条判据已经把没有的挡掉了）；
  // 单独取一个局部常量，是为了不再出现 `ann.anchor!` 这种"靠人记住"的断言
  const anchor = ann.anchor as NonNullable<Annotation['anchor']>;

  /*
    调用方只给了一段文本、没给块列表时（`buildStyledSegments(content, anns)`），
    用"块 id 相同、内容就是这段文本"的合成块兜底。

    这不是为了方便而开的口子，而是**兼容既有渲染契约**：渲染层本来就是
    "每块各自调用一次"，旧签名只传 content。合成块让"块内字符偏移"
    退化成"这段文本内的偏移"，语义完全一致。

    ⚠️ 但要记住**这是合成块**：合成块永远存在，所以"块不存在"这个结论
    在它身上没有意义（实测教训：忘了这件事时，真实块缺失会退化成一堆
    语焉不详的 `stale-offset`，而原因本该是明确的 `block-missing`）。
  */
  const synthetic = !blocks.some((b) => b.id === ann.blockId);
  const scope: readonly ContentBlock[] = synthetic
    ? [syntheticBlock(ann.blockId, content ?? '')]
    : blocks;

  // ① 定位符路径（新批注、或已迁移的旧批注）
  const locatorOutcome = resolveViaLocator(ann, scope, synthetic);
  if (locatorOutcome.kind === 'hit') return locatorOutcome.resolution;
  if (locatorOutcome.kind === 'fail') return locatorOutcome.resolution;
  // 'degraded' / 'absent' 都继续往下走；degraded 的原因留着，最后报告时用

  // ② 旧锚点文本匹配（迁移前行为，逐字节保留）
  const anchorBlock = scope.find((b) => b.id === ann.blockId);
  if (anchorBlock) {
    const legacy = resolveAnchor(anchor, anchorBlock.content);
    if (legacy && isValidRange(legacy.start, legacy.end, anchorBlock.content)) {
      return ok(legacy.start, legacy.end, 'legacy', legacy.start - anchor.offset);
    }
  }

  // ③ 跨块（**只有迁移会打开**）
  if (options.searchOtherBlocks) {
    const limit = options.maxOtherBlocks ?? 50;
    let scanned = 0;
    for (const block of blocks) {
      if (block.id === ann.blockId) continue;
      if (scanned >= limit) break;
      scanned += 1;
      const recovered = resolveAnchor(anchor, block.content);
      if (recovered && isValidRange(recovered.start, recovered.end, block.content)) {
        return ok(recovered.start, recovered.end, 'legacy', recovered.start - anchor.offset);
      }
    }
  }

  /*
    报告原因时的优先级：**定位符坏掉**这个事实比"旧锚点也找不到"更值得说 ——
    前者是用户能在导出文件里看见的具体问题（定位符字符串坏了），
    后者是一句泛泛的"找不到了"。
  */
  if (locatorOutcome.kind === 'degraded') return fail(locatorOutcome.reason);
  /*
    ⚠️ 合成块下的 `anchorBlock` **永远存在**（那正是"合成"的意思），
    所以不能拿它判断"块还在不在"。调用方给的 blocks 里没有这个块 id，
    唯一诚实的结论就是"这一段已不存在" —— 实测问题：漏了这条判断时，
    "块被删掉"会退化成语焉不详的 text-missing。
  */
  if (synthetic || !anchorBlock) return fail('block-missing');
  return fail('text-missing');
}

/**
 * 定位符路径的四种结局。
 *
 * ⚠️ 为什么必须有 `degraded` 这一档：定位符**坏掉**（读不出来 / 属于别的文档）与
 * **过期**（块没了 / 位置对不上）是两回事。前者说明这份数据本身有问题，
 * 而旧锚点仍然完全可信 —— 此时**必须继续降级**，不能把一条本来能正常显示的批注
 * 判成失锚，那是"新机制坏了就把旧机制的活路一起堵死"。
 * 后者相反：位置真的没了，硬用旧锚点只会跳到错的地方。
 */
type LocatorOutcome =
  | { kind: 'hit'; resolution: AnchorResolution }
  | { kind: 'degraded'; reason: DegradedReason }
  | { kind: 'fail'; resolution: AnchorResolution }
  | { kind: 'absent' };

/** 可以降级到旧锚点的两种原因 */
export type DegradedReason = 'parse-failed' | 'doc-mismatch';

/** 定位符路径；`absent` = 这条批注没有定位符（或调用方用的是合成块），交给旧锚点 */
function resolveViaLocator(
  ann: Annotation,
  blocks: readonly ContentBlock[],
  /** 调用方是否在用合成块兜底（见 `resolveAnnotationAnchor`） */
  synthetic: boolean,
): LocatorOutcome {
  // MUTATION-1 removed
  if (!ann.locator) return { kind: 'absent' };

  const parsed = parseLocator(ann.locator);
  if (!parsed) return { kind: 'degraded', reason: 'parse-failed' };
  if (parsed.docId !== ann.docId) return { kind: 'degraded', reason: 'doc-mismatch' };

  const block = blocks.find((b) => b.id === ann.blockId);
  // ⚠️ 合成块必然"找得到"，所以只有在**真实块列表**上才敢下"块不存在"这个结论
  if (!block) return { kind: 'fail', resolution: fail('block-missing') };
  if (synthetic) {
    // 没有真实块列表 → 这一层什么都验证不了，交给旧锚点路径去处理这段文本
    return { kind: 'absent' };
  }

  const content = block.content;
  const selectedText = ann.anchor?.selectedText ?? '';
  const savedOffset = parsed.charOffset;
  const savedPrefix = ann.anchor?.prefix ?? '';
  const tail = selectedText.slice(Math.max(0, selectedText.length - 15));

  const ev: SavedEvidence = {
    selectedText,
    /**
     * ⚠️ 用**存储里那份前缀**（`anchor.prefix`），不是"新文本在旧偏移处切开"得到的那份。
     *
     * 为什么这是对的：`prefix` 是选区前 15 个字（段首不足 15 时更短），它在原文里
     * **恰好结束于选区起点**。所以"这段文字在新文本里出现、且紧接着就是选区尾部"
     * 是一个极强的位置证据 —— 它把位置钉在**前缀与选区的交界**上。
     *
     * 反过来用"在旧偏移处切开新文本"得到的东西是没有判别力的：
     * 前面被插入 5 个字以后，那份切片里混进了新插入的字，根本不可能在新文本里找到
     * （实测：插入 5 个字时它退化成 `'【编者按】这是一段用于…文'`，
     * 于是最该命中的情形反而被判成失锚）。
     */
    prefix: savedPrefix,
    // 尾部 = 选区的倒数 min(长度, 15) 个字符；旧锚点也是 15 字上下文
    tail,
    savedOffset,
    derivedShift: deriveShift(content, savedPrefix, tail, savedOffset),
  };

  // ① 原位逐字命中
  if (content.startsWith(selectedText, savedOffset)) {
    return { kind: 'hit', resolution: ok(savedOffset, savedOffset + selectedText.length, 'exact', 0) };
  }

  // ② 块内小幅修复
  const picked = pickCandidate(ev, content);
  if (picked && isValidRange(picked.start, picked.end, content)) {
    return { kind: 'hit', resolution: ok(picked.start, picked.end, 'repaired', picked.delta) };
  }

  return { kind: 'fail', resolution: fail('stale-offset') };
}

// ═══════════════════════════════════════════════════════════════
// 迁移
// ═══════════════════════════════════════════════════════════════

export interface MigrationReport {
  /** 是否发生了实际改动（false 时调用方**不要写库**） */
  changed: boolean;
  ok: boolean;
  failure: AnchorFailure | null;
}

const noChange = (failure: AnchorFailure | null): MigrationReport => ({ changed: false, ok: false, failure });

export interface MigrationOptions {
  /** 迁移时间戳（注入以便测试确定化） */
  now?: string;
  /** 允许在别的块里找原文，默认 `true`（迁移有逐字证据，且会把新块 id 一起落盘） */
  searchOtherBlocks?: boolean;
  /** 跨块搜索的块数上限，防止病态文档拖慢"打开文档" */
  maxOtherBlocks?: number;
}

/**
 * 把一条**旧格式**批注升级成"块 ID + 块内字符偏移"。
 *
 * 规则（三条缺一不可）：
 *
 * 1. **只新增、不删除**：`anchor` 原样保留，即使位置挪过也一起更新旧字段
 *    （两个字段必须指向同一处，否则导出/降级会给出互相矛盾的坐标）。
 * 2. **失败不动**：定位失败时**原样返回** `{changed:false, failure}` ——
 *    批注不会被删、不会被改、下次打开会再试一次。失败的批注继续走旧锚点路径，
 *    在侧栏显示"无法定位"，由用户决定。
 * 3. **改过就留痕**：`migration` 记录时间与迁移方式，用户能在侧栏看到升级发生过。
 *
 * 幂等：已经有 `locator` 的批注再调一次不会产生第二次改动。
 */
export function migrateAnnotation(
  ann: Annotation,
  blocks: readonly ContentBlock[],
  options: MigrationOptions = {},
): { annotation: Annotation; report: MigrationReport } {
  if (ann.locator) return { annotation: ann, report: noChange(null) };
  const anchor = ann.anchor;
  if (!anchor || !anchor.selectedText) {
    // 整段笔记没有选区：没有可锚定的文字，永久留在旧路径上（这是正确的，不是失败）
    return { annotation: ann, report: noChange('no-anchor') };
  }

  const resolved = resolveAnnotationAnchor(ann, blocks, {
    searchOtherBlocks: options.searchOtherBlocks ?? true,
    maxOtherBlocks: options.maxOtherBlocks,
  });
  if (!resolved.resolved) return { annotation: ann, report: noChange(resolved.reason) };

  // 命中在哪个块？（跨块搜索可能把批注重挂到别的块上）
  let target = blocks.find((b) => b.id === ann.blockId);
  if (target && !target.content.startsWith(anchor.selectedText, resolved.start)) {
    // 块内偏移对不上 —— 说明这次命中的不是本块
    target = undefined;
  }
  if (!target) {
    target = blocks.find((b) => b.content.slice(resolved.start, resolved.end) === anchor.selectedText);
  }
  if (!target) return { annotation: ann, report: noChange('stale-offset') };

  const blockIdx = indexOfBlock(blocks, target.id);
  if (blockIdx < 0) return { annotation: ann, report: noChange('block-missing') };

  const locator = makeLocator({
    docId: ann.docId,
    pageIdx: pageOf(target),
    blockIdx,
    charOffset: resolved.start,
    charLength: resolved.end - resolved.start,
  });

  const rebased = target.id !== ann.blockId;
  const strategy: 'exact' | 'repaired' | 'rebased' = rebased
    ? 'rebased'
    : resolved.strategy === 'repaired'
      ? 'repaired'
      : 'exact';

  return {
    annotation: {
      ...ann,
      // 跨块重挂时块 id 必须一起改，否则侧栏跳转与高亮会指到两个地方
      blockId: target.id,
      locator,
      anchor: {
        prefix: target.content.slice(Math.max(0, resolved.start - 15), resolved.start),
        suffix: target.content.slice(resolved.end, Math.min(target.content.length, resolved.end + 15)),
        offset: resolved.start,
        length: resolved.end - resolved.start,
        selectedText: anchor.selectedText,
      },
      migration: {
        at: options.now ?? new Date().toISOString(),
        strategy,
        shiftedBy: resolved.start - anchor.offset,
      },
    },
    report: { changed: true, ok: true, failure: null },
  };
}

/** 把一份文档的批注整体迁移一遍（纯函数，不碰数据库） */
export function migrateAnnotations(
  annotations: readonly Annotation[],
  doc: { id: string; blocks: readonly ContentBlock[] },
  options: MigrationOptions = {},
): { annotations: Annotation[]; migrated: number; failed: Array<{ id: string; reason: AnchorFailure }> } {
  const out: Annotation[] = [];
  let migrated = 0;
  const failed: Array<{ id: string; reason: AnchorFailure }> = [];

  for (const ann of annotations) {
    if (ann.docId !== doc.id) {
      // 别的文档的批注不是"迁移失败"，原样带过（调用方本来也不该混着传）
      out.push(ann);
      continue;
    }
    const { annotation, report } = migrateAnnotation(ann, doc.blocks, options);
    out.push(annotation);
    if (report.changed) migrated += 1;
    else if (report.failure) failed.push({ id: ann.id, reason: report.failure });
  }

  return { annotations: out, migrated, failed };
}
