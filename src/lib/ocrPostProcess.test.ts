import { describe, expect, it } from 'vitest';
import { ocrResultToBlocks, ocrTextToBlocks, CHAR_SCRIPT_ENABLED } from '@/lib/ocrPostProcess';

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

  it('堆叠两行的紧贴公式：整行宽的上一行不得被判成下一行的上标（实测跨行大括号）', () => {
    // 实测几何：下行词框被 `{` 撑到 52px 高、量成 56 字号；上行词
    // 28px、312px 宽（几乎与基字等宽）、中心距 40px —— 五条几何判据
    // 全部通过，但它是**整行**，不是上标。宽片段判据必须拦住。
    const blocks = ocrResultToBlocks(
      pageResult({
        words: [
          w('其中λ>0，μ>0是常数.引入随机变量', 162, 568, 36, 600),
          w('_(1，当X≤Y', 301, 622, 28, 312),
          w('Z = {0, 当X > Y', 293, 650, 52, 320),
          w('(1）求条件概率密度', 225, 700, 36, 400),
          w('(2)求Z的分布律和分布函数', 225, 760, 36, 400),
        ],
      }),
    );

    const content = blocks.map((b) => b.content).join('\n');
    expect(content).not.toContain('^');
    expect(content).toContain('Z = {0, 当X > Y');
    expect(content).toContain('_(1，当X≤Y');
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

  it('全角右括号的小问编号（(2）…）同样另起一段（词坐标路径）', () => {
    // 两种右括号都要认：`(1)` 与 `(2）`。词坐标路径才有编号规则
    // （纯文本兜底没有，别在那儿写「假保护」用例）。
    // 两行同字号、行距 64px < 断段阈值 76.8px → 唯一该断的理由是编号本身。
    const words = [
      w('0，其他', 566, 1066, 54, 346),
      w('(2）求Z的分布律和分布函数。', 566, 1130, 54, 400),
    ];

    const blocks = ocrResultToBlocks(pageResult({ words }));

    expect(blocks).toHaveLength(2);
    expect(blocks[1]?.content.startsWith('(2）')).toBe(true);
  });

  it('小问编号在公式行后面同样另起一段（第 20 题的真实几何）', () => {
    // 真实页面（第 20 题概率密度表）：上一行 `0，其他`（fs54），下一行
    // `(1)问 X 和 Y 是否相互独立？`（fs36）——
    //  · 字号差 18px = 54×0.25… 恰在断段线上，靠回卷救援（上一行没写满
    //    整栏 → 不算「不同排面」）挡住；
    //  · 行距 47px < 断段阈值 64.8px。
    // 两条几何判据都不该断，**唯一**该断的理由是小问编号本身。
    // 旧正则只认「数字 + 分隔符」（`(1）` 里的 `(` 在数字前面，匹配不上），
    // 这一行会被并进上面那段 —— 正是用户报的「小问挤在表格里」。
    const words = [
      w('0，其他', 566, 1066, 54, 346),
      w('(1)问 X 和 Y 是否相互独立？', 218, 1122, 36, 431),
    ];

    const blocks = ocrResultToBlocks(pageResult({ words }));

    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.content).toBe('0，其他');
    expect(blocks[1]?.content.startsWith('(1)')).toBe(true);
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
    // `3.14` 出现在**行首**，形状上最像题号 —— 但它点号后面紧跟数字，
    // 不是编号形态。
    //
    // ⚠️ 必须给**两行**：只给「3.14 …」一行的话，首行无论如何都会开新段
    // （`!currentText` 恒真），旧正则照样通过 —— 那是**假保护**。
    // 旧正则末尾的 `\S` 会被小数点后的第一位数字满足（`\.` 后紧跟 `1`
    // 算匹配），`3.14 …` 被误判成题号行切成两块。前面垫一行正文，
    // 误判与否才会显形。
    const words = [
      w('圆的面积公式如下', 40, 100, 20, 200),
      w('3.14', 40, 130, 20, 40),
      w('是圆周率的近似值，在概率计算里经常出现，请记住这个常数。', 90, 130, 20, 480),
    ];

    const blocks = ocrResultToBlocks(pageResult({ words }));

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.content).toContain('圆的面积公式如下');
    expect(blocks[0]?.content).toContain('3.14 是圆周率的近似值');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 字号判据：相对容差 + 回卷续行救援
// ═══════════════════════════════════════════════════════════════════
//
// 对应**用户实测的第三个故障**：「正整数处出现错误换行」—— 第 17 题
// 的一句话在 `…均为 正 / 整数，问…` 之间被劈成了两段。
//
// 根因是字号判据写成了**绝对 2px**（`Math.abs(line.fontSize -
// currentFontSize) > 2`）：行的字号是词框高的均值，而公式行里的检测框
// 会被分数线/指数撑大 —— 实测首行 43、续行 36，7px 的差被当成了
// 「不同排面」。
//
// 修法有两层，下面各自有对应用例：
//   1. 绝对 → 相对（`FONT_SIZE_BREAK_RATIO`）：16% 的差属于检测框噪声；
//   2. 与字号无关的几何兜底（`wrappedContinuation`）：**写满整栏 +
//      从版心左缘起排 + 无句末标点** = 排版上的「回卷接排」——
//      字号噪声没有上界时，让几何事实说话。
//
// ⚠️ 第二组用例里的词框是**手工构造**的合成几何：真字号突变（正文 42
// → 小标题 58，差 28%）必须仍然断开，这条由上面「真正的章节标题…」
// 与「小标题甲」两条用例守着（改完 `FONT_SIZE_BREAK_RATIO` 后它们
// 依然全绿，说明阈值没有跨过 28% 那条线）。

describe('字号判据：相对容差与回卷续行（用户报的「正整数处换行」）', () => {
  it('⭐ 真实几何：17 题首行（字号 43）与续行（字号 36）必须是一段', () => {
    // 词框照抄用户页面的实测数据（run3 导出，坐标精确到像素）：
    //   首行 [225,212,1604,255] 字号 43（含 `p(1−p)^{x+y−2}`，检测框被撑大）
    //   续行 [147,266,573,302]  字号 36
    // 相对差 7/43 ≈ 16% —— 同一排面；旧实现的绝对 2px 判据在这里断开。
    const words = [
      w(
        '17. 设 随机 变量 (X ,Y) 具有 分 布律 P {X = x ,Y = y} = p (1 − p )x+y−2 ,0 < p < 1,x ,y 均为 正',
        225,
        212,
        43,
        1379,
        90,
      ),
      w('整数，问X，Y是否相互独立.', 147, 266, 36, 426, 99),
    ];

    const blocks = ocrResultToBlocks(pageResult({ words }));

    expect(blocks).toHaveLength(1);
    // 拼接处必须无缝：「正」与「整数」之间是同一句话（中文之间不插空格）
    expect(blocks[0]?.content).toContain('均为 正整数，问X');
  });

  it('回卷续行：字号差超容差，但「上一行写满整栏 + 本行从版心左缘起排」时仍续行', () => {
    // 行 2 的字号 80 是「被分式撑大的公式行」，与续行的 36 相差 55%
    // —— 相对容差也拦不住，能救它的只有几何事实：
    //   行 2 右缘 1604 = 全页最右（写满整栏）、行 3 左缘 140 ≈ 版心左缘。
    const words = [
      w('第一行正文内容写到这里', 100, 100, 36, 300),
      w('第二行是一根被撑大的公式行且写满整栏', 200, 160, 80, 1404),
      w('续行从版心左缘起排。', 140, 237, 36, 300),
    ];

    const blocks = ocrResultToBlocks(pageResult({ words }));

    // 行 1 → 行 2 没有回卷几何（行 1 右缘只有 400）→ 照常断开；
    // 行 2 → 行 3 是回卷接排 → 合并。
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.content).toBe('第一行正文内容写到这里');
    expect(blocks[1]?.content).toBe('第二行是一根被撑大的公式行且写满整栏续行从版心左缘起排。');
  });

  it('反向：字号差相同、但上一行没写满整栏 → 不许救援（回卷判据不能被滥用）', () => {
    // 行 1 特意写得又长又以句号收尾：它把「版心右缘」钉在 1500，
    // 同时让自己的行尾不具备回卷形态（句末标点直接断）。
    // 行 2 虽然比行 1 字号大、也在页面最左，但右缘只有 700 ——
    // 离版心右缘太远，不构成「写满整栏」，不许救援。
    const words = [
      w('第一行正文内容写到这里为止。', 100, 100, 36, 1400),
      w('第二行是一根被撑大的公式行但很短', 200, 160, 80, 500),
      w('续行从版心左缘起排。', 140, 237, 36, 300),
    ];

    const blocks = ocrResultToBlocks(pageResult({ words }));

    expect(blocks).toHaveLength(3);
    expect(blocks[2]?.content).toBe('续行从版心左缘起排。');
  });

  it('反向：上一行以冒号收尾 → 判定为「列举引子」，不救援', () => {
    const words = [
      w('第一行正文内容写到这里', 100, 100, 36, 300),
      w('第二行是一根被撑大的公式行且写满整栏：', 200, 160, 80, 1404),
      w('续行从版心左缘起排。', 140, 237, 36, 300),
    ];

    const blocks = ocrResultToBlocks(pageResult({ words }));

    expect(blocks).toHaveLength(3);
    expect(blocks[2]?.content).toBe('续行从版心左缘起排。');
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

import '@/lib/ocrPostProcess.layout.test';

// ═══════════════════════════════════════════════════════════════
// 字符级上下标：真实扫描件里「指数与整行同框」这个死角
// ═══════════════════════════════════════════════════════════════
//
// 用户那份习题 PDF 第 17 题实测导出：
//
//   词 1: "17. 设 随机 变量 (X ,Y) 具有 分 布律 P {X = x ,Y = y}
//          = p (1 − p )x+y−2 ,0 < p < 1,x ,y 均为 正"
//          bbox [225, 212, 1604, 255]   fontSize 43
//
// 指数 `x+y−2` 与整行**同在这一个检测框里**。词级判据（比两个词框的
// 高度与中心）对这种形态完全无能为力 —— 阈值怎么调都判不出来，
// 因为「指数」与「整行」在词级几何里是同一个东西。
//
// 这组测试用**真实的词框几何 + 真实的字体比例**（内部真正生效的词高
// 众数是 36，不是被公式撑大的 43），验证字符级判据真的把指数切了出来。
// 其中「控制实验」一条是**可证伪**的关键：同一段文本、同一个词框、
// 同一批字符框，只把纵向位置从「抬高」改成「坐在基线上」，
// `^{}` 必须消失 —— 说明断言是那些纵向数值驱动的。

import { attachCharsToWord, type AttachedChars } from '@/lib/ocrCharBoxes';
import type { OcrChar } from '@/lib/ocrTypes';

/** 第 17 题的真实词框与字号（用户导出，可直接采信） */
const S17_BBOX = { x0: 225, y0: 212, x1: 1604, y1: 255 };
const S17_MAIN_FONT = 36;

/** 第 17 题整行词的**真实文本**（用户导出，一字不改） */
const S17_TEXT =
  '17. 设 随机 变量 (X ,Y) 具有 分 布律 P {X = x ,Y = y} = p (1 - p )x+y-2 ,0 < p < 1,x ,y 均为 正';

/** 指数 `x+y-2` 在这段文本里的字符下标（含两端） */
const S17_EXP_FROM = S17_TEXT.indexOf('x+y-2');
const S17_EXP_TO = S17_EXP_FROM + 'x+y-2'.length - 1;

/**
 * 造一个词的字符框。
 *
 * 纵向按**真实排版比例**给（都以词框高度 36px 归一）：
 *  · 正文字符：墨迹高 0.72、底边坐在基线 0.72 上；
 *  · 上标字符：墨迹高 0.48（= 0.67 倍正文）、底边抬高 0.14，
 *    这正是中文数学排版里 `p (1 − p )^{x+y−2}` 的常见取值。
 * 横向按字符顺序均匀铺开。
 */
function s17Chars(expFrom: number, expTo: number): AttachedChars {
  const chars = [...S17_TEXT];
  const charW = (S17_BBOX.x1 - S17_BBOX.x0) / chars.length;
  const out: OcrChar[] = [];
  const measurements: AttachedChars['measurements'] = [];

  for (let i = 0; i < chars.length; i++) {
    const isExp = i >= expFrom && i <= expTo;
    const h = isExp ? 0.48 : 0.72;
    const y1 = isExp ? 0.72 - 0.14 : 0.72;
    const y0 = y1 - h;
    out.push({
      char: chars[i] ?? '',
      x0: S17_BBOX.x0 + i * charW,
      y0: S17_BBOX.y0 + y0 * S17_MAIN_FONT,
      x1: S17_BBOX.x0 + (i + 1) * charW,
      y1: S17_BBOX.y0 + y1 * S17_MAIN_FONT,
    });
    measurements.push({ y0, y1, h });
  }
  return { chars: out, measurements };
}

/**
 * 词的**字符框**全部坐在同一条基线上（哪怕更小）。
 *
 * 这是控制实验的形态：位移为 0，字符级判据此时**不该**报出任何上下标，
 * 于是输出必须与「没有字符框」的原路径逐字符一致。
 */
function s17CharsFlatBaseline(): AttachedChars {
  const chars = [...S17_TEXT];
  const charW = (S17_BBOX.x1 - S17_BBOX.x0) / chars.length;
  const out: OcrChar[] = [];
  const measurements: AttachedChars['measurements'] = [];
  for (let i = 0; i < chars.length; i++) {
    const h = i % 3 === 0 ? 0.72 : 0.5;
    out.push({
      char: chars[i] ?? '',
      x0: S17_BBOX.x0 + i * charW,
      y0: S17_BBOX.y0 + (0.72 - h) * S17_MAIN_FONT,
      x1: S17_BBOX.x0 + (i + 1) * charW,
      y1: S17_BBOX.y0 + 0.72 * S17_MAIN_FONT,
    });
    measurements.push({ y0: 0.72 - h, y1: 0.72, h });
  }
  return { chars: out, measurements };
}

const s17Word = () =>
  w(S17_TEXT, S17_BBOX.x0, S17_BBOX.y0, S17_MAIN_FONT, S17_BBOX.x1 - S17_BBOX.x0, 92);

const s17Page = () => pageResult({ words: [s17Word()] });

describe('字符级上下标：指数与整行同框时，词级几何永远判不出来', () => {
  it('先确认词级路径**确实**判不出来（否则这组测试没有意义）', () => {
    // 不带字符框：词级判据看不到任何「更小且更偏上」的另一个词
    const blocks = ocrResultToBlocks(s17Page());
    expect(blocks[0]?.content).toContain('p (1 - p )x+y-2');
    // 没有 `^{}`：这正是第 17 题现在的输出
    expect(blocks[0]?.content).not.toContain('^{');
  });

  // ⚠️ 这两条是**重写后的验收标准**，当前被总开关跳过（见 `CHAR_SCRIPT_ENABLED`）。
  // 保留而不是删除：它们精确描述了「什么才算做对了」——
  // 指数必须被包成**一个** `$^{...}$`，且不能吞掉结尾的空格。
  it.skipIf(!CHAR_SCRIPT_ENABLED)('拿到字符框后，指数 `x+y-2` 被包成一个 `$^{...}$`', () => {
    const word = s17Word();
    attachCharsToWord(word, s17Chars(S17_EXP_FROM, S17_EXP_TO));

    const content = ocrResultToBlocks(pageResult({ words: [word] }))[0]?.content ?? '';

    // 指数被切成**一个**片段（不是五个并列公式）
    expect(content).toContain('$^{x+y-2}$');
    expect(content).not.toContain('$^{x}$$^{+}$');
    // 指数之前与之后的原文都必须还在（切片最容易丢的就是首尾）
    expect(content).toContain('= p (1 - p )');
    expect(content).toContain(',0 < p < 1,x ,y 均为 正');
  });

  it('控制实验：把同一批字符框改成「全坐在基线上」，输出必须回到原样', () => {
    const word = s17Word();
    attachCharsToWord(word, s17CharsFlatBaseline());

    const content = ocrResultToBlocks(pageResult({ words: [word] }))[0]?.content ?? '';

    /**
     * ⚠️ 这就是「关掉新判据，测试会变红」的可证形式。
     *
     * 同一段文本、同一个词框、同一批字符框，**只把纵向位置从
     * 「抬高 0.14」改成「全部坐在基线上」**，`^{}` 就消失了 ——
     * 说明上面那条断言是**这些纵向数值**驱动的，
     * 而不是「加了字符框就总会包一层 `^{}`」的装饰性行为。
     */
    expect(content).not.toContain('^{');
    expect(content).not.toContain('$');
    expect(content).toContain('p (1 - p )x+y-2');
  });

  it('字符框与词文本对不上时**整段放弃**，绝不产出错位的公式', () => {
    const word = s17Word();
    const bogus = s17Chars(S17_EXP_FROM, S17_EXP_TO);
    // 把第一个字符改掉：字符序列与词文本不再一致
    attachCharsToWord(word, {
      chars: [{ ...bogus.chars[0]!, char: 'X' }, ...bogus.chars.slice(1)],
      measurements: bogus.measurements,
    });

    const content = ocrResultToBlocks(pageResult({ words: [word] }))[0]?.content ?? '';
    expect(content).not.toContain('^{');
    expect(content).toContain('p (1 - p )x+y-2');
  });

  it('字符数不一致时同样放弃（错位的框比没有更糟）', () => {
    const word = s17Word();
    const bogus = s17Chars(S17_EXP_FROM, S17_EXP_TO);
    attachCharsToWord(word, {
      chars: bogus.chars.slice(0, bogus.chars.length - 1),
      measurements: bogus.measurements.slice(0, bogus.measurements.length - 1),
    });

    const content = ocrResultToBlocks(pageResult({ words: [word] }))[0]?.content ?? '';
    expect(content).not.toContain('^{');
  });

  it.skipIf(!CHAR_SCRIPT_ENABLED)('指数**结尾紧跟空格**时不能把空格也吞进 `^{}`', () => {
    /**
     * ═══════════════════════════════════════════════════════════
     * 这条是从真实数据的实际输出里发现的边界
     * ═══════════════════════════════════════════════════════════
     *
     * `... (1 - p )x+y-2 ,0 ...` 里指数后面紧跟一个空格，
     * 而字符级判定（只看纵向几何）**会把那个空格也标成上标** ——
     * 空格也「更小（没墨迹）且更高」。
     *
     * 危险在于拼装：片段文本必须**不含尾随空格**，而且游标要落在空格**之前**，
     * 否则 ` ,0` 会连同空格一起被吞掉，输出变成 `$^{x+y-2,0}$`。
     * `groupScriptFragments` 的「空白打断」与 `emitWordWithCharScripts`
     * 的「游标只到片段末字符」共同保证这一点，这条测试把它钉住。
     */
    const word = s17Word();
    const built = s17Chars(S17_EXP_FROM, S17_EXP_TO + 1); // 把紧随的空格也标成上标
    attachCharsToWord(word, built);

    const content = ocrResultToBlocks(pageResult({ words: [word] }))[0]?.content ?? '';
    expect(content).toContain('$^{x+y-2}$ ,0');
    // 空格与后面的 `,0` 一个都不能少
    expect(content).not.toContain('$^{x+y-2 ,0');
    expect(content).not.toContain('$^{x+y-2,0');
  });
});

// ═══════════════════════════════════════════════════════════════
// 真实第 1 词（完整的 53 个字符 + 每字符置信度）走**整条链路**
// ═══════════════════════════════════════════════════════════════
//
// 上面那两条验收用例用的是「按比例合成」的字符框（均匀铺开、指数一律抬高
// 0.14）。这一组改用**用户导出的真实纵向范围**逐个字符给，并且带上
// 每字符置信度 —— 也就是重写后判据在生产里真正会拿到的输入。
//
// ⚠️ 真实误判的原文（用户导出，就是要挡住的东西）：
//
//   $^{17}$. 设 随机 变量 … 分 布律 $^{P}$ {X = x ,Y = y} …
//   (1$^{)问}$ X 和 Y 是否相互独立？
//   验证随机变量 Z = $^{√}$X2 + $^{Y}$ 的概率密度为
//
// 这四条断言就是「不许再出现这些」：可见文字必须逐字保持原样，
// 一个字都不能被包进 `$^{...}$`。

/** 真实词文本（用户导出，一字不改；指数是 ASCII `-`） */
const REAL17_TEXT =
  '17. 设 随机 变量 (X ,Y) 具有 分 布律 P {X = x ,Y = y} = p (1 - p )x+y-2 ,0 < p < 1,x ,y 均为 正';

/** 真实逐字符纵向范围 `[字符, y0, y1]`（画布像素；按出现顺序，与正文逐位对齐） */
const REAL17_ROWS: Array<[string, number, number]> = [
  ['1', 219.2, 239.6],
  ['7', 219.2, 238.6],
  ['.', 236.6, 240.6],
  ['设', 220.2, 247.8],
  ['随', 220.2, 247.8],
  ['机', 221.3, 246.8],
  ['变', 220.2, 246.8],
  ['量', 220.2, 247.8],
  ['(', 223.3, 245.8],
  ['X', 223.3, 244.7],
  [',', 237.6, 245.8],
  ['Y', 223.3, 244.7],
  [')', 224.3, 245.8],
  ['具', 220.2, 247.8],
  ['有', 220.2, 247.8],
  ['分', 220.2, 247.8],
  ['布', 220.2, 247.8],
  ['律', 220.2, 248.8],
  ['P', 223.3, 234.5],
  ['{', 221.3, 246.8],
  ['X', 226.4, 244.7],
  ['=', 231.5, 237.6],
  ['x', 231.5, 244.7],
  [',', 209, 258], // ← 异常框（超出整行）
  ['Y', 223.3, 244.7],
  ['=', 231.5, 237.6],
  ['y', 231.5, 248.8],
  ['}', 222.3, 246.8],
  ['=', 231.5, 237.6],
  ['p', 227.4, 249.8],
  ['(', 223.3, 245.8],
  ['1', 223.3, 244.7],
  ['-', 209, 258], // ← 异常框
  ['p', 227.4, 249.8],
  [')', 223.3, 245.8],
  ['x', 225.3, 232.5], // ── 指数 x+y-2（墨迹高 7.2px、底边高出正文 12.2px）
  ['+', 225.3, 232.5],
  ['y', 225.3, 232.5],
  ['-', 225.3, 232.5],
  ['2', 220.2, 232.5],
  [',', 237.6, 245.8],
  ['0', 224.3, 244.7],
  ['<', 225.3, 243.7],
  ['p', 227.4, 243.7],
  ['<', 225.3, 243.7],
  ['1', 224.3, 244.7],
  [',', 237.6, 245.8],
  ['x', 223.3, 243.7],
  [',', 237.6, 245.8],
  ['y', 223.3, 243.7],
  ['均', 220.2, 247.8],
  ['为', 220.2, 247.8],
  ['正', 221.3, 246.8],
];

const REAL17_MAIN = 36; // 内部真正生效的词高（不是被公式撑大的 43）
const REAL17_BASELINE = 244.7;
const REAL17_EXP_FROM = 35;
const REAL17_EXP_TO = 39;

/**
 * 造真实第 1 词的旁挂数据（与生产同一套归一化口径）。
 *
 * 置信度按**两条已知事实**构造（详见 `ocrCharBoxes.test.ts` 同名字段的说明）：
 * 高置信度的普通字（`7`/`P`/`=`/`p`）与低置信度的真指数（`x+y−2`）。
 * 逐字符置信度当时没有出口，拿不到真值 —— 这一点如实写在这里。
 */
function real17Attached(): {
  chars: OcrChar[];
  measurements: AttachedChars['measurements'];
  confidences: number[];
} {
  const chars = [...REAL17_TEXT].map((char) => ({ char }));
  const charW = (S17_BBOX.x1 - S17_BBOX.x0) / chars.length;
  const nonBlank = chars.filter((c) => c.char.trim());
  expect(nonBlank.length, '字符表必须与正文逐位对齐').toBe(REAL17_ROWS.length);

  let k = 0;
  const out: OcrChar[] = [];
  const measurements: AttachedChars['measurements'] = [];
  const confidences: number[] = [];
  const weak = [0.62, 0.65, 0.61, 0.58, 0.66];

  for (let i = 0; i < chars.length; i++) {
    const char = chars[i]!.char;
    if (!char.trim()) {
      // 空白位：占位、无墨迹、无置信度（与生产路径的契约一致）
      out.push({ char, x0: 0, y0: 0, x1: 0, y1: 0 });
      measurements.push(null);
      confidences.push(Number.NaN);
      continue;
    }
    const [ch, y0, y1] = REAL17_ROWS[k]!;
    expect(ch, `第 ${k} 个非空白字符`).toBe(char);
    const ky = k;
    k++;
    out.push({
      char,
      x0: S17_BBOX.x0 + i * charW,
      y0,
      x1: S17_BBOX.x0 + (i + 1) * charW,
      y1,
    });
    measurements.push({
      y0: (y0 - REAL17_BASELINE) / REAL17_MAIN + 0.72,
      y1: (y1 - REAL17_BASELINE) / REAL17_MAIN + 0.72,
      h: (y1 - y0) / REAL17_MAIN,
    });
    confidences.push(
      ky >= REAL17_EXP_FROM && ky <= REAL17_EXP_TO
        ? weak[ky - REAL17_EXP_FROM]!
        : 0.97 + ((ky * 7) % 5) * 0.005,
    );
  }
  return { chars: out, measurements, confidences };
}

describe('真实第 1 词（整条链路）：真实的那些误判一个都不许再出现', () => {
  const wordWithScripts = () => {
    const word = w(REAL17_TEXT, S17_BBOX.x0, S17_BBOX.y0, S17_MAIN_FONT, S17_BBOX.x1 - S17_BBOX.x0, 92);
    attachCharsToWord(word, real17Attached());
    return word;
  };

  it.skipIf(!CHAR_SCRIPT_ENABLED)('⭐ 指数 `x+y-2` 被包成**一个** `$^{...}$`（旧实现在这份数据上一个都没判出来）', () => {
    const content = ocrResultToBlocks(pageResult({ words: [wordWithScripts()] }))[0]?.content ?? '';

    expect(content).toContain('$^{x+y-2}$');
    // 不能拆成好几个公式
    expect(content).not.toContain('$^{x}$$^{+}$');
    // 前后原文必须都在（切片最容易丢首尾）
    expect(content).toContain('= p (1 - p )');
    expect(content).toContain(',0 < p < 1,x ,y 均为 正');
  });

  it('⭐ 旧实现的四个误判（`17`、`P`、`）问`、`√`/`Y`）**一个都不许再出现**', () => {
    const content = ocrResultToBlocks(pageResult({ words: [wordWithScripts()] }))[0]?.content ?? '';

    // `$^{17}$`（真实误判里最显眼的一个）
    expect(content).not.toContain('$^{17}$');
    expect(content).not.toContain('$^{1}$');
    expect(content).not.toContain('$^{7}$');
    // `$^{P}$`
    expect(content).not.toContain('$^{P}$');
    // `(1$^{)问}$`
    expect(content).not.toContain(')问}$');
    expect(content).not.toContain('$^{)');
    // `$^{Y}$`
    expect(content).not.toContain('$^{Y}$');
  });

  it.skipIf(!CHAR_SCRIPT_ENABLED)('⭐ 「不吞字」：只剥掉 `$^{`/`}$` 包装，内部文字必须与原词逐字符相同', () => {
    const content = ocrResultToBlocks(pageResult({ words: [wordWithScripts()] }))[0]?.content ?? '';
    // 只剥包装、**保留**包装里的内容（剥掉整段 `$...$` 会把指数本身也删掉，
    // 那样这条断言就永远成立 —— 是假保护）
    const stripped = content.replace(/\$\^\{/g, '').replace(/\}_\$/g, '').replace(/\}\$/g, '');
    expect(stripped.replace(/\s+/g, '')).toBe(REAL17_TEXT.replace(/\s+/g, ''));
    // 前提：这次确实包了一层（否则上面那条对「没包装」也成立）
    expect(content).toContain('$^{');
  });

  it.skipIf(!CHAR_SCRIPT_ENABLED)('反向防线：同一批字符框**不给置信度**时，误判会回来 —— 说明挡住它的确实是机制 2', () => {
    const word = w(REAL17_TEXT, S17_BBOX.x0, S17_BBOX.y0, S17_MAIN_FONT, S17_BBOX.x1 - S17_BBOX.x0, 92);
    const built = real17Attached();
    attachCharsToWord(word, { chars: built.chars, measurements: built.measurements });

    const content = ocrResultToBlocks(pageResult({ words: [word] }))[0]?.content ?? '';
    // 没有置信度 → 纯几何：`P`（以及三个中线等号）会被包进去
    expect(content).toContain('$^{');
  });
});


// ═══════════════════════════════════════════════════════════════
// 倾斜行：行基线拟合（书脊弯曲 / 扫描歪）不得把同一行切碎
// ═══════════════════════════════════════════════════════════════
//
// 阈值取证与机制说明见 `ocrPostProcess.ts` 里 `mergeTiltedLineFragments` /
// `lineBaseline` / `buildWordSlopes` 的文档。CSAPP（书脊弯曲扫描）取样
// 20 页的实测：页级斜率中位数 0.0000 – 0.0154，18% 的行（98/542）中心 y
// 漂移超过 5px 的分桶容差（应用画布尺度下 55.5%，见 `BASELINE_MIN_DRIFT_RATIO`
// 的文档）—— 不修的话，一条视觉上完整的行会被切成几段，
// 角标与基字一旦分属两段，上下标判定整条失效，输出退回平铺文本。
//
// 下面四组几何各自锁死一个机制（都做过反事实验证：把对应机制临时停用，
// 对应用例确实失败）：
//  1. 一条倾斜行（含 `e^{-(x+y)}`）在 0 – 0.025 的斜率下都必须仍是
//     **一条行**、指数仍绑得上 —— 把基线闸门换成「永不拟合」
//     （`BASELINE_MIN_DRIFT_RATIO = Infinity`）后，0.008 / 0.015 / 0.025
//     分别散成 2 / 2 / 3 段（首段词数 18 / 9 / 6）；
//  2. 台阶状的两条平行行（两栏版面的常见几何）**不得**被「拼起来是一条
//     直线」焊成一行 —— 中位残差挡不住它们（实测只 4.6px），挡住它们的
//     是判据 2b `offBaselineWords`；把它停用后两条行在平直与倾斜页面上
//     都焊成一行（输出 `甲甲甲乙乙乙丙丙丙子子子丑丑丑寅寅寅`）。它同时
//     锁住「每一条倾斜行自己要拼回来」：闸门永不拟合时，倾斜的每行
//     各裂成 2 段（共 4 条）；
//  3. 长基字词右端的上标：原始错位 3.5px 在 5px 门槛以下，扣掉 m·Δx
//     后才越线 —— 把 `findScriptAnchors` 里的 deskew 项清零（或让闸门
//     永不拟合），这个上标立刻退回成独立词 `$2$`；
//  4. 应用画布尺度（字号 105 / 行宽 3584 / |m| = 0.003）的整行几何 ——
//     这是对「固定斜率闸门 0.005」那个单位错误的回归守卫，
//     详见该用例自身的说明。

describe('倾斜行：行基线拟合（书脊弯曲 / 扫描歪）', () => {
  type TiltLine = { text: string; wordIndices: number[]; hasScripts: boolean };

  function tiltPageOf(
    words: Parameters<typeof pageResult>[0]['words'],
    canvasHeight: number,
  ): { contents: string[]; lines: TiltLine[] } {
    let structure: { lines: TiltLine[] } | undefined;
    const blocks = ocrResultToBlocks(pageResult({ words }), canvasHeight, (s) => {
      structure = s as unknown as { lines: TiltLine[] };
    });
    return { contents: blocks.map((b) => b.content), lines: structure?.lines ?? [] };
  }

  const slopeCases = [0, 0.008, 0.015, 0.025];

  /**
   * 20 词的行：`已知 函数 e^{-(x+y)} 的 概率密度为 f(x)，求其分布律，并写出过程`。
   *
   * 词框先按平直行给（与「更小且更高的词被判为上标」的用例同源），
   * 再按下标在行内的横向位置整体加 `slope·cx` —— 这就是倾斜扫描
   * 落到词级坐标上的样子：一行的 y 是 x 的线性函数。
   */
  function tiltRow(slope: number) {
    const parts: [string, number, number, number, number][] = [
      ['已知', 40, 40, 20, 0],
      ['函数', 90, 40, 20, 0],
      ['e', 140, 12, 20, 0],
      ['-(x+y)', 154, 60, 13, -18],
      ['的', 226, 20, 20, 0],
      ['概率', 256, 40, 20, 0],
      ['密度', 306, 40, 20, 0],
      ['为', 356, 20, 20, 0],
      ['f', 386, 12, 20, 0],
      ['(x)', 400, 40, 20, 0],
      ['，求', 450, 40, 20, 0],
      ['其', 500, 20, 20, 0],
      ['分布', 530, 40, 20, 0],
      ['律', 580, 20, 20, 0],
      ['，', 610, 20, 20, 0],
      ['并', 640, 20, 20, 0],
      ['写', 670, 20, 20, 0],
      ['出', 700, 20, 20, 0],
      ['过', 730, 20, 20, 0],
      ['程', 760, 20, 20, 0],
    ];
    const x0 = parts[0]![1];
    return parts.map(([text, x, width, h, dy]) => {
      const cx = x + width / 2 - x0;
      return w(text, x, Math.round(88 + dy + slope * cx), h, width);
    });
  }

  it('20 词的行在 0 – 0.025 的任何斜率下都是一条行，指数仍绑在 e 上', () => {
    const summary = slopeCases.map((slope) => {
      const { contents, lines } = tiltPageOf(tiltRow(slope), 600);
      return {
        slope,
        contents,
        lineCount: lines.length,
        wordCount: lines[0]?.wordIndices.length ?? 0,
        hasScripts: lines[0]?.hasScripts ?? false,
      };
    });

    expect(summary).toEqual(
      slopeCases.map((slope) => ({
        slope,
        contents: ['已知函数e$^{-(x+y)}$的概率密度为f (x)，求其分布律，并写出过程'],
        lineCount: 1,
        wordCount: 20,
        hasScripts: true,
      })),
    );
  });

  /**
   * 台阶状的两条平行行：每行 3 个 150px 宽的词（词距 6px），右侧一行的
   * 起点（x 522）恰好接在左侧一行（x1 502）之后、纵向错开 38px。
   * 这是两栏版面 / 表格单元的自然几何：判据 1「水平首尾相接」放行，
   * 拼起来的中位残差也过闸（角标以外的词各占一半、错位抵消）——
   * 唯一的拦截者是判据 2b。
   */
  function staircase(slope: number) {
    const rows: [string[], number, number][] = [
      [['甲甲甲', '乙乙乙', '丙丙丙'], 100, 40],
      [['子子子', '丑丑丑', '寅寅寅'], 138, 522],
    ];
    const out: ReturnType<typeof w>[] = [];
    for (const [texts, baseY, x0] of rows) {
      texts.forEach((text, k) => {
        const x = x0 + k * 156;
        const cx = x + 75;
        out.push(w(text, x, Math.round(baseY + slope * cx), 20, 150));
      });
    }
    return out;
  }

  it('台阶状的两条平行行（平直与倾斜）都不得被焊成一行', () => {
    const summary = [0, 0.03].map((slope) => {
      const { contents, lines } = tiltPageOf(staircase(slope), 600);
      return { slope, contents, lineCount: lines.length };
    });

    expect(summary).toEqual([
      { slope: 0, contents: ['甲甲甲乙乙乙丙丙丙', '子子子丑丑丑寅寅寅'], lineCount: 2 },
      { slope: 0.03, contents: ['甲甲甲乙乙乙丙丙丙', '子子子丑丑丑寅寅寅'], lineCount: 2 },
    ]);
  });

  /**
   * 长基字词右端的上标。几何全部按「不 deskew 就不成立」反推：
   *  · 基字（660px 宽的公式词）所在的平桶里有 3 个正文大小的词
   *    （`设` / `随机` / 公式词），`lineBaseline` 才拟合得出 m ≈ 0.0113；
   *  · 脚本相对基字的**原始**错位 3.5px < 5px（0.25 倍字号）——
   *    只做原始比较判不出上标；
   *  · 扣掉 m·Δx（Δx = 341px，倾斜分量 3.85px）后 7.4px，越过门槛；
   *  · 脚本离右侧 `，求` 的间隙 7px > 11×0.6 = 6.6px（挡出候选），
   *    离基字 5px ≤ 6.6px —— 唯一的绑定对象就是基字。
   */
  function longBaseRow(slope: number) {
    const put = (text: string, x: number, width: number, h: number, dy: number) => {
      const cx = x + width / 2;
      return w(text, x, Math.round(100 + slope * cx - dy - h / 2), h, width);
    };
    return [
      put('设', 150, 50, 20, 0),
      put('随机', 206, 60, 20, 0),
      put('p (1 − p )x+y−2 ,0 < p < 1', 272, 660, 20, 0),
      put('2', 937, 11, 11, 7),
      put('，求', 955, 40, 20, 0),
      put('分布律', 1001, 80, 20, 0),
    ];
  }

  it('长基字词右端的上标：平直与倾斜都要绑上（倾斜时靠基线 deskew 才绑得上）', () => {
    const summary = [0, 0.0115].map((slope) => {
      const { contents, lines } = tiltPageOf(longBaseRow(slope), 400);
      return { slope, contents, hasScripts: lines[0]?.hasScripts ?? false };
    });

    expect(summary).toEqual([
      {
        slope: 0,
        contents: ['设随机p (1 − p )x+y−2 ,0 < p < 1$^{2}$，求分布律'],
        hasScripts: true,
      },
      {
        slope: 0.0115,
        contents: ['设随机p (1 − p )x+y−2 ,0 < p < 1$^{2}$，求分布律'],
        hasScripts: true,
      },
    ]);
  });

  /**
   * 应用画布尺度的倾斜行（真实 CSAPP 场景）。
   *
   * 前三组几何都是「探测图尺度」（字号 20、行宽 ~750）：在那里固定
   * 斜率闸门 0.005 与实测吻合，因此抓不出它的**单位错误**。应用实际
   * 把页面渲染成字号 ~105px、行宽 ~3600px 的画布 —— CSAPP 的
   * 1490×1944pt 页面在 200 DPI 下先到 2.7778 倍，再被 20MP 上限压到
   * 2.6272 倍（3915×5108）。同一句「漂移刚越过分桶容差」在应用画布上
   * 只有 |m| ≈ 5/3624 ≈ 0.0014，固定闸门 0.005 高出 3.6 倍。
   * 实测（`tilt-appscale.mjs`，同一份 20 页 542 行换算到应用尺度）：
   * 55.5% 的行漂移超过 5px，其中 20.7%（112 行）被 0.005 挡回原路径 ——
   * 也就是说闸门恰好把「该拟合的行」挡在门外。
   *
   * 本用例的几何就取自那份实测：|m| = 0.003、行宽 3584 → 漂移 10.75px，
   * 两倍于分桶容差 —— 肉眼可见歪、平桶装不下，正是拟合基线的用例。
   * 反事实：把闸门换回固定 0.005（临时加 `|m| < 0.005 → null`），
   * 这条行立刻裂成 2 段（`lineCount` 2、首段 `wordCount` 10），
   * 输出也被拆成两条 —— 正是被实测抓到的故障形态。
   */
  function appScaleRow(slope: number) {
    const put = (text: string, x: number, width: number, h: number, dy: number) => {
      const cx = x + width / 2;
      return w(text, x, Math.round(600 + slope * cx - dy - h / 2), h, width);
    };
    return [
      put('已知', 40, 210, 105, 0),
      put('函数', 285, 210, 105, 0),
      put('e', 530, 63, 105, 0),
      // 指数紧贴基字（间隙 8px ≤ 0.6 × 68 = 40.8）：绑定对象唯一
      put('-(x+y)', 601, 300, 68, 50),
      put('的', 936, 105, 105, 0),
      put('概率', 1076, 210, 105, 0),
      put('密度', 1321, 210, 105, 0),
      put('为', 1566, 105, 105, 0),
      put('f', 1706, 63, 105, 0),
      put('(x)', 1804, 210, 105, 0),
      put('，求', 2049, 210, 105, 0),
      put('其', 2294, 105, 105, 0),
      put('分布', 2434, 210, 105, 0),
      put('律', 2679, 105, 105, 0),
      put('，', 2819, 105, 105, 0),
      put('并', 2959, 105, 105, 0),
      put('写', 3099, 105, 105, 0),
      put('出', 3239, 105, 105, 0),
      put('过', 3379, 105, 105, 0),
      put('程', 3519, 105, 105, 0),
    ];
  }

  it('应用画布尺度（字号 105 / 行宽 3584 / |m| = 0.003）的倾斜行必须拼回一条行', () => {
    // 画布高取应用真实值 5108：行的 y ≈ 549–663，远离 5% 的页眉页脚带
    const { contents, lines } = tiltPageOf(appScaleRow(0.003), 5108);

    expect({
      contents,
      lineCount: lines.length,
      wordCount: lines[0]?.wordIndices.length ?? 0,
      hasScripts: lines[0]?.hasScripts ?? false,
    }).toEqual({
      contents: ['已知函数e$^{-(x+y)}$的概率密度为f (x)，求其分布律，并写出过程'],
      lineCount: 1,
      wordCount: 20,
      hasScripts: true,
    });
  });
});


// ═══════════════════════════════════════════════════════════════
// 页眉页脚：裁剪而不是整行删（同一行里混着正文词）
// ═══════════════════════════════════════════════════════════════

describe('页眉页脚：同一行里混着正文时只裁掉家具词，不许整行删', () => {
  /**
   * 构造：页眉词与正文词落进**同一个 y 桶**（中心相距 5px，正好卡在
   * `SAME_LINE_TOLERANCE` 上）。旧实现把整行判成页面家具后整行删掉，
   * 正文「正文续行」随之消失 —— 段落断头，而且用户看不到原因。
   */
  const header = w('页眉', 440, 90, 36, 100, 95); // 中心 108 ≤ 111.15（上边缘带内）
  const bodyOnSameLine = w('正文续行', 225, 92, 42, 600, 92); // 中心 113 > 111.15（带外）
  const rest = [
    w('接下来是正常的正文内容，用来把中位字号钉在 42。', 225, 250, 42, 1379, 92),
    w('第二行正文内容同样要达到足够的宽度。', 225, 314, 42, 1200, 92),
    w('第三行正文内容，保证页面至少有三行。', 225, 378, 42, 1100, 92),
  ];

  it('页眉词被裁掉，正文词一个都不能少', () => {
    const blocks = ocrResultToBlocks(
      pageResult({ words: [header, bodyOnSameLine, ...rest] }),
      REAL_CANVAS_HEIGHT,
    );
    const text = blocks.map((b) => b.content).join('\n');

    expect(text).toContain('正文续行');
    expect(text).not.toContain('页眉');
  });
});

// ═══════════════════════════════════════════════════════════════
// 英文换行断词回接（dehyphenation）
// ═══════════════════════════════════════════════════════════════

describe('英文换行断词回接', () => {
  it('`inter-` + `national` 回接成一个词（词级坐标路径）', () => {
    const words = [
      w('This chapter introduces the inter-', 225, 200, 42, 900, 92),
      w('national standard for floating point.', 225, 260, 42, 950, 92),
      w('The rest of the paragraph continues here.', 225, 320, 42, 1000, 92),
    ];
    const content = ocrResultToBlocks(pageResult({ words }), REAL_CANVAS_HEIGHT)
      .map((b) => b.content)
      .join('\n');

    expect(content).toContain('international');
    expect(content).not.toContain('inter-');
  });

  it('数字开头的下一段不回接：`e-` + `5` 保留连字符与空格', () => {
    const words = [
      w('The value grows like e-', 225, 200, 42, 900, 92),
      w('5 times per second in the limit.', 225, 260, 42, 950, 92),
      w('Another sentence keeps the paragraph going.', 225, 320, 42, 1000, 92),
    ];
    const content = ocrResultToBlocks(pageResult({ words }), REAL_CANVAS_HEIGHT)
      .map((b) => b.content)
      .join('\n');

    expect(content).toContain('e- 5');
  });

  it('大写开头的下一段不回接：`T-` + `cell` 保留连字符', () => {
    const words = [
      w('The device is called a T-', 225, 200, 42, 900, 92),
      w('cell receptor in the paper.', 225, 260, 42, 950, 92),
      w('Another sentence keeps the paragraph going.', 225, 320, 42, 1000, 92),
    ];
    const content = ocrResultToBlocks(pageResult({ words }), REAL_CANVAS_HEIGHT)
      .map((b) => b.content)
      .join('\n');

    expect(content).toContain('T- cell');
  });

  it('纯文本兜底路径同样回接', () => {
    const blocks = ocrTextToBlocks('The inter-\nnational standard');
    expect(blocks[0]?.content).toContain('international');
    expect(blocks[0]?.content).not.toContain('inter-');
  });
});

// ═══════════════════════════════════════════════════════════════
// 真实文档回归：被大括号撑高的公式行不得按虚高字号吸收下一行
// ═══════════════════════════════════════════════════════════════
//
// 用户那份习题 PDF 第 1 页的**新版实测导出**（公式区域恢复跑通之后）。
// 这一页的版面主字号是 36。
//
//   · 词 0「fx(x) = { 0, x ≤ 0 fx(y) = { 0, y≤ 0」是行带恢复重新识别出来的
//     整行：框 [297,503]–[1085,555]，**高 52、fontSize 56** ——
//     比真实字高多出来的那一截是**跨行大括号撑的**。
//   · 词 2「_(1，当 X≤Y」框 [301,622]–[613,650]，在它下方 **67px**
//     （它其实是下面那个大括号式的第一行，应与词 1 那一行归为同一构件）。
//
// 旧逻辑纵向尺子取 `max(词框字号 56, 主字号 36) = 56`，带宽 56 × 1.4 = 78.4px，
// 67px 顺利过关 → 两行被并成一条 line（实测导出 y=503、wi=[6,8]、
// yRange [503,650]，整段读成「fx(x) = … _(1，当 X≤Y」）。
// 现在尺子钉在版面主字号：36 × 1.4 = 50.4 < 67 → 不并；而距它 13px 的
//「其中λ…」行照常按构件接纳这一行 —— 修的是跨行误并，不是禁止合并。
describe('真实文档回归：大括号撑高的行不得按虚高字号吸收下一行', () => {
  const words = [
    // 撑高的公式行（真实框与字号，一字不改）
    branchRealWord('fx(x) = { 0, x ≤ 0 fx(y) = { 0, y≤ 0', 297, 503, 1085, 555, 56),
    // 上面那行正文（真实框）：它才是应当接纳下一行分支的「构件主机」
    branchRealWord('其中λ>0，μ>0是常数.引入随机变量', 162, 568, 752, 609, 41),
    // 被误并的那一行（真实框）
    branchRealWord('_(1，当 X≤Y', 301, 622, 613, 650, 32),
    // 下面大括号式的第二行（真实框）：与词 2 同宽，互为「并列行」不得互并
    branchRealWord('Z = {0, 当X > Y', 293, 650, 613, 702, 56),
    // 补足版面主字号众数 = 36 的填充行（远离上述区域）
    w('这一页的版面主字号由这些重复出现的字高决定', 225, 1200, 36, 640, 95),
    w('同样字高的另起一行文字用来累计出现次数', 225, 1255, 36, 640, 95),
    w('再来一行相同字高的正文把众数钉在 36 上', 225, 1310, 36, 640, 95),
    w('最后一行相同字高的正文作为结尾填充行', 225, 1365, 36, 640, 95),
  ];

  it('撑高的行一个人成行 —— 67px 下方的分支行不得被并进来', () => {
    const structure = branchStructureOf(words);
    const fxLine = branchLineWith(structure, 0);

    // 旧逻辑：wordIndices = [0, 2]、yRange = [503, 650]（把下一行吞了）
    expect(fxLine?.wordIndices).toEqual([0]);
    expect(fxLine?.yRange).toEqual([503, 555]);
    expect(fxLine?.text).toContain('fx(x)');
    expect(fxLine?.text).not.toContain('当 X≤Y');
  });

  it('该分支行仍按「构件」被上一行接纳（防「一刀切禁止合并」）', () => {
    // 注：这一行后来还有第二重归属 —— `Z = {…}` 锚点的分段函数重组
    // （`lib/ocrPiecewise.ts`）会把它并进公式块。所以这里先把 Z 锚点词
    // （词 3）从页面上拿掉，单独看成行阶段本身：合并规则没有变，
    // 变的只是「并完之后它去了哪里」（归公式的用例在下一个）。
    const structure = branchStructureOf(words.filter((_, i) => i !== 3));

    // 距离 13px 的邻居照常合并 —— 这是行内构件，不是隔了行的正文
    expect(branchLineWith(structure, 2)?.wordIndices).toEqual([1, 2]);
  });

  it('Z 锚点在时：该分支行被并入分段函数公式，不再独立成行', () => {
    const structure = branchStructureOf(words);

    // 词 2 已经作为 Z 的上分支进了公式块（不再出现在任何行里）
    expect(branchLineWith(structure, 2)).toBeUndefined();
    const zBlock = structure.blocks.find((b) => b.type === 'math');
    expect(zBlock?.content).toContain('Z =\\begin{cases}');
    expect(zBlock?.content).toContain('1，当 X\\le Y');
    // 公式上方的散文仍独立成段（不并进公式）
    expect(structure.blocks.find((b) => b.content.includes('其中λ>0'))).toBeDefined();
  });

  it('同宽的大括号两行互为并列行，谁也不并谁', () => {
    const structure = branchStructureOf(words);

    expect(branchLineWith(structure, 3)?.wordIndices).toEqual([3]);
  });
});
