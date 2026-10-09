import katex from 'katex';

/**
 * 用 KaTeX 渲染 LaTeX 公式为 HTML 字符串。
 *
 * 正文块与目录标题共用同一份实现：目录里的 `$\epsilon - N$` 必须和正文
 * 渲染出同一个符号，否则两处对不上会让用户以为漏字。
 * throwOnError: false —— 坏公式退化成红色源码展示，而不是整块渲染失败。
 */
export function renderMath(tex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(tex, {
      displayMode,
      throwOnError: false,
      strict: false,
      trust: true,
    });
  } catch {
    return `<code>${tex}</code>`;
  }
}
