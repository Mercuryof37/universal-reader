import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  /**
   * 构建标识，注入成全局常量 `__BUILD_ID__`。
   *
   * ═══════════════════════════════════════════════════════════════
   * 为什么需要它
   * ═══════════════════════════════════════════════════════════════
   *
   * 「这个浏览器跑不了 OCR」的崩溃记录是持久的（localStorage，30 天），
   * 但**代码在变**：那条记录可能来自一个早就修掉的版本。
   * 用户实测就撞上了这一点 —— 他在 360 上累计了 3 次崩溃，
   * 而那 3 次发生在 WebGPU / PNG 编码 / 线程池都还没修的版本上；
   * 如今修复早已上线，他却被旧记录挡在门外、连再试一次的机会都没有。
   *
   * 所以崩溃计数要**按构建版本**记：换了新版本就重新开始计。
   * 每次构建都不同，因此每次部署都会给用户一次干净的机会 ——
   * 这正确反映了「这次修复也许已经解决了」。
   */
  define: {
    __BUILD_ID__: JSON.stringify(new Date().toISOString()),
  },
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
     *   PaddleOCR 的模型与 ONNX Runtime WASM、tesseract 的 core / worker /
     *   语言数据。它们的体积大（合计数十 MB）、按需下载，不适合预缓存，
     *   用 CacheFirst 让「用过一次之后离线也能用」。
     */
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: null,
      includeAssets: ['icons/*.png'],

      manifest: {
        name: '通用文档阅读器',
        short_name: '文档阅读器',
        /**
         * ⚠️ 这句话是**对用户的承诺**，不是宣传语 —— 它必须字面为真。
         *
         * ═══════════════════════════════════════════════════════════
         * 它曾经与代码事实冲突（三条外发路径里两条是静默开启的）
         * ═══════════════════════════════════════════════════════════
         *
         * 本项目共有**三条**能把文档内容送出本机的路径。它们曾经的状态是：
         * · 公式识别增强 —— 已经是显式 opt-in（默认 false）✓
         * · 云端翻译      —— 配了 `VITE_TRANSLATE_ENDPOINT` 就自动选 DeepL ✗
         * · 云端语音      —— `ttsPreference` 默认 `'auto'`，配了
         *                    `VITE_TTS_ENDPOINT` 就自动把正文发往 Azure ✗
         *
         * 也就是说：**后两条无需用户做任何动作就会外发**，而这句话写着
         * 「不上传服务器」。那是文案说 A、代码做 B —— 比缺功能严重。
         *
         * 处理方式：**改代码让承诺成立，而不是把承诺改小。** 三条路径现在
         * 全部满足同一套四要素（默认关闭 / 用户显式同意 / 代码层第二道防线 /
         * 界面写清代价），清单见 `src/lib/outboundPaths.ts`，它同时被设置面板
         * 渲染、被 `src/store/outboundPrivacy.test.ts` 断言。
         *
         * 所以这句话在**默认状态**下字面为真：不配置端点、用户不做任何
         * 显式动作时，没有任何一条路径能把文档内容送出本机。
         * 例外只可能来自用户自己的动作，且那个动作在界面上写着代价。
         *
         * 谁能破坏它：任何一条**新的**外发路径，或任何一次把某个同意位
         * 改成默认为真、或让"配置了端点"重新等价于"用户已同意"的改动。
         * 测试守的就是这两件事（两个方向：有能力/无能力 × 已同意/未同意）。
         */
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
        //
        // ⚠️ tesseract 第二意见资产（tess/、tess-core/、tessdata/，约 14.8MB）
        // 同理**必须排除**：默认 globPatterns 里的 `**/*.js` 会把
        //   tess/worker.min.js                    111KB
        //   tess-core/tesseract-core-*-lstm.wasm.js  ×3 变体 ≈11.7MB
        // 全部卷进预缓存 —— 而这三个 core 变体浏览器**只会用到其中一个**
        // （SIMD × 多线程 的组合探测），首访白下 11.8MB。
        // 它们和 OCR 模型同一性质：功能可用性不依赖 SW，
        // 走运行时 CacheFirst（见下方 runtimeCaching 的 tess 路由），
        // 第一次真正用到才下载，之后离线可用。
        // 注意 scripts/verify-dist.mjs 的第 2d/5 节会把这条约束当构建门禁来查。
        globIgnores: [
          '**/pdfjs-wasm/quickjs-eval*',
          '**/pdfjs-wasm/*_nowasm_fallback.js',
          '**/ort-wasm*',
          '**/tess/**',
          '**/tess-core/**',
          '**/tessdata/**',
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
            /**
             * tesseract 第二意见的资产（core 的 3 个 lstm 变体 ≈ 12MB、
             * worker ≈ 0.03MB、`eng.traineddata.gz` ≈ 3MB），全部同源 ——
             * `scripts/fetch-tess-assets.mjs` 在构建时落盘。
             *
             * ⚠️ **不能漏掉任何一类路径**，否则对应的那次调用会去
             * 联网重下：
             *   · `/tess-core/` —— core 的 wasm.js（内含 base64 的 wasm）；
             *   · `/tess/`      —— worker 脚本本体；
             *   · `/tessdata/`  —— 语言数据。
             * 三者里漏一个，离线时那条 fetch 就失败 → worker 建不起来 →
             * 第二意见静默降级（识别结果不受影响，但角标救回不生效）。
             *
             * 与 OCR 模型同理：**不预缓存**（可选功能，十几 MB 不该
             * 计入首访安装体积），CacheFirst 保证「用过一次之后离线也能用」。
             */
            urlPattern: /\/(tess-core|tess|tessdata)\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'tess-assets',
              expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 365 },
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
