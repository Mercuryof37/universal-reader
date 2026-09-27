/**
 * PDF 页面结构深度诊断（Node 端）。
 *
 * 当 getTextContent() 返回空时，原因可能有多种，处理方式完全不同：
 *   a) 纯图片型（扫描件）—— 只能靠 OCR，程序层面无解；
 *   b) 有内容流但用 Type3/自定义编码 —— 需要换解析策略（如按 ToUnicode 映射）；
 *   c) 文本被放在 Form XObject 里且未被展开 —— pdf.js 一般能处理，但需确认；
 *   d) 文本以矢量轮廓（路径）绘制 —— 同样只能 OCR。
 *
 * 这个脚本逐项排查上述可能，给出确定结论而不是猜测。
 *
 * 用法：node scripts/diagnose-pdf.mjs <path-to.pdf> [--pages N]
 */

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');

const args = process.argv.slice(2);
const filePath = args.find((a) => !a.startsWith('--'));
if (!filePath) {
  console.error('用法：node scripts/diagnose-pdf.mjs <path-to.pdf> [--pages N]');
  process.exit(1);
}
const pagesIndex = args.indexOf('--pages');
const maxPages = pagesIndex === -1 ? 5 : Number(args[pagesIndex + 1]) || 5;

const data = new Uint8Array(await readFile(filePath));
console.log(`文件：${basename(filePath)}（${(data.byteLength / 1024 / 1024).toFixed(1)} MB）\n`);

const doc = await pdfjsLib.getDocument({ data, verbosity: 0 }).promise;
console.log(`总页数：${doc.numPages}\n`);

for (let pageNum = 1; pageNum <= Math.min(doc.numPages, maxPages); pageNum++) {
  const page = await doc.getPage(pageNum);
  console.log(`── 第 ${pageNum} 页 ──`);

  // 1. 文本内容
  const content = await page.getTextContent();
  const items = content.items.filter((i) => typeof i.str === 'string');
  const nonEmpty = items.filter((i) => i.str.trim().length > 0);
  console.log(`  文本片段：${items.length}（非空白 ${nonEmpty.length}）`);
  if (nonEmpty.length) {
    console.log(`  样例：${nonEmpty.slice(0, 5).map((i) => JSON.stringify(i.str.slice(0, 40))).join(', ')}`);
  }

  // 2. 操作符列表：看看内容流里到底有什么
  //
  // 关键：必须传 intent: 'display'。
  // 默认的 'print' intent 不会展开 Form XObject 内部的指令，
  // 而扫描件恰恰是把图片放在 Form XObject 里再用 /Im0 Do 绘制的 ——
  // 用默认参数会得出"页面里什么都没有"的错误结论（这个坑我踩过）。
  const ops = await page.getOperatorList({ intent: 'display' });
  const opCounts = new Map();
  for (const fn of ops.fnArray) {
    opCounts.set(fn, (opCounts.get(fn) ?? 0) + 1);
  }
  const OPS = pdfjsLib.OPS;
  const opNames = [...opCounts.entries()]
    .map(([fn, count]) => ({ name: nameOfOp(fn, OPS), count }))
    .sort((a, b) => b.count - a.count);
  console.log(`  操作符：${ops.fnArray.length} 个，种类 ${opCounts.size}`);
  console.log(`  最常见：${opNames.slice(0, 8).map((o) => `${o.name}×${o.count}`).join(', ')}`);

  // 3. 关键操作符统计 —— 这些决定了"还有没有救"
  const showText = countOp(OPS.showText) + countOp(OPS.showSpacedText) + countOp(OPS.nextLineShowText);
  const images = countOp(OPS.paintImageXObject) + countOp(OPS.paintInlineImageXObject) + countOp(OPS.paintImageMaskXObject);
  const paths = countOp(OPS.constructPath);
  console.log(`  ├ 文字指令（showText 类）：${showText}  ← 大于 0 才可能有文字层`);
  console.log(`  ├ 绘制图像（paintImage*）：${images}  ← 大于 0 说明是图片型页面`);
  console.log(`  └ 矢量路径（constructPath）：${paths}  ← 文字转曲也会走这里`);

  // 4. 字体资源：有字体通常意味着有可提取的文本
  const fonts = [];
  for (const [key, value] of Object.entries(ops.dependencies ?? {})) {
    if (String(key).startsWith('font_')) fonts.push({ key, value });
  }
  console.log(`  字体依赖：${fonts.length}`);
  if (fonts.length) {
    for (const f of fonts.slice(0, 5)) {
      const loaded = f.value && typeof f.value === 'object' ? f.value : null;
      const name = loaded?.name ?? '(未加载)';
      const type = loaded?.type ?? '?';
      console.log(`    · ${String(f.key).slice(0, 40)} → ${name} / ${type}`);
    }
  }

  // 5. 页面标注：有些文档把文字放在 annotation 里
  const annots = await page.getAnnotations().catch(() => []);
  const textAnnots = annots.filter((a) => a.subtype === 'Text' || a.subtype === 'FreeText');
  console.log(`  标注总数：${annots.length}（其中文本类 ${textAnnots.length}）`);

  page.cleanup();
  console.log('');

  function countOp(op) {
    return opCounts.get(op) ?? 0;
  }
}

function nameOfOp(fn, OPS) {
  for (const [name, code] of Object.entries(OPS)) {
    if (code === fn) return name;
  }
  return `op_${fn}`;
}

// 6. 抽查更靠后的页面，避免只是前几页是封面/目录
console.log('── 抽查靠后页面 ──');
for (const pageNum of [Math.floor(doc.numPages / 2), doc.numPages - 5].filter(
  (n) => n > maxPages && n > 0,
)) {
  const page = await doc.getPage(pageNum);
  const content = await page.getTextContent();
  const nonEmpty = content.items.filter((i) => typeof i.str === 'string' && i.str.trim().length > 0);
  const ops = await page.getOperatorList({ intent: 'display' });
  const countOf = (op) => ops.fnArray.filter((f) => f === op).length;
  const showTextOps =
    countOf(pdfjsLib.OPS.showText) +
    countOf(pdfjsLib.OPS.showSpacedText) +
    countOf(pdfjsLib.OPS.nextLineShowText);
  const imageOps =
    countOf(pdfjsLib.OPS.paintImageXObject) +
    countOf(pdfjsLib.OPS.paintInlineImageXObject) +
    countOf(pdfjsLib.OPS.paintImageMaskXObject);
  console.log(
    `  第 ${pageNum} 页：文本片段 ${nonEmpty.length}，文字指令 ${showTextOps}，` +
      `图像指令 ${imageOps}，操作符总数 ${ops.fnArray.length}`,
  );
  page.cleanup();
}

await doc.destroy();
console.log('\n结论：');
console.log('  · 若 showText 类操作为 0 且 paintImage 很多 → 图片型 PDF，必须 OCR');
console.log('  · 若 showText 很多但文本片段为 0 → 字体编码问题，可尝试其他解析库');
console.log('  · 若 constructPath 极多且无 showText → 文字已转曲，只能 OCR');
