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
 * 现象：833 页的扫描书执行浏览器端 OCR，页面全部被判定为"空白页"跳过，
 * 最终报"未能从任何页面中提取出文字"，**且没有任何错误**。
 *
 * 根因：pdf.js 需要显式传入 `wasmUrl` 才能加载 JBIG2 / JPEG2000 解码器。
 * 而这份 PDF 的每一页都是 JBIG2 图像 —— 没有解码器就画不出任何东西，
 * canvas 全白，于是被"空白页跳过"逻辑全部跳过。
 *
 * 每一层的表现都是合理的：没有解码器 → 不绘制 → 画布空白 →
 * 空白检测正确地跳过 → 报告"没识别到文字"。没有任何一步会报错。
 *
 * ═══════════════════════════════════════════════════════════════
 * ⚠️ 断言分两类，这个区分是被 CI 失败教会的
 * ═══════════════════════════════════════════════════════════════
 *
 * | 类别 | 在干净检出上是否成立 | 放在哪里断言 |
 * |---|---|---|
 * | **仓库不变量**（脚本存在、钩子已挂、依赖提供解码器） | ✅ 成立 | 本文件 |
 * | **构建产物**（public/pdfjs-wasm 已生成） | ❌ **不成立** | `scripts/verify-dist.mjs` |
 *
 * `public/pdfjs-wasm/` 是构建产物且在 `.gitignore` 里，`npm ci` 也不会触发
 * `prebuild` 钩子 —— 因此**干净检出上它必然不存在**。
 *
 * 第一版测试断言了"复制结果必须存在"，在本机永远通过（目录早就在了），
 * 却在 CI 上必然失败。**那是断言了一个只在开发者机器上成立的状态。**
 * 这类错误比逻辑错误更值得警惕：它让"本地全绿"变成一种假象。
 */

const root = process.cwd();

/** 解码器的来源（依赖包里随版本发布） */
const DECODER_SOURCE = join(root, 'node_modules', 'pdfjs-dist', 'wasm');
/** 构建时由 prebuild/predev 钩子生成 */
const DECODER_TARGET = join(root, 'public', 'pdfjs-wasm');

/**
 * 扫描版 PDF 必需的解码器。
 * jbig2 → 黑白扫描件（最常见的扫描格式）
 * openjpeg → JPEG2000，彩色扫描件
 */
const REQUIRED_DECODERS = ['jbig2.wasm', 'openjpeg.wasm'];

function childNames(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return -1;
  }
}

// ══════════════════════════════════════════════════════════════
// 第一类：仓库不变量 —— 在干净检出上就必须成立
// ══════════════════════════════════════════════════════════════
describe('WASM 解码器：仓库不变量（干净检出上必须成立）', () => {
  it('复制脚本存在（predev / prebuild 钩子依赖它）', () => {
    expect(existsSync(join(root, 'scripts', 'copy-pdfjs-wasm.mjs'))).toBe(true);
  });

  it('package.json 在 dev 与 build 前都会复制解码器', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };

    // 这两个钩子缺任何一个，对应的运行方式就会拿不到解码器。
    // 尤其 prebuild：Cloudflare Pages 与 CI 都靠它把解码器放进产物。
    expect(pkg.scripts['predev']).toContain('copy-pdfjs-wasm');
    expect(pkg.scripts['prebuild']).toContain('copy-pdfjs-wasm');
  });

  it('package.json 在构建后会自动校验产物', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    // 产物级的检查（解码器是否真的进了 dist）由它负责
    expect(pkg.scripts['postbuild']).toContain('verify-dist');
  });

  it('pdfjs-dist 里确实提供了必需的解码器', () => {
    for (const name of REQUIRED_DECODERS) {
      const file = join(DECODER_SOURCE, name);
      expect(existsSync(file), `缺少 ${name}，pdfjs-dist 的目录结构可能已变化`).toBe(true);
      // 真实的 wasm 二进制应当有可观体积；0 字节说明依赖本身有问题
      expect(fileSize(file)).toBeGreaterThan(10_000);
    }
  });

  it('复制脚本被 .gitignore 排除在版本控制之外（它是产物，不是源码）', () => {
    const ignore = readFileSync(join(root, '.gitignore'), 'utf8');
    // 这条断言的意义：明确 public/pdfjs-wasm 是产物。
    // 若有人把它从 .gitignore 移除并提交，上面"干净检出上不存在"的前提就变了，
    // 需要重新审视本文件的分类。
    expect(ignore).toContain('public/pdfjs-wasm');
  });
});

// ══════════════════════════════════════════════════════════════
// 第二类：构建产物 —— 只在跑过复制脚本后才检查
// ══════════════════════════════════════════════════════════════
describe('WASM 解码器：构建产物（跑过复制脚本后才存在）', () => {
  const targetExists = existsSync(DECODER_TARGET);

  it.skipIf(!targetExists)('复制结果是完整的（与源文件等大，未被截断）', () => {
    for (const name of REQUIRED_DECODERS) {
      expect(fileSize(join(DECODER_TARGET, name))).toBe(fileSize(join(DECODER_SOURCE, name)));
    }
  });

  it.skipIf(!targetExists)('运行时需要的解码器都已复制齐', () => {
    const files = childNames(DECODER_TARGET);
    for (const name of REQUIRED_DECODERS) {
      expect(files, `public/pdfjs-wasm 里缺少 ${name}`).toContain(name);
    }
  });

  it('未跑复制脚本时给出可执行的提示（而不是静默跳过）', () => {
    // 这条用例在两种状态下都通过，作用是**把状态说清楚**：
    // 干净检出上它提示"请执行 npm run copy-wasm"，
    // 开发机上它确认产物已就绪。避免"跳过"变成"没人知道发生了什么"。
    if (targetExists) {
      expect(childNames(DECODER_TARGET).length).toBeGreaterThan(0);
    } else {
      console.info(
        '[pdfjsWasmAssets] public/pdfjs-wasm 尚未生成 —— 这是干净检出上的正常状态。' +
          '执行 npm run copy-wasm 或 npm run build 即可生成；' +
          '产物级的强制校验由 postbuild 的 scripts/verify-dist.mjs 负责。',
      );
      expect(true).toBe(true);
    }
  });
});
