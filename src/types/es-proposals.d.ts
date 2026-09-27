/**
 * 为尚未进入 TypeScript 标准库的 ES 提案 API 提供类型声明。
 *
 * 这些 API 由 `src/lib/polyfills.ts` 在运行时补齐，TypeScript 5.9 的 lib
 * 还没有它们，因此这里手工声明。
 *
 * ⚠️ 关键：补齐只对**执行它的那个 JS 上下文**有效。
 * Web Worker 拥有独立的全局对象与原型链，主线程打的补丁在 worker 内部不可见。
 * 这正是 pdf.js 曾连续三次报 `a.toHex is not a function` 的原因 ——
 * `toHex` 只在 worker 文件里被调用，而补齐代码跑在主线程。
 * 因此 pdf.js 现在被刻意安排在主线程运行（见 `src/parsers/pdfRuntime.ts`）。
 *
 * 与 `declare global` 配套的 `export {}` 是必须的：
 * 没有它，文件会被当成全局脚本，声明会污染全局作用域而不是做模块增强。
 *
 * 参考：tc39/proposal-arraybuffer-base64、tc39/proposal-promise-with-resolvers
 */

export {};

declare global {
  interface Uint8Array {
    /** 转小写十六进制字符串（ES2026 提案） */
    toHex(): string;
    /** 转 Base64 字符串（ES2026 提案） */
    toBase64(options?: { alphabet?: 'base64' | 'base64url'; omitPadding?: boolean }): string;
  }

  interface Uint8ArrayConstructor {
    /** 从十六进制字符串还原字节（ES2026 提案） */
    fromHex(input: string): Uint8Array;
    /** 从 Base64 字符串还原字节（ES2026 提案） */
    fromBase64(input: string, options?: { alphabet?: 'base64' | 'base64url' }): Uint8Array;
  }

  interface PromiseConstructor {
    /** 返回 promise 及配套的 resolve / reject（ES2024） */
    withResolvers<T>(): {
      promise: Promise<T>;
      resolve: (value: T | PromiseLike<T>) => void;
      reject: (reason?: unknown) => void;
    };
  }

  interface Map<K, V> {
    /** 键不存在时插入并返回值（TC39 upsert 提案） */
    getOrInsert(key: K, value: V): V;
    /** 键不存在时用 callback(key) 计算值并插入（TC39 upsert 提案） */
    getOrInsertComputed(key: K, callback: (key: K) => V): V;
  }

  interface WeakMap<K extends WeakKey, V> {
    getOrInsert(key: K, value: V): V;
    getOrInsertComputed(key: K, callback: (key: K) => V): V;
  }
}
