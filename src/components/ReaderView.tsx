import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Bookmark,
  Languages,
  ListTree,
  Pause,
  Play,
  Settings2,
  X,
} from 'lucide-react';
import type { Annotation } from '@/types/content';
import { useLibraryStore } from '@/store/libraryStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useAnnotationsStore } from '@/store/annotationsStore';
import { useVirtualWindow } from '@/hooks/useVirtualWindow';
import { useTtsReader } from '@/hooks/useTtsReader';
import { useViewportTranslation } from '@/hooks/useViewportTranslation';
import { BlockRow, type BlockSelection } from '@/components/BlockRow';
import { TranslationPanel } from '@/components/TranslationPanel';
import { TtsVoiceSelector } from '@/components/TtsVoiceSelector';
import { AnnotationSidebar } from '@/components/AnnotationSidebar';
import { loadProgress, saveProgress } from '@/lib/db';
import { buildHeadingAnchors, findHeadingIndex } from '@/lib/utils';

type SidePanel = 'none' | 'toc' | 'annotations' | 'settings';

/**
 * 阅读视图。
 *
 * 这个组件是唯一的"编排层"：数据（文档 / 批注 / 设置）、
 * 行为（朗读 / 翻译 / 进度）都在这里汇合，然后分发给纯展示组件。
 * 保持单一编排层的好处是依赖关系是树状的，而不是组件之间互相订阅。
 */
export function ReaderView() {
  const currentDoc = useLibraryStore((s) => s.currentDoc);
  const closeDocument = useLibraryStore((s) => s.closeDocument);

  const layout = useSettingsStore((s) => s.bilingualLayout);
  const targetLang = useSettingsStore((s) => s.translationTargetLang);
  const showTranslation = useSettingsStore((s) => s.showTranslation);
  const contentWidth = useSettingsStore((s) => s.contentWidth);
  const fontFamily = useSettingsStore((s) => s.fontFamily);
  const theme = useSettingsStore((s) => s.theme);

  const annotations = useAnnotationsStore((s) => s.annotations);
  const loadAnnotations = useAnnotationsStore((s) => s.load);
  const clearAnnotations = useAnnotationsStore((s) => s.clear);
  const addAnnotation = useAnnotationsStore((s) => s.add);
  const defaultColor = useSettingsStore((s) => s.defaultHighlightColor);

  const blocks = currentDoc?.blocks ?? [];
  const { containerRef, window: vwin, scrollToIndex, reportHeight, firstVisibleIndex } =
    useVirtualWindow(blocks.length);

  const tts = useTtsReader(blocks);
  const translation = useViewportTranslation(blocks);

  const [panel, setPanel] = useState<SidePanel>('none');
  const [selection, setSelection] = useState<BlockSelection | null>(null);
  const [restored, setRestored] = useState(false);
  const lastSaveRef = useRef(0);

  /** 打开文档时载入批注 */
  useEffect(() => {
    if (!currentDoc) return;
    setRestored(false);
    setPanel('none');
    void loadAnnotations(currentDoc.id);
    return () => clearAnnotations();
  }, [currentDoc?.id, loadAnnotations, clearAnnotations, currentDoc]);

  /** 恢复上次阅读位置（只在首次渲染后执行一次） */
  useEffect(() => {
    if (!currentDoc || restored) return;
    let cancelled = false;
    void (async () => {
      const progress = await loadProgress(currentDoc.id);
      if (cancelled || !progress) {
        setRestored(true);
        return;
      }
      // 等一帧让虚拟列表完成首次布局，否则 scrollTo 会被后续布局覆盖
      requestAnimationFrame(() => {
        scrollToIndex(progress.blockIndex);
        setRestored(true);
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [currentDoc, restored, scrollToIndex]);

  /** 视口变化 → 触发懒翻译 + 记录进度 */
  useEffect(() => {
    if (!currentDoc || !blocks.length) return;

    if (showTranslation) {
      // 从 store 直接取函数，避免把整个 translation 对象放进依赖数组
      // （那个对象每次渲染都是新的，会让这个 effect 每帧都跑）
      translation.translateRangeRef.current(vwin.start, vwin.end);
    }

    const now = Date.now();
    // 节流：每次滚动都写 IndexedDB 会造成大量无意义写入
    if (now - lastSaveRef.current > 1500) {
      lastSaveRef.current = now;
      void saveProgress({
        docId: currentDoc.id,
        blockIndex: firstVisibleIndex,
        percent: blocks.length ? firstVisibleIndex / blocks.length : 0,
        updatedAt: new Date().toISOString(),
      });
    }
  }, [currentDoc, blocks.length, vwin.start, vwin.end, firstVisibleIndex, showTranslation, translation.translateRangeRef]);

  /** 点击正文任意处关闭浮动工具条 */
  useEffect(() => {
    if (!selection) return;
    const close = () => setSelection(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelection(null);
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [selection]);

  /** 快捷键：空格播放/暂停会被输入框抢走，因此只在无输入焦点时生效 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;

      if (e.code === 'Space' && !selection) {
        e.preventDefault();
        tts.isSpeaking ? tts.stop() : tts.playFrom(firstVisibleIndex);
      }
      if (e.key === 'Escape') {
        setPanel('none');
        tts.stop();
      }
      if (e.key === 'j' || e.key === 'J') tts.next();
      if (e.key === 'k' || e.key === 'K') tts.prev();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tts, firstVisibleIndex, selection]);

  const annotationsByBlock = useCallback(
    (blockId: string): Annotation[] => annotations.filter((a) => a.blockId === blockId),
    [annotations],
  );

  /** Markdown 文内链接（`[x](#标题)`）的可跳转目标 */
  const headingAnchors = useMemo(() => buildHeadingAnchors(blocks), [blocks]);
  const jumpToAnchor = useCallback(
    (anchor: string) => {
      const idx = findHeadingIndex(blocks, anchor);
      if (idx >= 0) scrollToIndex(idx);
    },
    [blocks, scrollToIndex],
  );

  const handleAddAnnotation = useCallback(
    async (type: Annotation['type'], withNote: boolean) => {
      if (!selection || !currentDoc) return;
      const block = blocks[selection.blockIndex];
      if (!block) return;
      setSelection(null);
      await addAnnotation({
        blockId: block.id,
        blockContent: block.content,
        type,
        color: defaultColor,
        content: withNote ? (prompt('写下你的笔记') ?? '') : undefined,
        selection: { start: selection.start, end: selection.end, text: selection.text },
      });
      setPanel('annotations');
    },
    [selection, currentDoc, blocks, addAnnotation, defaultColor],
  );

  if (!currentDoc) return null;

  const visibleBlocks = blocks.slice(vwin.start, vwin.end);

  return (
    <div className="flex h-full flex-col">
      {/* ── 顶部工具条 ── */}
      <header className="no-print flex flex-wrap items-center gap-2 border-b border-[var(--reader-border)] bg-[var(--reader-panel)] px-3 py-2">
        <button
          type="button"
          onClick={closeDocument}
          className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs hover:bg-[var(--reader-bg)]"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
          文档库
        </button>

        <div className="min-w-0 flex-1 px-2">
          <h1 className="truncate text-sm font-medium" title={currentDoc.title}>
            {currentDoc.title}
          </h1>
          <p className="truncate text-[11px] text-[var(--reader-muted)]">
            {currentDoc.metadata.author ? `${currentDoc.metadata.author} · ` : ''}
            {currentDoc.metadata.charCount.toLocaleString()} 字 · {blocks.length} 段 ·{' '}
            {Math.round(((firstVisibleIndex + 1) / Math.max(1, blocks.length)) * 100)}%
          </p>
        </div>

        <button
          type="button"
          onClick={() => setPanel(panel === 'toc' ? 'none' : 'toc')}
          aria-label="目录"
          className={toolbarBtn(panel === 'toc')}
        >
          <ListTree className="h-4 w-4" aria-hidden />
        </button>

        <button
          type="button"
          onClick={() => setPanel(panel === 'annotations' ? 'none' : 'annotations')}
          aria-label="批注"
          className={toolbarBtn(panel === 'annotations')}
        >
          <Bookmark className="h-4 w-4" aria-hidden />
          {annotations.length > 0 && (
            <span className="ml-0.5 text-[10px] tabular-nums">{annotations.length}</span>
          )}
        </button>

        <button
          type="button"
          onClick={() => setPanel(panel === 'settings' ? 'none' : 'settings')}
          aria-label="阅读与朗读设置"
          className={toolbarBtn(panel === 'settings')}
        >
          <Settings2 className="h-4 w-4" aria-hidden />
        </button>

        <button
          type="button"
          onClick={() =>
            tts.isSpeaking ? tts.stop() : tts.playFrom(Math.max(0, firstVisibleIndex))
          }
          aria-label={tts.isSpeaking ? '暂停朗读' : '从当前位置朗读'}
          className="rounded-lg border border-[var(--reader-border)] p-1.5 hover:bg-[var(--reader-bg)]"
        >
          {tts.isSpeaking ? (
            <Pause className="h-4 w-4" aria-hidden />
          ) : (
            <Play className="h-4 w-4" aria-hidden />
          )}
        </button>

        <button
          type="button"
          onClick={() => useSettingsStore.getState().setShowTranslation(!showTranslation)}
          aria-label="切换译文"
          className={toolbarBtn(showTranslation)}
        >
          <Languages className="h-4 w-4" aria-hidden />
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* ── 正文 ── */}
        <main
          ref={containerRef}
          className="reader-scroll reader-prose min-h-0 flex-1 overflow-y-auto px-4 py-8 sm:px-8"
          data-theme={theme}
          data-font={fontFamily}
        >
          <div className="mx-auto" style={{ maxWidth: `${contentWidth}px` }}>
            <div style={{ height: `${vwin.topPadding}px` }} aria-hidden />

            {visibleBlocks.map((block, i) => {
              const index = vwin.start + i;
              return (
                <BlockRow
                  key={block.id}
                  block={block}
                  index={index}
                  annotations={annotationsByBlock(block.id)}
                  layout={layout}
                  targetLang={targetLang}
                  speaking={tts.playingIndex === index}
                  translating={
                    showTranslation &&
                    !block.translations[targetLang] &&
                    block.type !== 'code' &&
                    block.type !== 'image'
                  }
                  headingAnchors={headingAnchors}
                  onJumpAnchor={jumpToAnchor}
                  reportHeight={reportHeight}
                  onToggleSpeak={tts.toggle}
                  onSelection={setSelection}
                />
              );
            })}

            <div style={{ height: `${vwin.bottomPadding}px` }} aria-hidden />

            {vwin.end >= blocks.length && (
              <p className="py-10 text-center text-xs text-[var(--reader-muted)]">— 全文结束 —</p>
            )}
          </div>
        </main>

        {/* ── 侧栏 ── */}
        {panel !== 'none' && (
          <div className="no-print flex w-full max-w-sm shrink-0 flex-col border-l border-[var(--reader-border)] bg-[var(--reader-panel)]">
            <div className="flex items-center justify-between border-b border-[var(--reader-border)] px-4 py-2">
              <span className="text-sm font-medium">
                {panel === 'toc' ? '目录' : panel === 'annotations' ? '批注' : '设置'}
              </span>
              <button
                type="button"
                onClick={() => setPanel('none')}
                aria-label="关闭侧栏"
                className="rounded p-1 hover:bg-[var(--reader-bg)]"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </div>

            <div className="reader-scroll min-h-0 flex-1 overflow-y-auto">
              {panel === 'toc' && (
                <TocPanel onJump={scrollToIndex} activeIndex={firstVisibleIndex} />
              )}

              {panel === 'annotations' && (
                <AnnotationSidebar
                  blocks={blocks}
                  docTitle={currentDoc.title}
                  onJump={(blockId) => {
                    const idx = blocks.findIndex((b) => b.id === blockId);
                    if (idx >= 0) scrollToIndex(idx);
                  }}
                />
              )}

              {panel === 'settings' && (
                <>
                  <TranslationPanel
                    controls={{
                      pending: translation.pending,
                      translatedCount: translation.translatedCount,
                      totalCount: blocks.length,
                      translateAll: translation.translateAll,
                      cancel: translation.cancel,
                    }}
                  />
                  <TtsVoiceSelector
                    controls={{
                      isSpeaking: tts.isSpeaking,
                      progress: tts.progress,
                      voices: tts.voices,
                      onStop: tts.stop,
                      onNext: tts.next,
                      onPrev: tts.prev,
                      onResume: () => tts.playFrom(Math.max(0, firstVisibleIndex)),
                    }}
                  />
                  <ReadingSettings />
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── 选区浮动工具条 ── */}
      {selection && (
        <div
          className="no-print fixed z-50 flex -translate-x-1/2 gap-1 rounded-lg border border-[var(--reader-border)] bg-[var(--reader-panel)] p-1 shadow-lg"
          style={{ top: Math.max(8, selection.rect.top - 44), left: selection.rect.left }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {(
            [
              ['highlight', '高亮'],
              ['note', '记笔记'],
              ['question', '提问'],
              ['tag', '打标签'],
            ] as const
          ).map(([type, label]) => (
            <button
              key={type}
              type="button"
              onClick={() => void handleAddAnnotation(type, type === 'note')}
              className="rounded-md px-2 py-1 text-xs hover:bg-[var(--reader-bg)]"
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {/* ── 错误提示 ── */}
      {(tts.error || translation.error) && (
        <div className="no-print fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-red-400/60 bg-red-500/10 px-4 py-2 text-xs text-red-700 backdrop-blur dark:text-red-300">
          {tts.error ?? translation.error}
          <button
            type="button"
            className="ml-3 underline"
            onClick={() => {
              if (tts.error) tts.clearError();
              if (translation.error) translation.clearError();
            }}
          >
            知道了
          </button>
        </div>
      )}
    </div>
  );
}

function toolbarBtn(active: boolean): string {
  return [
    'flex items-center rounded-lg p-1.5 transition-colors',
    active
      ? 'bg-[var(--reader-bg)] text-[var(--reader-accent)]'
      : 'text-[var(--reader-fg)] hover:bg-[var(--reader-bg)]',
  ].join(' ');
}

/**
 * 目录面板。
 *
 * 除了点击跳转，还跟随正文滚动高亮"当前节"（最后一个起始位置不超过
 * 当前视口顶部的条目），并把高亮项滚进可视区 —— 长文档里目录本身就是
 * 一个迷你进度条。
 */
function TocPanel({ onJump, activeIndex }: { onJump: (index: number) => void; activeIndex: number }) {
  const currentDoc = useLibraryStore((s) => s.currentDoc);
  const toc = currentDoc?.toc ?? [];
  const blocks = currentDoc?.blocks ?? [];
  const activeRef = useRef<HTMLButtonElement | null>(null);

  const entries = useMemo(
    () => toc.map((entry) => ({ entry, index: blocks.findIndex((b) => b.id === entry.blockId) })),
    [toc, blocks],
  );

  const activeBlockId = useMemo(() => {
    let active: string | null = null;
    for (const { entry, index } of entries) {
      if (index < 0) continue;
      if (index <= activeIndex) active = entry.blockId;
      else break;
    }
    return active;
  }, [entries, activeIndex]);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeBlockId]);

  if (!toc.length) {
    return (
      <p className="p-4 text-xs leading-relaxed text-[var(--reader-muted)]">
        这份文档没有可识别的标题结构。Markdown 的 # 标题、纯文本的「第X章」会被自动收进目录。
      </p>
    );
  }

  return (
    <nav className="p-3">
      <ul className="flex flex-col gap-0.5">
        {entries.map(({ entry, index }) => {
          const active = entry.blockId === activeBlockId;
          return (
            <li key={entry.blockId}>
              <button
                type="button"
                ref={active ? activeRef : undefined}
                onClick={() => index >= 0 && onJump(index)}
                className={[
                  'w-full truncate rounded px-2 py-1 text-left text-xs hover:bg-[var(--reader-bg)] hover:text-[var(--reader-accent)]',
                  active ? 'toc-active' : '',
                ].join(' ')}
                style={{ paddingLeft: `${(entry.level - 1) * 12 + 8}px` }}
                title={entry.title}
              >
                {entry.title}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** 排版设置 */
function ReadingSettings() {
  const s = useSettingsStore();

  return (
    <section className="flex flex-col gap-3 p-4">
      <h2 className="text-sm font-medium">排版</h2>

      <label className="flex items-center gap-3 text-xs">
        <span className="w-14 shrink-0 text-[var(--reader-muted)]">字号</span>
        <input
          type="range"
          min={12}
          max={32}
          step={1}
          value={s.fontSize}
          onChange={(e) => s.setFontSize(Number(e.target.value))}
          className="flex-1 accent-[var(--reader-accent)]"
        />
        <span className="w-10 text-right tabular-nums">{s.fontSize}px</span>
      </label>

      <label className="flex items-center gap-3 text-xs">
        <span className="w-14 shrink-0 text-[var(--reader-muted)]">行距</span>
        <input
          type="range"
          min={1.2}
          max={3}
          step={0.05}
          value={s.lineHeight}
          onChange={(e) => s.setLineHeight(Number(e.target.value))}
          className="flex-1 accent-[var(--reader-accent)]"
        />
        <span className="w-10 text-right tabular-nums">{s.lineHeight.toFixed(2)}</span>
      </label>

      <label className="flex items-center gap-3 text-xs">
        <span className="w-14 shrink-0 text-[var(--reader-muted)]">版心</span>
        <input
          type="range"
          min={480}
          max={1100}
          step={20}
          value={s.contentWidth}
          onChange={(e) => s.setContentWidth(Number(e.target.value))}
          className="flex-1 accent-[var(--reader-accent)]"
        />
        <span className="w-12 text-right tabular-nums">{s.contentWidth}px</span>
      </label>

      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="text-[var(--reader-muted)]">字体</span>
        <select
          value={s.fontFamily}
          onChange={(e) => s.setFontFamily(e.target.value as 'serif' | 'sans')}
          className="rounded-md border border-[var(--reader-border)] bg-[var(--reader-bg)] px-2 py-1 text-xs"
        >
          <option value="serif">衬线（书卷）</option>
          <option value="sans">无衬线</option>
        </select>
      </div>

      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="text-[var(--reader-muted)]">双语布局</span>
        <select
          value={s.bilingualLayout}
          onChange={(e) => s.setBilingualLayout(e.target.value as typeof s.bilingualLayout)}
          className="rounded-md border border-[var(--reader-border)] bg-[var(--reader-bg)] px-2 py-1 text-xs"
        >
          <option value="stacked">上下对照</option>
          <option value="side-by-side">左右对照</option>
          <option value="original-only">只看原文</option>
          <option value="translation-only">只看译文</option>
        </select>
      </div>

      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="text-[var(--reader-muted)]">主题</span>
        <select
          value={s.theme}
          onChange={(e) => s.setTheme(e.target.value as typeof s.theme)}
          className="rounded-md border border-[var(--reader-border)] bg-[var(--reader-bg)] px-2 py-1 text-xs"
        >
          <option value="scroll">宣纸</option>
          <option value="sepia">米黄</option>
          <option value="dark">夜读</option>
        </select>
      </div>

      <p className="text-[11px] leading-relaxed text-[var(--reader-muted)]">
        快捷键：空格播放/暂停朗读，J 下一段，K 上一段，Esc 关闭面板。
      </p>
    </section>
  );
}
