import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { OCR_CHECKPOINT_EVERY_PAGES, shouldCheckpoint } from '@/lib/ocrTypes';

/**
 * OCR 中途落盘的时机。
 *
 * ═══════════════════════════════════════════════════════════════
 * 这组测试对应一个用户报过的真实故障
 * ═══════════════════════════════════════════════════════════════
 *
 * 「能正常扫描，但扫描完看不到文档，书库里也没有新条目。」
 *
 * 查证结果：整次 OCR 的结果**只存在内存里，直到最后一页跑完才写 IndexedDB**。
 * 而本应用用 `autoUpdate` 的 Service Worker —— 新版本部署后页面会
 * **自动重载**。用户那次扫描正好跨过一次部署，于是十几分钟的工作
 * 被清空，且**没有任何报错、没有任何摘要**，因为状态本来就随刷新一起没了。
 *
 * 修法之一是每识别若干页就把结果落盘。落盘时机的边界最容易写错：
 * 任务页数不足一个间隔时（比如试跑 3 页）如果没有「末页必落盘」，
 * 检查点永远不会触发 —— 而那恰恰是最常见的用法。
 */

describe('落盘节奏 mustCheckpoint', () => {
  it('末页一定落盘 —— 否则小任务永远等不到检查点', () => {
    // 这正是"前 10 页试跑"的默认场景，也是最常见的用法
    expect(shouldCheckpoint(10, 10)).toBe(true);
    // 不足一个间隔的小任务：3 页
    expect(shouldCheckpoint(3, 3)).toBe(true);
    // 单页文档
    expect(shouldCheckpoint(1, 1)).toBe(true);
  });

  it('每隔 OCR_CHECKPOINT_EVERY_PAGES 页落一次', () => {
    const step = OCR_CHECKPOINT_EVERY_PAGES;
    expect(step).toBeGreaterThan(1); // 每页都写库没有意义

    // 长任务（100 页）里，中途的检查点落在整数倍页
    expect(shouldCheckpoint(step, 100)).toBe(true);
    expect(shouldCheckpoint(step * 2, 100)).toBe(true);
    // 间隔中间的页不落盘
    expect(shouldCheckpoint(step + 1, 100)).toBe(false);
    expect(shouldCheckpoint(step * 2 - 1, 100)).toBe(false);
  });

  it('第一页不落盘（此时还只有一页内容，写库不划算）', () => {
    // 前提：总页数大于 1，否则第一页同时也是末页
    expect(shouldCheckpoint(1, 100)).toBe(false);
  });

  it('丢失窗口有上界：任意时刻距离上一次落盘不超过一个间隔', () => {
    const total = 237;
    let last = 0;
    let maxGap = 0;
    for (let p = 1; p <= total; p++) {
      if (shouldCheckpoint(p, total)) {
        maxGap = Math.max(maxGap, p - last);
        last = p;
      }
    }
    // 末页必落盘，所以最后一次一定被记上
    expect(last).toBe(total);
    expect(maxGap).toBeLessThanOrEqual(OCR_CHECKPOINT_EVERY_PAGES);
  });

  it('非法输入不触发落盘（而不是意外地在第 0 页写库）', () => {
    expect(shouldCheckpoint(0, 10)).toBe(false);
    expect(shouldCheckpoint(-1, 10)).toBe(false);
    expect(shouldCheckpoint(Number.NaN, 10)).toBe(false);
  });
});

/**
 * 落盘链路的两端必须都存在：parser 里生成快照并回调，
 * store 里真正把它写进 IndexedDB。只做一半等于没做 ——
 * 而且这种"只做一半"编译能过、测试不报错，正是本项目记录过的
 * 「看着对、跑起来不对」。
 */
describe('落盘链路两端都已接上（读源码断言）', () => {
  const PARSER_SRC = readFileSync(join(process.cwd(), 'src/parsers/pdfParser.ts'), 'utf8');
  const STORE_SRC = readFileSync(join(process.cwd(), 'src/store/libraryStore.ts'), 'utf8');

  it('parser 在页循环里调用 onCheckpoint', () => {
    expect(PARSER_SRC).toMatch(/await onCheckpoint\(snapshot\(\)\)/);
  });

  it('parser 的文档 id 在循环之前定下 —— 否则每次检查点会造出新文档', () => {
    const docIdDecl = PARSER_SRC.indexOf('const docId = uid()');
    const loop = PARSER_SRC.indexOf('for (let pageNum = 1; pageNum <= totalPages');

    expect(docIdDecl, '找不到循环前的 docId 声明').toBeGreaterThan(-1);
    expect(loop, '找不到页循环').toBeGreaterThan(-1);
    expect(docIdDecl).toBeLessThan(loop);
  });

  it('最终保存复用同一个 docId（覆盖检查点写下的那条，而不是新增一条）', () => {
    // 循环之后不应再出现 `docId: uid()`
    const loop = PARSER_SRC.indexOf('for (let pageNum = 1; pageNum <= totalPages');
    const after = PARSER_SRC.slice(loop);
    expect(after).not.toMatch(/docId:\s*uid\(\)/);
    expect(after).toMatch(/docId,/);
  });

  it('store 把检查点写进 IndexedDB 并刷新书库列表', () => {
    expect(STORE_SRC).toMatch(/onCheckpoint:\s*async/);
    expect(STORE_SRC).toMatch(/await saveDocument\(snapshot\)/);
  });
});
