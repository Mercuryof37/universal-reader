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
 *
 * ═══════════════════════════════════════════════════════════════
 * 版面模型（第 4 个文件）为什么来自**另一个仓库**
 * ═══════════════════════════════════════════════════════════════
 *
 * `ppu-paddle-ocr-models` 里的版面模型是 PP-DocLayoutV2 / V3，
 * 实测（HEAD + HF API 双重核对）体积为
 *
 *   layout/PP-DocLayoutV2.onnx = 213,303,073 字节 = 203.42 MiB
 *   layout/PP-DocLayoutV3.onnx = 129,920,689 字节 = 123.90 MiB
 *
 * 而 Cloudflare Pages 的单个静态资源上限是 **25 MiB**
 * （官方文档 https://developers.cloudflare.com/pages/platform/limits/ ，
 * 原文 "The maximum file size for a single Cloudflare Pages site asset is 25 MiB."）。
 * 超 5–8 倍，**同源发布不可能**；而且那两个仓库里**没有**版面模型的
 * `.ort` 预转换版本（只有 `.onnx`，`layout/*.ort` 全部 404）。
 *
 * 于是改用同族的轻量版 **PP-DocLayout-S**（PicoDet-S/GFL，23 类）：
 *
 *   stefanj0/PP-DocLayout-S-ONNX/pp_doclayout_s.onnx = 4,917,852 字节 = 4.69 MiB
 *   sha256 = 33688dbee1c23e34b81777e97cb428eb40f24b242c02b5f623484959e830aec8
 *
 * 上游权重 `PaddlePaddle/PP-DocLayout-S` 是 **Apache-2.0**，
 * 与既有三个模型同源同许可；ONNX 导出件也是 Apache-2.0。
 *
 * ⚠️ 因此本项目现在有**两个**模型来源 base。二者都用
 * `OCR_MODEL_SOURCE` 的同族环境变量可以分别覆盖（见下）。
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile, stat, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MAX_SINGLE_ASSET_BYTES_ENV,
  MODEL_ASSETS,
  modelAssetUrl,
  preflightBlocksDownload,
  preflightModelTier,
  resolveMaxSingleAssetBytes,
  tierAssets,
  tierTotalBytes,
} from '../src/lib/modelCacheTiers.ts';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEST = join(ROOT, 'public', 'ocr-models');

/**
 * 要下载的文件。
 *
 * ⚠️ **这些数字来自 `src/lib/modelCacheTiers.ts` 的 `MODEL_ASSETS`，不在这里写死。**
 * 以前它们是抄在这里的字面量，于是「清单说 9,982,352、实际产物是别的字节数」
 * 这种事只能靠人眼发现。现在路径、字节数、sha256 全部由那一个模块提供，
 * 运行时容量预检查用的也是同几个数字 —— 一处改，两边同时改。
 *
 * `bytes` 用于判断「是否已经取过」（±1% 容差，不同镜像的 Content-Length
 * 偶尔有细微差异）。`sha256` 只在**声明过**的文件上校验 ——
 * 既有三个文件的上游没有提供哈希，凭空写一个等于自欺；
 * 版面模型那一份来源仓库自带声明，且已在交付前实测比对通过。
 *
 * `source` 指这份文件属于哪一组来源 base（两组文件在不同的仓库里）。
 */
const FILES = tierAssets('standard').map((id) => {
  const asset = MODEL_ASSETS[id];
  return {
    id,
    path: asset.path,
    bytes: asset.bytes,
    ...(asset.sha256 ? { sha256: asset.sha256 } : {}),
    // 版面分析的远端路径与本地存放路径不一样，必须分开写：
    //   · 本地要放进 `layout/` 子目录（与 det/rec 的组织方式一致）；
    //   · 而它在 HuggingFace 仓库里是**根目录**下的 `pp_doclayout_s.onnx`。
    // 早先只写了 `path`，于是拼出的 URL 是
    // `.../resolve/main/layout/PP-DocLayout-S.onnx` → **404**，构建直接失败。
    // 实测正确地址（hf-mirror，HTTP 200、长度与期望值一致）：
    // `.../stefanj0/PP-DocLayout-S-ONNX/resolve/main/pp_doclayout_s.onnx`
    ...(id === 'layout' ? { remote: 'pp_doclayout_s.onnx' } : {}),
    source: id === 'layout' ? 'layout' : 'ocr',
  };
});

/**
 * 下载来源，按顺序尝试。**按文件分组**：两组文件在不同的仓库里。
 *
 * 国内镜像放第一位：本地开发/构建最可能在这里成功。
 * 官方源放第二位：Cloudflare / GitHub 的构建环境在境外，通常只有它能通。
 */
const SOURCES = {
  ocr: [
    process.env.OCR_MODEL_SOURCE,
    'https://hf-mirror.com/snowfluke/ppu-paddle-ocr-models/resolve/main',
    'https://huggingface.co/snowfluke/ppu-paddle-ocr-models/resolve/main',
  ].filter(Boolean),
  layout: [
    process.env.OCR_LAYOUT_MODEL_SOURCE,
    'https://hf-mirror.com/stefanj0/PP-DocLayout-S-ONNX/resolve/main',
    'https://huggingface.co/stefanj0/PP-DocLayout-S-ONNX/resolve/main',
  ].filter(Boolean),
};

/**
 * 已存在且大小合理就跳过 —— 让重复构建不必再下 35MB。
 *
 * ⚠️ 有 `sha256` 声明的文件**必须**比哈希，而且**哈希不符要重下**：
 * 只比字节数的话，「大小刚好一样但内容被截断/损坏/换了版本」会一路
 * 通过到运行期，表现为模型加载失败或（更糟）输出垃圾区域而**不报错**。
 */
async function alreadyPresent(file) {
  try {
    const full = join(DEST, file.path);
    const s = await stat(full);
    // 允许 ±1% 的偏差：不同镜像的 Content-Length 偶尔会有细微差异
    if (Math.abs(s.size - file.bytes) > file.bytes * 0.01) return false;
    if (file.sha256) {
      const actual = createHash('sha256').update(await readFile(full)).digest('hex');
      if (actual !== file.sha256) {
        console.warn(`  [校验失败] ${file.path} 的 sha256 不符，将重新下载`);
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

async function download(base, file) {
  const url = `${base.replace(/\/+$/, '')}/${file.remote ?? file.path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength < 1024) {
    throw new Error(`内容过小（${buf.byteLength} 字节），可能不是模型文件`);
  }
  // 声明了哈希就当场验：不然「下到一个 200 的错误页/半截文件」会静默通过
  if (file.sha256) {
    const actual = createHash('sha256').update(buf).digest('hex');
    if (actual !== file.sha256) {
      throw new Error(
        `sha256 不符（期望 ${file.sha256.slice(0, 16)}…，实得 ${actual.slice(0, 16)}…）` +
          ` —— 来源内容与预期不一致，拒绝写入`,
      );
    }
  }
  const dest = join(DEST, file.path);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, buf);
  return buf.byteLength;
}

async function main() {
  /**
   * `--self-check`：**只做预检查与逐项对照，不联网、不落盘、不下载。**
   *
   * 存在的理由只有一个：`src/lib/modelCacheTiers.test.ts` 需要一条
   * **真的把这个脚本跑起来**的用例 —— 「`from '../src/lib/modelCacheTiers'`
   * 能不能被解析」这种事任何 `toMatch` 都验不出来（路径写错时文本照样匹配），
   * 只有进程真的起来才算数。而正常路径会去联网下载 35MB，测试不能那么干。
   */
  const selfCheck = process.argv.includes('--self-check');

  const pending = [];
  const onDiskIds = [];
  if (!selfCheck) {
    for (const f of FILES) {
      if (await alreadyPresent(f)) {
        console.log(`  [已有] ${f.path}`);
        onDiskIds.push(f.id);
      } else {
        pending.push(f);
      }
    }
  }

  /**
   * ═══════════════════════════════════════════════════════════
   * ⚠️ **容量预检查：必须在第一个字节被取之前**
   * ═══════════════════════════════════════════════════════════
   *
   * 用的是运行时那一套判断（同一个 `preflightModelTier`），因为它要拦的是
   * 同一个失败：**某个资产超过 Cloudflare Pages 的单文件 25 MiB 上限**。
   * 那件事的唯一表现是「部署时报错」，而本地构建、类型检查、单元测试**全绿**
   * —— 所以它必须在构建期就拦下来，而不是等到产物门禁（`verify-dist.mjs`）
   * 或者真的部署那一步。
   *
   * 只把**本地还没有**的那些算作「本次要取的字节」（`cachedKeys`）：
   * 已经落盘的不重复计入 —— 与运行时把「已命中缓存」排除在外是同一个口径。
   *
   * ⚠️ 覆盖范围要说清：`FILES` 来自 `tierAssets('standard')`，也就是
   * **默认档位**那一套。将来某个档位若引入自己的新资产（例如 fast 档改用
   * tiny 模型），那一档的预检查在**它自己**的路径上跑
   * （运行时 `ensureModelTierAssets` 会跑），这里的字面量要一起改。
   */
  const preflight = preflightModelTier('standard', {
    cachedKeys: onDiskIds.map((id) => modelAssetUrl(id)),
    // 默认就是 25 MiB 口径；环境变量只为让测试能造出「超限」这个情况
    // （见 src/lib/modelCacheTiers.ts 里 MAX_SINGLE_ASSET_BYTES 的说明）
    maxSingleAssetBytes: resolveMaxSingleAssetBytes(process.env[MAX_SINGLE_ASSET_BYTES_ENV]),
  });
  if (preflightBlocksDownload(preflight)) {
    throw new Error(
      `容量预检查未通过，**未下载任何文件**：\n  · ${preflight.detail}\n` +
        `  判断用的数字：单文件上限 ${preflight.numbers.maxSingleAssetBytes} 字节`,
    );
  }

  if (selfCheck) {
    // 没有落盘扫描 ⇒ 四个都算「本次要取的」，预检查会把它们逐个对照一遍
    console.log(
      `  容量预检查通过：${preflight.items.length} 个文件，合计 ${(
        preflight.totalBytes /
        1024 /
        1024
      ).toFixed(2)}MB（单文件 25MiB 上限已逐个对照）`,
    );
    reportAssetBudget('standard');
    console.log('  [self-check] 未联网、未写入任何文件。');
    return;
  }
  if (!pending.length) {
    console.log('  OCR 模型已齐备，无需下载。');
    reportAssetBudget('standard');
    return;
  }

  console.log(`  需要下载 ${pending.length} 个模型文件…`);
  console.log(
    `  容量预检查通过：${preflight.items.length} 个文件，合计 ${(
      preflight.totalBytes /
      1024 /
      1024
    ).toFixed(2)}MB（单文件 25MiB 上限已逐个对照）`,
  );

  for (const f of pending) {
    let done = false;
    const errors = [];
    for (const base of SOURCES[f.source]) {
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
      const envHint =
        f.source === 'layout' ? 'OCR_LAYOUT_MODEL_SOURCE' : 'OCR_MODEL_SOURCE';
      throw new Error(
        `OCR 模型下载失败：${f.path}\n` +
          errors.map((e) => `  · ${e}`).join('\n') +
          `\n\n可设 ${envHint} 指向可达的镜像，例如：\n` +
          `  ${envHint}=https://your-mirror.example.com/<repo>/resolve/main`,
      );
    }
  }

  console.log('  OCR 模型已放入 public/ocr-models/（由 .gitignore 排除，不随仓库分发）');
  reportAssetBudget('standard');
}

/**
 * 把「**每个资产**与 25 MiB 的对照」打出来。
 *
 * 这一行是给人看的账：新增任何一个资产时，**先在这里看到它的占比**，
 * 而不是等到部署失败。任何一项超限即**抛错**（构建必须停下来）——
 * 判断用的是 `MODEL_ASSETS` 里那几个数字，与运行时 `preflightModelTier`
 * 读的是同一份，**上限也是同一个来源**（`resolveMaxSingleAssetBytes`），
 * 免得「预检查按 25 MiB、这张表按另一个数」两处口径分家。
 */
function reportAssetBudget(tier) {
  const maxBytes = resolveMaxSingleAssetBytes(process.env[MAX_SINGLE_ASSET_BYTES_ENV]);
  const over = [];
  const lines = tierAssets(tier).map((id) => {
    const asset = MODEL_ASSETS[id];
    if (asset.bytes > maxBytes) over.push(asset.path);
    const pct = ((asset.bytes / maxBytes) * 100).toFixed(1);
    return `      ${asset.path} = ${(asset.bytes / 1024 / 1024).toFixed(2)}MiB（上限的 ${pct}%）`;
  });

  console.log(
    `  档位 ${tier} 的资产预算：${tierAssets(tier).length} 个文件，合计 ` +
      `${(tierTotalBytes(tier) / 1024 / 1024).toFixed(2)}MiB（单文件上限 ${maxBytes} 字节）`,
  );
  console.log(lines.join('\n'));

  if (over.length) {
    throw new Error(
      `有资产超过单文件上限 ${maxBytes} 字节：${over.join(', ')} —— ` +
        `这个站点**部署不上去**（本地构建与单元测试都不会报错）`,
    );
  }
}

main().catch((err) => {
  console.error(`[fetch-ocr-models] ${err.message}`);
  process.exit(1);
});
