/**
 * 将 OCR 识别结果作为不可见文字层写回 PDF。
 *
 * 使用 pdf-lib 在原始 PDF 的每一页上叠加透明文本，
 * 使导出的 PDF 在外部阅读器中可选中、可搜索。
 *
 * 坐标系转换：
 * - OCR 坐标：原点左上角，单位像素（渲染 DPI）
 * - PDF 坐标：原点左下角，单位 point（1/72 inch）
 * - Y 轴需要翻转，X/Y 都需要按缩放比映射
 */
import { PDFDocument, rgb } from 'pdf-lib';
import type { OcrPageResult } from '@/lib/ocrTypes';

export interface TextLayerOptions {
  originalPdfBytes: ArrayBuffer;
  ocrResults: OcrPageResult[];
  /** OCR 渲染时的 DPI，默认 300 */
  renderDpi?: number;
}

export async function addTextLayerToPdf(options: TextLayerOptions): Promise<Uint8Array> {
  const { originalPdfBytes, ocrResults, renderDpi = 300 } = options;

  const pdfDoc = await PDFDocument.load(originalPdfBytes, { ignoreEncryption: true });
  const scale = renderDpi / 72;

  for (const result of ocrResults) {
    const pageIndex = result.pageNum - 1;
    if (pageIndex < 0 || pageIndex >= pdfDoc.getPageCount()) continue;

    const page = pdfDoc.getPage(pageIndex);
    const { height } = page.getSize();

    for (const word of result.words) {
      if (!word.text.trim()) continue;

      const pdfX = word.bbox.x0 / scale;
      const pdfY = height - word.bbox.y1 / scale;
      const fontSize = Math.max(1, Math.abs(word.bbox.y1 - word.bbox.y0) / scale * 0.85);

      try {
        page.drawText(word.text, {
          x: pdfX,
          y: pdfY,
          size: fontSize,
          color: rgb(1, 1, 1),
          opacity: 0,
        });
      } catch {
        // 个别字符编码失败不影响整体
      }
    }
  }

  return pdfDoc.save();
}
