import { useState } from 'react';
import { FileText, Trash2, BookOpen, AlertTriangle, X } from 'lucide-react';
import { useLibraryStore } from '@/store/libraryStore';
import { FileUploadZone } from '@/components/FileUploadZone';
import {
  dismissDiagnostics,
  getDiagnosticsSignature,
  getInterruptedOcr,
  getLastReloadReason,
  getOcrStageTrail,
  getPersistentOcrCrash,
  getReloadCount,
  isDiagnosticsDismissed,
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
  const ocrStructure = useLibraryStore((s) => s.ocrStructure);
  const cancelOcr = useLibraryStore((s) => s.cancelOcr);

  /** 「复制识别结构」按钮的反馈状态：用户必须知道到底复制成功了没有 */
  const [copyState, setCopyState] = useState<'idle' | 'done' | 'failed'>('idle');

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
  const crashCount = getPersistentOcrCrash()?.count ?? 0;

  /**
   * 报告的签名 + 「已关闭」状态。
   *
   * `showDiagnostics` 每次渲染都从存储重算，所以只把它从界面上藏起来是不够的：
   * 组件重新挂载（切到阅读器再回来）它就回来了，× 会显得是坏的。
   * 因此关闭动作记的是**这一份报告的签名**，并且用 state 触发重渲染。
   *
   * 记签名而不是一个 boolean，是为了**下次真的又出问题时提示还能回来** ——
   * 那才是最该被看到的时刻。
   */
  const signature = getDiagnosticsSignature({
    reloadCount,
    interrupted,
    crashCount,
    stageCount: stageTrail.length,
  });
  const [dismissedSignature, setDismissedSignature] = useState<string | null>(() =>
    isDiagnosticsDismissed(signature) ? signature : null,
  );
  const showDiagnostics =
    (reloadCount > 1 || interrupted !== null) && dismissedSignature !== signature;

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
        <Banner
          tone="warn"
          onClose={() => {
            dismissDiagnostics(signature);
            setDismissedSignature(signature);
          }}
        >
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

          {/*
            「复制识别结构」出口。
            存在的理由见 `lib/ocrStructure.ts` 顶部：上下标（指数、下标）的判定
            完全是几何的，而它此前只在**手工合成的坐标**上验证过 ——
            真实扫描件上是否成立，只能靠用户把真实数据发出来才能判断。

            文案刻意说清「这是什么、有什么用」：用户不是开发者，
            只写「识别结构」四个字，他不知道该不该点、点了会发生什么。
          */}
          {ocrStructure && (
            <div className="mt-2 border-t border-amber-400/40 pt-2">
              <button
                type="button"
                onClick={() => {
                  void (async () => {
                    const ok = await copyTextToClipboard(ocrStructure.json);
                    setCopyState(ok ? 'done' : 'failed');
                  })();
                }}
                className="rounded-lg border border-amber-500/50 px-2.5 py-1 text-xs font-medium transition-colors hover:bg-amber-500/15"
              >
                复制识别结构（第 {ocrStructure.pageNum} 页，{ocrStructure.linesTotal} 行 /{' '}
                {ocrStructure.wordsTotal} 个词）
              </button>
              <p className="mt-1 text-[11px] opacity-80">
                {copyState === 'done'
                  ? '已复制到剪贴板。把它粘贴给开发者，就能按真实数据校准公式识别。'
                  : copyState === 'failed'
                    ? '复制失败：浏览器拒绝了剪贴板操作。请改用 https 打开本页，或按 F12 在控制台里手动取出内容。'
                    : '这是一页的原始识别数据（每个字的位置与大小，以及分行分段的中间结果），' +
                      '不含图片，也不会联网。公式（例如指数）识别不对时，把它发给开发者最有用。'}
              </p>
            </div>
          )}
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

/**
 * 把文本写进剪贴板，返回是否成功。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么必须有 execCommand 这条退路
 * ═══════════════════════════════════════════════════════════════
 *
 * `navigator.clipboard` **只在安全上下文里存在**（https 或 localhost）。
 * 本应用会被部署到普通 http 地址上，也会被装成 PWA 从别的来源打开 ——
 * 那些情况下 `navigator.clipboard` 是 `undefined`，
 * 只写异步 API 就会得到「点下去什么都没发生」，而用户根本不知道原因。
 *
 * 退路用 `document.execCommand('copy')`（已废弃但浏览器仍普遍支持），
 * 它需要一个真实被选中的节点，所以这里临时插一个 textarea 再移除。
 *
 * 两条路都失败时**如实返回 false**，由调用方把原因显示给用户 ——
 * 「按钮点了没反应」是最难排查的一类反馈。
 */
async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 落到下面的退路（例如权限被拒）
  }

  try {
    const area = document.createElement('textarea');
    area.value = text;
    // 固定定位 + 透明：避免插入瞬间页面跳动
    area.style.position = 'fixed';
    area.style.top = '0';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
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
      {/*
        只在实际给了关闭处理时才画这个 ×。
        原先它无条件渲染，而诊断横幅当初没传 onClose ——
        于是「× 画出来了、点下去没反应」。没有处理函数的关闭按钮
        比没有按钮更糟：用户会以为界面坏了。
      */}
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭提示"
          className="shrink-0 rounded p-0.5 opacity-70 transition-opacity hover:opacity-100"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      )}
    </div>
  );
}
