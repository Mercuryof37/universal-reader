import { create } from 'zustand';
import type { DocDocument } from '@/types/content';
import { deleteDocument, listDocuments, loadDocument, saveDocument, type DocumentRow } from '@/lib/db';
import { parseFiles, isScannedPdfError } from '@/parsers';
import { errorReport, describeUnknownError } from '@/lib/diagnostics';
import { resolvePageLimit, type OcrLang, type OcrProgress } from '@/lib/ocrTypes';
import { bootModelTierAssets } from '@/lib/modelTierBoot';
import type { LayoutDocumentSummary } from '@/lib/ocrPostProcess';
import {
  clearOcrAttempt,
  clearOcrStage,
  clearPersistentOcrCrash,
  noteOcrProgress,
  noteOcrStage,
} from '@/lib/sessionDiagnostics';

/**
 * 文档库 store。
 *
 * 刻意不复用 settingsStore 的 persist：文档正文太大，
 * localStorage 存不下也不该存；这里的状态只是 IndexedDB 的内存镜像，
 * 刷新页面时通过 init() 重新从数据库读回，保证只有一份事实来源。
 */
interface LibraryState {
  documents: DocumentRow[];
  currentDocId: string | null;
  currentDoc: DocDocument | null;
  loading: boolean;
  importing: boolean;
  importProgress: { done: number; total: number; currentName: string } | null;
  error: string | null;
  lastImportErrors: { fileName: string; message: string }[];

  /** 扫描版 PDF 等待用户确认 OCR */
  scannedPdfPending: {
    buffer: ArrayBuffer;
    fileName: string;
    fileSize: number;
    pageCount: number;
    metaTitle: string;
    metaAuthor: string;
  } | null;
  ocrProgress: OcrProgress | null;
  /**
   * 上次 OCR 的结果摘要：成功的页数与被跳过的页数。
   *
   * `layoutSummary` 是 T2 的**文档级版面汇总**（见 `LayoutDocumentSummary`）：
   * 逐页的 `layout-metrics` 只能回答「这一页」，而「这本书里版面模型一共
   * 改了多少」此前没有任何读点。它**不参与任何判定**，只用于在界面上
   * 如实告诉用户「版面模型到底有没有在工作、改动了多少」。
   *
   * ⚠️ `layoutSummary.pagesWithLayout === 0` 是「一次都没接入」，
   * 不是「接入了但没改动」—— 不能拿 `pages` 当判据（模型缺席时
   * 回调照样会进、`pages` 照样很大）。两种情况的下一步动作相反，
   * 界面上必须分开说。
   */
  ocrSummary: {
    pagesProcessed: number;
    pagesSkipped: number;
    failures: number[];
    layoutSummary: LayoutDocumentSummary;
  } | null;
  /**
   * 上一页的**原始识别结构**（词框、字号、成行结果、最终块），已序列化成
   * JSON 字符串，供「复制识别结构」按钮使用。
   *
   * ═══════════════════════════════════════════════════════════════
   * 三处刻意的取舍
   * ═══════════════════════════════════════════════════════════════
   *
   * 1. **只留一页**。词级数据很大（一页上千个词），而这一页已经足够回答
   *    「真实文档里的指数到底长什么样」—— 那正是它存在的唯一理由。
   *    每次识别都覆盖它，不会随页数累积。
   *
   * 2. **不写 IndexedDB**。文档库只管正文与批注；把诊断用的词级数据
   *    塞进长期存储，会让每一次识别都多写几 MB，还得为此设计淘汰策略。
   *    存成 store 里的字符串，刷新页面自然消失，代价最小。
   *
   * 3. **在解析层就序列化**（`pdfParser` 里做），而不是把对象留在内存里
   *    等到点按钮时才 `stringify`。后者意味着整份词表对象常驻内存，
   *    而且会随 GC 压力反复被扫；字符串是只读的，内存占用与它的大小
   *    一样可预测 —— 本项目已经因为内存峰值吃过多次亏。
   *
   * 单页体积上限见 `lib/ocrStructure.ts` 的 `OCR_STRUCTURE_CHAR_BUDGET`。
   */
  ocrStructure: { pageNum: number; json: string; linesTotal: number; wordsTotal: number } | null;

  init: () => Promise<void>;
  importFiles: (files: File[]) => Promise<void>;
  openDocument: (docId: string) => Promise<void>;
  closeDocument: () => void;
  removeDocument: (docId: string) => Promise<void>;
  patchCurrentDoc: (patch: Partial<DocDocument>) => void;
  clearError: () => void;

  /**
   * 启动 OCR。
   * @param lang     OCR 语言
   * @param maxPages 最多处理多少页（从第 1 页起）。用于先小范围试跑 ——
   *                 833 页的扫描书整本 OCR 可能要一小时，先验 20 页更稳妥。
   */
  startOcr: (lang: OcrLang, maxPages?: number) => Promise<void>;
  cancelOcr: () => void;
}

export const useLibraryStore = create<LibraryState>((set, get) => ({
  documents: [],
  currentDocId: null,
  currentDoc: null,
  loading: false,
  importing: false,
  importProgress: null,
  error: null,
  lastImportErrors: [],
  scannedPdfPending: null,
  ocrProgress: null,
  ocrSummary: null,
  ocrStructure: null,

  init: async () => {
    set({ loading: true });
    try {
      set({ documents: await listDocuments() });
    } catch (err) {
      set({ error: `读取本地文档库失败：${describeUnknownError(err)}` });
    } finally {
      set({ loading: false });
    }
  },

  importFiles: async (files) => {
    if (!files.length) return;
    set({ importing: true, error: null, lastImportErrors: [], scannedPdfPending: null });

    try {
      const { documents, errors } = await parseFiles(files, (done, total, currentName) => {
        set({ importProgress: { done, total, currentName } });
      });

      for (const doc of documents) {
        await saveDocument(doc);
      }

      // 检查是否有扫描版 PDF 错误
      const scannedError = errors.find((e) => e.message.includes('扫描版'));
      if (scannedError && !documents.length) {
        // 尝试从原始文件中恢复 buffer（parseFiles 已经消费了 File）
        // 由于 parseFile 内部已读取 arrayBuffer，我们需要重新解析来捕获 ScannedPdfError
        // 实际上 ScannedPdfError 已经在 parseFile 中被抛出并转为字符串
        // 这里我们标记需要重新处理
      }

      set({
        documents: await listDocuments(),
        lastImportErrors: errors,
        ...(documents.length === 1 && documents[0]
          ? { currentDocId: documents[0].id, currentDoc: documents[0] }
          : {}),
        ...(errors.length && !documents.length
          ? { error: `全部导入失败：${errors.map((e) => `${e.fileName}（${e.message}）`).join('；')}` }
          : {}),
      });
    } catch (err) {
      // 用类型守卫而不是 instanceof：pdfParser 是动态 import 的，
      // 跨模块实例判断用标记属性更可靠（见 parsers/scannedPdfError.ts）。
      if (isScannedPdfError(err)) {
        set({
          scannedPdfPending: {
            buffer: err.pdfBuffer,
            fileName: err.fileName,
            fileSize: err.fileSize,
            pageCount: err.pageCount,
            metaTitle: err.metaTitle,
            metaAuthor: err.metaAuthor,
          },
          importing: false,
          importProgress: null,
        });
        return;
      }
      set({ error: `导入失败：${describeUnknownError(err)}` });
    } finally {
      set({ importing: false, importProgress: null });
    }
  },

  openDocument: async (docId) => {
    set({ loading: true, error: null });
    try {
      const doc = await loadDocument(docId);
      if (!doc) {
        set({ error: '文档不存在或已被删除。' });
        return;
      }
      set({ currentDocId: docId, currentDoc: doc });
    } catch (err) {
      set({ error: `打开文档失败：${describeUnknownError(err)}` });
    } finally {
      set({ loading: false });
    }
  },

  closeDocument: () => set({ currentDocId: null, currentDoc: null }),

  removeDocument: async (docId) => {
    await deleteDocument(docId);
    const isCurrent = get().currentDocId === docId;
    set({
      documents: await listDocuments(),
      ...(isCurrent ? { currentDocId: null, currentDoc: null } : {}),
    });
  },

  patchCurrentDoc: (patch) => {
    const doc = get().currentDoc;
    if (!doc) return;
    set({ currentDoc: { ...doc, ...patch } });
  },

  clearError: () => set({ error: null }),

  startOcr: async (lang, maxPages) => {
    const pending = get().scannedPdfPending;
    if (!pending) return;

    /**
     * ═══════════════════════════════════════════════════════════════
     * 「首次 OCR 意图」的判据 —— **就是这一行**（改动前它在 `pwa.ts` 的
     * `onRegisteredSW` 里，SW 一注册就跑，首访固定 34.59 MiB）
     * ═══════════════════════════════════════════════════════════════
     *
     * 为什么是这里，而不是更早或更晚：
     *
     * · **不是「导入了一份 PDF」**：`scannedPdfPending` 只是「这份 PDF 没文字层，
     *   要不要识别？」的**提问**。用户可能点「取消」，也可能先导入别的文件 ——
     *   那一步之后 OCR 未必发生，此时下载就等于把 34.59 MiB 押在一个问号上。
     * · **不是「打开了一个 PDF」**：文字层 PDF 走的是 `pdfParser` 的常规路径，
     *   一个模型字节都不需要。拿文件类型当判据会把「读文献」误判成「要 OCR」。
     * · **是「用户按下开始识别」**：这是全应用**唯一**一处「OCR 一定会发生」的
     *   承诺 —— `FileUploadZone` 的「开始识别」按钮 `void startOcr(...)`
     *   （`src/components/FileUploadZone.tsx`）就是它的全部调用方，而本函数
     *   一进来就已经确认 `scannedPdfPending` 非空、`lang` / `maxPages` 已选定。
     *   再往后一步（`import('@/parsers/pdfParser')` → `ocrParsePdf` →
     *   `ocrEngine.initialize()` → `PaddleOcrService.initialize()`）**太晚**：
     *   那时引擎已经在取同样三个文件，预取就只是在抢带宽，而不是「先就位」。
     *
     * ⚠️ 刻意**不 await**（`void`），两个理由都不是风格问题：
     *   ① 本行在 `set({ ocrProgress: { status: 'initializing' } })` 与
     *      `import('@/parsers/pdfParser')` **之前**，所以预取能与引擎初始化的
     *      准备工作真正重叠；但 34.59 MiB 在弱网上是几十秒，await 它等于让界面
     *      卡在「开始识别」上，连「正在加载 OCR 引擎…」都出不来；
     *   ② 引擎自己的 `initialize()` 紧跟其后（下一行就动态 import 解析器），
     *      两者并发正合用；预取先跑完就命中缓存，跑不完也不比改动前更差。
     *   `bootModelTierAssets()` **永不 reject**（`modelTierBoot.ts` 里所有失败
     *   都已经变成一条 `ModelTierBootReport`），所以这里不会留下未处理的 rejection。
     *
     * ⚠️ 刻意**不传档位**：档位由 `detectLayoutCapability()` 推出来
     * （`VITE_OCR_LAYOUT` 关掉时才走 fast 档），在调用点写死会让
     * 「缓存身份 = 当前档位」这句话变成假的。`modelTierBoot.test.ts`
     * 把「调用点不许写死档位」这条钉着（两个调用点各钉一次）。
     *
     * ⚠️ 这次调用**只在这里**发生：在此之前没有任何其他调用点，
     * 所以「`getModelTierBootRecord()` 返回 `null`」继续严格等价于
     * 「模型资产就位一次都没跑过」—— 而它现在的含义是
     * 「用户还没有表达过 OCR 意图」，而不是「页面还没加载完」。
     * 四条可观测通道（进程内订阅 / sessionStorage / 可复制报告 /
     * 文档库横幅）一个都没动。
     *
     * 幂等性不靠本文件里的标志位：第二次点「开始识别」时四个资产已在缓存里，
     * `ensureModelTierAssets` 会 **`cache.match` 命中 ⇒ 一个字节都不取**
     * （`preflightModelTier` 的 `items` 为空）。加一个「只跑一次」的模块级
     * 标志只会引入一个新的失败态：第一次因离线被 `skipped` 之后，
     * 联网重试会被自己的标志挡住，而用户看不出为什么模型一直下不下来。
     */
    void bootModelTierAssets();

    const total = resolvePageLimit(pending.pageCount, maxPages);
    set({
      importing: true,
      error: null,
      ocrSummary: null,
      // 新一次识别从零开始：旧的结构属于上一本书，留着只会误导
      ocrStructure: null,
      ocrProgress: { pageNum: 0, total, status: 'initializing' },
    });

    try {
      // 动态导入避免 pdfParser 被静态引入导致 chunk 合并
      noteOcrStage('engine-init', '开始初始化 OCR 引擎（首次需下载约 30MB 模型）');
      const { ocrParsePdf } = await import('@/parsers/pdfParser');
      const result = await ocrParsePdf(
        pending.buffer,
        pending.fileName,
        pending.fileSize,
        {
          lang,
          maxPages,
          onProgress: (p: OcrProgress) => {
            set({ ocrProgress: p });
            // 记进 sessionStorage：万一页面被系统回收/重载，重载后能告诉用户
            // 「上次识别到第几页断了」—— 用户打不开控制台时这是唯一的线索
            if (p.status === 'recognizing') noteOcrProgress(p.pageNum, p.total);
          },
          /**
           * 中途落盘。
           *
           * 没有它，整次 OCR 的结果只活在内存里，直到最后一页跑完才写库 ——
           * 一本几百页的书要跑十几分钟，这期间任何中断（尤其是本应用
           * `autoUpdate` 的 Service Worker 会在新版本部署后**自动重载页面**）
           * 都会让整次扫描无声无息地消失：没有报错、没有摘要、书库里也没有条目。
           *
           * 只刷新书库列表，**不**设置 currentDocId ——
           * 扫描还在进行，界面应停在进度视图，不该突然跳到阅读器。
           */
          onCheckpoint: async (snapshot) => {
            await saveDocument(snapshot);
            set({ documents: await listDocuments() });
          },
          /**
           * 导出识别结构：**只保留第一页**。
           *
           * 为什么是第一页而不是最后一页：用户报的故障（题目挤成一段、
           * 指数没生效）就在开头的题目页上，第一页最可能被看到；
           * 而且早期页面的识别条件（模型冷启动之后的第一页）也更接近
           * 他实际遇到的情况。后面的页面覆盖它没有意义 ——
           * 同一份 PDF 的版式是一致的，一页足够定量。
           *
           * 已在别处序列化成字符串（见 `ocrStructure` 字段的说明），
           * 这里不再持有词级对象。
           */
          onPageStructure: (structure) => {
            if (get().ocrStructure) return;
            set({
              ocrStructure: {
                pageNum: structure.pageNum,
                json: JSON.stringify(structure, null, 2),
                linesTotal: structure.linesTotal,
                wordsTotal: structure.wordsTotal,
              },
            });
          },
        },
        pending.metaTitle,
        pending.metaAuthor,
      );

      await saveDocument(result.document);
      // 走到这里说明整次识别正常收尾：清掉中断记录，免得下次打开误报。
      // 注意**不要**再写一个 'saved' 阶段 —— 那会让下次打开时看到一条
      // 早已成功的旧阶段，反而误导。
      clearOcrAttempt();
      clearOcrStage();
      // 识别成功说明这个浏览器其实跑得通：清掉持久崩溃记录，不再提示换浏览器
      clearPersistentOcrCrash();
      set({
        documents: await listDocuments(),
        currentDocId: result.document.id,
        currentDoc: result.document,
        scannedPdfPending: null,
        ocrProgress: null,
        ocrSummary: {
          pagesProcessed: result.pagesProcessed,
          pagesSkipped: result.pagesSkipped,
          failures: result.failures.map((f) => f.pageNum),
          layoutSummary: result.layoutSummary,
        },
      });
    } catch (err) {
      // 关键：不要写成 `(err as Error).message`。
      // JavaScript 允许 throw 任何值（字符串、Symbol、普通对象、undefined），
      // 第三方库（尤其涉及 Worker 与 WASM 的）经常不抛 Error。
      // 曾经这里显示给用户的是 "OCR 识别失败：undefined"，信息量为零。
      // 用 errorReport 保证任何抛出值都能变成可读、可复制上报的文本。
      console.error('[startOcr] 原始错误对象：', err);

      /**
       * 清掉中断记录 —— 因为**这次失败已经如实报给用户了**。
       *
       * 不这么做会污染「浏览器崩溃」的持久记录：那条记录是靠
       * 「启动时发现上次识别没走完、且不是应用刷新的」来判定的，
       * 而普通报错同样会留下没走完的痕迹。若不清掉，
       * 用户下次重新加载页面时就会被误记成「浏览器崩过一次」，
       * 累计两次就会把「开始识别」按钮禁掉 —— 明明只是识别失败而已。
       *
       * 真正被浏览器杀掉的进程没有机会执行到这里，
       * 那条记录才会留到下次启动被记成崩溃。这正是两者的分界。
       */
      clearOcrAttempt();
      clearOcrStage();

      set({
        error: `OCR 识别失败。\n\n${errorReport('（以下是诊断信息，可复制反馈）', err)}`,
        ocrProgress: null,
      });
    } finally {
      set({ importing: false });
    }
  },

  cancelOcr: () => set({ scannedPdfPending: null, ocrProgress: null, ocrSummary: null, ocrStructure: null }),
}));
