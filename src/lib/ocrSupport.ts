/**
 * 扫描版 PDF 的 OCR 需要哪些浏览器能力，以及当前环境是否具备。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么要有这个检查
 * ═══════════════════════════════════════════════════════════════
 *
 * 一位用户报告：扫描版 PDF 识别时**页面直接消失、没有任何报错**，
 * 应用自带的三条刷新路径都没有记录。查了很多轮之后才问出来：
 *
 *   「Firefox、Chrome、Microsoft Edge 都可以正常使用，但是 360 不行」
 *
 * 也就是说**应用本身是好的，问题在那个浏览器的内核**。
 * 这类国产浏览器普遍把 Chromium 内核停在很旧的版本上（本项目的基线是
 * Chrome/Edge 119+），还常带「兼容模式」（其实是 IE 内核）以及各种注入模块。
 * ONNX Runtime 的 WASM 运行时落在这种环境里会被直接终止 ——
 * 表现为进程消失，而不是抛异常。
 *
 * 教训是：**与其在崩溃后一路排查，不如在开始前就把不支持的环境认出来。**
 * 所以这里做**能力检测**（而不是嗅探 User-Agent —— UA 可以随便改，
 * 而且同一款浏览器的不同模式内核完全不同），
 * 检测不过就在界面上直接说清楚，并给出可执行的建议。
 *
 * 检测项与理由：
 *   · `WebAssembly`  —— 没有它整个 OCR 无从谈起；
 *   · WASM **SIMD**  —— ONNX Runtime Web 用的是 simd 构建，
 *     内核太旧时实例化会失败乃至终止进程；
 *   · 跨源隔离（COOP/COEP）—— 只影响多线程；我们是单线程，
 *     所以**只记录、不作判定**，避免把能用的环境误判成不能用。
 */

export interface OcrSupportDetails {
  wasm: boolean;
  simd: boolean;
  crossOriginIsolated: boolean;
}

export interface OcrSupport {
  ok: boolean;
  /** 不支持时的原因（可直接显示给用户） */
  reason?: string;
  details: OcrSupportDetails;
}

/**
 * 最小的、只在支持 SIMD 时才通过校验的 WASM 模块。
 *
 * 取自社区通用的特性检测写法：类型段声明返回 `v128`，
 * 代码段用 `i8x16.splat`（`0xfd 0x0f`）。不支持 SIMD 的内核
 * 会在 `WebAssembly.validate` 阶段就返回 false，而不会执行任何东西。
 */
const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15,
  253, 98, 11,
]);

function detectSimd(): boolean {
  try {
    return (
      typeof WebAssembly === 'object' &&
      typeof WebAssembly.validate === 'function' &&
      WebAssembly.validate(SIMD_PROBE)
    );
  } catch {
    return false;
  }
}

export function detectOcrSupport(): OcrSupport {
  if (typeof WebAssembly !== 'object' || typeof WebAssembly.instantiate !== 'function') {
    return {
      ok: false,
      reason:
        '这个浏览器不支持 WebAssembly，无法在本机运行文字识别。\n' +
        '请改用 Chrome、Edge 或 Firefox 打开本站；文字版 PDF 与 Markdown / TXT / EPUB 不受影响。',
      details: { wasm: false, simd: false, crossOriginIsolated: false },
    };
  }

  const simd = detectSimd();
  const crossOriginIsolated =
    typeof globalThis.crossOriginIsolated === 'boolean' ? globalThis.crossOriginIsolated : false;

  if (!simd) {
    return {
      ok: false,
      reason:
        '这个浏览器的内核版本过旧（缺少 WebAssembly SIMD 支持），无法运行文字识别。\n' +
        '国产浏览器（如 360、QQ、搜狗等）常把内核停在很旧的版本上，' +
        '即使用「极速模式」也可能不支持；「兼容模式」则是 IE 内核，肯定不支持。\n' +
        '请改用 Chrome、Edge 或 Firefox 打开本站；文字版 PDF 与 Markdown / TXT / EPUB 不受影响。',
      details: { wasm: true, simd, crossOriginIsolated },
    };
  }

  return { ok: true, details: { wasm: true, simd, crossOriginIsolated } };
}

/** 一行式的环境摘要，便于记进诊断轨迹 */
export function describeOcrSupport(): string {
  const s = detectOcrSupport();
  const parts = [`wasm=${s.details.wasm ? '是' : '否'}`, `simd=${s.details.simd ? '是' : '否'}`];
  return `${s.ok ? '支持' : '不支持'}（${parts.join('，')}）`;
}
