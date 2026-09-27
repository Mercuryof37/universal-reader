/**
 * 真实 PDF 解析检查工具（Node 端诊断脚本）。
 *
 * 为什么需要它：
 * 单测里用的是合成 PDF，只能验证算法；真实书籍的排版怪癖（页眉页脚、
 * 断行方式、字号体系、跨页段落）无法靠合成样本覆盖。
 * 这个脚本用 pdf.js 的 legacy 构建在 Node 里跑完整解析链，
 * 输出可量化的质量指标，用来判断解析效果而不是靠肉眼翻几百页。
 *
 * 用法：
 *   node scripts/inspect-pdf.mjs "D:\path\to\book.pdf"
 *   node scripts/inspect-pdf.mjs book.pdf --pages 60      # 只解析前 60 页
 *   node scripts/inspect-pdf.mjs book.pdf --samples 8     # 多打印几段样张
 *
 * 注意：脚本刻意与 src/parsers/pdfParser.ts 使用同一套聚类规则
 * （行分组容差、段距中位数倍数、超长块切分阈值），
 * 因此这里的输出能代表应用内的真实表现。改动解析器时请同步这里的常量。
 */

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

// legacy 构建是 Node 下唯一可用的版本（标准构建依赖 DOMMatrix 等浏览器 API）
const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');

// ── 与应用保持一致的参数 ──
const SAME_LINE_TOLERANCE = 0.6;
const PARAGRAPH_BREAK_RATIO = 1.35;
const MAX_BLOCK_CHARS = 1200;
const HEADING_MIN_FONT_SIZE = 16;
const HEADING_MAX_CHARS = 80;

const args = process.argv.slice(2);
const filePath = args.find((a) => !a.startsWith('--'));
if (!filePath) {
  console.error('用法：node scripts/inspect-pdf.mjs <path-to.pdf> [--pages N] [--samples N]');
  process.exit(1);
}
const maxPages = numberArg('--pages', Infinity);
const sampleCount = numberArg('--samples', 4);

function numberArg(flag, fallback) {
  const i = args.indexOf(flag);
  if (i === -1) return fallback;
  const value = Number(args[i + 1]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const data = new Uint8Array(await readFile(filePath));
console.log(`文件：${basename(filePath)}（${(data.byteLength / 1024 / 1024).toFixed(1)} MB）`);

const t0 = Date.now();
const doc = await pdfjsLib.getDocument({ data, verbosity: 0 }).promise;
console.log(`打开成功：${doc.numPages} 页，耗时 ${Date.now() - t0} ms`);

const meta = await doc.getMetadata().catch(() => null);
if (meta?.info) {
  const { Title, Author, Producer } = meta.info;
  console.log(`元信息：Title=${JSON.stringify(Title ?? '')} Author=${JSON.stringify(Author ?? '')} Producer=${JSON.stringify(Producer ?? '')}`);
}

const stats = {
  pagesParsed: 0,
  pagesWithoutText: [],
  items: 0,
  lines: 0,
  paragraphs: 0,
  blocks: 0,
  chars: 0,
  headingCount: 0,
  singleLineParagraphs: 0,
  fontSizeHistogram: new Map(),
  tinyParagraphs: [],   // 只有 1-2 个字的段落：通常是页眉页脚或分栏碎片
  longBlocks: 0,
  samples: [],
};

const parseStart = Date.now();

for (let pageNum = 1; pageNum <= Math.min(doc.numPages, maxPages); pageNum++) {
  const page = await doc.getPage(pageNum);
  const content = await page.getTextContent();
  const items = content.items.filter(
    (i) => typeof i.str === 'string' && Array.isArray(i.transform),
  );

  stats.pagesParsed++;
  stats.items += items.length;

  if (!items.length) {
    stats.pagesWithoutText.push(pageNum);
    page.cleanup();
    continue;
  }

  const lines = groupIntoLines(items);
  stats.lines += lines.length;
  for (const line of lines) {
    const key = Math.round(line.fontSize);
    stats.fontSizeHistogram.set(key, (stats.fontSizeHistogram.get(key) ?? 0) + 1);
  }

  const paragraphs = clusterIntoParagraphs(lines);
  stats.paragraphs += paragraphs.length;

  for (const para of paragraphs) {
    if (para.lines === 1) stats.singleLineParagraphs++;
    const body = para.text.replace(/\s+/g, ' ').trim();
    if (!body) continue;

    const pieces = body.length > MAX_BLOCK_CHARS ? splitLongText(body, MAX_BLOCK_CHARS) : [body];
    if (pieces.length > 1) stats.longBlocks++;

    for (const piece of pieces) {
      stats.blocks++;
      stats.chars += piece.replace(/\s/g, '').length;

      const isHeading = para.fontSize >= HEADING_MIN_FONT_SIZE && piece.length <= HEADING_MAX_CHARS;
      if (isHeading) stats.headingCount++;

      // 极短的段落几乎必然是页眉/页脚/页码，量化它们的规模有助于判断是否需要过滤
      const meaningful = piece.replace(/[\s\d.·—\-|]/g, '');
      if (!isHeading && meaningful.length > 0 && meaningful.length <= 2) {
        stats.tinyParagraphs.push({ page: pageNum, text: piece.slice(0, 30) });
      }
    }
  }

  // 收集样张：优先取正文中段，避开目录页
  if (stats.samples.length < sampleCount && pageNum > doc.numPages * 0.3) {
    const longest = paragraphs
      .map((p) => p.text.replace(/\s+/g, ' ').trim())
      .filter((t) => t.length > 60)
      .sort((a, b) => b.length - a.length)[0];
    if (longest) stats.samples.push({ page: pageNum, text: longest.slice(0, 160) });
  }

  page.cleanup();
  if (pageNum % 50 === 0) {
    console.log(`  …已解析 ${pageNum} 页（${Date.now() - parseStart} ms）`);
  }
}

const elapsed = Date.now() - parseStart;
await doc.destroy();

// ── 报告 ──
const pagesParsed = stats.pagesParsed;
console.log('\n════════ 解析结果 ════════');
console.log(`解析页数        ${pagesParsed}（耗时 ${elapsed} ms，${(elapsed / pagesParsed).toFixed(0)} ms/页）`);
console.log(`文字片段        ${stats.items.toLocaleString()}`);
console.log(`识别出的行      ${stats.lines.toLocaleString()}`);
console.log(`识别出的段落    ${stats.paragraphs.toLocaleString()}`);
console.log(`最终内容块      ${stats.blocks.toLocaleString()}`);
console.log(`正文字符数      ${stats.chars.toLocaleString()}`);
console.log(`无文字层的页    ${stats.pagesWithoutText.length}${stats.pagesWithoutText.length ? `（前 20 页：${stats.pagesWithoutText.slice(0, 20).join(', ')}）` : ''}`);
console.log(`单行段落占比    ${((stats.singleLineParagraphs / Math.max(1, stats.paragraphs)) * 100).toFixed(1)}%`);
console.log(`超长块被切分    ${stats.longBlocks}`);
console.log(`疑似标题        ${stats.headingCount}`);

console.log('\n──────── 字号分布（出现最多的 8 种）────────');
const fontEntries = [...stats.fontSizeHistogram.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
for (const [size, count] of fontEntries) {
  const pct = ((count / Math.max(1, stats.lines)) * 100).toFixed(1);
  console.log(`  ${String(size).padStart(3)}pt  ${String(count).padStart(7)} 行  ${pct}%`);
}

if (stats.tinyParagraphs.length) {
  console.log(`\n──────── 疑似页眉/页脚碎片（共 ${stats.tinyParagraphs.length} 条，抽样 8 条）────────`);
  for (const t of stats.tinyParagraphs.slice(0, 8)) {
    console.log(`  p${t.page}: ${JSON.stringify(t.text)}`);
  }
}

console.log('\n──────── 正文样张 ────────');
for (const s of stats.samples) {
  console.log(`  [p${s.page}] ${s.text}`);
}

// ── 判定 ──
console.log('\n════════ 体检结论 ════════');
const checks = [];
if (stats.pagesWithoutText.length / Math.max(1, pagesParsed) > 0.2) {
  checks.push(`⚠ ${((stats.pagesWithoutText.length / pagesParsed) * 100).toFixed(0)}% 的页没有文字层，可能是扫描件混合文档`);
}
if (stats.singleLineParagraphs / Math.max(1, stats.paragraphs) > 0.5) {
  checks.push('⚠ 过半段落只有 1 行，断段可能过碎（检查段距阈值）');
}
if (stats.paragraphs / Math.max(1, pagesParsed) < 3) {
  checks.push('⚠ 平均每页段落少于 3 个，断段可能过粗（多段被合并）');
}
if (stats.tinyParagraphs.length / Math.max(1, stats.blocks) > 0.15) {
  checks.push('⚠ 页眉/页脚碎片占比偏高，建议加 y 位置阈值过滤');
}
if (stats.blocks === 0) {
  checks.push('✗ 没有解析出任何内容块');
}
if (!checks.length) {
  checks.push('✓ 各项指标正常');
}
for (const c of checks) console.log('  ' + c);

// ── 与应用一致的纯函数实现（保持同步）──────────

function groupIntoLines(items) {
  const linesMap = new Map();
  for (const item of items) {
    const y = item.transform[5] ?? 0;
    let matchedKey;
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
      const sorted = [...group].sort((a, b) => (a.transform[4] ?? 0) - (b.transform[4] ?? 0));
      const text = sorted.map((i) => i.str).join('').replace(/\s+/g, ' ').trim();
      const fontSize = Math.max(...sorted.map((i) => i.height || 0), 0);
      return { y, text, fontSize };
    })
    .filter((l) => l.text.length > 0)
    .sort((a, b) => b.y - a.y);
}

function clusterIntoParagraphs(lines) {
  if (!lines.length) return [];

  const gaps = [];
  for (let i = 1; i < lines.length; i++) {
    gaps.push(Math.abs((lines[i - 1]?.y ?? 0) - (lines[i]?.y ?? 0)));
  }
  const medianGap = median(gaps) || 0;

  const paragraphs = [];
  let current = null;
  let prevY = null;

  for (const line of lines) {
    const gap = prevY === null ? 0 : Math.abs(prevY - line.y);
    const breakGap = medianGap > 0 ? medianGap * PARAGRAPH_BREAK_RATIO : line.fontSize * 1.35;
    const endsSentence = current !== null && /[。！？!?.;；]$/.test(current.text);

    const isNew =
      current === null ||
      gap > breakGap ||
      Math.abs(line.fontSize - current.fontSize) > 1.5 ||
      (endsSentence && gap > medianGap * 0.95);

    if (isNew || current === null) {
      if (current) paragraphs.push(current);
      current = { text: line.text, y: line.y, fontSize: line.fontSize, lines: 1 };
    } else {
      const joiner = /[\u4e00-\u9fff]$/.test(current.text) ? '' : ' ';
      current.text = `${current.text}${joiner}${line.text}`;
      current.lines += 1;
    }
    prevY = line.y;
  }
  if (current) paragraphs.push(current);
  return paragraphs;
}

function splitLongText(text, maxLen) {
  const sentences = text.split(/(?<=[。！？!?.;；])/);
  const out = [];
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

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : sorted[mid];
}
