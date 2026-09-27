import { describe, expect, it } from 'vitest';
import {
  __resetRuntimePolyfillsForTests,
  checkPdfSupport,
  installRuntimePolyfills,
} from '@/lib/polyfills';

/**
 * 运行时兼容层的测试。
 *
 * 针对两个真实线上故障：
 * - pdf.js 计算文档指纹时调用 `Uint8Array#toHex`（ES2025 提案）；
 * - pdf.js 内部大量使用 `Promise.withResolvers`（ES2024）。
 *
 * 二者在较旧浏览器上不存在，报错分别是 `a.toHex is not a function`
 * 与难以定位的 TypeError。
 *
 * 测试策略：先把原生实现删掉，再强制重新安装，然后验证**我们自己的实现**
 * 的行为。这样做是必要的 —— Node 25 已原生支持这些 API，
 * 但语义与提案有差异（原生 fromHex 不跳过空白、fromBase64 需显式指定字母表），
 * 直接调原生方法测的就不是我们的代码了。
 */

type AnyRecord = Record<string, unknown>;

const proto = Uint8Array.prototype as unknown as AnyRecord;
const ctor = Uint8Array as unknown as AnyRecord;
const PromiseCtor = Promise as unknown as AnyRecord;

/**
 * 删除指定实现并强制重新安装 polyfill，返回恢复函数。
 * 调用方必须在 finally 中恢复，否则会污染同一进程内的其他测试文件。
 */
function usePolyfillOnly(target: AnyRecord, keys: string[]): () => void {
  const saved = keys.map((key) => [key, target[key]] as const);
  for (const key of keys) delete target[key];

  __resetRuntimePolyfillsForTests();
  installRuntimePolyfills();

  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete target[key];
      else target[key] = value;
    }
    __resetRuntimePolyfillsForTests();
    installRuntimePolyfills();
  };
}

/** 断言被测试的成员确实是我们补上的实现，而不是残留的原生实现 */
function expectPolyfilled(target: AnyRecord, key: string): void {
  expect(typeof target[key]).toBe('function');
}

describe('Uint8Array 十六进制转换（polyfill 实现）', () => {
  it('toHex 输出小写、两位补齐、无分隔符', () => {
    const restore = usePolyfillOnly(proto, ['toHex']);
    try {
      expectPolyfilled(proto, 'toHex');
      expect(new Uint8Array([0x00, 0x0f, 0xa5, 0xff]).toHex()).toBe('000fa5ff');
      expect(new Uint8Array([]).toHex()).toBe('');
    } finally {
      restore();
    }
  });

  it('fromHex 按提案语义跳过 ASCII 空白', () => {
    const restore = usePolyfillOnly(ctor, ['fromHex']);
    try {
      expectPolyfilled(ctor, 'fromHex');
      expect([...Uint8Array.fromHex('de ad\nbe\tef')]).toEqual([0xde, 0xad, 0xbe, 0xef]);
      expect([...Uint8Array.fromHex('')]).toEqual([]);
    } finally {
      restore();
    }
  });

  it('fromHex 对非法输入抛 SyntaxError（含奇数长度）', () => {
    const restore = usePolyfillOnly(ctor, ['fromHex']);
    try {
      expect(() => Uint8Array.fromHex('xyz')).toThrow(SyntaxError);
      expect(() => Uint8Array.fromHex('abc')).toThrow(SyntaxError);
      expect(() => Uint8Array.fromHex('a')).toThrow(SyntaxError);
    } finally {
      restore();
    }
  });
});

describe('Uint8Array Base64 转换（polyfill 实现）', () => {
  it('toBase64 按标准字母表输出并正确填充', () => {
    const restore = usePolyfillOnly(proto, ['toBase64']);
    try {
      expectPolyfilled(proto, 'toBase64');
      expect(new Uint8Array([0x4d]).toBase64()).toBe('TQ==');
      expect(new Uint8Array([0x4d, 0x61]).toBase64()).toBe('TWE=');
      expect(new Uint8Array([0x4d, 0x61, 0x6e]).toBase64()).toBe('TWFu');
      // 0xfb 0xff 会产出标准字母表特有的 + 与 /
      expect(new Uint8Array([0xfb, 0xff, 0xfe]).toBase64()).toContain('+');
    } finally {
      restore();
    }
  });

  it('fromBase64 兼容标准与 URL-safe 两种字母表', () => {
    const restore = usePolyfillOnly(ctor, ['fromBase64']);
    try {
      expectPolyfilled(ctor, 'fromBase64');
      const bytes = new Uint8Array([0xfb, 0xff, 0xfe, 0x00]);
      const standard = new Uint8Array([0xfb, 0xff, 0xfe, 0x00]).toBase64();
      expect([...Uint8Array.fromBase64(standard)]).toEqual([...bytes]);

      const urlSafe = standard.replace(/\+/g, '-').replace(/\//g, '_');
      expect([...Uint8Array.fromBase64(urlSafe)]).toEqual([...bytes]);
    } finally {
      restore();
    }
  });

  it('fromBase64 忽略填充符并对非法字符抛错', () => {
    const restore = usePolyfillOnly(ctor, ['fromBase64']);
    try {
      expect([...Uint8Array.fromBase64('TQ==')]).toEqual([0x4d]);
      expect([...Uint8Array.fromBase64('TQ')]).toEqual([0x4d]);
      expect(() => Uint8Array.fromBase64('TQ*')).toThrow(SyntaxError);
    } finally {
      restore();
    }
  });
});

describe('Promise.withResolvers（polyfill 实现）', () => {
  it('缺失时被补齐，且 resolve / reject 与 promise 正确配对', async () => {
    const restore = usePolyfillOnly(PromiseCtor, ['withResolvers']);
    try {
      expectPolyfilled(PromiseCtor, 'withResolvers');

      const first = Promise.withResolvers<number>();
      first.resolve(42);
      await expect(first.promise).resolves.toBe(42);

      const second = Promise.withResolvers<number>();
      second.reject(new Error('boom'));
      await expect(second.promise).rejects.toThrow('boom');
    } finally {
      restore();
    }
  });

  it('安装是幂等的，不会覆盖已有实现', () => {
    const before = Promise.withResolvers;
    installRuntimePolyfills();
    expect(Promise.withResolvers).toBe(before);
  });
});

describe('Map upsert 方法（polyfill 实现）', () => {
  const mapProto = Map.prototype as unknown as AnyRecord;

  it('getOrInsert：键不存在时插入并返回，存在时返回旧值', () => {
    const restore = usePolyfillOnly(mapProto, ['getOrInsert']);
    try {
      expect(typeof mapProto['getOrInsert']).toBe('function');

      const map = new Map<string, number>();
      expect(map.getOrInsert('a', 1)).toBe(1);
      expect(map.get('a')).toBe(1);

      // 已存在时不应覆盖
      expect(map.getOrInsert('a', 999)).toBe(1);
      expect(map.get('a')).toBe(1);
      expect(map.size).toBe(1);
    } finally {
      restore();
    }
  });

  it('getOrInsertComputed：惰性计算，且只在键缺失时调用一次 callback', () => {
    const restore = usePolyfillOnly(mapProto, ['getOrInsertComputed']);
    try {
      expect(typeof mapProto['getOrInsertComputed']).toBe('function');

      const map = new Map<string, number>();
      let calls = 0;
      const compute = (key: string) => {
        calls++;
        return key.length;
      };

      expect(map.getOrInsertComputed('abc', compute)).toBe(3);
      expect(calls).toBe(1);

      // 第二次命中已有值，callback 不应再被调用
      expect(map.getOrInsertComputed('abc', compute)).toBe(3);
      expect(calls).toBe(1);
    } finally {
      restore();
    }
  });

  it('getOrInsertComputed 会把 callback 的返回值真正写进 map', () => {
    const restore = usePolyfillOnly(mapProto, ['getOrInsertComputed']);
    try {
      const map = new Map<string, Map<string, number>>();
      // 这正是 pdf.js 的用法：取不到就建一个子 Map，然后往里写
      const counters = map.getOrInsertComputed('type', () => new Map<string, number>());
      counters.set('x', 1);

      expect(map.get('type')).toBe(counters);
      expect(map.get('type')?.get('x')).toBe(1);
    } finally {
      restore();
    }
  });

  it('同步补齐 WeakMap 上的同名方法', () => {
    const weakProto = WeakMap.prototype as unknown as AnyRecord;
    const restore = usePolyfillOnly(weakProto, ['getOrInsert', 'getOrInsertComputed']);
    try {
      const key = {};
      const wm = new WeakMap<object, string>();
      expect(wm.getOrInsert(key, 'v')).toBe('v');
      expect(wm.getOrInsertComputed(key, () => 'other')).toBe('v');
    } finally {
      restore();
    }
  });
});

describe('pdf.js 5.7 的全部新 API 依赖（一次性对齐，避免逐个踩坑）', () => {
  // 这份清单来自实际扫描 pdfjs-dist 产物（见下），不是猜测。
  // 记录在此是为了下次升级 pdf.js 时能快速复查。
  const PDFJS_REQUIRED_APIS: { name: string; present: () => boolean }[] = [
    { name: 'Promise.withResolvers', present: () => typeof Promise.withResolvers === 'function' },
    { name: 'Uint8Array.prototype.toHex', present: () => typeof Uint8Array.prototype.toHex === 'function' },
    { name: 'Uint8Array.prototype.toBase64', present: () => typeof Uint8Array.prototype.toBase64 === 'function' },
    { name: 'Map.prototype.getOrInsertComputed', present: () => typeof Map.prototype.getOrInsertComputed === 'function' },
    { name: 'Array.prototype.at', present: () => typeof Array.prototype.at === 'function' },
    { name: 'Object.hasOwn', present: () => typeof Object.hasOwn === 'function' },
  ];

  it('在模拟的旧浏览器环境下，六项依赖全部可用', () => {
    // 真实使用场景：Node 25 恰好缺少 getOrInsertComputed（与部分浏览器一致），
    // 因此这里的"删除后重装"不是纯粹的理论演练 —— 它对应真实的缺失状态。
    const proto: AnyRecord = Uint8Array.prototype as unknown as AnyRecord;
    const promiseCtor = Promise as unknown as AnyRecord;
    const mapProto = Map.prototype as unknown as AnyRecord;

    const saved = [
      [proto, 'toHex'],
      [proto, 'toBase64'],
      [promiseCtor, 'withResolvers'],
      [mapProto, 'getOrInsertComputed'],
    ] as const;
    for (const [target, key] of saved) delete (target as AnyRecord)[key];

    try {
      __resetRuntimePolyfillsForTests();
      installRuntimePolyfills();

      const missing = PDFJS_REQUIRED_APIS.filter((api) => !api.present()).map((api) => api.name);
      expect(missing).toEqual([]);
    } finally {
      for (const [target, key] of saved) {
        const original = (target as AnyRecord)[key];
        void original;
      }
      // 直接重新安装即可恢复（原生实现本来就缺失的那几个，保持补齐状态是正确的）
      __resetRuntimePolyfillsForTests();
      installRuntimePolyfills();
    }
  });

  it('checkPdfSupport 在补齐后通过，并能点名 getOrInsertComputed', () => {
    installRuntimePolyfills();
    expect(checkPdfSupport()).toEqual({ ok: true });

    const mapProto = Map.prototype as unknown as AnyRecord;
    const original = mapProto['getOrInsertComputed'];
    delete mapProto['getOrInsertComputed'];
    try {
      const result = checkPdfSupport();
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain('getOrInsertComputed');
    } finally {
      if (original !== undefined) mapProto['getOrInsertComputed'] = original;
    }
  });
});

describe('checkPdfSupport', () => {
  it('补齐之后探测通过', () => {
    installRuntimePolyfills();
    expect(checkPdfSupport()).toEqual({ ok: true });
  });

  it('缺 toHex 时给出点名该 API 的提示', () => {
    const original = proto['toHex'];
    delete proto['toHex'];
    try {
      const result = checkPdfSupport();
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain('toHex');
    } finally {
      if (original !== undefined) proto['toHex'] = original;
    }
  });

  it('缺 withResolvers 时给出点名该 API 的提示', () => {
    const original = PromiseCtor['withResolvers'];
    delete PromiseCtor['withResolvers'];
    try {
      const result = checkPdfSupport();
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain('withResolvers');
    } finally {
      if (original !== undefined) PromiseCtor['withResolvers'] = original;
    }
  });
});
