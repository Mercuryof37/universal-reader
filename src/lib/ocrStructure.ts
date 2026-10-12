/**
 * 「识别结构」导出：把一页 OCR 的**原始几何**整理成可复制的 JSON。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么必须有这个出口
 * ═══════════════════════════════════════════════════════════════
 *
 * 上下标（指数、下标）的判据是**纯几何**的：更小、更偏上/偏下、水平紧邻。
 * 而这些阈值此前只在**手工合成的坐标**上验证过 —— 合成词框是我们自己
 * 想象的形状，真实识别器的输出完全可能不一样（高度偏大、位置偏移、
 * 与基字之间有别的词……）。用户的实测结果正是如此：
 * **同一套判据在合成坐标上全绿，在真实扫描件上却完全不生效。**
 *
 * 问题在于那台机器上跑不了浏览器里的推理，所以没法自己造出真实数据 ——
 * 只能让用户把**这一页的真实结构**复制出来。本文件负责把它整理成
 * 「人能看懂、也能直接量」的形状，并**控制体积**（见 `buildOcrStructure`）。
 *
 * ⚠️ 纯本地：这里只做数据整理，不发起任何网络请求，也不写入 IndexedDB。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 【读取契约】判断一份导出的格式，**必须用 `schema` + `schemaVersion` 两个键联合判定**
 * ═══════════════════════════════════════════════════════════════════════
 *
 * ⚠️ **不得只看 `schemaVersion` 的数字。** 数字相同而 `schema` 不同的载荷
 * **不是**同一族格式，按数字猜着读就会把两种不同的东西当成一种。
 *
 * ───────────────────────────────────────────────────────────────────────
 * 依据（MinerU `reference/output_files/`，**只借鉴设计，未引入任何其代码**）
 * ───────────────────────────────────────────────────────────────────────
 *
 *  · 原文：「JSON consumers identify the payload through the **serialized
 *    `schema` and `schema_version` keys**」——**两个键一起**才是身份；
 *  · 原文：「⚠️ **Do not identify a document type from its version number alone.**」
 *  · 原文：「The schema identity is named `schema_id` as a **Python attribute**,
 *    but it **serializes as `schema`**」—— 序列化出来的键名才是契约，
 *    内部属性名不是。本项目的对应物：导出里的键名就是契约（`schema`），
 *    TypeScript 侧的常量名（`OCR_STRUCTURE_SCHEMA`）只是它的副本。
 *  · 原文（`reference/migration_4/`）：「**changing a version number alone does
 *    not migrate a payload**」，且「"Can be read" / "migrated automatically" /
 *    "can re-export every format" 是**三个独立主张**，必须分别对待，
 *    不得由一个推出另一个。」
 *
 * ───────────────────────────────────────────────────────────────────────
 * 与旧键 `kind` / `version` 的关系：**替换，不是并存**
 * ───────────────────────────────────────────────────────────────────────
 *
 * `schema` **取代** `kind`、`schemaVersion` **取代** `version`，旧键**已从导出里删除**。
 * 三条理由：
 *
 *  1. ⭐ **并存会制造一个假的兼容层。** MinerU 的原文写得很直白：
 *     ⚠️「**任何按旧格式写的兼容打算一定落空**」（`reference/migration_4/`：
 *     4.0 只对**专用 Doclib 缓存读取器**做内存内转换，**不扩展到其他入口**，
 *     也**不重写历史文件**）。留下两个身份键，等于让读取方以为
 *     「按 `kind` 也能认出来」——而那正是它**不该**做的推断。
 *  2. **本项目没有存量格式包袱。** `kind`/`version` 从未被任何读取方解析过
 *     （全仓库只有本文件写它、`ocrStructure.test.ts` 断言过它一次），
 *     所以「换名」的真实代价是**零**，而收益是键名与 MinerU 契约对齐。
 *  3. **旧键在旧载荷里仍然是可识别的信号** —— 见 `parseOcrStructure`：
 *     带 `kind: 'universal-reader/ocr-structure'` 的载荷会被判成
 *     **上一代格式（`schemaVersion: 0`）**，走**显式降级**分支。
 *     注意这是「**识别出旧格式**」，不是「旧格式还能按新 schema 读」：
 *     后一种正是第 1 条要避免的假兼容。
 *
 * ───────────────────────────────────────────────────────────────────────
 * 四个标识各回答一个问题（**职责不重叠，都要保留**）
 * ───────────────────────────────────────────────────────────────────────
 *
 *  | 字段 | 回答的问题 | 变了意味着什么 |
 *  |---|---|---|
 *  | `schema` | **这是什么**（格式族身份） | 载荷根本是另一种东西，**必须拒绝** |
 *  | `schemaVersion` | **这份 JSON 该怎么读**（格式版本） | 字段的增减/语义变化，按该版本读 |
 *  | `producer.version` | **哪一个生产程序产出的** | 代码换了一版；**不等于格式变了** |
 *  | `document.isFullDocument` | **这份导出覆盖了多少内容** | 只影响「结论的适用范围」 |
 *
 * ⚠️ 最后一列的三个「不等于」是本契约存在的理由：`producer.version` 变了
 * **不代表** `schemaVersion` 变了，反之亦然（MinerU：「改版本号不等于迁移」）。
 */
import type { ContentBlock } from '@/types/content';
import type { OcrWord } from '@/lib/ocrTypes';
// 字符框不在 `OcrWord` 上 —— 由 `ocrCharBoxes` 用 WeakMap 旁挂，必须显式取。
// 这条例外值得写出来：看上去像"少了一个字段"，其实是刻意的设计。
//
// `buildCharSizeTable` / `charSizeKey` 是**机制 5 那条判据自己用的函数**
// （不是本文件另写一份）：导出里的「页内同字符最大高度」必须与判据同源，
// 否则两边会各自漂移（见 `buildOcrStructure` 里 `sizeTable` 的注释）。
import {
  buildCharSizeTable,
  charSizeKey,
  getAttachedChars,
  getCharBoxSkips,
  type AttachedChars,
  type CharSizeTable,
} from '@/lib/ocrCharBoxes';
// 被「外发面积闸门」挡下的公式候选（`ocrEngine` 写、这里读）。
// ⚠️ 只 import 这个**叶子模块**，不要 import `lib/ocrEngine` ——
// 那个模块会在顶层拉起 ONNX 运行时（`ort.env.wasm...`），
// 把整条导出链路拖进一个几十 MB 的依赖里。
import {
  getOutboundFormulaSkips,
  type OutboundFormulaSkip,
} from '@/lib/outboundFormulaGate';
// 版面分析的结果码。**只取类型与「结果 → 导出字段」两个纯函数** ——
// 本文件不读 `getPageLayoutAnalysis()` 那个模块级记录，理由见下面 `layout` 字段。
import {
  LAYOUT_SKIP_CATALOG,
  layoutOutcomeCode,
  layoutOutcomeDetail,
  type LayoutAnalysisOutcome,
  type LayoutOutcomeCode,
  type LayoutSkipCodeInfo,
} from '@/lib/layoutAnalysis';

/* ═══════════════════════════════════════════════════════════════════════
 * T5 · 导出契约：**schema 双键** + 载荷自描述 + 兼容性说明
 * ═══════════════════════════════════════════════════════════════════════
 *
 * 读取契约写在文件头注释里（那里是接手者一定会看到的位置）。
 * 本节是那份契约的**可执行副本**：所有键名、可缺省性、版本变更记录
 * 都在这里定义一次，由 `(structure as OcrStructureContract)` 那一行
 * **编译期校验**它与 `OcrStructure` 逐键一一对应（漏一个 `tsc -b` 就红）。
 *
 * ⚠️ 为什么必须是「定义一次 + 编译期对齐」，而不是在导出函数里手写这些列表：
 * 手写列表会与真实载荷**漂移**，而漂移之后 `contract.fields` 会变成一句
 * 「听起来很确定」的假话 —— 而读取方正是靠它判断「缺的字段是"没有"
 * 还是"这一版没有"」。本项目已经在「两份同类实现迟早漂移」这条上
 * 栽过多次（见 `buildCharSizeTable` 那段注释），这里不再加一处。
 */

/** 本导出格式的身份。**读取方必须与 `schemaVersion` 联合判定**，见文件头注释 */
export const OCR_STRUCTURE_SCHEMA = 'universal-reader/ocr-structure';

/**
 * 当前格式版本。
 *
 * | 版本 | 状态 | 身份键 |
 * |---|---|---|
 * | **1** | **当前**：`schema` + `schemaVersion` 双键 | `schema` |
 * | 0 | **上一代**：只有 `kind` + `version`（无 `schema`） | `kind` |
 *
 * ⚠️ `0` **不会**被写出来 —— 它只用于**识别旧载荷**（见 `parseOcrStructure`）。
 * 旧载荷自称 `version: 1`，但那与本表的 `1` **不是同一件事**：
 * 数字相同、身份键不同。这正是「不得只看版本号」在本项目里的**具体形态**。
 */
export const OCR_STRUCTURE_SCHEMA_VERSION = 1;

/** 上一代格式的身份串（只在**识别**旧载荷时用到，绝不由本文件写出） */
export const OCR_STRUCTURE_LEGACY_KIND = 'universal-reader/ocr-structure';

/**
 * 生产程序名。**只定义一次**（`envelopeOf` 与快照文件都引用它）——
 * 与「生产版本只放一处」同一条纪律：名字在四个地方各写一遍，
 * 改名时必漏一个，而漏掉的那个会让读取方把同一份数据认成两个来源。
 */
export const OCR_STRUCTURE_PRODUCER_NAME = 'universal-reader';

/**
 * 本导出格式自带的**字段可缺省性**声明。
 *
 * ⚠️ 它不是 JSON Schema、不引入任何依赖：只回答一个二值问题 ——
 * 「按当前格式，这个字段**一定会在**吗？」
 *
 *  · `optional: true`  ⟹ **一定不在**或**在且非空**，二者之一。
 *    于是「字段缺席」一定携带信息（这一步没跑成 / 没试过 / 一个都没挡下），
 *    而不是「可能是空集合」这种读不出结论的状态。
 *  · `optional` 缺省（= 必填）⟹ **永远在**。它可以是空数组 ——
 *    `charBoxSkips: []` 就是一个结论（每个词都拿到了字符框）。
 *
 * ⭐ 这正是「**没有字段 ≠ 字段为空**」这条既有约定在契约里的落点：
 * 契约**不把两者压平**，而是把它们编码成**可判定的**属性，并配一条
 * 由 `buildOcrStructure` 的既有输出**直接证明**的测试
 * （`optional: true` 的字段一旦出现就必须非空）。
 */
export interface OcrStructureField {
  /** 一句话说明这个字段是什么（给人看，不是判据） */
  what: string;
  /** `true` = 该字段只在其内容有意义时才出现，出现即非空 */
  optional?: true;
}

/** 字段名 → 声明。`OcrStructureContract` 要求它与 `OcrStructure` 逐键对齐 */
export type OcrStructureFieldMap = Record<string, OcrStructureField>;

/**
 * 当前格式的全部字段。**每个键都必须存在** ——
 * 因此「某个字段忘了写进契约」是一个**编译错误**，不是一次静默遗漏。
 *
 * ⚠️ **刻意没有索引签名**（`[k: string]: …`）。第一版有，代价是：
 * `keyof` 会被放宽成 `string`，于是「契约里多写一个界面上不存在的字段」
 * **编译不报错**（变异 M16 实测 exit 0）。而那种多写的字段会让
 * `contract.fields` 声明一个永远不会出现的字段 —— 读者据此判断
 * 「缺的字段是这一版没有」时就会得出**错误结论**。
 * 所以「逐键扩宽」那一步挪到了 `OcrStructureFieldMap` 上（见 `contractOf`）。
 */
export interface OcrStructureContract {
  schema: OcrStructureField;
  schemaVersion: OcrStructureField;
  producer: OcrStructureField;
  document: OcrStructureField;
  contract: OcrStructureField;
  compatibility: OcrStructureField;
  pageNum: OcrStructureField;
  canvasHeight: OcrStructureField;
  dominantFontSize: OcrStructureField;
  thresholds: OcrStructureField;
  words: OcrStructureField;
  wordsTotal: OcrStructureField;
  wordsWithChars: OcrStructureField;
  charBoxSkips: OcrStructureField;
  outboundFormulaSkips: OcrStructureField;
  lines: OcrStructureField;
  linesTotal: OcrStructureField;
  blocks: OcrStructureField;
  truncated: OcrStructureField;
  layout: OcrStructureField;
}

/**
 * 契约的唯一来源。
 *
 * 顺序 = 导出里的键顺序 = 读者从上往下读的顺序（身份 → 生产程序 →
 * 覆盖范围 → 自描述 → 兼容性 → 这一页的实测数据）。
 */
export const OCR_STRUCTURE_CONTRACT = {
  schema: { what: '本载荷的格式身份；与 schemaVersion 联合判定，不得只看版本号' },
  schemaVersion: { what: '本载荷的格式版本；回答「该按哪一版读」，不回答「这是什么」' },
  producer: { what: '生产程序的名字与版本；生产版本**只此一处**，不在别处重复' },
  document: { what: '这份导出覆盖了多少内容（是否整份文档）—— 只影响结论的适用范围' },
  contract: { what: '载荷自描述：本格式声明了哪些字段、哪些可以在缺席时仍有意义' },
  compatibility: { what: '本版相对上一版改了什么、有没有破坏性变化（写入时即固化）' },
  pageNum: { what: '页码（从 1 开始）' },
  canvasHeight: {
    what: '画布高度（像素）；判页眉页脚用的就是它。**整页尺寸没量到时缺席**',
    optional: true,
  },
  dominantFontSize: { what: '全页「正文字高」估计（出现次数最多且占比足够高的那个字高）' },
  thresholds: { what: '本次识别**实际生效**的阈值，与上面的实测数据同处一份 JSON' },
  words: { what: '词表（受体积预算截断，截掉多少见 truncated）' },
  wordsTotal: { what: '本页词总数（截断前）—— 与 words.length 的差就是被裁掉的数量' },
  wordsWithChars: {
    what: '拿到字符级框的词数；0 = 字符级定位这一步没跑成（与「字段不存在」含义不同）',
  },
  charBoxSkips: { what: '没拿到字符框的词及各自的原因；**空数组也是一个结论**' },
  outboundFormulaSkips: {
    what: '被外发面积闸门挡下的公式候选；**一个都没挡下时整个字段缺席**',
    optional: true,
  },
  lines: { what: '成行结果（受体积预算截断；wordIndices 指向 words 的下标）' },
  linesTotal: { what: '成行总数（截断前）' },
  blocks: { what: '最终内容块（含 ^{} / _{} 还原后的文本）' },
  truncated: { what: '体积控制的如实说明：被裁掉多少、以及预算本身是多少' },
  layout: {
    what: '本页版面分析的结果；**没接版面分析时整个字段缺席**（「没试过」不是「试过但为空」）',
    optional: true,
  },
} as const satisfies OcrStructureContract;

/** 编译期对齐：契约的键集合必须与 `OcrStructure` 的键集合**完全相同** */
type AssertSameKeys<A, B extends Record<keyof A, unknown>> = keyof B extends keyof A
  ? keyof A extends keyof B
    ? true
    : { 缺少字段声明: Exclude<keyof A, keyof B> }
  : { 多写了不存在的字段: Exclude<keyof B, keyof A> };
/**
 * ⚠️ 上面那一行才是完整的「键集合相同」检查 —— 它**两个方向都管**：
 *  · 界面有了、契约没写 ⟹ 报 `缺少字段声明`；
 *  · 契约写了、界面上没有 ⟹ 报 `多写了不存在的字段`。
 *
 * 这个检查能成立的前提是 `OcrStructureContract` **没有索引签名**
 * （否则 `keyof` 被放宽成 `string`，第二个方向永远为真）。
 */
export type OcrStructureContractAligned = AssertSameKeys<
  OcrStructureContract,
  typeof OCR_STRUCTURE_CONTRACT
>;

/**
 * 生产程序标识。
 *
 * ⚠️ 依据 MinerU 明文：「The producing version is `metadata.producer.version`,
 * **not a duplicate product extension field**」—— 生产版本**只放一处**。
 * 所以本导出里**没有**第二个「构建标识」字段：旧版的顶层 `buildId`
 * 已**合并进这里**（见 `compatibility.changedFields`），
 * 两个字段各存一份构建标识迟早会给出两个不同的答案。
 */
export interface OcrStructureProducer {
  /** 程序名（本项目即产品名） */
  name: string;
  /**
   * 生产程序版本。取值由 `vite.config.ts` 注入的 `__BUILD_ID__`
   * （每次构建不同，因此能唯一对应一次部署）。
   *
   * ⚠️ 它是**程序版本**，不是**格式版本**：程序换一版不代表这份 JSON
   * 该怎么读变了。后者只看 `schemaVersion`。
   */
  version: string;
}

/** 这份导出覆盖了多少内容（MinerU 的 `is_full_document`） */
export interface OcrStructureDocument {
  /**
   * `true` = 覆盖全文；`false` = 只覆盖了一部分（本项目常见：只导出了第一页）。
   *
   * ⚠️ 与 `producer.version` 一样，这个字段只回答「结论能推到多远」：
   * `false` 时**不能**从这一页的数据推断整份文档的性质。
   */
  isFullDocument: boolean;
}

/**
 * 某一个字段「相对上一版怎么了」。
 *
 * `breaking` 的判据（刻意的窄定义）：**上一版的读取方读到这一版会拿到
 * 不同的意思或直接解析失败**。加字段、加可选字段一律不算破坏性。
 */
export interface OcrStructureFieldChange {
  field: string;
  /** `true` = 上一次的读取方**不能再**按老办法读；`false` = 纯增量 */
  breaking: boolean;
  /** 为什么（给人看）。**破例性变化必须写清「旧读取方会怎样」** */
  why: string;
}

/**
 * 本版相对上一版的变更记录。
 *
 * ⚠️ **它是写进产物里的**，不是只写在 HANDOFF 里 —— 拿到一份 JSON 的人
 * 不该为了知道「上一版长什么样」去翻仓库。依据同上：MinerU 把
 * 「能被读 / 被自动迁移 / 能重导出」三种主张分开写进契约，
 * 本项目把「这一版加了什么、有没有破坏性」写进产物，是同一条原则。
 */
export interface OcrStructureCompatibility {
  /** 上一版的格式版本；没有上一版时为 `null`（本格式的第一版） */
  previousSchemaVersion: number | null;
  /** 本版相对上一版是否含**破坏性**变化（任一 changedFields.breaking 为真） */
  breaking: boolean;
  /** 逐字段说明改了什么 —— 包括**删掉的**字段 */
  changedFields: OcrStructureFieldChange[];
}

/**
 * 载荷自描述。
 *
 * ⚠️ 为什么不从载荷本身**现推**字段列表：那样得到的是一句同义反复
 * （「载荷里有这些键」当然成立）。这里的 `fields` 是**声明**，
 * 它要说的是「**按当前格式，这些字段本该在**」—— 于是「声明了但不在」
 * 才是可判定的事实（测试正是这么用的）。
 */
export interface OcrStructureSelfDescription {
  /** 本格式声明的字段（顺序 = 契约里的顺序） */
  fields: string[];
  /** 声明为**可在缺席时仍有意义**的字段（子集） */
  optionalFields: string[];
}

/**
 * 兼容性记录：**本格式第一版**，所以 `previousSchemaVersion: null`。
 *
 * ───────────────────────────────────────────────────────────────────────
 * 为什么 `changedFields` 是**从契约机械推导**的，而不是手写一张清单
 * ───────────────────────────────────────────────────────────────────────
 *
 * 手写清单一共有两种失效方式，本项目两种都见过：
 *  ① **漏**（加了字段忘了记录）——列表看起来很确定，实际上是残缺的；
 *  ② **漂移**（重构改了字段名，清单还是旧的）——读者被指向一个不存在的字段。
 * 所以这里反过来：**清单的骨架由 `Object.keys(OCR_STRUCTURE_CONTRACT)` 生成**，
 * 人手只填两件机器答不了的事 ——「是不是破坏性的」与「为什么」。
 *
 * 于是「加了字段忘了记录」变成了**不可能**：字段一进契约就必然出现在
 * 兼容性记录里，测试还会要求每个被删掉的旧键都有一条 `breaking: true`
 * （`ocrStructure.contract.test.ts`）。
 *
 * ⚠️ 代价要说清：`why` 因此变短了（每个字段一句话）。完整的来龙去脉在
 * 文件头注释与 `HANDOFF.md` 里，**产物里只放「读者做决定需要的那一句」**。
 */
/**
 * 人手要填的**两张小表**之一：每个契约字段「是不是破坏性变化 + 为什么」。
 *
 * ⚠️ 导出是刻意的：`ocrStructure.contract.test.ts` 用它核对
 * 「契约里每个字段都有记录」—— `Record<string, …>` 的索引签名会
 * 让漏写一个键**不报编译错**，所以那道核对只能落在测试里。
 */
export const CONTRACT_FIELD_CHANGES: Record<string, { breaking: boolean; why: string }> = {
  schema: { breaking: false, why: '格式身份键（取代旧版的 kind）' },
  schemaVersion: { breaking: false, why: '格式版本键（取代旧版的 version；两者数值同为 1，但身份键不同）' },
  producer: { breaking: false, why: '生产程序名 + 版本（取代旧版顶层 buildId；生产版本只留一处）' },
  document: { breaking: false, why: '这份导出覆盖了多少内容（是否全文）' },
  contract: { breaking: false, why: '载荷自描述：声明了哪些字段、哪些可以在缺席时仍有意义' },
  compatibility: { breaking: false, why: '本条记录本身（本版相对上一版的变更）' },
  pageNum: { breaking: false, why: '既有字段，语义不变' },
  canvasHeight: { breaking: false, why: '既有字段，语义不变（整页尺寸没量到时缺席）' },
  dominantFontSize: { breaking: false, why: '既有字段，语义不变' },
  thresholds: { breaking: false, why: '既有字段，语义不变' },
  words: { breaking: false, why: '既有字段，语义不变' },
  wordsTotal: { breaking: false, why: '既有字段，语义不变' },
  wordsWithChars: { breaking: false, why: '既有字段，语义不变' },
  charBoxSkips: { breaking: false, why: '既有字段，语义不变（空数组是结论，字段恒在）' },
  outboundFormulaSkips: { breaking: false, why: '既有字段，语义不变（没挡下时整个字段缺席）' },
  lines: { breaking: false, why: '既有字段，语义不变' },
  linesTotal: { breaking: false, why: '既有字段，语义不变' },
  blocks: { breaking: false, why: '既有字段，语义不变' },
  truncated: { breaking: false, why: '既有字段，语义不变' },
  layout: { breaking: false, why: '既有字段，语义不变（没接版面分析时整个字段缺席）' },
};

/**
 * 上一版里**存在、本版已删除**的键。
 *
 * ⚠️ 这几条是本格式对读取方的**全部破坏性变化**，必须显式列出：
 * 「删了什么」是读者最需要知道、而产物本身**看不出来**的事 ——
 * 看不到一个不存在的字段，与「这一版把它删了」从载荷上无法区分。
 */
const REMOVED_FIELDS: OcrStructureFieldChange[] = [  {
    field: 'kind',
    breaking: true,
    why: '已删除，由 schema 取代。⚠️ 按旧格式写的读取方会拿到 undefined —— 不做隐式兼容',
  },
  {
    field: 'version',
    breaking: true,
    why: '已删除，由 schemaVersion 取代。⚠️ 不得只看版本号：旧载荷同样自称 version: 1',
  },
  {
    field: 'buildId',
    breaking: true,
    why: '已删除，由 producer.version 取代。⚠️ 生产版本只放一处，两处迟早漂移成两个答案',
  },
];

/**
 * 本版相对上一版的变更记录。
 *
 * 顺序：**先删后增**（读者最需要先知道「我原来在读的键没了」）。
 *
 * 导出是刻意的：`ocrStructureContract.golden.ts` 用它推导快照，
 * 于是「契约里的说明文字改了、快照没跟上」这件事不可能发生 ——
 * 两处引用的是**同一个函数**，而不是同一段被抄了两遍的字节。
 */
export function ocrStructureCompatibility(): OcrStructureCompatibility {
  const changedFields: OcrStructureFieldChange[] = [
    ...REMOVED_FIELDS,
    ...Object.keys(OCR_STRUCTURE_CONTRACT).map((field) => ({
      field,
      breaking: CONTRACT_FIELD_CHANGES[field]?.breaking === true,
      why: CONTRACT_FIELD_CHANGES[field]?.why ?? '新增字段（未在 CONTRACT_FIELD_CHANGES 里说明）',
    })),
  ];
  return {
    previousSchemaVersion: null,
    breaking: changedFields.some((c) => c.breaking),
    changedFields,
  };
}

/** 本文件的写入侧用它构造信封；读取侧用它判定「声明了哪些字段」 */
function contractOf(): OcrStructureSelfDescription {
  const fields = Object.keys(OCR_STRUCTURE_CONTRACT);
  // 收窄成声明类型后再读 `optional`：`as const satisfies` 保留的是**每个键
  // 各自**的字面量类型，联合类型上没有 `optional` 这个属性。
  const declared: OcrStructureFieldMap = OCR_STRUCTURE_CONTRACT;
  return {
    fields,
    optionalFields: fields.filter((f) => declared[f]?.optional === true),
  };
}

/**
 * 本格式的**自描述**（声明了哪些字段、哪些可以在缺席时仍有意义）。
 *
 * 它既进产物（`contract` 字段），也由快照文件引用 —— 两处引用的是
 * **同一份**数据，所以「契约改了、快照没跟上」不可能发生。
 */
export const OCR_STRUCTURE_SELF_DESCRIPTION: OcrStructureSelfDescription = contractOf();

/**
 * 自描述的**指纹**（JSON 文本的长度 + 一份确定性的 32 位校验和）。
 *
 * ⚠️ 为什么需要一个指纹：`contract.fields` 只装**字段名**，说明文字
 * （`what`）不进产物。于是「改了说明文字」这件事在导出里**看不出来**，
 * 而它恰恰是读取方理解契约的唯一线索 —— 一句悄悄改掉的说明
 * （例如把「缺席 = 没试过」改成「缺席 = 已知为空」）不会被任何测试发现。
 *
 * 这个指纹把「说明文字」也钉住：改了就会红，而红了之后**必须显式
 * 更新这个常量**（那一下正是「说明为什么改」的时机）。
 *
 * ⚠️ 它**不是**安全设施，只是为了让改动无法静默通过 ——
 * 用 FNV-1a 而非加密散列是刻意的：这里要的是「便宜且确定」。
 */
export function ocrStructureSelfDescriptionFingerprint(): string {
  /**
   * ⚠️ 哈希的**输入是契约本身**（含每一条 `what` 说明文字），不是
   * 进产物的那份自描述 —— 后者只装字段名，对它取指纹等于没取
   * （第一版就是这么写的，变异 M11 照样绿）。
   */
  const json = JSON.stringify(OCR_STRUCTURE_CONTRACT);
  return `${json.length}:${fnv1a32(json)}`;
}

/** 确定性 32 位散列（FNV-1a）。只用于「有没有变」，不用于安全用途 */
function fnv1a32(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    // × 16777619，用移位避免超出 32 位整数精度
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * 导出载荷开头的**信封**：格式身份 + 生产程序 + 覆盖范围 + 自描述 + 兼容性。
 *
 * 抽成一个函数而不是内联，是为了让 `fixedCost`（体积预算里那部分固定开销）
 * 与真实载荷**用同一个算式**：内联两遍就会漂移，而漂移的表现是
 * 「预算算小了、导出超了 `charBudget`」这种只在极端页面上才现形的问题。
 */
function envelopeOf(isFullDocument: boolean): {
  schema: typeof OCR_STRUCTURE_SCHEMA;
  schemaVersion: typeof OCR_STRUCTURE_SCHEMA_VERSION;
  producer: OcrStructureProducer;
  document: OcrStructureDocument;
  contract: OcrStructureSelfDescription;
  compatibility: OcrStructureCompatibility;
} {
  return {
    schema: OCR_STRUCTURE_SCHEMA,
    schemaVersion: OCR_STRUCTURE_SCHEMA_VERSION,
    producer: {
      name: OCR_STRUCTURE_PRODUCER_NAME,
      // ⚠️ **生产版本的唯一出现处**（见 `OcrStructureProducer` 的注释）
      version: typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'unknown',
    },
    document: { isFullDocument },
    contract: OCR_STRUCTURE_SELF_DESCRIPTION,
    compatibility: ocrStructureCompatibility(),
  };
}

/** 一个词在页面上的原始形态（字段名刻意取短，便于阅读与对比） */
export interface OcrStructureWord {
  /** 词在 `words` 里的下标，供 `lines[].wordIndices` 引用 */
  i: number;
  text: string;
  confidence: number;
  /** [x0, y0, x1, y1]，像素坐标 */
  bbox: [number, number, number, number];
  /** 识别器给的字高（本项目里等于检测框高度） */
  fontSize: number;
  /** 由 bbox 直接算出的高度 —— 与 `fontSize` 不一致时说明识别器另有口径 */
  height: number;
  /** 中心 y，判上下标时用的就是这个量 */
  centerY: number;
  /**
   * 字符级框。**只有真的拿到时才存在**（见下面 `wordEntries` 里的长注释）。
   * 缺这个字段 = 字符级定位这一步没跑成，而不是"字符框为空"。
   */
  chars?: {
    char: string;
    bbox: [number, number, number, number];
    /**
     * 该字符的识别置信度；`null` = 这一位没有墨迹（空白）或识别多出被跳过。
     *
     * 它是判据里「位置异常 **且** 置信度偏低」那道门的输入，
     * 也是判断那道门到底有没有用的**唯一依据** —— 见下面写出处的注释。
     */
    confidence?: number | null;
    /**
     * ═══════════════════════════════════════════════════════════════
     * 机制 5（按字符自身尺寸）用的三个量 —— 下面三个字段是**一组**
     * ═══════════════════════════════════════════════════════════════
     *
     * **给谁用**：给**下一次改「机制 2（置信度门）与机制 5（按字符自身尺寸
     * 缩小）的关系」的人**用。现在的判据顺序是「几何 → 置信度 → 自身尺寸」，
     * 而真指数 `x+y−2` 的高度比**其实已经算出来了** —— 实测 `x` ≈ 0.35、
     * `2` ≈ 0.50，两者都 < `SCRIPT_MECH5_SCALEDOWN_RATIO`（0.8）；它们
     * **只是被置信度门挡在前面**（那五个字符的逐字符置信度 0.9205–0.9997，
     * 门槛 ≈ 0.91）。也就是说「几何合格 **且** 尺寸比 < 0.8 就算通过」
     * 是一条有实测数字支撑的改法。
     *
     * 但**在动手之前，这些量必须先能被看见**：导出里此前只有
     * `chars[].confidence`，**没有高度比** —— 于是「比值到底是多少」
     * 只能靠推算，而那正是本项目已经栽过三次的坑（同一个错误：用一个
     * 没验证过的假设去验证另一个假设），三次都是靠「把看不见却决定结论的
     * 量变成字段」走出来的：`charBoxSkips` → `charConfidencesComplete`
     * → `chars[].confidence`。这三个字段是同一件事的第四步。
     *
     * ⚠️ 三个字段**永远写出来**（量不到时写 `null`）——「量到了但是 null」
     * 本身就是信息，与「没有这个字段」是两回事（后者见 `chars` 本身：
     * 拿不到字符框的词连 `chars` 都不写）。
     */
    /**
     * 该字符的**像素**墨迹高度（= `bbox[3] - bbox[1]`，画布坐标，1 位小数）。
     *
     * `null` = 这一位**没有墨迹**：空白位（`word.text` 里的空格，对账时
     * 给的是退化框），或识别多出/漏掉、逐列墨迹分析没量到墨迹的位。
     * 判定用的标志与机制 5 建表时**是同一个**：`measurements[i] === null`
     * （= `buildCharSizeTable` 的第 1 条过滤规则）。
     *
     * ───────────────────────────────────────────────────────────────
     * ⚠️ 为什么必须是**像素**高度，而不是 `InkMeasurement.h`（归一化高度）
     * ───────────────────────────────────────────────────────────────
     *
     * `h` 的分母是**本词自己的裁剪高**，而检测框的紧致程度差异极大 ——
     * 同一个 `=`（墨迹高 6.1）在两个词里量出来是：
     *
     *   · 第 1 词（框高 43 → 裁剪高 ≈ 49）：6.1 / 49 ≈ **0.124**；
     *   · 第 16 词（框高 ≈ 23 → 裁剪高 ≈ 27）：6.1 / 27 ≈ **0.226**。
     *
     * 归一化后两者之比 0.124 / 0.226 ≈ **0.55 < 0.8** —— 本该**拒绝**的
     * 第 1 词等号会被判成「被缩小了」而**接受**。像素高度是「墨迹本身有
     * 多高」，两个词的框紧不紧都不影响它，这才是「该字符应有的高度」的
     * 口径（完整算式与依据见 `ocrCharBoxes.buildCharSizeTable` 的注释）。
     */
    inkHeight: number | null;
    /**
     * 机制 5 的分母 `H(c)`：**页内同字符**的最大实测像素高度。
     *
     * 取自机制 5 那张页级表（`ocrCharBoxes.buildCharSizeTable`），
     * 键用同一个 `charSizeKey`（只折全角；**不**折大小写、**不**把 Unicode
     * 上下标归到基字符 —— 每一条都有实测理由，见那个函数的注释）。
     * 因此它与 `inkHeight` **同源同口径**，可以直接相除。
     *
     * `null` 有两种情形，都表示「这个字符在本页没有可用基准」：
     *  1. **整页都没有表**（提供字符框的词少于 `SCRIPT_MECH5_MIN_WORDS`，
     *     机制 5 本来就没启用）→ 这一页每个字符都是 `null`；
     *  2. 这个字符不在表里 —— 它在整页没有留下任何可用的测量值，或者
     *     它**本身即 Unicode 上下标字符**（`²`/`₂`…，建表刻意排除它们：
     *     让「天生就矮」的形态去定义「全尺寸」是语义错误）。
     *     判据对第 2 类走**例外分支直接接受**，根本不查表。
     */
    pageMaxHeight: number | null;
    /**
     * `inkHeight / pageMaxHeight`（3 位小数）—— 就是机制 5 最后那次比较的
     * 左操作数（`px / full < SCRIPT_MECH5_SCALEDOWN_RATIO`）。
     *
     * `null` = 上面两个量有任何一个为 `null`（没有墨迹，或没有基准）。
     * 两个高度各舍入到 0.1px 之后才相除，所以 JSON 里这三个数**自洽**：
     * `heightRatio × pageMaxHeight` 就是 `inkHeight`。
     *
     * 为什么比值比坐标多留 2 位小数：这份真实数据里两个**待定读数**相隔
     * 只有 0.047（`2` 用全页最大 23 → 0.496；只认「21+」那个最保守的
     * 读数 → 0.543）。1 位小数会把两者都写成 0.5，恰好抹掉要看的差别。
     */
    heightRatio: number | null;
  }[];
  /** 整串逐字符置信度是否齐备；缺一个则为 `false`（`AttachedChars` 同一规则） */
  charConfidencesComplete?: boolean;
}

/** 一个词相对**本行基线**的实测几何：定阈值要看的正是这几个数 */
export interface OcrStructureLineStat {
  /** 词在 `words` 里的下标 */
  i: number;
  text: string;
  height: number;
  /** 中心相对本行基线的纵向偏移（正 = 更靠下/更低） */
  centerShift: number;
  /** 大致的基线偏移：按「基线 ≈ 基字下沿」估，正 = 更靠下 */
  baselineShift: number;
  /** 高度相对本行最大字高的比例（指数通常明显小于 1） */
  heightRatio: number;
  /** 与**左边最近一个更高词**的水平间隙，负数表示重叠 */
  gapToHigherLeft: number | null;
}

/** 成行之后的一行 */
export interface OcrStructureLine {
  text: string;
  /** 行中心 y */
  y: number;
  fontSize: number;
  avgConfidence: number;
  /** 该行纵向跨度 [y0, y1] */
  yRange: [number, number];
  /** 该行横向跨度 [x0, x1] */
  xRange: [number, number];
  /** 行内有序的词下标（顺序就是拼成文本的顺序） */
  wordIndices: number[];
  /** 该行是否被包进了上下标（`hasScripts`） */
  hasScripts: boolean;
  /** 只列**可疑的小字**：比本行基线矮 10% 以上的词 */
  stats: OcrStructureLineStat[];
}

/** 整页结构：这就是「复制识别结构」按钮复制出去的东西 */
export interface OcrStructure {
  /* ── T5 信封：格式身份 → 生产程序 → 覆盖范围 → 自描述 → 兼容性 ── */
  /**
   * 格式身份。**必须与 `schemaVersion` 联合判定**（见文件头注释的读取契约）。
   *
   * ⚠️ 它取代了旧版的 `kind` 字段：旧键**已删除**，不是并存。
   * 带 `kind` 的旧载荷由 `parseOcrStructure` 显式降级（`schemaVersion: 0`），
   * 不走「看起来像就解析」。
   */
  schema: typeof OCR_STRUCTURE_SCHEMA;
  /**
   * 格式版本。取值 `1`。
   *
   * ⚠️ 它取代了旧版的 `version` 字段。旧载荷**同样自称 `version: 1`** ——
   * 数字一样而身份键不同，这正是「不得只看版本号」在本项目里的具体形态：
   * `{ version: 1 }` 与 `{ schemaVersion: 1 }` **不是**同一种格式。
   */
  schemaVersion: typeof OCR_STRUCTURE_SCHEMA_VERSION;
  /** 生产程序名 + 版本。**生产版本的唯一出现处**（旧版顶层 `buildId` 已并入） */
  producer: OcrStructureProducer;
  /** 这份导出覆盖了多少内容（是否整份文档） */
  document: OcrStructureDocument;
  /** 载荷自描述：本格式声明了哪些字段、哪些可以在缺席时仍有意义 */
  contract: OcrStructureSelfDescription;
  /** 本版相对上一版改了什么、有没有破坏性变化 */
  compatibility: OcrStructureCompatibility;
  pageNum: number;
  /** 画布高度（像素）；判页眉页脚时用的是它 */
  canvasHeight?: number;
  /** 全页「正文字高」估计（出现次数最多、且占比足够高的那个字高） */
  dominantFontSize: number;
  /**
   * 本次识别实际使用的阈值。
   *
   * 写进来是为了让「阈值」与「实测数据」出现在同一份 JSON 里：
   * 收到这份数据的人可以直接把 `words` 里的高度与偏移和这里对比，
   * 判断阈值是松了还是紧了，而不必再去翻源码猜。
   */
  thresholds: {
    /** 候选要有多小：不超过正文字高的这个倍数 */
    scriptMaxFontRatio: number;
    /** 上标的最小上移量（正文字高倍数） */
    scriptSuperShift: number;
    /** 下标的最小下移量（正文字高倍数） */
    scriptSubShift: number;
    /** 水平紧邻上限（较小字高倍数） */
    scriptFragmentGap: number;
    /** 与基字中心距离上限（正文字高倍数），上标/下标分开 */
    scriptSuperBand: number;
    scriptSubBand: number;
    /** 平桶容差（px）：中心 y 相差不超过它的词算同一行 */
    sameLineTolerance: number;
    /**
     * 行基线拟合：拟合线在样本跨距上的总漂移（|slope| × 行宽）
     * 必须超过分桶容差的这个倍数，否则当平直行处理（判据不动）。
     * 行宽归一 → 对画布缩放不敏感。
     */
    baselineMinDriftRatio: number;
    /** 行基线拟合：残差上限（正文字高倍数） */
    baselineMaxResidualRatio: number;
    /** 倾斜行碎片合并：两段水平间隙上限（正文字高倍数） */
    tiltJoinGapRatio: number;
  };
  /** 所有词 */
  words: OcrStructureWord[];
  wordsTotal: number;
  /** 拿到字符级框的词数；0 表示字符级定位这一步没跑成 */
  wordsWithChars: number;
  /**
   * 没拿到字符框的词及各自的原因（`ocrCharBoxes` 的三个失败出口之一）。
   *
   * ⚠️ **恒存在**，`[]` 也是一个结论（每个词都拿到了字符框）——
   * 与 `outboundFormulaSkips` / `layout` 的缺席语义**刻意不同**，
   * 三者的可缺省性由 `contract.optionalFields` 如实声明，
   * 并由 `ocrStructure.contract.test.ts` 拿真实载荷逐条核对。
   */
  charBoxSkips: { text: string; reason: string }[];
  /**
   * 被**外发面积闸门**挡下的公式候选（`lib/outboundFormulaGate.ts`）——
   * 也就是「找到了、但因为它太大而**没有**发往 SimpleTex」的那些区域。
   *
   * ═══════════════════════════════════════════════════════════════
   * 为什么它必须能被看见
   * ═══════════════════════════════════════════════════════════════
   *
   * 闸门挡下的后果是「这块内容没有被公式增强救回来」，而用户看到的
   * 现象与「公式增强没开启」「SimpleTex 没认出来」**完全一样**：
   * 那道题里仍然少一块。没有这个字段，他只能猜 —— 而「原因写进了
   * 看不见的地方」正是本项目吃过两次亏的那个坑（见 `charBoxSkips`
   * 与 `ocrCharBoxes.ts` 里 `recordCharBoxSkip` 上方的说明）。
   *
   * 记录里给的是**可读的结论**：占比、上限、页面尺寸、以及这意味着什么，
   * 不需要回源码查表。
   *
   * ⚠️ 形状与 `charBoxSkips` 一致，但**缺席语义不同**：
   *   · `charBoxSkips` 恒存在（空数组也是一个结论：每个词都拿到了字符框）；
   *   · 本字段**只在真的挡下过候选时出现**，没有挡下时整个字段缺席。
   * 这么定是为了一条更硬的不变量：`pageLayoutInvariant.test.ts` 要求
   * 「无版面信息时导出与接入前**逐字节相同**」，无条件写一个空数组会让
   * 那份 golden 失效。代价要说清：**「挡下了 0 个」与「公式增强根本没跑
   * （开关关着）」在这份导出里分不出来** —— 两者的区别要去 `layout`
   * 与词表里找线索。这是有意的取舍，不是遗漏。
   */
  outboundFormulaSkips?: OutboundFormulaSkip[];
  /** 成行结果 */
  lines: OcrStructureLine[];
  linesTotal: number;
  /** 最终内容块（含 `^{}`/`_{}` 还原后的文本） */
  blocks: { type: string; content: string; hasInlineMath: boolean }[];
  /** 体积控制的如实说明：被裁掉多少、以及为什么 */
  truncated: { wordsDropped: number; linesDropped: number; charBudget: number };
  /**
   * 本页**版面分析**的结果（是否用上了版面模型 / 没用上的话是为什么）。
   *
   * ═══════════════════════════════════════════════════════════════
   * 为什么这个字段必须存在（本次任务的要点）
   * ═══════════════════════════════════════════════════════════════
   *
   * 用户看不到浏览器控制台 —— 而 `analyzePageLayout()` 此前把**七种**
   * 互不相同的原因全都写进 `console.warn` 后 `return null`。于是用户报
   * 「页眉被多滤掉一行」时，谁也没法判断那是版面模型干的还是几何启发式干的：
   * 前者意味着一个**从未在真实数据上跑过推理**的组件（`HANDOFF.md` §5.11.7）
   * 动了正文，后者只是老问题。
   *
   * 有了 `code`，「是不是版面模型干的」这个问题在**第一页导出的 JSON 里**
   * 就能回答，不需要控制台、不需要复现步骤、不需要猜。
   *
   * ═══════════════════════════════════════════════════════════════
   * 为什么 `code` 是 `'none'` 而不是 `null`（「没有字段 ≠ 字段为空」）
   * ═══════════════════════════════════════════════════════════════
   *
   * 本项目的既有规则是**拿不到的东西就不写字段**（拿不到字符框的词不写
   * `chars`，见 `OcrStructureWord.chars`），而不是写一个空值 —— 因为
   * 「字段不存在」与「字段存在但是空的」是两件不同的事，后者是一个结论。
   * 这里沿用同一原则，三个状态各有确切含义：
   *
   *   | 导出里的样子                    | 含义                                     |
   *   |---------------------------------|------------------------------------------|
   *   | **没有 `layout` 字段**          | 这一页**根本没接版面分析**（调用方没传） |
   *   | `layout.code === 'none'`        | 接了、跑了、**成功了**，区域就是模型给的 |
   *   | `layout.code === '<某个码>'`    | 接了、**失败了**，这一页走的是几何启发式 |
   *
   * 也就是说：**「没用上」不是「没有这个字段」**。前者是 `used: false` 的
   * 一个真实结论，后者是「没试过」。把两者混成同一个形状，就等于把
   * 「开关关着」与「没人调用」混为一谈 —— 那正是本次要消灭的那种含糊。
   *
   * ⚠️ **按 `code` 分支，不要按 `meaning` / `nextAction` 分支。**
   * 后两者是给人看的散文（照 MinerU 那条「不要按 message 里的散文分支」），
   * 措辞随时可能改；`code` 才是稳定契约。类型是 `LayoutOutcomeCode`，
   * 写错在 `tsc -b` 就报错。
   */
  layout?: OcrStructureLayout;
}

/**
 * `OcrStructure.layout` 的确切形状。
 *
 * ⚠️ **刻意不是「每个码一段说明」的完整字典**：那会让每一页导出都背上
 * 一份静态文案（`codeMeanings` 里全是同一批句子）。这里给的是
 * 「**本次实际用到的那个码**」的说明 —— 导出是拿来读的，读者要的是
 * 「这一页为什么没用上、我该做什么」，不是一本手册。
 *
 * 三种状态与 `OcrStructure.layout` 的注释完全一致，这里只补齐类型细节。
 */
export interface OcrStructureLayout {
  /** 真 = 这一页的区域来自版面模型；false = 走了既有几何启发式 */
  used: boolean;
  /**
   * 稳定的结果码：`'none'` = 成功。
   *
   * ⚠️ **`used === false` 时这个字段一定有值**（不是 null、不是 undefined）——
   * 因为「失败」与「没试过」已经由「有没有 `layout` 字段」区分掉了，
   * 走到了这里就一定试过，试过就一定有一个码。
   */
  code: LayoutOutcomeCode;
  /** 成功时：模型给了几个区域 */
  regionCount?: number;
  /** 成功时：区域坐标所在画布的尺寸（与 `canvasHeight` 同一坐标系） */
  width?: number;
  height?: number;
  /**
   * 失败时：**本次这一条**的具体细节（截断到 200 字符）。
   *
   * 用来把「同一个码覆盖的多个失败点」分开 —— 例如
   * `no_regions_detected` 的三个来源靠它区分（见 `meaningOfCode` 的 `sites`）。
   * 没有细节时**不写这个字段**（同上：没有字段 ≠ 字段为空字符串）。
   */
  detail?: string;
  /** `code` 的中文含义（给人看，不是判据） */
  meaning?: string;
  /** `code` 对应的下一步动作（给人看，不是判据） */
  nextAction?: string;
  /** 该码覆盖多个失败点时，逐条点明是哪几个（给人看，不是判据） */
  sites?: string[];
}

/** 取一个码的说明；用不到的信息不写进导出（保持导出可读、体积可控） */
function describeCode(code: LayoutOutcomeCode): LayoutSkipCodeInfo {
  return LAYOUT_SKIP_CATALOG[code];
}

/**
 * 单页结构占用的**字符数上限**。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么必须设上限
 * ═══════════════════════════════════════════════════════════════
 *
 * 词级数据很大：一页扫描件常有八百到两千个词，加上成行结构与
 * 每个词相对基线的实测几何，一页 JSON 轻松到几 MB。
 * 这个对象会**一直留在内存里**（不写 IndexedDB —— 参见 `libraryStore`），
 * 所以不设上限就等于让一次识别多占几 MB 常驻内存，
 * 而本应用已经因为内存吃过多次亏（标签页被系统回收、结果全丢）。
 *
 * 16 万字符约 0.32MB（UTF-16），够装下典型一页的完整词表；
 * 真撞上上限时**先丢词表尾部、再丢行明细**，但 `thresholds`、
 * `dominantFontSize`、`blocks` 与 `truncated` 永远保留 ——
 * 「要拿数据定阈值」这件事不能因为超限而失效。
 *
 * 为什么用「累加每条的 JSON 长度」估算而不是 `JSON.stringify` 后量长度：
 * 后者要先构造完整字符串，正好把我们想省的那份内存又分配一遍。
 */
export const OCR_STRUCTURE_CHAR_BUDGET = 160_000;

/** 只保留「比本行基线矮这个比例以上」的词作为可疑小字，避免整行都进 stats */
const SUSPICIOUS_HEIGHT_RATIO = 0.9;

/**
 * 构造一页的导出结构。
 *
 * 纯函数：输入是识别结果与后处理结果，输出是可直接 `JSON.stringify` 的对象。
 * 不传 `charBudget` 就按 `OCR_STRUCTURE_CHAR_BUDGET` 控体积。
 */
export function buildOcrStructure(input: {
  pageNum: number;
  canvasHeight?: number;
  dominantFontSize: number;
  words: OcrWord[];
  /**
   * 这份导出是否覆盖**全文**（MinerU 的 `is_full_document`）。
   *
   * ⚠️ **默认 `false`**（保守方向）：本函数导出的永远是**一页**，
   * 而「一页 = 全文」只有单页文档才成立。默认 `false` 意味着
   * 「忘了传」时读者只会**低估**结论的适用范围，不会误以为
   * 这一页的数据能代表整份文档 —— 反过来就是一次会误导人的乐观默认。
   * 由 `pdfParser` 在「没有 `maxPages` 上限」时显式传 `true`。
   */
  isFullDocument?: boolean;
  /** 成行结果。`wordIndices` 引用的是 `words` 的下标 */
  lines: {
    text: string;
    y: number;
    fontSize: number;
    avgConfidence: number;
    wordIndices: number[];
    hasScripts: boolean;
  }[];
  blocks: Omit<ContentBlock, 'id'>[];
  thresholds?: Partial<OcrStructure['thresholds']>;
  charBudget?: number;
  /**
   * 本页版面分析的结果。**不传就不写 `layout` 字段**（留下「没试过」这个状态）。
   *
   * ⚠️ 为什么是**显式入参**，而不是在本函数里读 `getPageLayoutAnalysis()`：
   *
   *  1. **确定性。** 读模块级记录意味着导出的内容取决于「谁在什么时候调用过
   *     `analyzePageLayout`」。本函数的注释第一行就写着它是**纯函数** ——
   *     一旦去读全局，这条性质就没了，而「纯」正是它的测试能成立的前提
   *     （`ocrStructure.charSize.test.ts` 全部依赖这一点）。
   *  2. **「导出的是哪一次」必须无歧义。** 传进来的是调用方**当页那一次**
   *     收到的 `outcome`（`pdfParser` 里与 `layout` 同一个 `await` 的解构结果），
   *     所以不存在「每页多次调用时导出的是哪一次」这个问题 —— 它就是
   *     「这一页那一次」。若改成读全局，答案会变成「最后一次调用」，
   *     而那是时序的产物，不是事实。
   *  3. **`used: false` 与「没字段」因此可以精确表达**：传了 → 写字段（附码）；
   *     没传 → 不写字段。全局记录做不到这个区分（读不到与「没试过」同形）。
   */
  layout?: LayoutAnalysisOutcome;
}): OcrStructure {
  const budget = input.charBudget ?? OCR_STRUCTURE_CHAR_BUDGET;

  /**
   * ═══════════════════════════════════════════════════════════════
   * 机制 5 的**页级**字符高度表：复用判据自己那一张，不另建一份
   * ═══════════════════════════════════════════════════════════════
   *
   * `chars[].pageMaxHeight` / `heightRatio` 必须与机制 5 **同源**：
   * 另写一份统计（哪怕口径写得一模一样）迟早会与判据漂移，而漂移之后
   * 导出的数字会「证明」一个判据并没有在做的事 —— 那比没有数据更糟。
   * 所以这里直接调用判据用的那个纯函数 `buildCharSizeTable()`，
   * 输入就是本函数收到的这份 `words`。
   *
   * 为什么重建等于「同一张表」（逐个理由）：
   *  1. `buildCharSizeTable` 是**纯函数**，只读词上旁挂的字符框
   *     （`getAttachedChars`）与 `measurements`，不看行、不看时间、不缓存；
   *  2. `ocrPostProcess.groupWordsIntoLines()` 建表用的是
   *     **同一个数组**（`result.words`）—— 它就是 `ocrResultToBlocks` 之后
   *     交给本函数的那一份；
   *  3. 建行之后到导出之前**没有任何代码修改词或字符框**（页面家具过滤、
   *     构件合并、版面重排动的都是「行」，不是词）。
   * 于是重建出来的表与判据当时用的那张**逐键相同**。这条不变量有测试钉着：
   * `ocrStructure.charSize.test.ts` 里「同一个表」那条用例要求导出中每个
   * 字符的 `pageMaxHeight` 都等于
   * `buildCharSizeTable(words)!.get(charSizeKey(char))`。
   *
   * ⚠️ 为什么**不**把表直接传进来（那才是最字面的"同一张"）：
   * 表是 `groupWordsIntoLines()` 的局部量。要把它交出来，得改
   * `groupWordsIntoLines` → `ocrResultToBlocks` → `buildOcrStructure`
   * 三处签名，也就动了**判据链路**本身的形状。而本任务的前提是
   * 「不改任何判据」—— 「同一个纯函数 + 同一份输入」是零风险的等价物。
   *
   * 拿不到表时（提供字符框的词少于 `SCRIPT_MECH5_MIN_WORDS`）机制 5
   * 本来就不启用：导出里所有字符的 `pageMaxHeight` / `heightRatio` 都是
   * `null` —— 那不是「量到了但是空」，而是**这一页没有基准**。
   */
  const sizeTable = buildCharSizeTable(input.words);

  const wordEntries: OcrStructureWord[] = input.words.map((word, i) => {
    const height = word.bbox.y1 - word.bbox.y0;
    return {
      i,
      text: word.text,
      confidence: Math.round(word.confidence),
      bbox: [round(word.bbox.x0), round(word.bbox.y0), round(word.bbox.x1), round(word.bbox.y1)],
      fontSize: round(word.fontSize),
      height: round(height),
      centerY: round((word.bbox.y0 + word.bbox.y1) / 2),
      /**
       * 字符级框（如果这一页拿到了）。
       *
       * ═══════════════════════════════════════════════════════════════
       * 为什么必须导出它
       * ═══════════════════════════════════════════════════════════════
       *
       * 字符级定位是判断上下标的**唯一依据**，而它整条链路都是
       * 「拿不到就静默退回旧行为」（见 `ocrEngine.attachCharBoxes` 的注释）。
       * 这个设计对用户是对的 —— 少一个字符框不该让整页识别失败；
       * 但**对诊断是灾难**：导出里若没有字符框，就分不清
       * 「功能没跑」「跑了但识别器建不起来」「跑了但没判出上下标」。
       *
       * 实测撞上过这一点：导出的 JSON 里既没有字符框、文本里也没有 `^{}`，
       * 于是完全无从判断是哪一种。加字段比猜便宜得多。
       *
       * ⚠️ 字符框**不在 `word` 上**：`ocrCharBoxes` 刻意用 `WeakMap` 旁挂
       * （没有字符框的词一个额外属性都不加），必须经 `getAttachedChars()` 取。
       * 没有字符框时**不写这个字段**（而不是写空数组）——
       * 「没有字段」与「有字段但为空」是两种不同的事实，前者说明这步没跑成。
       */
      ...(getAttachedChars(word)?.chars?.length
        ? {
            chars: getAttachedChars(word)!.chars.map((c, i) => ({
              char: c.char,
              bbox: [round(c.x0), round(c.y0), round(c.x1), round(c.y1)] as [
                number,
                number,
                number,
                number,
              ],
              /**
               * ⚠️ 每字符置信度必须能看见，否则关于它的每一次讨论都是猜测。
               *
               * 这是被一个真实失败逼出来的字段：上下标判据里那道「位置异常
               * **且** 识别置信度偏低」的门，在用户文档上没挡住 `=`、`+`、`∼`
               * —— 而这些字符**天生**就是识别器没把握的字形。当时要判断是
               * 「系数不对」还是「这个维度根本没用」，**手里一个真实数值都没有**，
               * 只能拿构造数据论证，结果用假设验证了假设。
               *
               * 口径（见 `CtcDecoded.confidences`）：该字符全部触发时间步上
               * argmax 概率的平均值，与 `measurements` 逐位对齐。
               * 空白位与「识别多出被跳过」的位是 `null`。
               */
              confidence: Number.isFinite(getAttachedChars(word)!.confidences?.[i])
                ? Math.round((getAttachedChars(word)!.confidences![i] as number) * 1e4) / 1e4
                : null,
              /**
               * 机制 5 的三个量（像素墨迹高 / 页内同字符最大高 / 两者之比）。
               *
               * ⚠️ 它们**必须**与 `confidence` 放在同一个对象里：判据正是
               * 「置信度足够低 **且** 尺寸比足够小」这条合取式，而下一个要
               * 回答的问题就是「这两个条件该怎么组合」—— 把两个量分放在
               * 两处，就等于又要靠推算去拼它们。三个字段的语义、口径与
               * `null` 的边界见接口声明处的长注释。
               */
              ...charSizesOf(getAttachedChars(word)!, i, sizeTable),
            })),
            // 整串置信度是否齐备，一眼可见：缺一个就不写（与 `AttachedChars` 同一规则）
            charConfidencesComplete: Boolean(getAttachedChars(word)!.confidences),
          }
        : {}),
    };
  });

  /** 本页拿到字符框的词数 —— 一眼看出这一步到底跑没跑成 */
  const wordsWithChars = wordEntries.filter((w) => w.chars?.length).length;

  const lineEntries: OcrStructureLine[] = input.lines.map((line) => {
    const ws = line.wordIndices
      .map((i) => input.words[i])
      .filter((w): w is OcrWord => w !== undefined);
    const heights = ws.map((w) => w.bbox.y1 - w.bbox.y0);
    const maxHeight = heights.length ? Math.max(...heights) : 0;
    // 「本行基线」用**最高的那个词**估计：上下标的定义就是「比它更小」
    const baseWord = ws.find((w) => w.bbox.y1 - w.bbox.y0 === maxHeight);
    const baseCenter = baseWord ? (baseWord.bbox.y0 + baseWord.bbox.y1) / 2 : line.y;
    const baseBottom = baseWord ? baseWord.bbox.y1 : line.y;
    const x0s = ws.map((w) => w.bbox.x0);
    const x1s = ws.map((w) => w.bbox.x1);
    const y0s = ws.map((w) => w.bbox.y0);
    const y1s = ws.map((w) => w.bbox.y1);

    return {
      text: line.text,
      y: round(line.y),
      fontSize: round(line.fontSize),
      avgConfidence: round(line.avgConfidence),
      yRange: [
        round(y0s.length ? Math.min(...y0s) : line.y),
        round(y1s.length ? Math.max(...y1s) : line.y),
      ],
      xRange: [round(x0s.length ? Math.min(...x0s) : 0), round(x1s.length ? Math.max(...x1s) : 0)],
      wordIndices: [...line.wordIndices],
      hasScripts: line.hasScripts,
      stats: line.wordIndices
        .map((i) => {
          const word = input.words[i];
          if (!word) return null;
          const height = word.bbox.y1 - word.bbox.y0;
          if (!(maxHeight > 0) || height >= maxHeight * SUSPICIOUS_HEIGHT_RATIO) return null;

          // 与「左边最近的那个更高的词」的水平间隙：上下标总是紧贴基字，
          // 而**谁是基字**正是最难判的地方，所以把候选与它的间隙一并给出。
          // 找不到更高的词时给 null，而不是编一个 0 —— 数据要如实。
          let left: OcrWord | undefined;
          for (const o of ws) {
            if (o === word) continue;
            if (o.bbox.x1 > word.bbox.x0) continue;
            if (o.bbox.y1 - o.bbox.y0 <= height) continue;
            if (!left || o.bbox.x1 > left.bbox.x1) left = o;
          }

          return {
            i,
            text: word.text,
            height: round(height),
            centerShift: round((word.bbox.y0 + word.bbox.y1) / 2 - baseCenter),
            baselineShift: round(word.bbox.y1 - baseBottom),
            heightRatio: round(height / maxHeight),
            gapToHigherLeft: left ? round(word.bbox.x0 - left.bbox.x1) : null,
          };
        })
        .filter((s): s is OcrStructureLineStat => s !== null),
    };
  });

  const blocks = input.blocks.map((b) => ({
    type: b.type as string,
    content: b.content,
    hasInlineMath: b.metadata.hasInlineMath === true,
  }));

  // ── 体积控制：按预算依次装填，装不下的如实记进 `truncated` ──
  //
  // 顺序刻意是「词表 → 行明细」：要定上下标阈值，最需要的是一页全部词的
  // 高度与位置；行明细是二次加工的结果，缺一部分不影响定量。
  // 而 `thresholds` / `dominantFontSize` / `blocks` 不参与取舍，永远完整。
  //
  // ⚠️ T5 起，信封（`envelopeOf`）也算进固定开销 —— 与真实返回值用
  // **同一个算式**：`JSON.stringify` 的键顺序在这里不参与判定（只量长度），
  // 所以「信封 + 这几个字段」就是最终载荷里不参与取舍的那一部分。
  // 信封只有几百字符，对 16 万预算无实质影响，但算漏它就等于
  // `truncated.charBudget` 与实际产出对不上账。
  const envelope = envelopeOf(input.isFullDocument ?? false);
  const fixedCost = JSON.stringify({
    ...envelope,
    pageNum: input.pageNum,
    canvasHeight: input.canvasHeight,
    dominantFontSize: round(input.dominantFontSize),
    thresholds: thresholdsOf(input.thresholds),
    blocks,
  }).length;

  let used = fixedCost + 64; // 留一点给外层字段名与 truncated
  const keptWords: OcrStructureWord[] = [];
  for (const entry of wordEntries) {
    const cost = JSON.stringify(entry).length + 1;
    if (used + cost > budget) break;
    used += cost;
    keptWords.push(entry);
  }

  const keptLines: OcrStructureLine[] = [];
  for (const entry of lineEntries) {
    const cost = JSON.stringify(entry).length + 1;
    if (used + cost > budget) break;
    used += cost;
    keptLines.push(entry);
  }

  /**
   * 被外发面积闸门挡下的候选。**只取一次**（读两次会得到两份不同的副本，
   * 而且让「有没有挡下」这个判断看起来像两个独立事实）。
   */
  const outboundFormulaSkips = getOutboundFormulaSkips();

  return {
    /**
     * ═══════════════════════════════════════════════════════════════
     * T5 信封。**放在最前面**是有意的：读者从上往下读到的第一个东西
     * 就是「这是什么、该按哪一版读、能不能读」——
     * 而不是先读几千行词表、读到最后才发现格式不认得。
     * ═══════════════════════════════════════════════════════════════
     *
     * ⚠️ `envelope` 是在上面算 `fixedCost` 时**同一个对象**
     * （同一个 `envelopeOf(...)` 调用），这里 spread 展开，
     * 所以「预算里算的信封」与「实际写出的信封」不可能不一致。
     *
     * ⚠️ 信封里**没有**「构建标识」的第二个副本：旧版的顶层 `buildId`
     * 已并入 `producer.version`（依据：MinerU「生产版本只放一处」）。
     * 那一个字符串仍然回答「你跑的是哪一版」——§5.12.11 那条待查缺陷
     * 要用的判据一个都没少，只是换了位置与名字。
     */
    ...envelope,
    pageNum: input.pageNum,
    /**
     * 画布高度。**拿不到时整个字段缺席**（不是写 `undefined`、更不是写 0）。
     *
     * ⚠️ T5 顺手修掉的一处不一致：此前它是无条件写的，于是
     * 「`canvasHeight: undefined`」在对象里**存在**、`JSON.stringify` 之后
     * 又**消失** —— 同一个字段在内存里与在导出里是两种形状，而
     * `contract.optionalFields` 声明的是「可在缺席时仍有意义」。
     * 现在两者一致：**不在**就是不在，导出与对象同形。
     * （`pageLayoutInvariant` 的 golden 走的是传了 1400 那条路径，
     *   所以逐字节不变量不受影响。）
     */
    ...(input.canvasHeight !== undefined ? { canvasHeight: input.canvasHeight } : {}),
    dominantFontSize: round(input.dominantFontSize),
    thresholds: thresholdsOf(input.thresholds),
    words: keptWords,
    wordsTotal: wordEntries.length,
    /**
     * 拿到字符级框的词数。
     *
     * **0 与「字段不存在」含义不同**，所以这里单独给一个计数：
     *   · `wordsWithChars > 0` → 字符级定位跑通了；
     *   · `wordsWithChars === 0` → 没跑通（识别器建不起来，或被降档画布等前置条件挡住）。
     * 有了它，下一次导出就能一眼分清"功能没生效"与"生效了但没判出上下标"。
     */
    wordsWithChars,
    /**
     * 取不到字符框的词**各自的原因**。
     *
     * 没有它时，导出只能说明「8/23 拿到了」，而这个事实**不足以定位问题** ——
     * 实测为此连猜两轮（先猜词太宽超出模型上限，被 44px 短词也失败的数据否掉）。
     * 原因本来是采集了的，只是写进了 `console.warn`，而用户看不到控制台。
     */
    charBoxSkips: getCharBoxSkips(),
    lines: keptLines,
    linesTotal: lineEntries.length,
    blocks,
    truncated: {
      wordsDropped: wordEntries.length - keptWords.length,
      linesDropped: lineEntries.length - keptLines.length,
      charBudget: budget,
    },
    /**
     * 版面分析的结果。**`input.layout` 为 undefined 时整个字段缺席** ——
     * 与上面的原则一致：「没试过」不是「试过但为空」。三种状态见
     * `OcrStructure.layout` 的注释（这是本次任务要「看得见」的那个字段）。
     */
    ...(input.layout ? { layout: layoutOf(input.layout) } : {}),
    /**
     * 被**外发面积闸门**挡下的公式候选。**空数组时整个字段缺席** ——
     * 理由（以及这个取舍的代价）写在 `OcrStructure.outboundFormulaSkips`
     * 上方的长注释里：无条件写空数组会让
     * `pageLayoutInvariant.test.ts` 的逐字节 golden 失效。
     */
    ...(outboundFormulaSkips.length ? { outboundFormulaSkips } : {}),
  };
}

/* ═══════════════════════════════════════════════════════════════════════
 * T5 · **读取侧**：判定一份载荷能不能按本格式解析
 * ═══════════════════════════════════════════════════════════════════════
 *
 * 只有写入侧的契约是**不可验证的**：写了双键，但没有任何代码按双键判定，
 * 那么「两个键都要有」就只是一句注释。下面这三个函数是同一份契约的
 * **读取侧实现**，它们的三个出口正好对应 MinerU 兼容性矩阵的三行：
 *
 * | 载荷 | 处置 | 本项目的出口 |
 * |---|---|---|
 * | 带**当前** `schema` 标识、`schemaVersion` 本版认识 | **严格读取** | `current` |
 * | 上一代格式（只有 `kind` + `version`，无 `schema`） | 仅**显式降级**，不按新格式读 | `downgraded` |
 * | `schemaVersion` 相同但 `schema` 不同 / 认不出的版本 | **拒绝** | `rejected` |
 *
 * ⚠️ 第三行是本次任务的核心负向用例（T5 验收标准 2）。MinerU 的原文：
 * 「带当前标识但**校验失败**的载荷**不会被当作旧格式重试**」——
 * 所以「像」不够，`schema` 必须**逐字符相等**。
 */

/** 拒绝 / 降级的稳定原因码。**按码分支，不要按 message 分支** */
export type OcrStructureParseCode =
  /** 不是对象 / 没有键 —— 连「是什么」都答不了 */
  | 'not_an_object'
  /** 有 `schema` 键，但它不是本格式（**只看版本号就会在这里读错**） */
  | 'wrong_schema_id'
  /** `schema` 对，但 `schemaVersion` 不是本版认识的数字 */
  | 'unknown_schema_version'
  /** 没有 `schema`，但带着上一代的 `kind` —— 能识别出它是旧格式 */
  | 'legacy_kind'
  /** 没有 `schema` 也没有 `kind` —— 无从判断，当作未知 */
  | 'unknown_payload';

/** 降级时逐条列出「这一版没有、所以读不到」的东西 */
export interface OcrStructureDowngradeNote {
  /** 读者的版本 */
  from: number;
  /** 能按哪一版读 */
  to: number;
  /** 按 `to` 版读会**拿不到**的字段（当前格式新引入的） */
  unavailableFields: string[];
  /** 为什么降级是安全的（而不是「猜着读」） */
  why: string;
}

/** 判定结果。三个出口**互斥**，且都带稳定原因码 */
export type OcrStructureParseResult =
  | {
      ok: true;
      status: 'current';
      /** 唯一的成功出口：这份载荷就是本格式本版本 */
      payload: OcrStructure;
    }
  | {
      ok: true;
      status: 'downgraded';
      code: 'legacy_kind';
      /** 旧载荷原文（**不按新格式解读**，见 `unavailableFields`） */
      payload: Record<string, unknown>;
      note: OcrStructureDowngradeNote;
    }
  | {
      ok: false;
      status: 'rejected';
      code: Exclude<OcrStructureParseCode, 'legacy_kind'>;
      /** 给人看的解释（**不是判据**） */
      message: string;
    };

/** `Object.keys` 拿不到数组/字符串的键，先做一层类型收窄 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * 判定一份载荷（对象或 JSON 文本）能否按本格式解析。
 *
 * ⚠️ **两个键联合判定**，这是本函数的全部要点：
 *
 *  1. 先看 `schema`（**是什么**）—— 不等就是另一种东西，直接 `rejected`，
 *     **绝不**因为 `schemaVersion` 恰好等于本版就去读它；
 *  2. `schema` 正确后再看 `schemaVersion`（**第几版**）—— 认不出就拒绝；
 *  3. 两个键都没有、但有旧版的 `kind` → **显式降级**（`schemaVersion: 0`），
 *     并把「按 0 版读会少什么」列出来。
 *
 * 传字符串时自己 `JSON.parse`，解析失败也走 `rejected`（原因码 `not_an_object`）——
 * 这一条是给「用户粘贴回来的 JSON」用的。
 */
export function parseOcrStructure(input: unknown): OcrStructureParseResult {
  let raw: unknown = input;
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input);
    } catch {
      return {
        ok: false,
        status: 'rejected',
        code: 'not_an_object',
        message: '这不是合法 JSON，无法判断格式。',
      };
    }
  }

  const obj = asRecord(raw);
  if (!obj) {
    return {
      ok: false,
      status: 'rejected',
      code: 'not_an_object',
      message: `载荷不是对象（拿到 ${Array.isArray(raw) ? 'array' : typeof raw}），无法判断格式。`,
    };
  }

  const schema = obj['schema'];
  if (typeof schema === 'string') {
    /**
     * ⚠️ **关键分支**：有 `schema` 键但值不是本格式 ⟹ 拒绝。
     *
     * 这里刻意**不看** `schemaVersion` 的数字 —— 那正是 MinerU
     * 「Do not identify a document type from its version number alone」
     * 要禁止的推断。数字相同只说明「作者碰巧用了同一个数字」。
     */
    if (schema !== OCR_STRUCTURE_SCHEMA) {
      return {
        ok: false,
        status: 'rejected',
        code: 'wrong_schema_id',
        message:
          `schema 是 ${JSON.stringify(schema)}，本格式是 ${JSON.stringify(OCR_STRUCTURE_SCHEMA)}；` +
          `schemaVersion=${JSON.stringify(obj['schemaVersion'])} 相同的载荷**也不**按本格式解析（不得只看版本号）。`,
      };
    }

    // `schema` 正确之后才轮到版本号
    if (obj['schemaVersion'] !== OCR_STRUCTURE_SCHEMA_VERSION) {
      return {
        ok: false,
        status: 'rejected',
        code: 'unknown_schema_version',
        message:
          `schema 正确，但 schemaVersion=${JSON.stringify(obj['schemaVersion'])} ` +
          `不是本版认识的 ${OCR_STRUCTURE_SCHEMA_VERSION} —— 拒绝按本版解析（不猜字段布局）。`,
      };
    }

    return { ok: true, status: 'current', payload: obj as unknown as OcrStructure };
  }

  /**
   * 没有 `schema`。旧格式的判据是**它自己的身份键** `kind` ——
   * 这也是「两个键都要有」的反面：旧载荷**只有**一对旧键。
   *
   * ⚠️ 注意它自称的 `version` 是 `1`，与 `schemaVersion: 1` 数字相同。
   * 把数字当身份，就会在这里把旧载荷读成新载荷 —— 本分支存在的意义
   * 就是让那件事**不可能**发生。
   */
  if (obj['kind'] === OCR_STRUCTURE_LEGACY_KIND) {
    return {
      ok: true,
      status: 'downgraded',
      code: 'legacy_kind',
      payload: obj,
      note: {
        from: typeof obj['version'] === 'number' ? obj['version'] : 0,
        to: 0,
        unavailableFields: ['schema', 'schemaVersion', 'producer', 'document', 'contract', 'compatibility'],
        why:
          '按上一代格式（kind + version）读：它的判定数据（words / lines / blocks / thresholds）' +
          '与当前格式**同名同义**，所以那一部分可以读；' +
          '⚠️ 但信封字段（生产者版本、是否全文、自描述、兼容性）在那一代**根本不存在**，' +
          '不得当成「空」或「默认值」填补 —— 它们回答的是「能不能按这个 schema 解析」，' +
          '而那正是旧格式无法回答的问题。',
      },
    };
  }

  return {
    ok: false,
    status: 'rejected',
    code: 'unknown_payload',
    message: '既没有 schema 键，也没有可识别的 kind 键 —— 无从判断格式，拒绝解析。',
  };
}

/**
 * 结果 → 导出字段。
 *
 * 教训来自 `charBoxSkips`、`producer.version`（旧称 `buildId`）这两处：诊断信息必须是**可读的结论**，
 * 而不是「一个需要回源码查表才知道什么意思的码」。用户不会去翻 GitHub，
 * 所以该码的**含义**与**下一步动作**跟着一起进导出。
 *
 * ⚠️ 随码带进来的 `meaning` / `nextAction` / `sites` 是**给人看的散文**，
 * 不是判据 —— 代码里任何地方都不得按它们分支（按 `code`）。
 * 这也是为什么它们放在同一个对象里却排在 `code` 之后。
 */
function layoutOf(outcome: LayoutAnalysisOutcome): OcrStructureLayout {
  const code = layoutOutcomeCode(outcome);
  const detail = layoutOutcomeDetail(outcome);
  const info = describeCode(code);

  return {
    used: outcome.ok,
    code,
    // 成功才有区域数/尺寸；失败时这两项没有意义，**不写**（不是写 0）
    ...(outcome.ok
      ? {
          regionCount: outcome.regionCount,
          width: outcome.width,
          height: outcome.height,
        }
      : {}),
    ...(detail ? { detail } : {}),
    meaning: info.meaning,
    nextAction: info.nextAction,
    ...(info.sites ? { sites: [...info.sites] } : {}),
  };
}

/**
 * 阈值默认值在这里**复制一份**，而不是从 `ocrPostProcess` 导入。
 *
 * 原因：导出结构要能被独立读懂 —— 收到 JSON 的人不该为了知道
 * 「0.9 到底是哪个阈值」再去翻源码。代价是两处可能漂移，
 * 因此 `ocrPostProcess` 在调用时会把真实值显式传进来，
 * 这里的默认值只用于「没传」的兜底，且两者由单元测试锁住一致。
 */
const DEFAULT_THRESHOLDS: OcrStructure['thresholds'] = {
  scriptMaxFontRatio: 0.9,
  scriptSuperShift: 0.25,
  scriptSubShift: 0.18,
  scriptFragmentGap: 0.6,
  scriptSuperBand: 1.5,
  scriptSubBand: 1.2,
  sameLineTolerance: 5,
  baselineMinDriftRatio: 1,
  baselineMaxResidualRatio: 0.35,
  tiltJoinGapRatio: 1.5,
};

function thresholdsOf(over?: Partial<OcrStructure['thresholds']>): OcrStructure['thresholds'] {
  return { ...DEFAULT_THRESHOLDS, ...over };
}

/** 坐标保留 1 位小数：像素级数据到 0.1px 已经足够定阈值，还能省掉大量字符 */
function round(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 10) / 10;
}

/**
 * 比值保留 3 位小数。
 *
 * 为什么比坐标（1 位）多留 2 位：机制 5 在这份真实数据上有两个**待定读数**
 * 相隔只有 0.047 —— 指数里的 `2`（墨迹高 11.4）：用全页最大 `2`（23）算
 * 得 **0.496**，只认「21+」那个最保守的读数则是 **0.543**。1 位小数会把
 * 两者都写成 0.5，恰好抹掉下次要看的那个差别（判据离阈值 0.8 有多远，
 * 全靠这个数）。多 2 位小数的代价是每个字符多几个字节，可以忽略。
 */
function roundRatio(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 1000) / 1000;
}

/**
 * 一个字符的「机制 5 三个量」。
 *
 * 口径与判据**逐条对齐**（不是近似、也不是另写一遍统计）：
 *
 *  · `inkHeight`：`chars[i].y1 - chars[i].y0` —— 与 `buildCharSizeTable`
 *    放进表里的那个像素高**是同一个算式**；`measurements[i]` 为 `null`
 *    （空白位 / 没量到墨迹）时给 `null`，那正是建表的第 1 条过滤规则。
 *    由 `measureCharPixelSpans` 保证「量到墨迹 ⟹ `y1 > y0`」，所以
 *    非 `null` 的 `inkHeight` 一定是正数（有测试钉着这条）。
 *  · `pageMaxHeight`：`sizeTable.get(charSizeKey(char))` —— 连键的算法都是
 *    同一个 `charSizeKey`（只折全角；不折大小写、不归 Unicode 上下标）。
 *  · `heightRatio`：`inkHeight / pageMaxHeight`，即判据最后那次比较的左操作数。
 *
 * 唯一的差别是**显示精度**：两个高度各舍入到 0.1px（本文件既有的省体积
 * 做法），比值再由舍入后的两个数算出。这样做的好处是 JSON 里的三个数
 * **自洽**：`heightRatio × pageMaxHeight` 就是 `inkHeight`，
 * 拿导出数据复核判据的人不必怀疑「这三个数为什么对不上」。
 */
function charSizesOf(
  attached: AttachedChars,
  i: number,
  sizeTable: CharSizeTable | null,
): { inkHeight: number | null; pageMaxHeight: number | null; heightRatio: number | null } {
  const box = attached.chars[i];
  if (!box) return { inkHeight: null, pageMaxHeight: null, heightRatio: null };

  const inkHeight = attached.measurements[i] ? round(box.y1 - box.y0) : null;

  const full = sizeTable?.get(charSizeKey(box.char));
  const pageMaxHeight = typeof full === 'number' && full > 0 ? round(full) : null;

  const heightRatio =
    inkHeight !== null && pageMaxHeight !== null ? roundRatio(inkHeight / pageMaxHeight) : null;

  return { inkHeight, pageMaxHeight, heightRatio };
}
