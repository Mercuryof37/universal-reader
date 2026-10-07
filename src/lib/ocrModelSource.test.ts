import { describe, expect, it } from 'vitest';

import {
  MIRROR_MODEL_BASE,
  OFFICIAL_MODEL_BASE,
  OCR_MODEL_BASE,
  OCR_MODEL_FILES,
  SELF_HOSTED_MODEL_BASE,
  buildOcrModel,
} from '@/lib/ocrModelSource';

/**
 * OCR 模型来源。
 *
 * ═══════════════════════════════════════════════════════════════
 * 这组断言对应一次「整条功能不可用」的故障，而且踩了三次坑
 * ═══════════════════════════════════════════════════════════════
 *
 * 现象：扫描版 PDF 一直显示初始化、最后什么都没有。
 *
 * 1. 包内置的模型预设三个文件**全在 huggingface.co 上**，而国内**不可达** ——
 *    一个字节都取不到，引擎永远初始化不了。
 * 2. 换国内镜像 hf-mirror.com：PowerShell 探测通、Node 完整下载了 29.9MB、
 *    响应还带**正确的 CORS 头**……但**用户的浏览器仍然报**
 *    `TypeError: Failed to fetch`。
 * 3. 结论：**不能让浏览器去任何第三方取模型。** 改为构建时取一次、
 *    与站点**同源**发布 —— 同源请求不受代理/扩展/DNS/CORS 这些差异影响。
 *
 * 所以这里钉死：**默认来源必须是同源路径，绝不能是任何第三方主机。**
 */

describe('OCR 模型来源', () => {
  it('默认来源是同源路径，不是任何第三方主机', () => {
    // 这是本组测试的核心：只要默认值又变回外部域名，OCR 就可能再次整体失效
    expect(OCR_MODEL_BASE).toBe(SELF_HOSTED_MODEL_BASE);
    expect(OCR_MODEL_BASE).not.toContain('huggingface.co');
    expect(OCR_MODEL_BASE).not.toContain('hf-mirror.com');
    expect(OCR_MODEL_BASE.startsWith('/')).toBe(true);
  });

  it('同源路径以 /ocr-models 结尾，与 prebuild 脚本的落盘位置一致', () => {
    expect(SELF_HOSTED_MODEL_BASE.endsWith('/ocr-models')).toBe(true);
  });

  it('三个文件名与包里内置预设保持一致（换主机不换结构）', () => {
    // 这三个路径直接对应 ppu-paddle-ocr 的 V6_SMALL_MODEL，
    // 也正是 scripts/fetch-ocr-models.mjs 落盘时用的相对路径
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

  it('默认 base 能拼出可用的同源 URL', () => {
    const model = buildOcrModel();
    expect(model.detection).toBe(`${SELF_HOSTED_MODEL_BASE}/detection/ort/PP-OCRv6_small_det.ort`);
    expect(model.detection.startsWith('/')).toBe(true);
    expect(model.detection).not.toContain('//detection');
  });

  it('base 末尾的斜杠不会拼出双斜杠', () => {
    const model = buildOcrModel('https://example.test/models/');
    expect(model.detection).not.toContain('models//');
  });

  it('三个来源可以互换 —— 官方源与镜像源的路径结构完全相同', () => {
    // 这样 VITE_OCR_MODEL_BASE 才能在「同源 / 官方 / 镜像」之间随意切换
    const official = buildOcrModel(OFFICIAL_MODEL_BASE);
    const mirror = buildOcrModel(MIRROR_MODEL_BASE);

    expect(official.detection.replace(OFFICIAL_MODEL_BASE, '')).toBe(
      mirror.detection.replace(MIRROR_MODEL_BASE, ''),
    );
    expect(official.charactersDictionary.replace(OFFICIAL_MODEL_BASE, '')).toBe(
      mirror.charactersDictionary.replace(MIRROR_MODEL_BASE, ''),
    );
  });
});
