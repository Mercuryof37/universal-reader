/**
 * 错误诊断工具。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么需要这个文件
 * ═══════════════════════════════════════════════════════════════
 *
 * 真实故障：OCR 识别失败时，界面上只显示
 *
 *     OCR 识别失败：undefined
 *
 * 信息量为零。根因不是"错误是 undefined"，而是**捕获方假设了错误一定是 Error**：
 *
 *     catch (err) {
 *       set({ error: `OCR 识别失败：${(err as Error).message}` });   // ← 丢信息
 *     }
 *
 * JavaScript 里 `throw` 可以抛出**任何值**：字符串、数字、Symbol、普通对象、
 * 甚至 `undefined` 本身。第三方库（尤其是 Worker 与 WASM 相关的库）
 * 并不总是遵循"抛 Error"的惯例，它们常常 reject 一个自定义对象或干脆是空值。
 *
 * 一旦调用方写 `(err as Error).message`，就会得到 `undefined` ——
 * 既不知道是什么错了，也无从排查。
 *
 * 本文件解决两件事：
 * 1. **永不丢信息** —— 任何抛出值都能转成有内容、可复制上报的文本；
 * 2. **记录原始值** —— 同时写进控制台，保留完整的堆栈与对象结构。
 */

/**
 * 把任意抛出值转成**保证非空**的可读描述。
 *
 * 覆盖的边界情况：
 * - `Error` / 子类（含 `DOMException`、自定义错误类）→ 用 message
 * - `Symbol` → `String(sym)`（注意 `sym + ''` 会抛 TypeError）
 * - 字符串 / 数字 / 布尔 → 直接字符串化
 * - 普通对象 → JSON 序列化，失败则退回 `Object.prototype.toString`
 * - `null` / `undefined` → 明确写出来，而不是留空
 * - `Object.create(null)`（无原型）→ 不会因为读 `.message` 而崩
 *
 * @returns 一定非空的描述文本
 */
export function describeUnknownError(value: unknown): string {
  if (value === undefined) return 'undefined（抛出方未提供任何错误信息）';
  if (value === null) return 'null（抛出方提供了空值）';

  if (value instanceof Error) {
    // 部分库会把 message 设为空串，此时退回 name，再退回构造名
    return value.message || value.name || value.constructor?.name || 'Error（无消息）';
  }

  const type = typeof value;
  if (type === 'string') {
    const text = value as string;
    return text.length > 0 ? text : '(空字符串)';
  }
  if (type === 'number' || type === 'boolean' || type === 'bigint') return String(value);
  if (type === 'symbol') {
    // 关键：不能写成 `value + ''`，那对 Symbol 会抛 TypeError
    return String(value);
  }
  if (type === 'function') {
    return `[function ${(value as { name?: string }).name || 'anonymous'}]`;
  }

  // 对象：优先 JSON，退化到安全摘要
  try {
    const json = JSON.stringify(value);
    if (json && json !== '{}') return json;
  } catch {
    // 循环引用或含 BigInt 时会抛错。
    // 关键：不能就此放弃 —— 只列键名会把值全丢掉（"name: loop" 变成看不见的 name）。
    // 改为逐字段安全提取，遇到嵌套对象/循环就跳过。
    const summary = summarizePlainObject(value);
    if (summary) return summary;
  }

  try {
    const tag = Object.prototype.toString.call(value);
    const keys = Object.keys(value as object);
    return keys.length ? `${tag} 键=[${keys.join(', ')}]` : tag;
  } catch {
    return '[无法描述的对象]';
  }
}

/**
 * 逐字段安全摘出一个普通对象的内容。
 *
 * 只收录**原始类型**的字段值（字符串 / 数字 / 布尔 / null），
 * 遇到嵌套对象、数组或循环引用就跳过 —— 因此**不可能无限递归**。
 * 这正是循环引用场景下仍能保住有用信息的原因。
 */
function summarizePlainObject(value: object): string {
  const MAX_FIELDS = 8;
  const MAX_TEXT = 120;
  const parts: string[] = [];

  let keys: string[];
  try {
    keys = Object.keys(value);
  } catch {
    return '';
  }

  for (const key of keys) {
    if (parts.length >= MAX_FIELDS) {
      parts.push('…');
      break;
    }
    let field: unknown;
    try {
      field = (value as Record<string, unknown>)[key];
    } catch {
      continue; // getter 抛错
    }

    const type = typeof field;
    if (field === null) {
      parts.push(`${key}=null`);
    } else if (type === 'string') {
      const text = field as string;
      parts.push(`${key}=${text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text}`);
    } else if (type === 'number' || type === 'boolean' || type === 'bigint') {
      parts.push(`${key}=${String(field)}`);
    }
    // 其余类型（对象 / 数组 / 函数 / symbol）一律跳过，避免递归与噪音
  }

  if (!parts.length) return '';
  const tag = Object.prototype.toString.call(value);
  return `${tag} { ${parts.join(', ')} }`;
}

/**
 * 构造可直接展示给用户、也可直接复制上报的错误文本。
 *
 * @param context 这个错误发生在哪一步（例如 `识别第 3 页（共 100 页）`）
 * @param error   原始抛出值，原样保留
 */
export function errorReport(context: string, error: unknown): string {
  const description = describeUnknownError(error);
  const stack = error instanceof Error && error.stack ? `\n\n堆栈：\n${error.stack}` : '';
  return `${context}\n\n${description}${stack}`;
}

/**
 * 把任意抛出值记进控制台**并返回**它。
 *
 * 用在 catch 里既想保留原始值、又想留下日志的场景：
 *
 * ```ts
 * } catch (err) {
 *   throw logAndRethrow('第 3 页渲染失败', err);
 * }
 * ```
 */
export function logAndRethrow(context: string, error: unknown): Error {
  // 用 console.error 传原始对象而不是字符串：浏览器控制台才能展开它的结构
  console.error(`[${context}]`, error);
  return new Error(errorReport(context, error));
}
