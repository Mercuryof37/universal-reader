import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 「文字层只是残渣」的判定规则。
 *
 * ═══════════════════════════════════════════════════════════════
 * 这组测试对应一个真实的用户问题
 * ═══════════════════════════════════════════════════════════════
 *
 * 用户导入一份习题 PDF，反馈"为什么只识别出了标题"。
 *
 * 查证结果是：那份 PDF 共 1 页、6 道题全是图片，文字层只有标题
 * 「概率论与数理统计习题5」和页脚的「单周周一下午2点前交作业」，
 * 合计 23 字、6 处图像绘制指令。
 *
 * 解析器如实提取了这 23 字 —— **它没坏，是那份 PDF 的内容不在文字层里**。
 * 但原实现的判断只有 `if (!textCharCount) 抛扫描件错误`，即
 * **只看"有没有文字"，不看"文字够不够"**。23 个字足以绕过检查，
 * 于是既不提示是图片型 PDF、也不提供 OCR，
 * 用户只能自己猜为什么内容不全。
 *
 * 下面把修好后的规则钉死：**两个条件必须同时成立**。
 */

// 阈值与 pdfParser.ts 保持一致（不 import 是因为它们是模块私有常量，
// 这里显式复制一份并注明来源，改动时必须同步）
const MIN_CHARS_PER_PAGE = 50;
const MIN_IMAGES_PER_PAGE = 3;

/** 复刻 pdfParser 里的判定逻辑，用于验证阈值行为 */
function isTextLayerResidue(totalChars: number, totalImages: number, pages: number): boolean {
  const charsPerPage = totalChars / Math.max(1, pages);
  const imagesPerPage = totalImages / Math.max(1, pages);
  return charsPerPage < MIN_CHARS_PER_PAGE && imagesPerPage >= MIN_IMAGES_PER_PAGE;
}

describe('文字层是残渣的判定', () => {
  it('真实故障样本：23 字 + 6 图 / 1 页 → 判定为图片型', () => {
    // 这就是用户那份习题 PDF 的实际数据
    expect(isTextLayerResidue(23, 6, 1)).toBe(true);
  });

  it('多页同型文档：每页都是"标题 + 一堆题目截图"', () => {
    // 10 页，每页 20 字 + 5 图
    expect(isTextLayerResidue(200, 50, 10)).toBe(true);
  });

  it('正常正文页不受影响（文字多）', () => {
    // 一页 A4 正文约 800~1500 字，哪怕配了插图也不该误判
    expect(isTextLayerResidue(900, 4, 1)).toBe(false);
    expect(isTextLayerResidue(8000, 40, 10)).toBe(false);
  });

  it('图文并茂的教材不受影响（图片多但文字也多）', () => {
    // 每页 600 字 + 5 张插图 —— 单看"图片多"会误伤，必须同时看文字量
    expect(isTextLayerResidue(6000, 50, 10)).toBe(false);
  });

  it('文字很少但没有图片的文档不受影响（如只有两行字的封面）', () => {
    // 单看"文字少"会误伤，必须同时看图片量
    expect(isTextLayerResidue(30, 0, 1)).toBe(false);
  });

  it('纯文字极少的扫描件（无图片指令但无文字）走另一条分支', () => {
    // textCharCount 为 0 时由 `!textCharCount` 分支处理，
    // 与本规则无关 —— 两者是或的关系
    expect(isTextLayerResidue(0, 0, 5)).toBe(false);
  });

  it('边界：恰好等于阈值时不判定为残渣', () => {
    // 用的是严格小于 / 大于等于，边界处偏向"不打扰用户"
    expect(isTextLayerResidue(50, 3, 1)).toBe(false); // 字数正好 50 → 不算残渣
    expect(isTextLayerResidue(49, 3, 1)).toBe(true);
    expect(isTextLayerResidue(49, 2, 1)).toBe(false); // 图片不够 → 不算
  });

  it('空文档不因除零而崩溃', () => {
    expect(isTextLayerResidue(0, 0, 0)).toBe(false);
  });
});

describe('判定所依赖的常量本身', () => {
  it('阈值必须与 pdfParser.ts 中的实际取值一致', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'parsers', 'pdfParser.ts'), 'utf8');

    // 这两个常量若被改动而测试没同步，上面的用例就变成自说自话。
    // 这里直接读源码核对，确保测试跟随实现。
    expect(source).toContain(`const MIN_CHARS_PER_PAGE = ${MIN_CHARS_PER_PAGE};`);
    expect(source).toContain(`const MIN_IMAGES_PER_PAGE = ${MIN_IMAGES_PER_PAGE};`);
  });

  it('图像统计必须用 display intent（否则 Form XObject 里的图片数不到）', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'parsers', 'pdfParser.ts'), 'utf8');

    // 默认的 'print' intent 不展开 Form XObject 内部指令，
    // 而扫描件与题目截图恰恰把图片放在 Form XObject 里 ——
    // 用默认参数会得出"这页没有图片"的错误结论
    expect(source).toContain("getOperatorList({ intent: 'display' })");
  });
});
