/**
 * 把 pdf.js 的 WASM 解码器复制到 public/ 目录。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么必须做这一步
 * ═══════════════════════════════════════════════════════════════
 *
 * pdf.js **不会**自动找到自己包里的 WASM 解码器 —— 它要求调用方显式传
 * `wasmUrl`，否则在需要解码图像时直接抛错：
 *
 *     Error: Ensure that the `wasmUrl` API parameter is provided.
 *
 * 而 JBIG2 与 JPEG2000 正是扫描版 PDF 最常用的两种图像编码：
 * 本项目实测的一份 833 页扫描书里有 833 处 JBIG2Decode + 384 处 JPXDecode。
 * 缺解码器的表现极具误导性：**不报错，只是页面渲染成一片空白**，
 * 于是"空白页跳过"逻辑把它当成空白页全部跳过，最终报"什么都没识别到"。
 *
 * 两种方案的选择：
 * - 指向 CDN：一行配置，但引入运行时网络依赖，违背本项目"离线可用"的定位；
 * - 复制到 public/：构建期一次性搬运，产物自带解码器，离线可用。
 *   **选这个。**
 *
 * 由 `npm run build` / `npm run dev` 前的 predev / prebuild 钩子自动执行，
 * 因此 public/pdfjs-wasm 不入库（见 .gitignore），但每次运行都会重新生成。
 */

import { cp, mkdir, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'node_modules', 'pdfjs-dist', 'wasm');
const target = join(root, 'public', 'pdfjs-wasm');

/** 只复制运行时会请求的文件，避免把 license 与 map 也搬进产物 */
const KEEP = /\.(wasm|js)$/;

async function main() {
  if (!existsSync(source)) {
    console.error(
      `[copy-pdfjs-wasm] 找不到 ${source}\n` +
        `请先执行 npm install。若 pdfjs-dist 版本升级后目录结构变化，需要更新本脚本。`,
    );
    process.exit(1);
  }

  await mkdir(target, { recursive: true });

  const entries = await readdir(source);
  let copied = 0;

  for (const name of entries) {
    if (!KEEP.test(name)) continue;
    const info = await stat(join(source, name));
    if (!info.isFile()) continue;

    await cp(join(source, name), join(target, name));
    copied++;
  }

  console.log(`[copy-pdfjs-wasm] 已复制 ${copied} 个解码器文件到 public/pdfjs-wasm/`);
}

main().catch((err) => {
  console.error('[copy-pdfjs-wasm] 复制失败：', err);
  process.exit(1);
});
