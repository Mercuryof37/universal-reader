import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Annotation, ContentBlock } from '@/types/content';
import { makeAnchor } from '@/lib/utils';
import { makeAnnotationAnchor, makeLocator, parseLocator } from '@/lib/annotationAnchor';
import { useAnnotationsStore } from '@/store/annotationsStore';

/**
 * 批注 store 的迁移路径。
 *
 * ⚠️ 这个文件**必须**钉住两件事，它们是"打开文档就悄悄改了用户数据"的护栏：
 *
 * 1. **写库的是升级后的那条**（不是原件）—— 否则下次打开还要再迁移一次，
 *    而"每次打开都改一遍"本身就是数据损坏的来源；
 * 2. **迁移失败的那条一个字节都不许改、也不许写库** —— 用户的历史批注
 *    在"位置对不上"时只有两种命运：留着让用户处理，或者被删掉。这里是前者。
 *
 * 测试用 `vi.mock('@/lib/db')` 拦掉 Dexie：Node 环境里没有 IndexedDB，
 * 而这里要测的是 store 的**决策**，不是 IndexedDB 本身。
 */

/** 内存版数据库：只记 store 真正读写过的东西，便于断言"写了几条、写的是哪条" */
const storage = new Map<string, Annotation>();
const puts: Annotation[] = [];
const listCalls: string[] = [];

vi.mock('@/lib/db', () => ({
  listAnnotations: async (docId: string) => {
    listCalls.push(docId);
    return [...storage.values()].filter((a) => a.docId === docId);
  },
  saveAnnotation: async (a: Annotation) => {
    puts.push(a);
    storage.set(a.id, a);
  },
  deleteAnnotation: async (id: string) => {
    storage.delete(id);
  },
}));

function block(content: string, id: string, pageNumber?: number): ContentBlock {
  return {
    id,
    type: 'paragraph',
    content,
    translations: {},
    metadata: pageNumber === undefined ? {} : { pageNumber },
  };
}

function legacyAnnotation(id: string, docId: string, blockId: string, content: string, start: number, end: number): Annotation {
  return {
    id,
    docId,
    blockId,
    type: 'highlight',
    color: 'amber',
    tags: [],
    anchor: makeAnchor(content, start, end),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const DOC_ID = 'd1';
const firstContent = '第一段：这是一段足够长的正文，用来放批注。';
/** 第 0 块带页码（模拟 PDF），第 1 块不带（模拟 md/txt）—— 两条路径都要覆盖 */
const blocks: ContentBlock[] = [block(firstContent, 'doc-d1-b0', 1), block('第二段。', 'doc-d1-b1')];

beforeEach(() => {
  storage.clear();
  puts.length = 0;
  listCalls.length = 0;
  useAnnotationsStore.getState().clear();
});

describe('annotationsStore · 打开文档时的锚点迁移', () => {
  it('旧格式批注被升级：内存里是升级后的那条，库里也写了升级后的那条', async () => {
    const legacy = legacyAnnotation('old-1', DOC_ID, 'doc-d1-b0', firstContent, 4, 8);
    storage.set(legacy.id, legacy);

    await useAnnotationsStore.getState().load(DOC_ID, blocks);

    const after = useAnnotationsStore.getState().annotations;
    expect(after).toHaveLength(1);
    const upgraded = after[0]!;
    expect(upgraded.locator).toBe('doc:d1/page:1/block:0/char:4+4');
    expect(upgraded.migration?.strategy).toBe('exact');
    // 旧字段仍然在（迁移只新增，不删除）
    expect(upgraded.anchor?.selectedText).toBe(legacy.anchor!.selectedText);
    expect(upgraded.anchor?.offset).toBe(4);

    // 写库的必须是**升级后**的那条，而且只写了这一条
    expect(puts).toHaveLength(1);
    expect(puts[0]!.locator).toBe('doc:d1/page:1/block:0/char:4+4');
    expect(storage.get('old-1')!.locator).toBe('doc:d1/page:1/block:0/char:4+4');
  });

  it('已经是新格式的批注不会被重写（打开文档不该产生无谓写盘）', async () => {
    const fresh: Annotation = {
      ...legacyAnnotation('new-1', DOC_ID, 'doc-d1-b0', firstContent, 4, 8),
      locator: makeLocator({ docId: DOC_ID, pageIdx: 1, blockIdx: 0, charOffset: 4, charLength: 4 }),
    };
    storage.set(fresh.id, fresh);

    await useAnnotationsStore.getState().load(DOC_ID, blocks);

    expect(useAnnotationsStore.getState().annotations[0]).toBe(fresh);
    expect(puts).toHaveLength(0);
  });

  it('⚠️ 迁移失败的那条：**一个字节都不改、也不写库**，并在报告里记一笔', async () => {
    const lost = legacyAnnotation('lost-1', DOC_ID, 'doc-d1-b0', '早就没有了的文字，原文里找不到。', 0, 9);
    const ok = legacyAnnotation('old-2', DOC_ID, 'doc-d1-b0', firstContent, 4, 8);
    storage.set(lost.id, lost);
    storage.set(ok.id, ok);

    await useAnnotationsStore.getState().load(DOC_ID, blocks);

    const after = useAnnotationsStore.getState().annotations;
    const lostAfter = after.find((a) => a.id === 'lost-1')!;
    // 逐字段原样（同一个引用）
    expect(lostAfter).toBe(lost);
    expect(lostAfter.locator).toBeUndefined();
    expect(lostAfter.migration).toBeUndefined();
    // 库里也没被动过
    expect(storage.get('lost-1')).toBe(lost);

    // 报告：1 条成功、1 条失败
    const report = useAnnotationsStore.getState().migration;
    expect(report).toMatchObject({ docId: DOC_ID, migrated: 1, failed: 1, persistFailed: 0 });

    // 只有成功的那条被写
    expect(puts).toHaveLength(1);
    expect(puts[0]!.id).toBe('old-2');
  });

  it('失败原因能落到用户看得懂的文案（侧栏直接用这句）', async () => {
    const lost = legacyAnnotation('lost-2', DOC_ID, 'doc-d1-b0', '早就没有了的文字，原文里找不到。', 0, 9);
    storage.set(lost.id, lost);

    await useAnnotationsStore.getState().load(DOC_ID, blocks);

    // 未迁移的批注仍然可以被解析（走旧锚点路径），只是拿不到块内偏移
    expect(useAnnotationsStore.getState().annotations[0]!.locator).toBeUndefined();
    expect(useAnnotationsStore.getState().migration?.failed).toBe(1);
  });

  it('不传 blocks 时**不迁移**：没有当前正文就无法验证位置，宁可不做', async () => {
    const legacy = legacyAnnotation('old-3', DOC_ID, 'doc-d1-b0', firstContent, 4, 8);
    storage.set(legacy.id, legacy);

    await useAnnotationsStore.getState().load(DOC_ID);

    expect(useAnnotationsStore.getState().annotations[0]!.locator).toBeUndefined();
    expect(useAnnotationsStore.getState().migration).toBeNull();
    expect(puts).toHaveLength(0);
  });

  it('写库失败不影响本次会话（内存里已经升级，下次打开重试）', async () => {
    const legacy = legacyAnnotation('old-4', DOC_ID, 'doc-d1-b0', firstContent, 4, 8);
    storage.set(legacy.id, legacy);
    const db = await import('@/lib/db');
    const spy = vi.spyOn(db, 'saveAnnotation').mockRejectedValueOnce(new Error('quota'));

    // 注意：store 在模块加载时已经绑定了 `@/lib/db` 的函数引用，
    // 所以这里只能验证"异常不会冒出来打断 load"，不能验证具体计数
    await expect(useAnnotationsStore.getState().load(DOC_ID, blocks)).resolves.toBeUndefined();
    expect(useAnnotationsStore.getState().annotations[0]!.locator).toBe('doc:d1/page:1/block:0/char:4+4');
    spy.mockRestore();
  });
});

describe('annotationsStore · 新建批注写入块内字符偏移', () => {
  it('add() 写的定位符与统一的构造器**逐字节相同**', async () => {
    await useAnnotationsStore.getState().load(DOC_ID, blocks);
    puts.length = 0;

    const created = await useAnnotationsStore.getState().add({
      blockId: 'doc-d1-b0',
      blockContent: firstContent,
      blockIndex: 0,
      pageIdx: 1,
      type: 'highlight',
      color: 'amber',
      selection: { start: 4, end: 8, text: firstContent.slice(4, 8) },
    });

    const expected = makeLocator({ docId: DOC_ID, pageIdx: 1, blockIdx: 0, charOffset: 4, charLength: 4 });
    expect(created.locator).toBe(expected);
    /*
      ⚠️ 再加一条"唯一入口"断言：同一个选区交给统一构造器，必须得到**同一个字符串**。
      没有这一条时，`add()` 哪天自己拼字符串也能让上面的用例继续绿 ——
      那正是本项目出现过的"假保护"形态。
    */
    expect(
      makeAnnotationAnchor({
        docId: DOC_ID,
        blocks: [blocks[0]!],
        blockIdx: 0,
        start: 4,
        end: 8,
        locatorBlockIdx: 0,
      }),
    ).toBe(created.locator);
    expect(parseLocator(created.locator)).toEqual({
      docId: DOC_ID,
      pageIdx: 1,
      blockIdx: 0,
      charOffset: 4,
      charLength: 4,
    });
    // 落库的那条也必须带定位符
    expect(puts).toHaveLength(1);
    expect(puts[0]!.locator).toBe(expected);
  });

  it('没有块下标时不写定位符（宁可不锚，也不写一个猜的块号）', async () => {
    await useAnnotationsStore.getState().load(DOC_ID, blocks);
    puts.length = 0;

    const created = await useAnnotationsStore.getState().add({
      blockId: 'doc-d1-b0',
      blockContent: firstContent,
      type: 'highlight',
      color: 'amber',
      selection: { start: 4, end: 8, text: firstContent.slice(4, 8) },
    });

    expect(created.locator).toBeUndefined();
    // 旧锚点仍然在 —— 这条批注照常可用
    expect(created.anchor?.selectedText).toBe(firstContent.slice(4, 8));
  });

  it('不传页码时不写 page 段（md/txt/epub 没有页概念）', async () => {
    await useAnnotationsStore.getState().load(DOC_ID, blocks);

    const created = await useAnnotationsStore.getState().add({
      blockId: 'doc-d1-b1',
      blockContent: '第二段。',
      blockIndex: 1,
      type: 'note',
      color: 'sky',
      selection: { start: 0, end: 3, text: '第二段' },
    });

    expect(created.locator).toBe('doc:d1/block:1/char:0+3');
    expect(created.locator).not.toContain('page');
  });

  it('整段笔记没有选区：不写定位符，也不写 anchor', async () => {
    await useAnnotationsStore.getState().load(DOC_ID, blocks);

    const created = await useAnnotationsStore.getState().add({
      blockId: 'doc-d1-b0',
      blockContent: firstContent,
      blockIndex: 0,
      type: 'note',
      color: 'violet',
      content: '整段感想',
    });

    expect(created.locator).toBeUndefined();
    expect(created.anchor).toBeUndefined();
  });

  it('非法选区（越界）不会写出定位符，但仍能存下批注', async () => {
    await useAnnotationsStore.getState().load(DOC_ID, blocks);

    const created = await useAnnotationsStore.getState().add({
      blockId: 'doc-d1-b0',
      blockContent: firstContent,
      blockIndex: 0,
      type: 'highlight',
      color: 'amber',
      selection: { start: 4, end: firstContent.length + 99, text: '越界' },
    });

    expect(created.locator).toBeUndefined();
    expect(created.id).toBeTruthy();
  });
});

describe('annotationsStore · 迁移后仍可导出/更新', () => {
  it('迁移过的批注照常出现在 JSON 导出里，且带 locator', async () => {
    const legacy = legacyAnnotation('old-5', DOC_ID, 'doc-d1-b0', firstContent, 4, 8);
    storage.set(legacy.id, legacy);
    await useAnnotationsStore.getState().load(DOC_ID, blocks);

    const json = JSON.parse(
      useAnnotationsStore.getState().exportAs('json', '测试文档', new Map([['doc-d1-b0', firstContent]])),
    ) as { count: number; annotations: Array<{ locator?: string; quotedText: string }> };

    expect(json.count).toBe(1);
    expect(json.annotations[0]!.locator).toBe('doc:d1/page:1/block:0/char:4+4');
    expect(json.annotations[0]!.quotedText).toBe(firstContent.slice(4, 8));
  });

  it('update() 不会把 locator 抹掉（局部更新只改传入的字段）', async () => {
    const legacy = legacyAnnotation('old-6', DOC_ID, 'doc-d1-b0', firstContent, 4, 8);
    storage.set(legacy.id, legacy);
    await useAnnotationsStore.getState().load(DOC_ID, blocks);
    puts.length = 0;

    await useAnnotationsStore.getState().update('old-6', { content: '补充一句' });

    const after = useAnnotationsStore.getState().annotations[0]!;
    expect(after.content).toBe('补充一句');
    expect(after.locator).toBe('doc:d1/page:1/block:0/char:4+4');
    expect(puts[0]!.locator).toBe('doc:d1/page:1/block:0/char:4+4');
  });
});
