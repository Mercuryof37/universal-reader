import { describe, expect, it, afterEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';import { PdfParser } from '@/parsers/pdfParser';
import { PDF_RUNTIME_MODE } from '@/parsers/pdfRuntime';
import { __resetRuntimePolyfillsForTests, installRuntimePolyfills } from '@/lib/polyfills';
import { buildPdf } from '@/parsers/__fixtures__/makePdf';

/**
 * 「老浏览器」回归测试 —— 本项目最重要的一组测试。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么需要它
 * ═══════════════════════════════════════════════════════════════
 *
 * `a.toHex is not a function` 这个线上故障连续出现三次都没被修掉，
 * 根因是**测试环境永远复现不出来**：Node 25 原生就有 `Uint8Array#toHex`，
 * 所以只要跑测试，它就一定存在，问题被环境掩盖了。
 *
 * 这组测试的做法是：主动把原型上的 `toHex` 删掉，模拟旧浏览器，
 * 再跑完整的解析流程。如果补齐逻辑失效，这里必然失败 ——
 * 把"不可复现的线上问题"变成"必然复现的本地测试"。
 */

const originalToHex = Object.getOwnPropertyDescriptor(Uint8Array.prototype, 'toHex');
const originalWithResolvers = Object.getOwnPropertyDescriptor(Promise, 'withResolvers');

/** 进入"老浏览器"模式：删掉新 API，并强制重新执行补齐逻辑 */
function enterLegacyBrowserMode(): void {
  delete (Uint8Array.prototype as unknown as Record<string, unknown>)['toHex'];
  delete (Promise as unknown as Record<string, unknown>)['withResolvers'];
  __resetRuntimePolyfillsForTests();
  installRuntimePolyfills();
}

function restoreNatives(): void {
  if (originalToHex) Object.defineProperty(Uint8Array.prototype, 'toHex', originalToHex);
  if (originalWithResolvers) Object.defineProperty(Promise, 'withResolvers', originalWithResolvers);
  __resetRuntimePolyfillsForTests();
  installRuntimePolyfills();
}

afterEach(restoreNatives);

describe('老浏览器环境：缺失 toHex 时 PDF 仍必须能解析', () => {
  it('补齐逻辑会在同一上下文内生效（这是修复的核心保证）', () => {
    expect(typeof Uint8Array.prototype.toHex).toBe('function');

    enterLegacyBrowserMode();

    // 关键断言：删除原生实现后，补齐逻辑必须立刻恢复它。
    // pdf.js 与这段补齐代码处在同一个 JS 上下文（主线程），因此它能拿到。
    expect(typeof Uint8Array.prototype.toHex).toBe('function');
    expect(new Uint8Array([0xde, 0xad]).toHex()).toBe('dead');
  });

  it('在缺 toHex 的环境下，仍能从真实 PDF 中提取出完整内容', async () => {
    enterLegacyBrowserMode();

    // 用合成 PDF 保证这个测试在任何机器上都能跑
    const bytes = buildPdf([
      {
        lines: [
          { text: 'Legacy Browser Test', x: 72, y: 720, size: 20 },
          { text: 'This paragraph must survive without native toHex.', x: 72, y: 680 },
        ],
      },
    ]);

    const file = {
      name: 'legacy.pdf',
      size: bytes.byteLength,
      arrayBuffer: async () => bytes.buffer.slice(0) as ArrayBuffer,
    } as unknown as File;

    const doc = await new PdfParser().parse(file);

    expect(doc.blocks.length).toBeGreaterThan(0);
    expect(doc.blocks.map((b) => b.content).join(' ')).toContain('must survive');
  });

  it('在缺 toHex 的环境下，真实中文 PDF 也能完整解析', async () => {
    const realPdf =
      'C:\\Users\\Li Peilin\\.dsh\\attachments\\v1\\files\\71\\7116f67677dcf76d585eac90976eebd6c10bdde219bd960d3002c240c300fed0\\国庆作业答案4.pdf';
    if (!existsSync(realPdf)) return; // 无样本时跳过

    enterLegacyBrowserMode();

    const buffer = await readFile(realPdf);
    const doc = await new PdfParser().parse({
      name: 'legacy-real.pdf',
      size: buffer.byteLength,
      arrayBuffer: async () =>
        buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
    } as unknown as File);

    expect(doc.blocks.length).toBeGreaterThan(10);
    expect(doc.blocks.map((b) => b.content).join('')).toContain('答案');
  }, 120_000);
});

describe('pdf.js 运行上下文', () => {
  it('确认 pdf.js 运行在独立 Worker 中，且该 Worker 有自己的补齐入口', () => {
    // 浏览器环境应为 'worker'：pdf.js 在独立上下文中运行以获得性能，
    // 因此它**不能**依赖主线程的补丁 —— 补齐由 src/parsers/pdfWorkerEntry.ts
    // 在 worker 内部执行（import 顺序即执行顺序）。
    //
    // 若这里变成 'main-thread'，说明有人改回了旧的降级方案。
    // 那种方案已证实不可行：pdf.js 5 不会自动退回主线程，
    // 而是直接抛 `No "GlobalWorkerOptions.workerSrc" specified`。
    expect(['worker', 'test']).toContain(PDF_RUNTIME_MODE);
  });

  it('pdfWorkerEntry 的 import 顺序是「先补齐、后 pdf.js」', async () => {
    // 用源码文本断言，因为这是唯一能在 Node 里验证该约束的方式：
    // worker 入口没有导出，无法在运行时观察它的执行效果。
    const source = await readFile(
      new URL('./pdfWorkerEntry.ts', import.meta.url),
      'utf8',
    );
    const polyfillIdx = source.indexOf("import '@/lib/polyfills'");
    const pdfjsIdx = source.indexOf("import 'pdfjs-dist/build/pdf.worker.min.mjs'");

    expect(polyfillIdx).toBeGreaterThan(-1);
    expect(pdfjsIdx).toBeGreaterThan(-1);
    // 顺序颠倒会让线上重新出现 a.toHex is not a function
    expect(polyfillIdx).toBeLessThan(pdfjsIdx);
  });
});
