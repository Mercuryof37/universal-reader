import { FileText, Trash2, BookOpen, AlertTriangle, X } from 'lucide-react';
import { useLibraryStore } from '@/store/libraryStore';
import { FileUploadZone } from '@/components/FileUploadZone';

const FORMAT_LABEL: Record<string, string> = {
  markdown: 'MD',
  plaintext: 'TXT',
  pdf: 'PDF',
  epub: 'EPUB',
};

/** 文档库：导入入口 + 已导入文档列表 */
export function DocumentLibrary({ onOpen }: { onOpen?: () => void }) {
  const documents = useLibraryStore((s) => s.documents);
  const loading = useLibraryStore((s) => s.loading);
  const error = useLibraryStore((s) => s.error);
  const importErrors = useLibraryStore((s) => s.lastImportErrors);
  const openDocument = useLibraryStore((s) => s.openDocument);
  const removeDocument = useLibraryStore((s) => s.removeDocument);
  const clearError = useLibraryStore((s) => s.clearError);
  const ocrSummary = useLibraryStore((s) => s.ocrSummary);
  const cancelOcr = useLibraryStore((s) => s.cancelOcr);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-xl font-semibold">文档库</h1>
          <p className="mt-1 text-xs text-[var(--reader-muted)]">
            {documents.length ? `共 ${documents.length} 篇 · 全部保存在本机浏览器` : '还没有导入任何文档'}
          </p>
        </div>
      </header>

      <FileUploadZone />

      {error && (
        <Banner tone="error" onClose={clearError}>
          {error}
        </Banner>
      )}

      {ocrSummary && (
        <Banner tone="warn" onClose={cancelOcr}>
          <p className="font-medium">OCR 完成：成功识别 {ocrSummary.pagesProcessed} 页</p>
          <ul className="mt-1 list-inside list-disc space-y-0.5">
            {ocrSummary.pagesSkipped > 0 && <li>{ocrSummary.pagesSkipped} 页为空白页或纯图片，已跳过</li>}
            {ocrSummary.failures.length > 0 && (
              <li>
                以下 {ocrSummary.failures.length} 页识别失败，已跳过：
                {ocrSummary.failures.slice(0, 20).join('、')}
                {ocrSummary.failures.length > 20 && ' …'}
              </li>
            )}
          </ul>
          <p className="mt-1 text-[11px] opacity-80">
            失败的页面不会中断整个任务。如需补齐，可对原文件重新执行 OCR。
          </p>
        </Banner>
      )}

      {importErrors.length > 0 && (
        <Banner tone="warn" onClose={clearError}>
          <p className="font-medium">有 {importErrors.length} 个文件未能导入：</p>
          <ul className="mt-1 list-inside list-disc space-y-0.5">
            {importErrors.map((e) => (
              <li key={`${e.fileName}-${e.message}`}>
                {e.fileName}：{e.message}
              </li>
            ))}
          </ul>
        </Banner>
      )}

      {loading && <p className="text-sm text-[var(--reader-muted)]">读取中…</p>}

      {!loading && documents.length === 0 && (
        <p className="text-sm text-[var(--reader-muted)]">
          导入一份 Markdown、TXT、PDF 或 EPUB 就能开始阅读。所有解析与存储都在本地完成。
        </p>
      )}

      <ul className="flex flex-col gap-3">
        {documents.map((doc) => (
          <li
            key={doc.id}
            className="group flex items-center gap-4 rounded-xl border border-[var(--reader-border)] bg-[var(--reader-panel)] p-4 transition-shadow hover:shadow-[0_2px_14px_var(--reader-shadow)]"
          >
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-[var(--reader-border)] text-[10px] font-semibold tracking-wide text-[var(--reader-muted)]">
              {FORMAT_LABEL[doc.format] ?? 'DOC'}
            </div>

            <div className="min-w-0 flex-1">
              <button
                type="button"
                onClick={() => {
                  void openDocument(doc.id);
                  onOpen?.();
                }}
                className="block w-full truncate text-left text-sm font-medium hover:text-[var(--reader-accent)]"
                title={doc.title}
              >
                {doc.title}
              </button>
              <p className="mt-0.5 truncate text-xs text-[var(--reader-muted)]">
                {doc.metadata.author ? `${doc.metadata.author} · ` : ''}
                {doc.metadata.charCount.toLocaleString()} 字 · {doc.blockCount} 段 ·{' '}
                {doc.metadata.sourceFile}
              </p>
            </div>

            <button
              type="button"
              onClick={() => {
                void openDocument(doc.id);
                onOpen?.();
              }}
              className="flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs text-[var(--reader-accent)] hover:bg-[var(--reader-bg)]"
            >
              <BookOpen className="h-3.5 w-3.5" aria-hidden />
              阅读
            </button>

            <button
              type="button"
              onClick={() => {
                if (confirm(`确定删除《${doc.title}》？该文档的所有批注也会一并删除。`)) {
                  void removeDocument(doc.id);
                }
              }}
              aria-label={`删除 ${doc.title}`}
              className="rounded-lg p-2 text-[var(--reader-muted)] transition-colors hover:bg-[var(--reader-bg)] hover:text-red-500"
            >
              <Trash2 className="h-4 w-4" aria-hidden />
            </button>
          </li>
        ))}
      </ul>

      <footer className="pt-2 text-xs text-[var(--reader-muted)]">
        <p className="flex items-center gap-1.5">
          <FileText className="h-3.5 w-3.5" aria-hidden />
          数据存放在 IndexedDB，清除浏览器站点数据会一并清除已导入的文档与批注。
        </p>
      </footer>
    </div>
  );
}

function Banner({
  tone,
  children,
  onClose,
}: {
  tone: 'error' | 'warn';
  children: React.ReactNode;
  onClose: () => void;
}) {
  const color =
    tone === 'error'
      ? 'border-red-400/60 bg-red-500/10 text-red-700 dark:text-red-300'
      : 'border-amber-400/60 bg-amber-500/10 text-amber-800 dark:text-amber-200';

  return (
    <div
      className={`flex items-start gap-2 rounded-lg border p-3 text-sm ${color}`}
      role="alert"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      {/* 用 whitespace-pre-line 保留解析器错误里的换行与空行：
          扫描件、加密、损坏这几类错误的处置办法是分段的，挤成一行很难读 */}
      <div className="min-w-0 flex-1 whitespace-pre-line leading-relaxed">{children}</div>
      <button type="button" onClick={onClose} aria-label="关闭提示">
        <X className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}
