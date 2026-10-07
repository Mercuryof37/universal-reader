/**
 * OCR 模型的下载来源。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么不能直接用包内置的 V6_SMALL_MODEL
 * ═══════════════════════════════════════════════════════════════
 *
 * `ppu-paddle-ocr` 内置的 `V6_SMALL_MODEL` 三个文件**全部挂在 huggingface.co 上**：
 *
 *   https://huggingface.co/snowfluke/ppu-paddle-ocr-models/resolve/main/detection/ort/PP-OCRv6_small_det.ort
 *   https://huggingface.co/snowfluke/ppu-paddle-ocr-models/resolve/main/recognition/ort/PP-OCRv6_small_rec.ort
 *   https://huggingface.co/snowfluke/ppu-paddle-ocr-models/resolve/main/recognition/ppocrv6_dict.txt
 *
 * 而**国内网络访问不了 huggingface.co**。本机实测：
 *   huggingface.co:443        → 不通
 *   cdn-lfs.huggingface.co:443 → 不通
 *   hf-mirror.com:443         → 通（这三个文件都能下载，合计 29.9MB）
 *
 * 后果不是「慢」，而是**整条功能彻底不可用**：模型一个字节都取不到，
 * OCR 引擎永远停在初始化，扫描版 PDF 一页都识别不出来。
 * 用户看到的现象是「一直显示读取中／正在初始化，最后什么都没有」，
 * 而且因为超时长达 180 秒、最后才报错，很容易被误判成「页面卡住了」
 * 甚至「页面自己刷新了」。**文字版 PDF / Markdown / TXT / EPUB 完全不受影响** ——
 * 因为它们不需要 OCR，这也正是「问题集中在扫描版 PDF」的原因。
 *
 * ═══════════════════════════════════════════════════════════════
 * 怎么改来源
 * ═══════════════════════════════════════════════════════════════
 *
 * 设 `VITE_OCR_MODEL_BASE` 即可，无需改代码：
 *
 *   VITE_OCR_MODEL_BASE=https://huggingface.co/snowfluke/ppu-paddle-ocr-models/resolve/main
 *     官方源（海外网络更合适）
 *
 *   VITE_OCR_MODEL_BASE=/ocr-models
 *     自托管：把三个文件按下面的目录结构放进 `public/ocr-models/`，
 *     就彻底不依赖任何外部站点（也顺带满足离线与隐私诉求）
 *
 * 不设则默认走下面的国内镜像。文件名与目录结构三个来源完全一致，
 * 因此互相之间可以随时切换。
 */

/** 官方源（国内不可达，保留作为显式选项与文档参照） */
export const OFFICIAL_MODEL_BASE =
  'https://huggingface.co/snowfluke/ppu-paddle-ocr-models/resolve/main';

/** 国内可用的镜像；与官方源是同一份文件 */
export const MIRROR_MODEL_BASE = 'https://hf-mirror.com/snowfluke/ppu-paddle-ocr-models/resolve/main';

/** 三个文件相对于 base 的路径（三个来源共用同一套结构） */
export const OCR_MODEL_FILES = {
  detection: 'detection/ort/PP-OCRv6_small_det.ort',
  recognition: 'recognition/ort/PP-OCRv6_small_rec.ort',
  charactersDictionary: 'recognition/ppocrv6_dict.txt',
} as const;

/** 实际使用的 base：环境变量优先，否则国内镜像 */
export function resolveModelBase(): string {
  const configured = import.meta.env.VITE_OCR_MODEL_BASE;
  if (configured && configured.trim()) return configured.trim().replace(/\/+$/, '');
  return MIRROR_MODEL_BASE;
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
