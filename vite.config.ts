import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
    // 不解析符号链接的真实路径。
    // 作用有二：pnpm 的符号链接结构下启动更快；同时避免 Vite 在 Windows 上
    // 调用 net use 探测网络驱动器（该子进程在受限环境中会被拒绝执行）。
    preserveSymlinks: true,
  },
  // pdf.js 5.x 使用顶层 await 与较新的语法，构建目标需跟上
  build: {
    target: 'es2022',
    /**
     * 关闭 sourcemap。
     *
     * 本地调试开着的价值有限，而代价很实在：实测 dist 总计 11.34 MB，
     * 其中 .map 占 7.56 MB —— 关掉后只剩 3.77 MB。
     *
     * 部署到公开站点时它还有第二重问题：sourcemap 会把完整源码一并发布。
     * 需要对线上错误做符号化时，正确做法是把 .map 上传到错误监控平台
     * （如 Sentry），而不是随站点发布。
     */
    sourcemap: false,
    // 单包体积大到一定程度就该显式拆包。这里只做兜底：
    // 真正有效的瘦身手段是让 PDF / EPUB 解析器走动态 import（见 src/parsers/index.ts），
    // 拆包只能改善缓存命中率，不能减少首次加载量。
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'vendor-react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
            { name: 'vendor-text', test: /node_modules[\\/](unified|remark|micromark|mdast|unist|vfile|zwitch|bail|trough|devlop|character-entities|decode-named-character-reference|property-information|space-separated-tokens|comma-separated-tokens|hast|html-void-elements|ccount|escape-string-regexp|markdown-table|longest-streak|is-plain-obj|trim-lines|web-namespaces)[\\/]/ },
          ],
        },
      },
    },
  },
  optimizeDeps: {
    include: ['tesseract.js'],
  },
  worker: {
    format: 'es',
  },
  server: {
    port: 5173,
  },
});
