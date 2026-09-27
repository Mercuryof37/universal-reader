/**
 * 合成 PDF 生成器（仅用于测试）。
 *
 * 为什么要在测试里手写 PDF 而不是放一个二进制样本文件：
 * 1. 二进制样本进仓库后无法 code review，出问题不知道哪一页坏；
 * 2. 手写可以精确构造边界情况（空白页、非 ASCII、多页、字号变化）；
 * 3. 生成逻辑本身就是对 PDF 结构的一次校验，能确认我们理解的位置信息是对的。
 *
 * 这里刻意只实现最小可用的子集：单字体、绝对定位文本、标准 xref 表。
 * 不实现压缩流——pdf.js 对未压缩内容的解析路径最直接，测试意图更清晰。
 */

export interface FakePdfLine {
  text: string;
  /** 距页面左边缘的点数 */
  x: number;
  /** 距页面下边缘的点数（PDF 坐标原点在左下角） */
  y: number;
  /** 字号，用于测试"大字号=标题"的启发式规则 */
  size?: number;
}

export interface FakePdfPage {
  lines: FakePdfLine[];
  /** 只放一个空内容流，用来模拟扫描件（无文字层） */
  blank?: boolean;
}

/** 生成一份合法的 PDF 字节流 */
export function buildPdf(pages: FakePdfPage[], opts: { title?: string; author?: string } = {}): Uint8Array {
  const objects: string[] = [];

  const pageCount = pages.length;
  // 对象编号规划：1=Catalog, 2=Pages, 3=Font, 4=Info, 之后每页两个（Page, Contents）
  const firstPageObj = 5;
  const kids = pages.map((_, i) => `${firstPageObj + i * 2} 0 R`).join(' ');

  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`;
  objects[3] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;
  objects[4] =
    `<< /Title (${escapePdfString(opts.title ?? 'Test Document')}) ` +
    `/Author (${escapePdfString(opts.author ?? 'Universal Reader Tests')}) ` +
    `/Producer (handmade test fixture) >>`;

  pages.forEach((page, i) => {
    const pageObjNum = firstPageObj + i * 2;
    const contentObjNum = pageObjNum + 1;

    const stream = page.blank ? '' : renderContentStream(page.lines);
    objects[pageObjNum] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObjNum} 0 R >>`;
    objects[contentObjNum] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });

  return assemble(objects);
}

/** 用文本操作符拼出页面内容流。BT/ET 包裹文本，Td 定位，Tj 显示 */
function renderContentStream(lines: FakePdfLine[]): string {
  const parts: string[] = [];
  for (const line of lines) {
    parts.push(`BT /F1 ${line.size ?? 12} Tf ${line.x} ${line.y} Td (${escapePdfString(line.text)}) Tj ET`);
  }
  return parts.join('\n');
}

/**
 * 转义 PDF 字符串字面量。
 *
 * 非 ASCII 字符会被转成 \ooo 八进制转义：PDF 的字符串字面量本质是字节串，
 * 我们只做"能不能被解析器读出来"的验证，不追求渲染正确性。
 */
function escapePdfString(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '\\' || ch === '(' || ch === ')') out += `\\${ch}`;
    else if (code < 32) out += `\\${code.toString(8).padStart(3, '0')}`;
    else if (code > 126) {
      // 拆成 UTF-8 字节再逐字节八进制转义
      for (const byte of new TextEncoder().encode(ch)) {
        out += `\\${byte.toString(8).padStart(3, '0')}`;
      }
    } else out += ch;
  }
  return out;
}

/** 拼装对象表、xref 表与 trailer，并计算正确的字节偏移 */
function assemble(objects: string[]): Uint8Array {
  const encoder = new TextEncoder();
  let body = '%PDF-1.4\n';

  const offsets: number[] = [];
  for (let i = 1; i < objects.length; i++) {
    const obj = objects[i];
    if (obj === undefined) continue;
    offsets[i] = encoder.encode(body).length;
    body += `${i} 0 obj\n${obj}\nendobj\n`;
  }

  const xrefOffset = encoder.encode(body).length;
  const maxObj = objects.length;

  let xref = `xref\n0 ${maxObj}\n0000000000 65535 f \n`;
  for (let i = 1; i < maxObj; i++) {
    const off = offsets[i] ?? 0;
    xref += `${off.toString().padStart(10, '0')} 00000 n \n`;
  }

  const trailer =
    `trailer\n<< /Size ${maxObj} /Root 1 0 R /Info 4 0 R >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;

  return encoder.encode(body + xref + trailer);
}
