import { useCallback, useRef, useState } from 'react';
import { FileUp, Loader2, ScanLine, X } from 'lucide-react';
import { SUPPORTED_EXTENSIONS, SUPPORTED_HINT } from '@/parsers';
import { useLibraryStore } from '@/store/libraryStore';
import { OCR_LANG_OPTIONS, type OcrLang } from '@/lib/ocrTypes';

/**
 * 估算剩余时长。
 *
 * 大任务的进度提示如果不给时间预期，用户无法判断"还要等 5 分钟还是 1 小时"，
 * 实际体验会明显变差。第一次调用时（pageNum 很小）不显示估算 —— 样本太少会给出荒唐的数字。
 */
function estimateRemaining(done: number, total: number, startedAt: number): string {
  if (done < 3) return '正在估算剩余时间…';
  const elapsed = Date.now() - startedAt;
  const perPage = elapsed / done;
  const remaining = perPage * (total - done);
  return `已用 ${formatDuration(elapsed)} · 预计还需 ${formatDuration(remaining)}（约 ${(perPage / 1000).toFixed(1)} 秒/页）`;
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

/**
 * 文件导入区。
 *
 * 交互细节都是刻意的：
 * - dragenter/dragleave 在子元素上会反复冒泡，用计数器而不是布尔值判断，
 *   否则鼠标划过内部图标就会闪一下"拖放态"；
 * - 目录拖放要过滤掉（DataTransferItem.kind === 'file' 且 getAsFile 为 null）；
 * - 上传中禁用再次点击，避免同一文件被解析两遍（PDF 解析很吃内存）。
 */
export function FileUploadZone({ compact = false }: { compact?: boolean }) {
  const importFiles = useLibraryStore((s) => s.importFiles);
  const importing = useLibraryStore((s) => s.importing);
  const progress = useLibraryStore((s) => s.importProgress);
  const scannedPdf = useLibraryStore((s) => s.scannedPdfPending);
  const ocrProgress = useLibraryStore((s) => s.ocrProgress);
  const startOcr = useLibraryStore((s) => s.startOcr);
  const cancelOcr = useLibraryStore((s) => s.cancelOcr);

  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  /** 识别页数上限；'all' 表示整本 */
  const [pageLimit, setPageLimit] = useState('10');
  /** 记录开始时间，用于估算剩余时长 */
  const [ocrStartedAt] = useState(() => Date.now());
  const [selectedLang, setSelectedLang] = useState<OcrLang>('chi_sim+eng');

  const handleFiles = useCallback(
    (fileList: FileList | null) => {
      if (!fileList?.length) return;
      void importFiles(Array.from(fileList));
    },
    [importFiles],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      handleFiles(e.dataTransfer.files);
    },
    [handleFiles],
  );

  // OCR 确认面板
  if (scannedPdf) {
    return (
      <div className="rounded-xl border-2 border-dashed border-[var(--reader-accent)] bg-[var(--reader-panel)] p-6">
        <div className="flex flex-col items-center gap-4 text-center">
          <ScanLine className="h-8 w-8 text-[var(--reader-accent)]" aria-hidden />
          <h3 className="text-base font-medium">检测到扫描版 PDF</h3>
          <p className="max-w-md text-sm text-[var(--reader-muted)]">
            「{scannedPdf.fileName}」共 {scannedPdf.pageCount} 页，全部为图片，没有可提取的文字层。
            可以使用浏览器端 AI OCR 识别文字（首次需下载约 10MB 模型）。
          </p>

          {!importing ? (
            <div className="flex flex-col items-center gap-3">
              <label className="flex items-center gap-2 text-sm">
                <span className="text-[var(--reader-muted)]">识别语言：</span>
                <select
                  value={selectedLang}
                  onChange={(e) => setSelectedLang(e.target.value as OcrLang)}
                  className="rounded border border-[var(--reader-border)] bg-[var(--reader-bg)] px-2 py-1 text-sm"
                >
                  {OCR_LANG_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </label>

              {/*
                页数上限：833 页的扫描书整本 OCR 可能要一小时。
                强制用户先小范围试跑，确认识别质量与耗时后再决定是否整本跑。
              */}
              <label className="flex items-center gap-2 text-sm">
                <span className="text-[var(--reader-muted)]">识别页数：</span>
                <select
                  value={pageLimit}
                  onChange={(e) => setPageLimit(e.target.value)}
                  className="rounded border border-[var(--reader-border)] bg-[var(--reader-bg)] px-2 py-1 text-sm"
                >
                  <option value="10">前 10 页（试跑）</option>
                  <option value="30">前 30 页</option>
                  <option value="100">前 100 页</option>
                  <option value="all">全部 {scannedPdf.pageCount} 页</option>
                </select>
              </label>

              <p className="max-w-md text-xs leading-relaxed text-[var(--reader-muted)]">
                建议先用前 10 页试跑：确认识别质量与单页耗时后再决定整本处理。
                识别失败的单页会被跳过，不会中断整个任务。
              </p>

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() =>
                    void startOcr(
                      selectedLang,
                      pageLimit === 'all' ? undefined : Number(pageLimit),
                    )
                  }
                  className="rounded-lg bg-[var(--reader-accent)] px-5 py-2 text-sm font-medium text-[var(--reader-bg)] transition-opacity hover:opacity-90"
                >
                  开始识别
                </button>
                <button
                  type="button"
                  onClick={cancelOcr}
                  className="flex items-center gap-1 rounded-lg border border-[var(--reader-border)] px-4 py-2 text-sm transition-colors hover:bg-[var(--reader-panel)]"
                >
                  <X className="h-3.5 w-3.5" />
                  取消
                </button>
              </div>
            </div>
          ) : (
            <div className="flex w-full max-w-md flex-col items-center gap-2">
              <Loader2 className="h-6 w-6 animate-spin text-[var(--reader-accent)]" aria-hidden />
              <p className="text-sm">
                {ocrProgress?.status === 'initializing'
                  ? '正在加载 OCR 引擎…'
                  : `正在识别第 ${ocrProgress?.pageNum ?? 0} / ${ocrProgress?.total ?? scannedPdf.pageCount} 页…`}
              </p>

              {/* 进度条：833 页的任务必须让用户看到"在动"，否则会以为卡死 */}
              {ocrProgress && ocrProgress.total > 0 && ocrProgress.status === 'recognizing' && (
                <>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--reader-border)]">
                    <div
                      className="h-full bg-[var(--reader-accent)] transition-[width] duration-300"
                      style={{
                        width: `${Math.round((ocrProgress.pageNum / ocrProgress.total) * 100)}%`,
                      }}
                    />
                  </div>
                  <p className="text-xs text-[var(--reader-muted)]">
                    {estimateRemaining(ocrProgress.pageNum, ocrProgress.total, ocrStartedAt)}
                  </p>
                </>
              )}

              <p className="text-xs text-[var(--reader-muted)]">
                {ocrProgress?.status === 'initializing'
                  ? '首次使用需下载 AI 模型（约 10MB），请耐心等待'
                  : '识别期间请保持标签页在前台，后台标签页会被浏览器降频'}
              </p>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      onDragEnter={(e) => {
        e.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        dragDepth.current -= 1;
        if (dragDepth.current <= 0) setDragging(false);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
      className={[
        'rounded-xl border-2 border-dashed transition-colors',
        compact ? 'p-4' : 'p-8',
        dragging ? 'border-[var(--reader-accent)] bg-[var(--reader-panel)]' : 'border-[var(--reader-border)]',
      ].join(' ')}
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={SUPPORTED_EXTENSIONS.join(',')}
        className="hidden"
        onChange={(e) => {
          handleFiles(e.target.files);
          e.target.value = '';
        }}
      />

      <div className="flex flex-col items-center gap-3 text-center">
        {importing ? (
          <>
            <Loader2 className="h-7 w-7 animate-spin text-[var(--reader-accent)]" aria-hidden />
            <p className="text-sm">
              正在解析
              {progress ? ` (${progress.done + 1}/${progress.total})` : ''}
              {progress?.currentName ? `：${progress.currentName}` : '…'}
            </p>
            <p className="text-xs text-[var(--reader-muted)]">
              大文件（尤其是 PDF）需要几秒，请勿关闭页面
            </p>
          </>
        ) : (
          <>
            <FileUp className="h-7 w-7 text-[var(--reader-muted)]" aria-hidden />
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="rounded-lg bg-[var(--reader-accent)] px-4 py-2 text-sm font-medium text-[var(--reader-bg)] transition-opacity hover:opacity-90"
            >
              选择文件
            </button>
            <p className="text-xs text-[var(--reader-muted)]">
              或把文件拖到这里 · 支持 {SUPPORTED_HINT}
            </p>
            <p className="text-xs text-[var(--reader-muted)]">
              文件全程只在你本机浏览器中解析，不会上传到任何服务器
            </p>
          </>
        )}
      </div>
    </div>
  );
}
