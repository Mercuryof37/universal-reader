import { create } from 'zustand';
import type { Annotation, AnnotationType, ContentBlock, HighlightColor } from '@/types/content';
import {
  deleteAnnotation as dbDeleteAnnotation,
  listAnnotations,
  saveAnnotation,
} from '@/lib/db';
import { makeAnchor, uid } from '@/lib/utils';
import { makeAnnotationAnchor, migrateAnnotations } from '@/lib/annotationAnchor';

/**
 * 打开文档时对旧批注做的一次性迁移结果。
 *
 * 为什么要把它放进 store 而不是丢掉：迁移是**用户数据的改动**，
 * 用户有权知道"我的批注被升级了 N 条、还有 M 条定不了位"。
 * 静默迁移与静默丢弃在这件事上一样糟。
 */
export interface AnchorMigrationReport {
  docId: string;
  /** 成功升级到"块内字符偏移"的条数 */
  migrated: number;
  /** 有的是旧格式但没能升级（**不会被删除**，继续走文本匹配） */
  failed: number;
  /** 迁移过程中写库失败的条数（内存里已生效，下次打开会重试） */
  persistFailed: number;
  at: string;
}

interface AnnotationsState {
  docId: string | null;
  annotations: Annotation[];
  activeAnnotationId: string | null;
  loading: boolean;
  migration: AnchorMigrationReport | null;

  /**
   * 载入某文档的批注。
   *
   * `blocks` 可选：给了就对旧格式批注做一次迁移（只新增 `locator` 字段）。
   * ⚠️ 不给 `blocks` 时**绝不猜** —— 没有当前文档的内容就没法验证位置，
   * 迁移会被跳过而不是用错的位置糊上去。
   */
  load: (docId: string, blocks?: readonly ContentBlock[]) => Promise<void>;
  clear: () => void;
  add: (input: {
    blockId: string;
    blockContent: string;
    /** 0-based 块下标；给了才会写定位符 */
    blockIndex?: number;
    /** 1-based 页码（PDF 才有）；不传就**不写** `page:` 段，而不是写个假的 1 */
    pageIdx?: number;
    type: AnnotationType;
    color: HighlightColor;
    content?: string;
    tags?: string[];
    selection?: { start: number; end: number; text: string };
  }) => Promise<Annotation>;
  update: (id: string, patch: Partial<Pick<Annotation, 'content' | 'color' | 'tags' | 'type'>>) => Promise<void>;
  remove: (id: string) => Promise<void>;
  setActive: (id: string | null) => void;
  /** 导出为 JSON 或 Markdown 文本 */
  exportAs: (format: 'json' | 'markdown', docTitle: string, blockText: Map<string, string>) => string;
}

export const useAnnotationsStore = create<AnnotationsState>((set, get) => ({
  docId: null,
  annotations: [],
  activeAnnotationId: null,
  loading: false,
  migration: null,

  load: async (docId, blocks) => {
    set({ loading: true, docId });
    try {
      const stored = await listAnnotations(docId);
      if (!blocks || !blocks.length) {
        set({ annotations: stored, migration: null });
        return;
      }

      const { annotations, migrated, failed } = migrateAnnotations(stored, { id: docId, blocks });

      // 先落内存：即使写库失败，本次会话里批注也已经是升级后的状态
      set({
        annotations,
        migration: {
          docId,
          migrated,
          failed: failed.length,
          persistFailed: 0,
          at: new Date().toISOString(),
        },
      });

      // 只写真正变过的那些 —— 全量 put 会让"打开文档"变成一次无谓的批量写盘
      let persistFailed = 0;
      for (let i = 0; i < annotations.length; i++) {
        if (annotations[i] === stored[i]) continue; // 同一个引用 = 没动过
        try {
          await saveAnnotation(annotations[i]!);
        } catch {
          persistFailed += 1;
        }
      }
      if (persistFailed) {
        set({ migration: { ...get().migration!, persistFailed } });
      }
    } finally {
      set({ loading: false });
    }
  },

  clear: () => set({ docId: null, annotations: [], activeAnnotationId: null, migration: null }),

  add: async (input) => {
    const { docId } = get();
    if (!docId) throw new Error('尚未打开任何文档，无法添加批注。');

    const now = new Date().toISOString();
    const anchor = input.selection
      ? makeAnchor(input.blockContent, input.selection.start, input.selection.end)
      : undefined;

    /*
      定位符必须走 `makeAnnotationAnchor` 这一个构造入口。

      ⚠️ 曾经在这里直接拼字符串，结果是"格式"有两份实现：
      删掉 `makeAnnotationAnchor` 里的字段，端到端用例照样全绿 ——
      典型的假保护。唯一入口是有测试保证的（见 annotationAnchor.test.ts
      的"add() 写的定位符与构造器逐字节相同"）。

      块序号用 `input.blockIndex`：定位符里的 `block` 段是**文档级**下标，
      而这个合成数组只有目标块自己 —— 下标必须显式对上，否则每条批注都会
      写成 `block:0`（实测抓到的错误：第二块的批注被写成 block:0）。
    */
    const blockIdx = input.blockIndex;
    const locator =
      blockIdx === undefined || !input.selection
        ? undefined
        : makeAnnotationAnchor({
            docId,
            blocks: [
              {
                id: input.blockId,
                type: 'paragraph',
                content: input.blockContent,
                translations: {},
                metadata: {},
              },
            ],
            blockIdx: 0,
            start: input.selection.start,
            end: input.selection.end,
            pageIdx: input.pageIdx,
            // 合成数组里目标块在 0 位，但写进定位符的必须是**文档级**下标
            locatorBlockIdx: blockIdx,
          });

    const annotation: Annotation = {
      id: uid('ann'),
      docId,
      blockId: input.blockId,
      type: input.type,
      color: input.color,
      content: input.content,
      tags: input.tags ?? [],
      anchor,
      ...(locator ? { locator } : {}),
      createdAt: now,
      updatedAt: now,
    };

    await saveAnnotation(annotation);
    // 新批注放在前面，用户加完就能在侧栏看到
    set({ annotations: [annotation, ...get().annotations], activeAnnotationId: annotation.id });
    return annotation;
  },

  update: async (id, patch) => {
    const target = get().annotations.find((a) => a.id === id);
    if (!target) return;

    const next: Annotation = { ...target, ...patch, updatedAt: new Date().toISOString() };
    await saveAnnotation(next);
    set({ annotations: get().annotations.map((a) => (a.id === id ? next : a)) });
  },

  remove: async (id) => {
    await dbDeleteAnnotation(id);
    set({
      annotations: get().annotations.filter((a) => a.id !== id),
      activeAnnotationId: get().activeAnnotationId === id ? null : get().activeAnnotationId,
    });
  },

  setActive: (activeAnnotationId) => set({ activeAnnotationId }),

  exportAs: (format, docTitle, blockText) => {
    const list = [...get().annotations].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    if (format === 'json') {
      return JSON.stringify(
        {
          document: docTitle,
          exportedAt: new Date().toISOString(),
          count: list.length,
          annotations: list.map((a) => ({
            ...a,
            // 一并导出被批注的原文，脱离本文档后仍可读
            quotedText: a.anchor?.selectedText ?? blockText.get(a.blockId)?.slice(0, 200) ?? '',
          })),
        },
        null,
        2,
      );
    }

    const lines: string[] = [`# ${docTitle} · 阅读批注`, ''];
    for (const a of list) {
      const quote = a.anchor?.selectedText?.trim();
      lines.push(`## ${a.tags[0] ?? TYPE_LABEL[a.type]} · ${a.createdAt.slice(0, 10)}`);
      if (quote) lines.push(`> ${quote.replace(/\n/g, ' ')}`);
      if (a.content) lines.push('', a.content);
      if (a.tags.length) lines.push('', `标签：${a.tags.map((t) => `\`${t}\``).join(' ')}`);
      lines.push('');
    }
    return lines.join('\n');
  },
}));

export const TYPE_LABEL: Record<AnnotationType, string> = {
  highlight: '高亮',
  note: '笔记',
  tag: '标签',
  question: '疑问',
};
