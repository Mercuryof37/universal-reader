/**
 * 从 tesseract.js 的识别结果里提取词。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么需要单独一个模块
 * ═══════════════════════════════════════════════════════════════
 *
 * 真实故障：整本扫描书的 OCR 跑完，界面上报"未能从任何页面中识别出文字
 * （共尝试 30 页，其中 0 页出错）"。
 *
 * 根因是 **tesseract.js v7 改了输出结构**：
 *
 * | 版本 | 词的位置 |
 * |---|---|
 * | v5 及以前 | `data.words[]` —— 平铺在顶层 |
 * | **v7** | `data.blocks[].paragraphs[].lines[].words[]` —— **只在最深处** |
 *
 * 旧代码读的是 `data.words`，在 v7 上永远是 `undefined`，
 * 于是每页都被当成"没识别出文字"。**而且不报错** —— 因为上层把
 * "识别出 0 个词" 与 "空白页" 归为同一种情况，静默跳过。
 *
 * 本模块的做法是**同时兼容两种结构**：
 * - 优先读平铺的 `words`（可用 `output: { blocks: false }` 拿回这种形状）；
 * - 否则深度遍历 blocks → paragraphs → lines → words。
 *
 * 返回值里带 `diagnostics`，让调用方能区分"真的一无所获"与"结构没匹配上"——
 * 这正是本次故障被掩盖了整整一轮的原因。
 */

/** tesseract 的 Bbox */
interface Bbox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** 提取出的词（本项目的内部形状） */
export interface ExtractedWord {
  text: string;
  confidence: number;
  bbox: Bbox;
  /** 字高（像素），供段落聚类判断行距与字号突变 */
  fontSize: number;
}

export interface WordExtractionResult {
  words: ExtractedWord[];
  /** 整页纯文本，tesseract 无论哪种结构都会提供；用于兜底与诊断 */
  pageText: string;
  diagnostics: {
    /** 采用的路径 */
    source: 'flat-words' | 'nested-blocks' | 'page-text-only' | 'empty';
    /** 平铺 words 是否存在且为数组 */
    hasFlatWords: boolean;
    /** blocks 是否为非空数组 */
    hasBlocks: boolean;
    /** 遍历到的块 / 段 / 行 / 词数量，便于判断结构是否符合预期 */
    blocks: number;
    paragraphs: number;
    lines: number;
    /** 被过滤掉的空白词数 */
    skippedBlank: number;
  };
}

/**
 * 从 tesseract 的识别结果里提取词。
 *
 * 输入类型刻意放宽为 `unknown`：tesseract 的类型定义在各版本间差异很大，
 * 而我们要处理的恰恰是"类型说没有、运行时也真没有"的情况。
 */
export function extractWords(data: unknown): WordExtractionResult {
  const diagnostics: WordExtractionResult['diagnostics'] = {
    source: 'empty',
    hasFlatWords: false,
    hasBlocks: false,
    blocks: 0,
    paragraphs: 0,
    lines: 0,
    skippedBlank: 0,
  };

  const root = (data ?? {}) as Record<string, unknown>;
  const pageText = typeof root['text'] === 'string' ? (root['text'] as string) : '';

  let skippedBlank = 0;
  const push = (raw: unknown, out: ExtractedWord[]): void => {
    const word = toWord(raw, () => skippedBlank++);
    if (word) out.push(word);
  };

  // ── 路径 1：平铺的 words（v5 及更早，或显式关闭 blocks 输出时的形状）──
  const flat = root['words'];
  if (Array.isArray(flat)) {
    diagnostics.hasFlatWords = true;
    const out: ExtractedWord[] = [];
    for (const raw of flat) push(raw, out);
    if (out.length) {
      diagnostics.source = 'flat-words';
      diagnostics.skippedBlank = skippedBlank;
      return { words: out, pageText, diagnostics };
    }
  }

  // ── 路径 2：嵌套结构 blocks → paragraphs → lines → words（v7 的默认形状）──
  const blocks = root['blocks'];
  if (Array.isArray(blocks)) {
    diagnostics.hasBlocks = true;
    const out: ExtractedWord[] = [];

    for (const block of blocks) {
      if (!isRecord(block)) continue;
      diagnostics.blocks++;

      const paragraphs = block['paragraphs'];
      if (!Array.isArray(paragraphs)) continue;

      for (const paragraph of paragraphs) {
        if (!isRecord(paragraph)) continue;
        diagnostics.paragraphs++;

        const lines = paragraph['lines'];
        if (!Array.isArray(lines)) continue;

        for (const line of lines) {
          if (!isRecord(line)) continue;
          diagnostics.lines++;

          const lineWords = line['words'];
          if (Array.isArray(lineWords)) {
            for (const raw of lineWords) push(raw, out);
          }
        }
      }
    }

    if (out.length) {
      diagnostics.source = 'nested-blocks';
      diagnostics.skippedBlank = skippedBlank;
      return { words: out, pageText, diagnostics };
    }
  }

  // ── 路径 3：没有词，但有纯文本 ──
  // 用在"识别出了文字但我们取不到坐标"的场景：至少不该报"什么都识别不到"。
  // 调用方会依据 diagnostics.source 决定如何提示。
  diagnostics.skippedBlank = skippedBlank;
  if (pageText.trim()) {
    diagnostics.source = 'page-text-only';
  }

  return { words: [], pageText, diagnostics };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toWord(raw: unknown, onBlank: () => void): ExtractedWord | null {
  if (!isRecord(raw)) return null;

  const text = typeof raw['text'] === 'string' ? (raw['text'] as string).trim() : '';
  if (!text) {
    onBlank();
    return null;
  }

  const bbox = raw['bbox'];
  const safeBbox: Bbox = isRecord(bbox)
    ? {
        x0: numberOr(bbox['x0'], 0),
        y0: numberOr(bbox['y0'], 0),
        x1: numberOr(bbox['x1'], 0),
        y1: numberOr(bbox['y1'], 0),
      }
    : { x0: 0, y0: 0, x1: 0, y1: 0 };

  return {
    text,
    confidence: numberOr(raw['confidence'], 0),
    bbox: safeBbox,
    // 字高：bbox 的两个 y 边界之差。缺失时为 0，上游的段落聚类会退化为平均值
    fontSize: Math.abs(safeBbox.y1 - safeBbox.y0),
  };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
