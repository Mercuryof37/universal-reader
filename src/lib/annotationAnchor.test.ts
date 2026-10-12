import { describe, expect, it } from 'vitest';
import {
  MIN_REPAIR_GAIN,
  anchorFailureMessage,
  indexOfBlock,
  makeAnnotationAnchor,
  makeLocator,
  migrateAnnotation,
  migrateAnnotations,
  pageOf,
  parseLocator,
  resolveAnnotationAnchor,
} from '@/lib/annotationAnchor';
import { buildStyledSegments } from '@/lib/annotations';
import { makeAnchor } from '@/lib/utils';
import type { Annotation, AnnotationType, ContentBlock, HighlightColor } from '@/types/content';

/**
 * 本文件测的是「批注锚点 = 块 ID + 块内字符偏移」这一层。
 *
 * 三条纪律（本项目已出现过 5 次以上"假保护"测试，因此写死在文件头）：
 *
 * 1. **只断言生产函数的调用结果**，不断言"某个名字出现在源码里" ——
 *    `expect(fn.toString()).toMatch(/名字/)` 会匹配 import 语句而不是真实调用。
 * 2. **断言确切坐标**（`toEqual({start, end})`），不用 `not.toBeNull()` 这种
 *    "什么都没证明"的断言：只证明"找到了"分不出"找对了"和"找错了"，
 *    而本模块存在的全部意义就是区分这两者。
 * 3. **断言里的偏移一律现算**（`indexOf` / `slice`），不手写数字：
 *    偏移是 UTF-16 code unit，汉字与"读起来几个字"经常差一，手写必错
 *    （本文件在开发过程中就因为手写偏移错过很多次）。
 */

// ═══════════════════════════════════════════════════════════════
// 夹具
// ═══════════════════════════════════════════════════════════════

function block(content: string, id: string, pageNumber?: number): ContentBlock {
  return {
    id,
    type: 'paragraph',
    content,
    translations: {},
    metadata: pageNumber === undefined ? {} : { pageNumber },
  };
}

interface AnnInput {
  id?: string;
  docId?: string;
  blockId: string;
  type?: AnnotationType;
  color?: HighlightColor;
  anchor?: Annotation['anchor'];
  locator?: string;
  content?: string;
}

function ann(input: AnnInput): Annotation {
  return {
    id: input.id ?? 'a1',
    docId: input.docId ?? 'd1',
    blockId: input.blockId,
    type: input.type ?? 'highlight',
    color: input.color ?? 'amber',
    tags: [],
    ...(input.anchor ? { anchor: input.anchor } : {}),
    ...(input.locator ? { locator: input.locator } : {}),
    ...(input.content ? { content: input.content } : {}),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

/** 造一条**新版**批注：定位符必须由生产构造器产出，不手写字符串 */
function newAnn(
  docId: string,
  blocks: readonly ContentBlock[],
  blockId: string,
  start: number,
  end: number,
): Annotation {
  const blockIdx = indexOfBlock(blocks, blockId);
  const target = blocks[blockIdx]!;
  const locator = makeAnnotationAnchor({ docId, blocks, blockIdx, start, end });
  if (!locator) throw new Error('fixture: locator construction failed');
  return ann({ docId, blockId, anchor: makeAnchor(target.content, start, end), locator });
}

// ═══════════════════════════════════════════════════════════════
// 定位符：构造与解析
// ═══════════════════════════════════════════════════════════════

describe('定位符 · 构造与解析', () => {
  it('完整形态逐字节固定（page 段存在时）', () => {
    const locator = makeLocator({ docId: 'docA', pageIdx: 4, blockIdx: 7, charOffset: 12, charLength: 3 });
    expect(locator).toBe('doc:docA/page:4/block:7/char:12+3');
  });

  it('没有页概念时整段省略 page:，而不是写一个假的 page:1', () => {
    const locator = makeLocator({ docId: 'docA', blockIdx: 0, charOffset: 0, charLength: 5 });
    expect(locator).toBe('doc:docA/block:0/char:0+5');
    // 反向断言：字符串里不能出现 page —— 这是"不许撒谎"的机械形式
    expect(locator).not.toContain('page');
  });

  it('解析回来逐字段相等（round-trip）', () => {
    const locator = makeLocator({ docId: 'docA', pageIdx: 4, blockIdx: 7, charOffset: 12, charLength: 3 });
    expect(parseLocator(locator)).toEqual({
      docId: 'docA',
      pageIdx: 4,
      blockIdx: 7,
      charOffset: 12,
      charLength: 3,
    });
  });

  it('page 缺失时 pageIdx 是 null，不是 0、也不是 1', () => {
    const parsed = parseLocator(makeLocator({ docId: 'd', blockIdx: 2, charOffset: 8, charLength: 1 }));
    expect(parsed?.pageIdx).toBeNull();
    expect(parsed?.blockIdx).toBe(2);
  });

  it('⚠️ base 写死在这里：block 0-based、char 0-based、page 1-based', () => {
    // 若 block 是 1-based，第 1 块会写成 block:1；若页码是 0-based，传进去的 1 会变成 0
    const locator = makeLocator({ docId: 'd', pageIdx: 1, blockIdx: 0, charOffset: 0, charLength: 1 });
    expect(locator).toBe('doc:d/page:1/block:0/char:0+1');
    expect(parseLocator(locator)).toEqual({
      docId: 'd',
      pageIdx: 1,
      blockIdx: 0,
      charOffset: 0,
      charLength: 1,
    });
  });

  it('char 也认 char:12-15 这种"起-止"写法，长度按 [start,end) 算', () => {
    expect(parseLocator('doc:d/page:1/block:2/char:12-15')).toEqual({
      docId: 'd',
      pageIdx: 1,
      blockIdx: 2,
      charOffset: 12,
      charLength: 3,
    });
  });

  it('认不出来的定位符一律返回 null —— 不猜、不补默认值', () => {
    expect(parseLocator(undefined)).toBeNull();
    expect(parseLocator('')).toBeNull();
    expect(parseLocator('block:2/char:1+1')).toBeNull();
    expect(parseLocator('doc:/block:2/char:1+1')).toBeNull();
    expect(parseLocator('doc:d/page:1/block:x/char:1+1')).toBeNull();
    expect(parseLocator('doc:d/page:首页/block:2/char:1+1')).toBeNull();
    expect(parseLocator('doc:d/page:1/block:2/char:abc')).toBeNull();
    expect(parseLocator('doc:d/page:1/block:2/char:12-')).toBeNull();
    expect(parseLocator('doc:d/page:1/char:1+1')).toBeNull();
  });

  it('docId 带连字符/冒号也能解析（PDF 文件名常见）', () => {
    const parsed = parseLocator('doc:2026-10-08T10:13:08.199Z/page:3/block:11/char:4+2');
    expect(parsed?.docId).toBe('2026-10-08T10:13:08.199Z');
    expect(parsed?.pageIdx).toBe(3);
  });

  it('pageOf / indexOfBlock 的边界', () => {
    expect(pageOf(block('x', 'b0', 3))).toBe(3);
    expect(pageOf(block('x', 'b0'))).toBeUndefined();
    expect(pageOf(block('x', 'b0', 0))).toBeUndefined(); // 0 不是合法页码（1-based）
    expect(pageOf(undefined)).toBeUndefined();
    const blocks = [block('a', 'x'), block('b', 'y')];
    expect(indexOfBlock(blocks, 'y')).toBe(1);
    expect(indexOfBlock(blocks, 'zz')).toBe(-1);
  });
});

describe('定位符 · 由选区构造（makeAnnotationAnchor）', () => {
  const blocks = [block('第一段正文。', 'doc-d1-b0', 2), block('第二段正文。', 'doc-d1-b1')];

  it('页码来自块的 metadata，块序号是数组下标', () => {
    expect(makeAnnotationAnchor({ docId: 'd1', blocks, blockIdx: 0, start: 1, end: 3 })).toBe(
      'doc:d1/page:2/block:0/char:1+2',
    );
    // 第 2 块没有页码 → 不写 page 段
    expect(makeAnnotationAnchor({ docId: 'd1', blocks, blockIdx: 1, start: 0, end: 2 })).toBe(
      'doc:d1/block:1/char:0+2',
    );
  });

  it('locatorBlockIdx 覆盖写出的块号（store 只有单块时的通路）', () => {
    // 合成数组里目标块在 0 位，但文档级下标是 5
    const locator = makeAnnotationAnchor({ docId: 'd1', blocks, blockIdx: 0, start: 0, end: 2, locatorBlockIdx: 5 });
    expect(locator).toBe('doc:d1/page:2/block:5/char:0+2');
    expect(parseLocator(locator)?.blockIdx).toBe(5);
  });

  it('显式 pageIdx 覆盖 metadata', () => {
    const locator = makeAnnotationAnchor({ docId: 'd1', blocks, blockIdx: 1, start: 0, end: 2, pageIdx: 9 });
    expect(parseLocator(locator)?.pageIdx).toBe(9);
  });

  it('非法区间/块不存在时返回 undefined（宁可不锚，也不给错坐标）', () => {
    expect(makeAnnotationAnchor({ docId: 'd1', blocks, blockIdx: 5, start: 0, end: 2 })).toBeUndefined();
    expect(makeAnnotationAnchor({ docId: 'd1', blocks, blockIdx: 0, start: 3, end: 3 })).toBeUndefined();
    expect(makeAnnotationAnchor({ docId: 'd1', blocks, blockIdx: 0, start: 2, end: 1 })).toBeUndefined();
    expect(makeAnnotationAnchor({ docId: 'd1', blocks, blockIdx: 0, start: -1, end: 2 })).toBeUndefined();
    expect(makeAnnotationAnchor({ docId: 'd1', blocks, blockIdx: 0, start: 0, end: 99 })).toBeUndefined();
    expect(makeAnnotationAnchor({ docId: 'd1', blocks, blockIdx: 0, start: Number.NaN, end: 2 })).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// 还原位置：round-trip 与判别性用例
// ═══════════════════════════════════════════════════════════════

describe('还原位置 · round-trip 与判别性用例', () => {
  it('构建 → 重新解析 → 还原到与原选区逐字符相同的位置', () => {
    const original = [block('概率论与数理统计习题五。', 'doc-d1-b0', 1)];
    const a = newAnn('d1', original, 'doc-d1-b0', 2, 6);
    expect(a.locator).toBe('doc:d1/page:1/block:0/char:2+4');

    // 重新解析：块 id 一样、文本一样（真实场景里这是最常见的一次）
    const reparsed = [block('概率论与数理统计习题五。', 'doc-d1-b0', 1)];
    const res = resolveAnnotationAnchor(a, reparsed);
    expect(res).toEqual({
      resolved: true,
      start: 2,
      end: 6,
      strategy: 'exact',
      shiftedBy: 0,
      reason: null,
    });
    expect(reparsed[0]!.content.slice(res.start, res.end)).toBe('论与数理');
  });

  it('⭐ 同一段文字出现在两个块里：两条批注各自锚到正确的那个块', () => {
    const shared = '结论：该定理成立。';
    const blocks = [block(`第一节。${shared}`, 'doc-d1-b0'), block(`第二节。${shared}`, 'doc-d1-b1')];

    const first = newAnn('d1', blocks, 'doc-d1-b0', 4, 4 + shared.length);
    const second = newAnn('d1', blocks, 'doc-d1-b1', 4, 4 + shared.length);
    expect(first.locator).toBe('doc:d1/block:0/char:4+9');
    expect(second.locator).toBe('doc:d1/block:1/char:4+9');

    expect(resolveAnnotationAnchor(first, blocks)).toMatchObject({ start: 4, end: 13, strategy: 'exact' });
    expect(resolveAnnotationAnchor(second, blocks)).toMatchObject({ start: 4, end: 13, strategy: 'exact' });

    // 判别性证据：各自只在自己的块里命中
    const seg1 = buildStyledSegments(blocks[0]!.content, [first], [], blocks);
    expect(seg1.filter((s) => s.annotationIds.length).map((s) => s.text).join('')).toBe(shared);
    expect(seg1.some((s) => s.annotationIds.length && s.text.includes('第一节'))).toBe(false);
  });

  it('同一块内选第二次出现的那一处：定位符指的正是第二处', () => {
    const content = 'ABC。ABC。尾巴';
    const blocks = [block(content, 'doc-d1-b0')];
    const second = newAnn('d1', blocks, 'doc-d1-b0', 4, 7);
    expect(second.locator).toBe('doc:d1/block:0/char:4+3');
    expect(resolveAnnotationAnchor(second, blocks)).toMatchObject({ start: 4, end: 7, strategy: 'exact' });
  });

  it('⚠️ 旧偏移处就是原文时：即使块内还有同样的文字，也稳定命中旧偏移那一处', () => {
    /*
      这条用例记录一个**实测出来的结构性事实**：

      - 只要旧偏移处的文字**仍然等于**旧选区，"定位符原位逐字命中"就直接成立；
      - 而"两处候选离旧偏移差不多远"要求旧偏移夹在两处出现之间 ——
        在那种布局下旧偏移处的文字必然与其中一处的开头相同，又回到"原位命中"。
      - 结论：**"同样近的两处弱候选"在真实批注上够不着**（弱证据层只在原位命中失败后
        才被使用）。这也说明"先验证、后修复、最后才挑"这个次序是对的：
        **能确定的就别去挑。**
    */
    const marker = 'XYZ';
    const body = `${'A'.repeat(28)}${marker}${'B'.repeat(12)}${marker}${'C'.repeat(20)}`;
    const p1 = body.indexOf(marker);
    const p2 = body.indexOf(marker, p1 + 1);
    expect(p1).toBe(28);
    expect(p2).toBe(43);

    const a = ann({
      docId: 'd1',
      blockId: 'doc-d1-b0',
      anchor: makeAnchor(body, p1, p1 + marker.length),
      locator: makeLocator({ docId: 'd1', blockIdx: 0, charOffset: p1, charLength: marker.length }),
    });

    const res = resolveAnnotationAnchor(a, [block(body, 'doc-d1-b0')]);
    expect(res).toEqual({
      resolved: true,
      start: p1,
      end: p1 + marker.length,
      strategy: 'exact',
      shiftedBy: 0,
      reason: null,
    });
    expect(res.start).toBe(p1);
    expect(res.start).not.toBe(p2);

    // 渲染层：高亮只覆盖旧偏移那 3 个字，且原文一个字不少
    const segs = buildStyledSegments(body, [a], [], [block(body, 'doc-d1-b0')]);
    expect(segs.map((s) => s.text).join('')).toBe(body);
    expect(segs.filter((s) => s.annotationIds.length).map((s) => s.text).join('')).toBe(marker);
  });
});

// ═══════════════════════════════════════════════════════════════
// 漂移改善：文字前后小幅增删
// ═══════════════════════════════════════════════════════════════

describe('漂移改善 · 文字前后小幅增删', () => {
  const base = '这是一段用于测试批注漂移的示例文字，前后各留一些上下文，确保修复判据有足够的证据可用。';
  /** 选区：base 正中间 4 个字符。偏移全部由 indexOf 算出，不手写数字 */
  const mid = Math.floor(base.length / 2);
  const selected = base.slice(mid, mid + 4);

  it('选区前面插入一段：批注跟着文字走，偏移恰好等于插入量（不差一个字）', () => {
    const blocks = [block(base, 'doc-d1-b0')];
    const a = newAnn('d1', blocks, 'doc-d1-b0', mid, mid + 4);
    expect(a.locator).toBe(`doc:d1/block:0/char:${mid}+4`);
    expect(a.anchor?.selectedText).toBe(selected);
    // 防御：选中的这 4 个字在原文里只能出现一次，否则"跟着走"没有判别力
    expect(base.indexOf(selected)).toBe(base.lastIndexOf(selected));

    const inserted = '【编者按】';
    const edited = `${inserted}${base}`;
    const res = resolveAnnotationAnchor(a, [block(edited, 'doc-d1-b0')]);
    /*
      ⚠️ 偏移是 UTF-16 code unit：插入的是 5 个汉字（length 5），不是字节数、不是字形数。
      "恰好等于插入量"这条断言是有判别力的：早期实现会让选区的最后一个字去和
      "选区末尾"对齐，于是给出 mid+9 这种**少算 4 个字**的坐标。
    */
    expect(res).toEqual({
      resolved: true,
      start: mid + inserted.length,
      end: mid + 4 + inserted.length,
      strategy: 'repaired',
      shiftedBy: inserted.length,
      reason: null,
    });
    expect(edited.slice(res.start, res.end)).toBe(selected);
    expect(edited.indexOf(selected)).toBe(res.start);
  });

  it('选区前面删掉一小段：同样跟着走', () => {
    const blocks = [block(base, 'doc-d1-b0')];
    const a = newAnn('d1', blocks, 'doc-d1-b0', mid, mid + 4);
    const removed = 5;
    const edited = base.slice(removed);
    const res = resolveAnnotationAnchor(a, [block(edited, 'doc-d1-b0')]);
    expect(res).toMatchObject({
      resolved: true,
      start: mid - removed,
      end: mid + 4 - removed,
      strategy: 'repaired',
      shiftedBy: -removed,
    });
    expect(edited.slice(res.start, res.end)).toBe(selected);
  });

  it('⚠️ 选区前面被删掉一大段（把前缀证据也删光了）：宁可失锚，不硬落位', () => {
    const blocks = [block(base, 'doc-d1-b0')];
    const a = newAnn('d1', blocks, 'doc-d1-b0', mid, mid + 4);
    const removed = mid + 3;
    const edited = base.slice(removed);
    const res = resolveAnnotationAnchor(a, [block(edited, 'doc-d1-b0')]);
    // 证据不足时唯一正确的行为是报失锚；绝不能拿旧偏移去新文本里硬落位
    expect(res).toMatchObject({ resolved: false, reason: 'stale-offset' });
    expect(edited.slice(mid, mid + 4)).not.toBe(selected);
  });

  it('选区后面被追加内容：位置纹丝不动，且**不算**"修复过"', () => {
    const blocks = [block(base, 'doc-d1-b0')];
    const a = newAnn('d1', blocks, 'doc-d1-b0', mid, mid + 4);
    const edited = `${base}（后记）`;
    const res = resolveAnnotationAnchor(a, [block(edited, 'doc-d1-b0')]);
    expect(res).toEqual({
      resolved: true,
      start: mid,
      end: mid + 4,
      strategy: 'exact',
      shiftedBy: 0,
      reason: null,
    });
  });

  it('⚠️ 只有弱证据（选区太短、前缀也被改）时：挪动量不够就报失锚', () => {
    // 前缀是 'ABCDEFGHIJ'、选区 'KLM'（尾部=整条选区，只有 3 个字）
    const blocks = [block('ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'doc-d1-b0')];
    const a = newAnn('d1', blocks, 'doc-d1-b0', 10, 13);

    // ① 前缀完好、只是整体后移 4：强证据层不受阈值限制，应正确修到 14
    const shifted = `ZZZZ${'ABCDEFGHIJKLMNOPQRSTUVWXYZ'}`;
    const hit = resolveAnnotationAnchor(a, [block(shifted, 'doc-d1-b0')]);
    expect(hit).toMatchObject({ resolved: true, start: 14, end: 17, strategy: 'repaired', shiftedBy: 4 });
    expect(shifted.slice(hit.start, hit.end)).toBe('KLM');

    // ② 前缀**本身**也被改掉：只剩弱证据，挪动量 4 < MIN_REPAIR_GAIN，判失锚
    const broken = `ZZZZ${'abcdeFGHIJKLMNOPQRSTUVWXYZ'}`;
    const res = resolveAnnotationAnchor(a, [block(broken, 'doc-d1-b0')]);
    expect(MIN_REPAIR_GAIN).toBeGreaterThan(4);
    expect(res).toMatchObject({ resolved: false, reason: 'stale-offset' });
    expect(res.start).toBe(-1);
    // 正确答案其实是 14，但证据不足 → 宁可不给
    expect(broken.slice(14, 17)).toBe('KLM');
  });

  it('批注选中的文字本身被改掉、前后文还在：要么位置不漂，要么明确失锚', () => {
    const blocks = [block(base, 'doc-d1-b0')];
    const a = newAnn('d1', blocks, 'doc-d1-b0', mid, mid + 4);
    const edited = `${base.slice(0, mid + 1)}改${base.slice(mid + 2)}`;
    const res = resolveAnnotationAnchor(a, [block(edited, 'doc-d1-b0')]);
    // 唯一不允许的是"悄悄挪到别处还说命中了"
    if (res.resolved) {
      expect(Math.abs(res.start - mid)).toBeLessThanOrEqual(1);
    } else {
      expect(res.reason).toBe('stale-offset');
    }
  });

  it('公差常量本身要被钉住（改了就必须同时改这条断言）', () => {
    // 决定"多小的位移算巧合"的那个数，不是可以随手调的自由参数
    expect(MIN_REPAIR_GAIN).toBe(8);
  });

  it('⭐ 文字推移靠**前缀**就能定回原位（改动落在前缀窗口之外）', () => {
    /*
      ⚠️ 夹具的正文用**互相区分**的字符段拼出来，不用 'ABCDEFG…' 那种连续字母表：
      连续字母表里"尾部"这种子串会到处重复（实测就撞过：尾部在另一个位置也出现，
      于是被距离更近的候选抢走），夹具会变成在考"哪个巧合更近"，而不是在考锚点。
    */
    const pre = 'P'.repeat(25);
    const head = 'abcdEFGH';
    const tailPart = '0123456789';
    const sentence = `${pre}${head}${tailPart}`;
    const start = 30;
    const end = start + 12;
    const blocks = [block(sentence, 'doc-d1-b0')];
    const a = newAnn('d1', blocks, 'doc-d1-b0', start, end);
    const selected = sentence.slice(start, end);

    // 最前面插入 3 个字把文字推移；另有一处改动落在**前缀窗口之外**（不干扰定位符）
    const shift = 3;
    const editAt = 5;
    const edited = `${'参'.repeat(shift)}${sentence.slice(0, editAt)}Y${sentence.slice(editAt + 1)}`;
    expect(edited.length).toBe(sentence.length + shift);
    expect(edited.slice(start + shift, end + shift)).toBe(selected);
    expect(edited.startsWith(selected, start)).toBe(false); // 原位命中必须失败
    // 夹具前提：选区前 15 字（前缀窗口）**没有被改动**
    expect(edited.slice(start + shift - 15, start + shift)).toBe(sentence.slice(start - 15, start));

    const res = resolveAnnotationAnchor(a, [block(edited, 'doc-d1-b0')]);
    expect(res).toEqual({
      resolved: true,
      start: start + shift,
      end: end + shift,
      strategy: 'repaired',
      shiftedBy: shift,
      reason: null,
    });
    expect(edited.slice(res.start, res.end)).toBe(selected);
  });

  it('⚠️ 文字被推移、且改动落在**前缀窗口之内**、选区又短：宁可失锚', () => {
    /*
      这条用例记录一个**边界**：前缀（选区前 15 字）**自己**被改过时，
      "前缀 ⊕ 尾部"在新文本里找不到，推算位移退化为 0；只剩弱证据层可用，
      而它要求挪动量达到 `MIN_REPAIR_GAIN` —— 这里只有 3，所以报失锚。
      **这是刻意的：证据不够时不猜。**
    */
    const pre = 'P'.repeat(25);
    const sentence = `${pre}abcdEFGH0123456789`;
    const start = 30;
    const blocks = [block(sentence, 'doc-d1-b0')];
    const a = newAnn('d1', blocks, 'doc-d1-b0', start, start + 3);

    const shift = 3;
    const editAt = start - 2; // 落在前缀窗口之内
    const edited = `${'参'.repeat(shift)}${sentence.slice(0, editAt)}Y${sentence.slice(editAt + 1)}`;
    expect(edited.slice(start + shift, start + shift + 3)).toBe(sentence.slice(start, start + 3));

    const res = resolveAnnotationAnchor(a, [block(edited, 'doc-d1-b0')]);
    expect(res).toMatchObject({ resolved: false, reason: 'stale-offset' });
    expect(res.start).toBe(-1);
  });

  it('⚠️ 前缀被改坏 + 文字被推移：即使尾部在新文本里唯一，挪动量不够也报失锚', () => {
    /*
      与上一条对照，记录这一层**守在哪儿**（第一版以为这里能靠"尾部唯一"命中，
      实测被打回，原因写下来）：

      - 前缀被改坏 → "前缀 ⊕ 尾部"找不到 → 推算位移退化为 0，强证据层失效；
      - 剩下的弱证据层（尾部起点）有一条硬门槛：挪动量必须 ≥ `MIN_REPAIR_GAIN`。
      本夹具里尾部 'z0123456789A' 在新文本里**确实唯一**（可验证），
      但挪动量只有 3 < 8，于是照样报失锚。

      **这是刻意的取舍**：弱证据层是唯一会"选一个位置"的地方，
      门槛低了它就会在"尾部到处出现"的块里随机挑一个。用户看到的是
      "原文已改动，锚点位置对不上"，然后自己重锚 —— 比悄悄挪错好。
    */
    /*
      ⚠️ 夹具的前缀区**不能是同一个字重复**（第一版是 'P'.repeat(25)，结果删一个 P
      仍然能在别处找到同样的前缀）—— 用互不相同的字符，这样"改掉一个字"才真的
      让这份前缀在新文本里消失。
    */
    const head = 'abcdefghijklmnopqrstuvwxyz';
    const sentence = `${head}0123456789ABCDEF`;
    const start = 25;
    const end = start + 12;
    expect(end).toBeLessThanOrEqual(sentence.length);
    const blocks = [block(sentence, 'doc-d1-b0')];
    const a = newAnn('d1', blocks, 'doc-d1-b0', start, end);
    const selected = sentence.slice(start, end);

    const shift = 3;
    const editAt = start - 2; // 落在前缀窗口之内 → 前缀对不上
    const edited = `${'参'.repeat(shift)}${sentence.slice(0, editAt)}Y${sentence.slice(editAt + 1)}`;
    expect(edited.slice(start + shift, end + shift)).toBe(selected);
    // 夹具前提 1：这份前缀在新文本里已经找不到（"前缀被改坏"的形式化描述）
    expect(edited.includes(sentence.slice(start - 15, start))).toBe(false);
    // 夹具前提 2：尾部在新文本里**唯一** —— 所以下面失败的原因不是"歧义"，是"证据不够"
    expect(edited.indexOf(selected)).toBe(start + shift);
    expect(edited.indexOf(selected, start + shift + 1)).toBe(-1);
    // 前提 3：挪动量确实小于门槛
    expect(shift).toBeLessThan(MIN_REPAIR_GAIN);

    const res = resolveAnnotationAnchor(a, [block(edited, 'doc-d1-b0')]);
    expect(res).toEqual({
      resolved: false,
      start: -1,
      end: -1,
      strategy: null,
      shiftedBy: 0,
      reason: 'stale-offset',
    });
  });

  it('⭐ 块内同一段文字出现多次 + 前文被删过：批注回**前缀边界**那一处，不是 indexOf 的第一处', () => {
    // 三处 'QRS'：第 0 处（干扰项）、目标处、目标处之后隔 1 字又一处
    const filler = '填充'.repeat(30);
    const content = `XXQRS${filler}了QRS了QRS`;

    /*
      选区取 7 个字（正好到块尾）：**选区内部还有一次 'QRS'**。
      这样"尾部在块内出现的位置"有多个，而只有目标处左侧那 15 个字（旧前缀）
      能与之接上 —— 前缀边界因此成为唯一能区分它们的证据。
    */
    const targetStart = content.lastIndexOf('QRS了QRS');
    expect(targetStart).toBeGreaterThan(10);
    expect(targetStart + 7).toBe(content.length);
    const anchor = makeAnchor(content, targetStart, targetStart + 7);
    expect(anchor?.selectedText).toBe('QRS了QRS');
    expect(content.slice(0, targetStart)).toContain('XXQRS');
    const a = ann({
      docId: 'd1',
      blockId: 'doc-d1-b0',
      anchor,
      locator: makeLocator({ docId: 'd1', blockIdx: 0, charOffset: targetStart, charLength: 7 }),
    });

    // 开头删掉 1 个字符：干扰项与目标处都还在，只是整体前移 1
    const edited = content.slice(1);
    const res = resolveAnnotationAnchor(a, [block(edited, 'doc-d1-b0')]);

    expect(res.resolved).toBe(true);
    expect(res.start).toBe(targetStart - 1);
    expect(edited.slice(res.start, res.end)).toBe(anchor?.selectedText);
    expect(edited.slice(res.start, res.end)).toBe('QRS了QRS');
    // 判别性证据：文本匹配会落到第 0 处那个干扰项，定位符不会
    expect(edited.indexOf('QRS')).toBeLessThan(res.start);
    expect(res.start).not.toBe(edited.indexOf('QRS'));
    expect(edited.slice(res.start - 1, res.start)).toBe('了');
  });

  it('⚠️ 短文字出现两次、前缀里也含它：取**离旧位置最近**的那一处，而不是 indexOf 的第一处', () => {
    /*
      这一节记录**实测**得到的两个事实（第一版用例的前提是错的，错在哪一并写下）：

      1. **"两处候选并列"在真实批注上够不着。** 设两处候选为 A < B，旧偏移为 T：
         若 B ≤ T，A 处候选的距离是 0（T 就落在那段旧文字里），连 `MIN_REPAIR_GAIN`
         都过不了；若 B > T，则 A ≤ T，A 处候选的距离同样是 0。
         两种情况都进不了弱证据层 —— 所以**永远只剩一个候选**，
         弱证据层没有"并列"可言。我试了四版夹具都没能造出可达的并列
         （见 `pickCandidate` 里那段"已知不可达"的说明）。
      2. 于是真实的取值规则就是"**取最近的那一处**"（这里是它唯一还能分辨的地方：
         短文字在块内出现两次、前缀里也含它，前缀边界规则失效）。

      判别性事实：**文本匹配给第一处（`indexOf` 的固有行为），本模块给最近的那处。**
    */
    const marker = '结论成立。';
    // 前置填充正好 15 个字：第二处 marker 左侧那 15 个字**也**含一次 marker，
    // 前缀边界规则因此失效，用例才真正落在弱证据层上
    const content = `说明说明说明说明说明说明${marker}补充：${marker}`;
    const first = content.indexOf(marker);
    const second = content.indexOf(marker, first + 1);
    const anchor = makeAnchor(content, second, second + marker.length);
    expect(anchor?.prefix.length).toBe(15);
    expect(anchor?.prefix.includes(marker)).toBe(true);

    const a = ann({
      docId: 'd1',
      blockId: 'doc-d1-b0',
      anchor,
      locator: makeLocator({ docId: 'd1', blockIdx: 0, charOffset: second, charLength: marker.length }),
    });

    // 删掉第一处之前的 10 个字：两处一起前移 10
    const cut = 10;
    const edited = content.slice(cut);
    const p1 = edited.indexOf(marker);
    const p2 = edited.indexOf(marker, p1 + 1);
    expect(first - p1).toBe(cut);
    expect(second - p2).toBe(cut);
    // 事实 1：两处与旧位置的距离差保持不变 —— 不是并列
    expect(Math.abs(p1 - second) - Math.abs(p2 - second)).toBe(second - first);

    const res = resolveAnnotationAnchor(a, [block(edited, 'doc-d1-b0')]);
    expect(res).toEqual({
      resolved: true,
      start: p2,
      end: p2 + marker.length,
      strategy: 'repaired',
      shiftedBy: p2 - second,
      reason: null,
    });
    // 判别性证据：文本匹配会落在第一处，本模块落在更近的第二处
    expect(res.start).not.toBe(p1);
    expect(edited.indexOf(marker)).toBeLessThan(res.start);
    expect(edited.slice(res.start, res.end)).toBe(marker);
  });

  it('⚠️ 弱证据层的"并列弃权"判据：既无用例覆盖，我也没能构造出反例（如实记录）', () => {
    /*
      这个用例**不测行为**，只把实测结论钉在这里，免得后人误以为那段判据有保护：

      1. **实测事实**：把 `pickCandidate` 里 `if (rival) return null;` 注释掉
         （等于关掉判据）后，整个套件**全绿**。
      2. 我试了五版夹具想造出"两处候选距离差 ≤ 2、且都通过逐字校验"的场景，
         都没成功。最接近的一版（对称布局）在最后一步失败，原因值得记下来：
         想让两处候选**同时**通过"尾部恰好从这里开始"的校验，旧偏移往往就
         落在其中一处的旧文字里，于是"原位逐字命中"先成立、根本走不到这一层。
      3. ⚠️ 我一度写了个"可证明不可达"的论证，**那个论证是错的**
         （漏了"旧偏移可以落在第一处候选的尾部内部"这一种情形），所以这里不写论证。

      结论：`AMBIGUITY_MARGIN` 与 `rival` 判断是**防御性代码**（源码里有同样的说明）。
      代价是 O(候选数) 的本地判断，留着；但**不要以为它被验证过**。
    */
    expect(MIN_REPAIR_GAIN).toBe(8);

    // 顺带钉住弱证据层确定可达的那条规则：距离不足门槛的候选直接进不来
    const marker = 'XYZ';
    const body = `${'A'.repeat(28)}${marker}${'B'.repeat(12)}${marker}${'C'.repeat(20)}`;
    const savedOffset = 31; // 处是 'BBB'，不是原文 → 原位命中失败
    expect(body.slice(savedOffset, savedOffset + marker.length)).toBe('BBB');
    expect(Math.abs(28 - savedOffset)).toBe(3); // 28 处距离 3 < 门槛 → 被挡掉
    expect(Math.abs(43 - savedOffset)).toBe(12); // 43 处距离 12 ≥ 门槛 → 可选

    const a = ann({
      docId: 'd1',
      blockId: 'doc-d1-b0',
      anchor: makeAnchor(body, savedOffset, savedOffset + 3),
      locator: makeLocator({ docId: 'd1', blockIdx: 0, charOffset: savedOffset, charLength: 3 }),
    });

    const res = resolveAnnotationAnchor(a, [block(body, 'doc-d1-b0')]);
    // 旧偏移处的 3 个字恰好就是存下来的选区文本 → 原位逐字命中，返回 31
    // （这正是实测里"很难落到弱证据层"的原因，写在注释第 2 条）
    expect(res).toEqual({ resolved: true, start: 31, end: 34, strategy: 'exact', shiftedBy: 0, reason: null });
  });
});

// ═══════════════════════════════════════════════════════════════
// 失锚：绝不静默落错位
// ═══════════════════════════════════════════════════════════════

describe('失锚 · 明确报告而不是猜位置', () => {
  it('文字整段消失（块还在）→ stale-offset', () => {
    const blocks = [block('原文在这里。', 'doc-d1-b0')];
    const a = newAnn('d1', blocks, 'doc-d1-b0', 0, 3);
    const res = resolveAnnotationAnchor(a, [block('完全不相干的内容。', 'doc-d1-b0')]);
    expect(res.resolved).toBe(false);
    expect(res.reason).toBe('stale-offset');
    expect(res.start).toBe(-1);
  });

  it('块整块消失 → block-missing（对照：块还在时同一个锚点是能命中的）', () => {
    const blocks = [block('原文在这里。', 'doc-d1-b0')];
    const a = newAnn('d1', blocks, 'doc-d1-b0', 0, 3);
    const res = resolveAnnotationAnchor(a, [block('别的块。', 'doc-d1-b1')]);
    expect(res).toMatchObject({ resolved: false, reason: 'block-missing' });
    expect(resolveAnnotationAnchor(a, blocks)).toMatchObject({ resolved: true, start: 0, end: 3 });
  });

  it('定位符读不出来 → 退回旧锚点路径（策略是 legacy，不是 exact）', () => {
    const blocks = [block('原文在这里。', 'doc-d1-b0')];
    const bad = { ...newAnn('d1', blocks, 'doc-d1-b0', 0, 3), locator: '不是定位符' };
    const res = resolveAnnotationAnchor(bad, blocks);
    expect(res).toMatchObject({ resolved: true, start: 0, end: 3, strategy: 'legacy' });
  });

  it('定位符读不出来、旧锚点也找不到 → parse-failed（原因要说清是定位符坏了）', () => {
    const blocks = [block('原文在这里。', 'doc-d1-b0')];
    const bad = { ...newAnn('d1', blocks, 'doc-d1-b0', 0, 3), locator: '不是定位符' };
    const res = resolveAnnotationAnchor(bad, [block('完全不相干。', 'doc-d1-b0')]);
    expect(res).toMatchObject({ resolved: false, reason: 'parse-failed' });
  });

  it('定位符属于别的文档 → doc-mismatch（不硬用别的文档的坐标）', () => {
    const blocks = [block('原文在这里。', 'doc-d1-b0')];
    const a = { ...newAnn('d1', blocks, 'doc-d1-b0', 0, 3), locator: 'doc:d2/block:0/char:0+3' };
    const res = resolveAnnotationAnchor(a, blocks);
    expect(res).toMatchObject({ resolved: true, start: 0, end: 3, strategy: 'legacy' });
    const lost = resolveAnnotationAnchor(a, [block('换掉了。', 'doc-d1-b0')]);
    expect(lost).toMatchObject({ resolved: false, reason: 'doc-mismatch' });
  });

  it('没有 anchor（整段笔记）→ no-anchor，且不产生零长度区间', () => {
    const a = ann({ blockId: 'doc-d1-b0' });
    const res = resolveAnnotationAnchor(a, [block('原文在这里。', 'doc-d1-b0')]);
    expect(res).toMatchObject({ resolved: false, reason: 'no-anchor' });
    expect(anchorFailureMessage('no-anchor')).toBe('整段批注（没有选区）');
  });

  it('每个失败原因都有给人看的中文说明', () => {
    for (const reason of ['parse-failed', 'doc-mismatch', 'block-missing', 'stale-offset', 'text-missing'] as const) {
      expect(anchorFailureMessage(reason).length).toBeGreaterThan(4);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 迁移：旧格式批注升级为块内字符偏移
// ═══════════════════════════════════════════════════════════════

describe('迁移 · 旧格式批注升级为块内字符偏移', () => {
  const blocks = [block('第一段：这是一段足够长的正文，用来放批注。', 'doc-d1-b0', 1), block('第二段。', 'doc-d1-b1')];

  it('位置没变：升级为 exact，保留旧 anchor 原文，位置逐字符正确', () => {
    const legacy = ann({ blockId: 'doc-d1-b0', anchor: makeAnchor(blocks[0]!.content, 4, 8) });
    const { annotation, report } = migrateAnnotation(legacy, blocks, { now: '2026-02-02T00:00:00.000Z' });

    expect(report).toEqual({ changed: true, ok: true, failure: null });
    expect(annotation.locator).toBe('doc:d1/page:1/block:0/char:4+4');
    expect(annotation.anchor?.selectedText).toBe(legacy.anchor!.selectedText);
    expect(annotation.migration).toEqual({
      at: '2026-02-02T00:00:00.000Z',
      strategy: 'exact',
      shiftedBy: 0,
    });
    expect(resolveAnnotationAnchor(annotation, blocks)).toMatchObject({ start: 4, end: 8, strategy: 'exact' });
  });

  it('位置被小幅挪动：迁移出新偏移，并如实记录挪了多少', () => {
    const legacy = ann({ blockId: 'doc-d1-b0', anchor: makeAnchor(blocks[0]!.content, 4, 8) });
    const prefix = '【按】';
    const shifted = [{ ...blocks[0]!, content: `${prefix}${blocks[0]!.content}` }, blocks[1]!];
    const { annotation, report } = migrateAnnotation(legacy, shifted, { now: 'T' });

    expect(report.changed).toBe(true);
    expect(annotation.locator).toBe(`doc:d1/page:1/block:0/char:${4 + prefix.length}+4`);
    // 旧锚点里存着完整原文，所以这次命中判据是"原位精确定位"；
    // 无论哪个判据，**挪了多少必须如实记录**
    expect(annotation.migration?.shiftedBy).toBe(prefix.length);
    expect(['exact', 'repaired']).toContain(annotation.migration?.strategy);
    // 旧 anchor 也一起更新，两个字段指向同一处
    expect(annotation.anchor?.offset).toBe(4 + prefix.length);
    expect(annotation.anchor?.selectedText).toBe(legacy.anchor!.selectedText);
    // 迁移出来的 locator 与直接构造的必须一致（防止"迁移路径自成一派"）
    expect(annotation.locator).toBe(
      makeAnnotationAnchor({
        docId: 'd1',
        blocks: shifted,
        blockIdx: 0,
        start: 4 + prefix.length,
        end: 8 + prefix.length,
      }),
    );
  });

  it('⚠️ 迁移失败：原件**逐字段原样返回**，不删、不改、下次再试', () => {
    const legacy = ann({ blockId: 'doc-d1-b0', anchor: makeAnchor(blocks[0]!.content, 4, 8) });
    const gone = [block('这段文字整段被换掉了。', 'doc-d1-b0'), blocks[1]!];
    const { annotation, report } = migrateAnnotation(legacy, gone, { now: 'T' });

    expect(report).toEqual({ changed: false, ok: false, failure: 'text-missing' });
    // 同一个引用：调用方靠引用判断"要不要写库"
    expect(annotation).toBe(legacy);
    expect(annotation.locator).toBeUndefined();
    expect(annotation.migration).toBeUndefined();
  });

  it('块没了、但文字整体挪到了别的块：迁移期允许重挂块，并把新块 id 一起落盘', () => {
    const legacy = ann({ blockId: 'doc-d1-b0', anchor: makeAnchor('这一段是目标内容，需要重挂。', 5, 9) });
    const after = [block('新增的页眉块。', 'doc-d1-b0'), block('这一段是目标内容，需要重挂。', 'doc-d1-b1')];
    const { annotation, report } = migrateAnnotation(legacy, after, { now: 'T' });
    expect(report.changed).toBe(true);
    expect(annotation.blockId).toBe('doc-d1-b1');
    expect(annotation.locator).toBe('doc:d1/block:1/char:5+4');
    expect(annotation.migration).toMatchObject({ strategy: 'rebased' });
    // 重挂之后侧栏跳转与高亮指的是同一个块
    expect(resolveAnnotationAnchor(annotation, after)).toMatchObject({ resolved: true, start: 5, end: 9 });
  });

  it('渲染期**不开**跨块搜索：块还在但文字没了，绝不跳到别的块去', () => {
    const legacy = ann({ blockId: 'doc-d1-b0', anchor: makeAnchor('这一段是目标内容，需要重挂。', 5, 9) });
    const after = [block('新增的页眉块。', 'doc-d1-b0'), block('这一段是目标内容，需要重挂。', 'doc-d1-b1')];
    const render = resolveAnnotationAnchor(legacy, after);
    expect(render.resolved).toBe(false);
    expect(render.reason).toBe('text-missing');
    const migrate = resolveAnnotationAnchor(legacy, after, { searchOtherBlocks: true });
    expect(migrate).toMatchObject({ resolved: true, start: 5, end: 9 });
  });

  it('已经是新格式的批注：迁移是幂等的，不产生第二次改动', () => {
    const a = newAnn('d1', blocks, 'doc-d1-b0', 4, 8);
    const once = migrateAnnotation(a, blocks, { now: 'T' });
    expect(once.report).toEqual({ changed: false, ok: false, failure: null });
    expect(once.annotation).toBe(a);
  });

  it('整段笔记（没有选区）：留在旧路径上，不算迁移失败', () => {
    const note = ann({ blockId: 'doc-d1-b0', type: 'note' });
    const { annotation, report } = migrateAnnotation(note, blocks, { now: 'T' });
    expect(report).toEqual({ changed: false, ok: false, failure: 'no-anchor' });
    expect(annotation).toBe(note);
  });

  it('migrateAnnotations 汇总：成功数 / 失败清单 / 别的文档的批注原样带过', () => {
    const ok = ann({ id: 'ok', blockId: 'doc-d1-b0', anchor: makeAnchor(blocks[0]!.content, 4, 8) });
    const lost = ann({ id: 'lost', blockId: 'doc-d1-b0', anchor: makeAnchor('早就没有了的文字。', 0, 9) });
    const other = ann({ id: 'other', docId: 'd9', blockId: 'doc-d9-b0', anchor: makeAnchor('别的文档', 0, 4) });

    const { annotations, migrated, failed } = migrateAnnotations([ok, lost, other], { id: 'd1', blocks }, { now: 'T' });
    expect(migrated).toBe(1);
    expect(failed).toEqual([{ id: 'lost', reason: 'text-missing' }]);
    expect(annotations[0]).not.toBe(ok);
    expect(annotations[0]!.locator).toBe('doc:d1/page:1/block:0/char:4+4');
    expect(annotations[1]).toBe(lost);
    expect(annotations[2]).toBe(other);
  });

  it('迁移后旧格式批注的渲染结果与迁移前一致（不改变旧路径行为）', () => {
    const legacy = ann({ blockId: 'doc-d1-b0', anchor: makeAnchor(blocks[0]!.content, 4, 8) });
    const before = buildStyledSegments(blocks[0]!.content, [legacy], [], blocks);
    const { annotation } = migrateAnnotation(legacy, blocks, { now: 'T' });
    const after = buildStyledSegments(blocks[0]!.content, [annotation], [], blocks);
    const highlighted = (segs: typeof before) =>
      segs.filter((s) => s.annotationIds.length).map((s) => s.text).join('');
    expect(highlighted(before)).toBe('这是一段');
    expect(highlighted(after)).toBe(highlighted(before));
  });
});

// ═══════════════════════════════════════════════════════════════
// 与渲染层的接线
// ═══════════════════════════════════════════════════════════════

describe('与渲染层接线 · buildStyledSegments', () => {
  const content = 'ABCDEFGHIJKLMNOP';

  it('高亮位置跟着定位符（而不是跟着旧 offset）', () => {
    const blocks = [block(content, 'doc-d1-b0')];
    const a = newAnn('d1', blocks, 'doc-d1-b0', 8, 11); // 'IJK'
    const inserted = '1234567890';
    const shifted = [block(`${inserted}${content}`, 'doc-d1-b0')];
    const segments = buildStyledSegments(shifted[0]!.content, [a], [], shifted);
    const highlighted = segments.filter((s) => s.annotationIds.length);
    expect(highlighted.map((s) => s.text).join('')).toBe('IJK');

    // 高亮覆盖的必须**正是**新偏移 18~21
    let cursor = 0;
    let cover = '';
    for (const s of segments) {
      if (s.annotationIds.length) cover = `${cursor}-${cursor + s.text.length}`;
      cursor += s.text.length;
    }
    expect(cover).toBe('18-21');
    expect(shifted[0]!.content.slice(18, 21)).toBe('IJK');
  });

  it('新偏移处的文字被换掉 → 明确失锚，且原文一个字都不少', () => {
    const blocks = [block(content, 'doc-d1-b0')];
    const a = newAnn('d1', blocks, 'doc-d1-b0', 8, 11);
    const inserted = '1234567890';
    const renamed = [block(`${inserted}${content.replace('IJK', 'XYZ')}`, 'doc-d1-b0')];
    const segs = buildStyledSegments(renamed[0]!.content, [a], [], renamed);
    expect(segs.every((s) => s.annotationIds.length === 0)).toBe(true);
    expect(segs.map((s) => s.text).join('')).toBe(renamed[0]!.content);
  });

  it('失锚的批注被跳过，但**原文一个字都不少**', () => {
    const blocks = [block(content, 'doc-d1-b0')];
    const a = newAnn('d1', blocks, 'doc-d1-b0', 8, 11);
    const other = [block('完 全 不 相 干', 'doc-d1-b0')];
    const segments = buildStyledSegments(other[0]!.content, [a], [], other);
    expect(segments.map((s) => s.text).join('')).toBe('完 全 不 相 干');
    expect(segments.every((s) => s.annotationIds.length === 0)).toBe(true);
  });

  it('只给一段文本、不给块列表时（旧签名）行为不变', () => {
    const legacy = ann({ blockId: 'doc-d1-b0', anchor: makeAnchor(content, 2, 5) });
    const segments = buildStyledSegments(content, [legacy]);
    expect(segments.map((s) => s.text).join('')).toBe(content);
    expect(segments.find((s) => s.text === 'CDE')?.annotationIds).toEqual(['a1']);
  });
});
