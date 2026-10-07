#!/usr/bin/env node
/**
 * ============================================================================
 * win-ocr-pdf.mjs — 用「Windows 自带 OCR」把扫描版 PDF 转成可导入本阅读器的
 *                   Markdown / 纯文本
 * ============================================================================
 *
 * 【用途】
 *   零后端静态站点（universal-reader）本身**无法**在浏览器里调用 Windows OCR
 *   （见 docs/Windows自带OCR可行性.md 的结论）。本脚本提供「本地辅助工具」形态：
 *   用户在自己电脑上跑一次，把扫描版 PDF 变成 .md / .txt，再拖进阅读器导入。
 *
 *   流水线：
 *     PDF ──pdfjs-dist──> 每页 PNG ──PowerShell+WinRT Windows.Media.Ocr──> JSON
 *         ──启发式重排──> Markdown
 *
 * 【前置条件】（全部零额外安装）
 *   1. Windows 10 / 11
 *   2. Node >= 20.19（本项目 engines 要求）
 *   3. 项目已 npm install —— 用到 pdfjs-dist 与 @napi-rs/canvas（二者都已在
 *      package.json 里，本脚本**不新增任何依赖**）
 *   4. Windows PowerShell 5.1 + 已安装 OCR 语言包（中文为 zh-Hans-CN）
 *      检查：powershell.exe -NoProfile -ExecutionPolicy Bypass `
 *              -File scripts/win-ocr-helper.ps1 -ListLanguages
 *   5. **不需要联网**，**不需要上传任何数据**
 *
 * 【用法】
 *   node scripts/win-ocr-pdf.mjs <input.pdf> [-o out.md] [options]
 *
 *   选项：
 *     -o, --out <file>      输出文件（默认与输入同名，扩展名 .md / .txt）
 *     --format <md|txt|json>  输出格式（默认 md）
 *     --dpi <n>             渲染 DPI（默认 200，与 src 里 OCR_RENDER_DPI 一致）
 *     --lang <tag>          OCR 语言（默认 zh-Hans-CN）
 *     --layout <paragraph|line>  段落重排策略（默认 paragraph，见下）
 *     --pages <spec>        只处理指定页，如 "1-5,9"（默认全部）
 *     --batch <n>           每批渲染+识别的页数（默认 8，控制磁盘与进程开销）
 *     --page-separator <s>  页分隔符（默认 '<!-- page N -->'，渲染时不可见）
 *     --work-dir <dir>      中间 PNG 的临时目录（默认系统 temp）
 *     --keep-images         保留中间 PNG（调试用）
 *     --quiet               少打印
 *     -h, --help
 *
 *   例：
 *     node scripts/win-ocr-pdf.mjs .\扫描书.pdf -o .\扫描书.md
 *     node scripts/win-ocr-pdf.mjs .\a.pdf --pages 1-3 --dpi 300 --layout line
 *
 * 【本脚本实测到哪一步】（Windows 11 10.0.26300 / Node v25.2.1 / PowerShell 5.1）
 *   ✅ 已验证：pdfjs-dist + @napi-rs/canvas 在 Node 里把 PDF 页渲染成 PNG。
 *   ✅ 已验证：PNG 批量交给 win-ocr-helper.ps1，取回带包围盒的中文识别 JSON。
 *   ✅ 已验证：JSON -> Markdown 的拼接与段落重排。
 *   ✅ 已验证：整条流水线对「图像型（扫描型）PDF」端到端跑通。
 *   ⚠ 未验证：真实扫描件（含倾斜/噪点/印章）的识别质量；本脚本只用合成图测过。
 *   ⚠ 未验证：加密 PDF、非 A4 页面、超 10000px 的大页（脚本会按 DPI 提示）。
 *   ⚠ 本机 **无法** 用 Edge/Chrome headless 生成对照 PDF —— DSH 沙箱拒绝
 *     mojo 命名管道（见可行性文档的「被拒命令」一节）。
 *
 * 【已知限制】（诚实列出）
 *   - 只输出 Markdown / TXT / JSON。**不输出「带文字层的 PDF」**：写 PDF 需要
 *     pdf-lib，而它已在本项目中被移除（HANDOFF §4.3 决定三），且本任务不允许改
 *     package.json。若将来要文字层 PDF，见可行性文档 §6 的评估。
 *   - 公式、跨行大括号、上下标：Windows OCR **实测会错**（x^2 → xA2，y_1 → y 1，
 *     跨行大括号的其中一行会整行丢失）。不要把本工具当作公式识别方案。
 *   - 段落重排（--layout paragraph）是**启发式**，不是版式分析。实测：
 *       合成「左对齐 + 右参差」的中文正文页（2 段共 8 个物理行）→ 重排结果与
 *       原文段落**完全一致**；但这是**合成图**，不是真实扫描件。
 *     已内置两道守卫：一页有效行 < 8 行、或检测到多栏排版时，**放弃重排**。
 *     仍建议：对陌生版式先用 `--layout line`（忠实保留 OCR 行）核对。
 *   - 版面顺序完全依赖 WinRT 返回的行序；多栏/表格/图文混排的阅读顺序不保证正确。
 */

import { createCanvas } from '@napi-rs/canvas';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

// ============================================================ 参数解析

function usage(exitCode = 0) {
  const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const m = src.match(/\/\*\*([\s\S]*?)\*\//);
  console.log(m ? m[1].replace(/^ \* ?/gm, '').trim() : 'win-ocr-pdf.mjs');
  process.exit(exitCode);
}

function parseArgs(argv) {
  const o = {
    input: null, out: null, format: 'md', dpi: 200, lang: 'zh-Hans-CN',
    layout: 'paragraph', pages: null, batch: 8, pageSeparator: null,
    workDir: null, keepImages: false, quiet: false,
  };
  const need = (i, name) => {
    if (i + 1 >= argv.length) fail(`选项 ${name} 缺少取值`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-h': case '--help': usage(0); break;
      case '-o': case '--out': o.out = need(i, a); i++; break;
      case '--format': o.format = need(i, a); i++; break;
      case '--dpi': o.dpi = Number(need(i, a)); i++; break;
      case '--lang': o.lang = need(i, a); i++; break;
      case '--layout': o.layout = need(i, a); i++; break;
      case '--pages': o.pages = need(i, a); i++; break;
      case '--batch': o.batch = Number(need(i, a)); i++; break;
      case '--page-separator': o.pageSeparator = need(i, a); i++; break;
      case '--work-dir': o.workDir = need(i, a); i++; break;
      case '--keep-images': o.keepImages = true; break;
      case '--quiet': o.quiet = true; break;
      default:
        if (a.startsWith('-')) fail(`未知选项：${a}`);
        else if (o.input) fail(`只能指定一个输入文件（已有 ${o.input}，又来了 ${a}）`);
        else o.input = a;
    }
  }
  if (!o.input) fail('缺少输入 PDF 路径。用 --help 看用法。');
  if (!['md', 'txt', 'json'].includes(o.format)) fail(`--format 只能是 md / txt / json，收到 ${o.format}`);
  if (!['paragraph', 'line'].includes(o.layout)) fail(`--layout 只能是 paragraph / line，收到 ${o.layout}`);
  if (!Number.isFinite(o.dpi) || o.dpi < 72 || o.dpi > 600) fail(`--dpi 必须在 72..600，收到 ${o.dpi}`);
  if (!Number.isInteger(o.batch) || o.batch < 1) fail(`--batch 必须是正整数，收到 ${o.batch}`);
  if (!o.out) {
    const ext = o.format === 'json' ? '.json' : o.format === 'txt' ? '.txt' : '.md';
    o.out = path.join(path.dirname(o.input), path.basename(o.input, path.extname(o.input)) + ext);
  }
  return o;
}

function fail(msg) {
  console.error(`\n[错误] ${msg}\n`);
  process.exit(1);
}

function log(o, ...a) { if (!o.quiet) console.log(...a); }

// ============================================================ 页码解析

function resolvePages(spec, numPages) {
  if (!spec) return Array.from({ length: numPages }, (_, i) => i + 1);
  const set = new Set();
  for (const part of String(spec).split(',')) {
    const s = part.trim();
    if (!s) continue;
    const m = s.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      const [a, b] = [Number(m[1]), Number(m[2])].sort((x, y) => x - y);
      for (let p = a; p <= b; p++) if (p >= 1 && p <= numPages) set.add(p);
    } else if (/^\d+$/.test(s)) {
      const p = Number(s);
      if (p >= 1 && p <= numPages) set.add(p);
    } else {
      fail(`--pages 里的 "${s}" 无法解析`);
    }
  }
  if (set.size === 0) fail(`--pages "${spec}" 没有匹配到任何页（文档共 ${numPages} 页）`);
  return [...set].sort((a, b) => a - b);
}

// ============================================================ PDF 渲染

async function loadPdfjs() {
  // legacy 构建对 Node 更友好（不依赖浏览器 API）
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  try {
    pdfjs.GlobalWorkerOptions.workerSrc = import.meta.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');
  } catch {
    // 解析不到 worker 时 pdfjs 会退化为同线程 fake worker，仍可工作
  }
  return pdfjs;
}

function resolveStandardFontsUrl() {
  try {
    const u = import.meta.resolve('pdfjs-dist/standard_fonts/');
    if (existsSync(fileURLToPath(u))) return u;
  } catch { /* ignore */ }
  return undefined;
}

async function renderPage(page, dpi) {
  const scale = dpi / 72;
  const viewport = page.getViewport({ scale });
  const w = Math.max(1, Math.ceil(viewport.width));
  const h = Math.max(1, Math.ceil(viewport.height));
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  await page.render({ canvasContext: ctx, viewport, canvas }).promise;
  return { png: canvas.toBuffer('image/png'), width: w, height: h };
}

// ============================================================ 调用 PowerShell OCR

function locatePowerShell() {
  const root = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  const cands = [
    path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    // 32 位 Node 跑在 64 位 Windows 上时的重定向路径
    path.join(root, 'Sysnative', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ];
  for (const c of cands) if (existsSync(c)) return c;
  return null;
}

function runOcrBatch(o, psExe, helper, { imageDir, imagePath }, jsonOut) {
  const args = [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', helper, '-OutFile', jsonOut, '-Language', o.lang,
  ];
  // 单图模式必须走 -ImagePath：若误用 -ImageDir，助手会把整个目录的图片全部 OCR 一遍
  // （用户把 PNG 放在一个有几百张图的目录里时会非常慢）。
  if (imagePath) args.push('-ImagePath', imagePath);
  else args.push('-ImageDir', imageDir);
  // 关键：stdio 'inherit'。DSH 沙箱禁止子进程用管道(named pipe)回传输出，
  // 所以结果一律走 JSON 文件，而不是 stdout。
  const r = spawnSync(psExe, args, { stdio: 'inherit' });
  if (r.error) fail(`无法启动 PowerShell：${r.error.message}`);
  if (!existsSync(jsonOut)) fail(`PowerShell 没有生成结果文件 ${jsonOut}（退出码 ${r.status}）`);
  const raw = readFileSync(jsonOut, 'utf8').replace(/^\uFEFF/, '');
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) { fail(`结果 JSON 解析失败：${e.message}`); }
  if (r.status === 3) fail('本机没有可用的 OCR 引擎。请先安装对应语言的「光学字符识别」可选功能。');
  return parsed;
}

// ============================================================ 文本重排

const CJK_RE = /[\u2E80-\u303F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/;
const SENTENCE_END_RE = /[。！？；：!?;:.]$/;
const LIST_START_RE = /^\s*(?:[•·▪◦*\-–—]|\(?\d+[.)、）]|[（(]\d+[)）]|[一二三四五六七八九十]+[、.)）])/;

function geom(line) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const w of line.words || []) {
    minX = Math.min(minX, w.x);
    maxX = Math.max(maxX, w.x + w.w);
    minY = Math.min(minY, w.y);
    maxY = Math.max(maxY, w.y + w.h);
  }
  return Number.isFinite(minX) ? { minX, maxX, minY, maxY } : null;
}

/**
 * 段落重排：把「明显是同一段的换行」合并回一行。
 *
 * 这是**启发式**，不是版式分析。它刻意做得保守：宁可不合并（保留换行），
 * 也不要把两段粘成一段。
 *
 * 实测教训（见可行性文档 §4.3）：前两版都失败过 ——
 *   v1「行右边缘的 90 分位」当正文右边界：在一页只有 7 行的合成件上，最长的行
 *      自己就成了「右边界」，导致 4 个视觉上完全独立的段落被粘成一段。
 *   v2 改用 min-left / max-right：在「左对齐 + 右参差」的页面上只合并了前两行、
 *      后两行没合并 —— 凭空造出一个不存在的段落边界，比不合并更糟。
 *   v3（当前）改用**右边缘的 75 分位**作「典型行宽」，并加两道守卫：
 *      · 有效行 < MIN_LINES_FOR_REFLOW → 样本不足以估计页边距，放弃重排
 *      · 检测到多栏排版 → 按行序重排会跨栏乱序，放弃重排
 *
 * 合并条件（**同时**满足才合并）：
 *   1. 上一行右边缘接近「典型行宽」的右端，且自身宽度 >= 55% 正文宽度
 *   2. 下一行左边缘接近正文左边界（不是缩进/新块起点）
 *   3. 两行竖直间距 <= 1.5×行高（正常行距，不是空行造成的段落间距）
 *   4. 下一行不以列表符号/编号开头
 *   5. 上一行不以句末标点结尾
 */
const MIN_LINES_FOR_REFLOW = 8;

/**
 * 多栏检测：若存在「竖直方向重叠 >= 50%，但水平方向完全不重叠」的两行，
 * 说明这是多栏排版 —— 此时按行序做段落重排会产生跨栏乱序，必须放弃重排。
 * 学术论文/双栏扫描件非常常见，所以这个守卫是必要的。
 */
function looksMultiColumn(items) {
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i].g, b = items[j].g;
      const vOverlap = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
      const vMin = Math.min(a.maxY - a.minY, b.maxY - b.minY);
      if (vMin <= 0 || vOverlap < vMin * 0.5) continue;
      const hOverlap = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
      if (hOverlap < 0) return true;
    }
  }
  return false;
}

function reflowParagraphs(lines) {
  const withGeom = lines
    .map((l) => ({ ...l, g: geom(l) }))
    .filter((l) => l.text.trim().length > 0);

  // 样本太少 -> 不猜版式，原样返回
  if (withGeom.length < MIN_LINES_FOR_REFLOW) return withGeom.map((l) => l.text.trim());
  if (withGeom.length === 0) return [];
  // 多栏 -> 不猜版式
  if (looksMultiColumn(withGeom)) return withGeom.map((l) => l.text.trim());

  const lefts = withGeom.map((l) => l.g.minX);
  const rights = withGeom.map((l) => l.g.maxX).sort((a, b) => a - b);
  const bodyLeft = Math.min(...lefts);
  const bodyRight = rights[rights.length - 1];
  const bodyWidth = Math.max(1, bodyRight - bodyLeft);

  const heights = withGeom.map((l) => l.g.maxY - l.g.minY).sort((a, b) => a - b);
  const lineH = heights[Math.floor(heights.length / 2)] || 20;

  // 「典型行宽」取右边缘的 75 分位，而不是最大值。
  // 理由：中文排版若为「左对齐 + 右参差」，各非末行右边缘会差一个字左右，
  // 只有靠分位数才能稳定地判断「这一行是否排到了行尾」。
  // CJK 字形近似正方形，所以 1.5×行高 ≈ 1.5 个汉字宽度，可直接当容差用。
  const typicalRight = rights[Math.min(rights.length - 1, Math.floor(rights.length * 0.75))];
  const leftTol = Math.max(lineH * 0.8, bodyWidth * 0.03);
  const rightTol = Math.max(lineH * 1.5, bodyWidth * 0.03);

  const out = [];
  let cur = withGeom[0].text.trim();
  for (let i = 1; i < withGeom.length; i++) {
    const prev = withGeom[i - 1];
    const next = withGeom[i];
    const prevWidth = prev.g.maxX - prev.g.minX;
    const prevReachesRight =
      prev.g.maxX >= typicalRight - rightTol && prevWidth >= bodyWidth * 0.55;
    const nextAtLeft = Math.abs(next.g.minX - bodyLeft) <= leftTol;
    const verticalGap = next.g.minY - prev.g.maxY;
    const tightLeading = verticalGap <= lineH * 1.5 && verticalGap >= -lineH * 0.5;
    const mergeable =
      prevReachesRight && nextAtLeft && tightLeading &&
      !SENTENCE_END_RE.test(cur) &&
      !LIST_START_RE.test(next.text);
    if (mergeable) {
      // CJK 之间不补空格；西文之间补空格
      const a = cur[cur.length - 1];
      const b = next.text.trim()[0];
      cur += (!CJK_RE.test(a) && !CJK_RE.test(b)) ? ' ' + next.text.trim() : next.text.trim();
    } else {
      out.push(cur);
      cur = next.text.trim();
    }
  }
  out.push(cur);
  return out;
}

// ============================================================ 组装输出

function assemble(o, pdfName, pageResults, meta) {
  if (o.format === 'json') {
    return JSON.stringify({ source: pdfName, ...meta, pages: pageResults }, null, 2);
  }

  const parts = [];
  for (const pr of pageResults) {
    const sep = o.pageSeparator !== null
      ? o.pageSeparator.replace(/\bN\b/g, String(pr.page))
      : `<!-- page ${pr.page} -->`;
    const body = o.layout === 'paragraph'
      ? reflowParagraphs(pr.lines)
      : pr.lines.map((l) => l.text.trim()).filter(Boolean);

    if (o.format === 'md') parts.push(sep);
    // 注意：Markdown 里「单换行」会被合并成同一段，所以两种 layout 都用空行分隔，
    // 保证每一行/每一段在渲染时真的是独立的块。
    parts.push(body.join('\n\n'));
  }
  const head = o.format === 'md'
    ? `<!-- 由 scripts/win-ocr-pdf.mjs 使用 Windows 自带 OCR (Windows.Media.Ocr, ${meta.engineLanguage}) 生成 -->\n` +
      `<!-- 源文件：${pdfName}｜渲染 ${meta.dpi} DPI｜处理 ${pageResults.length}/${meta.totalPages} 页 -->\n\n`
    : '';
  return head + parts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

// ============================================================ 主流程

async function main() {
  const t0 = Date.now();
  const o = parseArgs(process.argv.slice(2));

  if (process.platform !== 'win32') {
    fail(`本脚本依赖 Windows 自带的 WinRT OCR，当前平台是 ${process.platform}，无法运行。`);
  }
  if (!existsSync(o.input)) fail(`找不到输入文件：${o.input}`);
  if (path.resolve(o.input) === path.resolve(o.out)) fail('输入与输出是同一个文件，请用 -o 指定不同路径。');

  const helper = path.join(__dirname, 'win-ocr-helper.ps1');
  if (!existsSync(helper)) fail(`找不到 OCR 助手脚本：${helper}`);
  const psExe = locatePowerShell();
  if (!psExe) fail('找不到 Windows PowerShell 5.1 (powershell.exe)。WinRT OCR 需要它，PowerShell 7 不行。');

  // --- 打开 PDF（或直接当图片处理） ---
  const isImage = /\.(png|jpe?g|bmp|tiff?)$/i.test(o.input);

  const workDir = o.workDir
    ? path.resolve(o.workDir)
    : mkdtempSync(path.join(tmpdir(), 'win-ocr-'));
  mkdirSync(workDir, { recursive: true });

  log(o, `输入：${o.input}`);
  log(o, `输出：${o.out}`);
  log(o, `引擎：Windows.Media.Ocr / ${o.lang}｜渲染 ${o.dpi} DPI｜临时目录 ${workDir}`);

  let pageResults = [];
  let meta = {};

  if (isImage) {
    // 直接把图片交给 OCR
    const jsonOut = path.join(workDir, 'ocr.json');
    const res = runOcrBatch(o, psExe, helper, { imagePath: path.resolve(o.input) }, jsonOut);
    const img = res.images.find((x) => x.image === path.basename(o.input)) || res.images[0];
    if (!img) fail(`OCR 没有返回 ${path.basename(o.input)} 的结果。`);
    pageResults = [{ page: 1, width: img.width, height: img.height, lines: img.lines }];
    meta = { engineLanguage: res.engineLanguage, dpi: o.dpi, totalPages: 1 };
  } else {
    const pdfjs = await loadPdfjs();
    const data = new Uint8Array(readFileSync(o.input));
    const doc = await pdfjs.getDocument({
      data,
      isEvalSupported: false,
      useSystemFonts: true,
      standardFontDataUrl: resolveStandardFontsUrl(),
    }).promise;

    const pages = resolvePages(o.pages, doc.numPages);
    meta = { engineLanguage: o.lang, dpi: o.dpi, totalPages: doc.numPages };
    log(o, `PDF 共 ${doc.numPages} 页，处理 ${pages.length} 页`);

    // 分批：控制临时磁盘占用 + PowerShell 进程数
    for (let i = 0; i < pages.length; i += o.batch) {
      const chunk = pages.slice(i, i + o.batch);
      const batchDir = path.join(workDir, `batch-${String(i / o.batch).padStart(3, '0')}`);
      mkdirSync(batchDir, { recursive: true });

      const renderT0 = Date.now();
      for (const p of chunk) {
        const page = await doc.getPage(p);
        const { png, width, height } = await renderPage(page, o.dpi);
        const maxDim = 10000;
        if (width > maxDim || height > maxDim) {
          log(o, `  [跳过] 第 ${p} 页渲染为 ${width}x${height}，超过 WinRT OCR 上限 ${maxDim}，请降低 --dpi`);
          page.cleanup();
          continue;
        }
        writeFileSync(path.join(batchDir, `page-${String(p).padStart(4, '0')}.png`), png);
        page.cleanup();
      }
      log(o, `  渲染 ${chunk.length} 页完成（${Date.now() - renderT0} ms），交给 Windows OCR…`);

      const jsonOut = path.join(batchDir, 'ocr.json');
      const res = runOcrBatch(o, psExe, helper, batchDir, jsonOut);
      for (const e of res.errors || []) console.warn(`  [OCR 警告] ${e}`);

      for (const img of res.images) {
        const p = Number(img.image.match(/page-(\d+)\.png$/)?.[1] ?? 0) || (pageResults.length + 1);
        pageResults.push({ page: p, width: img.width, height: img.height, lines: img.lines });
      }
      if (!o.keepImages) rmSync(batchDir, { recursive: true, force: true });
    }

    pageResults.sort((a, b) => a.page - b.page);
  }

  if (!o.keepImages && !o.workDir) {
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  const text = assemble(o, path.basename(o.input), pageResults, meta);
  mkdirSync(path.dirname(path.resolve(o.out)), { recursive: true });
  writeFileSync(o.out, text, 'utf8');

  const chars = pageResults.reduce((n, p) => n + p.lines.reduce((m, l) => m + l.text.length, 0), 0);
  const size = statSync(o.out).size;
  console.log('');
  console.log(`✅ 完成：${o.out}`);
  console.log(`   ${pageResults.length} 页｜识别 ${chars} 字｜输出 ${size} 字节｜总耗时 ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  if (o.keepImages) console.log(`   中间图片保留在：${workDir}`);
}

main().catch((e) => {
  console.error('\n[未捕获错误]', e);
  process.exit(1);
});
