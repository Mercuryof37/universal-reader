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

// ── 2b. OCR 模型（自托管，与站点同源）────────────────────────
// 同样由 prebuild 钩子取来放进 public/。**必须在这里硬校验**：
// 缺了它的表现是「扫描版 PDF 的 OCR 一直初始化失败」，而不是构建报错 ——
// 也就是说，没有这道检查就会部署出一个「能打开、但 OCR 用不了」的站点，
// 而且没人会发现。这正是修复这次故障时要杜绝的失败模式。
const ocrModelDir = join(dist, 'ocr-models');
const REQUIRED_OCR_MODELS = [
  'detection/ort/PP-OCRv6_small_det.ort',
  'recognition/ort/PP-OCRv6_small_rec.ort',
  'recognition/ppocrv6_dict.txt',
  // 版面分析模型（见 src/lib/layoutAnalysis.ts）。
  // ⚠️ 它同样必须**硬失败**：缺了它的表现是「版面分析静默退回几何启发式」——
  // 而几何启发式正是本次要替换掉的东西。也就是说缺了它站点看起来
  // 完全正常，只是页眉页脚又会被当成正文、公式又会被当成大标题。
  // 没有任何人会发现问题，所以必须在这里拦住。
  'layout/PP-DocLayout-S.onnx',
];

/**
 * Cloudflare Pages 单个静态资源上限：**25 MiB**。
 *
 * 官方文档（https://developers.cloudflare.com/pages/platform/limits/ ）原文：
 *   "The maximum file size for a single Cloudflare Pages site asset is 25 MiB."
 *
 * 为什么要把这条固化成构建门禁：超限的**唯一**表现是部署时报错，
 * 而本地 `npm run build`、类型检查、单元测试**全都是绿的** ——
 * 这个问题只会在真正部署时才暴露。这正是本脚本开头那张表里
 * 同一类失败模式（源码看不出、产物才看得出）。
 *
 * 这条门禁的直接由来：初版方案打算用 PP-DocLayoutV2/V3 做版面分析，
 * 实测它们分别是 203.42 MiB / 123.90 MiB —— 超限 5–8 倍。
 * 没有这条检查的话，要等到部署那一步才会发现整个方案发布不上去。
 */
const MAX_ASSET_BYTES = 25 * 1024 * 1024;

if (
  check(
    existsSync(ocrModelDir),
    'dist/ocr-models 缺失 —— 请用 npm run build（prebuild 会执行 fetch-ocr-models.mjs）',
  )
) {
  let modelBytes = 0;
  for (const rel of REQUIRED_OCR_MODELS) {
    const full = join(ocrModelDir, rel);
    if (check(existsSync(full), `dist/ocr-models/${rel} 缺失 —— OCR 将无法初始化`)) {
      const size = statSync(full).size;
      modelBytes += size;
      // 空文件或截断的下载也要拦住：那种情况浏览器会报 Failed to fetch 或解析失败
      check(size > 1024, `dist/ocr-models/${rel} 只有 ${size} 字节，像是下载失败`);
      check(
        size <= MAX_ASSET_BYTES,
        `dist/ocr-models/${rel} 有 ${mb(size)}，超过 Cloudflare Pages 的单文件上限 ` +
          `${mb(MAX_ASSET_BYTES)} —— 这个产物**部署不上去**（本地构建与测试都不会报错）`,
      );
    }
  }
  if (modelBytes > 0) {
    notes.push(`OCR 模型 ${REQUIRED_OCR_MODELS.length} 个，合计 ${mb(modelBytes)}（同源发布）`);
  }
}

// ── 2c. **全部**产物都不能超过 Pages 的单文件上限 ─────────────
// 不只是模型：任何一个静态资源超限都会让**整个站点**部署失败，
// 而它同样不会在本地构建或单元测试里暴露出来。
for (const file of walk(dist)) {
  const size = statSync(file).size;
  check(
    size <= MAX_ASSET_BYTES,
    `${file.slice(dist.length + 1)} 有 ${mb(size)}，超过 Cloudflare Pages 的单文件上限 ` +
      `${mb(MAX_ASSET_BYTES)}`,
  );
}

// ── 2d. tesseract 第二意见资产（自托管，懒加载）──────────────
// 由 prebuild 的 fetch-tess-assets.mjs 落盘。**必须硬校验**，理由与 OCR 模型
// 完全一样：缺了它站点照常能打开、识别也照常出结果，只是「角标救回」
// 静默失效 —— 而那正是这一版要交付的功能。
//
// ⚠️ core 的三个 `-lstm` 变体**逐个都要查**：浏览器按
// `wasm-feature-detect` 的结果三选一（relaxedsimd → simd → 标量），
// 少哪一个，就是**那一类浏览器**上第二意见整个不可用。
const tessAssets = [
  ['tess/worker.min.js', 'worker 脚本（importScripts 的入口）'],
  ['tessdata/eng.traineddata.gz', '英文语言数据（只做几何复核，eng 够用）'],
  ['tess-core/tesseract-core-lstm.wasm.js', 'core 标量变体'],
  ['tess-core/tesseract-core-simd-lstm.wasm.js', 'core SIMD 变体'],
  ['tess-core/tesseract-core-relaxedsimd-lstm.wasm.js', 'core RelaxedSIMD 变体'],
];

{
  let tessBytes = 0;
  let missing = 0;
  for (const [rel, what] of tessAssets) {
    const full = join(dist, rel);
    if (!check(existsSync(full), `dist/${rel} 缺失（${what}）—— 请用 npm run build`)) {
      missing++;
      continue;
    }
    const size = statSync(full).size;
    tessBytes += size;
    check(size > 1024, `dist/${rel} 只有 ${size} 字节，像是下载/复制失败`);
  }
  if (!missing) {
    notes.push(`tesseract 第二意见资产 ${tessAssets.length} 个，合计 ${mb(tessBytes)}（同源发布）`);
  }
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

// ── 5. PWA 产物 ─────────────────────────────────────────────
// 离线能力同样是"产物对了才算对"：Service Worker 缺失时应用照常能跑，
// 只是断网后打不开 —— 而这一点在开发机上几乎永远不会被发现。
const swPath = join(dist, 'sw.js');
if (check(existsSync(swPath), 'dist/sw.js 缺失 —— PWA 插件未生效，离线功能不可用')) {
  const sw = readFileSync(swPath, 'utf8');

  // 导航回退是"断网后还能打开网站"的关键：没有它，离线访问首页会 404
  check(
    sw.includes('createHandlerBoundToURL("/index.html")') || sw.includes('index.html'),
    'sw.js 里没有 index.html 的导航回退 —— 离线时打不开网站',
  );

  // 入口 chunk 必须在预缓存清单里，否则离线时页面骨架不完整
  const entryInPrecache = entries.some((f) => sw.includes(f));
  check(entryInPrecache, 'sw.js 的预缓存清单里没有入口 chunk —— 离线时页面无法启动');

  // 应用壳之外，图标与 manifest 也应预缓存（否则"添加到主屏幕"后图标缺失）
  check(existsSync(join(dist, 'manifest.webmanifest')), 'dist/manifest.webmanifest 缺失');
  check(existsSync(join(dist, 'icons', 'icon-192.png')), 'dist/icons/icon-192.png 缺失');
  check(existsSync(join(dist, 'icons', 'icon-512.png')), 'dist/icons/icon-512.png 缺失');
  check(
    existsSync(join(dist, 'icons', 'icon-maskable-512.png')),
    'dist/icons/icon-maskable-512.png 缺失 —— Android 上图标会被裁切',
  );

  // 不该预缓存用不到的解码器：它们合计约 1MB，会让首访安装体积白白翻倍
  check(
    !sw.includes('quickjs-eval') && !sw.includes('nowasm_fallback'),
    'sw.js 预缓存了本项目不会请求的解码器（quickjs-eval / *_nowasm_fallback），白占约 1MB',
  );

  // tesseract 第二意见资产同理**必须留在预缓存之外**（走运行时 CacheFirst）。
  // 这里曾真实漏过一次：默认 globPatterns 的 `**/*.js` 把 worker 与三个 core
  // 变体（≈11.8MB）全卷进了预缓存清单 —— 而三个 core 变体浏览器只会用到
  // 其中一个，首访白下 11.8MB。这条检查的字面量选得很讲究：
  //   · `tess-core/tesseract-core-` —— 只出现在预缓存清单的 URL 里；
  //     运行时路由的正则序列化成 `tess-core|tess|tessdata)//`，
  //     不含这个字面量（下一行就靠这个区分）。
  check(
    !sw.includes('tess-core/tesseract-core-') && !sw.includes('tess/worker.min.js'),
    'sw.js 预缓存了 tesseract 第二意见资产（worker / core 变体 ≈11.8MB）——' +
      '它们应走运行时 CacheFirst（见 vite.config.ts 的 globIgnores），否则首访白下整个体积',
  );
  // 排除预缓存之余，运行时路由必须还在 —— 否则这些资产离线就取不到了
  check(
    sw.includes('tess-assets'),
    'sw.js 里没有 tesseract 资产的运行时缓存路由（cacheName: tess-assets）——' +
      '它们既不预缓存、也不缓存，离线时第二意见必然失败',
  );

  notes.push('Service Worker 已生成并包含导航回退');
}

// ── 6. 单个 chunk 体积 ──────────────────────────────────────
for (const name of readdirSync(assets)) {
  const size = statSync(join(assets, name)).size;
  if (size > MAX_CHUNK_BYTES && !/^pdfWorkerEntry-/.test(name) && !/^ort-wasm/.test(name)) {
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
