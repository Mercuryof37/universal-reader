import { describe, expect, it } from 'vitest';
import {
  buildToc,
  detectLanguage,
  makeAnchor,
  resolveAnchor,
  splitForSpeech,
  titleFromFileName,
} from '@/lib/utils';
import type { ContentBlock } from '@/types/content';
import { buildSegments } from '@/lib/annotations';

function block(content: string, id = 'b0'): ContentBlock {
  return { id, type: 'paragraph', content, translations: {}, metadata: {} };
}

describe('resolveAnchor', () => {
  const text = '清晨的雨幕笼罩着整座城市，街灯在积水里碎成一片光。';

  it('原位精确匹配', () => {
    const anchor = makeAnchor(text, 3, 7);
    expect(resolveAnchor(anchor, text)).toEqual({ start: 3, end: 7 });
  });

  it('段落前被插入文字后仍能通过原文搜索找到', () => {
    const anchor = makeAnchor(text, 3, 7);
    const shifted = `（新增编者按）${text}`;
    const resolved = resolveAnchor(anchor, shifted);
    expect(resolved).not.toBeNull();
    expect(shifted.slice(resolved!.start, resolved!.end)).toBe(text.slice(3, 7));
  });

  it('原文小幅改动后通过前后缀指纹定位', () => {
    const anchor = makeAnchor(text, 5, 9);
    const edited = text.replace('笼罩着', '笼罩住');
    const resolved = resolveAnchor(anchor, edited);
    // 原选区文字已不存在，允许定位到近似区间，但不能是 null
    expect(resolved).not.toBeNull();
  });

  it('完全找不到时返回 null 而不是抛错', () => {
    const anchor = makeAnchor(text, 0, 4);
    expect(resolveAnchor(anchor, '完全不相干的一段文字')).toBeNull();
  });

  it('无锚点或空选区返回 null', () => {
    expect(resolveAnchor(undefined, text)).toBeNull();
    expect(resolveAnchor(makeAnchor(text, 0, 0), text)).toBeNull();
  });
});

describe('buildSegments', () => {
  const text = 'ABCDEFGHIJ';

  it('无批注时返回单个片段且内容不变', () => {
    const segments = buildSegments(text, []);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.text).toBe(text);
  });

  it('切分后拼接必须严格等于原文', () => {
    const ann = {
      id: 'a1',
      docId: 'd',
      blockId: 'b0',
      type: 'highlight' as const,
      color: 'amber' as const,
      tags: [],
      anchor: makeAnchor(text, 2, 5),
      createdAt: '',
      updatedAt: '',
    };
    const segments = buildSegments(text, [ann]);
    expect(segments.map((s) => s.text).join('')).toBe(text);
    expect(segments.find((s) => s.color === 'amber')?.text).toBe('CDE');
  });

  it('重叠批注不丢字、不重复', () => {
    const mk = (id: string, start: number, end: number, color: 'amber' | 'sky') => ({
      id,
      docId: 'd',
      blockId: 'b0',
      type: 'highlight' as const,
      color,
      tags: [],
      anchor: makeAnchor(text, start, end),
      createdAt: '',
      updatedAt: '',
    });
    const segments = buildSegments(text, [mk('a1', 1, 6, 'amber'), mk('a2', 4, 8, 'sky')]);
    expect(segments.map((s) => s.text).join('')).toBe(text);
    const overlap = segments.find((s) => s.text === 'EF');
    expect(overlap?.annotationIds).toEqual(['a1', 'a2']);
  });
});

describe('splitForSpeech', () => {
  it('短文本不切分', () => {
    expect(splitForSpeech('你好世界')).toEqual(['你好世界']);
  });

  it('长文本按句末标点切分且不丢内容', () => {
    const long = '这是第一句话。这是第二句话！这是第三句话？'.repeat(20);
    const chunks = splitForSpeech(long, 60);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toBe(long);
    expect(chunks.every((c) => c.length <= 60)).toBe(true);
  });
});

describe('buildToc', () => {
  it('只收录 heading 并保留层级', () => {
    const blocks: ContentBlock[] = [
      { ...block('# 第一章'), type: 'heading', metadata: { level: 1 } },
      block('正文'),
      { ...block('小节'), type: 'heading', metadata: { level: 2 } },
    ];
    const toc = buildToc(blocks);
    expect(toc).toHaveLength(2);
    expect(toc[0]?.level).toBe(1);
    expect(toc[1]?.title).toBe('小节');
  });
});

describe('detectLanguage', () => {
  it('识别中文与英文', () => {
    expect(detectLanguage('这是一段足够长的中文文本，用于语言探测。')).toBe('zh');
    expect(detectLanguage('This is a long enough English sentence for detection.')).toBe('en');
  });

  it('识别日文假名', () => {
    expect(detectLanguage('これはにほんごのぶんしょうです。ひらがながたくさんあります。')).toBe('ja');
  });
});

describe('titleFromFileName', () => {
  it('去掉扩展名并把下划线转成空格', () => {
    expect(titleFromFileName('my_note-v2.md')).toBe('my note v2');
  });
});
