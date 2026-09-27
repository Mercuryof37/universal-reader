# 通用文档阅读器

把用户自己的文档（Markdown / TXT / PDF / EPUB）变成一本可双语对照、可朗读、可批注的电子书。
保留雨幕档案的纸质书卷阅读体验，把内容源从游戏剧情换成用户上传的文档。

**核心承诺：文档不出浏览器。** 解析、存储、批注、缓存全部在本机完成，没有后端，没有上传。

---

## 快速开始

```bash
npm install        # 若环境限制脚本执行，可用 npm install --ignore-scripts
npm run dev        # 开发服务器 http://localhost:5173
npm run build      # 生产构建，产物在 dist/
npm run preview    # 本地预览构建产物
npm test           # 单元测试
npm run typecheck  # 类型检查（前端 + Worker）
```

零配置即可运行：不配任何环境变量时，朗读走浏览器原生 TTS，翻译走浏览器内置翻译。
若要启用云端高质量翻译与音色，见下方「云端能力」一节。

**环境要求**：Node `^20.19 || >=22.12`（Vite 8 的要求）。本项目在 Node 25.2.1 上验证通过。

**浏览器要求**：**Chrome / Edge 119+、Firefox 121+、Safari 17.4+**。
pdf.js 5 依赖 `Promise.withResolvers`（ES2024）与 `Uint8Array#toHex`（ES2025 提案），
更低版本会导致 PDF 无法导入。应用已内置这些 API 的补齐实现并在能力不足时给出明确提示，
但仍建议使用新版本浏览器。

---

## 目录结构

```
universal-reader/
├─ src/
│  ├─ types/content.ts          统一内容模型（ContentBlock / DocDocument / Annotation）
│  ├─ parsers/                  解析引擎
│  │  ├─ index.ts               注册表：按扩展名分发，PDF/EPUB 走动态 import
│  │  ├─ pdfRuntime.ts          pdf.js 运行时：创建并复用共享 Worker
│  │  ├─ pdfWorkerEntry.ts      **Worker 入口：先装 API 补齐，再加载 pdf.js**
│  │  ├─ scannedPdfError.ts     扫描件错误类型（零依赖，避免拖入 pdfjs）
│  │  ├─ markdownParser.ts      remark → mdast → 拍平为线性块
│  │  ├─ textParser.ts          三级降级分段
│  │  ├─ pdfParser.ts           坐标聚类重建段落
│  │  └─ epubParser.ts          epubjs，按 spine 顺序拍平
│  ├─ lib/
│  │  ├─ db.ts                  Dexie 数据库：五张表 + 译文缓存键
│  │  ├─ annotations.ts         选区锚点解析、批注片段切分
│  │  ├─ textEncoding.ts        编码识别（BOM / UTF-8 / GBK / UTF-16）
│  │  ├─ polyfills.ts           ES2024/2025 API 补齐 + PDF 能力探测
│  │  ├─ ocrTypes.ts            OCR 类型与语言选项（零依赖，避免拖入 tesseract）
│  │  ├─ ocrEngine.ts           tesseract.js 封装（按需加载）
│  │  ├─ ocrPostProcess.ts      OCR 结果 → ContentBlock
│  │  ├─ pdfTextLayer.ts        把 OCR 结果写回 PDF 文字层（pdf-lib）
│  │  └─ utils.ts               锚点定位 / 文档装配 / 语言探测 / 朗读切句
│  ├─ services/
│  │  ├─ ttsEngine.ts           双引擎 TTS（浏览器原生 / 云端），含自动降级
│  │  └─ translationService.ts  翻译：缓存优先 → 代理 / 浏览器内置
│  ├─ store/                    Zustand：settings（localStorage）/ library / annotations
│  ├─ hooks/
│  │  ├─ useVirtualWindow.ts    自研虚拟滚动（估算 + ResizeObserver 校正）
│  │  ├─ useTtsReader.ts        朗读状态机（含自动连读）
│  │  └─ useViewportTranslation.ts  视口懒翻译队列（并发 3）
│  ├─ components/               UI：文档库、阅读视图、批注侧栏、翻译与朗读面板
│  └─ styles/index.css          主题令牌（CSS 变量）+ 正文排版
├─ worker/api-proxy.ts          Cloudflare Worker：翻译 / TTS 代理（密钥只在这里）
├─ docs/技术选型定稿.md          选型理由、被否决的方案、实测体积、风险与路线图
└─ .github/workflows/ci.yml     类型检查 + 测试 + 构建三重门禁
```

---

## 数据流

```
File ──▶ parsers/（按格式分发）
           │  md/txt：静态引入
           │  pdf/epub：动态 import + Worker
           ▼
      DocDocument { blocks[], toc[] }
           │
           ├──▶ Dexie.documents + Dexie.blocks   （持久化）
           ├──▶ libraryStore.currentDoc          （内存镜像）
           ▼
      ReaderView（虚拟滚动）
           ├──▶ BlockRow：原文 + 译文对照 + 高亮批注
           ├──▶ useTtsReader：逐段朗读，可自动连读
           ├──▶ useViewportTranslation：滚到哪翻到哪
           └──▶ annotationsStore ──▶ Dexie.annotations
```

**分层原则**：设置类（字号、主题、语速）存 localStorage；数据类（正文、批注、译文、进度）存 IndexedDB。
二者混用会导致"改一次字号写一次数据库"。

---

## 关键设计决策（踩过的坑）

1. **polyfill 只对执行它的那个 JS 上下文有效**。这是本项目最贵的教训，也是 `a.toHex is not a function` 反复出现三次的真因。pdf.js 计算文档指纹时调用 `Uint8Array#toHex`（ES2025 提案），而这段代码**只存在于 worker 文件里**——worker 有独立的全局对象与原型链，主线程打的补丁它看不到。于是出现"本地测试全绿、线上照旧报错"：Node 与主线程两边都有原生实现，唯独真正需要它的 worker 没有。
   **最终解法**：提供自己的 Worker 入口 `parsers/pdfWorkerEntry.ts`，**先 import 补齐、再 import pdf.js**（import 顺序即执行顺序），主线程用 `PDFWorker.create({ port })` 传入这个 Worker 实例。
   期间否决的三个方案：只在主线程补 API（worker 看不到）· 让 pdf.js 跑主线程（pdf.js 5 **不会**自动退回主线程，而是抛 `No "GlobalWorkerOptions.workerSrc" specified`）· 用 pdf.js 自带的 worker 文件（那文件内部没有补齐）。
   防线：`parsers/legacyBrowser.test.ts` 主动删掉原型上的 `toHex` 再跑完整解析。
2. **语法兼容 ≠ API 兼容**。Vite 只做语法降级、**不会**为缺失 API 注入 polyfill。`build.target: es2022` 让代码编译通过，不代表运行时有那些函数。
3. **验证要覆盖 worker 文件**。`toHex` 在主包里一处都没有，只在 `pdf.worker.min.mjs` 里 —— 只查主包的验证会得出"没问题"的错误结论。
4. **跨模块共享的类型与常量必须与重量级实现分离**。为拿一个错误类而 `import '@/parsers/pdfParser'`，会把 pdfjs（415KB）与 tesseract.js 拖进首屏包 —— 实测主包 gzip 从 68KB 涨到 201KB。所以有了 `scannedPdfError.ts` 与 `ocrTypes.ts`。
5. **看构建产物，不只看源码**。上面的回退在源码里完全看不出来，只有在 `dist/assets` 的 chunk 列表里才暴露。
6. **组件里的 `getOperatorList()` 默认不展开 Form XObject**，扫描件恰恰把图片放在 Form XObject 里。不加 `intent: 'display'` 会得出"页面是空的"这一错误结论。（我误判过一次。）
7. **PDF 断段阈值必须自适应**。按固定倍数（行距 > 1.0×字号）判定，会把 12pt / 1.2 倍行距的文档每一行都切成独立段落。改为先求本页行距中位数再判定。
8. **`File.text()` 一律按 UTF-8 解码**，中文 Windows 的 txt 常是 GBK 或 UTF-16，直接读会得到空白或乱码。见 `lib/textEncoding.ts`。
9. **解析出 0 个块必须报错**。静默返回空文档是最糟的失败方式——用户看到"导入成功"却一片空白，无从排查。
10. **PDF 没有"段落"**。只有绝对定位的文字片段，必须按 y 坐标聚行、按行距聚段。
11. **批注锚点不能只存偏移**。文档重新解析后偏移会整体漂移。方案是「偏移 + 前后 15 字指纹」三级降级定位；定位失败时**保留批注并标记失锚**，绝不静默丢弃用户的笔记。
12. **批注高亮必须用区间切分，不能做字符串替换**。批注会重叠，切分后拼接必须严格等于原文，否则界面丢字。这条不变量有单元测试守着。
13. **翻译与朗读都必须有降级路径**。没配密钥也要能用，否则第一次打开应用的人会以为坏了。
14. **密钥不进前端**。前端代码、构建产物、localStorage 对用户完全可见。所有付费调用经 `worker/api-proxy.ts` 转发。
15. **虚拟滚动不引入现成库**。行高随字号、行距、双语布局、译文展开变化，固定 `itemHeight` 的库配置成本高于自研。

---

## 云端能力（可选）

```bash
# 1. 部署代理
npx wrangler secret put DEEPL_API_KEY
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put AZURE_SPEECH_KEY
npx wrangler secret put AZURE_SPEECH_REGION
npx wrangler deploy

# 2. 在 wrangler.toml 里把 ALLOWED_ORIGIN 设成你的站点域名
#    （不设会导致代理拒绝跨域；设错会导致它成为任何人都能白嫖的接口）

# 3. 前端指向代理
cp .env.example .env.local   # 填入 VITE_TRANSLATE_ENDPOINT 与 VITE_TTS_ENDPOINT
```

不配置完全不影响使用，只是翻译与朗读退化为浏览器内置能力。

---

## 部署

**Cloudflare Pages**：构建命令 `npm run build`，输出目录 `dist`。产物是纯静态文件，无需任何服务端环境。

**注意**：源映射会一并输出到 `dist/assets/*.map`（约 5 MB）。生产环境可选择关闭 `build.sourcemap`，或只上传 map 到错误监控平台而不随站点发布。

---

## 实测体积

| 产物 | gzip | 加载时机 |
|---|---|---|
| 应用主体 | 70 KB | 首屏 |
| React | 68 KB | 首屏 |
| 样式 | 6 KB | 首屏 |
| remark 全家桶 | 18 KB | 导入 md/txt |
| pdfjs | 124 KB | **仅导入 PDF**（解析在独立 Worker 中进行，Worker 自身 1.15 MB 首次导入时加载） |
| epubjs | 105 KB | 仅导入 EPUB |
| OCR 引擎封装 | 8 KB | **仅执行 OCR**（tesseract.js 的 WASM 与语言包另行按需下载） |

> PDF 解析运行在独立 Worker 中（`pdfWorkerEntry-*.js`，1.15 MB），
> 它由第一次导入 PDF 时按需加载并全局复用，因此连续导入多个 PDF 不会重复付出启动成本。
> Worker 入口内部**先安装 API 补齐、再加载 pdf.js** —— 这是 `a.toHex` 问题的最终解法。

---

## 当前进度

**已完成（可用）**
- 四种格式导入与统一内容模型
- IndexedDB 持久化（文档 / 正文 / 批注 / 进度 / 译文缓存）
- 虚拟滚动阅读、目录跳转、进度记忆
- 双语对照（上下 / 左右 / 只看原文 / 只看译文四种布局）
- 批注：选区高亮、5 色、笔记、失锚检测、导出 JSON / Markdown
- 朗读：双引擎、音色与语速、逐段连读、快捷键（空格 / J / K / Esc）
- 翻译：视口懒翻译、并发控制、两级缓存、可取消
- 三套阅读主题、字号/行距/版心/字体调节
- 75 个单元测试（含合成 PDF 端到端解析、真实文件回归、**旧浏览器缺 API 的模拟**）、CI 三重门禁
- 三个诊断脚本：`scripts/inspect-pdf.mjs`（解析质量体检）、`scripts/diagnose-pdf.mjs`（页面结构排查）、`scripts/analyze-pdf-objects.mjs`（原始对象分析）
- 扫描版 PDF 的浏览器端 OCR 入口（tesseract.js，按需加载）

**待做（建议顺序见 `docs/技术选型定稿.md` 第八节）**
- 真实文档的端到端回归（尤其双栏 PDF 与扫描件）
- Playwright E2E
- 中文正文字体子集化
- PDF 双栏识别、页眉页脚过滤
- 批注手动重锚、全文搜索
- PWA 离线启动、全量数据导出/导入

---

## 已知限制

- **PDF 双栏排版**可能把左右两栏串成同一行（当前按 y 聚类，未做分栏检测）。
- **扫描版 PDF（图片型）无法提取文字**，会明确报错并给出 OCR 命令。阅读器当前不支持以图片方式翻页阅读。
- **混排 PDF**（部分页是图片）只导入有文字层的页，控制台会说明跳过页数。
- **行距完全均匀且无句末标点的 PDF**（如整页无标点的目录页）可能被合并成一整段。
- **浏览器原生 TTS** 音色取决于操作系统，Windows 与 macOS 差异明显；Chrome 对超长文本会静默中断（已用切句规避）。
- **浏览器内置翻译**需要较新的 Chrome（Translator API），其他浏览器请配置云端代理。
- **清除浏览器站点数据**会连同已导入的文档与批注一起清除，请用批注导出功能备份。

---

## 排查手册

导入异常时，先看这两处，多数问题能直接定位：

| 现象 | 先看什么 | 常见原因 |
|---|---|---|
| PDF 报 `a.toHex is not a function` | — | 已修复（自定义 Worker 入口内先装补齐）。若仍出现，**必须重启 dev server 并 `Ctrl+Shift+R`** |
| PDF 报 `No "GlobalWorkerOptions.workerSrc" specified` | — | 已修复。该错误来自"让 pdf.js 跑主线程"的错误尝试——pdf.js 5 不会自动退回主线程 |
| PDF 提示"没有文字层，是扫描版" | — | 图片型 PDF。界面会提供**浏览器端 OCR** 入口，也可先用外部工具 OCR |
| PDF 打开但内容很少 | 控制台警告 | 混排文档（多数页是图片）。已跳过图片页，控制台会说明跳过多少页 |
| txt 打开后空白或乱码 | 文档库中的文档标签「编码：xxx」 | 原文件是 GBK/UTF-16；已自动识别，标签显示"可能有误"说明识别失败 |
| txt 段落全挤在一起 / 碎成一段一行 | 文档库中的「N 段」计数 | 段落切分按空行判定；该文件可能用单换行分段，或通篇没有空行 |
| 导入后侧栏无内容但顶部显示有字数 | 浏览器控制台（F12） | 可能是渲染异常，把控制台报错贴出来 |

**取控制台日志的方法**：按 F12 → 切到 Console → 重现一次问题 → 右键选择「Save as…」或直接截图。

**排查前先做这一步**：`Ctrl+Shift+R` 强制刷新。Vite 的开发服务器会缓存已转换模块，`src/parsers/*` 的改动有时不会立即生效 —— 这会让"已修复的问题"看起来还在。

**诊断脚本**（Node 端，不需要浏览器）：

```bash
# 解析质量体检：页数、段落数、字号分布、断段是否过碎/过粗
node scripts/inspect-pdf.mjs "D:\path\to\book.pdf" --pages 40

# 页面结构排查：内容流里到底有没有文字/图片指令，判断是不是扫描件
node scripts/diagnose-pdf.mjs "D:\path\to\book.pdf" --pages 3

# 原始对象分析：不依赖解析器，直接数图片/字体对象，判断文件是否内容为空
node scripts/analyze-pdf-objects.mjs "D:\path\to\book.pdf"
```
