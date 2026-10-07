/**
 * OCR 模型的下载来源。
 *
 * ═══════════════════════════════════════════════════════════════
 * 默认：与站点同源（`/ocr-models/…`），不再让浏览器去第三方取
 * ═══════════════════════════════════════════════════════════════
 *
 * 这条结论是踩了三次坑才得到的，值得完整记下来：
 *
 * 1. `ppu-paddle-ocr` 内置的 `V6_SMALL_MODEL` 三个文件**全在 huggingface.co 上**。
 *    本机实测 `huggingface.co:443` 与 `cdn-lfs.huggingface.co:443` **都不通** ——
 *    模型一个字节都取不到，OCR 引擎永远初始化不了，扫描版 PDF 一页都识别不了。
 * 2. 于是改用国内镜像 `hf-mirror.com`。PowerShell 探测通、Node 完整下载了 29.9MB、
 *    响应还带着**正确的 CORS 头**（回显了 Origin）—— 一切看着都对。
 * 3. **但用户的浏览器仍然报**：
 *      `Failed to fetch …/PP-OCRv6_small_det.ort after 3 attempt(s): TypeError: Failed to fetch`
 *
 * 也就是说：外网通、CORS 也没问题，**浏览器就是取不到**。
 * 这类差异（代理、扩展、DNS、公司网关……）无法从代码侧根治。
 *
 * 结论：**不要让浏览器去任何第三方取模型。** 由构建脚本
 * （`scripts/fetch-ocr-models.mjs`）取一次、放进 `public/ocr-models/`、
 * 与站点同源发布。同源请求不受上述任何一项影响，而且顺带满足
 * 离线与隐私诉求（运行期不再有第三方外发）。
 *
 * ═══════════════════════════════════════════════════════════════
 * 怎么改来源
 * ═══════════════════════════════════════════════════════════════
 *
 * 设 `VITE_OCR_MODEL_BASE` 即可，无需改代码：
 *
 *   （不设）        → 同源 `/ocr-models`，即构建时取好的那份【默认】
 *   https://…       → 任意 CDN 或自建镜像
 *   https://huggingface.co/snowfluke/ppu-paddle-ocr-models/resolve/main
 *                   → 官方源（海外网络适用）
 *
 * 三个来源的文件名与目录结构完全一致，因此可以随时互换。
 */

/** 官方源（国内不可达；保留作为显式选项与文档参照） */
export const OFFICIAL_MODEL_BASE =
  'https://huggingface.co/snowfluke/ppu-paddle-ocr-models/resolve/main';

/** 国内镜像（本机可用，但**用户的浏览器实测取不到**，故不再作为默认） */
export const MIRROR_MODEL_BASE = 'https://hf-mirror.com/snowfluke/ppu-paddle-ocr-models/resolve/main';

/** 同源路径：由 scripts/fetch-ocr-models.mjs 在构建前放入 public/ocr-models/ */
export const SELF_HOSTED_MODEL_BASE = `${import.meta.env.BASE_URL}ocr-models`.replace(/\/{2,}/g, '/');

/** 三个文件相对于 base 的路径（三个来源共用同一套结构） */
export const OCR_MODEL_FILES = {
  detection: 'detection/ort/PP-OCRv6_small_det.ort',
  recognition: 'recognition/ort/PP-OCRv6_small_rec.ort',
  charactersDictionary: 'recognition/ppocrv6_dict.txt',
} as const;

/**
 * 版面分析模型相对于 base 的路径（见 `lib/layoutAnalysis.ts`）。
 *
 * ⚠️ 它**不在**上面那个对象里，因为它的来源仓库与那三个不同：
 * `ppu-paddle-ocr-models` 只有 PP-DocLayoutV2/V3（实测 203.42 MiB / 123.90 MiB，
 * 超 Cloudflare Pages 的 25 MiB 单文件上限 5–8 倍，发布不上去），
 * 因此改用轻量版 PP-DocLayout-S（4.69 MiB）。
 * 混进 `OCR_MODEL_FILES` 会让人误以为它和那三个同源，所以单列。
 */
export const LAYOUT_MODEL_FILES = {
  layout: 'layout/PP-DocLayout-S.onnx',
} as const;

/**
 * 版面模型的下载来源，按顺序尝试。
 *
 * 与 OCR 三件套一样是国内镜像优先、官方源兜底；
 * 可用 `VITE_OCR_LAYOUT_MODEL_BASE` 覆盖（自建镜像时用）。
 *
 * 导出这两个常量是为了让测试能钉住「路径结构在三个来源之间可互换」——
 * 这正是 `VITE_OCR_LAYOUT_MODEL_BASE` 能随时切换的前提。
 */
export const OFFICIAL_LAYOUT_MODEL_BASE =
  'https://huggingface.co/stefanj0/PP-DocLayout-S-ONNX/resolve/main';
export const MIRROR_LAYOUT_MODEL_BASE =
  'https://hf-mirror.com/stefanj0/PP-DocLayout-S-ONNX/resolve/main';

/** 版面模型实际使用的 base：环境变量优先，否则**同源**（构建时已取好） */
export function resolveLayoutModelBase(): string {
  const configured = import.meta.env?.VITE_OCR_LAYOUT_MODEL_BASE;
  if (configured && configured.trim()) return configured.trim().replace(/\/+$/, '');
  return SELF_HOSTED_MODEL_BASE;
}

/** 版面模型的完整同源 URL */
export function buildLayoutModelUrl(base: string = resolveLayoutModelBase()): string {
  return `${base.replace(/\/+$/, '')}/${LAYOUT_MODEL_FILES.layout}`;
}

/** 实际使用的 base：环境变量优先，否则**同源**（构建时已取好） */
export function resolveModelBase(): string {
  // `?.` 不能省：测试环境（vitest/node）下 `import.meta.env` 可能整体不存在
  const configured = import.meta.env?.VITE_OCR_MODEL_BASE;
  if (configured && configured.trim()) return configured.trim().replace(/\/+$/, '');
  return SELF_HOSTED_MODEL_BASE;
}

export const OCR_MODEL_BASE = resolveModelBase();

/**
 * 交给 `PaddleOcrService` 的模型描述。
 *
 * 结构必须与包里的 `V6_SMALL_MODEL` 一致（detection / recognition /
 * charactersDictionary 三个 URL），只是把主机换掉 ——
 * 这样既保留了官方预设的模型选择，又能绕开不可达的域名。
 */
export function buildOcrModel(base: string = OCR_MODEL_BASE): {
  detection: string;
  recognition: string;
  charactersDictionary: string;
} {
  // 去掉末尾斜杠：用户在环境变量里手写 `.../resolve/main/` 是很自然的事，
  // 不处理就会拼出 `main//detection/...` 这种双斜杠 URL。
  // `resolveModelBase()` 已经处理过默认值，但本函数是导出的，
  // 直接传入 base 的调用方（以及将来的调用点）也必须安全。
  const root = base.replace(/\/+$/, '');
  return {
    detection: `${root}/${OCR_MODEL_FILES.detection}`,
    recognition: `${root}/${OCR_MODEL_FILES.recognition}`,
    charactersDictionary: `${root}/${OCR_MODEL_FILES.charactersDictionary}`,
  };
}
