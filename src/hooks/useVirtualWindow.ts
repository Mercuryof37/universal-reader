import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export interface VirtualWindow {
  /** 首个需要渲染的下标 */
  start: number;
  /** 末个需要渲染的下标（不含） */
  end: number;
  /** 容器上方的占位高度，单位 px */
  topPadding: number;
  /** 容器下方的占位高度，单位 px */
  bottomPadding: number;
}

/** 每项高度可按需增长，超出后按均值收敛，防止一屏之外的项把总高撑爆 */
const DEFAULT_ESTIMATE = 120;

/**
 * 极简虚拟滚动。
 *
 * 为什么不用 react-window / virtua：
 * 我们的列表项高度是"近似稳定但会变"的——字号、行高、双语模式、
 * 译文展开都会改变高度，而现成库普遍要求固定 itemHeight 或接入其测量机制，
 * 配置成本高于收益。这里用"估算 + ResizeObserver 实测校正"的折中：
 * 只渲染可见区 ± 缓冲，其余用上下占位块撑起滚动条。
 *
 * 已知代价：拖动滚动条过快时可能出现短暂空白（估算与实测的差值），
 * 因此上下各留若干项缓冲。
 */
export function useVirtualWindow(
  itemCount: number,
  estimateHeight = DEFAULT_ESTIMATE,
  buffer = 6,
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  /** 各下标的实测高度 */
  const heightsRef = useRef(new Map<number, number>());
  /** 高度变更的版本号，用于触发 offsets 重算 */
  const [heightVersion, setHeightVersion] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(720);

  // 预先算好每一项的起始偏移与总高度：这是后面所有区间计算的基础
  const { offsets, totalHeight } = useMemo(() => {
    const result = new Array<number>(itemCount);
    let acc = 0;
    for (let i = 0; i < itemCount; i++) {
      result[i] = acc;
      acc += heightsRef.current.get(i) ?? estimateHeight;
    }
    return { offsets: result, totalHeight: acc };
    // heightVersion 是刻意加入的依赖：它变化代表实测高度更新了
  }, [itemCount, estimateHeight, heightVersion]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    setViewportHeight(el.clientHeight || 720);

    // 用 rAF 节流：scroll 触发频率远高于渲染帧，每次都 setState 会掉帧
    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        setScrollTop(el.scrollTop);
      });
    };

    const resizeObserver = new ResizeObserver(() => setViewportHeight(el.clientHeight || 720));
    resizeObserver.observe(el);
    el.addEventListener('scroll', onScroll, { passive: true });

    return () => {
      el.removeEventListener('scroll', onScroll);
      resizeObserver.disconnect();
    };
  }, []);

  const { window: virtualWindow, firstVisible } = useMemo(() => {
    if (itemCount === 0) {
      return { window: { start: 0, end: 0, topPadding: 0, bottomPadding: 0 }, firstVisible: 0 };
    }

    // 找到第一个"底部越过视口顶部"的项
    let start = 0;
    while (start < itemCount - 1 && (offsets[start + 1] ?? 0) <= scrollTop) start++;

    const limit = scrollTop + viewportHeight;
    let end = start;
    while (end < itemCount && (offsets[end] ?? totalHeight) < limit) end++;
    if (end === start) end = Math.min(itemCount, start + 1);

    const startWithBuffer = Math.max(0, start - buffer);
    const endWithBuffer = Math.min(itemCount, end + buffer);

    const topPadding = offsets[startWithBuffer] ?? 0;
    const lastIndex = endWithBuffer - 1;
    const lastHeight = heightsRef.current.get(lastIndex) ?? estimateHeight;
    const bottomPadding = Math.max(0, totalHeight - ((offsets[lastIndex] ?? 0) + lastHeight));

    return {
      window: { start: startWithBuffer, end: endWithBuffer, topPadding, bottomPadding },
      // 上报给外界的"第一可见项"必须是未加缓冲的 start：
      // 缓冲只服务于渲染（提前挂好 6 块，快速拖动时不露白），
      // 而进度、目录高亮、朗读起点要的是用户真正看到的那一段，
      // 拿 window.start 会恒定提前 buffer 项（表现就是滚动时进度"走在后面"）
      firstVisible: start,
    };
  }, [itemCount, offsets, totalHeight, scrollTop, viewportHeight, buffer, estimateHeight]);

  /** 注册某个下标实测到的真实高度 */
  const reportHeight = useCallback((index: number, height: number) => {
    if (height <= 0) return;
    const prev = heightsRef.current.get(index);
    // 阈值 2px：避免亚像素抖动导致无限重算
    if (prev === undefined || Math.abs(prev - height) > 2) {
      heightsRef.current.set(index, height);
      setHeightVersion((v) => v + 1);
    }
  }, []);

  const scrollToIndex = useCallback(
    (index: number) => {
      const el = containerRef.current;
      if (!el || itemCount === 0) return;
      const target = Math.max(0, Math.min(index, itemCount - 1));
      const top = offsets[target] ?? 0;
      el.scrollTo({ top: Math.max(0, top - 24), behavior: 'smooth' });

      // 估算高度与实际高度会有偏差（表格、译文、列宽变化都会改变块高），
      // 只按 offsets 滚会停在目标上方或下方几百像素。等平滑滚动结束后，
      // 用真实 DOM 位置校正一次 —— 目录跳转必须落在标题上，而不是"附近"。
      window.setTimeout(() => {
        const node = el.querySelector(`[data-index="${target}"]`);
        if (!node) return;
        const delta =
          node.getBoundingClientRect().top - el.getBoundingClientRect().top - 24;
        if (Math.abs(delta) > 8) {
          el.scrollTo({ top: Math.max(0, el.scrollTop + delta), behavior: 'auto' });
        }
      }, 520);
    },
    [offsets, itemCount],
  );

  return {
    containerRef,
    window: virtualWindow,
    scrollToIndex,
    reportHeight,
    /** 视口顶部那一段的真实下标（不含渲染缓冲），用于进度、目录高亮与朗读起点 */
    firstVisibleIndex: firstVisible,
    scrollTop,
  };
}

/**
 * 测量单个块的真实高度并上报。
 *
 * 用 ResizeObserver 而不是挂载时读一次 offsetHeight：
 * 字体加载完成、译文展开、字号变化都会异步改变高度，
 * 只在挂载时测量会让虚拟滚动的位置持续偏移。
 */
export function useMeasuredHeight(
  index: number,
  report: (index: number, height: number) => void,
): React.RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    report(index, el.getBoundingClientRect().height);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) report(index, entry.contentRect.height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [index, report]);

  return ref;
}
