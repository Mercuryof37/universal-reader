import { useState, useSyncExternalStore } from 'react';
import { FileText, Trash2, BookOpen, AlertTriangle, X } from 'lucide-react';
import { useLibraryStore } from '@/store/libraryStore';
import { FileUploadZone } from '@/components/FileUploadZone';
import {
  getModelTierBootRecord,
  modelTierBootBannerTitle,
  modelTierBootNoteworthy,
  renderModelTierBootReport,
  subscribeModelTierBoot,
} from '@/lib/modelTierBoot';
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
import { renderLayoutSummaryLine } from '@/lib/ocrPostProcess';

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

  /**
   * 模型资产就位（启动钩子 `bootModelTierAssets`）的结论。
   *
   * ═══════════════════════════════════════════════════════════════
   * 为什么必须显示出来，而不是只 `console.warn`
   * ═══════════════════════════════════════════════════════════════
   *
   * 那次运行发生在 Service Worker 注册成功之后，而**它的失败恰恰会让
   * 「装上就能离线读」这个卖点失效** —— 用户看到的现象只是「断网时识别不了」，
   * 与「这个浏览器本来就不支持」长得一模一样。
   *
   * 而这个项目的用户多半在手机 / iOS Safari 上，**没有 DevTools 可看**
   * （见 `sessionDiagnostics.ts` 顶部那段同样的理由）。所以结论必须
   * 出现在界面上，并且能一键复制成可上报的文本。
   *
   * ⚠️ 只有「值得让人知道」的结果才显示（见 `modelTierBootNoteworthy`）：
   * 正常路径一条都不弹 —— 每次都弹「一切正常」会训练用户无视横幅，
   * 真正要命的那条也就跟着看不见了。安静不等于没记录：
   * `getModelTierBootRecord()` 在任何情况下都拿得到完整结论。
   */
  const modelBoot = useSyncExternalStore(
    subscribeModelTierBoot,
    getModelTierBootRecord,
    // 服务端快照（本项目不做 SSR，给一个稳定值即可满足签名）
    () => null,
  );
  const [bootCopyState, setBootCopyState] = useState<'idle' | 'done' | 'failed'>('idle');

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

      {modelBoot && modelTierBootNoteworthy(modelBoot) && (
        <Banner tone="warn">
          <p className="font-medium">{modelTierBootBannerTitle(modelBoot)}</p>
          <p className="mt-1">{modelBoot.detail}</p>
          <p className="mt-1 text-[11px] opacity-80">
            质量档位：{modelBoot.tierLabel}（{modelBoot.tier}）· 缓存：{modelBoot.cacheName}
            {modelBoot.failed.length > 0 && ` · 下载失败 ${modelBoot.failed.length} 个`}
            {modelBoot.cleaned.length > 0 && ` · 已清理旧档位缓存 ${modelBoot.cleaned.length} 个`}
          </p>
          {/*
            复制出口：用户没有控制台，而这条结论里带着判断用的**原始数字**
            （单文件上限、已用 / 配额、逐项 URL）。不给他一个复制按钮，
            这些数字就永远留在他的浏览器里 —— 与 `ocrStructure` 同一个理由。
          */}
          <div className="mt-2 border-t border-amber-400/40 pt-2">
            <button
              type="button"
              onClick={() => {
                void (async () => {
                  const ok = await copyTextToClipboard(renderModelTierBootReport(modelBoot));
                  setBootCopyState(ok ? 'done' : 'failed');
                })();
              }}
              className="rounded-lg border border-amber-500/50 px-2.5 py-1 text-xs font-medium transition-colors hover:bg-amber-500/15"
            >
              复制模型资产诊断
            </button>
            <p className="mt-1 text-[11px] opacity-80">
              {bootCopyState === 'done'
                ? '已复制到剪贴板。把它发给开发者，就能看出是哪一步没准备好。'
                : bootCopyState === 'failed'
                  ? '复制失败：浏览器拒绝了剪贴板操作。请改用 https 打开本页，或按 F12 在控制台里执行 __modelTierBoot()。'
                  : '这份文本说明模型资产走到哪一步、卡在哪里，不含正文内容，也不会联网。'}
            </p>
          </div>
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

          {/*
            ═══════════════════════════════════════════════════════════
            T2 文档级版面汇总 —— 逐页数字在这里第一次变成「这本书的结论」
            ═══════════════════════════════════════════════════════════

            为什么要有这一块：逐页的 `layout-metrics` 每页打一行，
            一本 30 页的书就是 30 行，而「这本书里版面模型一共改了多少」
            此前没有任何读点 —— 也就是说这个数在真实运行里**没人得到过**。

            ⚠️ 刻意把「一次都没接入」与「接入了但没改动」分成两句不同的话：
            前者要查模型有没有加载（或用户关没关开关），后者要查模型判得对不对。
            这两种情况的下一步动作相反，所以不能用一句「版面改动 0 行」糊过去。

            ⚠️ 判据是 `pagesWithLayout`（**真的拿到区域的页数**），不是 `pages`：
            模型缺席时 `applyLayoutToLines` 也会交出一份「全 0」报告，
            所以 `pages` 在两种情况下都可能很大 —— 拿它当判据会把
            「没接入」误报成「接入了但没改动」。
          */}
          <div className="mt-2 border-t border-amber-400/40 pt-2">
            {ocrSummary.layoutSummary.pagesWithLayout === 0 ? (
              <p className="text-[11px] opacity-80">
                版面分析本次<strong>一次都没接入</strong>（模型未取到 / 推理失败 / 已被关闭），
                页眉页脚与阅读顺序全部走几何启发式 —— 这不是「版面模型没改动」。
              </p>
            ) : (
              <>
                <p className="text-[11px] opacity-90">
                  版面分析：接入 {ocrSummary.layoutSummary.pagesWithLayout} 页
                  {ocrSummary.layoutSummary.pages > ocrSummary.layoutSummary.pagesWithLayout &&
                    `（共 ${ocrSummary.layoutSummary.pages} 页有版面报告）`}
                  ，额外摘掉页面家具 {ocrSummary.layoutSummary.removedByLayout} 行
                  {Object.keys(ocrSummary.layoutSummary.removedByLabel).length > 0 &&
                    `（${Object.entries(ocrSummary.layoutSummary.removedByLabel)
                      .map(([label, n]) => `${label}×${n}`)
                      .join('、')}）`}
                  ，重排阅读顺序 {ocrSummary.layoutSummary.reorderedPages} 页，
                  标题判定被改动{' '}
                  {Object.values(ocrSummary.layoutSummary.headingUse).reduce((a, b) => a + b, 0)} 次。
                </p>
                <p className="mt-1 text-[11px] opacity-80">
                  这是<strong>这一本书的总数</strong>（逐页明细仍在控制台的 layout-metrics 行里）。
                  它只说明版面模型改动了多少，<strong>不说明改得对不对</strong> ——
                  后者需要人工标注，见 npm run eval:layout。
                </p>
                {/* 单行 JSON：与 `renderLayoutSummaryLine` 完全同一份文本，
                    因此界面上复制的与日志里出现的**逐字节相同** */}
                <button
                  type="button"
                  onClick={() => {
                    void (async () => {
                      const ok = await copyTextToClipboard(
                        renderLayoutSummaryLine(ocrSummary.layoutSummary),
                      );
                      setCopyState(ok ? 'done' : 'failed');
                    })();
                  }}
                  className="mt-2 rounded-lg border border-amber-500/50 px-2.5 py-1 text-xs font-medium transition-colors hover:bg-amber-500/15"
                >
                  复制版面汇总（单行 JSON）
                </button>
              </>
            )}
          </div>
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
      : // 警示框的文字用**高对比中性色**，不要用琥珀色系列。
        // 用户实测反馈：`text-amber-800 / dark:text-amber-200` 与本站
        // 暖色调（米色/浅琥珀）背景过近，**读不清**；深色模式下
        // `text-amber-200` 更是亮黄，与背景几乎融在一起。
        // 底色保留琥珀色以维持「这是提醒」的语义，文字则用近黑/近白。
        'border-amber-400/60 bg-amber-500/10 text-neutral-900 dark:text-neutral-100';

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
