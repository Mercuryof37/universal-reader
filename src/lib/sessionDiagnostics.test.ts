import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  bumpReloadCount,
  clearOcrAttempt,
  clearOcrStage,
  getInterruptedOcr,
  getLastOcrStage,
  getLastReloadReason,
  getOcrStageTrail,
  getReloadCount,
  noteOcrProgress,
  noteOcrStage,
  noteReloadReason,
} from '@/lib/sessionDiagnostics';

/**
 * 会话级诊断。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么这个模块必须有测试
 * ═══════════════════════════════════════════════════════════════
 *
 * 这套东西是**唯一**让一次六轮排查得以收敛的工具：用户打不开控制台，
 * 全靠它记下「页面被加载了几次」「刷新是谁发起的」「OCR 走到哪一步」，
 * 再由界面显示出来。
 *
 * 也就是说：**它一旦失灵，同类故障就会重新变成无从下手。**
 * 而它的失法是安静的 —— 记录写得不对，界面只是少显示一行，
 * 没有任何报错。所以每一条语义都值得钉死。
 *
 * 特别是这一条：`getLastReloadReason()` 返回 null 意味着
 * **「刷新不是应用发起的」**，这是把「浏览器回收标签页」与
 * 「应用自己的重载逻辑」区分开的唯一依据（最终正是靠它排除了应用自身）。
 * 如果它在没有记录时返回了默认值而不是 null，这个结论就会反过来。
 */

beforeEach(() => {
  // 每个用例从干净的会话存储开始
  sessionStorage.clear();
});

describe('重载计数', () => {
  it('第一次加载返回 1，之后递增', () => {
    expect(bumpReloadCount()).toBe(1);
    expect(bumpReloadCount()).toBe(2);
    expect(getReloadCount()).toBe(2);
  });

  it('没有记录时按 1 计（正常打开，而不是 0 或 NaN）', () => {
    expect(getReloadCount()).toBe(1);
  });
});

describe('重载原因 —— 区分「应用刷新」与「浏览器回收」的关键', () => {
  it('没有记录时必须返回 null，而不是任何默认值', () => {
    /**
     * 这条是整个排查里最重要的一条语义：
     * null ⇒ 三条应用内路径都没发起刷新 ⇒ 进程是被外部干掉的。
     * 若这里返回一个"未知"之类的默认值，结论就会被误判成"应用自己刷的"。
     */
    expect(getLastReloadReason()).toBeNull();
  });

  it('记下原因后能读回，且是可读文本', () => {
    noteReloadReason('sw-update');
    const r = getLastReloadReason();
    expect(r).not.toBeNull();
    expect(r?.label).toBeTruthy();
    expect(r?.label).toMatch(/新版本|刷新/);
  });

  it('三种原因都能记、且读回的文本互不相同', () => {
    const labels = new Set<string>();
    for (const reason of ['sw-update', 'preload-error', 'manual'] as const) {
      sessionStorage.clear();
      noteReloadReason(reason);
      const label = getLastReloadReason()?.label;
      expect(label).toBeTruthy();
      labels.add(label as string);
    }
    // 三者必须能互相区分，否则诊断没有意义
    expect(labels.size).toBe(3);
  });

  it('过期的记录不再返回（避免几天前的旧记录一直挂在界面上）', () => {
    vi.useFakeTimers();
    try {
      noteReloadReason('manual');
      // 往前推 31 分钟，超过 STALE_MS（30 分钟）
      vi.advanceTimersByTime(31 * 60 * 1000);
      expect(getLastReloadReason()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('OCR 进度与阶段轨迹', () => {
  it('进度记录可读回；清掉之后读到 null', () => {
    noteOcrProgress(3, 10);
    expect(getInterruptedOcr()).toMatchObject({ pageNum: 3, total: 10 });
    clearOcrAttempt();
    expect(getInterruptedOcr()).toBeNull();
  });

  it('阶段轨迹保留多条 —— 画布尺寸不能被后一条覆盖', () => {
    /**
     * 这是一个**真实踩过的坑**：原先只保留最后一条，
     * 于是 `render` 阶段记下的画布尺寸被随后的 `recognize` 覆盖，
     * 而那正是判断"要不要继续降内存"的唯一数字。
     */
    noteOcrStage('render', '画布 1667×2223（15MB）');
    noteOcrStage('onnx', '送入推理');

    const trail = getOcrStageTrail();
    expect(trail.length).toBe(2);
    expect(trail[0]?.stage).toBe('render');
    expect(trail[0]?.detail).toContain('1667×2223');
    expect(trail[1]?.stage).toBe('onnx');
    expect(getLastOcrStage()?.stage).toBe('onnx');
  });

  it('轨迹有上限，不会无限增长（长任务会记很多条）', () => {
    for (let i = 0; i < 40; i++) noteOcrStage(`stage-${i}`);
    const trail = getOcrStageTrail();
    expect(trail.length).toBeLessThanOrEqual(5);
    // 保留的必须是最新的那几条
    expect(trail[trail.length - 1]?.stage).toBe('stage-39');
  });

  it('清空后轨迹为空', () => {
    noteOcrStage('render');
    clearOcrStage();
    expect(getOcrStageTrail()).toEqual([]);
    expect(getLastOcrStage()).toBeNull();
  });
});

describe('存储不可用时必须安全降级', () => {
  it('sessionStorage 抛异常时所有接口都不炸', () => {
    /**
     * 隐私模式 / 禁用存储时 sessionStorage 可能直接抛异常。
     * 诊断信息永远不该把主流程弄挂 —— 它是来帮忙的，不是来添乱的。
     *
     * 注意用 `globalThis` 而不是 `window`：vitest 跑在 node 环境下，
     * 那里**没有** `window`（这一点让本用例第一次写就失败了）。
     */
    const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      get() {
        throw new Error('storage disabled');
      },
    });

    try {
      expect(() => bumpReloadCount()).not.toThrow();
      expect(() => getReloadCount()).not.toThrow();
      expect(() => noteOcrProgress(1, 1)).not.toThrow();
      expect(() => noteOcrStage('x')).not.toThrow();
      expect(() => noteReloadReason('manual')).not.toThrow();
      expect(() => clearOcrAttempt()).not.toThrow();
      expect(() => clearOcrStage()).not.toThrow();
      // 读不到就返回安全的默认值
      expect(getLastReloadReason()).toBeNull();
      expect(getInterruptedOcr()).toBeNull();
      expect(getOcrStageTrail()).toEqual([]);
      // 计数退回 1（"正常打开一次"），而不是 0 或 NaN
      expect(getReloadCount()).toBe(1);
    } finally {
      if (original) Object.defineProperty(globalThis, 'sessionStorage', original);
    }
  });
});
