/**
 * SimpleTex 公式 OCR 服务。
 *
 * 将图片中的数学公式识别为 LaTeX，通过 Cloudflare Worker 代理调用 SimpleTex API。
 * 用于扫描版 PDF 中公式区域的精确识别（替代通用 OCR 对公式的低质量输出）。
 */

const MAX_IMAGE_SIZE = 2_000_000;

function getEndpoint(): string {
  const endpoint = import.meta.env.VITE_TRANSLATE_ENDPOINT;
  if (!endpoint) throw new Error('未配置 VITE_TRANSLATE_ENDPOINT');
  return endpoint.replace(/\/$/, '') + '/api/formula-ocr';
}

export async function recognizeFormula(
  imageData: HTMLCanvasElement | OffscreenCanvas | ImageData,
  signal?: AbortSignal,
): Promise<string> {
  const buffer = await toPngBuffer(imageData);

  if (buffer.byteLength > MAX_IMAGE_SIZE) {
    throw new Error('公式图片过大，请缩小裁剪区域');
  }

  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const base64 = btoa(binary);

  const resp = await fetch(getEndpoint(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: base64 }),
    signal,
  });

  if (!resp.ok) {
    const data = (await resp.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || `公式识别失败 (${resp.status})`);
  }

  const data = (await resp.json()) as { latex?: string };
  if (!data.latex) throw new Error('SimpleTex 未返回 LaTeX');
  return data.latex;
}

async function toPngBuffer(
  source: HTMLCanvasElement | OffscreenCanvas | ImageData,
): Promise<ArrayBuffer> {
  if (source instanceof ImageData) {
    const canvas = document.createElement('canvas');
    canvas.width = source.width;
    canvas.height = source.height;
    canvas.getContext('2d')!.putImageData(source, 0, 0);
    source = canvas;
  }

  if (source instanceof OffscreenCanvas) {
    const blob = await source.convertToBlob({ type: 'image/png' });
    return blob.arrayBuffer();
  }

  return new Promise((resolve, reject) => {
    source.toBlob(
      (blob) => {
        if (!blob) reject(new Error('toBlob returned null'));
        else blob.arrayBuffer().then(resolve, reject);
      },
      'image/png',
    );
  });
}
