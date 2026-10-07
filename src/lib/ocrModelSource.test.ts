import { describe, expect, it } from 'vitest';

import {
  MIRROR_MODEL_BASE,
  OFFICIAL_MODEL_BASE,
  OCR_MODEL_BASE,
  OCR_MODEL_FILES,
  buildOcrModel,
} from '@/lib/ocrModelSource';

/**
 * OCR 模型来源。
 *
 * ═══════════════════════════════════════════════════════════════
 * 这组断言对应一次「整条功能不可用」的故障
 * ═══════════════════════════════════════════════════════════════
 *
 * 现象：「扫描版 PDF 一直显示读取中／正在初始化，最后什么都没有」。
 *
 * 查证结果：`ppu-paddle-ocr` 内置的模型预设三个文件**全在 huggingface.co 上**，
 * 而本机实测该域名（以及它的 LFS 主机 cdn-lfs.huggingface.co）**都不可达**。
 * 于是模型一个字节都下不下来，OCR 引擎永远初始化不了，一页都识别不出，
 * 自然也没有任何文档入库 —— 而文字版 PDF / Markdown / TXT / EPUB 完全正常，
 * 因为它们根本不走 OCR。这就是「问题集中在扫描版 PDF」的原因。
 *
 * 结论：**默认来源绝不能是那个不可达的域名。**
 */

describe('OCR 模型来源', () => {
  it('默认来源不是 huggingface.co（国内不可达，选了它等于功能不可用）', () => {
    expect(OCR_MODEL_BASE).not.toContain('huggingface.co');
    expect(OCR_MODEL_BASE).toBe(MIRROR_MODEL_BASE);
  });

  it('默认来源是 https 且不是空串', () => {
    expect(OCR_MODEL_BASE.startsWith('https://') || OCR_MODEL_BASE.startsWith('/')).toBe(true);
    expect(OCR_MODEL_BASE.length).toBeGreaterThan(0);
  });

  it('三个文件名与包里内置预设保持一致（换主机不换结构）', () => {
    // 这三个路径直接对应 ppu-paddle-ocr 的 V6_SMALL_MODEL
    expect(OCR_MODEL_FILES.detection).toBe('detection/ort/PP-OCRv6_small_det.ort');
    expect(OCR_MODEL_FILES.recognition).toBe('recognition/ort/PP-OCRv6_small_rec.ort');
    expect(OCR_MODEL_FILES.charactersDictionary).toBe('recognition/ppocrv6_dict.txt');
  });

  it('buildOcrModel 拼出三个完整 URL，且都在同一个 base 下', () => {
    const model = buildOcrModel('https://example.test/models');

    expect(model.detection).toBe('https://example.test/models/detection/ort/PP-OCRv6_small_det.ort');
    expect(model.recognition).toBe(
      'https://example.test/models/recognition/ort/PP-OCRv6_small_rec.ort',
    );
    expect(model.charactersDictionary).toBe(
      'https://example.test/models/recognition/ppocrv6_dict.txt',
    );
  });

  it('base 末尾的斜杠不会拼出双斜杠', () => {
    const model = buildOcrModel('https://example.test/models/');
    expect(model.detection).not.toContain('models//');
  });

  it('三个来源可以互换 —— 官方源与镜像源的路径结构完全相同', () => {
    // 这样 VITE_OCR_MODEL_BASE 才能在「官方 / 镜像 / 自托管」之间随意切换
    const official = buildOcrModel(OFFICIAL_MODEL_BASE);
    const mirror = buildOcrModel(MIRROR_MODEL_BASE);

    expect(official.detection.replace(OFFICIAL_MODEL_BASE, '')).toBe(
      mirror.detection.replace(MIRROR_MODEL_BASE, ''),
    );
    expect(official.charactersDictionary.replace(OFFICIAL_MODEL_BASE, '')).toBe(
      mirror.charactersDictionary.replace(MIRROR_MODEL_BASE, ''),
    );
  });

  it('自托管写法（以 / 开头的相对路径）也能拼接', () => {
    const model = buildOcrModel('/ocr-models');
    expect(model.detection).toBe('/ocr-models/detection/ort/PP-OCRv6_small_det.ort');
  });
});
