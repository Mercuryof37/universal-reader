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
