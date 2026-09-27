import { describe, expect, it } from 'vitest';
import { describeUnknownError, errorReport, logAndRethrow } from '@/lib/diagnostics';

/**
 * 错误诊断工具的测试。
 *
 * 背景：OCR 失败时界面只显示 `OCR 识别失败：undefined`，信息量为零。
 * 根因是捕获方写了 `(err as Error).message`，而 `throw` 可以抛**任何值**。
 * 这组测试把"任何抛出值都必须转成非空描述"这条不变量钉死。
 */

describe('describeUnknownError：永不返回空描述', () => {
  it('Error 用 message', () => {
    expect(describeUnknownError(new Error('磁盘已满'))).toBe('磁盘已满');
  });

  it('message 为空串时退回 name', () => {
    const err = new Error('');
    expect(describeUnknownError(err)).toBe('Error');
  });

  it('自定义错误子类用其 message', () => {
    class ScannedPdfError extends Error {}
    expect(describeUnknownError(new ScannedPdfError('是扫描版'))).toBe('是扫描版');
  });

  it('字符串原样返回', () => {
    expect(describeUnknownError('网络断开')).toBe('网络断开');
  });

  it('空字符串给出占位而不是留空', () => {
    expect(describeUnknownError('')).toBe('(空字符串)');
  });

  it('数字与布尔字符串化', () => {
    expect(describeUnknownError(404)).toBe('404');
    expect(describeUnknownError(false)).toBe('false');
    expect(describeUnknownError(0)).toBe('0');
  });

  it('Symbol 不抛错（写成 sym + "" 会抛 TypeError）', () => {
    const sym = Symbol('worker-crashed');
    expect(() => describeUnknownError(sym)).not.toThrow();
    expect(describeUnknownError(sym)).toBe('Symbol(worker-crashed)');
  });

  it('undefined 与 null 明确写出来，而不是留空', () => {
    expect(describeUnknownError(undefined)).toContain('undefined');
    expect(describeUnknownError(null)).toContain('null');
    // 关键：绝不能是空串
    expect(describeUnknownError(undefined).length).toBeGreaterThan(0);
    expect(describeUnknownError(null).length).toBeGreaterThan(0);
  });

  it('普通对象序列化出内容', () => {
    expect(describeUnknownError({ code: 'WASM_LOAD_FAILED' })).toContain('WASM_LOAD_FAILED');
  });

  it('空对象给出类型标签而不是 "{}"', () => {
    const result = describeUnknownError({});
    expect(result).not.toBe('{}');
    expect(result).toContain('Object');
  });

  it('循环引用不抛错', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic['self'] = cyclic;
    expect(() => describeUnknownError(cyclic)).not.toThrow();
    expect(describeUnknownError(cyclic)).toContain('loop');
  });

  it('无原型对象（Object.create(null)）不抛错', () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare['reason'] = 'x';
    expect(() => describeUnknownError(bare)).not.toThrow();
  });

  it('函数值给出可读标签', () => {
    function named() {}
    expect(describeUnknownError(named)).toContain('named');
  });

  it('BigInt 不抛错', () => {
    expect(() => describeUnknownError(10n)).not.toThrow();
    expect(describeUnknownError(10n)).toBe('10');
  });
});

describe('errorReport：上下文 + 描述 + 堆栈', () => {
  it('包含上下文、描述与堆栈', () => {
    const report = errorReport('识别第 3 页', new Error('画布上下文创建失败'));
    expect(report).toContain('识别第 3 页');
    expect(report).toContain('画布上下文创建失败');
    expect(report).toContain('堆栈');
  });

  it('非 Error 值也包含上下文且非空', () => {
    const report = errorReport('初始化 OCR 引擎', undefined);
    expect(report).toContain('初始化 OCR 引擎');
    expect(report).toContain('undefined');
  });

  it('Symbol 作为抛出值时报告可读', () => {
    const report = errorReport('识别第 1 页', Symbol('boom'));
    expect(report).toContain('识别第 1 页');
    expect(report).toContain('boom');
  });
});

describe('logAndRethrow：保留原始值到控制台', () => {
  it('把原始对象交给 console.error（便于浏览器展开结构）', () => {
    const original = console.error;
    const captured: unknown[][] = [];
    console.error = (...args: unknown[]) => void captured.push(args);

    try {
      const raw = { code: 'LANG_DATA_MISSING' };
      const thrown = logAndRethrow('下载语言包', raw);

      expect(captured).toHaveLength(1);
      // 第一个参数是上下文标签，第二个是**原始对象**（不是字符串）
      expect(String(captured[0]?.[0])).toContain('下载语言包');
      expect(captured[0]?.[1]).toBe(raw);

      // 抛出的 Error 里带着可读文本
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown.message).toContain('LANG_DATA_MISSING');
    } finally {
      console.error = original;
    }
  });
});
