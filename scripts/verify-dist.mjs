/**
 * 构建产物校验。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么需要这个脚本
 * ═══════════════════════════════════════════════════════════════
 *
 * 本项目出过的几个最严重的问题，**源码、类型检查、单元测试全都是绿的**，
 * 只有产物本身能反映出来：
 *
 * | 曾经的问题 | 源码能否发现 | 产物能否发现 |
 * |---|---|---|
 * | pdfjs 被静态引入，首屏包 68KB → 201KB | ❌ 看不出来 | ✅ chunk 列表 |
 * | 缺 WASM 解码器，扫描版 PDF 渲染成白页 | ❌ 看不出来 | ✅ 文件是否存在 |
 * | sourcemap 让产物膨胀 3 倍并泄露源码 | ❌ 看不出来 | ✅ 文件统计 |
 *
 * 因此把这三条固化成构建后自动执行的门禁。任何一条不满足就**让构建失败** ——
 * 宁可本地构建失败，也不要发布一个坏产物。
 *
 * 由 package.json 的 postbuild 钩子调用，因此 `npm run build`
 * 在本地、CI、Cloudflare Pages 上走的是同一条路径，无需任何额外配置。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = process.cwd();
const dist = resolve(root, 'dist');
const assets = join(dist, 'assets');

/** 扫描版 PDF 必需的解码器；缺失会导致页面渲染成白页且不报错 */
const REQUIRED_WASM = ['jbig2.wasm', 'openjpeg.wasm'];

/** 单个 chunk 的体积上限（未压缩）。超过说明有依赖被静态引入了。 */
const MAX_CHUNK_BYTES = 4 * 1024 * 1024;

const problems = [];
const notes = [];

function check(condition, message) {
  if (condition) return true;
  problems.push(message);
  return false;
}

// ── 1. 基本产物 ──────────────────────────────────────────────
if (!check(existsSync(dist), 'dist/ 不存在 —— 构建似乎没有执行')) {
  report();
  process.exit(1);
}
check(existsSync(join(dist, 'index.html')), 'dist/index.html 缺失');
check(existsSync(assets), 'dist/assets 缺失');

// ── 2. WASM 解码器 ──────────────────────────────────────────
// 这是最容易漏的一项：它由 prebuild 钩子复制，若用 `vite build` 直接构建就不会执行，
// 而缺它的表现是"扫描版 PDF 全部渲染成白页"，完全不报错。
const wasmDir = join(dist, 'pdfjs-wasm');
if (check(existsSync(wasmDir), 'dist/pdfjs-wasm 缺失 —— prebuild 钩子可能没执行（请用 npm run build）')) {
  const files = readdirSync(wasmDir);
  for (const name of REQUIRED_WASM) {
    check(files.includes(name), `dist/pdfjs-wasm/${name} 缺失`);
  }
  notes.push(`WASM 解码器 ${files.length} 个，合计 ${mb(sum(files.map((f) => statSync(join(wasmDir, f)).size)))}`);
}

// ── 3. 不应存在 sourcemap ───────────────────────────────────
const allFiles = walk(dist);
const maps = allFiles.filter((f) => f.endsWith('.map'));
check(
  maps.length === 0,
  `产物里有 ${maps.length} 个 .map 文件（约 ${mb(sum(maps.map((f) => statSync(f).size)))}）` +
    ` —— 应关闭 build.sourcemap`,
);

// ── 4. 入口 chunk 不应混入 pdfjs ─────────────────────────────
// 判据来自实践：pdfjs 的产物里含有这两个标识符，而我们的业务代码没有。
const PDFJS_MARKERS = ['useWorkerFetch', 'GlobalWorkerOptions'];
const entries = readdirSync(assets).filter((f) => /^index-.*\.js$/.test(f));
check(entries.length > 0, '在 dist/assets 里找不到入口 chunk（index-*.js）');

for (const name of entries) {
  const text = readFileSync(join(assets, name), 'utf8');
  const hit = PDFJS_MARKERS.find((m) => text.includes(m));
  check(
    !hit,
    `入口 chunk ${name} 里出现了 pdfjs 标志（${hit}）—— pdfjs 被静态引入了，首屏体积会翻倍`,
  );
}

/** pdfjs 应当在自己的独立 chunk 里 */
const pdfChunk = readdirSync(assets).find((f) => /^pdfParser-.*\.js$/.test(f));
check(pdfChunk !== undefined, '找不到独立的 pdfParser chunk —— PDF 解析器可能没有走按需加载');

const workerChunk = readdirSync(assets).find((f) => /^pdfWorkerEntry-.*\.js$/.test(f));
check(workerChunk !== undefined, '找不到 pdfWorkerEntry chunk —— pdf.js 的 Worker 入口缺失');

// ── 5. 单个 chunk 体积 ──────────────────────────────────────
for (const name of readdirSync(assets)) {
  const size = statSync(join(assets, name)).size;
  if (size > MAX_CHUNK_BYTES && !/^pdfWorkerEntry-/.test(name)) {
    problems.push(`${name} 体积 ${mb(size)}，超过上限 ${mb(MAX_CHUNK_BYTES)}`);
  }
}

// ── 报告 ────────────────────────────────────────────────────
const totalBytes = sum(allFiles.map((f) => statSync(f).size));
notes.unshift(`产物共 ${allFiles.length} 个文件，${mb(totalBytes)}`);

report();

function report() {
  if (problems.length === 0) {
    console.log('[verify-dist] 构建产物校验通过');
    for (const note of notes) console.log(`  · ${note}`);
    return;
  }

  console.error('[verify-dist] 构建产物校验未通过：');
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error(
    '\n这些问题的共同点是：源码与单元测试都看不出异常，只有产物能反映。' +
      '修复后请重新执行 npm run build。',
  );
  process.exitCode = 1;
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function sum(values) {
  return values.reduce((a, b) => a + b, 0);
}

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
