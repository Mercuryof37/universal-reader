import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * pdf.js WASM 解码器的交付防线。
 *
 * ═══════════════════════════════════════════════════════════════
 * 这组测试对应一次最隐蔽的线上故障
 * ═══════════════════════════════════════════════════════════════
 *
 * 现象：833 页的扫描书执行浏览器端 OCR，前 10 页全部被判定为"空白页"跳过，
 * 最终报"未能从任何页面中提取出文字"，**且没有任何错误**。
 *
 * 根因：pdf.js 需要显式传入 `wasmUrl` 才能加载 JBIG2 / JPEG2000 解码器。
 * 而这份 PDF 的每一页都是 JBIG2 图像 —— 没有解码器就画不出任何东西，
 * canvas 全白，于是被"空白页跳过"逻辑全部跳过。
 *
 * 这个故障之所以难查，是因为**每一层的表现都是合理的**：
 * 没有解码器 → 不绘制 → 画布空白 → 空白检测正确地跳过 → 报告"没识别到文字"。
 * 没有任何一步会报错。
 *
 * 因此这里用测试锁死交付链路：解码器必须存在、必须被复制到 public/。
 */

// 用 process.cwd() 而不是 import.meta.url：
// 后者指向 src/lib/，上溯层级容易数错；vitest 的工作目录就是项目根，语义也更明确。
const root = process.cwd();

const DECODER_SOURCE = join(root, 'node_modules', 'pdfjs-dist', 'wasm');
const DECODER_TARGET = join(root, 'public', 'pdfjs-wasm');

/**
 * 扫描版 PDF 必需的解码器。
 * jbig2 → 黑白扫描件（最常见的扫描格式）
 * openjpeg → JPEG2000，彩色扫描件
 */
const REQUIRED_DECODERS = ['jbig2.wasm', 'openjpeg.wasm'];

describe('pdf.js WASM 解码器交付链路', () => {
  it('复制脚本存在（predev / prebuild 钩子依赖它）', () => {
    expect(existsSync(join(root, 'scripts', 'copy-pdfjs-wasm.mjs'))).toBe(true);
  });

  it('package.json 在 dev 与 build 前都会复制解码器', () => {
    const pkg = JSON.parse(
      readFileSync(join(root, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };

    // 关键：这两个钩子缺任何一个，对应的运行方式就会拿不到解码器
    expect(pkg.scripts['predev']).toContain('copy-pdfjs-wasm');
    expect(pkg.scripts['prebuild']).toContain('copy-pdfjs-wasm');
  });

  it('pdfjs-dist 里确实提供了必需的解码器', () => {
    for (const name of REQUIRED_DECODERS) {
      const file = join(DECODER_SOURCE, name);
      expect(existsSync(file), `缺少 ${name}，pdfjs-dist 的目录结构可能已变化`).toBe(true);
      // 真实的 wasm 二进制应当有可观体积；0 字节说明复制或打包出了问题
      expect(statSync(file).size).toBeGreaterThan(10_000);
    }
  });

  it('解码器已复制到 public/pdfjs-wasm（否则构建产物里不会有它们）', () => {
    expect(
      existsSync(DECODER_TARGET),
      'public/pdfjs-wasm 不存在 —— 请执行 npm run copy-wasm',
    ).toBe(true);

    const files = readdirSync(DECODER_TARGET);
    for (const name of REQUIRED_DECODERS) {
      expect(files, `public/pdfjs-wasm 里缺少 ${name}`).toContain(name);
    }
  });

  it('复制结果与源文件等大（确认是完整复制而非截断）', () => {
    for (const name of REQUIRED_DECODERS) {
      expect(statSync(join(DECODER_TARGET, name)).size).toBe(
        statSync(join(DECODER_SOURCE, name)).size,
      );
    }
  });
});
