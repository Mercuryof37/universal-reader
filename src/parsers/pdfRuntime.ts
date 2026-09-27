/**
 * pdf.js 运行时配置。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么需要这个文件（一段三次踩坑的历史）
 * ═══════════════════════════════════════════════════════════════
 *
 * pdf.js 5 依赖两个很新的 ES API：
 * - `Uint8Array.prototype.toHex`（ES2025 提案，Chrome 119 之前不存在）
 * - `Promise.withResolvers`（ES2024）
 *
 * 它们由 `lib/polyfills.ts` 补齐。但补齐**只对执行它的那个 JS 上下文有效** ——
 * 而 `toHex` 只在 pdf.js 的 worker 代码里被调用，主线程的补丁它看不到。
 * 于是出现"本地测试全绿、线上照旧报 `a.toHex is not a function`"。
 *
 * 期间试过并否决的方案：
 * - ❌ 只在主线程补 API：worker 看不到，无效。
 * - ❌ 让 pdf.js 跑在主线程（不设 workerSrc）：pdf.js 5 **不会**自动退回主线程，
 *      而是直接抛 `No "GlobalWorkerOptions.workerSrc" specified`。
 * - ❌ 给 `workerSrc` 指向 pdf.js 自带的 worker 文件：那个文件内部没有补齐，
 *      依然会在 worker 里报 `toHex`。
 * - ✅ **提供自己的 worker 入口（`pdfWorkerEntry.ts`），在 pdf.js 之前执行补齐。**
 *      import 顺序即执行顺序，结构上不可能出错，且保留了 worker 的性能优势。
 *
 * 创建 Worker 的方式用 Vite 的 `?worker&url`：拿到可自行实例化的 URL，
 * 而不是让 Vite 直接生成实例（后者无法传入我们需要的选项、也不便缓存复用）。
 */

import * as pdfjsLib from 'pdfjs-dist';
import { installRuntimePolyfills } from '@/lib/polyfills';
import workerUrl from '@/parsers/pdfWorkerEntry.ts?worker&url';

// 主线程也补齐一次（幂等）：pdf.js 主线程侧同样会用到 Promise.withResolvers。
// 注意这只解决主线程，worker 内的补齐由 pdfWorkerEntry.ts 负责。
installRuntimePolyfills();

/** 是否运行在测试环境（vitest 走 Node + legacy 构建，无真正的 Worker） */
const isTestEnv = import.meta.env.MODE === 'test';

/**
 * WASM 解码器目录。
 *
 * pdf.js **不会**自动找到自己包里的 WASM 解码器，必须显式提供路径，
 * 否则解码 JBIG2 / JPEG2000 图像时抛
 * `Ensure that the wasmUrl API parameter is provided.`
 *
 * 这两种编码是扫描版 PDF 最常用的：本项目的实测样本里有
 * 833 处 JBIG2Decode + 384 处 JPXDecode，即**每一页都需要解码器**。
 *
 * 失败表现极具误导性 —— 不报错，页面只是渲染成一片空白，
 * 然后被"空白页跳过"逻辑全部跳过，最终报"什么都没识别到"。
 *
 * 文件由 `scripts/copy-pdfjs-wasm.mjs` 从 pdfjs-dist 复制到 public/，
 * 因此产物自带解码器、无需联网（本项目的定位是离线可用）。
 */
const WASM_URL = `${import.meta.env.BASE_URL}pdfjs-wasm/`;

/**
 * Worker 实例按需创建并全局复用。
 *
 * 为什么不每次解析都新建：Worker 启动需要加载并初始化整个 pdf.js 解析器
 * （约 1.2MB），每次导入都重建会明显拖慢连续导入多个文件的体验。
 * 一个 pdf.js worker 可以承载多个文档的解析请求（它内部按 docId 区分）。
 */
let sharedWorker: Worker | null = null;

function getSharedWorker(): Worker {
  sharedWorker ??= new Worker(workerUrl, {
    type: 'module',
    // 与源文件同源，显式声明避免某些环境下被当成跨域脚本
    name: 'pdfjs-worker',
  });
  return sharedWorker;
}

/**
 * 构造传给 `getDocument` 的参数。
 *
 * 浏览器里通过 `PDFWorker.create({ port })` 传入我们自己的 worker 实例
 * （v5 的工厂方法是 `create`，不是旧版的 `fromPort`）；
 * 测试环境（Node）没有真 Worker，走 legacy 构建的伪 worker 分支。
 */
export function createPdfDocumentParams(buffer: ArrayBuffer): Record<string, unknown> {
  if (isTestEnv) {
    return { data: buffer, verbosity: 0 };
  }

  return {
    data: buffer,
    // 复用缓存的 worker 实例
    worker: pdfjsLib.PDFWorker.create({ port: getSharedWorker() }),
    // 解析在 worker 内进行，资源获取也交给 worker 的 fetch
    useWorkerFetch: true,
    // JBIG2 / JPEG2000 解码器路径 —— 扫描版 PDF 缺它会导致整本渲染成白页
    wasmUrl: WASM_URL,
    verbosity: 0,
  };
}

/** 供诊断与测试断言使用：当前是否使用独立的 Worker 上下文 */
export const PDF_RUNTIME_MODE: 'worker' | 'test' = isTestEnv ? 'test' : 'worker';

/**
 * 释放共享 Worker。
 * 正常使用无需调用；主要供测试与页面卸载时清理。
 */
export function disposeSharedPdfWorker(): void {
  sharedWorker?.terminate();
  sharedWorker = null;
}

export { pdfjsLib };
