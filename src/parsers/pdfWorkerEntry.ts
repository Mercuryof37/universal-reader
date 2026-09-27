/**
 * pdf.js Worker 的入口文件。
 *
 * ═══════════════════════════════════════════════════════════════
 * 这个文件只做一件关键的事：**在 pdf.js 之前安装 API 补齐**
 * ═══════════════════════════════════════════════════════════════
 *
 * Worker 拥有独立的 JavaScript 上下文（独立的全局对象与原型链）。
 * 主线程对 `Uint8Array.prototype` 打的补丁，**worker 内部完全看不到**。
 *
 * 而 pdf.js 计算文档指纹时调用 `Uint8Array#toHex`（ES2025 提案，
 * Chrome 119 之前不存在），它只出现在 worker 代码里 ——
 * 这正是 `a.toHex is not a function` 反复出现的根因。
 *
 * 本项目的解法不是"让 pdf.js 跑在主线程"（那会失去 worker 的性能优势），
 * 也不是"往 pdf.js 内部注入补丁"（依赖内部结构，跨版本极易失效），
 * 而是**提供自己的 worker 入口，把补齐放在 pdf.js 之前** ——
 * import 顺序即执行顺序，结构上就不可能出错。
 *
 * 本文件没有 export：它是一个纯粹的副作用入口，由主线程用
 * `new Worker(url, { type: 'module' })` 创建。pdf.js 的 worker 代码本身
 * 会自行建立消息监听、与主线程通信，这里的 import 就足以让它开始工作。
 */

// ⚠️ 顺序不可调整：补齐必须在 pdf.js 的 worker 代码之前执行。
import '@/lib/polyfills';
import 'pdfjs-dist/build/pdf.worker.min.mjs';
