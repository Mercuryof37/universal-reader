/**
 * PDF 原始对象结构分析（不依赖任何 PDF 库）。
 *
 * 用途：当 pdf.js 报告"页面里什么都没有"时，需要判断究竟是
 *   a) 文件本身内容就是空的（例如只保留了页面骨架的"壳文件"）；
 *   b) 内容被对象流（Object Stream）压缩，解析器没有展开；
 *   c) 内容在 Form XObject / 附件里，需要额外寻址。
 *
 * 做法是直接扫描字节流统计对象类型。这对损坏或非标准 PDF 同样有效，
 * 因为它不依赖解析器能否正确理解结构。
 *
 * 用法：node scripts/analyze-pdf-objects.mjs <path-to.pdf>
 */

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { inflateSync, inflateRawSync } from 'node:zlib';

const filePath = process.argv[2];
if (!filePath) {
  console.error('用法：node scripts/analyze-pdf-objects.mjs <path-to.pdf>');
  process.exit(1);
}

const buf = await readFile(filePath);
console.log(`文件：${basename(filePath)}（${(buf.length / 1024 / 1024).toFixed(1)} MB）\n`);

// 以 latin1 读取：PDF 的语法层是字节导向的，用 UTF-8 会破坏偏移计算
const latin = buf.toString('latin1');

// ── 1. 对象类型统计（直接数 /Type /Xxx 出现次数）──────
const typeNames = [
  'Catalog', 'Pages', 'Page', 'Font', 'FontDescriptor', 'FontFile', 'FontFile2', 'FontFile3',
  'Type0', 'Type1', 'TrueType', 'Type3', 'CIDFontType0', 'CIDFontType2',
  'XObject', 'Image', 'Form', 'ObjStm', 'XRef', 'Metadata', 'Outlines', 'Annot',
  'ToUnicode', 'Encoding', 'Contents', 'ExtGState', 'ColorSpace', 'Pattern',
];

console.log('════ 对象类型统计 ════');
const counts = {};
for (const name of typeNames) {
  const re = new RegExp(`/Type\\s*/${name}\\b`, 'g');
  counts[name] = (latin.match(re) ?? []).length;
}
for (const [name, count] of Object.entries(counts)) {
  if (count > 0) console.log(`  /Type /${name}${' '.repeat(Math.max(1, 22 - name.length))}${count}`);
}

// 子类型（字体、XObject 的关键信息在这里）
console.log('\n════ 关键子类型 ════');
for (const name of ['Image', 'Form', 'Type0', 'Type1', 'TrueType', 'Type3', 'CIDFontType0', 'CIDFontType2']) {
  const re = new RegExp(`/Subtype\\s*/${name}\\b`, 'g');
  const count = (latin.match(re) ?? []).length;
  if (count > 0) console.log(`  /Subtype /${name}${' '.repeat(Math.max(1, 22 - name.length))}${count}`);
}

// ── 2. 过滤器统计：判断内容是否被压缩 ────────
console.log('\n════ 流过滤器 ════');
for (const filter of ['FlateDecode', 'DCTDecode', 'JPXDecode', 'CCITTFaxDecode', 'JBIG2Decode', 'LZWDecode', 'ASCIIHexDecode', 'RunLengthDecode']) {
  const count = (latin.match(new RegExp(`/${filter}\\b`, 'g')) ?? []).length;
  if (count > 0) console.log(`  /${filter}${' '.repeat(Math.max(1, 20 - filter.length))}${count}`);
}

// ── 3. 统计 stream 与 /Length ────────
const streamCount = (latin.match(/\bstream\r?\n/g) ?? []).length;
console.log(`\n════ 流对象 ════`);
console.log(`  stream 关键字出现次数：${streamCount}`);

const lengths = [...latin.matchAll(/\/Length\s+(\d+)/g)].map((m) => Number(m[1]));
if (lengths.length) {
  const sorted = [...lengths].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  console.log(`  /Length 声明数：${lengths.length}`);
  console.log(`  总声明长度：${(sum / 1024 / 1024).toFixed(2)} MB`);
  console.log(`  中位数：${sorted[Math.floor(sorted.length / 2)]} 字节`);
  console.log(`  最大：${sorted[sorted.length - 1]} 字节`);
  console.log(`  为 0 的：${sorted.filter((n) => n === 0).length}`);
}

// ── 4. 解压若干内容流，看看里面到底有什么 ────────
console.log('\n════ 内容流抽样（解压后前 300 字节）════');
let sampled = 0;
let opStats = { showText: 0, paintImage: 0, constructPath: 0, totalStreams: 0, emptyStreams: 0 };

const streamRe = /stream\r?\n/g;
let m;
while ((m = streamRe.exec(latin)) !== null && sampled < 6) {
  const start = m.index + m[0].length;
  // 找到该流对应的 /Length（向前找最近的）
  const headerStart = Math.max(0, latin.lastIndexOf('<<', m.index));
  const header = latin.slice(headerStart, m.index);
  const lengthMatch = /\/Length\s+(\d+)/.exec(header);
  if (!lengthMatch) continue;

  const declared = Number(lengthMatch[1]);
  if (declared <= 0) {
    opStats.emptyStreams++;
    continue;
  }

  const raw = buf.subarray(start, Math.min(start + declared, buf.length));
  opStats.totalStreams++;

  const isFlate = /\/FlateDecode/.test(header);
  let text = '';
  if (isFlate) {
    text = tryInflate(raw);
  } else {
    text = raw.toString('latin1');
  }

  if (!text) continue;

  // 统计常见的绘制操作符
  opStats.showText += (text.match(/\b(Tj|TJ|'|")\s/g) ?? []).length;
  opStats.constructPath += (text.match(/\b(re|m|l|c|v|y)\s/g) ?? []).length;

  if (text.trim().length === 0) {
    opStats.emptyStreams++;
    continue;
  }

  sampled++;
  const preview = text.replace(/\s+/g, ' ').slice(0, 300);
  console.log(`  [流 ${sampled}] 长度 ${declared} → 解压后 ${text.length} 字节`);
  console.log(`    ${preview}`);
}

console.log(`\n  抽样流总数：${opStats.totalStreams}，其中空流：${opStats.emptyStreams}`);
console.log(`  文字操作符（Tj/TJ）：${opStats.showText}`);
console.log(`  路径操作符（re/m/l/c）：${opStats.constructPath}`);

// ── 5. 附加文件与元数据线索 ────────
console.log('\n════ 其他线索 ════');
for (const key of ['EmbeddedFile', 'Filespec', 'Collection', 'AcroForm', 'Encrypt', 'ObjStm', 'XRefStm', 'Linearized']) {
  const count = (latin.match(new RegExp(`/${key}\\b`, 'g')) ?? []).length;
  if (count > 0) console.log(`  /${key}${' '.repeat(Math.max(1, 18 - key.length))}${count}`);
}

// 文件尾部结构
const tail = latin.slice(-2048).replace(/[^\x20-\x7e\n]/g, '.');
console.log('\n════ 文件尾部 200 字节 ════');
console.log('  ' + tail.slice(-200).replace(/\n/g, '\n  '));

// ── 结论 ────────
console.log('\n════ 判定 ════');
if (counts.Image > 0 || counts.Form > 0) {
  console.log('  · 文件内存在 Image/Form 对象，但页面操作符里没有绘制指令');
  console.log('    → 内容可能被放在未被页面引用的对象里（结构损坏或被裁剪）');
} else if (counts.Font > 0 || counts.FontFile2 > 0 || counts.FontFile3 > 0) {
  console.log('  · 存在字体对象但页面无文字指令 → 文字层被移除，只剩字体残留');
} else {
  console.log('  · 文件中既没有图片也没有字体对象');
  console.log('    → 这个 PDF 的页面内容本身就是空的（可能是"壳文件"或仅含页面框架）');
}

function tryInflate(raw) {
  for (const fn of [inflateSync, inflateRawSync]) {
    try {
      return fn(raw).toString('latin1');
    } catch {
      // 换下一种解压方式
    }
  }
  return '';
}
