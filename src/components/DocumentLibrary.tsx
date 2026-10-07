import { FileText, Trash2, BookOpen, AlertTriangle, X } from 'lucide-react';
import { useLibraryStore } from '@/store/libraryStore';
import { FileUploadZone } from '@/components/FileUploadZone';
import {
  getInterruptedOcr,
  getLastReloadReason,
  getOcrStageTrail,
  getReloadCount,
} from '@/lib/sessionDiagnostics';

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

  /**
   * 会话诊断：把「页面被刷新过几次」「上次识别断在第几页」**显示在界面上**。
   *
   * 这不是给开发者看的调试信息，而是**唯一能在没有控制台的情况下
   * 区分三种故障形态**的手段（用户很可能在手机 / iOS Safari 上，那里没有 DevTools）：
   *   - 刷新次数 > 1  → 页面确实在被反复重载，问题在重载；
   *   - 有中断记录    → 重载发生在识别途中，且能看出跑到多远；
   *   - 两者都没有    → 页面没重载，问题在识别或入库本身。
   *
   * 只在确有异常时才显示，正常使用看不到它。
   */
  const reloadCount = getReloadCount();
  const interrupted = getInterruptedOcr();
  const lastReload = getLastReloadReason();
  const stageTrail = getOcrStageTrail();
  const showDiagnostics = reloadCount > 1 || interrupted !== null;

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

      {showDiagnostics && (
        <Banner tone="warn">
          <p className="font-medium">检测到上次会话异常中断</p>
          <ul className="mt-1 list-inside list-disc space-y-0.5">
            {reloadCount > 1 && (
              <li>
                本页已被加载 <b>{reloadCount}</b> 次 —— 刷新来源：
                <b>
                  {lastReload
                    ? lastReload.label
                    : '不是应用发起的（三条刷新路径都没有记录，最可能是浏览器自身回收了标签页，通常是内存不足）'}
                </b>
              </li>
            )}
            {interrupted && (
              <li>
                上次扫描版 PDF 识别进行到第 <b>{interrupted.pageNum}</b> / {interrupted.total} 页时被打断
                —— 已识别完成的部分已保存在本机，重新打开那本书即可看到
              </li>
            )}
            {stageTrail.length > 0 && (
              <li>
                中断前走过的步骤：
                <ul className="mt-0.5 list-inside list-disc space-y-0.5 opacity-90">
                  {stageTrail.map((s, i) => (
                    <li key={`${s.stage}-${i}`}>
                      {s.stage}
                      {s.detail ? ` —— ${s.detail}` : ''}
                    </li>
                  ))}
                </ul>
              </li>
            )}
          </ul>
          <p className="mt-1 text-[11px] opacity-80">
            关掉标签页后这条提示会消失。若反复出现，说明识别过程被系统中断了。
          </p>
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
  /** 可选：会话诊断条没有「关闭」语义（关掉标签页它自然消失），因此不强制提供 */
  onClose?: () => void;
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
