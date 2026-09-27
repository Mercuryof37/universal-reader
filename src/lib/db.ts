import Dexie, { type Table } from 'dexie';
import type { Annotation, DocDocument, ReadingProgress } from '@/types/content';

/**
 * 本地数据库。
 *
 * 为什么用 IndexedDB 而不是 localStorage：
 * localStorage 只能存字符串且上限约 5MB，一篇带译文的书轻松超过；
 * IndexedDB 可以存结构化对象、容量按磁盘配额算（通常几百 MB 起），且读写不阻塞主线程。
 *
 * 为什么用 Dexie 而不是原生 IndexedDB：
 * 原生 API 是回调+事务+游标的事件式写法，一个简单查询要几十行；
 * Dexie 把它包装成接近数组操作的形式，并且把版本升级写成声明式 schema。
 */

/** 文档表：只存元信息，正文分表存，避免列表页把几百 MB 正文读进内存 */
export interface DocumentRow {
  id: string;
  title: string;
  format: DocDocument['format'];
  metadata: DocDocument['metadata'];
  /** 中文/英文混排时用于列表搜索的小写检索串 */
  searchText: string;
  blockCount: number;
}

/** 正文表：一篇文档一行，便于整篇原子写入 */
export interface BlockRow {
  docId: string;
  blocks: DocDocument['blocks'];
  toc: DocDocument['toc'];
}

/** 译文缓存表：键为 `${hash(原文)}:${targetLang}`，跨文档复用（同一句话不必重复调用付费 API） */
export interface TranslationRow {
  id: string;
  targetLang: string;
  text: string;
  engine: string;
  createdAt: string;
}

class ReaderDatabase extends Dexie {
  documents!: Table<DocumentRow, string>;
  blocks!: Table<BlockRow, string>;
  annotations!: Table<Annotation, string>;
  progress!: Table<ReadingProgress, string>;
  translations!: Table<TranslationRow, string>;

  constructor() {
    super('universal-reader');

    // 表结构变更时新增 this.version(n).stores({...}) 即可，
    // Dexie 会自动做增量迁移，不要直接改动已发布版本的 schema。
    this.version(1).stores({
      documents: 'id, title, format, metadata.created, metadata.modified',
      blocks: 'docId',
      annotations: 'id, docId, blockId, type, createdAt',
      progress: 'docId, updatedAt',
      translations: 'id, targetLang, createdAt',
    });
  }
}

export const db = new ReaderDatabase();

/** 生成译文缓存键：把原文与目标语言一起哈希，避免超长键 */
export function translationKey(text: string, targetLang: string): string {
  return `${hashString(text)}:${targetLang}`;
}

/**
 * 32 位 FNV-1a 哈希。
 * 这里只用于生成缓存键，不需要抗碰撞的密码学强度，
 * 但同一原文必须稳定得到同一结果，所以不用随机数也不用 Date。
 */
export function hashString(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export async function saveDocument(doc: DocDocument): Promise<void> {
  const row: DocumentRow = {
    id: doc.id,
    title: doc.title,
    format: doc.format,
    metadata: doc.metadata,
    searchText: `${doc.title} ${doc.metadata.sourceFile} ${doc.metadata.author ?? ''}`.toLowerCase(),
    blockCount: doc.blocks.length,
  };

  // 一个事务里同时写两张表：避免只写入元信息而正文缺失的半成品状态
  await db.transaction('rw', db.documents, db.blocks, async () => {
    await db.documents.put(row);
    await db.blocks.put({ docId: doc.id, blocks: doc.blocks, toc: doc.toc });
  });
}

export async function loadDocument(docId: string): Promise<DocDocument | null> {
  const [row, body] = await Promise.all([db.documents.get(docId), db.blocks.get(docId)]);
  if (!row || !body) return null;

  return {
    id: row.id,
    title: row.title,
    format: row.format,
    metadata: row.metadata,
    blocks: body.blocks,
    toc: body.toc,
  };
}

export async function listDocuments(): Promise<DocumentRow[]> {
  const rows = await db.documents.toArray();
  return rows.sort((a, b) => b.metadata.created.localeCompare(a.metadata.created));
}

export async function deleteDocument(docId: string): Promise<void> {
  await db.transaction('rw', db.documents, db.blocks, db.annotations, db.progress, async () => {
    await db.documents.delete(docId);
    await db.blocks.delete(docId);
    await db.annotations.where('docId').equals(docId).delete();
    await db.progress.delete(docId);
  });
}

export async function listAnnotations(docId: string): Promise<Annotation[]> {
  const rows = await db.annotations.where('docId').equals(docId).toArray();
  return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function listAllAnnotations(): Promise<Annotation[]> {
  return db.annotations.toArray();
}

export async function saveAnnotation(annotation: Annotation): Promise<void> {
  await db.annotations.put(annotation);
}

export async function deleteAnnotation(id: string): Promise<void> {
  await db.annotations.delete(id);
}

export async function saveProgress(progress: ReadingProgress): Promise<void> {
  await db.progress.put(progress);
}

export async function loadProgress(docId: string): Promise<ReadingProgress | null> {
  return (await db.progress.get(docId)) ?? null;
}

export async function getCachedTranslation(
  text: string,
  targetLang: string,
): Promise<TranslationRow | null> {
  return (await db.translations.get(translationKey(text, targetLang))) ?? null;
}

export async function putCachedTranslation(
  text: string,
  targetLang: string,
  translated: string,
  engine: string,
): Promise<void> {
  await db.translations.put({
    id: translationKey(text, targetLang),
    targetLang,
    text: translated,
    engine,
    createdAt: new Date().toISOString(),
  });
}

export async function clearTranslationCache(): Promise<void> {
  await db.translations.clear();
}

/** 估算已用存储空间，用于设置页提示用户（浏览器会给出 origin 级别配额） */
export async function estimateStorage(): Promise<{ usage: number; quota: number } | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null;
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  return { usage, quota };
}

/** 已安装但尚未真正使用的表，声明在此避免 Dexie 报未使用告警 */
export const tableNames = db.tables.map((t) => t.name);
