import { describe, expect, it } from 'vitest';
import { copyForPdfJs } from '@/parsers/pdfParser';
import { ScannedPdfError, isScannedPdfError } from '@/parsers/scannedPdfError';

/**
 * ArrayBuffer 分离（detach）语义的回归测试。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么需要这组测试
 * ═══════════════════════════════════════════════════════════════
 *
 * pdf.js 在**使用独立 Worker 时**会把 `data` 传入的 ArrayBuffer
 * **转移（transfer）** 给 worker。转移之后主线程这一侧的 buffer 变为
 * "已分离"状态 —— `byteLength` 归零，任何读取都抛：
 *
 *     TypeError: Cannot perform Construct on a detached ArrayBuffer
 *
 * 这个缺陷打断的是 **OCR 流程**：它需要复用同一份字节做两件事 ——
 * 先解析一遍判定是否为扫描件，之后再用同一份字节逐页渲染。
 * 第一次解析把 buffer 吃掉后，第二次就失败了。
 *
 * 用 `structuredClone(buffer, { transfer: [buffer] })` 可以在 Node 里
 * **真实复现**转移语义，因此这个测试不是模拟，而是精确复现。
 */

/** 构造一个有确定内容的 buffer，用于验证拷贝后内容不变 */
function makeBuffer(size = 64): ArrayBuffer {
  const buffer = new ArrayBuffer(size);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < size; i++) view[i] = i % 256;
  return buffer;
}

/** 模拟 pdf.js 的行为：把 buffer 转移走（原 buffer 随即分离） */
function transferAway(buffer: ArrayBuffer): void {
  structuredClone(buffer, { transfer: [buffer] });
}

describe('ArrayBuffer 分离语义（复现线上故障的机制）', () => {
  it('转移后原 buffer 分离：byteLength 归零，且构造视图抛错', () => {
    const buffer = makeBuffer();
    expect(buffer.byteLength).toBe(64);

    transferAway(buffer);

    expect(buffer.byteLength).toBe(0);
    // 这一条就是用户看到的报错原文
    expect(() => new Uint8Array(buffer)).toThrow(/detached ArrayBuffer/);
  });

  it('分离之后无法通过 slice 恢复 —— 所以必须提前拷贝', () => {
    const buffer = makeBuffer();
    transferAway(buffer);

    // 这解释了为什么"事后再补救"是行不通的
    expect(() => buffer.slice(0)).toThrow(/detached ArrayBuffer/);
  });
});

describe('copyForPdfJs', () => {
  it('原始 buffer 在拷贝被转移后仍然可用、内容不变', () => {
    const original = makeBuffer();
    const copy = copyForPdfJs(original);

    // 交给 pdf.js 的那一份被转移走
    transferAway(copy);

    // 原始 buffer 必须完好 —— 这是 OCR 能继续工作的前提
    expect(original.byteLength).toBe(64);
    expect(() => new Uint8Array(original)).not.toThrow();
    expect(new Uint8Array(original)[10]).toBe(10);
  });

  it('拷贝与原始内容一致，且不是同一个对象', () => {
    const original = makeBuffer();
    const copy = copyForPdfJs(original);

    expect(copy).not.toBe(original);
    expect(new Uint8Array(copy)).toEqual(new Uint8Array(original));

    // 修改拷贝不影响原始（确认是深拷贝而非共享视图）
    new Uint8Array(copy)[0] = 255;
    expect(new Uint8Array(original)[0]).toBe(0);
  });

  it('空 buffer 也能安全处理', () => {
    const empty = new ArrayBuffer(0);
    const copy = copyForPdfJs(empty);
    expect(copy.byteLength).toBe(0);
  });
});

describe('ScannedPdfError 携带的 buffer 必须可用', () => {
  it('buffer 可用时正常构造，且能被类型守卫识别', () => {
    const buffer = makeBuffer();
    const error = new ScannedPdfError(10, buffer, 'title', 'author', 'book.pdf', buffer.byteLength);

    expect(isScannedPdfError(error)).toBe(true);
    expect(error.buffer.byteLength).toBe(64);
    expect(error.pdfBuffer.byteLength).toBe(64);
    expect(error.pageCount).toBe(10);
    expect(error.totalPages).toBe(10);
    expect(error.message).toContain('10');
  });

  it('若传入已分离的 buffer，构造时会打出诊断日志（而非静默通过）', () => {
    const buffer = makeBuffer();
    transferAway(buffer);

    // 这是"防御性诊断"：真正出错的位置（OCR 渲染）离原因很远，
    // 所以在构造错误对象时就把问题喊出来。
    const originalError = console.error;
    const logged: unknown[] = [];
    console.error = (...args: unknown[]) => void logged.push(args);

    try {
      // eslint-disable-next-line no-new
      new ScannedPdfError(10, buffer, 't', 'a', 'book.pdf', 64);
    } finally {
      console.error = originalError;
    }

    expect(logged.length).toBe(1);
    expect(String(logged[0])).toContain('已分离');
  });
});
