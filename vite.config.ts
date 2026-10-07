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
     * - **运行时缓存**（runtimeCaching）：pdfjs 的 WASM 解码器、
     *   PaddleOCR 的模型与 ONNX Runtime WASM。它们的体积大（合计数十 MB）、
     *   按需下载，不适合预缓存，用 CacheFirst 让「用过一次之后离线也能用」。
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

        /**
         * ⚠️ 刻意**不设** navigateFallback
         *
         * ═══════════════════════════════════════════════════════════
         * 这是「Failed to fetch dynamically imported module」的真因
         * ═══════════════════════════════════════════════════════════
         *
         * `navigateFallback: '/index.html'` 会注册一条**预缓存路由**，
         * 而预缓存路由的优先级高于网络 —— 也就是说
         * **在线时也会返回缓存的旧 index.html**。
         *
         * 后果是一条隐蔽的失败链：
         *
         *   旧 index.html（缓存）
         *     → 它引用的是旧构建的 chunk 哈希
         *     → 新部署后服务器上那些文件已被删除
         *     → 用户点击导入 PDF，动态 import 一个不存在的文件
         *     → Failed to fetch dynamically imported module: .../pdfParser-CiRxJgol.js
         *
         * **页面本身正常、其他功能也正常，只有按需加载的那几个解析器会炸** ——
         * 这正是它难以定位的原因。
         *
         * `skipWaiting` / `autoUpdate` 解决不了这个问题：它们管的是
         * 「新 SW 何时接管」，而这里的旧 SW 是**主动**把旧 HTML 递给了用户。
         *
         * 改法见下方 runtimeCaching 里的导航路由：在线走网络、离线回退缓存。
         */
        navigateFallback: undefined,

        // 构建后立刻接管，避免用户第一次访问时 SW 还在等待
        clientsClaim: true,
        skipWaiting: true,

        cleanupOutdatedCaches: true,

        runtimeCaching: [
          {
            /**
             * 导航请求（打开页面 / 刷新）：**在线优先，离线回退**。
             *
             * 这是修复的核心 —— 只要在线，就拿服务器上最新的 index.html，
             * 它引用的 chunk 哈希必然与服务器上的资源一致，
             * 从根本上消除「旧 HTML 找新 chunk」的错配。
             *
             * 离线时才回退到预缓存的 index.html，保住离线可打开的能力。
             *
             * 用 NetworkFirst 而不是 NetworkOnly：后者会让离线彻底打不开网站，
             * 而「离线可用」是本项目的核心约束之一。
             */
            urlPattern: ({ request }: { request: Request }) => request.mode === 'navigate',
            handler: 'NetworkFirst',
            options: {
              cacheName: 'html-navigation',
              // 网络等待上限：超时就回退缓存，避免弱网下白屏很久
              networkTimeoutSeconds: 3,
              expiration: { maxEntries: 8 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
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
            /**
             * PaddleOCR 模型文件（检测 + 识别 + 字典，合计约 30MB）。
             *
             * **默认来源是同源 `/ocr-models/`**（构建时由 fetch-ocr-models.mjs
             * 取好放进 public/），因此这条同源规则才是实际生效的那条。
             * 另外两个主机保留覆盖，是因为 `VITE_OCR_MODEL_BASE` 还能把来源
             * 换回官方源或自建镜像 —— 漏掉任一来源，那批用户就会
             * 「用过一次也还是不能离线用」。
             *
             * 不放进预缓存：30MB 会让首访安装体积暴涨，而 OCR 是可选功能。
             * CacheFirst 让「用过一次之后离线也能用」。
             */
            urlPattern: /(\/ocr-models\/)|(^https:\/\/(huggingface\.co|hf-mirror\.com)\/)/,
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
