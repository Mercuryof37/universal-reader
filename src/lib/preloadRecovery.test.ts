import { describe, expect, it } from 'vitest';
import { isChunkLoadError } from '@/lib/preloadRecovery';

/**
 * chunk 加载失败的自愈逻辑。
 *
 * ═══════════════════════════════════════════════════════════════
 * 这组测试对应一个真实的用户报错
 * ═══════════════════════════════════════════════════════════════
 *
 *   有 1 个文件未能导入：
 *   习题5-10月19日交(1).pdf：Failed to fetch dynamically imported module:
 *   https://universal-reader.pages.dev/assets/pdfParser-CiRxJgol.js
 *
 * 页面本身正常、md/txt 也能导入，**只有按需加载的 pdf/epub 解析器失败** ——
 * 用户很容易误以为"这个 PDF 有问题"，而实际是旧页面去找已被删除的旧 chunk。
 *
 * 根因修复在 vite.config.ts（导航请求改 NetworkFirst），
 * 本模块是兜底：即使错配仍发生，也要自动刷新自愈而不是把错误抛给用户。
 *
 * 这里测的是**识别环节** —— 判错了会导致两种坏结果：
 * 漏判 → 用户看到莫名其妙的失败；误判 → 无关错误也触发刷新。
 */

describe('isChunkLoadError：识别各浏览器的报错措辞', () => {
  it('Chrome / Edge 的动态 import 失败', () => {
    expect(
      isChunkLoadError(
        new TypeError(
          'Failed to fetch dynamically imported module: https://example.com/assets/pdfParser-CiRxJgol.js',
        ),
      ),
    ).toBe(true);
  });

  it('Firefox 的措辞', () => {
    expect(
      isChunkLoadError(new Error('error loading dynamically imported module')),
    ).toBe(true);
  });

  it('Safari 的措辞', () => {
    expect(isChunkLoadError(new Error('Importing a module script failed.'))).toBe(true);
  });

  it('大小写不敏感', () => {
    expect(
      isChunkLoadError(new Error('FAILED TO FETCH DYNAMICALLY IMPORTED MODULE')),
    ).toBe(true);
  });

  it('接受字符串形式的抛出值（throw 可以抛任何东西）', () => {
    // 与 diagnostics.ts 同一条原则：错误未必是 Error 实例
    expect(isChunkLoadError('Failed to fetch dynamically imported module: /x.js')).toBe(true);
  });

  it('接受 TypeError 之外的 Error 子类', () => {
    class CustomError extends Error {}
    expect(
      isChunkLoadError(new CustomError('Failed to fetch dynamically imported module: /x.js')),
    ).toBe(true);
  });
});

describe('isChunkLoadError：不该误判的情况', () => {
  it('普通的网络错误不触发自动刷新', () => {
    // 用户断网时也会「fetch 失败」，但那是网络问题，刷新解决不了，
    // 反而会把用户正在读的文档刷掉
    expect(isChunkLoadError(new TypeError('Failed to fetch'))).toBe(false);
    expect(isChunkLoadError(new Error('NetworkError when attempting to fetch resource.'))).toBe(
      false,
    );
  });

  it('翻译接口的失败不触发刷新', () => {
    expect(isChunkLoadError(new Error('翻译请求失败（HTTP 429）'))).toBe(false);
  });

  it('OCR 的失败不触发刷新', () => {
    expect(isChunkLoadError(new Error('Error attempting to read image.'))).toBe(false);
  });

  it('undefined / null / 空值一律不触发', () => {
    // 这正是"OCR 识别失败：undefined"那次的教训 ——
    // 抛出值可能什么都没有，此时绝不能靠猜去刷新页面
    expect(isChunkLoadError(undefined)).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError('')).toBe(false);
    expect(isChunkLoadError({})).toBe(false);
    expect(isChunkLoadError(42)).toBe(false);
  });

  it('普通业务错误不触发', () => {
    expect(isChunkLoadError(new Error('不支持的文件格式「.docx」'))).toBe(false);
    expect(isChunkLoadError(new Error('这份 PDF 是扫描版'))).toBe(false);
  });
});
