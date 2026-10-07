import { useCallback, useRef, useState } from 'react';
import { FileUp, Loader2, ScanLine, X } from 'lucide-react';
import { SUPPORTED_EXTENSIONS, SUPPORTED_HINT } from '@/parsers';
import { useLibraryStore } from '@/store/libraryStore';
import { useSettingsStore } from '@/store/settingsStore';
import { OCR_LANG_OPTIONS, type OcrLang } from '@/lib/ocrTypes';
import { detectOcrSupport } from '@/lib/ocrSupport';
import { getInterruptedOcr, getLastReloadReason, getPersistentOcrCrash } from '@/lib/sessionDiagnostics';

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

  const formulaOcrEnabled = useSettingsStore((s) => s.formulaOcrEnabled);
  const setFormulaOcrEnabled = useSettingsStore((s) => s.setFormulaOcrEnabled);

  // 环境能力与「这台机器上崩过几次」只判定一次，结果不会在会话中变化。
  const [ocrSupport] = useState(() => {
    const interrupted = getInterruptedOcr();
    const lastReload = getLastReloadReason();
    return detectOcrSupport({
      hadInterruptedRun: interrupted !== null,
      // 三条应用内刷新路径都没有记录 ⇒ 页面是被外部（浏览器）中断的
      interruptedByExternal: interrupted !== null && lastReload === null,
      // 跨会话的持久记录：关掉标签页后 sessionStorage 就没了，
      // 只有它能让用户「重开浏览器」之后仍然看到提醒
      persistentCrashCount: getPersistentOcrCrash()?.count ?? 0,
    });
  });

  // 用户是否点了「仍要尝试」，覆盖掉基于历史记录的拦截。
  // 必须和上面那些 hook 放在一起 —— 组件后面有提前 return，
  // 在那里声明 hook 会违反 Hooks 规则（渲染间顺序不一致）。
  const [supportOverridden, setSupportOverridden] = useState(false);
  /** 是否禁止开始识别：能力确实缺失时禁止；仅历史记录拦截时允许用户覆盖 */
  const ocrBlocked = ocrSupport.level === 'unsupported' && !supportOverridden;

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
            可以使用浏览器端 AI OCR 识别文字（首次需下载约 30MB 模型）。
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

              {/*
                环境判定：内核不支持 / 疑似有问题时，在**开始之前**就说清楚。
                起因见 lib/ocrSupport.ts 的注释 —— 某外壳浏览器会在推理时
                把整个页面弄没，不留任何报错，用户与应用都无从判断。
              */}
              {ocrSupport.level !== 'ok' && (
                <div
                  className={
                    'max-w-md rounded-md border p-3 text-xs leading-relaxed ' +
                    (ocrSupport.level === 'unsupported'
                      ? 'border-red-500/40 bg-red-500/10 text-red-900 dark:text-red-100'
                      : 'border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-100')
                  }
                >
                  <p className="font-medium">
                    {ocrSupport.level === 'unsupported'
                      ? '当前浏览器内核不支持此功能'
                      : `当前浏览器可能无法稳定运行此功能${ocrSupport.problemBrowser ? `（${ocrSupport.problemBrowser}）` : ''}`}
                  </p>

                  <p className="mt-1 whitespace-pre-line">{ocrSupport.reason}</p>

                  <p className="mt-2">
                    <span className="font-medium">推荐使用：</span>
                    {ocrSupport.recommendation}
                  </p>

                  <p className="mt-1 opacity-80">
                    只有扫描版 PDF 的文字识别需要用到这些能力；
                    文字版 PDF 与 Markdown / TXT / EPUB 不受影响，可以正常导入阅读。
                  </p>

                  {/*
                    覆盖入口：**只有基于历史记录**（崩溃次数）的拦截才给这个出口。
                    能力确实缺失时（缺 WASM/SIMD）点了也一定失败，不给。
                    理由：历史不等于未来，代码一直在改；用户实测就被这一点挡过 ——
                    他的 3 次崩溃都发生在已经修好的旧版本上。
                  */}
                  {ocrSupport.canOverride && (
                    <button
                      type="button"
                      onClick={() => setSupportOverridden(true)}
                      className="mt-2 rounded-md border border-current px-2 py-1 text-xs font-medium transition-opacity hover:opacity-80"
                    >
                      仍要尝试
                    </button>
                  )}
                </div>
              )}

              <p className="max-w-md text-xs leading-relaxed text-[var(--reader-muted)]">
                建议先用前 10 页试跑：确认识别质量与单页耗时后再决定整本处理。
                识别失败的单页会被跳过，不会中断整个任务。
              </p>

              {/*
                隐私开关：公式增强是全应用唯一会把文档内容送出本机的路径
                （页面局部像素 → 自建 Worker → 第三方 SimpleTex）。
                默认关闭，且必须由用户在这里显式打开。
              */}
              <label className="flex max-w-md items-start gap-2 rounded-md border border-[var(--reader-border)] p-2 text-xs leading-relaxed">
                <input
                  type="checkbox"
                  checked={formulaOcrEnabled}
                  onChange={(e) => setFormulaOcrEnabled(e.target.checked)}
                  className="mt-0.5 accent-[var(--reader-accent)]"
                />
                <span>
                  <span className="font-medium">上传公式区域以换取更准的公式</span>
                  <span className="block text-[var(--reader-muted)]">
                    打开后，识别到公式时会把<span className="font-medium">那一小块图片</span>
                    发往第三方服务（SimpleTex）换取 LaTeX，
                    <span className="font-medium">需要联网</span>。默认关闭 ——
                    不打开就没有任何内容离开本机，公式会保留为 OCR 的原始文字（可能是乱码）。
                  </span>
                </span>
              </label>

              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={ocrBlocked}
                  /**
                   * 内核确实不支持时**直接挡住**，而不是让用户点下去撞崩溃。
                   * 上面那块提示已经说明了原因与替代浏览器，
                   * 这里再点一次只会浪费他的时间，还可能把页面弄没、丢掉已导入的文件。
                   *
                   * 注意只对 `unsupported`（能力实测缺失）硬挡；
                   * `risky`（已知外壳浏览器 / 上次崩过）**不禁用** ——
                   * 那两条是启发式与历史记录，不该剥夺用户再试一次的机会。
                   */
                  title={
                    ocrBlocked
                      ? '当前浏览器内核不支持文字识别，请改用推荐浏览器'
                      : undefined
                  }
                  onClick={() =>
                    void startOcr(
                      selectedLang,
                      pageLimit === 'all' ? undefined : Number(pageLimit),
                    )
                  }
                  className="rounded-lg bg-[var(--reader-accent)] px-5 py-2 text-sm font-medium text-[var(--reader-bg)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
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
                  ? '首次使用需下载 AI 模型（约 30MB），请耐心等待'
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
