import { describe, expect, it } from 'vitest';

import { buildOcrStructure } from '@/lib/ocrStructure';
import { applyLayoutToLines, ocrResultToBlocks } from '@/lib/ocrPostProcess';
import type { OcrPageResult } from '@/lib/ocrTypes';

/**
 * 不变量测试：**无版面信息时，输出与接入前逐字节相同**。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么这条必须存在，而且必须是「逐字节」
 * ═══════════════════════════════════════════════════════════════
 *
 * `layoutAnalysis.ts` 顶部写着：版面分析**只做加法**，它一旦缺席
 * （模型没取到 / 推理抛错 / 结果异常 / 用户关闭），整条 OCR 链路必须与
 * 接入前**逐字节一致**。这条不变量是「默认开启一个未验证组件」这件事
 * 唯一的正当理由 —— 一旦它不成立，用户拿到的正文就可能因为一个
 * **从未在真实数据上跑过推理**的模型而改变（`HANDOFF.md` §5.11.7）。
 *
 * 本次改动给导出加了 `layout` 字段，因此必须说清不变量覆盖什么：
 *
 *   · **判定结果**（`lines` / `blocks` / `hasScripts` / `words` / `truncated`）
 *     与接入前**逐字节相同** —— 这是「正文没变」的实质。
 *   · 导出里**新增** `layout` 字段是本次任务明确要求的「必须看得见」，
 *     它是**增量**、不参与判定；没有版面信息时它**根本不出现**。
 *
 * ═══════════════════════════════════════════════════════════════
 * golden 是怎么来的（**不是手写的**）
 * ═══════════════════════════════════════════════════════════════
 *
 * 它是把同一份 fixture 喂给 **改动前那一版**（`git show HEAD:…` 取出的
 * `ocrStructure.ts` / `ocrPostProcess.ts`）跑出来的真实输出，原样抄进来。
 * 手写一个「我认为应该长这样」的对象，只能证明「今天的代码符合我今天的
 * 预期」，证明不了「与接入前相同」—— 那正是本项目已经出现过 5 次的
 * 「假保护」形态。
 */
import { FIXTURE_WORDS, GOLDEN_BLOCKS_JSON } from './pageLayoutInvariant.golden';
import {
  CONTRACT_FIELD_ORDER,
  GOLDEN_V2_STRUCTURE_JSON,
  LEGACY_DECISION_JSON,
  LEGACY_ENVELOPE_KEYS,
  decisionJsonOf,
  splitEnvelope,
} from './ocrStructureContract.golden';

/**
 * 一份固定的单页识别结果：页眉 + 三行正文（含一处上标、`hasScripts: true`）+ 页脚。
 *
 * `FIXTURE_WORDS` 本身由 golden 文件持有 —— 这样「输入」与「改动前的输出」
 * 永远成对，不会出现「换了 fixture 但忘了重生成 golden」这种静默失效。
 */
const page = (): OcrPageResult => ({
  pageNum: 1,
  avgConfidence: 91,
  pageText: '',
  words: FIXTURE_WORDS.map((w) => ({ ...w, bbox: { ...w.bbox } })),
});

describe('不变量：无版面信息时输出与接入前逐字节相同', () => {
  it('`ocrResultToBlocks` 不传版面信息时的输出 = 改动前的真实输出', () => {
    const blocks = ocrResultToBlocks(page(), 1400);
    expect(JSON.stringify(blocks)).toBe(GOLDEN_BLOCKS_JSON);
  });

  it('传**空数组**与不传版面信息结果相同（既有契约：空数组等于没有）', () => {
    // `applyLayoutToLines` 的既有契约是「不传 / 传空数组 → 原样返回」。
    // 用同一份 golden 二次核对：哪天空数组被当成「有版面信息」，它立刻红。
    expect(JSON.stringify(ocrResultToBlocks(page(), 1400, undefined, []))).toBe(GOLDEN_BLOCKS_JSON);
    expect(JSON.stringify(ocrResultToBlocks(page(), 1400, undefined, undefined))).toBe(
      GOLDEN_BLOCKS_JSON,
    );
  });

  it('导出的判定部分与改动前逐字节相同 —— 且**没有** `layout` 字段', () => {
    let captured: Record<string, unknown> | undefined;
    ocrResultToBlocks(page(), 1400, (structure) => {
      captured = JSON.parse(JSON.stringify(structure)) as Record<string, unknown>;
    });

    const actual = captured!;
    /**
     * ═══════════════════════════════════════════════════════════════
     * T5 之后，这条断言换成「**判定部分**逐字节相同」
     * ═══════════════════════════════════════════════════════════════
     *
     * 旧的不变量是「整份导出 = 改动前的真实输出」。T5 有意给导出加了
     * 六个信封字段（`schema` / `schemaVersion` / `producer` / `document` /
     * `contract` / `compatibility`），所以「整份相同」**不可能**再成立 ——
     * 但**它当初要保护的东西一个字都没变**：正文与判据数据。
     *
     * 于是这里把它拆成可判定的两半（`splitEnvelope`）：
     *   · `LEGACY_DECISION_JSON` = 旧 golden 扣掉**旧**信封
     *     （`kind` / `version` / `buildId`）后的字节；
     *   · `decisionJsonOf(actual)` = 新导出扣掉**新**信封后的字节。
     * 两者必须逐字节相同。
     *
     * ⚠️ 为什么这样**没有**弱化断言：旧 golden 与新导出**本来就是**
     * 同一份 `FIXTURE_WORDS` 跑出来的，而旧信封恰好就是新信封里
     * 那三个对应物（`kind`→`schema`、`version`→`schemaVersion`、
     * `buildId`→`producer.version`）。扣掉它们之后剩下的键集合
     * 两边**完全相同**，所以这是一次**等强度的逐字节比对**，
     * 覆盖面一点没少。
     */
    expect(decisionJsonOf(actual)).toBe(LEGACY_DECISION_JSON);

    /**
     * ⚠️ 反面：新的身份键**必须**在，而旧的三个键**必须不在**。
     *
     * 少了这一条，上面那次比对在「两边都扣掉了各自的信封」之后
     * 仍然可能对一个**没有信封**的载荷成立 —— 那样 T5 就白做了。
     */
    for (const key of LEGACY_ENVELOPE_KEYS) {
      expect(key in actual, `旧键 ${key} 不该再出现在导出里（T5 用 schema 双键取代了它）`).toBe(
        false,
      );
    }
    const { envelope } = splitEnvelope(actual);
    expect(Object.keys(envelope)).toEqual([
      'schema',
      'schemaVersion',
      'producer',
      'document',
      'contract',
      'compatibility',
    ]);

    // 同一份真实输出与「信封 + 判定部分」的完整快照对比：顺带钉住键顺序
    expect(JSON.stringify(actual)).toBe(GOLDEN_V2_STRUCTURE_JSON);
    // 快照里的字段声明顺序 = 契约里的顺序（读者从上往下读的顺序）
    expect((actual.contract as { fields: string[] }).fields).toEqual(CONTRACT_FIELD_ORDER);

    /**
     * ⚠️ 还要钉住「golden 真的覆盖到了 `hasScripts` 两条分支」。
     *
     * 这组坐标是我探针实测选出来的（基字够宽、行距够大），而只要有人
     * 动一下 fixture 的数字，上下标就可能不再绑上、这一行静默变成
     * `hasScripts: false` —— 比对照样绿，但**不变量已经不再覆盖那个分支**
     * 了。这就是本项目已经出现过 5 次的那类假保护，所以在这里显式拦住它。
     */
    const lines = actual.lines as { hasScripts: boolean }[];
    expect(lines.some((l) => l.hasScripts)).toBe(true);
    expect(lines.some((l) => !l.hasScripts)).toBe(true);

    /**
     * 「**没有字段 ≠ 字段为空**」——本项目已确立的规则（拿不到字符框的词
     * 不写 `chars`）。没传 `layoutOutcome` = 这一页根本没接版面分析，
     * 那是一个**缺席**，不该写成一个 null 值。
     */
    expect('layout' in actual).toBe(false);
  });

  it('给了失败码时判定部分仍然逐字节不变，只是多出 `layout`', () => {
    let captured: Record<string, unknown> | undefined;
    ocrResultToBlocks(
      page(),
      1400,
      (structure) => {
        captured = JSON.parse(JSON.stringify(structure)) as Record<string, unknown>;
      },
      undefined, // 没有区域
      { ok: false, code: 'feature_disabled' }, // 但**试过**（开关关着）
    );

    const actual = captured!;
    const { layout, ...withoutLayout } = actual;

    // 加一个失败码绝不该改动正文
    expect(decisionJsonOf(withoutLayout)).toBe(LEGACY_DECISION_JSON);
    // 而「试过但失败」这一次必须看得见，且带上含义与下一步动作
    expect(layout).toMatchObject({
      used: false,
      code: 'feature_disabled',
      meaning: expect.stringContaining('开关'),
      nextAction: expect.stringContaining('设置'),
    });
  });

  it('成功时同样不改判定，且带上 regionCount 与坐标尺寸', () => {
    let captured: Record<string, unknown> | undefined;
    ocrResultToBlocks(
      page(),
      1400,
      (structure) => {
        captured = JSON.parse(JSON.stringify(structure)) as Record<string, unknown>;
      },
      [],
      { ok: true, code: 'none', regionCount: 7, width: 1000, height: 1400 },
    );

    const actual = captured!;
    const { layout, ...withoutLayout } = actual;
    expect(decisionJsonOf(withoutLayout)).toBe(LEGACY_DECISION_JSON);
    expect(layout).toMatchObject({
      used: true,
      code: 'none',
      regionCount: 7,
      width: 1000,
      height: 1400,
    });
    // 成功时不该有 detail（「没有字段 ≠ 字段为空」）
    expect('detail' in (layout as object)).toBe(false);
  });

  it('同一份输入连跑两次逐字节相同（不引入时间/随机/顺序依赖）', () => {
    const once = buildOcrStructure({
      pageNum: 1,
      canvasHeight: 1400,
      dominantFontSize: 12,
      words: FIXTURE_WORDS,
      lines: [],
      blocks: [],
    });
    const twice = buildOcrStructure({
      pageNum: 1,
      canvasHeight: 1400,
      dominantFontSize: 12,
      words: FIXTURE_WORDS,
      lines: [],
      blocks: [],
    });
    expect(JSON.stringify(once)).toBe(JSON.stringify(twice));
    expect('layout' in once).toBe(false);
  });

  /**
   * ═══════════════════════════════════════════════════════════════
   * 变异 M16 为什么变绿 —— 用探针证明它是**数学恒等**
   * ═══════════════════════════════════════════════════════════════
   *
   * M16 把 `applyLayoutToLines(..., layoutRegions, ...)` 改成
   * `applyLayoutToLines(..., layoutRegions ?? [], ...)`，21+6 条用例**全绿**。
   * 这不是假保护，而是那一改**在语义上是恒等变换**：
   * `applyLayoutToLines` 的第一行就是
   *
   *     if (!regions?.length || !lines.length) return lines;
   *
   * `undefined?.length` 与 `[].length` 都是 0，取反都是 true，于是两者
   * **返回同一个 `lines` 引用**（连拷贝都没有）。所以「undefined vs 空数组」
   * 根本不是一个可区分的输入 —— 这条用例把这个事实**正面钉住**，
   * 而不是留着一条永远不可能变红的期望。
   *
   * ⚠️ 它同时也是不变量本身的第二个证据：空数组与缺席**同为**「没有版面信息」，
   * 两者都必须走原路返回。
   */
  it('探针：`applyLayoutToLines` 对 undefined 与空数组是同一个恒等变换', () => {
    /**
     * ⚠️ 这两个元素是**故意做成空对象**的：本探针要证明的是
     * 「`!regions?.length` 这一条短路**先于**函数读取 `lines` 的任何字段」。
     * 如果哪天有人把读取挪到判断之前，这里会直接抛
     * 「Cannot read properties of undefined」—— 那正是要抓的回归。
     */
    const lines = [{}, {}] as unknown as Parameters<typeof applyLayoutToLines>[0];

    const withUndefined = applyLayoutToLines(lines, undefined, 1400);
    const withEmpty = applyLayoutToLines(lines, [], 1400);

    // 必须是**同一个引用**：说明它是原样返回，而不是「算出一份等价的」
    expect(withUndefined.lines).toBe(lines);
    expect(withEmpty.lines).toBe(lines);
    expect(JSON.stringify(withEmpty.lines)).toBe(JSON.stringify(withUndefined.lines));

    // 报告也必须如实说「什么都没发生」—— 模型缺席时它不是「全 0 的统计」
    expect(withUndefined.report.decisionRows).toEqual([]);
    expect(withEmpty.report.decisionRows).toEqual([]);
    expect(withEmpty.report.removedByLayout).toBe(0);
    expect(withEmpty.report.reordered).toBe(false);
    expect(withEmpty.report.headingUse).toEqual({});

    // 反面：给一个真的有区域的数组就不再是恒等（证明上面两条不是因为它永远原样返回）
    const oneRegion = [
      { classId: 13, label: 'header', score: 0.9, x0: 0, y0: 0, x1: 500, y1: 40 },
    ];
    expect(applyLayoutToLines(lines, oneRegion, 1400).lines).not.toBe(lines);
  });
});
