/**
 * 运行时兼容层。
 *
 * ═══════════════════════════════════════════════════════════════
 * pdf.js 5.7.284 依赖的新 ES API 全量清单（实测扫描其产物得到）
 * ═══════════════════════════════════════════════════════════════
 *
 * | API                                  | worker | 主包 | 本文件是否补齐 | 缺失时的报错 |
 * |--------------------------------------|-------:|-----:|:--------------:|--------------|
 * | `Uint8Array.prototype.toHex`         |   2 处 |    — | ✅             | `a.toHex is not a function` |
 * | `Uint8Array.prototype.toBase64`      |     — | 2 处 | ✅             | 同类 |
 * | `Promise.withResolvers`              |  14 处 | 26 处| ✅             | 难以定位的 TypeError |
 * | `Map.prototype.getOrInsertComputed`  |   8 处 | 11 处| ✅             | `this[#methodPromises].getOrInsertComputed is not a function` |
 * | `Array.prototype.at`                 |  44 处 | 13 处| ✅             | `x.at is not a function` |
 * | `Object.hasOwn`                      |  20 处 |  2 处| ✅             | `Object.hasOwn is not a function` |
 * | `Float16Array`                       |   7 处 |  7 处| ➖ 不需要       | 已被 pdf.js 特性检测，回退 Float32Array |
 * | `structuredClone`                    |     — |  4 处| ➖ 不需要       | Chrome 98+ 已有 |
 * | `URL.parse`                          |   3 处 |  8 处| ➖ 不需要       | Chrome 126+ 已有 |
 *
 * **扫描方法**（升级 pdf.js 后应重新执行一次）：
 *
 * ```powershell
 * $t = Get-Content node_modules\pdfjs-dist\build\pdf.worker.mjs -Raw
 * foreach ($p in 'withResolvers','getOrInsertComputed','\.toHex\(','\.toBase64\(','Object\.hasOwn','Float16Array') {
 *   "{0,-24} {1}" -f $p, ([regex]::Matches($t, $p)).Count
 * }
 * ```
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么这些补齐必须写两遍（主线程 + Worker）
 * ═══════════════════════════════════════════════════════════════
 *
 * Worker 拥有独立的全局对象与原型链，主线程打的补丁它**完全看不到**。
 * 而 pdf.js 的核心解析跑在 Worker 里（`parsers/pdfWorkerEntry.ts`），
 * 因此那个入口也 import 了本文件。
 *
 * 这个坑踩了三次：`toHex`（PDF 完全无法导入）、`withResolvers`、
 * `getOrInsertComputed`（OCR 阶段）。前两次都以为补在主线程就够了 ——
 * 本地测试全绿，因为 Node 与主线程恰好都有原生实现，
 * **唯独真正需要它的那个 worker 没有**。
 *
 * 结论：补齐代码必须在**每一个执行它的 JS 上下文**里安装。
 */

/** Promise.withResolvers：返回 promise 及配套的 resolve / reject */
function installPromiseWithResolvers(): void {
  // 用方括号访问是刻意的：lib 里没有这个成员（ES2024 才加入），
  // 属性访问写法会被 TS 直接判为编译错误。
  const P = Promise as unknown as Record<string, unknown>;
  if (typeof P['withResolvers'] === 'function') return;

  P['withResolvers'] = function withResolvers<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

/** Array.prototype.at：ES2022，Safari 15.4 以下缺失 */
function installArrayAt(): void {
  if (typeof Array.prototype.at === 'function') return;
  Object.defineProperty(Array.prototype, 'at', {
    value: function at<T>(this: T[], index: number): T | undefined {
      const len = this.length;
      const i = Math.trunc(index) || 0;
      const k = i >= 0 ? i : len + i;
      return k < 0 || k >= len ? undefined : this[k];
    },
    writable: true,
    configurable: true,
  });
}

/**
 * Map / WeakMap 的 upsert 方法：TC39 提案，Chrome 140 之前不存在。
 *
 * 这是第三个真实线上故障的来源：pdf.js 用 `getOrInsertComputed` 做
 * "取不到就现算一个放进去"的分组统计，缺失时报
 * `this[#methodPromises].getOrInsertComputed is not a function`
 * （私有字段名 + 压缩变量名，完全看不出是谁的问题）。
 *
 * 语义严格按 tc39/proposal-upsert：
 * - `getOrInsert(key, value)`：键存在返回旧值，否则插入 value 并返回它；
 * - `getOrInsertComputed(key, callback)`：同上，但值由 callback(key) 惰性计算，
 *   且 callback 只在键不存在时调用一次。
 *
 * 两个方法都补上：虽然当前 pdf.js 只用到 Computed 版本，
 * 但它们同属一个提案、通常一起使用，只补一半会在下次升级时再踩一次。
 */
function installMapUpsert(): void {
  const mapProto = Map.prototype as unknown as Record<string, unknown>;
  const weakMapProto = WeakMap.prototype as unknown as Record<string, unknown>;

  for (const proto of [mapProto, weakMapProto]) {
    proto['getOrInsert'] ??= function getOrInsert(
      this: Map<unknown, unknown>,
      key: unknown,
      value: unknown,
    ) {
      if (this.has(key)) return this.get(key);
      this.set(key, value);
      return value;
    };

    proto['getOrInsertComputed'] ??= function getOrInsertComputed(
      this: Map<unknown, unknown>,
      key: unknown,
      callback: (key: unknown) => unknown,
    ) {
      if (this.has(key)) return this.get(key);
      // 关键：仅在键不存在时调用 callback，且只调用一次
      const value = callback(key);
      this.set(key, value);
      return value;
    };
  }
}

/** Object.hasOwn：ES2022 */
function installObjectHasOwn(): void {
  const O = Object as unknown as { hasOwn?: (o: object, k: PropertyKey) => boolean };
  if (typeof O.hasOwn === 'function') return;
  O.hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * Uint8Array 的十六进制与 Base64 转换：ES2025 / ES2026 提案，尚未全面可用。
 *
 * 这是第二个真实线上故障的来源：
 * pdf.js 在计算文档指纹时调用 `calculateMD5(...).toHex()`，
 * 而指纹是**每一份 PDF 都会走**的必经路径（见 worker 里的 fingerprints getter）。
 * 缺失时的报错是 `a.toHex is not a function` —— 压缩后的变量名让人完全看不出
 * 问题出在哪个 API 上。
 *
 * 实现严格按 tc39/proposal-arraybuffer-base64 的语义：
 * - toHex 小写、无分隔符；
 * - fromHex 跳过 ASCII 空白，遇到非法字符抛 SyntaxError；
 * - toBase64 默认标准字母表（含 + / 与 = 填充）；
 * - fromBase64 兼容标准与 URL-safe 字母表（忽略 - _），同样跳过空白。
 */
const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function installUint8ArrayConversions(): void {
  const proto = Uint8Array.prototype as unknown as Record<string, unknown>;
  const ctor = Uint8Array as unknown as Record<string, unknown>;

  proto['toHex'] ??= function toHex(this: Uint8Array): string {
    let out = '';
    for (let i = 0; i < this.length; i++) {
      out += (this[i] ?? 0).toString(16).padStart(2, '0');
    }
    return out;
  };

  ctor['fromHex'] ??= function fromHex(input: string): Uint8Array {
    const cleaned = input.replace(/[\t\n\f\r ]/g, '');
    if (cleaned.length % 2 !== 0) {
      throw new SyntaxError('fromHex: 十六进制字符串长度必须为偶数');
    }
    const out = new Uint8Array(cleaned.length / 2);
    for (let i = 0; i < out.length; i++) {
      const byte = Number.parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
      if (Number.isNaN(byte)) {
        throw new SyntaxError(`fromHex: 第 ${i * 2} 个字符不是合法的十六进制数字`);
      }
      out[i] = byte;
    }
    return out;
  };

  proto['toBase64'] ??= function toBase64(this: Uint8Array): string {
    let out = '';
    for (let i = 0; i < this.length; i += 3) {
      const b0 = this[i] ?? 0;
      const b1 = this[i + 1];
      const b2 = this[i + 2];
      out += BASE64_CHARS[b0 >> 2];
      out += BASE64_CHARS[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
      out += b1 === undefined ? '=' : BASE64_CHARS[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
      out += b2 === undefined ? '=' : BASE64_CHARS[b2 & 0x3f];
    }
    return out;
  };

  ctor['fromBase64'] ??= function fromBase64(input: string): Uint8Array {
    const cleaned = input.replace(/[\t\n\f\r ]/g, '').replace(/=+$/, '');
    const bytes: number[] = [];
    let buffer = 0;
    let bits = 0;

    for (const ch of cleaned) {
      // URL-safe 字母表：- 与 _ 分别等价于 + 与 /
      const normalized = ch === '-' ? '+' : ch === '_' ? '/' : ch;
      const value = BASE64_CHARS.indexOf(normalized);
      if (value === -1) throw new SyntaxError(`fromBase64: 非法字符 "${ch}"`);

      buffer = (buffer << 6) | value;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        bytes.push((buffer >> bits) & 0xff);
      }
    }

    return new Uint8Array(bytes);
  };
}

/**
 * 探测 PDF 解析所需的关键能力。
 * 在导入 PDF 之前调用，能在能力不足时给出人话提示，
 * 而不是把一个 TypeError 直接抛到用户脸上。
 */
export function checkPdfSupport(): { ok: true } | { ok: false; reason: string } {
  const g = globalThis as unknown as Record<string, unknown>;
  const uint8Proto = (g['Uint8Array'] as { prototype: Record<string, unknown> } | undefined)
    ?.prototype;
  const promise = g['Promise'] as Record<string, unknown> | undefined;
  const mapProto = (g['Map'] as { prototype: Record<string, unknown> } | undefined)?.prototype;

  // pdf.js 5.7 在几条必经路径上依赖很新的 API（实测扫描其产物得到）：
  //   pdf.worker.mjs: withResolvers ×14 · getOrInsertComputed ×8 · toHex ×2
  //   pdf.mjs:        withResolvers ×26 · getOrInsertComputed ×11 · toBase64 ×2
  // 缺失时报的都是压缩后的信息（`a.toHex is not a function`、
  // `this[#methodPromises].getOrInsertComputed is not a function`），完全看不出根因，
  // 因此这里提前探测并点名。
  // 正常情况下总是通过 —— installRuntimePolyfills() 已在入口与 worker 入口处补齐。
  const missing: string[] = [];
  if (typeof promise?.['withResolvers'] !== 'function') missing.push('Promise.withResolvers');
  if (typeof uint8Proto?.['toHex'] !== 'function') missing.push('Uint8Array.toHex');
  if (typeof mapProto?.['getOrInsertComputed'] !== 'function') missing.push('Map.getOrInsertComputed');

  if (missing.length) {
    return {
      ok: false,
      reason: `PDF 解析库所需的 ${missing.join(' 与 ')} 不可用，请升级浏览器。`,
    };
  }
  return { ok: true };
}

let installed = false;

/** 幂等安装；重复调用没有副作用 */
export function installRuntimePolyfills(): void {
  if (installed) return;
  installed = true;

  installPromiseWithResolvers();
  installUint8ArrayConversions();
  installMapUpsert();
  installArrayAt();
  installObjectHasOwn();
}

/**
 * 仅供测试使用：让下一次 installRuntimePolyfills() 真正重新执行。
 *
 * 为什么需要它：安装是一次性的（模块级 installed 标记），
 * 而测试需要"先删除原生实现，再验证补齐逻辑生效"这个顺序。
 * 生产代码不要调用。
 */
export function __resetRuntimePolyfillsForTests(): void {
  installed = false;
}

installRuntimePolyfills();
