import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  /**
   * 与 `vite.config.ts` 保持一致：注入构建标识。
   *
   * 少了它，`__BUILD_ID__` 在测试里就是 undefined，而
   * `sessionDiagnostics` 的「按版本隔离崩溃记忆」逻辑会因此整段失效 ——
   * 表现是相关断言莫名其妙地不成立（写这条时正是如此）。
   * 测试里用固定值即可：我们验的是「版本不同就作废」这个逻辑，
   * 不需要它是真实时间戳。
   */
  define: {
    __BUILD_ID__: JSON.stringify('test-build'),
  },
  resolve: {
    alias: [
      // pdf.js 默认构建依赖浏览器专有 API（DOMMatrix 等），在 Node 里会直接抛
      // ReferenceError。测试环境改用官方提供的 legacy 构建。
      // 注意：这条 alias 只影响测试；浏览器仍然用标准构建（见 src/parsers/pdfWorker.ts）。
      { find: /^pdfjs-dist$/, replacement: 'pdfjs-dist/legacy/build/pdf.mjs' },
      { find: /^@\/(.*)$/, replacement: fileURLToPath(new URL('./src/$1', import.meta.url)) },
    ],
    // 与 vite.config.ts 保持一致：避免 Windows 下的真实路径探测子进程
    preserveSymlinks: true,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
