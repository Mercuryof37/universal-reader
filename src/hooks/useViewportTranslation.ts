import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ContentBlock } from '@/types/content';
import { describeUnknownError } from '@/lib/diagnostics';
import {
  TARGET_LANGUAGES,
  isBrowserTranslationAvailable,
  translateBlock,
  withTranslation,
} from '@/services/translationService';
import { useSettingsStore, type TranslationEngineId } from '@/store/settingsStore';
import { useLibraryStore } from '@/store/libraryStore';

/**
 * 视口懒翻译。
 *
 * 核心动机是钱和等待时间：一篇 3 万字的文档，整篇送去 DeepL 会一次性消耗
 * 全部免费额度，用户还要盯着进度条等半分钟。而实际阅读时，
 * 用户根本不会一次看完——只翻译"看得见的 ± 缓冲"就够用，
 * 成本与等待都降到 1/10 以下。
 *
 * 实现要点：
 * - 并发上限 3：再高会触发多数翻译 API 的限流（429）；
 * - 队列用 ref 保存而不是 state：避免每次入队都触发重渲染；
 * - 译文写回 store 时生成新对象（zustand 靠引用变化感知更新）。
 */
export function useViewportTranslation(blocks: ContentBlock[]) {
  const targetLang = useSettingsStore((s) => s.translationTargetLang);
  const engine = useSettingsStore((s) => s.defaultTranslationEngine);
  const showTranslation = useSettingsStore((s) => s.showTranslation);
  const patchCurrentDoc = useLibraryStore((s) => s.patchCurrentDoc);
  const currentDoc = useLibraryStore((s) => s.currentDoc);

  const [pending, setPending] = useState(0);
  const [error, setError] = useState<string | null>(null);
  /** 已入队/已完成翻译的 block id，防止同一块反复入队 */
  const handledRef = useRef(new Set<string>());
  const inflightRef = useRef(0);
  const queueRef = useRef<string[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  // 换文档或换语言时清空队列状态
  useEffect(() => {
    handledRef.current.clear();
    queueRef.current = [];
    setPending(0);
    setError(null);
  }, [currentDoc?.id, targetLang]);

  const pump = useCallback(() => {
    const MAX_CONCURRENT = 3;

    while (inflightRef.current < MAX_CONCURRENT && queueRef.current.length) {
      const blockId = queueRef.current.shift();
      if (!blockId) break;

      const doc = useLibraryStore.getState().currentDoc;
      const block = doc?.blocks.find((b) => b.id === blockId);
      if (!doc || !block) {
        handledRef.current.delete(blockId);
        continue;
      }

      inflightRef.current += 1;
      setPending((n) => n + 1);

      void (async () => {
        try {
          const result = await translateBlock(block, targetLang, {
            engine: engine as TranslationEngineId,
            signal: abortRef.current?.signal,
          });

          // 每次都从 store 取最新文档：翻译期间用户可能已经切换文档
          const latest = useLibraryStore.getState().currentDoc;
          if (!latest || latest.id !== doc.id) return;

          const nextBlocks = latest.blocks.map((b) =>
            b.id === blockId ? withTranslation(b, targetLang, result.translatedText) : b,
          );
          patchCurrentDoc({ blocks: nextBlocks });
        } catch (err) {
          const message = describeUnknownError(err);
          // 中断不是错误，切换文档/语言时必然发生
          if ((err as Error).name !== 'AbortError') setError(message);
        } finally {
          inflightRef.current -= 1;
          setPending((n) => Math.max(0, n - 1));
          pump();
        }
      })();
    }
  }, [targetLang, engine, patchCurrentDoc]);

  /** 把视口内的块加入翻译队列 */
  const translateRange = useCallback(
    (startIndex: number, endIndex: number) => {
      if (!showTranslation) return;

      abortRef.current ??= new AbortController();

      let queued = 0;
      for (let i = Math.max(0, startIndex); i < Math.min(blocks.length, endIndex); i++) {
        const block = blocks[i];
        if (!block) continue;
        if (!shouldTranslate(block, targetLang)) continue;
        if (handledRef.current.has(block.id)) continue;

        handledRef.current.add(block.id);
        queueRef.current.push(block.id);
        queued++;
      }
      if (queued) pump();
    },
    [blocks, showTranslation, pump],
  );

  /** 一次性翻译全篇（用户明确要求导出或通读时用） */
  const translateAll = useCallback(() => {
    if (!blocks.length) return;
    translateRange(0, blocks.length);
  }, [blocks, translateRange]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    queueRef.current = [];
    setPending(0);
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  /**
   * 稳定引用的 translateRange。
   *
   * 为什么需要它：调用方要在"视口变化"的 effect 里触发翻译，
   * 而 translateRange 依赖 blocks（每次文档更新都是新数组），
   * 直接放进依赖数组会让那个 effect 在每次渲染后都执行一次，
   * 进而造成 翻译→更新文档→再翻译 的死循环。
   */
  const translateRangeRef = useRef(translateRange);
  translateRangeRef.current = translateRange;

  const translatedCount = useMemo(
    () => blocks.filter((b) => b.translations[targetLang]).length,
    [blocks, targetLang],
  );

  return {
    translateRange,
    translateRangeRef,
    translateAll,
    cancel,
    pending,
    translatedCount,
    error,
    clearError: () => setError(null),
    targetLang,
    languages: TARGET_LANGUAGES,
    browserTranslationAvailable: isBrowserTranslationAvailable(),
  };
}

/** 代码块、图片、纯符号不翻译；已有目标语言译文的也跳过 */
function shouldTranslate(block: ContentBlock, targetLang: string): boolean {
  if (block.type === 'code' || block.type === 'image') return false;
  if (block.translations[targetLang]) return false;
  const text = block.content.trim();
  return text.length >= 2;
}
