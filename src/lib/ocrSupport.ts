/**
 * 扫描版 PDF 的 OCR 支持情况判定，以及不支持时给用户的建议。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么需要三条证据，而不是一条
 * ═══════════════════════════════════════════════════════════════
 *
 * 起因是一次很长的排查，最后靠用户一句「Firefox、Chrome、Edge 都能用，
 * 但 360 不行」才收束：那个浏览器内核过旧且被魔改，会在推理时
 * **把整个页面弄没**，不抛异常、不留日志。
 *
 * 只做能力检测是不够的 —— 第一版只查了 WebAssembly 与 SIMD，
 * 而 360 是基于 Chromium 的，**很可能这两项都通过**，
 * 于是检测返回「支持」、提示不出现、用户照样撞上崩溃。
 * 检测必须结合另外两条证据：
 *
 *   1. **能力**（WASM / SIMD）—— 缺了就一定不行，这是硬阻断；
 *   2. **已知的问题浏览器**（360 / QQ / 搜狗 等外壳浏览器）——
 *      它们普遍把内核停在很旧的版本上，还有「兼容模式」是 IE 内核；
 *   3. **上次是否真的崩过** —— 应用自己记录的诊断（页面被重载、
 *      且刷新不是应用发起的）。这是**本机实测事实**，比任何推断都硬。
 *
 * 三者相加才既不会漏报（像第一版那样），也不会把能用的环境误判成不能用。
 *
 * ⚠️ 诚实说明：第 2 条是**启发式**，靠 UA 里的厂商标记识别，UA 可以伪造，
 * 同一款外壳浏览器的不同模式内核也不同。所以它只用于**提醒**，
 * 不用于硬阻断 —— 硬阻断只给第 1 条（能力确实缺失）。
 */

/** 支持情况的三档 */
export type OcrSupportLevel =
  /** 未发现问题 */
  | 'ok'
  /** 疑似有问题：能试，但要先提醒（已知外壳浏览器 / 上次崩过） */
  | 'risky'
  /** 确定不可用：能力缺失，直接挡住 */
  | 'unsupported';

export interface OcrSupportDetails {
  wasm: boolean;
  simd: boolean;
  crossOriginIsolated: boolean;
}

export interface OcrSupport {
  level: OcrSupportLevel;
  /** 识别到的已知问题浏览器名（如「360 浏览器」）；没识别到则为 null */
  problemBrowser: string | null;
  /** 给用户看的原因；level 为 ok 时为空 */
  reason: string;
  /** 推荐使用的浏览器（任何非 ok 情况都给） */
  recommendation: string;
  details: OcrSupportDetails;
}

/**
 * 已知会把内核停在旧版本上的外壳浏览器。
 *
 * 匹配的是 UA 里的厂商标记。**这只是启发式**：UA 能被伪造，
 * 而且同一款浏览器的「极速模式」与「兼容模式」内核完全不同，
 * 所以命中后只是提醒，不是硬阻断。
 */
const PROBLEM_BROWSERS: { pattern: RegExp; name: string }[] = [
  { pattern: /QihooBrowser|QHBrowser|360SE|360EE|360Browser/i, name: '360 浏览器' },
  { pattern: /QQBrowser/i, name: 'QQ 浏览器' },
  { pattern: /MetaSr|Sogou|SE 2\.X/i, name: '搜狗浏览器' },
  { pattern: /LBBROWSER|LieBao/i, name: '猎豹浏览器' },
  { pattern: /2345Explorer|2345chrome/i, name: '2345 浏览器' },
  { pattern: /UBrowser|UCBrowser/i, name: 'UC 浏览器' },
  { pattern: /Maxthon/i, name: '傲游浏览器' },
  { pattern: /TheWorld/i, name: '世界之窗浏览器' },
  { pattern: /BIDUBrowser|baidubrowser/i, name: '百度浏览器' },
];

/** 识别 UA 里已知的问题浏览器；识别不到返回 null */
export function detectProblemBrowser(userAgent?: string): string | null {
  const ua = userAgent ?? (typeof navigator === 'undefined' ? '' : navigator.userAgent);
  if (!ua) return null;
  for (const { pattern, name } of PROBLEM_BROWSERS) {
    if (pattern.test(ua)) return name;
  }
  return null;
}

/** 推荐使用的浏览器文案（带版本基线，与本项目其它文档保持一致） */
export const BROWSER_RECOMMENDATION =
  '请改用 Chrome、Edge 或 Firefox 的较新版本打开本站（本项目验证过的基线是 ' +
  'Chrome / Edge 119+、Firefox 121+）。';

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

/** 上次识别是否「开始了但没走完」—— 由调用方从 sessionDiagnostics 传入 */
export interface OcrSupportInput {
  /** 上一次 OCR 是否被中断（页面被重载等） */
  hadInterruptedRun?: boolean;
  /** 该中断是否**不是**应用自身发起的刷新（即外部原因，如浏览器回收页面） */
  interruptedByExternal?: boolean;
  /** 覆盖 UA，便于测试 */
  userAgent?: string;
}

export function detectOcrSupport(input: OcrSupportInput = {}): OcrSupport {
  const problemBrowser = detectProblemBrowser(input.userAgent);

  // ── 第 1 条：能力。缺了就是硬阻断 ──────────────────────────
  if (typeof WebAssembly !== 'object' || typeof WebAssembly.instantiate !== 'function') {
    return {
      level: 'unsupported',
      problemBrowser,
      reason:
        '这个浏览器不支持 WebAssembly，无法在本机运行文字识别。' +
        (problemBrowser ? `（检测到你在使用${problemBrowser}，它的内核通常过旧。）` : ''),
      recommendation: BROWSER_RECOMMENDATION,
      details: { wasm: false, simd: false, crossOriginIsolated: false },
    };
  }

  const simd = detectSimd();
  const crossOriginIsolated =
    typeof globalThis.crossOriginIsolated === 'boolean' ? globalThis.crossOriginIsolated : false;
  const details: OcrSupportDetails = { wasm: true, simd, crossOriginIsolated };

  if (!simd) {
    return {
      level: 'unsupported',
      problemBrowser,
      reason:
        '这个浏览器的内核版本过旧：缺少 WebAssembly SIMD 支持，无法运行文字识别。' +
        (problemBrowser ? `检测到你在使用${problemBrowser}。` : '') +
        '国产外壳浏览器常把内核停在很旧的版本上，即使用「极速模式」也可能不支持；' +
        '「兼容模式」实际是 IE 内核，一定不支持。',
      recommendation: BROWSER_RECOMMENDATION,
      details,
    };
  }

  // ── 第 3 条（最硬的证据）：上次真的崩过 ────────────────────
  // 能力都通过却仍然中断，且刷新不是应用发起的 —— 这是本机实测事实。
  if (input.hadInterruptedRun && input.interruptedByExternal) {
    return {
      level: 'risky',
      problemBrowser,
      reason:
        '上一次识别没有跑完，而且页面是被浏览器自己中断的（不是本应用发起的刷新）。' +
        '这种情况通常意味着当前浏览器无法稳定运行本功能' +
        (problemBrowser ? `，检测到你正在使用${problemBrowser}。` : '。') +
        '你可以再试一次；如果反复中断，请换浏览器。',
      recommendation: BROWSER_RECOMMENDATION,
      details,
    };
  }

  // ── 第 2 条：已知的问题浏览器（启发式，只提醒）─────────────
  if (problemBrowser) {
    return {
      level: 'risky',
      problemBrowser,
      reason:
        `检测到你在使用${problemBrowser}。这类外壳浏览器的内核通常明显落后于主线版本` +
        '（本项目验证过的基线是 Chrome / Edge 119+、Firefox 121+），' +
        '识别过程中可能被浏览器中断，且不会给出任何错误提示。' +
        '如果识别失败或中途中断，请换用下面的浏览器重试。',
      recommendation: BROWSER_RECOMMENDATION,
      details,
    };
  }

  return {
    level: 'ok',
    problemBrowser: null,
    reason: '',
    recommendation: '',
    details,
  };
}

/** 一行式的环境摘要，便于记进诊断轨迹 */
export function describeOcrSupport(input: OcrSupportInput = {}): string {
  const s = detectOcrSupport(input);
  const parts = [`wasm=${s.details.wasm ? '是' : '否'}`, `simd=${s.details.simd ? '是' : '否'}`];
  if (s.problemBrowser) parts.push(`浏览器=${s.problemBrowser}`);
  return `${s.level}（${parts.join('，')}）`;
}
