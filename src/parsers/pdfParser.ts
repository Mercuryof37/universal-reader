import type { ContentBlock, DocDocument, FileParser } from '@/types/content';
import { buildDocument, uid } from '@/lib/utils';
import { checkPdfSupport } from '@/lib/polyfills';
import { errorReport, describeUnknownError } from '@/lib/diagnostics';
import { createPdfDocumentParams, pdfjsLib } from '@/parsers/pdfRuntime';
import { ScannedPdfError } from '@/parsers/scannedPdfError';
import { OCR_CONTINUE_ON_PAGE_ERROR, OCR_RENDER_DPI, resolvePageLimit, shouldCheckpoint } from '@/lib/ocrTypes';
import type { OcrLang, OcrProgress } from '@/lib/ocrTypes';
import { ocrResultToBlocks } from '@/lib/ocrPostProcess';

/**
 * 从 pdf.js 的文本项里我们只取用这几个字段。
 * 不直接引用 pdfjs 的完整类型：跨版本类型名变动频繁，
 * 而且除了 transform 矩阵，其余字段我们其实都用不上。
 */
interface PdfTextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
  fontName?: string;
}

/** 页内聚成的段落 */
interface PdfParagraph {
  text: string;
  y: number;
  /** 该段最大字号，用于判断是否为标题 */
  fontSize: number;
  /** 段内行数 */
  lines: number;
}

const SAME_LINE_TOLERANCE = 0.6;
const MAX_BLOCK_CHARS = 1200;
/** 超过该字号的短文本视为标题（PDF 没有语义标签，只能靠字号猜） */
const HEADING_MIN_FONT_SIZE = 16;
const HEADING_MAX_CHARS = 80;
/** 断段判定相对行距中位数的倍数 */
const PARAGRAPH_BREAK_RATIO = 1.35;

/**
 * 判定"文字层只是残渣"的两个阈值（均为每页均值，须**同时**满足）。
 *
 * 依据一份真实习题 PDF：6 道题全是图片，文字层只有标题与页脚的
 * "单周周一下午2点前交作业概率论与数理统计习题5"，合计 23 字、6 处图像。
 * 即 **23 字/页、6 图/页**，明显落在下面两条阈值之内。
 *
 * ── 为什么要求同时满足，而不是任一满足 ──
 *
 * 单看"文字少"会误伤：一页只写两行字的封面、一张示意图配一句说明，
 * 都属于正常文档。单看"图片多"也会误伤：图文并茂的教材每页都有插图。
 * 只有**两者同时成立**才说明文字层是残渣 —— 图片才是内容的载体。
 *
 * 误判的代价是不对称的：误判为图片型只是多跑一次 OCR（慢，但结果正确）；
 * 漏判则让用户拿到残缺内容却毫不知情（本次故障）。
 * 因此宁可偏严。
 */
const MIN_CHARS_PER_PAGE = 50;
const MIN_IMAGES_PER_PAGE = 3;

/**
 * 统计一页里的图像绘制指令数。
 *
 * 必须传 `intent: 'display'`：默认的 `'print'` 不会展开 Form XObject 内部的指令，
 * 而扫描件与"题目截图"恰恰把图片放在 Form XObject 里。
 * 用默认参数会得出"这页没有图片"的错误结论 —— 这个坑在
 * `scripts/diagnose-pdf.mjs` 里也踩过一次（见 docs/03 误判 A）。
 *
 * 只遍历操作符列表、不解码图像，因此开销远小于真正渲染一页。
 */
async function countImageOps(page: {
  getOperatorList: (opts: { intent: string }) => Promise<{ fnArray: number[] }>;
}): Promise<number> {
  try {
    const ops = await page.getOperatorList({ intent: 'display' });
    const imageOps = new Set<number>([
      pdfjsLib.OPS.paintImageXObject,
      pdfjsLib.OPS.paintInlineImageXObject,
      pdfjsLib.OPS.paintImageMaskXObject,
      pdfjsLib.OPS.paintImageXObjectRepeat,
    ]);
    return ops.fnArray.filter((fn) => imageOps.has(fn)).length;
  } catch {
    // 拿不到操作符列表不应影响正文提取 —— 最坏情况是漏判一次"图片型 PDF"
    return 0;
  }
}

/**
 * 为 pdf.js 准备文档数据。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么必须拷贝（一个只在真机暴露的陷阱）
 * ═══════════════════════════════════════════════════════════════
 *
 * pdf.js 在**使用独立 Worker 时**会把 `data` 传入的 ArrayBuffer
 * **转移（transfer）** 给 worker。转移之后，主线程这一侧的 buffer 会变成
 * "已分离（detached）"状态 —— 长度归零，任何读取操作都会抛：
 *
 *     TypeError: Cannot perform Construct on a detached ArrayBuffer
 *
 * 这对一次性解析没有影响，但会打断**需要复用同一份字节**的流程：
 * OCR 就是这样的流程 —— 它先解析一遍以判定是否为扫描件，
 * 之后还要用同一份字节再次渲染每一页。
 *
 * 用 `slice(0)` 拷贝一份交给 pdf.js，原始 buffer 保持可用。
 * 代价是一次内存拷贝（几十 MB 的文件约几十毫秒），换来的是调用方不必
 * 关心"pdf.js 有没有把我的 buffer 吃掉"这种隐蔽的副作用。
 */
export function copyForPdfJs(buffer: ArrayBuffer): ArrayBuffer {
  return buffer.slice(0);
}

/**
 * 把一页的文字片段按 y 坐标聚成行，再按行距聚成段。
 *
 * 断段逻辑必须自适应，不能用固定的"行距 > 1.0×字号"这类绝对阈值：
 * 实测中一本 12pt、1.2 倍行距的书行距约 14.4pt，而字号也是 12，
 * 用绝对阈值会把每一行都判成独立段落，整篇文档碎成一千段。
 *
 * 因此分两步：
 * 1. 先算出本页所有相邻行距的中位数（即这本书的"正常行距"）；
 * 2. 只有行距超过中位数的 1.35 倍、或字号突变、或上一行已结句且留白明显，才断段。
 */
export function clusterIntoParagraphs(items: PdfTextItem[]): PdfParagraph[] {
  if (!items.length) return [];

  const lines = groupIntoLines(items);
  if (!lines.length) return [];

  // 第一步：统计本页行距中位数
  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    gaps.push(Math.abs((lines[i - 1]?.y ?? 0) - (lines[i]?.y ?? 0)));
  }
  const medianGap = median(gaps) || 0;

  const paragraphs: PdfParagraph[] = [];
  let current: PdfParagraph | null = null;
  let prevY: number | null = null;

  for (const line of lines) {
    const gap = prevY === null ? 0 : Math.abs(prevY - line.y);
    // 中位数拿不到时（只有一行）用一个保守的相对值兜底
    const breakGap = medianGap > 0 ? medianGap * PARAGRAPH_BREAK_RATIO : line.fontSize * 1.35;

    // 显式标注类型：这个别名来自可变的 current，
    // 不加标注 TS 会因为循环推断而把它视为 any。
    const prevParagraph: PdfParagraph | null = current;
    const endsSentence = prevParagraph !== null && /[。！？!?.;；]$/.test(prevParagraph.text);

    const isNewParagraph =
      prevParagraph === null ||
      gap > breakGap ||
      Math.abs(line.fontSize - prevParagraph.fontSize) > 1.5 ||
      // 上一行已经以句末标点收尾，且留白不小于正常行距 —— 典型的段末。
      // 阈值取 0.95 而不是 1.1：整篇行距完全均匀的 PDF 里没有任何"行距变大"的信号，
      // 此时"上一行已结句"是唯一可用的断段依据，用大于 1 的系数会导致永远不断段。
      (endsSentence && gap > medianGap * 0.95);

    if (isNewParagraph || prevParagraph === null) {
      if (prevParagraph) paragraphs.push(prevParagraph);
      current = { text: line.text, y: line.y, fontSize: line.fontSize, lines: 1 };
    } else {
      // 中文行间不加空格，英文行间加空格
      const joiner = /[\u4e00-\u9fff]$/.test(prevParagraph.text) ? '' : ' ';
      prevParagraph.text = `${prevParagraph.text}${joiner}${line.text}`;
      prevParagraph.lines += 1;
      current = prevParagraph;
    }
    prevY = line.y;
  }
  if (current) paragraphs.push(current);

  return paragraphs;
}

/** 把片段按 y 坐标聚成行，并按 x 坐标排出阅读顺序 */
function groupIntoLines(items: PdfTextItem[]): { y: number; text: string; fontSize: number }[] {
  const linesMap = new Map<number, PdfTextItem[]>();

  for (const item of items) {
    const y = item.transform[5] ?? 0;
    let matchedKey: number | undefined;
    for (const key of linesMap.keys()) {
      if (Math.abs(key - y) <= SAME_LINE_TOLERANCE) {
        matchedKey = key;
        break;
      }
    }
    const key = matchedKey ?? y;
    const bucket = linesMap.get(key);
    if (bucket) bucket.push(item);
    else linesMap.set(key, [item]);
  }

  return [...linesMap.entries()]
    .map(([y, group]) => {
      // PDF 的文字片段不一定按阅读顺序排列，按 x 坐标排序才符合人眼顺序
      const sorted = [...group].sort((a, b) => (a.transform[4] ?? 0) - (b.transform[4] ?? 0));
      const text = sorted
        .map((i) => i.str)
        .join('')
        .replace(/\s+/g, ' ')
        .trim();
      const fontSize = Math.max(...sorted.map((i) => i.height || 0), 0);
      return { y, text, fontSize };
    })
    .filter((l) => l.text.length > 0)
    // y 轴向上为正，降序即阅读顺序
    .sort((a, b) => b.y - a.y);
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : (sorted[mid] ?? 0);
}

/**
 * 扫描版专用错误从独立模块重新导出，保持既有调用路径可用。
 * 定义放在 scannedPdfError.ts 是为了避免"为拿一个错误类而拖进整个 pdfjs + PaddleOCR 依赖树"。
 */
export { ScannedPdfError, isScannedPdfError } from '@/parsers/scannedPdfError';

/**
 * PDF 解析器。
 *
 * 核心思路：PDF 里没有"段落"这个概念，只有一堆绝对定位的文字片段。
 * 因此需要两步重建：
 * 1. 按 y 坐标把片段聚成行（同一行 y 差值在容差内）；
 * 2. 按行距把行聚成段（行距明显大于行高即认为是新段）。
 *
 * 扫描版 PDF 会抛出 ScannedPdfError，调用方可捕获后调用 ocrParse() 进行 OCR。
 */
export class PdfParser implements FileParser {
  supportedFormats = ['.pdf'];
  label = 'PDF';

  async parse(file: File): Promise<DocDocument> {
    const support = checkPdfSupport();
    if (!support.ok) {
      throw new Error(`${support.reason}（建议使用 Chrome / Edge 119 以上版本）`);
    }

    const buffer = await file.arrayBuffer();

    let doc: Awaited<ReturnType<typeof pdfjsLib.getDocument>['promise']>;
    try {
      doc = await pdfjsLib.getDocument(
        createPdfDocumentParams(copyForPdfJs(buffer)) as Parameters<
          typeof pdfjsLib.getDocument
        >[0],
      ).promise;
    } catch (err) {
      throw new Error(describeOpenFailure(err));
    }

    const drafts: Omit<ContentBlock, 'id'>[] = [];
    let metaTitle = '';
    let metaAuthor = '';

    try {
      const info = await doc.getMetadata().catch(() => null);
      const raw = (info?.info ?? {}) as Record<string, unknown>;
      if (typeof raw.Title === 'string') metaTitle = raw.Title;
      if (typeof raw.Author === 'string') metaAuthor = raw.Author;
    } catch {}

    let textCharCount = 0;
    let pagesWithText = 0;
    /** 全文档的图像绘制指令总数，用于识别"文字少但图片多"的混合型 PDF */
    let imageOpCount = 0;

    for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
      const page = await doc.getPage(pageNum);
      const content = await page.getTextContent();
      const items = (content.items as unknown[]).filter(isTextItem);

      const paragraphs = clusterIntoParagraphs(items);
      const pageChars = paragraphs.reduce((n, p) => n + p.text.replace(/\s/g, '').length, 0);
      textCharCount += pageChars;
      if (pageChars > 0) pagesWithText++;

      // 统计该页画了多少张图。
      // 用 intent: 'display' 才会展开 Form XObject 内部的指令 ——
      // 扫描件与"题目截图"恰恰把图片放在 Form XObject 里（见 docs/03 误判 A）。
      // 注意这里只遍历操作符列表，不解码图像，开销远小于渲染。
      imageOpCount += await countImageOps(page);

      for (const para of paragraphs) {
        const body = para.text.replace(/\s+/g, ' ').trim();
        if (!body) continue;

        const pieces = body.length > MAX_BLOCK_CHARS ? splitLongText(body, MAX_BLOCK_CHARS) : [body];

        for (const piece of pieces) {
          drafts.push({
            type:
              para.fontSize >= HEADING_MIN_FONT_SIZE && piece.length <= HEADING_MAX_CHARS
                ? 'heading'
                : 'paragraph',
            content: piece,
            translations: {},
            metadata: { pageNumber: pageNum },
          });
        }
      }

      page.cleanup();

      // 每页让出一次事件循环：pdf.js 跑在主线程，
      // 不让出的话进度提示不会刷新、取消按钮点不动、页面会完全冻死。
      // 每 5 页让出一次，在"响应性"与"调度开销"之间取平衡。
      if (pageNum % 5 === 0) await yieldToUI();
    }

    const totalPages = doc.numPages;
    await doc.destroy();

    /**
     * ══════════════════════════════════════════════════════════════
     * 判断"文字层是否只是残渣"—— 一个真实故障换来的规则
     * ══════════════════════════════════════════════════════════════
     *
     * 故障现场：一份习题 PDF，6 道题全是图片，只有页脚的
     * "单周周一下午2点前交作业"和标题"概率论与数理统计习题5"有文字层，
     * 合计 23 个字。解析器如实提取了这 23 字，用户看到的就是"只有标题"。
     *
     * 原实现的判断是 `if (!textCharCount) 抛扫描件错误` ——
     * **只看"有没有文字"，不看"文字够不够"**。23 个字足以绕过这个检查，
     * 于是既不提示是图片型 PDF，也不提供 OCR，用户只能自己猜为什么内容不全。
     *
     * 现在的判断加上"图片远多于文字"这一维度：
     * - 平均每页文字很少（< MIN_CHARS_PER_PAGE），且图片不少 → 文字层是残渣
     * - 此时抛 ScannedPdfError，让界面提供 OCR —— 与"整本无文字"同等处置，
     *   因为它们对用户的含义相同：**你要的内容不在文字层里**。
     */
    const charsPerPage = textCharCount / Math.max(1, totalPages);
    const imagesPerPage = imageOpCount / Math.max(1, totalPages);
    const textLayerIsResidue =
      charsPerPage < MIN_CHARS_PER_PAGE && imagesPerPage >= MIN_IMAGES_PER_PAGE;

    if (!textCharCount || textLayerIsResidue) {
      if (textLayerIsResidue) {
        console.info(
          `[pdfParser] ${file.name}：文字层仅 ${textCharCount} 字（${charsPerPage.toFixed(0)} 字/页），` +
            `但检测到 ${imageOpCount} 处图像（${imagesPerPage.toFixed(1)} 处/页）—— ` +
            `判定为内容以图片为主，转为 OCR 流程。`,
        );
      }
      throw new ScannedPdfError(totalPages, buffer, metaTitle, metaAuthor, file.name, file.size);
    }

    if (pagesWithText / totalPages < 0.3) {
      console.warn(
        `[pdfParser] ${file.name}：仅 ${pagesWithText}/${totalPages} 页含可提取文字，` +
          `其余为图片页，已跳过。`,
      );
    }

    return buildDocument({
      docId: uid(),
      fileName: file.name,
      format: 'pdf',
      blocks: drafts,
      title: metaTitle || undefined,
      author: metaAuthor || undefined,
      sizeBytes: file.size,
    });
  }
}

/**
 * OCR 任务的选项与结果类型。
 */
export interface OcrParseOptions {
  /** 语言 */
  lang: OcrLang;
  /** 最多处理多少页（从第 1 页起）。不传则处理全部 */
  maxPages?: number;
  onProgress?: (p: OcrProgress) => void;
  /**
   * 每识别完若干页（见 `OCR_CHECKPOINT_EVERY_PAGES`）回调一次，
   * 传入**到目前为止**的完整文档快照，供调用方落盘。
   *
   * 为什么需要它：整次 OCR 原本只在最后一页跑完后才写库，
   * 中途任何中断（页面自动重载、误关标签页、崩溃）都会让整次扫描
   * 无声无息地全部丢失。有了检查点，丢失窗口从"整次扫描"缩小到"最多几页"。
   *
   * 快照里的 `docId` 在整个过程中保持不变，因此反复写入是**覆盖**同一条记录，
   * 不会产生重复文档。
   *
   * 回调抛错不会中断扫描（只告警）—— 落盘是尽力而为的保障，不该反过来毁掉任务。
   */
  onCheckpoint?: (snapshot: DocDocument) => void | Promise<void>;
}

/** 单页 OCR 失败时的记录 */
export interface OcrPageFailure {
  pageNum: number;
  message: string;
}

export interface OcrParseResult {
  document: DocDocument;
  /** 成功识别的页数 */
  pagesProcessed: number;
  /** 判定为空白并跳过的页 */
  pagesSkipped: number;
  /** 失败的页及原因 */
  failures: OcrPageFailure[];
}

/**
 * 对扫描版 PDF 执行 OCR。
 *
 * ═══════════════════════════════════════════════════════════════
 * 容错设计（源于一次真实故障）
 * ═══════════════════════════════════════════════════════════════
 *
 * 初版实现里，任何一页失败都会抛出异常、**丢弃全部已识别结果**。
 * 实测在一本 833 页的扫描书上，第 31 页失败导致前 30 页的成果全部作废
 * —— 对一本需要跑一小时的书来说，这个代价不可接受。
 *
 * 现在的策略：
 * - 单页失败 → 记录页码与原因，**继续处理后续页面**；
 * - 空白页 → 跳过（扫描书里有大量隔页与插图页，OCR 它们纯属浪费）；
 * - 全部失败才算失败；部分成功则保存成果并如实报告失败的页。
 *
 * 这样用户拿到的是"833 页里成功了 830 页，第 31/57/88 页失败"，
 * 而不是"什么都没有"。
 */
export async function ocrParsePdf(
  buffer: ArrayBuffer,
  fileName: string,
  fileSize: number,
  options: OcrParseOptions,
  metaTitle: string,
  metaAuthor: string,
): Promise<OcrParseResult> {
  const { lang, maxPages, onProgress, onCheckpoint } = options;

  // 打开文档：这一步失败的原因与解析路径相同（加密 / 损坏 / 缺 API）
  let doc: Awaited<ReturnType<typeof pdfjsLib.getDocument>['promise']>;
  try {
    doc = await pdfjsLib.getDocument(
      createPdfDocumentParams(copyForPdfJs(buffer)) as Parameters<typeof pdfjsLib.getDocument>[0],
    ).promise;
  } catch (err) {
    throw new Error(errorReport('OCR：打开 PDF 失败', describeOpenFailure(err)));
  }

  // 页数计算与 store 共用同一个函数，避免两处口径不一致导致进度条与实际处理量对不上
  const totalPages = resolvePageLimit(doc.numPages, maxPages);
  const scale = OCR_RENDER_DPI / 72;

  // OCR 引擎按需加载：PaddleOCR 依赖的 ONNX Runtime WASM 约 28MB、模型约 10MB，
  // 体积依然很大，只有真的执行 OCR 时才需要它。
  const { ocrEngine, analyzeCanvasInk } = await import('@/lib/ocrEngine');
  await ocrEngine.initialize(lang);

  const allDrafts: Omit<ContentBlock, 'id'>[] = [];
  const failures: OcrPageFailure[] = [];
  /** OCR 跑了但没产出内容块的页（与"空白页"不同，这是值得警惕的信号） */
  const emptyOcrPages: { pageNum: number; source: string; textLength: number; darkRatio: number }[] =
    [];
  /** 每页的墨迹测量结果，用于区分"渲染空白"与"文件本身空白" */
  const blankPages: { pageNum: number; darkRatio: number; failed: boolean }[] = [];
  let pagesProcessed = 0;
  let pagesSkipped = 0;

  /**
   * 文档 id 在循环**之前**就定下来。
   *
   * 原来它是在最后 `buildDocument({ docId: uid() })` 时才生成的，
   * 于是中途落盘根本不可能 —— 每次检查点都会造出一个新 id，
   * 结果是书库里堆一堆半成品而不是覆盖同一条。
   */
  const docId = uid();

  /** 用当前的累积结果组装一次快照（供检查点落盘） */
  const snapshot = (): DocDocument =>
    buildDocument({
      docId,
      fileName,
      format: 'pdf',
      blocks: allDrafts,
      title: metaTitle || undefined,
      author: metaAuthor || undefined,
      sizeBytes: fileSize,
    });

  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    onProgress?.({ pageNum, total: totalPages, status: 'recognizing' });

    let pageCanvas: HTMLCanvasElement | undefined;
    /** 本页是否真的产出了内容块（决定这一页要不要触发一次中途落盘） */
    let blocksThisPage = false;
    try {
      const page = await doc.getPage(pageNum);
      const viewport = page.getViewport({ scale });

      // 注意：变量名避开 `document`，否则会遮蔽全局的 document 对象
      pageCanvas = document.createElement('canvas');
      pageCanvas.width = Math.ceil(viewport.width);
      pageCanvas.height = Math.ceil(viewport.height);
      const ctx = pageCanvas.getContext('2d');
      if (!ctx) {
        throw new Error('浏览器未提供 2D 画布上下文（可能因显存不足或标签页被降级）');
      }
      // 白底：PNG 的透明像素在 OCR 前会变成黑色，直接毁掉识别率
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, pageCanvas.width, pageCanvas.height);

      await page.render({
        canvasContext: ctx,
        viewport,
      } as Parameters<typeof page.render>[0]).promise;

      // 空白页跳过：省下的时间相当可观（扫描书里隔页很多）
      const ink = analyzeCanvasInk(pageCanvas);
      if (ink.failed) {
        // 测量失败时不跳过 —— 宁可白跑一次 OCR，也不能静默丢页
        console.warn(`[ocrParsePdf] 第 ${pageNum} 页墨迹分析失败，仍将执行 OCR`);
      }

      blankPages.push({ pageNum, darkRatio: ink.darkRatio, failed: ink.failed });

      if (!ink.failed && ink.darkRatio < 0.0005) {
        pagesSkipped++;
        console.warn(
          `[ocrParsePdf] 第 ${pageNum} 页判定为空白页并跳过：` +
            `深色像素占比=${(ink.darkRatio * 100).toFixed(4)}%，` +
            `平均亮度=${ink.meanLuma.toFixed(1)}，` +
            `尺寸=${ink.width}×${ink.height}`,
        );
      } else {
        const ocrResult = await ocrEngine.recognizePage(
          pageCanvas,
          pageNum,
          totalPages,
          onProgress,
        );
        const blocks = ocrResultToBlocks(ocrResult, pageCanvas.height);
        if (blocks.length) {
          allDrafts.push(...blocks);
          pagesProcessed++;
          blocksThisPage = true;
        } else {
          // 关键区分：OCR 确实跑了但没提取到词，与"页面本身是空白"是两回事。
          // 曾经两者都被计入 skipped 且不报错，导致
          // "30 页全空、0 页出错" 这种自相矛盾的结果无法排查。
          pagesSkipped++;
          const info = ocrResult.extraction;
          emptyOcrPages.push({
            pageNum,
            source: info?.source ?? 'unknown',
            textLength: ocrResult.pageText?.length ?? 0,
            darkRatio: ink.darkRatio,
          });
          console.warn(
            `[ocrParsePdf] 第 ${pageNum} 页 OCR 未产生内容块：` +
              `提取路径=${info?.source ?? 'unknown'}，` +
              `纯文本长度=${ocrResult.pageText?.length ?? 0}，` +
              `词数=${ocrResult.words.length}，` +
              `墨迹占比=${(ink.darkRatio * 100).toFixed(4)}%`,
          );
        }
      }

      page.cleanup();

      // 中途落盘：丢失窗口从"整次扫描"缩小到"最多 OCR_CHECKPOINT_EVERY_PAGES 页"。
      // 只在这一页确实产出了内容时才写，空白页/失败页没必要触发一次写入。
      if (onCheckpoint && blocksThisPage && shouldCheckpoint(pageNum, totalPages)) {
        try {
          await onCheckpoint(snapshot());
        } catch (err) {
          // 落盘失败不能反过来毁掉整次扫描 —— 告警后继续
          console.warn(`[ocrParsePdf] 第 ${pageNum} 页后落盘失败（继续识别）：`, err);
        }
      }
    } catch (err) {
      // 关键：单页失败不中断整个任务。
      // 记录页码与原因，继续下一页 —— 否则 833 页的书会因一页坏掉而前功尽弃。
      failures.push({ pageNum, message: describeUnknownError(err) });
      console.warn(`[ocrParsePdf] 第 ${pageNum}/${totalPages} 页失败：`, err);
      if (!OCR_CONTINUE_ON_PAGE_ERROR) throw err;
    } finally {
      // 无论成功失败都释放画布：50 MP 的画布约 200MB，泄漏几页就会耗尽内存
      if (pageCanvas) {
        pageCanvas.width = 0;
        pageCanvas.height = 0;
      }
    }
  }

  await doc.destroy();

  if (!allDrafts.length) {
    // 区分三种"什么都没识别出来"，因为处置办法完全不同
    const ocrRanButEmpty = emptyOcrPages.length;
    const blankCount = blankPages.filter((p) => !p.failed && p.darkRatio < 0.0005).length;
    const maxDarkRatio = blankPages.reduce((m, p) => Math.max(m, p.darkRatio), 0);
    const inkFailed = blankPages.filter((p) => p.failed).length;

    throw new Error(
      `OCR 未能从任何页面中提取出文字（共尝试 ${totalPages} 页）。\n\n` +
        (failures.length
          ? `· 出错 ${failures.length} 页，前几个：\n${failures
              .slice(0, 3)
              .map((f) => `    第 ${f.pageNum} 页：${f.message}`)
              .join('\n')}\n`
          : '') +
        (ocrRanButEmpty
          ? `· OCR 执行成功但未返回任何词：${ocrRanButEmpty} 页\n` +
            `  提取路径分布：${summarizeSources(emptyOcrPages)}\n` +
            `  纯文本长度合计：${emptyOcrPages.reduce((n, p) => n + p.textLength, 0)} 字符\n`
          : '') +
        (blankCount
          ? `· 判定为空白页并跳过：${blankCount} 页\n` +
            `  全页深色像素占比最大值：${(maxDarkRatio * 100).toFixed(4)}%\n` +
            (maxDarkRatio < 0.0001
              ? `  ⚠ 所有页面都几乎全白 —— 这通常**不是**文件空白，而是页面渲染失败。\n` +
                `    扫描版 PDF 依赖 pdf.js 的 WASM 解码器（JBIG2 / JPEG2000），\n` +
                `    请确认 public/pdfjs-wasm/ 下有 jbig2.wasm 与 openjpeg.wasm。\n`
              : '')
          : '') +
        (inkFailed ? `· 墨迹分析失败：${inkFailed} 页（已改为继续执行 OCR）\n` : '') +
        `\n若确认 PDF 内容清晰可读，可改用外部工具离线 OCR：` +
        `ocrmypdf -l chi_sim --force-ocr 输入.pdf 输出.pdf\n` +
        `控制台（F12）里有每一页的详细测量数据。`,
    );
  }

  // 复用循环前定下的 docId：中途检查点已经用这个 id 写过若干次，
  // 最后一次写入必须是**覆盖**它，否则书库里会留下一个半成品 + 一个完整版
  const resultDoc = buildDocument({
    docId,
    fileName,
    format: 'pdf',
    blocks: allDrafts,
    title: metaTitle || undefined,
    author: metaAuthor || undefined,
    sizeBytes: fileSize,
  });

  return { document: resultDoc, pagesProcessed, pagesSkipped, failures };
}

/** 把"提取路径"的分布汇总成一行，便于一眼判断是不是结构问题 */
function summarizeSources(pages: { source: string }[]): string {
  const counts = new Map<string, number>();
  for (const p of pages) counts.set(p.source, (counts.get(p.source) ?? 0) + 1);
  return [...counts.entries()].map(([k, v]) => `${k}×${v}`).join('、');
}

function isTextItem(item: unknown): item is PdfTextItem {
  return (
    !!item &&
    typeof item === 'object' &&
    typeof (item as PdfTextItem).str === 'string' &&
    Array.isArray((item as PdfTextItem).transform)
  );
}

/**
 * 把底层异常翻译成人能看懂的说明。
 *
 * 为什么需要它：pdf.js 抛出的原始信息形如 `a.toHex is not a function`，
 * 这是压缩后的变量名，用户看到只会一头雾水，也无法据此自救。
 * 已知的两种"缺失 API"故障在这里被点名，并给出可执行的处置办法。
 */
export function describeOpenFailure(err: unknown): string {
  const message = describeUnknownError(err);

  if (/toHex|fromHex|toBase64|fromBase64/.test(message)) {
    return (
      `PDF 打开失败：当前浏览器缺少 PDF 解析库所需的新版 API（Uint8Array 的十六进制转换）。\n\n` +
      `这通常出现在 Chrome / Edge 119 以下的浏览器。本应用内置了补齐实现，` +
      `若仍看到这条错误，请强制刷新页面（Ctrl+Shift+R）以清除旧版脚本缓存；` +
      `若无效请升级浏览器。\n\n原始错误：${message}`
    );
  }

  if (/withResolvers/.test(message)) {
    return (
      `PDF 打开失败：当前浏览器缺少 Promise.withResolvers（ES2024），` +
      `请升级到 Chrome / Edge 119 以上版本。\n\n原始错误：${message}`
    );
  }

  // 这条曾经真实出现过：试图让 pdf.js 跑在主线程（不设 workerSrc）时，
  // pdf.js 5 并不会自动退回主线程，而是直接抛这个错。
  // 记下来是为了避免后来者重复踩坑。
  if (/GlobalWorkerOptions\.workerSrc/.test(message)) {
    return (
      `PDF 打开失败：pdf.js 的 Worker 未配置。\n\n` +
      `这通常意味着运行时配置被改动过（见 src/parsers/pdfRuntime.ts）。` +
      `pdf.js 需要一个明确的 Worker 来源，不会自动退回主线程。\n\n原始错误：${message}`
    );
  }

  if (/password|encrypted/i.test(message)) {
    return `PDF 打开失败：文件已加密，需要密码。请先用其他工具解除加密后再导入。`;
  }

  return `PDF 打开失败，文件可能已损坏或不属于标准 PDF 格式。\n\n原始错误：${message}`;
}

/**
 * 让出一次事件循环，让浏览器有机会刷新界面。
 *
 * pdf.js 运行在主线程（原因见 pdfRuntime.ts），逐页解析会长时间占住主线程。
 * 每页解析后调用一次，可保证进度提示会更新、取消按钮能响应，页面不会完全冻死。
 * 优先用 scheduler.yield（若有），否则退回 setTimeout(0)。
 */
export function yieldToUI(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (scheduler?.yield) return scheduler.yield();
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** 把超长文本按句末标点切成不超过 maxLen 的片段 */
export function splitLongText(text: string, maxLen: number): string[] {
  const sentences = text.split(/(?<=[。！？!?.;；])/);
  const out: string[] = [];
  let buf = '';
  for (const s of sentences) {
    if ((buf + s).length > maxLen && buf) {
      out.push(buf.trim());
      buf = '';
    }
    if (s.length > maxLen) {
      for (let i = 0; i < s.length; i += maxLen) out.push(s.slice(i, i + maxLen).trim());
    } else {
      buf += s;
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter(Boolean);
}
