/**
 * SimpleTex 公式 OCR 服务。
 *
 * 将图片中的数学公式识别为 LaTeX，通过 Cloudflare Worker 代理调用 SimpleTex API。
 * 用于扫描版 PDF 中公式区域的精确识别（替代通用 OCR 对公式的低质量输出）。
 *
 * ⚠️ 这是三条会把文档内容送出本机的路径之一。**不是「唯一」** ——
 * 这个口径以前写在这里，是错的，也是「本机外发记录」那个审计缺口
 * 被低估成三分之一的根因：另外两条是云端翻译（`translationService.ts`
 * 的 `translateWithProxy`）与云端语音（`ttsEngine.ts` 的 `CloudTTSEngine`）。
 * 三条共用同一套四要素，清单见 `lib/outboundPaths.ts`（并被设置面板渲染）。
 *
 * 因此它自己也要检查隐私开关（见下方 `recognizeFormula` 的第二道防线），
 * 而不是只依赖调用方自觉。
 */

import { useSettingsStore } from '@/store/settingsStore';

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
  /**
   * 第二道防线。
   *
   * `ocrEngine.enhanceFormulaRegions()` 已经会在开关关闭时提前返回，
   * 但那是**调用方**的自律。真正执行上传的是这个函数，所以它必须自己拒绝 ——
   * 否则将来任何一个新调用方只要忘了检查，就会静默把文档内容发出去。
   *
   * 这里选择抛错而不是静默返回空串：万一真被绕过，
   * 调用方会看到明确原因，而不是拿到一个莫名其妙的空结果。
   */
  if (!useSettingsStore.getState().formulaOcrEnabled) {
    throw new Error(
      '公式云端识别已在设置中关闭（formulaOcrEnabled = false），已拒绝上传。',
    );
  }

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
