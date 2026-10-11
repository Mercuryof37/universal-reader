import { describe, expect, it } from 'vitest';

import {
  HEADING_VETO_LABELS,
  PARAGRAPH_TITLE_MIN_FONT_RATIO,
  geometricWouldBeHeading,
  headingDisposition,
  type LayoutRegion,
} from '@/lib/layoutAnalysis';
import { ocrResultToBlocks, type LayoutPageReport } from '@/lib/ocrPostProcess';

/**
 * T3：把版面**类别**用足 —— 「公式行被误判成大标题」这一条
 *
 * ═══════════════════════════════════════════════════════════════
 * 这组测试要证明什么（两个方向，都必须能变红）
 * ═══════════════════════════════════════════════════════════════
 *
 * `HANDOFF.md` §5.11.5 记着：版面信息**只接了页眉页脚 + 阅读顺序**，
 * 另外两个痛点（「公式行被误判成大标题」与「跨行大括号错误合并」）
 * **没有动** —— 因为改判据回归风险大。T3 换了一个入口：**不改几何阈值，
 * 而是用模型已有的类别去否决（或确认）几何的判定**。
 *
 * 因此这里每一个「新判据」都必须同时满足两条，缺一条就是假保护：
 *
 *   ① **模型在场时它真的改判**（否则就是一条永远不会生效的规则 ——
 *      记进统计只会让数字好看）；
 *   ② **模型缺席时它一个字都不改**（这是硬性不变量：
 *      `lines`/`blocks`/`hasScripts` 与改动前逐字节相同）。
 *
 * 两条都**实测**过（见交付说明里的变异表）。第 ② 条另有一份 golden
 * 兜底：`pageLayoutInvariant.test.ts` + `pageLayoutInvariant.golden.ts`。
 */

/** 与仓库既有测试同一个 helper 口径：w(text, x, y, h, width, confidence) */
const w = (text: string, x: number, y: number, h: number, width = 30, confidence = 90) => ({
  text,
  confidence,
  bbox: { x0: x, y0: y, x1: x + width, y1: y + h },
  fontSize: h,
});

const pageResult = (words: ReturnType<typeof w>[]) => ({
  pageNum: 1,
  words,
  avgConfidence: 90,
});

const region = (
  label: string,
  classId: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  score = 0.9,
): LayoutRegion => ({ label, classId, score, x0, y0, x1, y1 });

/** 取一次调用的完整版面报告（`layoutApplied.report`） */
const run = (
  words: ReturnType<typeof w>[],
  regions: readonly LayoutRegion[] | undefined,
  pageHeight = 2223,
): { blocks: ReturnType<typeof ocrResultToBlocks>; report: LayoutPageReport | undefined } => {
  let report: LayoutPageReport | undefined;
  const blocks = ocrResultToBlocks(
    pageResult(words),
    pageHeight,
    undefined,
    regions,
    undefined,
    (r) => {
      report = r;
    },
  );
  return { blocks, report };
};

/** 中位字号 42、门槛 54.6 的一页；标题行字号 78.7（会触发几何的 1.3 倍） */
const headingRatioPage = (): ReturnType<typeof w>[] => [
  w('设随机变量X与Y相互独立', 100, 212, 42, 700),
  w('且都服从参数为p的几何分布', 100, 300, 42, 700),
  w('求P 的值。', 100, 600, 42, 300),
];

describe('T3 方向一（否决）：模型说「这是公式/正文」→ 几何的标题判定被推翻', () => {
  /**
   * 这一行**同时**满足两件事，因此它是这条判据的合法触发点：
   *   · 几何想判它标题：字号 78.7 > 中位数 42 × 1.3 = 54.6，
   *     且文本以 `1. ` 开头（`looksLikeHeading` 认可这种题号形态）；
   *   · 模型说它是公式：它整个落在 `formula` 区域里。
   *
   * ⚠️ 这**不是**硬凑的：用户那份习题 PDF 上被判成大标题的三行里，
   * 第一行就是 `Z= 当X>Y 其中λ>0，μ>0是常数.引入随机变量=10, 当X>Y`
   * （`HANDOFF.md` §5.11.1 表，实测字号 78.7）。那一行的文本判据恰好
   * 不通过（含 `=`），所以旧代码靠「文本证据」侥幸挡住了它；而
   * 「1. f(x)=x² 的导数」这种**带编号的公式行**过得了文本判据，
   * 会真的被判成标题 —— 那正是这一条要修的形态。
   */
  const formulaLine = () => w('1. f(x)=x2 的导数', 100, 1000, 78.7, 400);

  it('模型缺席：这一行**是** heading（证明它本来真的会被误判）', () => {
    const { blocks } = run([...headingRatioPage(), formulaLine()], undefined);

    // 先证明「缺陷真的存在」——否则下面的「修好了」没有意义
    expect(blocks.map((b) => b.type)).toContain('heading');
    const heading = blocks.find((b) => b.type === 'heading')!;
    expect(heading.content).toContain('f(x)=x2');
  });

  it('模型说 `formula`：同一行变成 paragraph，**内容一个字不少**', () => {
    const { blocks } = run([...headingRatioPage(), formulaLine()], [
      region('text', 2, 90, 200, 1560, 760),
      region('formula', 7, 95, 985, 1450, 1090),
    ]);

    // 改判：不再有 heading
    expect(blocks.map((b) => b.type)).not.toContain('heading');
    // 而**内容完全保留**（否决只改块类型，不删字）—— 这一条最重要
    const all = blocks.map((b) => b.content).join('\n');
    expect(all).toContain('1. f(x)=x2 的导数');
    expect(all).toContain('设随机变量X与Y相互独立');
  });

  it('模型说 `text`（正文）：同样被否决 —— 大字号不等于标题', () => {
    const { blocks } = run([...headingRatioPage(), formulaLine()], [
      // ⚠️ 区域必须**真的盖住**这一行：`regionForWord` 要覆盖率 ≥ 0.5，
      // 第一版这块 text 只到 y=760，而这一行在 y=1000 —— 于是它
      // `uncovered`、否决根本没触发，用例红了。红的原因是**测试数据错了**，
      // 不是代码错了（记在这里，免得下次再踩）。
      region('text', 2, 90, 200, 1560, 1200),
    ]);

    expect(blocks.map((b) => b.type)).not.toContain('heading');
    expect(blocks.map((b) => b.content).join('\n')).toContain('1. f(x)=x2 的导数');
  });

  it('模型说 `formula_number`：也在否决名单里（它同样是公式的一部分）', () => {
    expect(HEADING_VETO_LABELS.has('formula_number')).toBe(true);
    const { blocks } = run([...headingRatioPage(), formulaLine()], [
      region('text', 2, 90, 200, 1560, 760),
      region('formula_number', 19, 95, 985, 1450, 1090),
    ]);
    expect(blocks.map((b) => b.type)).not.toContain('heading');
  });

  /**
   * ⚠️ 反方向：**被否决的必须是「几何本来就想要的」**。
   *
   * 若把判据写成「模型说是 text → 一律不判标题」，那么一页里所有
   * 行都会被这条规则覆盖，而它对几何本来就不判标题的行是**空操作** ——
   * 空操作却会被记进 `headingUse`，于是一条从不生效的规则在统计里
   * 显示成「生效了很多次」。这条用例钉住那个区别。
   */
  it('几何本来就不判标题的行，不会被记为「被否决」', () => {
    const small = w('一行普通正文', 100, 420, 42, 400);
    const { blocks, report } = run([...headingRatioPage(), small], [
      region('text', 2, 90, 200, 1560, 760),
    ]);

    expect(blocks.map((b) => b.type)).not.toContain('heading');
    // 关键：`headingUse` 里**不该**出现「否决」这个规则 —— 因为没有东西被否决
    expect(report!.headingUse).toEqual({});
  });
});

describe('T3 方向二（确认）：模型说「这是小标题」→ 替代「文本像标题」那条判据', () => {
  /**
   * ⚠️ 这一组是「这条规则真的会改判」的证据。若确认的结论与几何永远
   * 相同，它就是一条**永远不会生效**的规则 —— 本项目的纪律是不留这种规则。
   *
   * 「1. 求下列极限」的形态：**够大**（78.7 > 42 × 1.3 = 54.6）、
   * **够短**（8 字 < 40），但 `looksLikeHeading` **拒收**它 ——
   * 编号后面跟的是空格而不是 `. ` / `、`，所以 `^\d+(\.\d+)*[\s、.]`
   * 匹配不上（`1. 求` 里 `1.` 后面是空格，其实**能**匹配 `[\s、.]` 的 `\s`）。
   *
   * 所以这里用一个**真的过不了**文本判据的形态：中文题号 `（一）`。
   * 它既不以 `第…章` 开头、也不是阿拉伯编号、也不是全大写英文 ——
   * 三条文本判据全不认，但版面上它就是一个小标题（居中、字号 78.7）。
   */
  /**
   * ⚠️ 这一组是「这条规则真的会改判」的证据。若确认的结论与几何永远
   * 相同，它就是一条**永远不会生效**的规则 —— 本项目的纪律是不留这种规则。
   *
   * 「（一）极限的定义」的形态：**够大**（78.7 > 42 × 1.3 = 54.6）、
   * **够短**（8 字 < 40），但 `looksLikeHeading` **拒收**它 ——
   * 中文题号 `（一）` 既不是「第…章」、也不是阿拉伯编号、
   * 也不是全大写英文，三条文本判据全不认。而版面上它确实是居中标题。
   */
  const layoutOnlyTitle = () => w('（一）极限的定义', 100, 1000, 78.7, 500);

  it('模型缺席：这一行**不是** heading（文本判据拒收它）', () => {
    const { blocks } = run([...headingRatioPage(), layoutOnlyTitle()], undefined);
    expect(blocks.map((b) => b.type)).not.toContain('heading');
    // 内容照旧在
    expect(blocks.map((b) => b.content).join('\n')).toContain('（一）极限的定义');
  });

  it('模型说 `paragraph_title`：同一行**变成** heading（这就是「用足类别」）', () => {
    const { blocks, report } = run([...headingRatioPage(), layoutOnlyTitle()], [
      region('text', 2, 90, 200, 1560, 760),
      region('paragraph_title', 0, 95, 985, 700, 1090),
    ]);

    const heading = blocks.find((b) => b.type === 'heading');
    expect(heading, '模型确认后必须出现一个 heading 块').toBeDefined();
    expect(heading!.content).toContain('（一）极限的定义');
    // 逐类别计数必须如实记下是**哪一条**规则改的判
    expect(report!.headingUse).toEqual({ layout_says_paragraph_title: 1 });
  });

  it('模型说 `doc_title`：同样确认，但记成**另一个**规则名', () => {
    const { report } = run([...headingRatioPage(), layoutOnlyTitle()], [
      region('text', 2, 90, 200, 1560, 760),
      region('doc_title', 11, 95, 985, 700, 1090),
    ]);
    expect(report!.headingUse).toEqual({ layout_says_doc_title: 1 });
  });

  /**
   * ⚠️ **确认这条不能变成「模型说了算」**：字号闸门与长度闸门必须还在。
   */
  it('模型说是标题、但**字号不够**：不判标题（模型不能把一行小字变标题）', () => {
    const small = w('（一）极限的定义', 100, 1000, 42, 500); // 与中位数同字号
    const { blocks, report } = run([...headingRatioPage(), small], [
      region('text', 2, 90, 200, 1560, 760),
      region('paragraph_title', 0, 95, 985, 700, 1090),
    ]);

    expect(blocks.map((b) => b.type)).not.toContain('heading');
    expect(report!.headingUse).toEqual({});
    // 而字号只要过了放松后的门槛（42 × 1.3 × 0.95 = 51.87），就该确认
    expect(42).toBeLessThan(42 * 1.3 * PARAGRAPH_TITLE_MIN_FONT_RATIO);
  });

  it('模型说是标题、但**文本确实超过 `maxChars`**：宽度闸门挡住它', () => {
    /**
     * ⚠️ 两道长度闸门必须分清，第一版这条用例就在这里错了一次：
     *
     *   · `looksLikeHeading` 的**文本证据**闸门是 **40 字**
     *     （它第一行就是 `if (text.length > 40) return false`）；
     *   · `HEADING_MAX_CHARS`（**块级**闸门，即本例要测的那一道）是 **80 字**。
     *
     * 40–80 字之间的行会**通过** `maxChars` 却被 `looksLikeHeading` 拒收 ——
     * 而 `paragraph_title` 这条类别**替代的正是 `looksLikeHeading`**，
     * 所以那一段的行在这一版里**会**被判成标题。这是刻意的，
     * 也正是「用足类别」的收益面。第一版用例拿 43 字去测 `maxChars`，
     * 红的原因是我把两道闸门搞混了。
     *
     * 所以这里取 **84 字**（> 80），稳稳越过 `maxChars`。
     */
    const longText =
      '（一）极限的定义与它的若干等价刻画以及在解题过程中的实际应用举例说明与完整证明过程，' +
      '并进一步讨论该定义在多元函数与数列情形下的推广形式以及常见反例的构造方法与判别技巧说明';
    const long = w(longText, 100, 1000, 78.7, 900);
    expect(longText.length).toBeGreaterThan(80);

    const { blocks, report } = run([...headingRatioPage(), long], [
      region('text', 2, 90, 200, 1560, 760),
      region('paragraph_title', 0, 95, 985, 1450, 1090),
    ]);

    expect(blocks.map((b) => b.type)).not.toContain('heading');
    // 而内容照旧一个字不少（闸门拒绝的是「类型」，不是「文本」）
    expect(blocks.map((b) => b.content).join('\n')).toContain('（一）极限的定义');
    // 「模型说是标题但太长」不该被记成一条生效的规则
    expect(report!.headingUse).toEqual({});
  });

  it('40–80 字之间：`maxChars` 放行、而 `paragraph_title` 替代了 40 字那条文本证据', () => {
    /**
     * 这一条把「替代」这件事**正面钉住**：同一段 43 字文本，
     * 模型缺席时是 `paragraph`（`looksLikeHeading` 拒收 > 40 字），
     * 模型说是 `paragraph_title` 时是 `heading`。
     * 少了它，「确认这条规则真的在改判」就只剩一个 8 字的例子，
     * 而看不出它究竟替代了哪一道闸门。
     */
    const mid = w(
      '（一）极限的定义与它的若干等价刻画以及在解题过程中的实际应用举例说明与完整证明过程',
      100,
      1000,
      78.7,
      900,
    );
    expect(mid.text.length).toBeGreaterThan(40);
    expect(mid.text.length).toBeLessThanOrEqual(80);

    const absent = run([...headingRatioPage(), mid], undefined);
    expect(absent.blocks.map((b) => b.type)).not.toContain('heading');

    const present = run([...headingRatioPage(), mid], [
      region('text', 2, 90, 200, 1560, 760),
      region('paragraph_title', 0, 95, 985, 1450, 1090),
    ]);
    expect(present.blocks.map((b) => b.type)).toContain('heading');
    expect(present.report!.headingUse).toEqual({ layout_says_paragraph_title: 1 });
  });
});

describe('T3 不变量：模型缺席时**每一条新判据都不触发**', () => {
  /**
   * 这一组是**清单**（验收标准第 4 条要求的「用例清单」的落点）：
   * 逐条证明 T3 引入的每个规则在「拿不到版面信息」时都不会改变任何结论。
   *
   * ⚠️ 它证明的是**同一个函数**在两个输入上的输出相同 —— 而不是
   * 「跑一遍没报错」。前者才能叫不变量。
   */
  const opts = { fontRatio: 1.3, maxChars: 80 };
  const looksLikeHeading = (text: string): boolean => /^\d+(\.\d+)*[\s、.]/.test(text);

  it('`headingDisposition(undefined, …)` 恒为「不表态」（`allowed: true`、无 `rule`）', () => {
    // 穷举一组有代表性的输入：够大/不够大 × 像标题/不像 × 长/短
    const texts = ['1. 求下列极限', '（一）极限的定义', '设随机变量X与Y相互独立', ''];
    const sizes = [0, 12, 42, 54.6, 78.7];
    for (const text of texts) {
      for (const size of sizes) {
        const d = headingDisposition(undefined, text, size, 42, opts, looksLikeHeading);
        expect(d, `text=${text} size=${size}`).toEqual({ allowed: true });
      }
    }
  });

  it('`geometricWouldBeHeading` 与改造前那条表达式**逐例相同**', () => {
    /**
     * 改造前 `flushParagraph` 里的表达式就是下面这个三合一。
     * 若 `geometricWouldBeHeading` 与它有任何一处漂移，
     * 「模型缺席时行为不变」这句话就不再成立。
     *
     * ⚠️ `medianFontSize > 0` 那一条**必须**写进来：改造前由
     * `median(...) || 12` 保证它恒成立，所以「改造前那条表达式」是
     * **四条**而不是三条。第一版这里漏了它，于是这条用例在
     * `median=0` 的探针上变红 —— 红的原因是**量错的仪器**，
     * 不是代码错了（`text=1. 求下列极限 size=42 median=0`）。
     */
    const before = (text: string, blockFontSize: number, medianFontSize: number): boolean =>
      medianFontSize > 0 &&
      blockFontSize > medianFontSize * 1.3 &&
      text.trim().length <= 80 &&
      looksLikeHeading(text);

    for (const text of ['1. 求下列极限', '（一）极限的定义', 'x'.repeat(120), '']) {
      for (const size of [0, 42, 54.61, 78.7]) {
        for (const median of [0, 42, 100]) {
          expect(
            geometricWouldBeHeading(text, size, median, opts, looksLikeHeading),
            `text=${text.slice(0, 8)} size=${size} median=${median}`,
          ).toBe(before(text, size, median));
        }
      }
    }
  });

  it('其他类别（`figure_title` / `image` / `footnote`）一律不表态', () => {
    for (const label of ['figure_title', 'image', 'footnote', 'aside_text', 'table', 'seal']) {
      expect(headingDisposition(label, '1. 求下列极限', 78.7, 42, opts, looksLikeHeading)).toEqual({
        allowed: true,
      });
    }
  });
});

describe('T3 门禁：否决名单**只收**该收的类别', () => {
  it('名单内容逐个点明（多一个都会扩大误伤面）', () => {
    expect([...HEADING_VETO_LABELS].sort()).toEqual(
      ['abstract', 'content', 'formula', 'formula_number', 'reference', 'text'].sort(),
    );
  });

  it('家具类别**不在**名单里：它们已经被摘掉了，放进来只会是死规则', () => {
    // 「永远不会触发的规则」正是本项目反复清理的假保护形态
    for (const label of ['header', 'footer', 'number', 'seal', 'header_image', 'footer_image']) {
      expect(HEADING_VETO_LABELS.has(label as never), `${label} 不该在否决名单里`).toBe(false);
    }
  });

  it('`paragraph_title` / `doc_title` 不在否决名单里（它们是确认族群）', () => {
    expect(HEADING_VETO_LABELS.has('paragraph_title')).toBe(false);
    expect(HEADING_VETO_LABELS.has('doc_title')).toBe(false);
  });
});
