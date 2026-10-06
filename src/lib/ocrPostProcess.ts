/**
 * OCR 后处理：把 Tesseract 的 Word[] 转为 ContentBlock[]。
 *
 * 流程：
 * 1. 按 y 坐标聚类为行（容差 5px）；
 * 2. 按行间距离分割段落（自适应中位数阈值）；
 * 3. 字号启发式标题检测（大于中位数 1.3 倍且文本较短 → heading）。
 */
import type { ContentBlock } from '@/types/content';
import type { OcrWord, OcrPageResult } from '@/lib/ocrTypes';

interface OcrLine {
  words: OcrWord[];
  text: string;
  y: number;
  fontSize: number;
  avgConfidence: number;
}

const SAME_LINE_TOLERANCE = 5;
const PARAGRAPH_BREAK_RATIO = 1.35;
const HEADING_FONT_RATIO = 1.3;
const HEADING_MAX_CHARS = 80;
const HEADER_FOOTER_MARGIN_RATIO = 0.05;
const HEADER_FOOTER_FONT_RATIO = 0.85;

/**
 * 把 tesseract 的纯文本输出转成内容块。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么必须做这件事
 * ═══════════════════════════════════════════════════════════════
 *
 * 真实故障：10 页 OCR 跑完，报"未能从任何页面中提取出文字"，
 * 但诊断信息里赫然写着 **"纯文本长度合计：7058 字符"**。
 *
 * 也就是说：**tesseract 明明识别出了七千多字，我们却把它丢了** ——
 * 只因为拿不到词级坐标（`data.words` 与 `data.blocks` 都为空）。
 *
 * 这是最不该发生的一类缺陷：把"能用的结果"当成"没有结果"。
 * 坐标的价值是让段落切分更准、便于定位原页；拿不到坐标时，
 * 退化成按换行切分也远好于什么都不给。
 *
 * 因此这里做纯文本兜底：
 * - 空行分段（tesseract 用换行表达段落，用空行表达段间距）
 * - 单行且短、且不像正文的，按启发式判为标题（与纯文本解析器同一套思路）
 * - 合并过短的碎行，避免把一句话拆成多段
 */
export function ocrTextToBlocks(pageText: string): Omit<ContentBlock, 'id'>[] {
  const normalized = pageText.replace(/\r\n?/g, '\n').trim();
  if (!normalized) return [];

  // 先按空行分段；tesseract 对段落间距的表达在不同语言/版式下不一致，
  // 因此若空行分段结果只有一块，退化为按单行分段。
  let chunks = normalized
    .split(/\n\s*\n+/)
    .map((c) => c.replace(/\n/g, ' ').replace(/\s{2,}/g, ' ').trim())
    .filter(Boolean);

  if (chunks.length <= 1) {
    chunks = normalized
      .split('\n')
      .map((l) => l.replace(/\s{2,}/g, ' ').trim())
      .filter(Boolean);
  }

  const merged = mergeShortChunks(chunks);

  return merged.map((text) => ({
    type: looksLikeHeading(text) ? ('heading' as const) : ('paragraph' as const),
    content: text,
    translations: {},
    metadata: {},
  }));
}

/**
 * 合并过短的碎片。
 *
 * tesseract 在拿不到版式信息时，常把一个句子按视觉行拆成多段；
 * 过短的块会让阅读体验碎片化，也会让翻译按碎片送 API 导致语义断裂。
 *
 * 注意：**看起来像标题的块不参与合并**。
 * 标题天然很短（"第一章 计算机系统漫游" 只有 11 字），
 * 若不加这条判断，它会被当作"短碎片"并进正文，章节结构就此丢失
 * —— 这个问题是被单元测试抓出来的。
 */
function mergeShortChunks(chunks: string[], minLength = 20, maxMerged = 400): string[] {
  const out: string[] = [];

  for (const chunk of chunks) {
    const prev = out[out.length - 1];
    const shouldMerge =
      prev !== undefined &&
      !looksLikeHeading(prev) &&
      !looksLikeHeading(chunk) &&
      (prev.length < minLength || chunk.length < minLength) &&
      prev.length + chunk.length <= maxMerged &&
      // 上一块已经以句末标点收尾时不再合并，那更像是真的段落结束
      !/[。！？!?.;；:：]$/.test(prev);

    if (shouldMerge) {
      // 中文之间不加空格，英文之间加空格
      const joiner = /[\u4e00-\u9fff]$/.test(prev) ? '' : ' ';
      out[out.length - 1] = `${prev}${joiner}${chunk}`;
    } else {
      out.push(chunk);
    }
  }

  return out;
}

/** 标题启发式：短、单行、以编号或章节词开头 */
function looksLikeHeading(text: string): boolean {
  if (text.length > 40) return false;
  if (/[。！？!?]$/.test(text)) return false;

  return (
    /^#{1,6}\s/.test(text) ||
    /^(第[一二三四五六七八九十百千\d]+[章节回卷篇部]|Chapter\s+\d+|序章|后记|尾声)/i.test(text) ||
    /^\d+(\.\d+)*[\s、.]/.test(text) ||
    // 全大写英文短行（书名、章节名常见）
    (/^[A-Z][A-Z\s\d\-:]{3,}$/.test(text) && text.length <= 30)
  );
}

export function ocrResultToBlocks(
  result: OcrPageResult,
  pageHeight?: number,
): Omit<ContentBlock, 'id'>[] {
  // 关键兜底：拿不到词级坐标时，用纯文本也要产出内容。
  // 否则就会出现"识别出 7058 字却报告什么都没识别到"这种荒唐结果。
  if (!result.words.length) {
    const fallback = ocrTextToBlocks(result.pageText ?? '');
    if (fallback.length) {
      console.info(
        `[ocrPostProcess] 第 ${result.pageNum} 页无词级坐标，已按纯文本切分为 ${fallback.length} 块` +
          `（${result.pageText?.length ?? 0} 字符）`,
      );
    }
    return fallback;
  }

  const lines = groupWordsIntoLines(result.words);
  if (!lines.length) return ocrTextToBlocks(result.pageText ?? '');

  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    gaps.push(Math.abs((lines[i - 1]?.y ?? 0) - (lines[i]?.y ?? 0)));
  }
  const medianGap = median(gaps) || 0;
  const medianFontSize = median(lines.map((l) => l.fontSize)) || 12;

  // Filter out header/footer lines: in top/bottom margin with small font
  const filteredLines = filterHeaderFooter(lines, pageHeight, medianFontSize);

  const blocks: Omit<ContentBlock, 'id'>[] = [];
  let currentText = '';
  let currentConfSum = 0;
  let currentConfCount = 0;
  let currentFontSize = 0;
  let prevY: number | null = null;

  for (const line of filteredLines) {
    const gap = prevY === null ? 0 : Math.abs(prevY - line.y);
    const breakGap = medianGap > 0 ? medianGap * PARAGRAPH_BREAK_RATIO : line.fontSize * 1.35;
    const endsSentence = currentText && /[。！？!?.;；]$/.test(currentText);

    const isNewParagraph =
      !currentText ||
      gap > breakGap ||
      Math.abs(line.fontSize - currentFontSize) > 2 ||
      (endsSentence && gap > medianGap * 0.95);

    if (isNewParagraph) {
      if (currentText.trim()) {
        const avgConf = currentConfCount > 0 ? currentConfSum / currentConfCount : 0;
        const isHeading =
          currentFontSize > medianFontSize * HEADING_FONT_RATIO &&
          currentText.trim().length <= HEADING_MAX_CHARS;

        blocks.push({
          type: isHeading ? 'heading' : 'paragraph',
          content: currentText.trim(),
          translations: {},
          metadata: {
            pageNumber: result.pageNum,
            ocrConfidence: Math.round(avgConf),
            ...(isHeading ? { level: 2 } : {}),
          },
        });
      }
      currentText = line.text;
      currentConfSum = line.avgConfidence * line.words.length;
      currentConfCount = line.words.length;
      currentFontSize = line.fontSize;
    } else {
      const joiner = /[\u4e00-\u9fff]$/.test(currentText) ? '' : ' ';
      currentText = `${currentText}${joiner}${line.text}`;
      currentConfSum += line.avgConfidence * line.words.length;
      currentConfCount += line.words.length;
    }
    prevY = line.y;
  }

  if (currentText.trim()) {
    const avgConf = currentConfCount > 0 ? currentConfSum / currentConfCount : 0;
    const isHeading =
      currentFontSize > medianFontSize * HEADING_FONT_RATIO &&
      currentText.trim().length <= HEADING_MAX_CHARS;

    blocks.push({
      type: isHeading ? 'heading' : 'paragraph',
      content: currentText.trim(),
      translations: {},
      metadata: {
        pageNumber: result.pageNum,
        ocrConfidence: Math.round(avgConf),
        ...(isHeading ? { level: 2 } : {}),
      },
    });
  }

  return blocks;
}

/**
 * Filter out header/footer lines based on position and font size.
 *
 * Headers/footers typically sit in the top/bottom 5% of the page
 * and use smaller font than body text. Both conditions must be met
 * to avoid stripping legitimate short content near page edges.
 */
function filterHeaderFooter(
  lines: OcrLine[],
  pageHeight: number | undefined,
  medianFontSize: number,
): OcrLine[] {
  if (!pageHeight || pageHeight <= 0 || lines.length < 3) return lines;

  const topThreshold = pageHeight * HEADER_FOOTER_MARGIN_RATIO;
  const bottomThreshold = pageHeight * (1 - HEADER_FOOTER_MARGIN_RATIO);
  const smallFontThreshold = medianFontSize * HEADER_FOOTER_FONT_RATIO;

  return lines.filter((line) => {
    const inMargin = line.y < topThreshold || line.y > bottomThreshold;
    const smallFont = line.fontSize < smallFontThreshold;
    return !(inMargin && smallFont);
  });
}

function groupWordsIntoLines(words: OcrWord[]): OcrLine[] {
  const linesMap = new Map<number, OcrWord[]>();

  for (const word of words) {
    const y = (word.bbox.y0 + word.bbox.y1) / 2;
    let matchedKey: number | undefined;
    for (const key of linesMap.keys()) {
      if (Math.abs(key - y) <= SAME_LINE_TOLERANCE) {
        matchedKey = key;
        break;
      }
    }
    const key = matchedKey ?? y;
    const bucket = linesMap.get(key);
    if (bucket) bucket.push(word);
    else linesMap.set(key, [word]);
  }

  return [...linesMap.entries()]
    .map(([y, group]) => {
      const sorted = [...group].sort((a, b) => a.bbox.x0 - b.bbox.x0);
      const text = sorted.map((w) => w.text).join(' ').replace(/\s+/g, ' ').trim();
      const fontSize = group.reduce((sum, w) => sum + w.fontSize, 0) / group.length;
      const avgConfidence = group.reduce((sum, w) => sum + w.confidence, 0) / group.length;
      return { words: sorted, text, y, fontSize, avgConfidence };
    })
    .filter((l) => l.text.length > 0)
    .sort((a, b) => a.y - b.y);
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0);
}
