import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { PdfParser } from '@/parsers/pdfParser';
import { describeOpenFailure } from '@/parsers/pdfParser';
import { isScannedPdfError, type ScannedPdfError } from '@/parsers/scannedPdfError';
import '@/lib/polyfills';

/**
 * 真实 PDF 回归测试（条件执行，文件不存在时整个套件跳过）。
 *
 * 合成 PDF 只能验证算法；真实文件的排版怪癖与元数据结构无法靠夹具覆盖。
 * 这里覆盖两类真实样本：
 * - 普通文字版 PDF：必须能完整解析出内容（这是最主流的用例）；
 * - 扫描版 PDF：必须被准确识别并给出 OCR 建议，而不是抛底层错误。
 *
 * 想加入自己的样本，设置环境变量 REAL_PDF_PATH / REAL_SCAN_PATH 即可。
 */

const TEXT_PDF =
  process.env.REAL_PDF_PATH ??
  'C:\\Users\\Li Peilin\\.dsh\\attachments\\v1\\files\\71\\7116f67677dcf76d585eac90976eebd6c10bdde219bd960d3002c240c300fed0\\国庆作业答案4.pdf';

const SCAN_PDF =
  process.env.REAL_SCAN_PATH ??
  'C:\\Users\\Li Peilin\\.dsh\\attachments\\v1\\files\\df\\dfa7f379cf10f9a331445d90286d7b5528c90df532e857add724f8996c621f26\\深入理解计算机系统（中文清晰).pdf';

async function loadAsFile(path: string): Promise<File> {
  const buffer = await readFile(path);
  return {
    name: path.split('\\').pop() ?? 'sample.pdf',
    size: buffer.byteLength,
    arrayBuffer: async () =>
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  } as unknown as File;
}

describe.skipIf(!existsSync(TEXT_PDF))('真实文字版 PDF', () => {
  it('能完整解析出内容块，且保留中文文本与页码', async () => {
    const parser = new PdfParser();
    const doc = await parser.parse(await loadAsFile(TEXT_PDF));

    // 这份样本是 7 页的生物作业答案，文本量不大但结构完整
    expect(doc.format).toBe('pdf');
    expect(doc.blocks.length).toBeGreaterThan(10);

    const all = doc.blocks.map((b) => b.content).join('\n');
    expect(all).toContain('答案');
    // 必须真正提取到中文，而不是空壳
    expect(all.replace(/\s/g, '').length).toBeGreaterThan(500);
    // 页码要落在块上，否则无法做"回跳原页"
    expect(doc.blocks.some((b) => (b.metadata.pageNumber ?? 0) >= 2)).toBe(true);
  }, 120_000);
});

describe.skipIf(!existsSync(SCAN_PDF))('真实扫描版 PDF', () => {
  it('被准确识别为扫描版并给出可执行的处置建议', async () => {
    let caught: Error | null = null;
    try {
      await new PdfParser().parse(await loadAsFile(SCAN_PDF));
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).not.toBeNull();
    expect(caught!.message).not.toContain('toHex');
    expect(caught!.message).toContain('扫描');
    expect(caught!.message).toMatch(/OCR|ocrmypdf/);
  }, 300_000);

  it('错误对象携带的 buffer 必须可用（OCR 流程依赖它）', async () => {
    // 这是「Cannot perform Construct on a detached ArrayBuffer」的回归防线。
    // pdf.js 会把传入的 ArrayBuffer 转移给 worker，若直接把原始 buffer 交给它，
    // ScannedPdfError 拿到的就是一个已分离的 buffer（byteLength 为 0），
    // 用户点击"开始识别"时才会失败 —— 那时离真正的原因已经很远。
    let caught: unknown = null;
    try {
      await new PdfParser().parse(await loadAsFile(SCAN_PDF));
    } catch (err) {
      caught = err;
    }

    expect(isScannedPdfError(caught)).toBe(true);
    const error = caught as ScannedPdfError;

    // 关键断言：buffer 未分离，且长度与文件大小一致
    expect(error.buffer.byteLength).toBeGreaterThan(0);
    expect(error.buffer.byteLength).toBe(error.fileSize);

    // 能真的读出字节内容（分离的 buffer 会在这一步抛错）
    const head = new Uint8Array(error.buffer, 0, 5);
    expect(String.fromCharCode(...head)).toBe('%PDF-');
  }, 300_000);
});

describe('describeOpenFailure：把底层错误翻译成人话', () => {
  it('缺 toHex 时点名 API 并给出强刷与升级建议', () => {
    const message = describeOpenFailure(new TypeError('a.toHex is not a function'));
    expect(message).toContain('toHex');
    expect(message).toContain('Ctrl+Shift+R');
    // 必须保留原始错误，便于排查时对照
    expect(message).toContain('a.toHex is not a function');
  });

  it('缺 withResolvers 时给出升级建议', () => {
    const message = describeOpenFailure(new Error('Promise.withResolvers is not a function'));
    expect(message).toContain('withResolvers');
    expect(message).toContain('119');
  });

  it('加密文件给出明确说明', () => {
    const message = describeOpenFailure(new Error('No password given'));
    expect(message).toContain('加密');
  });

  it('未知错误保留原始信息，不吞掉线索', () => {
    const message = describeOpenFailure(new Error('Invalid PDF structure'));
    expect(message).toContain('Invalid PDF structure');
  });

  it('非 Error 对象被序列化成可读 JSON，而不是 [object Object]', () => {
    expect(describeOpenFailure('boom')).toContain('boom');
    // 结构化的错误对象要能把内容带出来
    // 注意：夹具里刻意避开 password/encrypt 字样，否则会命中加密分支（那是另一条用例）
    const withObject = describeOpenFailure({ code: 1, stage: 'worker-boot' });
    expect(withObject).toContain('"code":1');
    expect(withObject).toContain('worker-boot');
    expect(withObject).not.toContain('[object Object]');
  });

  it('结构化的加密错误也能被识别', () => {
    // pdf.js 有时抛对象而不是 Error，此时也不能漏掉加密判定
    expect(describeOpenFailure({ name: 'PasswordException', message: 'No password given' })).toContain(
      '加密',
    );
    expect(describeOpenFailure({ reason: 'encrypted' })).toContain('加密');
  });

  it('抛出 undefined 时也必须得到可读文本，而不是 "undefined"', () => {
    // 真实故障：OCR 失败时界面显示 "OCR 识别失败：undefined"，信息量为零。
    // 根因是捕获方写了 (err as Error).message。
    const message = describeOpenFailure(undefined);
    expect(message).toContain('PDF 打开失败');
    expect(message).toContain('未提供任何错误信息');
    // 不能是一句光秃秃的 undefined
    expect(message.replace(/\s/g, '')).not.toBe('PDF打开失败：undefined');
  });

  it('抛出 Symbol 时也不崩', () => {
    expect(() => describeOpenFailure(Symbol('worker-crash'))).not.toThrow();
    expect(describeOpenFailure(Symbol('worker-crash'))).toContain('worker-crash');
  });
});
