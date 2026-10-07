/**
 * 把 PaddleOCR 的模型文件取到 `public/ocr-models/`，随站点一起发布。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么要自托管，而不是让浏览器去第三方取
 * ═══════════════════════════════════════════════════════════════
 *
 * 用户实测的报错：
 *   Failed to fetch https://hf-mirror.com/.../PP-OCRv6_small_det.ort
 *   after 3 attempt(s): TypeError: Failed to fetch
 *
 * 而同一台机器上：
 *   · `Test-NetConnection hf-mirror.com:443` → 通
 *   · Node 的 fetch 把三个文件都完整下载了（9.52 + 20.30 + 0.07 = 29.9MB）
 *   · hf-mirror 的响应**带正确的 CORS 头**（回显了 Origin）
 *
 * 也就是说：**外网能通、CORS 也没问题，但用户的浏览器就是取不到。**
 * 这类差异（代理、扩展、DNS、公司网关……）无法从代码侧根治，
 * 而包内置的官方源 huggingface.co 在国内更是完全不可达。
 *
 * 结论：**不要再让浏览器去任何第三方取模型。**
 * 构建时取一次、放进产物里、与站点同源发布 —— 同源请求不受上述任何一项影响，
 * 而且顺带满足离线与隐私诉求（运行期不再有第三方外发）。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么放在 public/ 而不是提交进仓库
 * ═══════════════════════════════════════════════════════════════
 *
 * 与 `public/pdfjs-wasm` 同样的理由：这是**第三方依赖的产物**，
 * 入库会在依赖升级后留下与版本不一致的副本。
 * 因此它被 .gitignore 排除，由 prebuild / predev 钩子按需取一次。
 *
 * 取不到时**直接让构建失败**（见 scripts/verify-dist.mjs 的校验），
 * 而不是产出一个「能部署但 OCR 用不了」的站点 —— 这次的故障正是
 * 「东西没到位，但没有任何人发现」。
 */
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEST = join(ROOT, 'public', 'ocr-models');

/** 三个文件相对于 base 的路径，以及期望的字节数（用于判断是否需要重新下载） */
const FILES = [
  { path: 'detection/ort/PP-OCRv6_small_det.ort', bytes: 9_982_352 },
  { path: 'recognition/ort/PP-OCRv6_small_rec.ort', bytes: 21_290_816 },
  { path: 'recognition/ppocrv6_dict.txt', bytes: 74_948 },
];

/**
 * 下载来源，按顺序尝试。
 *
 * 国内镜像放第一位：本地开发/构建最可能在这里成功。
 * 官方源放第二位：Cloudflare / GitHub 的构建环境在境外，通常只有它能通。
 * 可用 `OCR_MODEL_SOURCE` 指定单一来源（自建镜像时用）。
 */
const SOURCES = [
  process.env.OCR_MODEL_SOURCE,
  'https://hf-mirror.com/snowfluke/ppu-paddle-ocr-models/resolve/main',
  'https://huggingface.co/snowfluke/ppu-paddle-ocr-models/resolve/main',
].filter(Boolean);

/** 已存在且大小合理就跳过 —— 让重复构建不必再下 30MB */
async function alreadyPresent(file) {
  try {
    const s = await stat(join(DEST, file.path));
    // 允许 ±1% 的偏差：不同镜像的 Content-Length 偶尔会有细微差异
    return Math.abs(s.size - file.bytes) <= file.bytes * 0.01;
  } catch {
    return false;
  }
}

async function download(base, file) {
  const url = `${base.replace(/\/+$/, '')}/${file.path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength < 1024) {
    throw new Error(`内容过小（${buf.byteLength} 字节），可能不是模型文件`);
  }
  const dest = join(DEST, file.path);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, buf);
  return buf.byteLength;
}

async function main() {
  const pending = [];
  for (const f of FILES) {
    if (await alreadyPresent(f)) {
      console.log(`  [已有] ${f.path}`);
    } else {
      pending.push(f);
    }
  }

  if (!pending.length) {
    console.log('  OCR 模型已齐备，无需下载。');
    return;
  }

  console.log(`  需要下载 ${pending.length} 个模型文件…`);

  for (const f of pending) {
    let done = false;
    const errors = [];
    for (const base of SOURCES) {
      const host = new URL(base).host;
      try {
        const bytes = await download(base, f);
        console.log(`  [完成] ${f.path}  ${(bytes / 1024 / 1024).toFixed(2)}MB  ← ${host}`);
        done = true;
        break;
      } catch (err) {
        errors.push(`${host}: ${err.message}`);
      }
    }
    if (!done) {
      // 明确失败：宁可不部署，也不要部署一个 OCR 用不了的站点
      throw new Error(
        `OCR 模型下载失败：${f.path}\n` +
          errors.map((e) => `  · ${e}`).join('\n') +
          `\n\n可设 OCR_MODEL_SOURCE 指向可达的镜像，例如：\n` +
          `  OCR_MODEL_SOURCE=https://your-mirror.example.com/snowfluke/ppu-paddle-ocr-models/resolve/main`,
      );
    }
  }

  console.log('  OCR 模型已放入 public/ocr-models/（由 .gitignore 排除，不随仓库分发）');
}

main().catch((err) => {
  console.error(`[fetch-ocr-models] ${err.message}`);
  process.exit(1);
});
