import { create } from 'zustand';
import type { Annotation, AnnotationType, HighlightColor } from '@/types/content';
import {
  deleteAnnotation as dbDeleteAnnotation,
  listAnnotations,
  saveAnnotation,
} from '@/lib/db';
import { makeAnchor, uid } from '@/lib/utils';

interface AnnotationsState {
  docId: string | null;
  annotations: Annotation[];
  activeAnnotationId: string | null;
  loading: boolean;

  load: (docId: string) => Promise<void>;
  clear: () => void;
  add: (input: {
    blockId: string;
    blockContent: string;
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

  load: async (docId) => {
    set({ loading: true, docId });
    try {
      set({ annotations: await listAnnotations(docId) });
    } finally {
      set({ loading: false });
    }
  },

  clear: () => set({ docId: null, annotations: [], activeAnnotationId: null }),

  add: async (input) => {
    const { docId } = get();
    if (!docId) throw new Error('尚未打开任何文档，无法添加批注。');

    const now = new Date().toISOString();
    const annotation: Annotation = {
      id: uid('ann'),
      docId,
      blockId: input.blockId,
      type: input.type,
      color: input.color,
      content: input.content,
      tags: input.tags ?? [],
      anchor: input.selection
        ? makeAnchor(input.blockContent, input.selection.start, input.selection.end)
        : undefined,
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
