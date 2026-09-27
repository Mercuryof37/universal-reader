import { describe, expect, it } from 'vitest';
import { decodeBuffer, hasReadableContent } from '@/lib/textEncoding';
import { TextParser } from '@/parsers/textParser';
import { MarkdownParser } from '@/parsers/markdownParser';

const encoder = new TextEncoder();

function fileFromBytes(name: string, bytes: Uint8Array): File {
  return {
    name,
    size: bytes.byteLength,
    text: async () => new TextDecoder('utf-8').decode(bytes),
    arrayBuffer: async () => bytes.buffer.slice(0) as ArrayBuffer,
  } as unknown as File;
}

function fileFromString(name: string, content: string): File {
  return fileFromBytes(name, encoder.encode(content));
}

/** 用 GBK 字节手工构造内容；这些字节取自 GBK 编码表的已知值 */
const GBK = {
  中: [0xd6, 0xd0],
  文: [0xce, 0xc4],
  测: [0xb2, 0xe2],
  试: [0xca, 0xd4],
  第: [0xb5, 0xda],
  一: [0xd2, 0xbb],
  章: [0xd5, 0xc2],
} as const;

function gbkBytes(text: string, asciiPart: string): Uint8Array {
  const out: number[] = [];
  for (const ch of asciiPart) out.push(ch.charCodeAt(0));
  for (const ch of text) {
    const pair = GBK[ch as keyof typeof GBK];
    if (pair) out.push(...pair);
  }
  return new Uint8Array(out);
}

describe('decodeBuffer', () => {
  it('识别 UTF-8 BOM 并剥离', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...encoder.encode('你好世界')]);
    const result = decodeBuffer(bytes.buffer as ArrayBuffer);
    expect(result.encoding).toBe('UTF-8 (BOM)');
    expect(result.text).toBe('你好世界');
    expect(result.lossy).toBe(false);
  });

  it('识别 UTF-16LE BOM', () => {
    const text = '你好世界';
    const bytes = new Uint8Array(2 + text.length * 2);
    bytes[0] = 0xff;
    bytes[1] = 0xfe;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      bytes[2 + i * 2] = code & 0xff;
      bytes[2 + i * 2 + 1] = code >> 8;
    }
    const result = decodeBuffer(bytes.buffer as ArrayBuffer);
    expect(result.encoding).toBe('UTF-16LE');
    expect(result.text).toBe(text);
  });

  it('无 BOM 的纯 UTF-8 文本正常解码且不误判编码', () => {
    const result = decodeBuffer(encoder.encode('这是 UTF-8 编码的中文文本。').buffer as ArrayBuffer);
    expect(result.encoding).toBe('UTF-8');
    expect(result.text).toContain('中文文本');
    expect(result.lossy).toBe(false);
  });

  it('GBK 字节被识别并正确解码（回归：中文 txt 打开后空白/乱码）', () => {
    const bytes = gbkBytes('中文测试', 'hello ');
    const result = decodeBuffer(bytes.buffer as ArrayBuffer);

    expect(result.encoding).toBe('GB18030 / GBK');
    expect(result.text).toBe('hello 中文测试');
    expect(result.lossy).toBe(false);
  });

  it('不支持的编码标签不会抛错，退回 UTF-8', () => {
    // 构造一段无效 UTF-8：解码器应产出替换字符而不是异常
    const result = decodeBuffer(new Uint8Array([0xff, 0xfe, 0x00, 0x01, 0x02, 0x03]).buffer as ArrayBuffer);
    expect(typeof result.text).toBe('string');
  });
});

describe('hasReadableContent', () => {
  it('全空白判为无内容', () => {
    expect(hasReadableContent('   \n\n\t  ')).toBe(false);
  });

  it('只有替换字符判为无内容', () => {
    expect(hasReadableContent('\uFFFD\uFFFD\uFFFD')).toBe(false);
  });

  it('有正常文字判为有内容', () => {
    expect(hasReadableContent('\n\n  正文  \n')).toBe(true);
  });
});

describe('TextParser 编码集成', () => {
  it('能解析 GBK 编码的 txt', async () => {
    const file = fileFromBytes('gbk.txt', gbkBytes('第一章', 'Chapter: '));
    const doc = await new TextParser().parse(file);

    expect(doc.blocks.length).toBeGreaterThan(0);
    expect(doc.blocks.map((b) => b.content).join(' ')).toContain('第一章');
    expect(doc.metadata.tags[0]).toContain('GB18030');
  });

  it('能解析 UTF-16LE 的 txt', async () => {
    const text = '第一段内容。\r\n\r\n第二段内容。';
    const bytes = new Uint8Array(2 + text.length * 2);
    bytes[0] = 0xff;
    bytes[1] = 0xfe;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      bytes[2 + i * 2] = code & 0xff;
      bytes[2 + i * 2 + 1] = code >> 8;
    }

    const doc = await new TextParser().parse(fileFromBytes('utf16.txt', bytes));
    expect(doc.blocks.map((b) => b.content).join(' ')).toContain('第二段内容');
  });

  it('真正的空文件抛出可读错误，而不是产出空文档', async () => {
    await expect(new TextParser().parse(fileFromString('empty.txt', ''))).rejects.toThrow(
      /没有可读文本/,
    );
  });

  it('只有空白字符的文件同样抛出可读错误', async () => {
    await expect(new TextParser().parse(fileFromString('blank.txt', '   \n\n  \t '))).rejects.toThrow(
      /没有可读文本/,
    );
  });

  it('正常 UTF-8 中文 txt 不受影响', async () => {
    const doc = await new TextParser().parse(
      fileFromString('ok.txt', '第一段。\n\n第二段。\n\n第三段。'),
    );
    expect(doc.blocks).toHaveLength(3);
    expect(doc.metadata.tags[0]).toBe('编码：UTF-8');
  });
});

describe('MarkdownParser 编码集成', () => {
  it('使用同一套编码识别逻辑', async () => {
    const bytes = gbkBytes('中文测试', '# ');
    const doc = await new MarkdownParser().parse(fileFromBytes('gbk.md', bytes));
    expect(doc.blocks[0]?.type).toBe('heading');
    expect(doc.blocks[0]?.content).toBe('中文测试');
  });
});
