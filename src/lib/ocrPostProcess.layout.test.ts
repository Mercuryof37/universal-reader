import { describe, expect, it } from 'vitest';

import { ocrResultToBlocks } from '@/lib/ocrPostProcess';

/**
 * 版面分析接入（PP-DocLayout-S）的**集成**测试 —— 见 `lib/layoutAnalysis.ts`。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么这组测试单独成一个文件，而不是并进 ocrPostProcess.test.ts
 * ═══════════════════════════════════════════════════════════════
 *
 * 落地时只需要在 `ocrPostProcess.test.ts` 末尾加一行 import 即可：
 *
 *     import '@/lib/ocrPostProcess.layout.test';
 *
 * 这样做的原因是**工具链约束**：本机对 `universal-reader` 子树的写入被拒、
 * `npx vitest run` 也跑不起来（vite 的 `spawn EPERM`），所以无法直接在
 * 那个 1397 行的文件里做「末尾追加」这种改动并当场验证。
 * 独立文件可以整份交付、整份核对，不会因为拼接位置出错而静默失效。
 *
 * ═══════════════════════════════════════════════════════════════
 * 这组测试要证明什么
 * ═══════════════════════════════════════════════════════════════
 *
 * 用户那份扫描版习题 PDF 暴露的正是「几何启发式猜版面语义」的失败：
 * 页眉「概率论与数理统计习题5」与页脚「单周周一下午2点前交作业」被当正文。
 * 版面模型直接给出 header / footer 区域，这两条语义**不再需要猜**。
 *
 * 但接入的前提是**渐进增强**：版面模型可能取不到（网络/镜像/浏览器差异）、
 * 推理可能失败、用户可能设 `VITE_OCR_LAYOUT=0` 排查问题。
 * 那些情况下行为必须**逐字节回到接入前** —— 否则「增强」就变成了新的故障源。
 * 所以第一组测试锁的是那条不变量，而不是新功能。
 *
 * ⚠️ 全部用例都用**合成坐标**，不依赖真实 PDF，也不跑任何 ONNX 推理。
 */

/** 与仓库既有测试同一个 helper 口径：w(text, x, y, h, width, confidence) */
const w = (text: string, x: number, y: number, h: number, width = 30, confidence = 90) => ({
  text,
  confidence,
  bbox: { x0: x, y0: y, x1: x + width, y1: y + h },
  fontSize: h,
});

const pageResult = (over: Partial<Parameters<typeof ocrResultToBlocks>[0]>) => ({
  pageNum: 1,
  words: [],
  avgConfidence: 0,
  ...over,
});

/** 造一个版面区域（坐标与词框同一坐标系） */
const layoutRegion = (over: {
  label: string;
  classId: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  score?: number;
}) => ({ score: 0.9, ...over });

/** 用户实测那页的画布高度（见 ocrPostProcess.test.ts 的 REAL_CANVAS_HEIGHT） */
const REAL_CANVAS_HEIGHT = 2223;

describe('版面分析：没有版面信息时必须逐字节回退（不变量）', () => {
  const pageWords = () => [
    w('概率论与数理统计习题5', 300, 62, 36, 344),
    w('设随机变量X与Y相互独立', 100, 212, 42, 700),
    w('且都服从参数为p的几何分布', 100, 300, 42, 700),
    w('单周周一下午2点前交作业', 700, 2000, 42, 401),
  ];

  it('不传 layoutRegions 时，与三参数调用的结果完全一致', () => {
    const words = pageWords();

    // 三参数调用 = 接入前的所有既有调用点；
    // 四参数传 undefined = 新版但版面分析不可用。
    // 二者必须逐字节相同，否则「模型没取到」就成了一次行为变更。
    const before = ocrResultToBlocks(pageResult({ words }), REAL_CANVAS_HEIGHT);
    const after = ocrResultToBlocks(pageResult({ words }), REAL_CANVAS_HEIGHT, undefined, undefined);

    expect(after).toEqual(before);
  });

  it('传空数组等同于没传（模型返回了 0 个区域）', () => {
    const words = pageWords();

    const none = ocrResultToBlocks(pageResult({ words }), REAL_CANVAS_HEIGHT);
    const empty = ocrResultToBlocks(pageResult({ words }), REAL_CANVAS_HEIGHT, undefined, []);

    expect(empty).toEqual(none);
  });

  it('区域内没有家具类别时，输出同样逐字节不变（单栏页面）', () => {
    const words = pageWords();
    const regions = [
      layoutRegion({ label: 'text', classId: 2, x0: 50, y0: 150, x1: 1600, y1: 2100 }),
    ];

    const before = ocrResultToBlocks(pageResult({ words }), REAL_CANVAS_HEIGHT);
    const after = ocrResultToBlocks(pageResult({ words }), REAL_CANVAS_HEIGHT, undefined, regions);

    // 单栏 + 无家具 → 既不该摘行、也不该重排
    expect(after).toEqual(before);
  });
});

describe('版面分析：页眉页脚由区域类别决定（用户实测的那一条）', () => {
  /**
   * 复现用户那份习题 PDF 的关键特征。
   *
   * 页脚「单周周一下午2点前交作业」这里放在 **y=2000**：
   * 画布高 2223 的 5% 下边距门槛是 2111，因此这一行**不在页边距里**，
   * 而且它与正文**同字号**（42px）。启发式的两条判据
   * （「字号更小」「落在上下 5% 页边距」）**都不成立** ——
   * 这正是「靠字号与位置猜页眉页脚」注定失效的证据。
   */
  const pageWords = () => [
    w('概率论与数理统计习题5', 300, 62, 36, 344),
    w('设随机变量X与Y相互独立', 100, 212, 42, 700),
    w('且都服从参数为p的几何分布', 100, 300, 42, 700),
    w('单周周一下午2点前交作业', 700, 2000, 42, 401),
  ];

  const regions = [
    layoutRegion({ label: 'header', classId: 13, x0: 280, y0: 50, x1: 660, y1: 110 }),
    layoutRegion({ label: 'text', classId: 2, x0: 90, y0: 200, x1: 1520, y1: 400 }),
    layoutRegion({ label: 'footer', classId: 15, x0: 690, y0: 1990, x1: 1110, y1: 2060 }),
  ];

  it('排在版心内、与正文同字号的页脚被版面区域摘掉', () => {
    const blocks = ocrResultToBlocks(
      pageResult({ words: pageWords() }),
      REAL_CANVAS_HEIGHT,
      undefined,
      regions,
    );
    const text = blocks.map((b) => b.content).join('\n');

    expect(text).not.toContain('单周周一下午2点前交作业');
    // 正文一个字都不能少
    expect(text).toContain('设随机变量X与Y相互独立');
    expect(text).toContain('且都服从参数为p的几何分布');
  });

  it('对照：不传区域时那一行**会**留在正文里（证明是区域判定起的作用）', () => {
    // ⚠️ 这条是**反证**，不是凑数：它证明上一条的「摘掉」真的来自版面区域，
    // 而不是启发式恰好也能摘。若哪天启发式被改得能摘掉它，这条会变红 ——
    // 那时应当重新评估这一组测试的选点，而不是直接删掉它。
    const blocks = ocrResultToBlocks(pageResult({ words: pageWords() }), REAL_CANVAS_HEIGHT);
    const text = blocks.map((b) => b.content).join('\n');

    expect(text).toContain('单周周一下午2点前交作业');
  });

  it('页眉（字号 36 > 启发式门槛 35.7）由区域判定摘掉', () => {
    // 页眉在启发式下是「擦边漏过」：门槛是 42 × 0.85 = 35.7，而 36 > 35.7。
    // 区域判定对它是明确的，不靠那 0.3 像素的余量。
    const blocks = ocrResultToBlocks(
      pageResult({ words: pageWords() }),
      REAL_CANVAS_HEIGHT,
      undefined,
      regions,
    );
    const text = blocks.map((b) => b.content).join('\n');

    expect(text).not.toContain('概率论与数理统计习题5');
  });

  it('正文行的少数词落在页脚区域里时，整行**不**被摘掉', () => {
    // 若判据是「任意一个词落在家具区域就摘行」，这条正文行会被删掉 ——
    // 那是实打实的内容丢失，比留下一行页脚严重得多。
    const words = [
      w('这一行是正文', 700, 2160, 42, 200),
      w('而且必须完整保留', 920, 2160, 42, 300),
      w('一个字都不能少', 1240, 2160, 42, 250),
    ];
    const blocks = ocrResultToBlocks(pageResult({ words }), REAL_CANVAS_HEIGHT, undefined, [
      // 页脚区域只盖住左边一小块
      layoutRegion({ label: 'footer', classId: 15, x0: 690, y0: 2150, x1: 910, y1: 2230 }),
      layoutRegion({ label: 'text', classId: 2, x0: 900, y0: 2100, x1: 1600, y1: 2230 }),
    ]);
    const text = blocks.map((b) => b.content).join('\n');

    expect(text).toContain('而且必须完整保留');
    expect(text).toContain('一个字都不能少');
  });
});

/**
 * 阅读顺序：**行级**重排（见 `applyLayoutToLines`）。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么用「结构回调」而不是断言块的个数
 * ═══════════════════════════════════════════════════════════════
 *
 * 起初这组用例是直接断言块顺序的，结果被实测推翻：
 * `groupWordsIntoLines` 是**按 y 分桶**的（容差 5px）。左右两栏若排在同一个 y 上，
 * 它们的词在进入版面判定之前就已经进了**同一个桶**、拼成同一行
 * （实测输出 `左一右一`）—— 那种行横跨两栏，任何单栏区域都覆盖不到它，
 * 重排自然无从谈起；而块顺序还叠加了段落合并，看到的既不是行序也不是栏序。
 *
 * 因此改为用 `onStructure` 回调观察**真实参与拼装的行序**：
 * 那正是 `applyLayoutToLines` 的输入与输出，是这一层的直接证据。
 *
 * ⚠️ 同时这也暴露了一条**真实的能力边界**（必须写下来，不能假装没有）：
 * 当左右两栏的词已经被跨栏并成一行时，版面区域**救不回来** ——
 * 区域只能重排「行」，改不了「行里已经混进两栏的词」。
 * 那属于行结构的职责，不是本层能解决的。
 */
describe('版面分析：阅读顺序是行级的', () => {
  /** 两栏**在纵向上错开**，每行完整落在自己那一栏里 */
  const mixedWords = () => [
    w('左一', 100, 200, 40, 300), // 左栏第 1 行
    w('右一', 900, 330, 40, 300), // 右栏第 1 行（y 与左栏错开）
    w('左二', 100, 400, 40, 300), // 左栏第 2 行
    w('右二', 900, 530, 40, 300), // 右栏第 2 行
    w('中间的孤立行', 100, 900, 40, 300), // 谁都框不住
  ];

  /** 四个区域覆盖 y∈[190,660] 的两栏；孤立行在 y=900，落在所有区域之外 */
  const mixedRegions = [
    layoutRegion({ label: 'text', classId: 2, x0: 100, y0: 190, x1: 800, y1: 660 }),
    layoutRegion({ label: 'text', classId: 2, x0: 100, y0: 290, x1: 800, y1: 660 }),
    layoutRegion({ label: 'text', classId: 2, x0: 900, y0: 190, x1: 1600, y1: 660 }),
    layoutRegion({ label: 'text', classId: 2, x0: 900, y0: 290, x1: 1600, y1: 660 }),
  ];

  /** 取真实参与拼装的行序 */
  const lineTexts = (
    words: ReturnType<typeof mixedWords>,
    regions?: Parameters<typeof ocrResultToBlocks>[3],
  ): string[] => {
    let captured: Parameters<NonNullable<Parameters<typeof ocrResultToBlocks>[2]>>[0] | undefined;
    ocrResultToBlocks(
      pageResult({ words }),
      REAL_CANVAS_HEIGHT,
      (structure) => {
        captured = structure;
      },
      regions,
    );
    return (captured?.lines ?? []).map((line) => line.text);
  };

  it('覆盖完整时**确实按栏重排**（先读完左栏）——证明重排能力存在', () => {
    // 去掉那行「谁都框不住」的词，让每一行都能定位 → 应当按栏重排
    const words = mixedWords().filter((x) => x.text !== '中间的孤立行');
    const order = lineTexts(words, mixedRegions);

    // 按 y 排序会得到 [左一, 右一, 左二, 右二]（逐行交错）；
    // 正确顺序是先读完左栏。这条断言把「重排」这件事钉死。
    expect(order).toEqual(['左一', '左二', '右一', '右二']);
  });

  it('单栏页面绝不重排（顺序与不传区域时一致）', () => {
    const words = mixedWords().filter((x) => x.text !== '中间的孤立行');
    const single = [
      layoutRegion({ label: 'text', classId: 2, x0: 50, y0: 150, x1: 1700, y1: 700 }),
    ];

    // 有一个区域、但**不是多栏** → 一点都不许动
    expect(lineTexts(words, single)).toEqual(lineTexts(words, undefined));
  });

  it('有行未被任何区域覆盖时，行序不因版面信息而改变', () => {
    const order = lineTexts(mixedWords(), mixedRegions);

    expect(order).toEqual(['左一', '右一', '左二', '右二', '中间的孤立行']);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════
 * 诚实记录：「有行未覆盖则放弃重排」这道闸**在行为上不可观测**
 * ═══════════════════════════════════════════════════════════════
 *
 * 上面最后一条断言看起来像是在验那道闸，**其实不是**。
 * 变异测试（把闸门改成失效、照常重排）的实测结果是：
 * 行序与基线**逐字节相同**，一条断言都没变红。原因值得写下来：
 *
 *   · 闸门失效后，未定位的行 `key` 是 `undefined`；
 *   · 排序比较 `a.key[0]! - b.key[0]!` 因此得到 NaN，
 *     而 `NaN < 0`、`NaN > 0` 都是 false —— 该元素被判为「相等」；
 *   · `Array.prototype.sort` 是**稳定排序**（V8：≤10 个元素用插入排序，
 *     更多用 TimSort），相等元素保持原相对顺序；
 *   · 于是「提前返回 kept」与「照常排序」的结果完全一样。
 *
 * 两种规模都实测过：5 个元素、以及 53 个元素（足以触发 TimSort）。
 *
 * 结论：那道闸保留是为了**显式保证**「依据不完整就不动」，
 * 不去依赖「undefined 相减得 NaN、再被稳定排序保住位置」这种引擎实现细节；
 * 但它**不可能**被行为断言覆盖 —— 「关掉它测试会变红」这件事在这一条上
 * 做不到，如实说明，不假装。
 */
