import { useMemo, useState } from 'react';
import { Download, Highlighter, MessageSquare, Search, Trash2, TriangleAlert } from 'lucide-react';
import type { Annotation, ContentBlock } from '@/types/content';
import { TYPE_LABEL, useAnnotationsStore } from '@/store/annotationsStore';
import { HIGHLIGHT_COLORS } from '@/types/content';

/** 批量下载文本为文件；不经过服务器，纯前端 Blob */
function downloadText(filename: string, content: string, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // 立刻 revoke 在部分浏览器会导致下载中断，延后释放
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * 批注侧栏。
 *
 * 一个关键取舍：批注失锚（文档被重新解析后找不到原文位置）时不删除，
 * 而是标记出来让用户自己确认。静默丢弃用户的笔记是最不可接受的行为。
 */
export function AnnotationSidebar({
  blocks,
  docTitle,
  onJump,
}: {
  blocks: ContentBlock[];
  docTitle: string;
  onJump: (blockId: string) => void;
}) {
  const annotations = useAnnotationsStore((s) => s.annotations);
  const activeId = useAnnotationsStore((s) => s.activeAnnotationId);
  const setActive = useAnnotationsStore((s) => s.setActive);
  const remove = useAnnotationsStore((s) => s.remove);
  const update = useAnnotationsStore((s) => s.update);
  const exportAs = useAnnotationsStore((s) => s.exportAs);

  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | Annotation['type']>('all');

  const blockMap = useMemo(() => new Map(blocks.map((b) => [b.id, b])), [blocks]);

  /** 失锚检测：有选区但原文中找不到 */
  const lostIds = useMemo(() => {
    const lost = new Set<string>();
    for (const a of annotations) {
      if (!a.anchor) continue;
      const block = blockMap.get(a.blockId);
      if (!block) {
        lost.add(a.id);
        continue;
      }
      if (!block.content.includes(a.anchor.selectedText)) lost.add(a.id);
    }
    return lost;
  }, [annotations, blockMap]);

  const filtered = annotations.filter((a) => {
    if (typeFilter !== 'all' && a.type !== typeFilter) return false;
    if (!query.trim()) return true;
    const q = query.toLowerCase();
    return (
      (a.content ?? '').toLowerCase().includes(q) ||
      (a.anchor?.selectedText ?? '').toLowerCase().includes(q) ||
      a.tags.some((t) => t.toLowerCase().includes(q))
    );
  });

  return (
    <aside className="flex h-full flex-col">
      <header className="flex flex-col gap-2 border-b border-[var(--reader-border)] p-4">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <Highlighter className="h-4 w-4 text-[var(--reader-accent)]" aria-hidden />
          批注
          <span className="text-xs text-[var(--reader-muted)]">({annotations.length})</span>
        </h2>

        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--reader-muted)]"
            aria-hidden
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索原文或笔记"
            className="w-full rounded-md border border-[var(--reader-border)] bg-[var(--reader-bg)] py-1.5 pl-7 pr-2 text-xs outline-none focus:border-[var(--reader-accent)]"
          />
        </div>

        <div className="flex flex-wrap gap-1 text-[11px]">
          {(['all', 'highlight', 'note', 'question', 'tag'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTypeFilter(t)}
              className={[
                'rounded-full border px-2 py-0.5 transition-colors',
                typeFilter === t
                  ? 'border-[var(--reader-accent)] text-[var(--reader-accent)]'
                  : 'border-[var(--reader-border)] text-[var(--reader-muted)] hover:bg-[var(--reader-panel)]',
              ].join(' ')}
            >
              {t === 'all' ? '全部' : TYPE_LABEL[t]}
            </button>
          ))}
        </div>
      </header>

      <div className="reader-scroll flex-1 overflow-y-auto p-4">
        {filtered.length === 0 ? (
          <p className="text-xs leading-relaxed text-[var(--reader-muted)]">
            还没有批注。在正文里用鼠标选中一段文字，再点击浮出的工具条即可高亮或写笔记。
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {filtered.map((a) => {
              const isLost = lostIds.has(a.id);
              const isActive = activeId === a.id;

              return (
                <li
                  key={a.id}
                  className={[
                    'rounded-lg border p-3 text-xs transition-colors',
                    isActive
                      ? 'border-[var(--reader-accent)] bg-[var(--reader-panel)]'
                      : 'border-[var(--reader-border)] hover:bg-[var(--reader-panel)]',
                  ].join(' ')}
                >
                  <div className="mb-1.5 flex items-center gap-2">
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      data-color={a.color}
                      style={{ background: 'var(--hl-color)' }}
                      aria-hidden
                    />
                    <button
                      type="button"
                      onClick={() => {
                        setActive(a.id);
                        onJump(a.blockId);
                      }}
                      className="font-medium hover:text-[var(--reader-accent)]"
                    >
                      {TYPE_LABEL[a.type]}
                    </button>
                    <span className="ml-auto text-[10px] text-[var(--reader-muted)]">
                      {a.createdAt.slice(0, 10)}
                    </span>
                    <button
                      type="button"
                      onClick={() => void remove(a.id)}
                      aria-label="删除批注"
                      className="text-[var(--reader-muted)] hover:text-red-500"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  </div>

                  {a.anchor?.selectedText && (
                    <blockquote
                      className="mb-1.5 border-l-2 border-[var(--reader-border)] pl-2 italic text-[var(--reader-muted)]"
                      data-color={a.color}
                    >
                      {a.anchor.selectedText.length > 120
                        ? `${a.anchor.selectedText.slice(0, 120)}…`
                        : a.anchor.selectedText}
                    </blockquote>
                  )}

                  {a.content && <p className="whitespace-pre-wrap leading-relaxed">{a.content}</p>}

                  {isLost && (
                    <p className="mt-1.5 flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-400">
                      <TriangleAlert className="h-3 w-3" aria-hidden />
                      原文已改动，无法定位到具体位置
                    </p>
                  )}

                  <div className="mt-2 flex items-center gap-1.5">
                    {HIGHLIGHT_COLORS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        aria-label={`改为${c}色`}
                        data-color={c}
                        onClick={() => void update(a.id, { color: c })}
                        className="h-3.5 w-3.5 rounded-full border border-[var(--reader-border)]"
                        style={{ background: 'var(--hl-color)' }}
                      />
                    ))}
                    <button
                      type="button"
                      onClick={() => {
                        const note = prompt('编辑笔记', a.content ?? '');
                        if (note !== null) void update(a.id, { content: note });
                      }}
                      className="ml-auto flex items-center gap-1 text-[10px] text-[var(--reader-muted)] hover:text-[var(--reader-accent)]"
                    >
                      <MessageSquare className="h-3 w-3" aria-hidden />
                      编辑
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <footer className="flex gap-2 border-t border-[var(--reader-border)] p-3">
        <button
          type="button"
          disabled={!annotations.length}
          onClick={() => {
            const map = new Map(blocks.map((b) => [b.id, b.content]));
            downloadText(
              `${docTitle}-批注.json`,
              exportAs('json', docTitle, map),
              'application/json;charset=utf-8',
            );
          }}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-[var(--reader-border)] px-2 py-1.5 text-[11px] hover:bg-[var(--reader-panel)] disabled:opacity-40"
        >
          <Download className="h-3 w-3" aria-hidden />
          JSON
        </button>
        <button
          type="button"
          disabled={!annotations.length}
          onClick={() => {
            const map = new Map(blocks.map((b) => [b.id, b.content]));
            downloadText(`${docTitle}-批注.md`, exportAs('markdown', docTitle, map));
          }}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-[var(--reader-border)] px-2 py-1.5 text-[11px] hover:bg-[var(--reader-panel)] disabled:opacity-40"
        >
          <Download className="h-3 w-3" aria-hidden />
          Markdown
        </button>
      </footer>
    </aside>
  );
}
