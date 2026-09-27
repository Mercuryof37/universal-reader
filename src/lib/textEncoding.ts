/**
 * 文本文件的编码识别。
 *
 * 为什么必须专门处理：浏览器原生的 `File.text()` 一律按 UTF-8 解码，
 * 而中文 Windows 环境下导出的 .txt 有相当比例是 GBK/ANSI，
 * 记事本另存的"Unicode"则是 UTF-16LE。
 * 直接用 text() 读这些文件会得到一整片替换字符（），
 * 用户看到的现象就是"文件打开了但内容是空的/乱码"。
 *
 * 识别策略（按可靠性从高到低）：
 * 1. 看 BOM —— 最可靠，UTF-8 / UTF-16 都会带；
 * 2. 按 UTF-8 解码，统计替换字符比例 —— UTF-8 是自校验编码，
 *    非 UTF-8 字节几乎必然产生 U+FFFD，这是很强的信号；
 * 3. 回退到 GB18030 —— 它是 GBK 的超集，能覆盖简体、繁体与生僻字，
 *    且对纯 ASCII 无害，因此是中文环境最安全的兜底编码。
 */

export interface DecodeResult {
  text: string;
  /** 实际使用的编码，用于在界面上提示用户 */
  encoding: string;
  /** 是否存在替换字符（说明可能仍然解码有误） */
  lossy: boolean;
}

/** 替换字符 U+FFFD，解码失败的标志 */
const REPLACEMENT = '\uFFFD';

export async function readTextFile(file: File): Promise<DecodeResult> {
  const buffer = await file.arrayBuffer();
  return decodeBuffer(buffer);
}

export function decodeBuffer(buffer: ArrayBuffer): DecodeResult {
  const bytes = new Uint8Array(buffer);

  // 1. BOM 嗅探
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return finish(decode(bytes.subarray(3), 'utf-8'), 'UTF-8 (BOM)');
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return finish(decode(bytes.subarray(2), 'utf-16le'), 'UTF-16LE');
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    // TextDecoder 没有 utf-16be，手动交换字节后按 LE 解码
    const swapped = new Uint8Array(bytes.length - 2);
    for (let i = 2; i + 1 < bytes.length; i += 2) {
      swapped[i - 2] = bytes[i + 1]!;
      swapped[i - 1] = bytes[i]!;
    }
    return finish(decode(swapped, 'utf-16le'), 'UTF-16BE');
  }

  // 没有 BOM：先按 UTF-8 试
  const asUtf8 = decode(bytes, 'utf-8');
  const badRatio = replacementRatio(asUtf8);

  if (badRatio === 0) return { text: asUtf8, encoding: 'UTF-8', lossy: false };

  // 替换字符比例很低时可能是个别坏字节，不冒险改变编码
  if (badRatio < 0.002) return { text: asUtf8, encoding: 'UTF-8', lossy: true };

  // 2. 疑似非 UTF-8，尝试 GB18030（GBK 超集）
  const asGb = decode(bytes, 'gb18030');
  if (replacementRatio(asGb) < badRatio) {
    return finish(asGb, 'GB18030 / GBK');
  }

  // 3. 兜底：保持 UTF-8 结果，但标记为有损，让界面能提示用户
  return { text: asUtf8, encoding: 'UTF-8', lossy: true };
}

function decode(bytes: Uint8Array, encoding: string): string {
  try {
    return new TextDecoder(encoding, { fatal: false }).decode(bytes);
  } catch {
    // 运行时不支持该编码标签时退回 UTF-8，绝不抛错中断导入
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
}

function finish(text: string, encoding: string): DecodeResult {
  return { text, encoding, lossy: replacementRatio(text) > 0.002 };
}

function replacementRatio(text: string): number {
  if (!text.length) return 0;
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === REPLACEMENT) count++;
  }
  return count / text.length;
}

/**
 * 判断文本是否"实际上没有可读内容"。
 *
 * 用于在导入后给出明确提示：全是控制字符/替换字符的"空文件"
 * 比真正的空文件更让人困惑。
 */
export function hasReadableContent(text: string): boolean {
  const meaningful = text.replace(/[\s\uFFFD\u0000-\u001f]+/g, '');
  return meaningful.length > 0;
}
