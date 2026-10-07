import { describe, expect, it } from 'vitest';
import { ocrResultToBlocks, ocrTextToBlocks } from '@/lib/ocrPostProcess';

/**
 * OCR 结果转内容块的测试。
 *
 * ═══════════════════════════════════════════════════════════════
 * 这组测试对应一次"把能用的结果丢掉"的故障
 * ═══════════════════════════════════════════════════════════════
 *
 * 现象：10 页 OCR 跑完，报"未能从任何页面中提取出文字"，
 * 但诊断信息里写着 **"纯文本长度合计：7058 字符"**。
 *
 * 也就是说 tesseract 明明识别出了七千多字，代码却因为拿不到词级坐标
 * （`data.words` 与 `data.blocks` 都为空）而返回了空数组。
 *
 * **把"能用的结果"当成"没有结果"是最不该发生的缺陷。**
 * 下面这些用例锁死"只要有文本就必须产出内容块"这条不变量。
 */

const pageResult = (over: Partial<Parameters<typeof ocrResultToBlocks>[0]>) => ({
  pageNum: 1,
  words: [],
  avgConfidence: 0,
  ...over,
});

describe('ocrTextToBlocks：纯文本兜底', () => {
  it('空文本返回空数组', () => {
    expect(ocrTextToBlocks('')).toEqual([]);
    expect(ocrTextToBlocks('   \n\n  \t ')).toEqual([]);
  });

  it('单段文本产出一个段落块（这是 7058 字被丢掉的那个场景）', () => {
    const text = '这是一段由 OCR 识别出的中文内容，长度足够成为完整的段落，不应该被当成空结果丢弃。';
    const blocks = ocrTextToBlocks(text);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe('paragraph');
    expect(blocks[0]?.content).toBe(text);
    // 内容一个字都不能丢
    expect(blocks[0]?.content.replace(/\s/g, '')).toBe(text.replace(/\s/g, ''));
  });

  it('空行分段', () => {
    const blocks = ocrTextToBlocks(
      '第一段的内容足够长，应当独立成为一块而不是被合并。\n\n第二段的内容同样足够长，也应当独立成块。',
    );
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.content).toContain('第一段');
    expect(blocks[1]?.content).toContain('第二段');
  });

  it('没有空行但行数很多时按单行分段', () => {
    const blocks = ocrTextToBlocks(
      '第一行的内容足够长，可以独立成为一段。\n第二行的内容足够长，可以独立成为一段。\n第三行的内容足够长，可以独立成为一段。',
    );
    expect(blocks).toHaveLength(3);
  });

  it('识别章节标题', () => {
    const blocks = ocrTextToBlocks('第一章 计算机系统漫游\n\n正文内容在这里展开说明。');
    expect(blocks[0]?.type).toBe('heading');
    expect(blocks[0]?.content).toBe('第一章 计算机系统漫游');
  });

  it('识别编号标题与全大写英文标题', () => {
    expect(ocrTextToBlocks('1.1 信息就是位加上下文')[0]?.type).toBe('heading');
    expect(ocrTextToBlocks('CHAPTER ONE')[0]?.type).toBe('heading');
  });

  it('以句号结尾的短行不当作标题', () => {
    const blocks = ocrTextToBlocks('这是一句完整的话。');
    expect(blocks[0]?.type).toBe('paragraph');
  });

  it('合并过短的碎片，避免一句话被拆成多段', () => {
    // 模拟 tesseract 按视觉行拆分的输出
    const blocks = ocrTextToBlocks(
      '这是被视觉行拆分后\n产生的一堆短碎片\n它们本应属于同一段',
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.content).toContain('这是被视觉行拆分后');
    expect(blocks[0]?.content).toContain('它们本应属于同一段');
  });

  it('中文碎片之间不插空格', () => {
    const blocks = ocrTextToBlocks('中文短行\n另一行中文');
    expect(blocks[0]?.content).toBe('中文短行另一行中文');
  });

  it('英文碎片之间插空格', () => {
    const blocks = ocrTextToBlocks('short line\nanother line');
    expect(blocks[0]?.content).toBe('short line another line');
  });

  it('上一块已以句末标点收尾时不再合并', () => {
    const blocks = ocrTextToBlocks('这是一个完整的句子。\n另起的内容');
    expect(blocks).toHaveLength(2);
  });
});

describe('ocrResultToBlocks：词级坐标缺失时必须走文本兜底', () => {
  it('无词但有文本时，仍产出内容块（本缺陷的核心断言）', () => {
    const blocks = ocrResultToBlocks(
      pageResult({ pageText: '识别出了内容，但没有词级坐标。' }),
    );

    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks[0]?.content).toContain('识别出了内容');
  });

  it('无词且无文本时才返回空', () => {
    expect(ocrResultToBlocks(pageResult({ pageText: '' }))).toEqual([]);
    expect(ocrResultToBlocks(pageResult({}))).toEqual([]);
  });

  it('有词时走坐标路径，不使用文本兜底', () => {
    const blocks = ocrResultToBlocks(
      pageResult({
        pageText: '这段文本应当被忽略，因为词级坐标可用。',
        words: [
          {
            text: '坐标路径',
            confidence: 95,
            bbox: { x0: 10, y0: 10, x1: 100, y1: 30 },
            fontSize: 20,
          },
        ],
      }),
    );

    expect(blocks[0]?.content).toBe('坐标路径');
  });

  it('多页累计的文本都能被保住（模拟 4 页 × 约 1764 字的场景）', () => {
    const pageText = '这是一页扫描书正文的内容，长度大约相当于真实页面的一段。'.repeat(40);
    let total = 0;
    for (let page = 1; page <= 4; page++) {
      const blocks = ocrResultToBlocks(pageResult({ pageNum: page, pageText }));
      total += blocks.reduce((n, b) => n + b.content.length, 0);
    }
    // 关键：不能是 0
    expect(total).toBeGreaterThan(1000);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 上下标的几何识别与还原
// ═══════════════════════════════════════════════════════════════════
//
// 真实数学排版里指数**不是** Unicode 上标字符（`¹²³`），而是
// 「字号更小、位置更高」的另一个文本块 —— `BlockRow.tsx` 里已有的
// `normalizeSuperSub()` 只映射 Unicode 字符，对这种形态完全无能为力，
// 于是 `e^{-(x+y)}` 被平铺成 `e-(x+y)`。
//
// 用户实测的题目里正是这种形态：
//     f(x,y) = 1/2 (x+y) e^{-(x+y)},  x>0, y>0
//
// 判据保守到「不确定就不动」：宁可漏判（维持现状），也不能把正常文字
// 塞进 `^{...}`。下面每一条正常文本的用例都是**误判防线**。
//
// ⚠️ 这些坐标是**手工构造**的合成词框，不是从真实 PDF 量出来的。
// 它们验的是「判据在给定几何下是否按设计动作」，不能证明真实页面上
// 一定能判对 —— 那是另一回事，见本文件末尾的说明。
//
// ⚠️ 关于下面期望值里的中文空格（`已知函数e...` 而不是 `已知 函数 e...`）：
// 本项目的口径是**中文之间不插空格**，与 `mergeShortChunks` 的
// 「中文碎片之间不插空格」和 `ocrResultToBlocks` 行拼接里的
// `/[\u4e00-\u9fff]$/` 判断完全一致。理由见
// `ocrPostProcess.ts` 里 `appendWithJoin` 的注释：识别器常把一个中文词
// 切成单字词，一旦「一个词一个空格」，正文会变成 `这 是 一 段 普 通 的`。
// 本组用例关注的是上下标，期望值里的空格因此按项目口径写成无空格形式。

/**
 * 构造一个词。
 *
 * 宽度必须显式给：中文与 ASCII 的字宽不同，用「字数 × 系数」推宽度会让
 * 相邻中文词的框互相重叠，而重叠的词框在上下标判据里表现完全不同
 * （重心、水平间隙都会被带偏），测试就会验错东西 —— 这一点正是被
 * 第一版失败的用例抓出来的。
 */
const w = (text: string, x: number, y: number, h: number, width = 30, confidence = 90) => ({
  text,
  confidence,
  bbox: { x0: x, y0: y, x1: x + width, y1: y + h },
  fontSize: h,
});

describe('上下标：几何判定与 LaTeX 还原', () => {
  it('更小且更高的词被判为上标，包成 ^{...}', () => {
    // 三个 20px 高的正文词（y 88-108），最后一个带一个 13px 高、更靠上的指数
    const blocks = ocrResultToBlocks(
      pageResult({
        words: [
          w('已知', 40, 88, 20, 40),
          w('函数', 90, 88, 20, 40),
          w('e', 140, 88, 20, 12),
          w('-(x+y)', 154, 70, 13, 60),
        ],
      }),
    );

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.content).toBe('已知函数e$^{-(x+y)}$');
  });

  it('指数被拆成多个词时合并成同一段上下标', () => {
    const blocks = ocrResultToBlocks(
      pageResult({
        words: [
          w('设', 40, 88, 20, 20),
          w('函数', 70, 88, 20, 40),
          w('e', 120, 88, 20, 12),
          w('-', 134, 74, 12, 8),
          w('x', 144, 74, 12, 10),
        ],
      }),
    );

    expect(blocks[0]?.content).toContain('设函数e$^{-x}$');
  });

  it('更小且明显更低的词被判为下标，包成 _{...}', () => {
    const blocks = ocrResultToBlocks(
      pageResult({
        words: [
          w('设', 40, 88, 20, 20),
          w('变量', 70, 88, 20, 40),
          w('a', 120, 88, 20, 12),
          w('i', 134, 100, 11, 8),
        ],
      }),
    );

    expect(blocks[0]?.content).toBe('设变量a$_{i}$');
  });

  it('单个词的「行」不做任何改动（无法判定参考字号）', () => {
    const blocks = ocrResultToBlocks(pageResult({ words: [w('e', 100, 88, 20, 12)] }));
    expect(blocks[0]?.content).toBe('e');
  });

  it('只有两个词时不判定上下标（参考字号不可靠）', () => {
    const blocks = ocrResultToBlocks(
      pageResult({ words: [w('e', 100, 88, 20, 12), w('x', 114, 70, 13, 10)] }),
    );

    expect(blocks[0]?.content).toBe('e x');
    expect(blocks[0]?.content).not.toContain('^');
  });
});

describe('上下标：误判防线（这些用例比识别本身更重要）', () => {
  it('同一基线上的小一号文字**不得**被判为上标', () => {
    // 三个词同基线（y 都是 88），第三个略小 —— 错位为 0，绝不能变成公式
    const blocks = ocrResultToBlocks(
      pageResult({
        words: [
          w('参见', 40, 88, 20, 40),
          w('下图', 90, 88, 20, 40),
          w('注', 140, 88, 17, 17),
        ],
      }),
    );

    expect(blocks[0]?.content).toBe('参见下图注');
    expect(blocks[0]?.content).not.toContain('$');
  });

  it('更小但只低一点点（同一视觉行内的下沉）不得被判为下标', () => {
    const blocks = ocrResultToBlocks(
      pageResult({
        words: [
          w('参见', 40, 88, 20, 40),
          w('下图', 90, 88, 20, 40),
          w('注', 140, 90, 17, 17),
        ],
      }),
    );

    expect(blocks[0]?.content).not.toContain('_');
  });

  it('字号不够小（只小 5%）不得被判为上下标', () => {
    const blocks = ocrResultToBlocks(
      pageResult({
        words: [
          w('正文', 40, 88, 20, 40),
          w('内容', 90, 88, 20, 40),
          w('尾', 140, 74, 19, 19),
        ],
      }),
    );

    expect(blocks[0]?.content).not.toContain('$');
  });

  it('正常大小但偏高的词不得被判为上标（只有小字才可能是上下标）', () => {
    const blocks = ocrResultToBlocks(
      pageResult({
        words: [
          w('正文', 40, 88, 20, 40),
          w('内容', 90, 88, 20, 40),
          w('高', 140, 68, 20, 20),
        ],
      }),
    );

    expect(blocks[0]?.content).not.toContain('^');
  });

  it('整行普通中文正文一个字都不变（无脚本、无 LaTeX 标记）', () => {
    const text = '这是一段普通的识别结果，里面没有任何数学公式';
    const words = [...text].map((ch, i) => w(ch, 40 + i * 20, 88, 20, 20));
    const blocks = ocrResultToBlocks(pageResult({ words }));

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.content).toBe(text);
    expect(blocks[0]?.metadata.hasInlineMath).toBeUndefined();
  });

  it('整行字号一致时不会凭空产生公式（含拉丁字母与标点）', () => {
    const words = ['The', 'quick', 'brown', 'fox', 'jumps', 'over', 'the', 'lazy', 'dog.'].map(
      (t, i) => w(t, 40 + i * 50, 88, 20, 44),
    );
    const blocks = ocrResultToBlocks(pageResult({ words }));

    expect(blocks[0]?.content).toBe('The quick brown fox jumps over the lazy dog.');
  });
});

describe('上下标：输出可被渲染层安全消费', () => {
  it('LaTeX 特殊字符被转义（下划线）', () => {
    const blocks = ocrResultToBlocks(
      pageResult({
        words: [
          w('设', 40, 88, 20, 20),
          w('函数', 70, 88, 20, 40),
          w('e', 120, 88, 20, 12),
          w('a_b', 134, 74, 12, 24),
        ],
      }),
    );

    expect(blocks[0]?.content).toContain('$^{a\\_b}$');
  });

  it('上下标之间的空隙不产生多余空格（指数内的 `x+y`）', () => {
    const blocks = ocrResultToBlocks(
      pageResult({
        words: [
          w('设', 40, 88, 20, 20),
          w('函数', 70, 88, 20, 40),
          w('e', 120, 88, 20, 12),
          w('x', 134, 74, 12, 8),
          w('+', 146, 74, 12, 8),
          w('y', 158, 74, 12, 8),
        ],
      }),
    );

    expect(blocks[0]?.content).toContain('e$^{x+y}$');
  });

  it('含行内公式的块会带上 hasInlineMath 标记', () => {
    const blocks = ocrResultToBlocks(
      pageResult({
        words: [
          w('设', 40, 88, 20, 20),
          w('函数', 70, 88, 20, 40),
          w('e', 120, 88, 20, 12),
          w('x', 134, 70, 12, 8),
        ],
      }),
    );

    expect(blocks[0]?.metadata.hasInlineMath).toBe(true);
  });

  it('不带公式的块不会误带 hasInlineMath 标记', () => {
    const blocks = ocrResultToBlocks(
      pageResult({
        words: [w('普通', 40, 88, 20, 40), w('正文', 90, 88, 20, 40), w('内容', 140, 88, 20, 40)],
      }),
    );

    expect(blocks[0]?.metadata.hasInlineMath).toBeUndefined();
  });

  it('生成的 `$` 定界符成对出现（渲染层按 $...$ 切分，落单会吃掉整段文字）', () => {
    const blocks = ocrResultToBlocks(
      pageResult({
        words: [
          w('设', 40, 88, 20, 20),
          w('函数', 70, 88, 20, 40),
          w('e', 120, 88, 20, 12),
          w('x', 134, 70, 12, 8),
        ],
      }),
    );
    const content = blocks[0]?.content ?? '';

    expect((content.match(/\$/g) ?? []).length % 2).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 以题号开头的行必须另起一段
// ═══════════════════════════════════════════════════════════════════
//
// 这组用例对应**用户实测的另一个故障**：一份扫描版习题 PDF 识别之后，
// 整份题目的内容**全部挤成了一段** —— 「17. …」「20. …」「24. …」
// 连成一整块，每一题都读不出来。
//
// 根因不是几何判据写错了，而是**几何判据在这类版面上根本不够用**：
// 习题集里「题目与题目之间」的间距和「同一题的行与行之间」的间距
// **是一样的**，`gap > breakGap` 无论怎么调都区分不出来，
// 于是整页被并成一个段落。
//
// 被浪费掉的是一个几何之外的强信号：**每一题都以编号开头**。
// 编号是排版意图的显式声明，比任何间距阈值都可靠（见
// `ocrPostProcess.ts` 里 `NUMBERED_ITEM_RE` 上方的说明）。
//
// ⚠️ 这组用例的价值在于**回归保护**：把那条规则注释掉之后它们必须变红。
// 因此期望值刻意断言「块的个数」，而不只是「包含某段文字」——
// 只断言包含的话，内容全挤成一块时依然会通过，等于没测。
// 下面用 `blocksOf` 让同一套期望在**两条路径**上都跑一遍：
// 断段规则在「词坐标路径」与「纯文本兜底路径」各有一份实现，
// 只测一条会让两条实现悄悄跑偏（这个项目已经因此吃过一次亏）。

/** 两条路径各自取块：给了词就走坐标路径，否则走纯文本兜底 */
const blocksOf = (
  text: string,
  words?: Parameters<typeof ocrResultToBlocks>[0]['words'],
) => (words?.length ? ocrResultToBlocks(pageResult({ pageText: text, words })) : ocrTextToBlocks(text));

describe('编号行分段：整份习题不再挤成一段（回归保护）', () => {
  it('17. / 20. / 24. 开头的行各自另起一段（用户报的故障）', () => {
    const text = [
      '17. 设随机变量X与Y相互独立，且都服从参数为p的几何分布。',
      '20. 已知随机变量X服从二项分布b(n,p)，求X的分布律。',
      '24. 设总体X的概率密度函数为p(1-p)x+y-2，求参数p的矩估计。',
    ].join('\n');

    const blocks = blocksOf(text);

    // 三题必须是三块。并成一块时 blocks.length === 1，这条断言立刻变红。
    expect(blocks).toHaveLength(3);
    expect(blocks[0]?.content.startsWith('17.')).toBe(true);
    expect(blocks[1]?.content.startsWith('20.')).toBe(true);
    expect(blocks[2]?.content.startsWith('24.')).toBe(true);
    // 一块里不许混进别人的题号
    expect(blocks[0]?.content).not.toContain('20.');
    expect(blocks[1]?.content).not.toContain('24.');
  });

  it('走词坐标路径时同样按编号切段（两条路径必须同一口径）', () => {
    // ⚠️ 形状同样是刻意选的：**行距必须小到几何判据判不出来**。
    //
    // 断段阈值是 `min(max(中位行距, 字号) * 1.2, 字号 * 1.8)`。
    // 若把行距放成 24px（≥ 20 × 1.2），光靠几何判据就能断开，
    // 编号规则注释掉用例照样通过 —— 那就是**假保护**（实测踩过一次）。
    // 这里用 12px：小于 24，几何上只能算同一段，唯一的断点来源就是编号规则。
    //
    // 词按识别器的真实切分给（连续片段，不是单字）：单字切分会让
    // `17.` 变成 `1`/`7`/`.` 三个词，词之间还会被补空格（`1 7.`），
    // 那就不是在验真实形态了。
    const words = [
      w('17.', 40, 200, 20, 40),
      w('设随机变量X与Y相互独立，且都服从参数为p的几何分布。', 90, 200, 20, 400),
      w('20.', 40, 212, 20, 40),
      w('已知随机变量X服从二项分布b(n,p)，求X的分布律。', 90, 212, 20, 380),
      w('24.', 40, 224, 20, 40),
      w('设总体X的概率密度函数为p(1-p)x+y-2，求参数p的矩估计。', 90, 224, 20, 440),
    ];

    const blocks = ocrResultToBlocks(pageResult({ words }));

    expect(blocks).toHaveLength(3);
    expect(blocks[0]?.content.startsWith('17.')).toBe(true);
    expect(blocks[1]?.content.startsWith('20.')).toBe(true);
    expect(blocks[2]?.content.startsWith('24.')).toBe(true);
    // 每一题的正文各自留在自己那一块里（不能串到别的题上）
    expect(blocks[0]?.content).toContain('与Y相互独立');
    expect(blocks[1]?.content).toContain('b(n,p)');
    expect(blocks[2]?.content).toContain('p(1-p)x+y-2');
    expect(blocks[0]?.content).not.toContain('b(n,p)');
  });

  it('中文顿号编号（3、）同样识别为编号', () => {
    const text =
      '3、设随机变量X的分布函数为F(x)，求它的概率密度函数。\n' +
      '4、设随机变量Y服从正态分布，求它的数学期望与方差。';

    const blocks = blocksOf(text);

    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.content.startsWith('3、')).toBe(true);
    expect(blocks[1]?.content.startsWith('4、')).toBe(true);
  });

  it('括号形式的编号（7) / 8））同样识别为编号', () => {
    const text =
      '7) 设随机变量X服从均匀分布，求它的方差与标准差。\n' +
      '8）已知随机变量Y服从指数分布，求它的分布函数。';

    expect(blocksOf(text)).toHaveLength(2);
  });

  it('编号行紧跟上一段时，上一段正常收尾（不吞内容、不产生空块）', () => {
    const text =
      '本题给出了一段与本页题目无关的说明性文字，它应当独立成为一段。\n' +
      '17. 设随机变量X与Y相互独立，且都服从参数为p的几何分布。';

    const blocks = blocksOf(text);

    expect(blocks).toHaveLength(2);
    // 上一段的文字必须完整保留（不能被新段吞掉）
    expect(blocks[0]?.content).toContain('说明性文字');
    expect(blocks[0]?.content).not.toContain('17.');
    expect(blocks[1]?.content).toBe('17. 设随机变量X与Y相互独立，且都服从参数为p的几何分布。');
    // 不许出现空块：空块在阅读器里就是一块空白
    expect(blocks.every((b) => b.content.trim().length > 0)).toBe(true);
  });

  it('短的编号行同样各自另起一段（词坐标路径）', () => {
    // ⚠️ 这条用例的形状是刻意选的，它决定了用例是否真的在保护那条规则。
    //
    // 断段阈值是 `min(max(中位行距, 字号) * 1.2, 字号 * 1.8)`。
    // 行距若放到 24px（≥ 20 × 1.2），光靠几何判据就能断开，
    // 编号规则注释掉用例照样通过 —— 那就是**假保护**（实测踩过一次）。
    // 这里用 12px：几何上只能算同一段，唯一的断点来源就是编号规则。
    const words = [
      w('17. 求X的分布律', 40, 200, 20, 200),
      w('20. 求X的期望', 40, 212, 20, 200),
      w('24. 求p的矩估计', 40, 224, 20, 200),
    ];

    const blocks = ocrResultToBlocks(pageResult({ words }));

    expect(blocks).toHaveLength(3);
    expect(blocks[0]?.content).toBe('17. 求X的分布律');
    expect(blocks[1]?.content).toBe('20. 求X的期望');
    expect(blocks[2]?.content).toBe('24. 求p的矩估计');
  });

  it('一道题跨两行时，只在题号那行断开（不会把同一题切碎）', () => {
    // 两行的词框纵向重叠 9px（行距只有 11px）→ 几何判据判不出换段；
    // 而续行不以编号开头，必须留在同一块里。
    // 这条防的是「编号规则被写成见编号就切、把一道题切成一堆碎片」。
    const words = [
      w('17. 设随机变量X与Y相互独立', 40, 200, 20, 300),
      w('且都服从参数为p的几何分布。', 40, 211, 20, 280),
    ];

    const blocks = ocrResultToBlocks(pageResult({ words }));

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.content).toContain('17.');
    expect(blocks[0]?.content).toContain('几何分布');
  });

  it('编号出现在句子中间时不切段', () => {
    // 两行紧挨着：若编号规则被写成「文本里含编号就切」，
    // 第一行会被自己切开，这里就会多出一块
    const text = [
      '本页第 17. 题与本页第 20. 题属于同一组，请放在一起讨论。',
      '它们都要求先写出分布函数，再求期望与方差，最后核对答案。',
    ].join('\n');

    const blocks = blocksOf(text);

    expect(blocks).toHaveLength(2);
    // 句中编号只是普通文字，一行一个字都不该被切走
    expect(blocks[0]?.content).toBe('本页第 17. 题与本页第 20. 题属于同一组，请放在一起讨论。');
  });

  it('小数（3.14 / 2.718）不被当成编号', () => {
    // 单行输入：几何上没有任何切段理由，唯一的风险是「小数点被当成题号」。
    // 注意断言必须落在**完整内容**上 —— 只断言「包含 3.14」的话，
    // 即使它被切成两块（`3` 与 `.14 …`）也照样能通过。
    const line = '圆周率π的近似值为 3.14，这个数值在概率计算里经常出现，请记住它。';
    const blocks = ocrTextToBlocks(line);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.content).toBe(line);
    expect(blocks[0]?.content).toContain('3.14');
  });

  it('以小数开头的行不另起一段（这是最容易误判的形态）', () => {
    // `3.14` 出现在行首，形状上最像题号 —— 但它点号后面紧跟数字，
    // 不是编号形态。这里用词坐标路径验，且**词框按真实切分**给。
    const words = [
      w('3.14', 40, 100, 20, 40),
      w('是圆周率的近似值，在概率计算里经常出现，请记住这个常数。', 90, 100, 20, 480),
    ];

    const blocks = ocrResultToBlocks(pageResult({ words }));

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.content).toBe('3.14 是圆周率的近似值，在概率计算里经常出现，请记住这个常数。');
  });
});

describe('上下标：绑定了基字却判不出形态时，一个字都不能丢', () => {
  /**
   * ═══════════════════════════════════════════════════════════════
   * 这是一条**实测复现过**的丢字缺陷
   * ═══════════════════════════════════════════════════════════════
   *
   * 输入 `e` 后面跟一个被切开的小字指数 `-` `2` 时，输出曾是
   * `正文内容e$^{-}$` —— **`2` 整个消失了**。
   *
   * 根因是两条判据的口径不一致，中间留了一道缝：
   *  · `findScriptAnchors` 的兄弟传播只要求「与已绑定的兄弟词纵向错位
   *    不超过较小字高的 0.5 倍」，**不检查错位量本身**；
   *  · `inferScriptKind` 却要求错位量达到 0.18 / 0.25 倍正文字高。
   * 被兄弟带进来的词因此两边都不算：已经绑了基字 → 主循环跳过它；
   * 又判不出形态 → 拼装时 `continue` 丢掉。
   *
   * 修法是**只补回文字**（当作普通字排在基字后面），不放宽任何阈值 ——
   * 所以这些用例同时也是「误判防线没有被放宽」的证据。
   */
  it('被兄弟带进来的小字判不出形态时，按普通字补回（不许消失）', () => {
    const words = [
      w('正文', 40, 88, 20, 40),
      w('内容', 90, 88, 20, 40),
      w('e', 150, 88, 20, 10),
      // `-` 紧贴 `e`、又明显偏上 → 它自己就能绑上基字
      w('-', 160, 78.5, 13, 6),
      // `2` 与 `-` 在同一行带内（错位 0），因此被兄弟传播带进来，
      // 但它自己没有足够的错位量 → 判不出上标还是下标
      w('2', 166, 78.5, 13, 8),
    ];

    const blocks = ocrResultToBlocks(pageResult({ words }));
    const content = blocks[0]?.content ?? '';

    // 上半部分：形态判得出来时仍然正常还原成 `$^{-2}$`
    expect(content).toContain('e$^{-2}$');
    // 底线：识别出来的文字一个都不能少
    for (const word of words) {
      expect(content).toContain(word.text);
    }
  });

  it('错位量不到上标门槛的小字也必须补回来（曾经整块消失）', () => {
    // 中心上移恰好等于上标门槛（5px）的情形：
    // 锚定判据用的是「上移 ≥ 门槛」，而形态判据当时多要了一条
    // 「框的下沿不高于基字中心」，两者在边界上不一致 → 文字被丢掉
    const words = [
      w('正文', 40, 88, 20, 40),
      w('内容', 90, 88, 20, 40),
      w('e', 150, 88, 20, 10),
      w('2', 160, 85, 13, 8),
    ];

    const content = ocrResultToBlocks(pageResult({ words }))[0]?.content ?? '';

    expect(content).toContain('2');
    expect(content).toContain('e');
  });

  it('无论判成上标、下标还是普通字，输入里的每个词都要出现在输出里', () => {
    // 把几种典型形态一起过一遍，锁住「不丢字」这条不变量。
    // 这也是本项目最容易违反的一条：任何一处提前 `continue`
    // 都会让某个词无声无息地消失，而用户根本不知道原文有它。
    const cases: Parameters<typeof ocrResultToBlocks>[0]['words'][] = [
      [
        w('正文', 40, 88, 20, 40),
        w('内容', 90, 88, 20, 40),
        w('e', 150, 88, 20, 10),
        w('-', 160, 78.5, 13, 6),
        w('2', 166, 80, 13, 8),
      ],
      [
        w('设', 40, 88, 20, 20),
        w('变量', 70, 88, 20, 40),
        w('a', 120, 88, 20, 12),
        w('i', 134, 100, 11, 8),
      ],
      [
        w('参见', 40, 88, 20, 40),
        w('下图', 90, 88, 20, 40),
        w('注', 140, 90, 17, 17),
      ],
    ];

    for (const words of cases) {
      const content = ocrResultToBlocks(pageResult({ words }))
        .map((b) => b.content)
        .join('\n');
      for (const word of words) {
        expect(content).toContain(word.text);
      }
    }
  });
  it('指数被切成多个词时，整条链上的词都不许丢（实测丢过 `2`）', () => {
    /**
     * ═══════════════════════════════════════════════════════════════
     * 这条用例覆盖一个**实测丢字**的形态，必须用扫描才抓得到
     * ═══════════════════════════════════════════════════════════════
     *
     * 单个位移值试不出问题：`-`（紧贴基字）与 `2`（跟在 `-` 后面）
     * 的相对错位要落在某个区间里，`2` 才会被绑到 `-` 上而不是 `e` 上 ——
     * 这时 `2` 的基字自己也是个上下标，拼装时 `e` 那一轮只拿挂在自己
     * 名下的词拼公式，于是 `2` 谁也不管，**整个字符消失**（实测输出
     * 是 `e$^{-}$`，`2` 不见了）。
     *
     * 所以这里对位移做一次扫描：只要有一个位置丢字就变红。
     * 这也是「识别出的文字一个都不能少」这条不变量的回归保护。
     */
    for (let dy = 0; dy <= 12; dy++) {
      const words = [
        w('正文', 40, 88, 20, 40),
        w('内容', 90, 88, 20, 40),
        w('e', 150, 88, 20, 12),
        w('-', 162, 76, 13, 8),
        w('2', 170, 76 + dy, 13, 8),
      ];
      const content = ocrResultToBlocks(pageResult({ words }))
        .map((b) => b.content)
        .join('\n');

      for (const word of words) {
        expect(content, `dy=${dy} 时 ${JSON.stringify(word.text)} 消失了`).toContain(word.text);
      }
      // `$` 必须成对：落单的定界符会让渲染层把整段文字吃掉
      expect((content.match(/\$/g) ?? []).length % 2, `dy=${dy} 的 $ 不成对`).toBe(0);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// 跨行构件的阅读顺序
// ═══════════════════════════════════════════════════════════════════
//
// 跨行大括号/堆叠分数的检测框又高又怪，它的中心 y 与两侧分支都不在
// 同一个容差内 → 原来会被拆成不同的「行」，按 y 排序拼接时上下文交错。
// 这里验「分支之间的相对顺序」与「不该合并的两行不会被合并」。
//
// ⚠️ 必须说清楚界限：**内容整块消失与阅读顺序无关**。那块内容经核对是
// 识别器根本没返回（`words` 里没有它），本组用例只覆盖顺序，
// 不能证明「主分支消失」已被修复。

describe('跨行构件：阅读顺序', () => {
  it('同一纵向区域内的分支不再与上下文交错，主行排最前', () => {
    const blocks = ocrResultToBlocks(
      pageResult({
        words: [
          w('f(x,y)', 60, 200, 20, 60),
          w('=', 124, 200, 20, 12),
          w('1/2(x+y)e', 140, 200, 20, 90),
          w('0,', 78, 248, 14, 22), // 落在主式跨度之内的下分支
        ],
      }),
    );

    expect(blocks).toHaveLength(1);
    const content = blocks[0]?.content ?? '';
    const main = content.indexOf('f(x,y)');
    const branch = content.indexOf('0,');

    expect(main).toBeGreaterThanOrEqual(0);
    expect(branch).toBeGreaterThanOrEqual(0);
    // 主式必须在下分支之前，且两者落在同一个块里（不再被别的行隔开）
    expect(main).toBeLessThan(branch);
  });

  it('没有等号时也不会把上分支排到主行后面', () => {
    const blocks = ocrResultToBlocks(
      pageResult({
        words: [
          w('甲组', 60, 200, 20, 40),
          w('乙组', 110, 200, 20, 40),
          w('丙组', 160, 200, 20, 40),
          w('合计', 100, 248, 14, 28),
        ],
      }),
    );

    const content = blocks[0]?.content ?? '';
    expect(content.indexOf('甲组')).toBeLessThan(content.indexOf('合计'));
  });

  it('左对齐的相邻两行不得被并成一行（它们只是排版上挨着）', () => {
    const blocks = ocrResultToBlocks(
      pageResult({
        words: [
          w('这一行文字明显长得多，因为它写了很多字', 40, 200, 20, 380),
          w('短行', 40, 250, 14, 28),
        ],
      }),
    );

    const first = blocks[0]?.content ?? '';
    const second = blocks[1]?.content ?? '';

    // 判据是「不许并成一行」，所以断言必须落在**两个块**上。
    //
    // 这里改过一次：原断言要求两段文字都出现在 `blocks[0]` 里、且长行在前，
    // 那实际上是在承认它们已经被并进同一块 —— 与本用例的名字（不得被并成一行）
    // 正好相反。修好构件合并之后它们本来就会分成两块，于是断言失败。
    // 现在如实断言：两行各自成块、顺序为先上后下。
    expect(blocks).toHaveLength(2);
    expect(first).toContain('这一行文字');
    expect(second).toContain('短行');
  });

  it('间隔很远的两行不会被并到同一块里', () => {
    const blocks = ocrResultToBlocks(
      pageResult({
        words: [
          w('上一段的内容', 40, 200, 20, 120),
          w('下一段的内容', 40, 320, 20, 120),
        ],
      }),
    );

    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.content).toContain('上一段');
    expect(blocks[1]?.content).toContain('下一段');
  });

  it('行内词按 x 排序（识别器返回顺序不影响输出顺序）', () => {
    const blocks = ocrResultToBlocks(
      pageResult({
        words: [
          w('丙', 180, 200, 20, 20),
          w('甲', 40, 200, 20, 20),
          w('乙', 110, 200, 20, 20),
        ],
      }),
    );

    expect(blocks[0]?.content).toBe('甲乙丙');
  });
});

/**
 * ═══════════════════════════════════════════════════════════════
 * 用**用户真实文档的数据**做回归保护
 * ═══════════════════════════════════════════════════════════════
 *
 * 坐标、字号、词数全部取自用户导出的 `ocr-structure` JSON
 * （那份习题 PDF：画布高 2223、23 个词、dominantFontSize 42.5）。
 *
 * 当时的故障是**整页被合并成了一行**：
 *   第一行 yRange = [212, 1628]，跨度 **1416 像素**、含 **18 个词**。
 * 后果就是整页挤成一段，题目 17/20/24/28 全连在一起。
 *
 * 根因：`canMergeAsBranch` 的判据 1（纵向重叠）与判据 2（横向压得实）
 * **都没有纵向距离上限**，而 host 跨度会随每次合并不断变宽 →
 * 链式反应 → 跨度覆盖页宽之后整页被吞。
 *
 * 这组用例钉的就是那个根因：**横向被包住但纵向隔很远的两行，绝不能并。**
 */
describe('真实文档回归：整页不得被合并成一行', () => {
  // 第一题：长行，水平跨度 225→1604
  const q17 = w(
    '17. 设 随机 变量 (X ,Y) 具有 分 布律 P {X = x ,Y = y} = p (1 − p )x+y−2 ,0 < p < 1',
    225,
    212,
    43,
    1379,
    90,
  );
  // 第三题：落在 q17 的水平跨度**之内**，但纵向低 719 像素
  const q24 = w('24. 设随机变量(X,Y)的概率密度为', 211, 931, 43, 545, 93);
  // 第四题：更低，纵向差 1185 像素
  const q28 = w(
    '28. 设 X,Y是相互独立的随机变量，它们都服从正态分布 N(0，σ²).试',
    225,
    1397,
    38,
    956,
    94,
  );

  it('横向被包住、纵向隔了 719 像素的两行必须分开', () => {
    const blocks = ocrResultToBlocks(pageResult({ words: [q17, q24] }));

    // 修好之前这里只有 1 个块（整页一行）
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    expect(blocks.some((b) => b.content.includes('17.'))).toBe(true);
    expect(blocks.some((b) => b.content.includes('24.'))).toBe(true);
  });

  it('三题依次排开时，每个题号都还在，且不再是「整页一块」', () => {
    const blocks = ocrResultToBlocks(pageResult({ words: [q17, q24, q28] }));
    const text = blocks.map((b) => b.content).join('\n');

    for (const marker of ['17.', '24.', '28.']) {
      expect(text, `题号 ${marker} 不应消失`).toContain(marker);
    }
    expect(blocks.length).toBeGreaterThanOrEqual(2);
  });

  it('页脚（远在页面底部）不得被并进正文', () => {
    // 真实页脚 y=2149，与正文最低的 q28（y=1397）相差 752 像素
    const footer = w('单周周一下午2点前交作业', 634, 2149, 42, 401, 100);
    const blocks = ocrResultToBlocks(pageResult({ words: [q17, q24, footer] }));

    // 页脚要么被过滤掉、要么单独成块，但绝不能被并进某道题里
    for (const b of blocks) {
      if (b.content.includes('交作业')) {
        expect(b.content.length).toBeLessThan(60);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 以下内容追加到 src/lib/ocrPostProcess.test.ts 的**文件末尾**
//（该文件里已有 `pageResult` 与 `w` 两个 helper，这里直接复用，不再声明）
// ═══════════════════════════════════════════════════════════════

/**
 * 用户那份习题 PDF 第 1 页的**实测几何**（画布高 2223、中位字号 42）。
 * 只列本组用例真正用到的那几个量：页眉、页脚、以及第 5 行的三个词。
 */
const REAL_CANVAS_HEIGHT = 2223;
const REAL_HEADER = w('概率论与数理统计习题5', 440, 80, 36, 344, 95);
const REAL_FOOTER = w('单周周一下午2点前交作业', 634, 2170, 42, 401, 100);

/** 正文行：字高与真实页一致（42），宽度取真实首题量到的 1379 */
const realBodyLine = (text: string, y: number, width: number) => w(text, 225, y, 42, width, 92);

const REAL_17 =
  '17. 设 随机 变量 (X ,Y) 具有 分 布律 P {X = x ,Y = y} = p (1 − p )x+y−2 ,0 < p < 1';
const REAL_19 = '19. 设X的分布函数为F(x)，求它的概率密度函数。';
const REAL_20 = '20. 已知X服从二项分布b(n,p)，求X的分布律。';
const REAL_21 = '21. 设X与Y相互独立，都服从参数p的几何分布。';
const REAL_24 = '24. 设总体X的概率密度函数为p(1-p)x+y-2，求参数p的矩估计。';

function realPage() {
  const body = [
    realBodyLine(REAL_17, 250, 1379),
    realBodyLine(REAL_19, 314, 900),
    realBodyLine(REAL_20, 378, 880),
    realBodyLine(REAL_21, 442, 950),
  ];
  return { body, words: [REAL_HEADER, ...body, REAL_FOOTER] };
}

describe('真实文档回归：页眉/页脚不得出现在 blocks 里', () => {
  it('页眉「概率论与数理统计习题5」（y=80 / 字号 36）被滤掉', () => {
    const { words } = realPage();
    const blocks = ocrResultToBlocks(pageResult({ words }), REAL_CANVAS_HEIGHT);

    expect(blocks.some((b) => b.content.includes('概率论与数理统计习题5'))).toBe(false);
    expect(blocks[0]?.content.startsWith('17.')).toBe(true);
  });

  it('页脚「单周周一下午2点前交作业」（y=2170 / 字号 42，与正文同字号）被滤掉', () => {
    const { words } = realPage();
    const blocks = ocrResultToBlocks(pageResult({ words }), REAL_CANVAS_HEIGHT);

    expect(blocks.some((b) => b.content.includes('交作业'))).toBe(false);
  });

  it('页眉页脚被滤掉之后正文一个词都不能少', () => {
    const { body, words } = realPage();
    const blocks = ocrResultToBlocks(pageResult({ words }), REAL_CANVAS_HEIGHT);
    const text = blocks.map((b) => b.content).join('\n');

    for (const line of body) {
      expect(text, `${line.text.slice(0, 8)}… 消失了`).toContain(line.text.slice(0, 12));
    }
    expect(blocks.length).toBeGreaterThan(0);
  });
});

describe('真实文档回归：公式检测框撑大的行不得判成 heading', () => {
  /** 真实数据：字号 78.7 / 87.5 / 58，该页中位字号 42（门槛 54.6） */
  const REAL_HEADING_LINES = [
    'Z= 当X>Y 其中λ>0，μ>0是常数.引入随机变量=10, 当X>Y',
    'fz(e)= 0 0, 其他',
    'P).',
  ];

  function headingPage() {
    return [
      realBodyLine(REAL_19, 165, 900),
      realBodyLine(REAL_20, 225, 880),
      realBodyLine(REAL_21, 285, 950),
      w(REAL_HEADING_LINES[0] ?? '', 225, 296, 78.7, 700, 88),
      w(REAL_HEADING_LINES[1] ?? '', 225, 470, 87.5, 260, 88),
      realBodyLine(REAL_24, 560, 940),
      w(REAL_HEADING_LINES[2] ?? '', 225, 790, 58, 70, 88),
      realBodyLine('以下为下一节的正文，用来把整页的中位字号钉在 42 上。', 900, 700),
    ];
  }

  it('三行真实数据都不得是 heading', () => {
    const blocks = ocrResultToBlocks(pageResult({ words: headingPage() }), REAL_CANVAS_HEIGHT);
    const headings = blocks.filter((b) => b.type === 'heading').map((b) => b.content);
    const text = blocks.map((b) => b.content).join('\n');

    for (const line of REAL_HEADING_LINES) {
      expect(headings, `「${line.slice(0, 12)}…」不应是 heading`).not.toContain(line);
      expect(headings.some((h) => h.includes(line.slice(0, 10)))).toBe(false);
      expect(text).toContain(line);
    }
  });

  it('真正的章节标题仍然判成 heading —— 防「一刀切禁掉标题」', () => {
    const words = [
      w('第一章 绪论', 225, 120, 78.7, 116, 92),
      realBodyLine(REAL_19, 260, 900),
      realBodyLine(REAL_20, 325, 880),
      realBodyLine(REAL_21, 390, 950),
      w('小标题甲', 225, 470, 58, 116, 88),
    ];
    const blocks = ocrResultToBlocks(pageResult({ words }), REAL_CANVAS_HEIGHT);

    expect(blocks[0]?.type).toBe('heading');
    expect(blocks[0]?.content).toBe('第一章 绪论');
    // 反面：字号同量级但没有标题形态的短行不得被一并放过
    expect(blocks.find((b) => b.content === '小标题甲')?.type).toBe('paragraph');
  });
});

describe('真实文档回归：跨行构件内的词序必须按 y', () => {
  it('构件里的行序必须按 y：主行在下时不得被提到最前', () => {
    // ⚠️ 这个形状是**实测扫出来的**，保证被测的正是「行序」这一条：
    //   · 两个词的中心 y 差 55px → 各自成一个桶（容差 5px 挂不住）；
    //   · 下面那行（含 `=`）**又宽又高**（400×40 对 160×30），
    //     正是 `pickPrimaryLine` 认定的「主行」；
    //   · 它更高 → 横向包含判据不成立，因此它不会先去吃掉上面那行，
    //     上面那行的桶先建好、主行再并进来 —— 与「谁先当主机」无关；
    //   · 于是唯一的变数就是行序：主行的 y 比上面那行的桶中心低，
    //     原来会被提到最前，读出来是 `=M 主行=B 承接上文`。
    // 实测：这一形状在原逻辑下给出 wordIndices = [1, 0]（读成
    // `=M 主行=B 承接上文`），修好后是 [0, 1]（换过 8 组其它形状都区分不出来）。
    const upper = w('=B 承接上文', 300, 550, 30, 160, 90);
    const main = w('=M 主行', 300, 600, 40, 400, 90);

    expect((upper.bbox.y0 + upper.bbox.y1) / 2).toBe(565);
    expect((main.bbox.y0 + main.bbox.y1) / 2).toBe(620);

    let captured: Parameters<NonNullable<Parameters<typeof ocrResultToBlocks>[2]>>[0] | undefined;
    const blocks = ocrResultToBlocks(
      pageResult({ words: [upper, main] }),
      REAL_CANVAS_HEIGHT,
      (structure) => {
        captured = structure;
      },
    );

    const line = captured?.lines.find((l: { text: string }) => l.text.includes('承接上文'));
    expect(line).toBeDefined();
    expect(line?.wordIndices).toEqual([0, 1]);
    expect(line?.text).toBe('=B 承接上文=M 主行');
    expect(blocks[0]?.content).toContain('=B 承接上文=M 主行');
  });

  it('含 `=` 的行排在后面时同样不得被提到最前（全 ASCII 形状）', () => {
    // 与上一条同一个机制，换成全 ASCII 文本，并且**只有下面那行含 `=`**：
    // 上一条里两行都含 `=`，`pickPrimaryLine` 会挑中上面那行 —— 那是我第一版
    // 用例的毛病（验到的是「谁含等号」而不是「主行排在哪」），这里避开。
    const upper = w('AB CD EF GH', 100, 300, 20, 160, 90);
    const main = w('X = Y', 100, 350, 30, 260, 90);

    let captured: Parameters<NonNullable<Parameters<typeof ocrResultToBlocks>[2]>>[0] | undefined;
    const blocks = ocrResultToBlocks(
      pageResult({ words: [upper, main] }),
      REAL_CANVAS_HEIGHT,
      (structure) => {
        captured = structure;
      },
    );

    expect(captured?.lines[0]?.wordIndices).toEqual([0, 1]);
    expect(blocks[0]?.content).toBe('AB CD EF GH X = Y');
  });

  it('同一行的词序不变（防「把词全按 y 重排」）', () => {
    const words = [
      w('甲乙丙', 40, 200, 20, 90),
      w('丁戊己', 140, 200, 20, 90),
      w('庚辛壬', 240, 200, 20, 90),
    ];
    const blocks = ocrResultToBlocks(pageResult({ words }), REAL_CANVAS_HEIGHT);

    expect(blocks[0]?.content).toBe('甲乙丙丁戊己庚辛壬');
  });
});

// ═══════════════════════════════════════════════════════════════
// 以下内容追加到 src/lib/ocrPostProcess.test.ts 的**文件末尾**
//（该文件里已有 `w` / `pageResult` / `REAL_CANVAS_HEIGHT` 三个 helper，
// 这里直接复用，不再声明 —— 重名会直接编译不过）
// ═══════════════════════════════════════════════════════════════

/**
 * ═══════════════════════════════════════════════════════════════
 * 用户那份习题 PDF 第 1 页的**完整真实导出**
 * ═══════════════════════════════════════════════════════════════
 *
 * 23 个词、15 条 line、14 个 block（`canvasHeight: 2223`、
 * 导出的 `dominantFontSize: 43`）。坐标、字号全部照抄 `ocr-structure` JSON，
 * 一个数都没有改；词序就是导出里的 `i`。
 *
 * ⚠️ 最容易搞错的一个量：导出里的 `dominantFontSize: 43` 是**行字号的中位数**
 * （`ocrResultToBlocks` 传给 `buildOcrStructure` 的就是 `medianFontSize`），
 * 而 `groupWordsIntoLines` 内部真正用的是**词高的众数**
 * `dominantFontSize(words)`。这一页的众数是 **36**（36 高有 5 个词：
 * 0/2/10/13/16；43 高只有 4 个），所以 `0.9 × 36 = 32.4` ——
 * 36 高的词 10 / 13 / 16 **都进不了上下标候选**。这一点必须照实复现，
 * 否则整页会走成另一条完全不同的路径（把参考字号当成 40 时，
 * 词 16 会被 `attachDetachedScriptLines` 当成词 15 的下标挂上去）。
 */
const branchRealWord = (
  text: string,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  fontSize: number,
) => ({ text, confidence: 90, bbox: { x0, y0, x1, y1 }, fontSize });

const BRANCH_REAL_WORDS = [
  branchRealWord('概率论与数理统计习题5', 657, 44, 1010, 80, 36),
  branchRealWord(
    '17. 设 随机 变量 (X ,Y) 具有 分 布律 P {X = x ,Y = y} = p (1 − p )x+y−2 ,0 < p < 1,x ,y 均为 正',
    225,
    212,
    1604,
    255,
    43,
  ),
  branchRealWord('整数，问X，Y是否相互独立.', 147, 266, 573, 302, 36),
  branchRealWord('20. 设 X和Y是相互独立的随机变量，其概率密度分别为', 225, 418, 1050, 460, 42),
  branchRealWord('其中λ>0，μ>0是常数.引入随机变量', 162, 568, 752, 609, 41),
  branchRealWord('Z= 当X>Y', 258, 599, 647, 723, 124),
  branchRealWord('=10, 当X>Y', 343, 649, 628, 720, 71),
  branchRealWord('(1） 求 条件 概率 密度 f x|Y(x |y).', 228, 720, 709, 763, 43),
  branchRealWord('(2) 求 Z 的分布律和分布函数.', 231, 775, 681, 812, 37),
  branchRealWord('24. 设随机变量(X,Y)的概率密度为', 211, 931, 756, 974, 43),
  branchRealWord('）', 433, 1061, 477, 1097, 36),
  branchRealWord('0，', 566, 1066, 639, 1120, 54),
  branchRealWord('其他', 810, 1066, 912, 1120, 54),
  branchRealWord('(1)问 X 和 Y 是否相互独立？', 218, 1122, 649, 1158, 36),
  branchRealWord('(2) 求 Z = X + Y 的概率密度.', 215, 1170, 681, 1208, 38),
  branchRealWord('28. 设 X,Y是相互独立的随机变量，它们都服从正态分布 N(0，σ²).试', 225, 1397, 1181, 1435, 38),
  branchRealWord('验证随机变量 Z = √X2 + Y 的概率密度为', 167, 1452, 778, 1488, 36),
  branchRealWord('fz(e)= 0', 255, 1482, 739, 1603, 121),
  branchRealWord('0, 其他', 480, 1574, 709, 1628, 54),
  branchRealWord('我们称 Z 服从参数 为σ(σ > 0) 的瑞利(Rayleigh) 分布.', 166, 1629, 918, 1666, 37),
  branchRealWord(
    '35. 设 X,Y是相互独立的随机变量,X ∼ b(n1,p),Y∼ b(n2,p),证明Z = X +Y∼b(n1+n₂,',
    215,
    1826,
    1519,
    1869,
    43,
  ),
  branchRealWord('P).', 140, 1868, 231, 1926, 58),
  branchRealWord('单周周一下午2点前交作业', 634, 2149, 1035, 2191, 42),
];

type BranchLine = {
  text: string;
  y: number;
  fontSize: number;
  wordIndices: number[];
  xRange: [number, number];
  yRange: [number, number];
  hasScripts: boolean;
};

type BranchStructure = {
  dominantFontSize: number;
  lines: BranchLine[];
  blocks: { type: string; content: string }[];
};

function branchStructureOf(words: Parameters<typeof pageResult>[0]['words']): BranchStructure {
  let captured: BranchStructure | undefined;
  ocrResultToBlocks(pageResult({ words }), REAL_CANVAS_HEIGHT, (s) => {
    captured = s as unknown as BranchStructure;
  });
  if (!captured) throw new Error('导出回调没有被调用');
  return captured;
}

/** 取「包含某个词」的那一条 line（下标就是导出里的 `i`，直接写真实数字） */
const branchLineWith = (structure: BranchStructure, index: number) =>
  structure.lines.find((line) => line.wordIndices.includes(index));

/** 整页的真实结构（每个用例都重新算一次，避免相互污染） */
const branchRealPage = () => branchStructureOf(BRANCH_REAL_WORDS);

/**
 * ═══════════════════════════════════════════════════════════════
 * 真实文档回归：构件合并不得把正文行焊成一行
 * ═══════════════════════════════════════════════════════════════
 *
 * 上一轮为了让「跨行大括号 / 堆叠分数」能合并，把 `mergeContainedBranches`
 * 改成了**宽度大的行先当主机**。而页面上最宽的行恰恰是**正文行**，
 * 于是它成了主机，邻近的正文行在几何上又完全满足「比主机窄 +
 * 纵向间隔在 1.4 倍字号带内」—— 就被当成「分支」吸收了。
 * 下面用的就是导出里那几行，`wordIndices` / `yRange` 都照抄导出。
 */
describe('真实文档回归：构件合并不得把正文行焊成一行', () => {
  it('A：孤立的 `）`（词 10）不得被并进下一行正文（词 13）', () => {
    // 回归时（实测导出）：一条 line 的 wordIndices = [10, 13]、yRange = [1061, 1158]
    const structure = branchRealPage();

    expect(branchLineWith(structure, 13)?.wordIndices).toEqual([13]);
    expect(branchLineWith(structure, 13)?.yRange).toEqual([1122, 1158]);
    expect(branchLineWith(structure, 10)?.wordIndices).toEqual([10]);
    expect(branchLineWith(structure, 10)?.yRange).toEqual([1061, 1097]);

    // 块一级：孤立符号与下一行各自成块（导出里它们是同一个 block）
    expect(structure.blocks.find((b) => b.content === '）')).toBeDefined();
    expect(
      structure.blocks.some((b) => b.content === '(1)问 X 和 Y 是否相互独立？'),
    ).toBe(true);
  });

  it('B：整句正文（词 19）不得被公式块吞掉', () => {
    // 回归时（实测导出）：一条 line 的 wordIndices = [17, 18, 19]、
    // yRange = [1482, 1666]（跨度 184px）、fontSize 70.7
    const structure = branchRealPage();

    expect(branchLineWith(structure, 19)?.wordIndices).toEqual([19]);
    expect(branchLineWith(structure, 19)?.yRange).toEqual([1629, 1666]);
    expect(branchLineWith(structure, 19)?.fontSize).toBe(37);
    expect(
      structure.blocks.some(
        (b) => b.content === '我们称 Z 服从参数 为σ(σ > 0) 的瑞利(Rayleigh) 分布.',
      ),
    ).toBe(true);

    // 公式那一对（跨行大括号的下分支）**仍然要合并** —— 修的是过度合并，不是禁止合并
    expect(branchLineWith(structure, 17)?.wordIndices).toEqual([17, 18]);
    expect(branchLineWith(structure, 17)?.yRange).toEqual([1482, 1628]);
  });

  it('C：两行普通正文（词 15 / 词 16）不得互相并', () => {
    // ⚠️ 诚实说明：**在这份导出里 C 并没有发生** —— 词 15（yRange [1397,1435]）
    // 与词 16（yRange [1452,1488]）本来就是两条 line（只在同一个 block 里）。
    // 原因是这一页的词高众数是 36，而 `attachDetachedScriptLines` 要求候选
    // `fontSize ≤ 0.9 × 参考字号 = 32.4` —— 36 高的词 16 根本进不了候选。
    // 所以这条是**守卫用例**（防止以后被回归引入），不是复现用例；
    // 同一条判据真正的漏洞见下面那条构造用例。
    const structure = branchRealPage();

    expect(branchLineWith(structure, 15)?.wordIndices).toEqual([15]);
    expect(branchLineWith(structure, 16)?.wordIndices).toEqual([16]);
    expect(branchLineWith(structure, 16)?.yRange).toEqual([1452, 1488]);
  });

  it('整页不变量：17 组词的真实分组、页眉页脚、以及「不产生假公式」', () => {
    // 这一条把**整页**的真实分组钉死：修好之后 15 条 line 变 17 条，
    // 多出来的正是 A 与 B 拆开的那两条 —— 别的地方一个都不许动。
    const structure = branchRealPage();
    const groups = structure.lines.map((line) => line.wordIndices.join(','));

    expect(groups).toEqual([
      '1',
      '2',
      '3',
      '4,5,6',
      '7',
      '8',
      '9',
      '10',
      '11,12',
      '13',
      '14',
      '15',
      '16',
      '17,18',
      '19',
      '20',
      '21',
    ]);

    // 页眉（词 0）与页脚（词 22）必须仍然被滤掉，一个字都不许进正文
    const text = structure.lines.map((line) => line.text).join('\n');
    expect(text).not.toContain('概率论与数理统计习题5');
    expect(text).not.toContain('单周周一下午2点前交作业');
    // 这一页没有任何真正的上下标，因此不许凭空出现 `$`（渲染层按 `$...$` 切分）
    expect(text).not.toContain('$');
    expect(structure.lines.every((line) => line.hasScripts === false)).toBe(true);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════
 * `attachDetachedScriptLines` 的漏洞（构造用例）
 * ═══════════════════════════════════════════════════════════════
 *
 * 这条补救路径原来的三条几何判据**全部形同虚设**：
 *   · `fontSize ≤ 0.9 × 参考字号`：参考字号 40 时上限正好是 36 —— 正文行高 36；
 *   · 行间距离 ≤ 36px：普通行距本来就落在里面（实测 17px）；
 *   · 水平间隙：两行横向重叠时算出来是**负数**（225 − 778 = −553），
 *     `负数 > 上限` 恒为假。
 * 于是**一整行正文**能被当成上一行的下标挂上去。
 *
 * ⚠️ 触发前提：词高众数必须 ≥ 40（否则 36 高的候选进不了门 —— 这一页的
 * 众数是 36，所以真实导出里没触发，见上面那条 C 守卫用例）。
 * 下面用一个众数 40 的页面把漏洞钉住：坐标仍用导出里词 15 / 词 16 的真实框。
 */
describe('孤立上下标补救路径：一整行正文不得被当成下标', () => {
  it('词 16（22 字符的正文行）不得被挂成词 15 的下标', () => {
    /** 定众数用的正文行：宽度一致 → 相互之间过不了「分支必须明显更窄」那道闸 */
    const bodyLine = (y: number) => [
      w('17.', 225, y, 40, 60, 90),
      w('设随机变量(X,Y)具有分布律', 300, y, 40, 500, 90),
      w('P{X=x,Y=y}=p(1−p)x+y−2', 820, y, 40, 400, 90),
    ];
    const denseBody = [...bodyLine(212), ...bodyLine(257), ...bodyLine(302), ...bodyLine(347)];

    // 真实坐标：词 15 x225–1181 / y1397–1435（宽 956、高 38）
    const upper = w('28. 设 X,Y是相互独立的随机变量，它们都服从正态分布 N(0，σ²).试', 225, 1397, 38, 956, 90);
    // 真实坐标：词 16 x167–778 / y1452–1488（宽 611、高 36），只隔 17px
    const lower = w('验证随机变量 Z = √X2 + Y 的概率密度为', 167, 1452, 36, 611, 90);
    const words = [...denseBody, upper, lower];
    const upperIndex = words.indexOf(upper);
    const lowerIndex = words.indexOf(lower);

    const structure = branchStructureOf(words);

    // 回归时（众数 40）：一条 line 的 wordIndices = [12, 13]（≡ 真实 [15, 16]）
    expect(branchLineWith(structure, upperIndex)?.wordIndices).toEqual([upperIndex]);
    expect(branchLineWith(structure, lowerIndex)?.wordIndices).toEqual([lowerIndex]);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════
 * 判据的另一半：整句正文当**候选**时同样不能被吞（构造用例）
 * ═══════════════════════════════════════════════════════════════
 *
 * 回归 B 里那句真实正文是**主机**（它最宽）。把角色对调 —— 公式行最宽、
 * 正文行落在它的跨度之内 —— 同样的横向比值（0.68 ≥ 0.60）会让正文行从
 * 「横向压得实」那道闸（判据 2）被吞掉。判据必须是对称的：
 * **主机不能是成句正文，分支也不能是成句正文。**
 *
 * ⚠️ 数据来源：候选用的是 B 里那句真实正文的真实框（x166–918 / y1629–1666，
 * 宽 752、高 37）；主机那一行的**框宽是推的**（1100px，一个 33 字符、
 * 0 汉字的公式行在 1379px 版心里的合理宽度）—— 这一页里没有这种组合。
 */
describe('成句正文当候选时也不得被并（判据必须对称）', () => {
  it('公式主机（1100px）不得吞掉紧随其后的整句正文（752px / 比值 0.68）', () => {
    const host = w('P{X=x,Y=y}=p(1−p)x+y−2,0<p<1', 150, 200, 40, 1100, 90);
    const sentence = w(
      '我们称 Z 服从参数 为σ(σ > 0) 的瑞利(Rayleigh) 分布.',
      166,
      260,
      37,
      752,
      90,
    );
    const words = [host, sentence];

    const structure = branchStructureOf(words);

    expect(branchLineWith(structure, words.indexOf(sentence))?.wordIndices).toEqual([
      words.indexOf(sentence),
    ]);
    expect(branchLineWith(structure, words.indexOf(host))?.wordIndices).toEqual([
      words.indexOf(host),
    ]);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════
 * 反面：这些合并**必须继续成立**（防「一刀切禁掉构件合并」）
 * ═══════════════════════════════════════════════════════════════
 *
 * 词 4/5/6 这一组是上一轮修好的词序，它与三个回归**在几何上无法区分**：
 * 同样是「一行更宽的式子 + 更窄更近的邻居」，区别只在**文本** ——
 * `其中λ>0，μ>0是常数.引入随机变量`（19 字符 / 11 个汉字）是式子，
 * 而 `我们称 Z 服从参数 为σ(σ > 0) 的瑞利(Rayleigh) 分布.`（38 字符 /
 * 13 个汉字、以 `.` 收尾）是成句正文。新判据的两道门槛（≥24 字符且
 * ≥10 汉字 / 句末标点且 ≥4 汉字）必须正好把这两类分开 ——
 * 19 与 24 之间只隔 5 个字符，这条余量就是靠这一组守住的。
 */
describe('真实文档回归：公式主干（含中文的式子）仍然可以当主机', () => {
  it('词 4/5/6 合为一行，且顺序为 [4, 5, 6]', () => {
    const structure = branchRealPage();
    const line = branchLineWith(structure, 4);

    expect(line?.wordIndices).toEqual([4, 5, 6]);
    expect(line?.text).toBe('其中λ>0，μ>0是常数.引入随机变量Z= 当X>Y=10, 当X>Y');
    expect(line?.yRange).toEqual([568, 723]);
    // 字号是三个词的加权平均，导出里是 78.7
    expect(line?.fontSize).toBeCloseTo(78.7, 1);
  });
});
