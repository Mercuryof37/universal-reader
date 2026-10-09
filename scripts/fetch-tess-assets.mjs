/**
 * 把 tesseract.js 的**全部运行期资产**取到 `public/` 下，随站点同源发布。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么每一个文件都必须自托管
 * ═══════════════════════════════════════════════════════════════
 *
 * tesseract.js 在浏览器里默认去 jsdelivr 取**四类**东西，缺一不可：
 *
 *   1. worker 脚本      https://cdn.jsdelivr.net/npm/tesseract.js@v7/…/worker.min.js
 *   2. wasm 内核        https://cdn.jsdelivr.net/npm/tesseract.js-core@v7/…
 *   3. 语言模型         https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/…
 *   4. （无）—— wasm 本体**不包括**：见下
 *
 * 默认源全部在境外 CDN，与 PaddleOCR 那批模型遇到的是同一堵墙
 * （见 fetch-ocr-models.mjs 的长注释：浏览器取不到而 Node 取得到）。
 * 本项目的核心约束又是「离线可用 + 不外发」，所以四类资产一律同源。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么只需要三个内核文件、而不是六个
 * ═══════════════════════════════════════════════════════════════
 *
 * `tesseract.js-core` 里有六个 `.wasm.js`：
 *
 *   tesseract-core.wasm.js             ┐
 *   tesseract-core-simd.wasm.js        ├ 带 legacy 引擎（OEM 0/2）的版本
 *   tesseract-core-relaxedsimd.wasm.js ┘
 *   tesseract-core-lstm.wasm.js             ┐
 *   tesseract-core-simd-lstm.wasm.js        ├ 只有 LSTM（OEM 1）的版本
 *   tesseract-core-relaxedsimd-lstm.wasm.js ┘
 *
 * 内核选择逻辑在 `tesseract.js/src/worker-script/browser/getCore.js`：
 * 当 `corePath` 是**目录**时，按 `wasm-feature-detect` 在
 * relaxedSimd / simd / 无 simd 三档里各挑一个；而 `oem = 1`（LSTM_ONLY，
 * 本项目的用法）时挑的**永远是 `-lstm` 那三个**。
 * 因此另外三个（各 ~4.5MB）对本项目是死重，不搬运。
 *
 * ⚠️ 而 `.wasm.js` 里**内嵌了 wasm 二进制**（base64），运行期不会再去取
 * 单独的 `.wasm` 文件 —— 这一点是实测确认的（文件尺寸 ≈ 2.85MB × 4/3）。
 * 所以「同源 W A S M」的工作量就是这三个文件本身，没有别的。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么内核从 node_modules 拷、语言模型却要下载
 * ═══════════════════════════════════════════════════════════════
 *
 * 内核与 worker 脚本是 `tesseract.js` / `tesseract.js-core` 两个依赖自带的，
 * 拷贝即得、且**必须与锁定版本一致**（版本漂移会导致 worker 与内核协议不匹配，
 * 症状是 worker 静默不返回，见 createWorker 的 load 流程）。
 * 用 sha256 把「拷到的确实是这一版」钉死 —— 这是防止 `package.json`
 * 里依赖被静默升级后资产悄悄对不上的唯一手段。
 *
 * 语言模型不在任何依赖里（库设计上是运行期从 CDN 拉），只能下载。
 * 来源与哈希：
 *   @tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz
 *   sha256 = 45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91
 * `best_int` 是整数量化版（2.95MB），识别几何证据够用；`chi_sim` 不用 ——
 * 见 ocrTesseractScripts.ts 顶部：本模块**只要几何证据、不要字符标签**，
 * 标签本身在数学区域全是垃圾（实测），所以单 eng 已够，且避开了
 * 多语言（`chi_sim+eng`）在 v7 的加载缺陷（实测 `Error opening data file`）。
 *
 * 取不到时**直接让构建失败**，与 fetch-ocr-models.mjs 同策略：
 * 宁可不部署，也不要部署一个「角标第二意见」静默失效的站点。
 */
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PUBLIC = join(ROOT, 'public');

/**
 * 从 node_modules 搬运的文件。`from` 是相对仓库根，`dest` 相对 `public/`。
 *
 * 三个内核版本的 sha256 与 tesseract.js-core@7.0.0 实测值一致；
 * worker.min.js 与 tesseract.js@7.0.0 一致。两者升版时这里会先失败，
 * 提示重新核对 —— 这正是要的效果（静默不匹配比失败难查得多）。
 */
const COPIES = [
  {
    from: 'node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js',
    dest: 'tess-core/tesseract-core-lstm.wasm.js',
    bytes: 3_896_484,
    sha256: 'eef5f8b2f8e20e150680b20adaec4a60babafee3adbe8a94583c81fee46e8680',
  },
  {
    from: 'node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js',
    dest: 'tess-core/tesseract-core-simd-lstm.wasm.js',
    bytes: 3_899_472,
    sha256: 'c58b46a4c796c0b8afccf77591d5b875b6896b45d402bbce8caa6f5362447b38',
  },
  {
    from: 'node_modules/tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js',
    dest: 'tess-core/tesseract-core-relaxedsimd-lstm.wasm.js',
    bytes: 3_905_767,
    sha256: '861a536cf9ef8e63cb644d57bab39c388f37f7d6b6f60024b741c5f6b39a59b3',
  },
  {
    from: 'node_modules/tesseract.js/dist/worker.min.js',
    dest: 'tess/worker.min.js',
    bytes: 111_307,
    sha256: '576b7df7e3393e137e51849357c9adb53fe7ac1bb69bfa06cf3d61520f182c6d',
  },
];

/**
 * 需要下载的文件。`source` 决定用哪个环境变量覆盖。
 *
 * 与 fetch-ocr-models.mjs 的小差异：这里**也**声明 sha256 ——
 * 上游 `@tesseract.js-data` 包在 npm 上是发布制品，内容固定，
 * 下载源（jsdelivr / npmmirror）只是同一 npm 包的不同镜像，
 * 哈希必须一致；不一致就说明镜像内容有问题，应当当场拒绝而不是放行。
 */
const DOWNLOADS = [
  {
    dest: 'tessdata/eng.traineddata.gz',
    bytes: 2_952_873,
    sha256: '45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91',
    source: 'tessdata',
  },
];

/**
 * eng 模型的下载来源，按顺序尝试。
 *
 * jsdelivr 放第一：实测可从本机 node 取到（curl 走系统代理时反而会失败，
 * 但 node 的 fetch 正常）。npmmirror 是第二道：它是国内镜像，
 * 构建环境在国内时更稳。
 */
const SOURCES = {
  tessdata: [
    process.env.OCR_TESSDATA_SOURCE,
    'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0_best_int',
    'https://registry.npmmirror.com/@tesseract.js-data/eng/4.0.0_best_int/files',
  ].filter(Boolean),
};

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * 已存在且哈希一致就跳过。
 *
 * 这里**只认哈希**，不比字节数（对比 fetch-ocr-models.mjs：那边有些文件
 * 上游没给哈希，只好退而求其次）。四个搬运件 + 一个下载件都有权威哈希，
 * 那就用最严的判据 —— 大小一致但内容被换掉/截断的情况一律拦住。
 */
async function alreadyPresent(dest, sha) {
  try {
    const full = join(PUBLIC, dest);
    const buf = await readFile(full);
    return sha256(buf) === sha;
  } catch {
    return false;
  }
}

async function copyOne(file) {
  const src = join(ROOT, file.from);
  let buf;
  try {
    buf = await readFile(src);
  } catch {
    throw new Error(
      `找不到 ${file.from} —— 依赖缺失或版本过旧。\n` +
        `  请先运行 npm install（应装 tesseract.js@7 与 tesseract.js-core@7 同版），\n` +
        `  若依赖已升级，请核对本脚本里钉住的 sha256 是否需要同步更新。`,
    );
  }
  const actual = sha256(buf);
  if (actual !== file.sha256) {
    throw new Error(
      `${file.from} 的 sha256 不符：\n` +
        `  期望 ${file.sha256}\n  实得 ${actual}\n` +
        `  说明 node_modules 里的版本与脚本钉住的不一致。\n` +
        `  两种可能：依赖被升级（→ 更新脚本里的哈希并重新验证），\n` +
        `  或依赖被篡改（→ 不要部署）。`,
    );
  }
  const dest = join(PUBLIC, file.dest);
  await mkdir(dirname(dest), { recursive: true });
  await copyFile(src, dest);
  return buf.byteLength;
}

async function downloadOne(base, file) {
  const url = `${base.replace(/\/+$/, '')}/${file.dest.split('/').pop()}`;
  const res = await fetch(url, { referrerPolicy: 'no-referrer' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength < 1024) {
    throw new Error(`内容过小（${buf.byteLength} 字节），可能不是模型文件`);
  }
  const actual = sha256(buf);
  if (actual !== file.sha256) {
    throw new Error(
      `sha256 不符（期望 ${file.sha256.slice(0, 16)}…，实得 ${actual.slice(0, 16)}…）` +
        ` —— 来源内容与预期不一致，拒绝写入`,
    );
  }
  const dest = join(PUBLIC, file.dest);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, buf);
  return buf.byteLength;
}

async function main() {
  let copied = 0;
  for (const f of COPIES) {
    if (await alreadyPresent(f.dest, f.sha256)) {
      console.log(`  [已有] public/${f.dest}`);
      continue;
    }
    const bytes = await copyOne(f);
    console.log(`  [搬运] public/${f.dest}  ${(bytes / 1024).toFixed(0)}KB`);
    copied++;
  }

  for (const f of DOWNLOADS) {
    if (await alreadyPresent(f.dest, f.sha256)) {
      console.log(`  [已有] public/${f.dest}`);
      continue;
    }
    const errors = [];
    let done = false;
    for (const base of SOURCES[f.source]) {
      const host = new URL(base).host;
      try {
        const bytes = await downloadOne(base, f);
        console.log(`  [下载] public/${f.dest}  ${(bytes / 1024 / 1024).toFixed(2)}MB  ← ${host}`);
        done = true;
        break;
      } catch (err) {
        errors.push(`${host}: ${err.message}`);
      }
    }
    if (!done) {
      throw new Error(
        `tesseract 语言模型下载失败：${f.dest}\n` +
          errors.map((e) => `  · ${e}`).join('\n') +
          `\n\n可设 OCR_TESSDATA_SOURCE 指向可达的镜像，例如：\n` +
          `  OCR_TESSDATA_SOURCE=https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0_best_int`,
      );
    }
  }

  if (copied === 0) {
    console.log('  tesseract 资产已齐备，无需搬运/下载。');
  } else {
    console.log('  tesseract 资产已放入 public/（由 .gitignore 排除，不随仓库分发）');
  }
}

main().catch((err) => {
  console.error(`[fetch-tess-assets] ${err.message}`);
  process.exit(1);
});
