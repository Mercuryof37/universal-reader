import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    /**
     * PWA：让网站离线可用、可安装到桌面。
     *
     * ═══════════════════════════════════════════════════════════
     * 为什么这件事对本项目格外重要
     * ═══════════════════════════════════════════════════════════
     *
     * 项目的核心约束之一是「离线可用」，但在此之前它只在
     * 「页面已经加载」的前提下成立 —— 断网后连 index.html 都拿不到，
     * 已导入的书自然也读不了（文档在 IndexedDB 里，但页面进不去）。
     *
     * Service Worker 补上了这一环：预缓存页面骨架，离线时直接由缓存响应。
     *
     * 缓存策略的分工：
     * - **预缓存**（precache）：构建产物里的入口 chunk、样式、图标。
     *   这些是「能打开页面」的最小集合，必须离线可用。
     * - **运行时缓存**（runtimeCaching）：pdfjs 的 WASM 解码器与
     *   tesseract 的语言包。它们的体积大（合计约 25MB）、按需下载，
     *   不适合预缓存，用 CacheFirst 让「用过一次之后离线也能用」。
     */
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: null,
      includeAssets: ['icons/*.png'],

      manifest: {
        name: '通用文档阅读器',
        short_name: '文档阅读器',
        description:
          '导入 Markdown / TXT / PDF / EPUB，双语对照阅读、语音朗读与批注。文档全程留在本机浏览器，不上传服务器。',
        lang: 'zh-CN',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        background_color: '#2b2620',
        theme_color: '#2b2620',
        categories: ['productivity', 'books', 'utilities'],
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/icons/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },

      workbox: {
        // 只预缓存应用真正会用到的解码器。
        //
        // copy-pdfjs-wasm.mjs 会把 pdfjs-dist/wasm/ 整个目录复制过来，
        // 但其中三样东西本项目永远不会请求：
        //   quickjs-eval.wasm / quickjs-eval.js —— pdf.js 的 JS 沙箱求值特性
        //   *_nowasm_fallback.js —— 浏览器不支持 WASM 时的纯 JS 兜底
        // 合计约 1MB。预缓存它们会让首访的安装体积白白翻倍。
        globIgnores: [
          '**/pdfjs-wasm/quickjs-eval*',
          '**/pdfjs-wasm/*_nowasm_fallback.js',
          '**/ort-wasm*',
        ],

        // 单文件预缓存上限。pdfWorkerEntry 有 1.15MB，默认的 2MB 够用，
        // 但放宽到 5MB 以免将来拆分变化时静默漏掉关键资源
        // （workbox 对超限文件只打警告、不报错，很容易被忽略）
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,

        // 导航请求走预缓存的 index.html —— 这是「离线也能打开网站」的关键
        navigateFallback: '/index.html',
        // 不把 Worker 的 API 请求当成导航请求处理
        navigateFallbackDenylist: [/^\/api\//],

        // 构建后立刻接管，避免用户第一次访问时 SW 还在等待
        clientsClaim: true,
        skipWaiting: true,

        cleanupOutdatedCaches: true,

        runtimeCaching: [
          {
            // pdf.js 的 WASM 解码器（jbig2 / openjpeg / qcms）
            // 扫描版 PDF 依赖它们，缺失时页面会渲染成白页且不报错
            urlPattern: /\/pdfjs-wasm\/.*\.(wasm|js)$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'pdfjs-wasm',
              expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // PaddleOCR 模型文件（从 HuggingFace CDN 下载，约 10MB）
            urlPattern: /^https:\/\/huggingface\.co\/.*/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'ocr-models',
              expiration: { maxEntries: 30, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // ONNX Runtime WASM 文件（约 28MB），首次 OCR 时按需加载
            urlPattern: /\/ort-wasm.*\.(wasm|js|mjs)$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'onnx-wasm',
              expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },

      devOptions: {
        // 开发环境不启用 SW：它会缓存模块导致改动看不到，
        // 是「明明改了代码却没生效」的经典来源
        enabled: false,
      },
    }),
  ],
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
    exclude: ['ppu-paddle-ocr', 'ppu-ocv', 'onnxruntime-web'],
  },
  worker: {
    format: 'es',
  },
  server: {
    port: 5173,
  },
});
