/**
 * ⚠️ **本文件的两个常量由现有 golden 与导出契约推导，不要手改。**
 *
 * ═══════════════════════════════════════════════════════════════════════
 * T5 给导出加了六个信封字段，因此「逐字节相同」这条不变量必须拆成两半
 * ═══════════════════════════════════════════════════════════════════════
 *
 * `pageLayoutInvariant.golden.ts` 里的 `GOLDEN_STRUCTURE_JSON` 是**接入
 * 版面分析之前**那一版的真实输出，它承载的是**不变量**：判定部分
 * （`words` / `lines` / `blocks` / `thresholds` / `truncated` /
 * `wordsWithChars` / `charBoxSkips`）**一个字节都不该变**。
 *
 * 而 T5 的信封（格式身份、生产者、自描述、兼容性）是**新增的元数据**：
 * 它变了不代表判定变了。把两者混在同一个字符串里比对，会导致
 * 「改一行契约说明就红」—— 那种红会训练人「顺手更新 golden」，
 * 而那份 golden 里恰恰包着真正的不变量。所以这里把它们**分开**：
 *
 *  · `LEGACY_DECISION_JSON` —— 从旧 golden 里**扣掉旧信封**
 *    （`kind` / `version` / `buildId`）剩下的部分。新导出的同名字段
 *    必须与它**逐字节相同**（`pageLayoutInvariant.test.ts` 里比对）。
 *  · `GOLDEN_V2_STRUCTURE_JSON` —— 当前格式的**完整快照**
 *    （信封 + 判定部分）。它是**快照，不是不变量**：信封字段合理地会
 *    随契约改动而变，改了要**说明为什么**，而不是无脑重录。
 *
 * ───────────────────────────────────────────────────────────────────────
 * 怎么推导出来的（可核对，不是「我抄了一份当前输出」）
 * ───────────────────────────────────────────────────────────────────────
 *
 *  1. `LEGACY_DECISION_JSON`：把 `GOLDEN_STRUCTURE_JSON` 解析成对象，
 *     删掉 `kind` / `version` / `buildId` 三个旧信封键，再 `JSON.stringify`。
 *     ——旧格式的这三个键恰好就是新格式六个键里的三个对应物，
 *     删掉它们剩下的**就是**「判定部分」这个词的确切含义。
 *  2. `GOLDEN_V2_STRUCTURE_JSON`：同一个对象**原地**补上新信封
 *     （`schema` → `schemaVersion` → `producer` → `document` → `contract`
 *     → `compatibility`，顺序与 `buildOcrStructure` 的 spread 顺序一致），
 *     再 `JSON.stringify`。
 *
 * ⚠️ 信封里的 `contract` 与 `compatibility` **不是抄来的**：它们直接调用
 * `ocrStructure.ts` 里导出产物用的那两个来源（`OCR_STRUCTURE_SELF_DESCRIPTION`
 * 与 `ocrStructureCompatibility()`）。抄一遍说明文字就会出现
 * 「契约改了但快照没变」的假绿 —— 而这正是本项目反复栽过的那类假保护。
 * 手写的只有 `producer`（值来自 `vitest.config.ts` 注入的 `__BUILD_ID__`）
 * 与 `document`（默认 `false`，见 `buildOcrStructure` 的入参说明）。
 *
 * 于是「信封之外的部分与改动前逐字节相同」这条不变量是**结构性成立**的，
 * 而不是靠一次人工比对碰巧成立。测试再从**两个独立方向**核对它：
 * ① 真实跑一遍 `ocrResultToBlocks`，把判定键逐个与 `LEGACY_DECISION_JSON` 比；
 * ② 同一份真实输出与 `GOLDEN_V2_STRUCTURE_JSON` 整串比（顺带钉住键顺序）。
 *
 * 重新生成（只有在**有意**改变契约时才做，且必须在提交信息里写明为什么）：
 *   cd universal-reader
 *   node ../scripts-out/gen-golden.mjs src/lib/ocrStructureContract.golden.ts
 * （该脚本只读 `git show`，无任何 git 写操作。若脚本不在，本文件的两个常量
 *   也可以由上面两条规则手工推出 —— 但**必须**逐条核对推导过程，
 *   不要直接粘贴一次运行输出：那会同时把不该变的部分一起改掉。）
 */
import {
  OCR_STRUCTURE_CONTRACT,
  OCR_STRUCTURE_PRODUCER_NAME,
  OCR_STRUCTURE_SCHEMA,
  OCR_STRUCTURE_SCHEMA_VERSION,
  OCR_STRUCTURE_SELF_DESCRIPTION,
  ocrStructureCompatibility,
} from './ocrStructure';
import { GOLDEN_STRUCTURE_JSON } from './pageLayoutInvariant.golden';

/** 旧格式（`schemaVersion: 0`）信封的三个键 —— 新格式里由六个键取代 */
export const LEGACY_ENVELOPE_KEYS = ['kind', 'version', 'buildId'] as const;

/** 新格式信封的六个键，顺序 = `buildOcrStructure` 里的 spread 顺序 */
export const STRUCTURE_ENVELOPE_KEYS = [
  'schema',
  'schemaVersion',
  'producer',
  'document',
  'contract',
  'compatibility',
] as const;

const legacy = JSON.parse(GOLDEN_STRUCTURE_JSON) as Record<string, unknown>;

/**
 * 旧 golden 的**判定部分**：扣掉旧信封之后剩下的键值。
 *
 * `JSON.parse` 在这里是安全的：旧 golden 是 `JSON.stringify` 的单行输出，
 * 键顺序被保留，且它只含数字/字符串/数组/对象（没有 `undefined`、
 * 没有 `toJSON`），所以「解析 → 扣键 → 再序列化」是**恒等**的。
 */
const legacyDecision: Record<string, unknown> = Object.fromEntries(
  Object.entries(legacy).filter(([k]) => !(LEGACY_ENVELOPE_KEYS as readonly string[]).includes(k)),
);

/** 判定部分的逐字节形式 */
export const LEGACY_DECISION_JSON = JSON.stringify(legacyDecision);

/**
 * 当前格式的完整快照（信封 + 判定部分）。
 *
 * ⚠️ **它是快照，不是不变量。** 与 `GOLDEN_STRUCTURE_JSON` 的区别：
 * 后者一旦变化必须解释「判定为什么变了」，前者变化只需解释「契约为什么变了」。
 */
export const GOLDEN_V2_STRUCTURE_JSON = JSON.stringify({
  schema: OCR_STRUCTURE_SCHEMA,
  schemaVersion: OCR_STRUCTURE_SCHEMA_VERSION,
  producer: { name: OCR_STRUCTURE_PRODUCER_NAME, version: 'test-build' },
  document: { isFullDocument: false },
  contract: OCR_STRUCTURE_SELF_DESCRIPTION,
  compatibility: ocrStructureCompatibility(),
  // ⚠️ 展开的是**扣掉旧信封之后的**判定部分：`{...envelope, ...legacy}` 会把
  // `kind` / `version` / `buildId` 三个旧键带回来，而那正是本版删掉的东西。
  ...legacyDecision,
});

/** 信封里那六个键（真实载荷里它们排在最前） */
export function splitEnvelope(payload: Record<string, unknown>): {
  envelope: Record<string, unknown>;
  decision: Record<string, unknown>;
} {
  const envelope: Record<string, unknown> = {};
  const decision: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if ((STRUCTURE_ENVELOPE_KEYS as readonly string[]).includes(k)) envelope[k] = v;
    else decision[k] = v;
  }
  return { envelope, decision };
}

/** 判定部分的逐字节形式 —— 与 `LEGACY_DECISION_JSON` 同口径 */
export function decisionJsonOf(payload: Record<string, unknown>): string {
  return JSON.stringify(splitEnvelope(payload).decision);
}

// 供测试核对「契约的键顺序 = 快照里的键顺序」用
export const CONTRACT_FIELD_ORDER = Object.keys(OCR_STRUCTURE_CONTRACT);
