/**
 * 生成 PWA 图标。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么不直接用现成的图标生成工具
 * ═══════════════════════════════════════════════════════════════
 *
 * PWA 需要 192×192 与 512×512 两个尺寸的 PNG。
 * 常见做法是引入 `sharp` 或 `@vite-pwa/assets-generator`，
 * 但它们会带来几十兆的原生依赖，而本项目只需要**两张纯色几何图形**。
 *
 * 因此这里只用 Node 内置的 `zlib` 手写一个最小 PNG 编码器：
 * 依赖为零、输出确定、将来改配色只需改几个常量。
 *
 * PNG 的结构其实很简单，依次是：
 *   magic(8B) + IHDR + IDAT + IEND，每段都是 长度+类型+数据+CRC32
 * 其中 IDAT 是 zlib 压缩后的"每行前面加一个 filter 字节"的原始像素。
 *
 * 由 `npm run icons` 调用，也可作为 prebuild 的一部分显式执行。
 * 产物入库（icons/ 目录），因为它们是设计资产而非构建产物。
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public', 'icons');

// ── 配色：与阅读器的「宣纸 / 夜读」主题呼应 ──
const BG = [0x2b, 0x26, 0x20]; // 深墨色底（--reader-fg）
const FG = [0xd8, 0xa6, 0x6a]; // 暖金：封面轮廓
const PAGE = [0xf2, 0xe8, 0xd5]; // 米白：内页（与阅读器「宣纸」主题同色）

/**
 * 生成 192/512 的常规图标，以及 512 的 maskable 版本
 *
 * ═══════════════════════════════════════════════════════════════
 * 图标设计经过四次返工，每一次都是"生成完必须看图"才发现的
 * ═══════════════════════════════════════════════════════════════
 *
 * | 版本 | 画法 | 渲染结果 |
 * |---|---|---|
 * | 1 | U 形外框 + 中缝，竖边只画下半段 | 上方大片空白，完全不像书 |
 * | 2 | 实心书体 + 居中 7% 细缝 | 两根并排的柱子 |
 * | 3 | 加一条 6% 宽的左侧装订脊 | 仍是柱子 —— 细脊与中缝在缩放后糊成一片 |
 * | 4 | **金色封面轮廓 + 米白内页 + 中缝** | ✅ 读得出是"一本翻开的书" |
 *
 * 前三版的共同错误是**想靠细线传达信息**：6~7% 宽的线在 512px 下只有约 30px，
 * 到浏览器标签页的 16~32px 就彻底消失。第四版改用**色块对比**：
 * 轮廓勾出外形，浅色内页填充内容区 —— 缩到很小仍能分辨。
 *
 * 教训：**图标是纯视觉产物，不看渲染结果就无法判断对错。**
 * 前三版我都是"脚本执行成功"就以为完成了。
 */
const TARGETS = [
  { size: 192, file: 'icon-192.png', pad: 0.12 },
  { size: 512, file: 'icon-512.png', pad: 0.12 },
  // maskable 图标会被系统裁成圆形/圆角，安全区只有中间约 80%，
  // 因此把图形缩小、留出更多边距，避免被裁掉笔画
  { size: 512, file: 'icon-maskable-512.png', pad: 0.26 },
];

/**
 * 画一个"翻开的书"轮廓。
 *
 * 用像素级判定而不是引入绘图库：图形简单（一个 U 形外框 + 中缝），
 * 直接在归一化坐标里判断点落在哪条线上即可，不需要抗锯齿也能看清。
 */
function renderIcon(size, pad) {
  const rgba = Buffer.alloc(size * size * 4);
  const inset = size * pad;
  const box = size - inset * 2;
  // 线宽随尺寸缩放，保证 192 与 512 视觉一致

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // 归一化到 [0,1]，以图形区域为基准
      const u = (x - inset) / box;
      const v = (y - inset) / box;

      const color = bookColorAt(u, v);
      const i = (y * size + x) * 4;
      rgba[i] = color[0];
      rgba[i + 1] = color[1];
      rgba[i + 2] = color[2];
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

/**
 * 返回某个归一化坐标处的颜色。
 *
 * 图形自外向内分三层，靠**色块**而不是细线区分：
 *   1. 封面轮廓（暖金）：书的边界
 *   2. 内页（米白）：内容区域，左右两页
 *   3. 中缝（暖金）：两页之间的书脊
 */
function bookColorAt(u, v) {
  const left = 0.10;
  const right = 0.90;
  const top = 0.16;
  const bottom = 0.84;

  // 书体之外 → 背景
  if (u < left || u > right || v < top || v > bottom) return BG;

  // 封面轮廓的厚度：占书宽的 9%，缩到 32px 时仍有约 3px 可见
  const border = 0.09;
  const innerLeft = left + border;
  const innerRight = right - border;
  const innerTop = top + border * 1.4; // 顶部（书口）稍厚，视觉上更像书的封面翻边
  const innerBottom = bottom - border;

  // 中缝：两页之间的书脊，宽度与边框相当，保证缩放后不消失
  const spineHalf = border * 0.55;
  if (Math.abs(u - 0.5) < spineHalf) return FG;

  const insidePage =
    u >= innerLeft && u <= innerRight && v >= innerTop && v <= innerBottom;

  return insidePage ? PAGE : FG;
}

// ══════════════════════════════════════════════════════════════
// 最小 PNG 编码器
// ══════════════════════════════════════════════════════════════

function encodePng(width, height, rgba) {
  // 每行前面加一个 filter 字节。用 0（None）而不是更省的 Paeth：
  // 纯色图形的 deflate 压缩率已经很好，省下的那点体积不值得多写几十行。
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // 颜色类型 6 = RGBA
  ihdr[10] = 0; // 压缩方法
  ihdr[11] = 0; // 滤波方法
  ihdr[12] = 0; // 隔行扫描

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data]);

  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);

  return Buffer.concat([length, typeAndData, crc]);
}

/** CRC-32（PNG 规范规定的那张表） */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// ══════════════════════════════════════════════════════════════
// 主流程 —— 必须放在文件末尾
// ══════════════════════════════════════════════════════════════
// ES 模块会先执行所有顶层语句、再执行导入。
// 若把这段放在 CRC_TABLE 的 const 声明之前，就会撞上"暂时性死区"
// （ReferenceError: Cannot access 'CRC_TABLE' before initialization）。

mkdirSync(outDir, { recursive: true });

for (const { size, file, pad } of TARGETS) {
  writeFileSync(join(outDir, file), encodePng(size, size, renderIcon(size, pad)));
  console.log(`[make-icons] ${file}  ${size}×${size}`);
}
