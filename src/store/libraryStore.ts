import { create } from 'zustand';
import type { DocDocument } from '@/types/content';
import { deleteDocument, listDocuments, loadDocument, saveDocument, type DocumentRow } from '@/lib/db';
import { parseFiles, isScannedPdfError } from '@/parsers';
import { errorReport, describeUnknownError } from '@/lib/diagnostics';
import { resolvePageLimit, type OcrLang, type OcrProgress } from '@/lib/ocrTypes';
import { clearOcrAttempt, noteOcrProgress } from '@/lib/sessionDiagnostics';

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
  /** 上次 OCR 的结果摘要：成功的页数与被跳过的页数 */
  ocrSummary: { pagesProcessed: number; pagesSkipped: number; failures: number[] } | null;

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

    const total = resolvePageLimit(pending.pageCount, maxPages);
    set({
      importing: true,
      error: null,
      ocrSummary: null,
      ocrProgress: { pageNum: 0, total, status: 'initializing' },
    });

    try {
      // 动态导入避免 pdfParser 被静态引入导致 chunk 合并
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
        },
        pending.metaTitle,
        pending.metaAuthor,
      );

      await saveDocument(result.document);
      // 走到这里说明整次识别正常收尾：清掉中断记录，免得下次打开误报
      clearOcrAttempt();
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
        },
      });
    } catch (err) {
      // 关键：不要写成 `(err as Error).message`。
      // JavaScript 允许 throw 任何值（字符串、Symbol、普通对象、undefined），
      // 第三方库（尤其涉及 Worker 与 WASM 的）经常不抛 Error。
      // 曾经这里显示给用户的是 "OCR 识别失败：undefined"，信息量为零。
      // 用 errorReport 保证任何抛出值都能变成可读、可复制上报的文本。
      console.error('[startOcr] 原始错误对象：', err);
      set({
        error: `OCR 识别失败。\n\n${errorReport('（以下是诊断信息，可复制反馈）', err)}`,
        ocrProgress: null,
      });
    } finally {
      set({ importing: false });
    }
  },

  cancelOcr: () => set({ scannedPdfPending: null, ocrProgress: null, ocrSummary: null }),
}));
