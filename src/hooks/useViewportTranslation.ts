import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ContentBlock } from '@/types/content';
import { describeUnknownError } from '@/lib/diagnostics';
import {
  hasCloudTranslationConfig,
  detectBrowserTranslator,
} from '@/lib/outboundPaths';
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
 * ═══════════════════════════════════════════════════════════════
 * 「安静降级」：不可用时不要翻译，也不要在阅读界面报错
 * ═══════════════════════════════════════════════════════════════
 *
 * 这里以前没有可用性判断，于是未配置代理的部署 + Firefox 上的表现是：
 * **每一段**翻译都抛一次错，错误条刷满屏幕，而用户没有任何出路
 * （云端引擎在这个部署上同样不可用）。翻译成了死路，界面还在不停地说
 * 「失败了」—— 用户既不知道为什么，也不知道能做什么。
 *
 * 现在的分工是刻意分开的：
 * - **阅读界面**：不可用就**根本不入队**（`translateRange` 直接返回），
 *   用户看不到任何红字，只是没有译文列；
 * - **解释**：放在用户主动去看的地方（设置 → 双语对照），
 *   写清缺什么、去哪里配。
 *
 * 这个分工本身就是对「诚实」的实现：**阅读界面不撒谎说自己在翻译，
 * 也不拿一条用户无法处置的错误去打扰他。**
 */
export function useViewportTranslation(blocks: ContentBlock[]) {
  const targetLang = useSettingsStore((s) => s.translationTargetLang);
  const engine = useSettingsStore((s) => s.defaultTranslationEngine);
  const cloudConsent = useSettingsStore((s) => s.cloudTranslationConsent);
  const showTranslation = useSettingsStore((s) => s.showTranslation);
  const patchCurrentDoc = useLibraryStore((s) => s.patchCurrentDoc);
  const currentDoc = useLibraryStore((s) => s.currentDoc);

  /**
   * 这台机器此刻能不能真的翻译。
   *
   * 三个条件缺一不可，而且**云端那支还要求用户同意** ——
   * 「配了端点」只说明能做，不说明准做。
   */
  const engineUsable = useMemo(() => {
    if (!engine) return false;
    if (engine === 'browser') return detectBrowserTranslator();
    return hasCloudTranslationConfig() && cloudConsent;
  }, [engine, cloudConsent]);

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

      /**
       * ⭐ 安静降级的那一行。
       *
       * 引擎不可用（没有 Translator 的浏览器 / 没配端点 / 云端未获同意）
       * 时**根本不入队** —— 于是不会产生任何错误、不会刷任何红字，
       * 阅读界面只是没有译文列。原因写在设置里（`TranslationPanel`）。
       *
       * 放在这里而不是放在 `translateBlock` 的 catch 里，是刻意的：
       * 前者是「不做无意义的事」，后者是「做了再失败再解释」。
       * 后者在滚动时每帧都会重试一遍，也就是原来那个"刷屏"的来源。
       */
      if (!engineUsable) return;

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
    [blocks, showTranslation, pump, engineUsable],
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
    /** 此刻是否真的会翻译 —— 界面用它决定要不要画译文列（安静降级） */
    engineUsable,
  };
}

/** 代码块、图片、纯符号不翻译；已有目标语言译文的也跳过 */
function shouldTranslate(block: ContentBlock, targetLang: string): boolean {
  if (block.type === 'code' || block.type === 'image') return false;
  if (block.translations[targetLang]) return false;
  const text = block.content.trim();
  return text.length >= 2;
}
