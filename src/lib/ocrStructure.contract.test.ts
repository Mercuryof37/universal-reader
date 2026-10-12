import { describe, expect, it, vi } from 'vitest';

import { ocrResultToBlocks } from '@/lib/ocrPostProcess';
import type { LayoutAnalysisOutcome } from '@/lib/layoutAnalysis';
import type { OcrPageResult, OcrWord } from '@/lib/ocrTypes';
import {
  CONTRACT_FIELD_CHANGES,
  OCR_STRUCTURE_CHAR_BUDGET,
  OCR_STRUCTURE_CONTRACT,
  OCR_STRUCTURE_LEGACY_KIND,
  OCR_STRUCTURE_SCHEMA,
  OCR_STRUCTURE_SCHEMA_VERSION,
  OCR_STRUCTURE_SELF_DESCRIPTION,
  buildOcrStructure,
  ocrStructureCompatibility,
  ocrStructureSelfDescriptionFingerprint,
  parseOcrStructure,
  type OcrStructure,
} from '@/lib/ocrStructure';
import { FIXTURE_WORDS } from '@/lib/pageLayoutInvariant.golden';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * T5 · 导出契约：**schema 双键** + 载荷自描述 + 兼容性说明
 * ═══════════════════════════════════════════════════════════════════════
 *
 * 本文件只验**契约本身**，不重复验判定逻辑（那些在 `ocrStructure.test.ts`
 * 与 `pageLayoutInvariant.test.ts` 里）。
 *
 * ───────────────────────────────────────────────────────────────────────
 * 两个方向都必须测（T5 硬性要求 1）
 * ───────────────────────────────────────────────────────────────────────
 *
 *  · **正向**：当前版本的导出被判成 `current`，拿得到载荷；
 *  · **负向**：旧版本 / 未知 schema 的导出被**明确拒绝或明确降级**，
 *    而不是「看起来像就解析」。
 *
 * ⚠️ 每个负向用例都走 `parseOcrStructure` 的**真实分支**，并断言它的
 * **稳定原因码**（`code`）—— 不是断言「存在某个字段」。这一点在本项目
 * 已经踩过 5 次以上：断言「有 schema 字段」在**任何**实现下都成立，
 * 只有断言「走的是 `wrong_schema_id` 分支」才证明拒绝真的发生了。
 *
 * ───────────────────────────────────────────────────────────────────────
 * 本文件怎么避开那三类假保护
 * ───────────────────────────────────────────────────────────────────────
 *
 *  ① **不读别的测试改过的当前值**：下面所有载荷都是**本文件现场造的**
 *     局部对象（`currentPayload()` / `legacyPayload()`），不是模块级
 *     可变状态，也不依赖执行顺序。两个会读全局的用例
 *     （`producer.version` 跟构建标识、`outboundFormulaSkips` 的出现条件）
 *     都**显式 mock 并在 `afterEach` / `finally` 里恢复**。
 *  ② **不用 `toMatch(/名字/)` 那种会匹配到 import / 注释的断言**：
 *     对源码取词的断言一律**按行取、丢掉注释行**之后再比对
 *     （见最后一个 describe；HANDOFF §5.10.8 记着这个坑踩过三次）。
 *  ③ **断言分支，而不是断言字段存在**：负向用例一律断言 `status` + `code`。
 */

/**
 * ⚠️ 本模块被**显式 mock**，为了拿到对「外发面积闸门」这一路旁挂记录的
 * 控制权。理由：`outboundFormulaSkips` 读的是模块级记录，不 mock 的话
 * 那条用例验的其实是「别的用例有没有在这之前挡下过候选」——
 * 正是本文件注释里说的第 ① 类假保护。
 *
 * `vi.mock` 被提升到 import 之前，所以工厂里只能引用 `vi.hoisted` 造的状态。
 */
const gateState = vi.hoisted(() => ({ skips: [] as unknown[] }));

vi.mock('@/lib/outboundFormulaGate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/outboundFormulaGate')>();
  return { ...actual, getOutboundFormulaSkips: () => gateState.skips };
});

/** 现场造一份「当前版本」的导出（与 `buildOcrStructure` 是同一种形状） */
function currentPayload(over: Partial<OcrStructure> = {}): Record<string, unknown> {
  return {
    schema: OCR_STRUCTURE_SCHEMA,
    schemaVersion: OCR_STRUCTURE_SCHEMA_VERSION,
    producer: { name: 'universal-reader', version: 'some-build' },
    document: { isFullDocument: false },
    contract: OCR_STRUCTURE_SELF_DESCRIPTION,
    compatibility: ocrStructureCompatibility(),
    pageNum: 1,
    dominantFontSize: 20,
    thresholds: {},
    words: [],
    wordsTotal: 0,
    wordsWithChars: 0,
    charBoxSkips: [],
    lines: [],
    linesTotal: 0,
    blocks: [],
    truncated: { wordsDropped: 0, linesDropped: 0, charBudget: OCR_STRUCTURE_CHAR_BUDGET },
    ...over,
  };
}

/**
 * 现场造一份**上一代格式**的导出：只有 `kind` + `version` + `buildId`。
 *
 * ⚠️ 它的 `version` 是 **1** —— 与 `schemaVersion: 1` 数字相同。
 * 这正是「不得只看版本号」在本项目里的判别性输入：任何按数字判定的实现
 * 都会把它读成新格式，而它**不是**。
 */
function legacyPayload(): Record<string, unknown> {
  return {
    kind: OCR_STRUCTURE_LEGACY_KIND,
    version: 1,
    buildId: 'old-build-42dd59f',
    pageNum: 1,
    dominantFontSize: 20,
    words: [],
    wordsTotal: 0,
    wordsWithChars: 0,
    charBoxSkips: [],
    lines: [],
    linesTotal: 0,
    blocks: [],
    truncated: { wordsDropped: 0, linesDropped: 0, charBudget: OCR_STRUCTURE_CHAR_BUDGET },
  };
}

const w = (text: string, x: number, y: number, h: number, width = 30): OcrWord => ({
  text,
  confidence: 90,
  bbox: { x0: x, y0: y, x1: x + width, y1: y + h },
  fontSize: h,
});

const page = (words: OcrWord[]): OcrPageResult => ({
  pageNum: 1,
  words,
  avgConfidence: 90,
  pageText: '',
});

const normalWords = (): OcrWord[] => [w('设', 40, 88, 20, 20), w('函数', 70, 88, 20, 40)];

/** 抓一次**真实**导出（经 `ocrResultToBlocks` 的第 7 个参数接线） */
function captureReal(
  options: {
    words?: OcrWord[];
    isFullDocument?: boolean;
    layout?: LayoutAnalysisOutcome;
    passIsFullDocument?: false;
  } = {},
): Record<string, unknown> {
  let captured: Record<string, unknown> | undefined;
  ocrResultToBlocks(
    page(options.words ?? normalWords()),
    1400,
    (structure) => {
      captured = JSON.parse(JSON.stringify(structure)) as Record<string, unknown>;
    },
    undefined,
    options.layout,
    undefined,
    // `passIsFullDocument: false` 用来走「这个参数根本不传」的那条路
    options.passIsFullDocument === false ? undefined : options.isFullDocument,
  );
  if (!captured) throw new Error('结构没有被交出来');
  return captured;
}

describe('T5 正向：当前版本的导出能被识别为可解析', () => {
  it('真实导出带齐 schema 双键、producer、document.isFullDocument 四个字段', () => {
    const payload = captureReal();

    expect(payload.schema).toBe('universal-reader/ocr-structure');
    expect(payload.schemaVersion).toBe(1);
    expect(payload.producer).toEqual({ name: 'universal-reader', version: 'test-build' });
    expect(payload.document).toEqual({ isFullDocument: false });
  });

  it('真实导出能被 parseOcrStructure 判成 current，并原样拿回载荷', () => {
    const payload = captureReal();

    const result = parseOcrStructure(payload);

    // ⚠️ 断言的是**分支**（status）以及它给出的载荷，不是「有 schema 字段」
    expect(result.status).toBe('current');
    if (result.status !== 'current') throw new Error('预期 current');
    expect(result.ok).toBe(true);
    expect(result.payload.schemaVersion).toBe(1);
    expect(result.payload.wordsTotal).toBe(2);
    // 原样返回：读取方拿到的就是这份对象，不是「重建的一份等价物」
    expect(result.payload).toBe(payload);
  });

  it('`schema` 与 `schemaVersion` 两个键都要对：这是双键，不是「版本号 + 一个字符串」', () => {
    // 两个键各自都对 → 通过
    expect(parseOcrStructure(currentPayload()).status).toBe('current');
    // 缺任一个都不通过（逐条见负向 describe）
    const noSchema = currentPayload();
    delete noSchema.schema;
    expect(parseOcrStructure(noSchema).status).toBe('rejected');

    const noVersion = currentPayload();
    delete noVersion.schemaVersion;
    expect(parseOcrStructure(noVersion).status).toBe('rejected');
  });

  it('JSON 文本也能判定（用户是把 JSON 粘贴回来的，不是把对象递回来的）', () => {
    const result = parseOcrStructure(JSON.stringify(captureReal()));

    expect(result.status).toBe('current');
  });

  it('真实 fixture 的导出也能判定为 current（不是只在小载荷上成立）', () => {
    const result = parseOcrStructure(captureReal({ words: FIXTURE_WORDS.map((x) => ({ ...x })) }));

    expect(result.status).toBe('current');
    if (result.status !== 'current') throw new Error('预期 current');
    expect(result.payload.wordsTotal).toBe(FIXTURE_WORDS.length);
  });
});

describe('T5 负向：旧版本 / 未知 schema 必须被明确拒绝或明确降级', () => {
  it('⚠️ `schemaVersion` 相同但 `schema` 不同 ⟹ **拒绝**（不得按版本号猜着读）', () => {
    const impostor = { ...currentPayload(), schema: 'universal-reader/ocr-structure-v2' };

    const result = parseOcrStructure(impostor);

    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('预期 rejected');
    // 走的是**这个**分支，而不是「别的拒绝」
    expect(result.code).toBe('wrong_schema_id');
    // 而且它明确说出了「版本号相同也不认」这件事
    expect(result.message).toContain('universal-reader/ocr-structure-v2');
    expect(result.message).toContain('不得只看版本号');
  });

  it('`schema` 对、`schemaVersion` 是未来版本 ⟹ 拒绝（不猜字段布局）', () => {
    const result = parseOcrStructure({ ...currentPayload(), schemaVersion: 2 });

    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('预期 rejected');
    expect(result.code).toBe('unknown_schema_version');
  });

  it('`schemaVersion` 是 0 ⟹ 拒绝（0 是**旧格式的代号**，不是一个可读的新版本）', () => {
    const result = parseOcrStructure({ ...currentPayload(), schemaVersion: 0 });

    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('预期 rejected');
    expect(result.code).toBe('unknown_schema_version');
  });

  it('⚠️ 上一代格式（kind + version）⟹ **显式降级**，不是按新格式读', () => {
    const legacy = legacyPayload();
    const result = parseOcrStructure(legacy);

    expect(result.status).toBe('downgraded');
    if (result.status !== 'downgraded') throw new Error('预期 downgraded');
    expect(result.ok).toBe(true);
    expect(result.code).toBe('legacy_kind');
    // 判成「第 0 版」—— 与它自称的 `version: 1` **无关**：身份键不同
    expect(result.note.to).toBe(0);
    expect(result.note.from).toBe(1);
    // 它明确列出了「按这一版读会拿不到什么」，而不是让读者去猜
    expect(result.note.unavailableFields).toContain('schema');
    expect(result.note.unavailableFields).toContain('producer');
    /**
     * ⚠️ 判别性断言：降级时**不得**按新格式解读。
     *
     * 若哪天有人「顺手」把旧载荷补成新形状（填默认 producer、填
     * `isFullDocument: false`），上面几条仍然可能通过，但载荷会**不再
     * 与输入全等** —— 那正是「按旧格式写的兼容打算一定落空」的翻版：
     * 补出来的默认值会被下游当成事实。
     */
    expect(result.payload).toEqual(legacy);
    expect(result.payload).toBe(legacy);
  });

  it('旧载荷的判定数据仍在（降级不等于什么都读不了）', () => {
    const legacy = legacyPayload();
    legacy['wordsTotal'] = 14;
    legacy['linesTotal'] = 3;

    const result = parseOcrStructure(legacy);

    expect(result.status).toBe('downgraded');
    if (result.status !== 'downgraded') throw new Error('预期 downgraded');
    // 判定数据读得到 —— 它与当前格式**同名同义**，这是降级可行的全部依据
    expect(result.payload['wordsTotal']).toBe(14);
    expect(result.payload['linesTotal']).toBe(3);
    // 而信封字段**不补**：它们回答的是「能不能按这个 schema 解析」，
    // 那是旧格式根本没有的能力
    expect('producer' in result.payload).toBe(false);
    expect('contract' in result.payload).toBe(false);
  });

  it('既没有 schema 也没有 kind ⟹ 拒绝（无从判断格式）', () => {
    const result = parseOcrStructure({ pageNum: 1, words: [] });

    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('预期 rejected');
    expect(result.code).toBe('unknown_payload');
  });

  it('非对象 / 坏 JSON / 数组 ⟹ 拒绝（连「是什么」都答不了）', () => {
    for (const bad of ['{ 这不是 JSON', 42, null, undefined, [1, 2, 3]] as unknown[]) {
      const result = parseOcrStructure(bad);
      expect(result.status, `输入 ${JSON.stringify(bad)} 应当被拒绝`).toBe('rejected');
      if (result.status !== 'rejected') throw new Error('预期 rejected');
      expect(result.code).toBe('not_an_object');
    }
  });

  it('📋 实际行为原文（三份载荷各是什么下场）—— 这条用例**故意**打日志', () => {
    /**
     * ⚠️ 这是**回执用例**：它把三种载荷的真实下场原样打出来，供人手抄进
     * 报告 / HANDOFF。断言只有一条（三者互不相同）——
     * 它要证的是「三个出口真的可区分」，不是别的。
     *
     * 留在这里而不是写在临时脚本里：临时脚本会随任务结束消失，
     * 而「旧载荷会怎样」是**接手者一定会问**的问题。
     */
    const cases: Record<string, unknown> = {
      当前版本: captureReal(),
      上一代格式: legacyPayload(),
      'schemaVersion 相同但 schema 不同': {
        ...currentPayload(),
        schema: 'universal-reader/ocr-structure-v2',
      },
    };
    const outcomes = Object.entries(cases).map(([label, payload]) => {
      const result = parseOcrStructure(payload);
      const summary =
        result.status === 'rejected'
          ? `rejected / code=${result.code} / message=${result.message}`
          : result.status === 'downgraded'
            ? `downgraded / code=${result.code} / to=${result.note.to} / 读不到: ${result.note.unavailableFields.join(',')}`
            : `current / schemaVersion=${result.payload.schemaVersion}`;
      return { label, summary };
    });

    for (const { label, summary } of outcomes) console.info(`[T5] ${label} ⇒ ${summary}`);

    const statuses = outcomes.map((o) => o.summary.split(' / ')[0]);
    expect(statuses).toEqual(['current', 'downgraded', 'rejected']);
  });

  it('⚠️ 判别性对照：判定数据逐字节相同、只换身份键，出口就从 current 变成 downgraded', () => {
    /**
     * 这条把「双键判定」变成一个**可对照的实验**：
     * 两份载荷的**判定数据完全相同**，只有身份键不同，出口必须不同。
     * 若哪天 `parseOcrStructure` 退化成「只看 version 数字」，
     * 两份都会变成 `current` —— 这条会红。
     */
    const shared: Record<string, unknown> = {
      pageNum: 1,
      dominantFontSize: 20,
      words: [],
      wordsTotal: 0,
    };

    const asLegacy = parseOcrStructure({ ...shared, kind: OCR_STRUCTURE_LEGACY_KIND, version: 1 });
    const asCurrent = parseOcrStructure({
      ...shared,
      schema: OCR_STRUCTURE_SCHEMA,
      schemaVersion: 1,
    });
    // 数字都是 1，出口却必须不同 —— 这就是「不得只看版本号」
    expect(asLegacy.status).toBe('downgraded');
    expect(asCurrent.status).toBe('current');
  });
});

describe('T5 载荷自描述：`contract` 说的必须与真实载荷一致', () => {
  it('`contract.fields` 与真实导出里出现的字段**双向**一致', () => {
    const payload = captureReal();
    const declared = OCR_STRUCTURE_SELF_DESCRIPTION.fields;

    // ① 声明了但载荷里没有 —— 只有允许缺席的字段才可以这样
    const optional = new Set(OCR_STRUCTURE_SELF_DESCRIPTION.optionalFields);
    for (const field of declared.filter((f) => !(f in payload))) {
      expect(optional.has(field), `${field} 不在载荷里，却没被声明为可缺席`).toBe(true);
    }

    // ② 载荷里有但没声明 —— 一个都不允许（那就是「没说清这是什么」）
    const undeclared = Object.keys(payload).filter((k) => !declared.includes(k));
    expect(undeclared).toEqual([]);

    /**
     * ③ ⚠️ 声明必须是**从契约那一个来源**来的，而不是另抄一份名字。
     *
     * 只比「载荷里的字段名」是查不出这一点的：手抄一份 `fields` 数组
     * （内容恰好一样）会让 ①② 都绿 —— 而它正是本项目反复出现的那种
     * 「会漂移的第二份清单」。这里换一个**只有契约知道**的东西来比：
     * 每个声明字段的 `what` 说明文字。
     *
     * 第一次写这条时用的是变异 M11（改 `pageNum` 的说明文字），
     * 结果**变绿了** —— 因为 `GOLDEN_V2_STRUCTURE_JSON` 里的 `contract`
     * 引用的就是契约本身，两边一起变。补上这一条之后 M11 才变红。
     */
    const description = new Map(declared.map((f) => [f, OCR_STRUCTURE_CONTRACT[f as keyof typeof OCR_STRUCTURE_CONTRACT].what]));
    const fromContractObject = Object.keys(OCR_STRUCTURE_CONTRACT).map((f) => description.get(f));
    expect(declared).toEqual(Object.keys(OCR_STRUCTURE_CONTRACT));
    expect(fromContractObject.every((d) => typeof d === 'string' && d.length > 0)).toBe(true);
    // 反向：契约里每一条说明都必须能被载荷的自描述解释（没有孤儿说明）
    for (const f of Object.keys(OCR_STRUCTURE_CONTRACT)) {
      expect(declared, `契约里的 ${f} 没有出现在自描述里`).toContain(f);
    }
  });

  it('⚠️ `contract` 是**契约那一个来源**的投影（改契约说明 ⟹ 真实导出跟着变）', () => {
    /**
     * 上一条用例比的是「字段名集合」，手抄一份内容相同的名字仍能骗过它。
     * 这一条用**说明文字**（只有契约里才有）当指纹：
     *
     *  · `OCR_STRUCTURE_SELF_DESCRIPTION` 是契约对象自己的投影；
     *  · 真实导出里的 `contract` 必须**与它是同一个值**（不是深拷贝、
     *    不是重建的一份等价物）。
     *
     * 于是「改了契约的说明文字而导出没跟上」不可能发生 —— 除非有人
     * 显式去拷贝它，而那时 `toBe` 会红。
     */
    const payload = captureReal();

    /**
     * ⚠️ 分两步，因为真实导出在测试里是**过了一次 `JSON.stringify`** 的
     * （`captureReal` 复刻的正是用户复制出去的那份文本）：
     *  · 引用相等只能在**内存对象**上验（`buildOcrStructure` 的返回值）；
     *  · 序列化那一侧只能验**值相等**。
     * 两步都要，缺了第一步就查不出「有人深拷贝了一份」。
     */
    const structure = buildOcrStructure({
      pageNum: 1,
      dominantFontSize: 20,
      words: normalWords(),
      lines: [],
      blocks: [],
    });
    expect(structure.contract).toBe(OCR_STRUCTURE_SELF_DESCRIPTION);

    expect(payload.contract).toEqual(OCR_STRUCTURE_SELF_DESCRIPTION);
    // 且它逐字等于契约的键序（键序也是契约的一部分：读者从上往下读的顺序）
    expect((payload.contract as { fields: string[] }).fields).toEqual(
      Object.keys(OCR_STRUCTURE_CONTRACT),
    );
    // 契约里每条说明都是非空字符串（空说明等于没说明）
    for (const [field, entry] of Object.entries(OCR_STRUCTURE_CONTRACT)) {
      expect(entry.what.length, `${field} 的 what 是空的`).toBeGreaterThan(0);
    }
  });

  it('⚠️ `optional: true` 的字段**出现即非空**（「没有字段 ≠ 字段为空」的落点）', () => {
    /**
     * 这条是本次任务里最要紧的一条断言。
     *
     * 契约把「可在缺席时仍有意义」声明成 `optional: true`，其含义是
     * **两态取值**：要么不在，要么在且非空。缺席因此一定携带信息
     * （这一步没跑成 / 没试过 / 一个都没挡下），而不是「可能是空集合」
     * 这种读不出结论的状态。
     *
     * 本用例对**跨全部三种状态**的真实导出逐条核对：一旦有人把某个
     * 可缺席字段改成「无条件写空数组」，这里立刻红 —— 契约与实现
     * 不允许各自漂移。
     */
    const optional = [...OCR_STRUCTURE_SELF_DESCRIPTION.optionalFields].sort();
    // 这三条是契约里声明的全部可缺席字段；数量变了要在这里显式改
    expect(optional).toEqual(['canvasHeight', 'layout', 'outboundFormulaSkips']);

    const payloads = [
      captureReal(),
      captureReal({ layout: { ok: true, code: 'none', regionCount: 2, width: 10, height: 20 } }),
      captureReal({ layout: { ok: false, code: 'feature_disabled' } }),
      captureReal({ words: FIXTURE_WORDS.map((x) => ({ ...x })) }),
    ];

    for (const payload of payloads) {
      for (const field of optional) {
        if (!(field in payload)) continue;
        const value = payload[field];
        if (Array.isArray(value)) {
          expect(value.length, `${field} 在载荷里是空数组，应改为整个字段缺席`).toBeGreaterThan(0);
        } else {
          // `undefined` / `null` 与「字段不在」是两种事实，不能混
          expect(value, `${field} 出现了但值是 ${String(value)}`).not.toBeUndefined();
          expect(value).not.toBeNull();
        }
      }
    }
  });

  it('`layout` 三种状态各自可判定：缺席 / used=true / used=false', () => {
    // ① 没传 outcome → 整个字段缺席（缺席 = 没试过）
    expect('layout' in captureReal()).toBe(false);

    // ② 试过且成功 → 在，且 used 为 true
    const ok = captureReal({ layout: { ok: true, code: 'none', regionCount: 2, width: 10, height: 20 } });
    expect((ok.layout as { used: boolean }).used).toBe(true);

    // ③ 试过但失败 → 在，且 used 为 false、带稳定码
    const failed = captureReal({ layout: { ok: false, code: 'feature_disabled' } });
    expect(failed.layout).toMatchObject({ used: false, code: 'feature_disabled' });
  });

  it('`outboundFormulaSkips` 只在真的挡下过候选时出现（**缺席携带信息**）', () => {
    /**
     * ⚠️ 这个字段读的是模块级旁挂记录，所以本文件顶部 mock 了
     * `getOutboundFormulaSkips` 并在这里**显式设值**：
     * 不设的话验的就是「别的用例有没有挡下过候选」—— 第 ① 类假保护。
     */
    gateState.skips = [];
    expect('outboundFormulaSkips' in captureReal()).toBe(false);

    gateState.skips = [
      { text: '一大块公式', reason: 'ratio', areaRatio: 0.42, limit: 0.3, pageWidth: 900, pageHeight: 1200 },
    ];
    const withSkips = captureReal();
    expect(withSkips.outboundFormulaSkips).toHaveLength(1);
    // 出现即非空 —— 与契约里的 `optional: true` 一致
    expect((withSkips.outboundFormulaSkips as unknown[]).length).toBeGreaterThan(0);

    gateState.skips = [];
  });

  it('空数组字段（`charBoxSkips`）恒在且如实可为空 —— 与可缺席字段是两种约定', () => {
    const payload = captureReal();

    /**
     * 同一个载荷里同时存在两种约定，这正是「不能压平」的证据：
     *   · `charBoxSkips: []` —— 字段**在**，空数组是结论（每个词都拿到了字符框）；
     *   · `canvasHeight` —— 传了 1400 所以在；不传时会**整个缺席**（下一条用例）。
     * 若把两者统一成「空数组 / 空值」，这两条会一起红。
     */
    expect('charBoxSkips' in payload).toBe(true);
    expect(payload.charBoxSkips).toEqual([]);
    expect(payload.canvasHeight).toBe(1400);
    expect(OCR_STRUCTURE_SELF_DESCRIPTION.optionalFields).not.toContain('charBoxSkips');
    // 而「0 个词拿到字符框」是一个**值**（0），不是缺席
    expect(payload.wordsWithChars).toBe(0);
  });

  it('`canvasHeight` 拿不到时整个字段缺席（缺席 ≠ 值为 0，也 ≠ 值为 undefined）', () => {
    const structure = buildOcrStructure({
      pageNum: 1,
      // 故意不传 canvasHeight
      dominantFontSize: 20,
      words: [],
      lines: [],
      blocks: [],
    });

    /**
     * ⚠️ 这里要同时看**对象**与**序列化结果**。
     *
     * 只查 `'canvasHeight' in structure` 的话，一个「无条件写、
     * 值恰好是 `undefined`」的实现会红 —— 那是**对的**（它确实不是缺席），
     * 但如果只查 `JSON.stringify` 后的样子，那种实现又会**绿**，
     * 因为 `undefined` 会被 `JSON.stringify` 丢掉。
     * 两种形状不一致本身就是缺陷，所以两边都钉住。
     */
    expect('canvasHeight' in structure).toBe(false);
    expect(JSON.parse(JSON.stringify(structure))).not.toHaveProperty('canvasHeight');
    // 而且它不是被写成了 0 —— 那是两条不同的路
    expect(structure.canvasHeight).toBeUndefined();

    // 反面：传了就一定在（证明上面三条不是因为这一行被删了）
    expect(captureReal().canvasHeight).toBe(1400);
  });
});

describe('T5 兼容性说明：产物里能看出这一版加了什么、有没有破坏性变化', () => {
  it('真实导出里带着兼容性记录，且它逐字段覆盖了契约里的每个字段', () => {
    const payload = captureReal();
    const compatibility = payload.compatibility as {
      previousSchemaVersion: number | null;
      breaking: boolean;
      changedFields: { field: string; breaking: boolean; why: string }[];
    };

    expect(compatibility.previousSchemaVersion).toBeNull();
    // 每个契约字段都有一条记录（机械推导，见 `ocrStructureCompatibility`）
    for (const field of Object.keys(OCR_STRUCTURE_CONTRACT)) {
      expect(
        compatibility.changedFields.some((c) => c.field === field),
        `契约字段 ${field} 没有出现在兼容性记录里`,
      ).toBe(true);
    }
    // 每条都得说清「为什么」，不然记录只是噪声
    for (const change of compatibility.changedFields) {
      expect(change.why.length, `${change.field} 的 why 是空的`).toBeGreaterThan(0);
    }
  });

  it('⚠️ 本版对旧读取方是**破坏性**的（kind / version / buildId 三个键被删）', () => {
    const compatibility = ocrStructureCompatibility();

    for (const removed of ['kind', 'version', 'buildId']) {
      const change = compatibility.changedFields.find((c) => c.field === removed);
      expect(change, `${removed} 被删了却没记录`).toBeDefined();
      expect(change?.breaking, `${removed} 是破坏性删除，必须标 breaking`).toBe(true);
    }
    expect(compatibility.breaking).toBe(true);
    // `breaking` 是**推导值**，不是手写常量：任一条为真它就为真
    expect(compatibility.breaking).toBe(compatibility.changedFields.some((c) => c.breaking));
  });

  it('真实导出里**确实没有**那三个旧键（兼容性说明与实际产物一致）', () => {
    const payload = captureReal();

    for (const key of ['kind', 'version', 'buildId']) {
      expect(key in payload, `旧键 ${key} 仍在导出里，与 compatibility 的说法矛盾`).toBe(false);
    }
  });
});

describe('T5 职责不重叠：几个标识各回答一个问题', () => {
  it('`producer.version` 跟着构建标识走（它取代了旧的 buildId，且**只有一处**）', () => {
    /**
     * ⚠️ 必须 mock：`__BUILD_ID__` 是构建期注入的全局常量（测试里固定为
     * `'test-build'`），改它才能证明这一行**真的读了它**。不 mock 的话，
     * 「producer.version === 'test-build'」也可能是某个写死的常量碰巧相等
     * —— 那是第 ① 类假保护。
     */
    vi.stubGlobal('__BUILD_ID__', 'build-under-test-abc');
    try {
      const structure = buildOcrStructure({
        pageNum: 1,
        dominantFontSize: 20,
        words: [],
        lines: [],
        blocks: [],
      });
      expect(structure.producer.version).toBe('build-under-test-abc');
      // 且导出里**没有**第二个地方放构建标识
      expect('buildId' in structure).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('`producer.version` 与 `document.isFullDocument` **互不决定**', () => {
    /**
     * 两个维度独立：MinerU 的「三种主张必须分别对待」在本项目的最小形态 ——
     * 「这一页能代表整份文档吗」与「你跑的是哪一版」是两个问题，
     * 不能由一个推出另一个。
     */
    const partial = captureReal({ isFullDocument: false });
    const full = captureReal({ isFullDocument: true });

    expect(partial.producer).toEqual(full.producer);
    expect(partial.document).toEqual({ isFullDocument: false });
    expect(full.document).toEqual({ isFullDocument: true });
  });

  it('`isFullDocument` 只进导出，**不改判定**（除它以外逐字节相同）', () => {
    const partial = captureReal({ isFullDocument: false });
    const full = captureReal({ isFullDocument: true });

    const strip = (p: Record<string, unknown>) => {
      const { document: _document, ...rest } = p;
      return JSON.stringify(rest);
    };
    expect(strip(full)).toBe(strip(partial));
  });

  it('`isFullDocument` 默认走**保守**的那一个方向（忘了传 ⟹ false）', () => {
    const structure = buildOcrStructure({
      pageNum: 1,
      dominantFontSize: 20,
      words: [],
      lines: [],
      blocks: [],
    });

    expect(structure.document.isFullDocument).toBe(false);
    // 而调用方显式传 true 时它必须真的变 —— 否则上面那条「默认 false」
    // 可能只是因为这一行被写死了
    expect(captureReal({ isFullDocument: true }).document).toEqual({ isFullDocument: true });
  });
});

describe('T5 假保护排查：契约真的只有一个来源', () => {
  /**
   * ⚠️ 契约自描述的**指纹金标**。
   *
   * 生成方式（改动是**有意**的时候才更新）：
   *   `ocrStructureSelfDescriptionFingerprint()` 的返回值抄到这里。
   * 它与 `pageLayoutInvariant.golden.ts` 是同一类东西：一个**快照**，
   * 变了要解释，而不是无脑重录。
   */
  const OCR_STRUCTURE_SELF_DESCRIPTION_FINGERPRINT = '1142:9143fcca';

  /**
   * ⚠️ 这一组**有意**读源码，因此必须躲开本项目踩过三次的那个坑：
   * **注释里含有被断言的关键词**（HANDOFF §5.10.8）。
   *
   * 做法：按行取，先丢掉注释行，再比对。这样「只写在注释里的规则」
   * 永远不会让断言通过 —— 而它正是第 ② 类假保护
   * （`toMatch(/名字/)` 匹配到 import 或注释）的形态。
   */
  const sourceLinesOf = async (file: string): Promise<string[]> => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    return source
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => !line.startsWith('*') && !line.startsWith('//') && !line.startsWith('/*'));
  };

  it('契约的说明文字只在 `OCR_STRUCTURE_CONTRACT` 里出现一次（没有第二份清单）', async () => {
    /**
     * `ocrStructureContract.golden.ts` 曾经把契约里的说明文字**抄了一遍**，
     * 那就是一份会漂移的清单 —— 本用例把它钉死：快照文件里**不得**
     * 出现逐字段的说明文字，只能引用 `OCR_STRUCTURE_SELF_DESCRIPTION`
     * 与 `ocrStructureCompatibility()`。
     */
    const lines = await sourceLinesOf('./ocrStructureContract.golden.ts');

    expect(
      lines.filter((l) => l.includes('既有字段，语义不变')),
      '快照文件里抄了一份契约说明，请改为引用契约本身',
    ).toEqual([]);
    expect(lines.some((l) => l.includes('OCR_STRUCTURE_SELF_DESCRIPTION'))).toBe(true);
    expect(lines.some((l) => l.includes('ocrStructureCompatibility()'))).toBe(true);
  });

  it('`contract.fields` 与 `OcrStructure` 接口里的字段**完全一致**（源码级，第三个来源）', async () => {
    /**
     * 前两条用例验的是「契约 ↔ 载荷」。这一条从**第三个来源**核对：
     * 源码里 `export interface OcrStructure { … }` 实际声明了哪些字段。
     *
     * ⚠️ 为什么值得单独一条：`contract.fields` 可能被人手改成一份
     * 「看起来很像」的清单，而上面那条双向比对只会发现它比载荷多/少 ——
     * 只要两边一起改就查不出来。接口是**类型系统真正用的那一份**，
     * 它与契约不一致时 `tsc -b` 也会红（见 `OcrStructureContractAligned`），
     * 这里再让它在**测试**里也红一次：两道门比一道门可靠。
     */
    const lines = await sourceLinesOf('./ocrStructure.ts');
    const start = lines.findIndex((l) => l.startsWith('export interface OcrStructure {'));
    expect(start, '找不到 OcrStructure —— 导出契约变了，本用例要重写').toBeGreaterThan(-1);

    /**
     * ⚠️ 必须**按大括号深度**取字段，不能只看缩进：`thresholds` 是内联对象，
     * 它的 10 个属性同样是 2 空格缩进 —— 只看缩进会把这 10 个内层键
     * 当成顶层字段（第一版就是这么写的，测试立刻红）。
     *
     * 深度 0 = `OcrStructure` 自己的字段；`}` 退回 0 时接口结束。
     */
    const declaredInType: string[] = [];
    let depth = 0;
    for (const line of lines.slice(start + 1)) {
      if (depth === 0) {
        const field = /^([A-Za-z_$][\w$]*)\??:/.exec(line);
        if (field) declaredInType.push(field[1]);
        if (line.startsWith('}')) break; // 接口结束
      }
      depth += (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0);
    }

    expect([...declaredInType].sort()).toEqual([...Object.keys(OCR_STRUCTURE_CONTRACT)].sort());
  });

  it('⚠️ 契约的**说明文字**没有被悄悄改过（指纹金标）', () => {
    /**
     * `contract.fields` 只装字段名，说明文字（`what`）不进产物 ——
     * 所以「谁把某句说明改成了相反的意思」在导出里看不出来，
     * 也没有任何别的测试会发现。这一条用指纹把它钉住。
     *
     * ⚠️ 它变红时**不要**直接改常量：先确认这次改动是**有意的**、
     * 且新说明仍然准确，再更新 `OCR_STRUCTURE_SELF_DESCRIPTION_FINGERPRINT`。
     * （`contract.fields` 的名字集合另有逐字比对，见上一条用例。）
     */
    expect(ocrStructureSelfDescriptionFingerprint()).toBe(
      OCR_STRUCTURE_SELF_DESCRIPTION_FINGERPRINT,
    );
  });

  it('⚠️ 人手填的两张小表与契约**逐键对齐**（漏写一个字段不该静默通过）', () => {
    /**
     * `CONTRACT_FIELD_CHANGES` 是 `Record<string, …>`，漏写一个键**不会**
     * 报编译错 —— 而 `ocrStructureCompatibility` 里那个 `?? '新增字段…'`
     * 兜底会让漏写**静默通过**（变异 M12 实测：全绿）。
     * 所以这条核对必须落在测试里。
     */
    expect(Object.keys(CONTRACT_FIELD_CHANGES).sort()).toEqual(
      Object.keys(OCR_STRUCTURE_CONTRACT).sort(),
    );
    // 每条说明都得是能读的一句话，而空字符串等于没写
    for (const [field, entry] of Object.entries(CONTRACT_FIELD_CHANGES)) {
      expect(entry.why.length, `${field} 的 why 是空的`).toBeGreaterThan(0);
    }
  });

  it('兼容性记录的骨架由契约机械推导（不是手写清单）', async () => {
    const lines = await sourceLinesOf('./ocrStructure.ts');

    // 骨架必须来自 `Object.keys(OCR_STRUCTURE_CONTRACT)`（真实调用，不是注释）
    expect(
      lines.some((l) => /Object\.keys\(OCR_STRUCTURE_CONTRACT\)\.map\(/.test(l)),
      '兼容性记录不再由契约推导 —— 它会与契约漂移',
    ).toBe(true);

    // 而人只填两张小表：「是不是破坏性 + 为什么」与「删了哪些旧键」
    expect(lines.some((l) => l.startsWith('export const CONTRACT_FIELD_CHANGES'))).toBe(true);
    expect(lines.some((l) => l.startsWith('const REMOVED_FIELDS'))).toBe(true);
  });

  it('读取方判定时用的是两个键（源码里两个键的读取都真的发生）', async () => {
    const lines = await sourceLinesOf('./ocrStructure.ts');

    expect(lines.some((l) => l.includes("obj['schema']"))).toBe(true);
    expect(lines.some((l) => l.includes("obj['schemaVersion']"))).toBe(true);
    /**
     * ⚠️ 反面：判定路径上**只有一处**读旧键 `kind`，且它必须是
     * 「识别旧载荷」那个分支。若哪天有人加了一条「`kind` 也对就按新格式读」
     * 的捷径，这里会红。
     */
    const kindReads = lines.filter((l) => l.includes("obj['kind']"));
    expect(kindReads).toHaveLength(1);
    expect(kindReads[0]).toContain('OCR_STRUCTURE_LEGACY_KIND');
  });
});
