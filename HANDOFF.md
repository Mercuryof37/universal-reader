# HANDOFF · 项目交接文档

> **本文的读者**：接手本项目的开发者或 AI 模型。假设你**没有任何上下文**。
>
> **本文的目标**：让你在读完这一份文档后，能够准确判断
> 「什么已经能用、什么还没验证过、下一步最该做什么」。
>
> **一句话定位**：一个**纯前端、零后端、本地优先**的文档阅读器。
> 用户导入 md / txt / pdf / epub，获得双语对照、语音朗读、批注能力，
> **文档全程不离开浏览器**。
>
> ⚠️ 最后一句有**一处例外，且已于本轮收口**：`5184bde` 引入的 SimpleTex 公式 OCR
> 是**唯一**会把页面局部像素送出本机的路径，但它现在是**默认关闭的显式开关**
> （`settingsStore.formulaOcrEnabled`，默认 `false`）—— 不勾选就一个字节都不外发。
> 详见 §1 的 T2、§5.8 与 §1 末尾的「本轮三项决定」。

| 项 | 值 |
|---|---|
| 仓库 | `Mercuryof37/universal-reader`（分支 `main`） |
| 当前提交 | **`780c54c`**（**最新一轮**：新增 `src/lib/ocrSupport.ts` —— **在开始 OCR 之前做能力检测**，把不受支持的内核在「开始识别」之前就认出来并给出可执行建议，而不是崩在推理里；新增 5 个用例。见 **§5.10**，即 `docs/03` 的**缺陷 22**）<br>**这一轮之前还落过几个提交**（模型改为同源自托管、只启用 WASM、`ort.env.wasm.numThreads = 1` 与去掉 `toBlob`、`OCR_RENDER_DPI` 300 → 200），它们的哈希本文未记录。**`780c54c` 的推送与部署状态本轮未核对** |
| 部署 | Cloudflare Pages（静态）+ 可选 Cloudflare Worker（API 代理） |
| 上一轮提交 | `fc79896`（「fix(ocr): stop losing a whole scan to a mid-run reload, and defer that reload」，即 §5.9 缺陷 21 的两条修法）＋ `ed66ba8`（只新增测试文件、**不影响产物**）：**二者均已推送到 `origin/main`**（`fc79896` 的 push 重试了 7 次，本机 `github.com:443` 时通时断，见 §10），**部署已确认** —— `verify` 与 `Cloudflare Pages` 两项 check 均为 **success**，线上入口 chunk 为 `assets/index-CiMmJIqw.js` |
| 更早一轮提交 | `f549173`（三项决策）与 `f331393`（文档同步）：**二者均已部署**（`verify` 与 `Cloudflare Pages` 两项 check 均为 **success**，线上已服务于那一批产物） |
| 代码规模 | `src/` **65 个文件 / 11,018 行** · `scripts/` 8 个 / 1,151 行 · `worker/` 1 个 / 453 行<br>（这是上一轮基线，**本轮新增若干文件后未复核**，不要直接引用） |
| 依赖 | **26** 个（dependencies 16 + devDependencies 10），本轮**不变**（上一轮由 29 降下来） |
| 测试 | **24 个文件 / 246 个用例全部通过**（**最新一轮基线**；上一轮是 20 / 216） |
| 门禁 | `tsc -b` ✅ · `vitest run` ✅ · `npm run build` ✅（含 ONNX WASM 清理 + 产物校验） |
| 文档 | `README.md`（用户手册）· `docs/`（3 份专题）· 本文 |

> **关于「本轮」这个词**：本文其余各节大量使用「本轮」，它们指的是 **`fc79896` + `ed66ba8` 那一轮**
> （§5.9 缺陷 21）。**最新一轮是 `780c54c`（§5.10 缺陷 22）** —— 正文里凡涉及它的地方都会写明提交号。

---

## 1. 先读这一节：项目由什么约束塑造

**技术选型不是"选最好的"，而是"在约束下选最不容易后悔的"。**
理解下面六条约束，你才能判断某项改动是否合适。

| 编号 | 约束 | 直接后果 |
|---|---|---|
| C1 | **零后端** | 不能有 SSR、不能有服务端 API、不能依赖服务端会话。所有数据在 IndexedDB |
| C2 | **离线可用** | 依赖必须能打包进浏览器；已由 Service Worker 落实（见 §5） |
| C3 | **隐私是卖点** | 付费 API 的密钥**一律不进前端**，只能经自建 Worker 代理 |
| C4 | **要解析大文件** | PDF 动辄几十 MB。内存与解码器可靠性比算法技巧更重要 |
| C5 | **翻译按字符计费** | 必须有缓存与"按需调用"。已实现视口懒翻译 + 两级缓存 |
| C6 | **单人开发、静态托管** | 运维复杂度必须接近零。**因此不引入数据库、不引入服务端框架** |

### 上一轮（`aa8827a`）发现的两条张力 —— 必须与上面六条一起读（**T2 本轮已收口，T1 仍未解决**）

| 编号 | 张力 | 具体事实 |
|---|---|---|
| T1 | **C2 离线 × 首次 OCR 需要联网**（**仍未解决，但第三方域名的依赖风险已部分收口**） | OCR 引擎换成 PaddleOCR / ONNX Runtime Web 之后，**模型（约 30MB）与 ONNX WASM（约 28MB，来自 jsDelivr）都只在运行时缓存里**（`ocr-models`、`onnx-wasm`，均 CacheFirst），**不在预缓存清单里**。也就是说「用过一次之后才能离线用」。国内网络对第三方 CDN 的可达性不保证，这是**外部依赖风险**。<br>**§5.10 那一轮部分收口**：模型改为**构建时取好、与站点同源发布**（`scripts/fetch-ocr-models.mjs` → `public/ocr-models/`，默认 base 就是同源 `/ocr-models`），运行时**不再请求 `huggingface.co` / `hf-mirror.com`** —— 那正是浏览器报 `TypeError: Failed to fetch` 的来源。但模型**仍不在预缓存清单里**，所以「首次 OCR 必须联网」这一条**不变**；ONNX WASM 仍来自 `cdn.jsdelivr.net` |
| T2 | **C3 隐私 × SimpleTex 公式 OCR**（**本轮已收口**） | `5184bde` 引入的公式增强会把**页面局部像素**（裁剪出的公式区域，客户端上限 `MAX_IMAGE_SIZE = 2_000_000` 字节）POST 到自建 Worker，再由 Worker 以 `Authorization: Bearer <key>` 转发到第三方 `https://server.simpletex.cn/api/v1/simpletex_recognize`。这是本项目**唯一**把文档内容送出本机的路径。**本轮改为默认关闭的显式开关**（`settingsStore.formulaOcrEnabled`，默认 `false`）：不勾选 → 不发起任何网络请求、一个字节都不外发。**但残余点必须保留**：勾选后仍会上传；需要联网；Worker 未配 `SIMPLETEX_API_KEY` 时该端点在线上实测仍返回 500；应用内**没有**「上传了什么」的审计视图。见 §5.8 与 §4.2 |

> 上一轮单列的「PWA 更新模式自相矛盾」**已于本轮拍板**：保留 `autoUpdate`，永不触发的提示 UI 已删除。见 §5.7。

### 本轮三项决定（**已拍板，不要再翻案**）

三项决定都是「已经做完并写进代码」，不是待办。细节见各自的小节：

| 决定 | 结论 | 代价 / 残余点 | 详见 |
|---|---|---|---|
| 一 · PWA 更新模式 | **保留 `autoUpdate`**，不回到 prompt。据此删掉了 prompt 模式那套永不触发的「有新版本可用 / 立即更新」UI | 页面仍会**无预警自动重载**，滚动位置与展开的译文会丢。**其中「进行中的 OCR 会丢」这一项已在本轮缓解**（导入/OCR 期间推迟刷新 + 中途落盘，见 §5.9）—— 其余代价**不变** | §5.7 |
| 二 · 公式云端识别 | **改为默认关闭的显式开关**（`settingsStore.formulaOcrEnabled`，默认 `false`），在 OCR 对话框里由用户勾选 | 隐私张力已收口（默认零上传）；勾选后仍上传到第三方、需要联网、线上端点当前 500、无审计视图 | §5.8 |
| 三 · 死代码与冗余依赖 | 删除 `ocrWordExtraction.ts`（含 13 个孤立用例）、`ocrWordExtraction.test.ts`、`pdfTextLayer.ts`；移除 `pdf-lib`、`jszip`、`rehype-katex` | 无（都是无调用方的代码与无 import 的依赖） | §4.3 |

### 由此推出的"不要做"

以下改动看起来是改进，实则会破坏项目定位，**请先与维护者确认**：

| 不要做 | 原因 |
|---|---|
| 引入 Next.js / Nuxt / Remix | 它们解决服务端渲染与服务端数据获取，本项目没有服务端 |
| 加云同步 / 用户账号 | 一旦有服务端存文档，C3 的核心卖点消失。若要做，必须端到端加密 |
| 把 API 密钥放进前端 | 等同于公开。前端代码、产物、localStorage 对用户完全可见 |
| 引入 CJK 字体子集化 | 当前用系统字体栈，中文显示成本为零。子集化要引入几 MB 字体与构建步骤，且易产生"生僻字变豆腐块"。**投入产出比为负** |
| 把 PDF 解析移回 Web Worker | 见 §6 缺陷 1 —— 已尝试三次失败，当前方案是唯一可用的 |
| 让 SimpleTex 公式增强继续"默认静默上传" | 与 C3 的口径直接冲突。**已改为默认关闭的显式开关**（§5.8）。不要把它改回默认开启，也不要绕过开关去调 `recognizeFormula()` |
| 把 ONNX WASM 重新塞回 `dist/` 或加进预缓存 | 单个 `.wasm` 约 28MB，**超过 Cloudflare Pages 单文件 25MB 上限**；构建后必须由 `clean-onnx-wasm.mjs` 删除并改走 CDN（见 §3） |
| 把 OCR 结果继续只留在内存里、等最后一页跑完才写库 | 这正是 §5.9 缺陷 21 的真因之一：一次十来分钟的扫描，任何中断都会**无声无息地全部丢失**。中途落盘（检查点）不是优化，是保障措施 |
| 用 **User-Agent 嗅探**来判断「这个浏览器能不能跑 OCR」 | UA 可以随便改，而且**同一款外壳浏览器的「极速模式」与「兼容模式」内核完全不同**（后者实际是 IE 内核）。§5.10 的结论是**只检测能力**（`WebAssembly` + WASM SIMD），不要跳过 `detectOcrSupport()` |
| 把 `crossOriginIsolated` 当成「能不能跑 OCR」的判据 | 它只影响**多线程**；本项目是单线程运行（`ort.env.wasm.numThreads = 1`），拿它做判定会**把能用的环境误判成不能用**。它只记录、不判定（§5.10） |

---

## 2. 技术栈（版本为实测安装版本）

### 运行时依赖

| 包 | 版本 | 用途 | 加载时机 |
|---|---|---|---|
| `react` / `react-dom` | 19.3.0 | UI | 首屏 |
| `zustand` | 5.0.15 | 状态管理（含 persist） | 首屏 |
| `dexie` | 4.4.6 | IndexedDB 封装 | 首屏 |
| `lucide-react` | 0.548.0 | 图标 | 首屏 |
| `@base-ui/react` | 1.8.0 | 无交互样式的无障碍组件 | 首屏 |
| `unified` / `remark-parse` / `remark-gfm` / `remark-math` / `unist-util-visit` | 11.0.5 / 11.0.0 / 4.0.1 / 6.0.0 / 5.1.0 | Markdown 解析（含 `$行内$` 与 `$$块级$$` 数学） | 导入 md/txt |
| `katex` | 0.19.0 | 数学公式渲染（`BlockRow.tsx` 区分 display / inline） | 导入含公式的文档 |
| `pdfjs-dist` | 5.7.284 | PDF 解析（**含 WASM 解码器**） | 仅导入 PDF |
| `epubjs` | 0.3.93 | EPUB 解析 | 仅导入 EPUB |
| `ppu-paddle-ocr` | 6.6.0 | 浏览器端 OCR（PP-OCRv6 small，**替代原 Tesseract.js**） | 仅执行 OCR，模型约 10MB 运行时下载 |
| `onnxruntime-web` | 1.30.0 | PaddleOCR 的 ONNX 推理运行时（WASM 约 28MB 由 CDN 提供） | 仅执行 OCR |

> **本轮移除了 3 个「装了没用」的依赖**（依赖总数 **29 → 26**，即 dependencies 19 → 16、
> devDependencies 10 不变）：
>
> | 依赖 | 为什么可以删 |
> |---|---|
> | `pdf-lib@^1.17.1` | 它唯一的用途是配合 `pdfTextLayer.ts` 把 OCR 结果写回 PDF；该文件删除后，`src/`、`worker/`、`scripts/` 里 grep `pdf-lib` / `PDFDocument` **零命中** |
> | `jszip@^3.10.2` | 全仓库没有任何 `from 'jszip'` / `require('jszip')` / `import('jszip')`（`epubParser.ts` 只在**注释**里提过它）。注意：`epubjs` 自己的 `dependencies` 里带 `jszip ^3.7.1`，所以 `node_modules/jszip` 依然存在 —— 移除的只是应用层的冗余声明 |
> | `rehype-katex@^7.0.1` | 全仓库无任何 import；公式渲染实际由 `BlockRow.tsx` 直接调 `katex.renderToString()` 完成 |
>
> 实测：`npm install --ignore-scripts --no-audit --no-fund` 输出 `removed 23 packages in 1s`（exit 0）。
> 详见 §4.3 的「已清理」表。


> **OCR 引擎已于 `cdf2957` 更换**：`tesseract.js@^7.0.0` 被**移除**，改为
> `ppu-paddle-ocr@6.6.0` + `onnxruntime-web@1.30.0`。更换理由（提交信息原文要点）：
> PP-OCR 专为中文训练、中文准确率远超 Tesseract；50+ 语言全字典，**无需手动选语言包**。
> `vite.config.ts` 配套加了 `optimizeDeps.exclude: ['ppu-paddle-ocr', 'ppu-ocv', 'onnxruntime-web']`。
>
> 因此：**本文及仓库里其他文档中一切「tesseract / 语言包 / tessdata」的表述都已过时**，
> 看到请按本表更正（源码注释里仍有若干遗留，见 §4.3）。

### 开发依赖

`vite` 8.3.1（Rolldown 内核）· `typescript` 5.9.3（strict）· `tailwindcss` 4.3.3（CSS-first 配置）·
`vitest` 4.1.11 · `vite-plugin-pwa` 1.3.0 · `@vitejs/plugin-react` 6.1.1

### 环境要求

| 项 | 要求 |
|---|---|
| Node | `^20.19.0 \|\| >=22.12.0`（Vite 8 的硬性要求） |
| 浏览器 | **Chrome / Edge 119+、Firefox 121+、Safari 17.4+** |

> 浏览器门槛来自 pdf.js 5：它依赖 `Promise.withResolvers`（ES2024）与
> `Uint8Array#toHex`（ES2025）。应用内置了补齐实现，但低版本仍可能出问题。

---

## 3. 如何运行与验证

```bash
npm install          # 受限环境可用 --ignore-scripts
npm run dev          # http://localhost:5173
npm run build        # 完整构建（含 WASM 复制 + 图标生成 + ONNX WASM 清理 + 产物校验）
npm test             # 24 个测试文件 / 246 个用例
npm run typecheck    # 三个 TS project：app / node / worker
```

### ⚠️ 必须用 `npm run build`，不能用 `npx vite build`

`package.json` 挂了这些钩子，直接调 `vite build` 会全部跳过：

| 钩子 | 脚本 | 作用 |
|---|---|---|
| `predev` / `prebuild` | `copy-pdfjs-wasm.mjs` + `make-icons.mjs` | 复制 pdf.js 的 WASM 解码器；生成 PWA 图标 |
| `postbuild` | `clean-onnx-wasm.mjs` **&&** `verify-dist.mjs` | 删掉打进 `dist/` 的 ONNX WASM；再校验产物 |

**跳过 `copy-pdfjs-wasm` 的后果是：扫描版 PDF 全部渲染成白页，且不报任何错。**
（见 §6 缺陷 11 —— 这个坑排查了很多轮。）

### ⚠️ ONNX WASM 走 CDN —— 由 `clean-onnx-wasm.mjs` 保证

`3d4a2ad` 起，`ort.env.wasm.wasmPaths` 被指向
`https://cdn.jsdelivr.net/npm/onnxruntime-web@<版本>/dist/`（`src/lib/ocrEngine.ts` 第 17 行附近）。
原因只有一个：**该 `.wasm` 约 28MB，超过 Cloudflare Pages 单文件 25MB 上限**，打进 `dist/` 就部署不上去。

`postbuild` 的前半段 `clean-onnx-wasm.mjs` 负责把它从产物中删掉（`vite.config.ts` 的
`globIgnores` 里也加了 `**/ort-wasm*`，避免被预缓存）。实测构建日志：

```
Removed ort-wasm-simd-threaded.jsep-MDYUKy93.wasm (served from CDN at runtime)
Cleaned 1 ONNX WASM file(s) from dist.
```

**注意**：`tsc -b` 也在 `npm run build` 里（`build` = `tsc -b && vite build`），
所以单独跑 `vite build` 连类型检查一起跳过。

### 构建产物门禁会检查什么

`scripts/verify-dist.mjs` 把历史上踩过的坑变成了自动检查：

| 检查 | 拦截的缺陷 |
|---|---|
| `dist/pdfjs-wasm/jbig2.wasm` 等存在 | 缺陷 11 |
| 产物中无 `.map` | sourcemap 泄露源码 + 体积翻 3 倍 |
| 入口 chunk 不含 pdfjs 标志 | 缺陷 2（首屏包 68KB → 201KB） |
| 存在独立的 `pdfParser` / `pdfWorkerEntry` chunk | 按需加载被静态 import 破坏 |
| `sw.js` 存在且含导航回退 | PWA 离线能力 |
| 未预缓存无用解码器 | 首访安装体积白涨 1MB |

**这些检查做过负向测试**（删文件、篡改内容），确认真的会失败退出码 1，不是装饰。

---

## 4. 当前状态：什么能用，什么没验证

**这一节是本文最重要的部分。请认真区分「已验证」与「没验证」。**

### 4.1 已验证可用（有测试或真机验证）

| 功能 | 验证方式 |
|---|---|
| 四种格式导入与统一内容模型 | 单元测试（合成 PDF、真实 md/txt） |
| **Markdown 解析**（标题/列表/引用/代码块） | 单元测试，含"列表项不重复"回归 |
| **纯文本解析**（三级降级分段） | 单元测试 |
| **编码识别**（UTF-8 / GBK / UTF-16） | 单元测试，用真实 GBK 字节验证 |
| **PDF 坐标聚类重建段落** | 单元测试 + **真实 833 页扫描件与 7 页文字版验证** |
| **PDF 打不开的各类情况**（加密/损坏/扫描件） | 单元测试 + 真实文件 |
| IndexedDB 持久化与阅读进度 | 代码审阅（**无自动化测试**） |
| 虚拟滚动 | 代码审阅（**无自动化测试**） |
| 批注锚点三级降级定位 | 单元测试（14 例） |
| 批注片段切分（重叠批注） | 单元测试，含"拼接等于原文"不变量 |
| 翻译缓存键与降级逻辑 | 单元测试 |
| PWA 产物完整性 | 产物门禁 + `sw.js` 全文核对 |
| 构建产物正确性 | 负向测试确认门禁有效 |
| PWA 陈旧 chunk 修复（导航路由改 NetworkFirst、不再有 `navigateFallback`） | 线上 `sw.js` 直接抓取核对 + `src/lib/pwaOffline.test.ts` 8 个用例（读 `vite.config.ts` 把 `NAVIGATION_CACHE_NAME` 钉死）；`src/lib/preloadRecovery.ts` 另有 11 个用例。**这两个文件共 19 个用例，已计入当前 246 个用例的基线** |
| **OCR 中途落盘**（`shouldCheckpoint` 的边界规则） | 单元测试（`src/lib/ocrCheckpoint.test.ts` 9 个用例：末页必落盘、每 5 页一次、首页不落、丢失窗口有上界、非法输入返回 `false`）**＋ 源码断言**（parser 与 store 两端都钉）。**但真机中断场景未验证**，见 §4.2 与 §5.9 |

#### 更早一轮（已提交 `f549173`、已部署）的实测证据

| 检查 | 结果 |
|---|---|
| `npx tsc -b` | **exit 0** |
| `npx vitest run` | **200 passed / 18 files**（上一轮 `aa8827a` 是 205 / 18：**−13** 删除的孤立用例、**+8** 新增的公式隐私用例） |
| `npm run build` | `PWA v1.3.0  mode generateSW  precache 18 entries (3578.54 KiB)`；`Removed ort-wasm-simd-threaded.jsep-MDYUKy93.wasm (served from CDN at runtime)`；`[verify-dist] 构建产物校验通过` —— 产物共 **83 个文件 / 5.54 MB**；WASM 解码器 **7 个 / 合计 1.41 MB**；`sw.js` 已生成且包含导航回退 |
| 本轮本地构建哈希 | `index-BBM5E4Bw.js` · `pdfParser-DJvvPlRl.js` · `epubParser-C4ddlQTO.js` · `ocrEngine-BiEnaltO.js` · `index-edxBkGh6.css` |
| GitHub check-runs（commit `f549173`） | `Cloudflare Pages: **success**`、`verify: **success**` |
| 线上 `sw.js`（直接抓 `https://universal-reader.pages.dev/sw.js`） | 含 `NetworkFirst`、含 `html-navigation`；**不含** `createHandlerBoundToURL` —— 导航修复未被本轮改动破坏 |
| 线上 precache 清单（本轮重新抓取） | 含 `assets/index-BUj-R2J2.js`、`assets/pdfParser-BjFMW2CJ.js`、`assets/epubParser-zridiCjA.js`、`assets/ocrEngine-BItOXzga.js`；入口 CSS 仍是 `assets/index-C6dUSkX0.css` |
| 线上 `index.html` | 响应头 `Cache-Control: public, max-age=0, must-revalidate`（上一轮实测；**本轮已带 cache-buster 复测内容哈希**，见下表 —— 它正是核对部署时该用的判据） |

> **本地哈希 ≠ 线上哈希**：同一份源码，上一轮本地构建出 `index-BBM5E4Bw.js` / `pdfParser-DJvvPlRl.js`，
> 线上（`f549173` 的产物）是 `index-BUj-R2J2.js` / `pdfParser-BjFMW2CJ.js`。
> Cloudflare 的构建与本地构建**不是逐字节可复现的**（连 CSS 哈希都不同：本地 `index-edxBkGh6.css`，
> 线上 `index-C6dUSkX0.css`），**绝不能用本地 `dist/` 里的文件名去推断线上资源名**
> （排查这次故障时踩过这个坑）。

#### 上一轮（已推送 `fc79896` + `ed66ba8`，**部署已确认**）的实测证据

| 检查 | 结果 |
|---|---|
| `npx tsc -b` | **exit 0** |
| `npx vitest run` | **216 passed / 20 files**（上一轮 200 / 18 → 本轮 **+16**，来自**两个**新增文件：`src/lib/ocrCheckpoint.test.ts` **9 个用例** + `src/lib/pwaReload.test.ts` **7 个用例**） |
| `npm run build` | `PWA v1.3.0  mode generateSW  precache 18 entries (3579.98 KiB)`；`[verify-dist] 构建产物校验通过` —— 产物共 **83 个文件 / 5.54 MB**；WASM 解码器 **7 个 / 合计 1.41 MB**（**产物规模、WASM 数量与体积、依赖数 26 三项本轮均未变**） |
| 本轮本地构建哈希 | `index-DWhM5bxu.js` · `pdfParser-BQZ8b1PC.js` · `epubParser-BJh-4Mxz.js` · `ocrEngine-DFAnINT2.js` · `index-edxBkGh6.css` |
| 关键文件行数 | `src/lib/pwa.ts` **132** · `src/components/PwaPrompt.tsx` **126** · `src/parsers/pdfParser.ts` **745** · `src/store/libraryStore.ts` **244** · `src/lib/ocrTypes.ts` **154** · `src/lib/ocrCheckpoint.test.ts` **110**（新增） · `src/lib/pwaReload.test.ts` **96**（新增） |
| GitHub check-runs（commit `fc79896`） | **已核对**：`verify: **success**`、`Cloudflare Pages: **success**`。commit `ed66ba8`（只新增测试文件、**不影响产物**）的 check 当时仍在 `in_progress`，但它与 `fc79896` 的产物**完全相同** |
| 线上 `index.html`（**带 cache-buster**：`?t=<时间戳>`） | **已复测**：入口 chunk = **`assets/index-CiMmJIqw.js`** —— 与本地构建哈希不同（这是常态，见 §10）；响应头仍是 `Cache-Control: public, max-age=0, must-revalidate` |
| 线上 `sw.js`（**本轮已复测，但第一次抓错了**） | ⚠️ **不带 cache-buster 抓 `sw.js` 会读到 Cloudflare 边缘缓存里的旧副本**，第一次抓取据此误判成「没部署」。**核对部署必须带 `?t=<时间戳>`，或改用响应头为 `must-revalidate` 的 `index.html` 作判据**。这与本项目原始故障（§5.6）**是同一类错误 —— 都是读到了被缓存的旧产物** |

> **本表这次就是"已上线"的证据**（与上一轮不同，本轮部署已确认）：`fc79896` 的两项 check
> 均为 `success`，线上 `index.html` 实测也已指向本批产物。**但这只证明「产物已上线」，
> 不等于「修法已生效」** —— 两个修法的真机行为仍未验证，见 §4.2 与 §5.9.6。
>
> ⚠️ **核对部署时的坑（必须记住）**：抓线上的 `sw.js` **一定要带 cache-buster**
> （`?t=<时间戳>`），否则会读到 Cloudflare 边缘缓存里的旧副本，从而得出「没部署」的
> **错误结论**（第一次抓就是这么误判的）。这与 §5.6 记录的原始故障**是同一类错误**：
> 读到了被缓存的旧产物。更稳的判据是抓响应头为 `must-revalidate` 的 `index.html`。

#### 最新一轮（提交 `780c54c`）的实测证据

| 检查 | 结果 |
|---|---|
| `npx vitest run` | **246 passed / 24 files**（**最新基线**。上一轮记录是 216 passed / 20 files，现在共有 **24 个测试文件**） |
| 新增测试 | `src/lib/ocrSupport.test.ts`（**5 个用例 / 68 行**）；同一轮里还有 `src/lib/ocrModelSource.test.ts` **7 例** · `src/lib/ocrExecutionProvider.test.ts` **4 例** · `src/lib/ocrRuntimeSafety.test.ts` **5 例**（见 §5.10.7） |
| `npm run build` | **本轮未记录**（这次同步没有拿到该轮的构建输出）。注意 `verify-dist.mjs` 现在还多了一条**模型缺失就让构建硬失败**的检查（已做负向测试：移走目录 → **exit 1**，见 §5.10.7） |
| 部署 / 线上哈希 | **本轮未核对**。⚠️ **不要**把上一轮的 `assets/index-CiMmJIqw.js` 当成这一轮的线上入口 chunk |

> 更完整的证据与未验证项在 §5.10.9 与 §5.10.10 —— 其中最重要的一条是：
> **能力检测本身没有在真机上验证过**（本机装不了 360），见 §4.2。

### 4.2 已实现但**从未在真机上跑通**

| 功能 | 状态 | 风险 |
|---|---|---|
| **扫描版 PDF 的 OCR（PaddleOCR）** | 引擎已在 `cdf2957` 整体重写，代码完整。**真机口径（用户实测）**：「Firefox、Chrome、Microsoft Edge 都可以正常使用，但是 360 不行」—— 本故障只出现在**内核过旧的外壳浏览器**上（§5.10）。**真实扫描件的识别准确率仍未量化验证** | **最高**。见下方说明 |
| **OCR 的前置能力检测**（§5.10，`780c54c`） | `src/lib/ocrSupport.ts` + `src/lib/ocrSupport.test.ts`（**5 个用例**）已完成：不支持的环境会在 OCR 对话框里被直接说明原因与替代浏览器，不再崩在推理里。**但本机没有任何一款国产外壳浏览器可供实测**（装不了 360），所以「真机上会不会被正确拦下」**没有验证过** | 中 |
| 真实浏览器里的离线 PWA 流程 | 产物正确、线上 `sw.js` 已核对，但**从未做过「加载 → 刷新一次 → DevTools 切 Offline → 刷新」** | 中 |
| **公式上传开关的真机行为** | 开关的默认值与早退顺序只有**单元测试与源码断言**（`formulaOcrPrivacy.test.ts` 8 个用例）；「勾选 / 不勾选各跑一次真实 OCR」**从未做过** | 中。见 §5.8 |
| **导入/OCR 期间推迟自动刷新**（§5.9 修法一） | **未在真实浏览器里验证**。要验它，需要**一次真实部署正好落在一次真实扫描中间**，这个时机无法在本地构造；目前只有源码与逻辑层面的确认 | 中。真实浏览器里「新版本已就绪」横幅与「立即刷新」按钮**从未被人眼看到过** |
| **OCR 中途落盘在真实中断下的效果**（§5.9 修法二） | **未在真实浏览器里验证**。只有 `ocrCheckpoint.test.ts` 的 9 个单元用例与 parser / store 两端的源码断言；**没有真机跑过一次会中断的长扫描**（关标签页、浏览器崩溃都没试过） | 中。「最多丢 5 页」是**由单元测试推出的结论**，不是实测到的结果 |
| SimpleTex 公式 OCR 端到端 | 代码完整，且现在是**默认关闭的显式开关**（不勾选根本不会调用）；线上 `/api/formula-ocr` 上一轮实测返回 **500** | 中。需要 Worker 上配好 `SIMPLETEX_API_KEY`（否则恒 500） |
| 云端翻译（DeepL / OpenAI） | Worker 已部署，前端已配端点 | 中。未做端到端验证（需要有效的 DeepL key） |
| 云端 TTS（Azure） | 代码完整 | 中。未验证 |
| 「安装到桌面」 | manifest 正确 | 低 |

> **OCR 的特别说明**：换引擎**之前**，这条链路在真机上失败过 4 次
> （`data.blocks` 嵌套结构、纯文本兜底、多档降采样都是那个时期的修复）。
> `cdf2957` 把 Tesseract.js 整条替换为 PaddleOCR，**上述失败模式随引擎一起消失，
> 但也意味着「这套代码在真实扫描件上从没跑过」**。
>
> **§5.10 补记（`780c54c`）**：这套代码此后在真机上被认真跑过一轮 —— 结论是
> **应用本身没有问题**：卡住的是**内核过旧的外壳浏览器**（360），进程在第一次推理时直接消失，
> **不抛异常、页面被重载**。六轮排查、四个被否掉的假设，以及「开始前的能力检测」这个修法见 §5.10。
>
> 另：`src/**/*.test.ts` 里没有任何 `katex` / `$$` 断言 —— **`cdf2957` 新增的数学公式渲染至今没有自动化测试覆盖**。
>
> 另：**OCR 结果的持久化时机**（§5.9 缺陷 21）已有单元测试，但「真机中断后书库里确实留着已识别的部分」
> 没有实测过。注意这条与本表的「识别准确率」是两个不同的问题：**一个是准不准，一个是丢不丢**。
>
> 如果你要接手，**第一件事应该是跑通一次真实扫描件的 OCR**（见 §8 R1），而不是加新功能。

### 4.3 已清理的死代码与技术债

#### 本轮已清理（原先列在「技术债 / 待办」里，现在**已经不存在了**）

| 位置 | 为什么是死代码 | 处置 |
|---|---|---|
| `src/lib/ocrWordExtraction.ts` | 从 **Tesseract v7 的嵌套输出**（`blocks[].paragraphs[].lines[].words[]`）提词的模块；换成 PaddleOCR 后 `ocrEngine.ts` 直接读平铺的 `result.results[]`，全仓库**只有它自己的测试** import 它 | **已删除** |
| `src/lib/ocrWordExtraction.test.ts` | **13 个用例**在测一个没有生产调用方的模块 | **已删除**（本轮测试数 −13 就是它） |
| `src/lib/pdfTextLayer.ts` | 定义了 `addTextLayerToPdf`，但全仓库无任何调用方（grep `addTextLayerToPdf` 只命中它自己的定义行） | **已删除** |
| `pdf-lib@^1.17.1` | 删掉 `pdfTextLayer.ts` 后，`src/`、`worker/`、`scripts/` 里 grep `pdf-lib` / `PDFDocument` 零命中 | **已从 `package.json` 移除** |
| `jszip@^3.10.2` | 全仓库没有任何 `from 'jszip'` / `require('jszip')` / `import('jszip')`；`epubParser.ts` 只在**注释**里提过 "JSZip"。`epubjs` 自己的 `dependencies` 里带 `jszip: ^3.7.1`，所以 `node_modules/jszip` 依然存在（已实测） | **已从 `package.json` 移除**（只是移除应用层冗余声明，不是从磁盘上删包） |
| `rehype-katex@^7.0.1` | 全仓库无任何 import（`src/` 里 grep `rehype` 零命中）；公式渲染实际由 `BlockRow.tsx` 直接调 `katex.renderToString()` 完成 | **已从 `package.json` 移除** |

> 删除前已逐个 grep 确认无生产引用。`src/lib/ocrTypes.ts` 第 11 行的注释原先把 `pdfTextLayer`
> 列为需要类型定义的模块之一，该名称也已同步删除。
> 依赖总数因此从 **29（19 + 10）降到 26（16 + 10）**；`npm install --ignore-scripts --no-audit --no-fund`
> 实测输出 `removed 23 packages in 1s`（exit 0）。

#### 仍未处理的遗漏

| 位置 | 问题 | 建议 |
|---|---|---|
| OCR 语言选择器（`OcrLang` / `OCR_LANG_OPTIONS`） | UI 上仍有语言下拉框，但 `OcrEngine.initialize(_lang)` 的参数**已不被使用**（PaddleOCR 是全字典多语言） | 决定是让选择器影响 `model`，还是从 UI 上撤掉 |
| `src/lib/ocrPostProcess.ts` 里的历史叙述 | 描述「tesseract v7 把词输出从平铺改成嵌套」等过去故障成因的段落 | **保留**（是历史事实，不是错误） |
| 旧的 `pdfWorker.ts` | 已删除，但 `docs/03` 里仍有它的历史记录 | **保留**（是历史，不是错误） |

### 4.4 最近的提交做了什么（`cdf2957` → `780c54c`，HEAD = `780c54c`）

按时间升序排列（作者字段为提交里的原始值）。

| commit | 日期 | 作者 | 主题 | 实质改动 |
|---|---|---|---|---|
| `cdf2957` | 2026-10-06 21:30 | Mercuryof37 | feat: 数学公式渲染 + OCR 引擎升级为 PaddleOCR | 13 个文件、**+1245 / −322 行**。移除 `tesseract.js@^7.0.0`，新增 `ppu-paddle-ocr@6.6.0` + `onnxruntime-web@1.30.0`（模型 `V6_SMALL_MODEL`）；`src/lib/ocrEngine.ts` 重写（540 行，非空行 463）；新增 `katex@0.19.0` / `remark-math@6.0.0` / `rehype-katex@7.0.1`，Markdown 支持 `$行内$` 与 `$$块级$$` |
| `3d4a2ad` | 2026-10-06 22:06 | Mercuryof37 | fix: header/footer filtering, superscript rendering, and display math | 三件事：① **页眉页脚过滤**（`src/lib/ocrPostProcess.ts`，`HEADER_FOOTER_MARGIN_RATIO = 0.05`、`HEADER_FOOTER_FONT_RATIO = 0.85`：落在页面上下各 5% 边距内、且字号小于全页字号中位数 0.85 倍的行判为页眉/页脚丢弃）；② 修掉「单行的 `$$...$$` 被当成行内公式」这个真实缺陷；③ 加入 Unicode 上下标检测，交给 KaTeX 渲染。**另外把 ONNX WASM 改成从 CDN 加载**并新增 `scripts/clean-onnx-wasm.mjs`（见 §3） |
| `d7a5bae` | 2026-10-06 22:13 | Mercuryof37 | fix: switch SW to autoUpdate + skipWaiting to prevent stale chunk errors | `registerType: 'prompt' → 'autoUpdate'`、`skipWaiting: false → true`。**这是错误方向**（见 §5.6.2）；它留下的「prompt 模式 UI 永不触发」问题已在本轮拍板处理（保留 `autoUpdate` + 删除死 UI，见 §5.7） |
| `5184bde` | 2026-10-06 22:20 | Mercuryof37 | feat: integrate SimpleTex formula OCR into recognition pipeline | 新增 `src/services/formulaOcrService.ts`（73 行）与 `worker/api-proxy.ts` 的 `/api/formula-ocr`；`ocrEngine.enhanceFormulaRegions()` 在检测到公式候选区域时**自动**把裁剪图发给第三方 SimpleTex。**这是本项目第一次把文档像素送出本机**（见 §1 T2） |
| `a766d3f` | 2026-10-06 22:39 | Universal Reader Dev | fix(pwa): stop serving stale index.html so lazy chunks never 404 | 陈旧 chunk 故障的**真因修复**：去掉 `navigateFallback`，导航请求改 NetworkFirst（见 §5.6.3） |
| `aa8827a` | 2026-10-06 22:51 | Universal Reader Dev | fix(pwa): seed the navigation cache so offline cold start works | 补上 NetworkFirst 引入的离线冷启动空档：新增 `src/lib/pwaOffline.ts` + 8 个单测（见 §5.6.4） |
| `f549173` | 2026-10-06 | Mercuryof37 | feat(privacy)!: make the formula upload opt-in, drop dead code and unused deps | 上一轮的三项决策：公式上传改为默认关闭的显式开关（§5.8）、删掉 prompt 模式的死 UI（§5.7）、删除 `ocrWordExtraction.ts` / `pdfTextLayer.ts` 与三个未使用依赖（§4.3） |
| `f331393` | 2026-10-06 | — | 文档同步 | 把上一轮的三项决策与实测数字写进 `HANDOFF.md` / `README.md`。**无代码改动** |
| `fc79896` | 2026-10-06 | — | fix(ocr): stop losing a whole scan to a mid-run reload, and defer that reload | **本轮第一个提交**：修 §5.9 缺陷 21 的两个修法 —— 导入/OCR 期间推迟自动刷新（`pwa.ts` + `PwaPrompt.tsx`）与 OCR 中途落盘（`ocrTypes.ts` + `pdfParser.ts` + `libraryStore.ts`），新增 `ocrCheckpoint.test.ts` 9 个用例 |
| `ed66ba8` | 2026-10-06 | — | 补顺序守卫测试（推迟刷新） | **上一轮第二个提交**：新增 `src/lib/pwaReload.test.ts`（**当时 7 个用例 / 96 行**），针对「导入/OCR 期间**推迟刷新**」做**顺序**断言 —— 钉住「先检查 `importing`、再决定要不要 `reload()`」这一次序，以及「被推迟时置 `updatePending`」与「工作结束后 `PwaPrompt` 才调 `reloadNow`」。**只新增测试文件、不改产物**，因此它与 `fc79896` 的部署产物**完全相同** |
| `780c54c` | — | — | **最新一轮**（提交主题与作者字段**未逐字复核**，本行按已知事实描述） | 新增 `src/lib/ocrSupport.ts`（**104 行**）+ `src/lib/ocrSupport.test.ts`（**68 行 / 5 个用例**）：**在 OCR 开始前做能力检测**（`WebAssembly` 是否存在 + WASM SIMD 是否支持，用一个最小的 `v128` 模块跑 `WebAssembly.validate`），不支持时在 OCR 对话框里直接说明原因并给出替代浏览器，且说明文字版 PDF 与 Markdown / TXT / EPUB 不受影响；`crossOriginIsolated` **只记录、不判定**。**这一轮之前还落过几个提交**（模型同源自托管、只启用 WASM、`numThreads = 1` 与去掉 `toBlob`、`OCR_RENDER_DPI` 300 → 200），**它们各自的哈希本文未记录**，改动内容见 §5.10 |

> 注：`a766d3f` / `aa8827a` 的作者是 `Universal Reader Dev`（其余几个是 `Mercuryof37`），
> 主题前缀也因此从 `fix:` 变成 `fix(pwa):`。
>
> 注：`ed66ba8` 与 `780c54c` 的提交信息与作者字段未逐字复核，那两行按已知事实描述
> （`ed66ba8` 只新增测试文件、与 `fc79896` 产物相同；`780c54c` 的改动内容见 §5.10）。
>
> 注（**用例数会变，不要照抄旧数字**）：`src/lib/pwaReload.test.ts` 与 `src/lib/ocrCheckpoint.test.ts`
> 现在**各有 10 个用例** —— 此后又补进了「**已导入但还没点开始识别的扫描件**也算忙」（`state.scannedPdfPending`）、
> 「离线时不自动刷新」，以及「**第一页成功产出内容时立刻落盘**」这几条。
> 上表按**提交当时的**事实记录，现状以仓库里的测试文件为准。

---

## 5. 架构

### 5.1 数据流

```
用户拖入文件
    │
    ▼
parsers/index.ts  ← 按扩展名分发（注册表模式）
    ├─ .md/.txt  → 静态加载（依赖 ~100KB）
    └─ .pdf/.epub → 动态 import（依赖合计 ~760KB，仅按需下载）
    │
    ▼  统一收敛为 DocDocument { id, title, format, blocks[], toc[], metadata }
    │
    ├──▶ Dexie 事务写入：documents（元信息）+ blocks（正文，整篇一行）
    └──▶ libraryStore.currentDoc（内存镜像）
              │
              ▼
        ReaderView（唯一编排层）
              ├─▶ useVirtualWindow        只渲染可见区 ±6 项
              ├─▶ BlockRow                原文 + 译文 + 高亮
              ├─▶ useTtsReader            朗读状态机
              ├─▶ useViewportTranslation  视口懒翻译（并发 3）
              └─▶ annotationsStore ──▶ Dexie.annotations
```

**关键设计：解析后拍平成线性数组。** 阅读器的三件核心事（滚动、朗读、批注）
都按"段"为单位，保留语法树意味着三处都要额外遍历，收益为负。

### 5.2 内容模型（`src/types/content.ts`）

```ts
DocDocument   { id, title, format, blocks: ContentBlock[], toc, metadata }
ContentBlock  { id, type, content, translations: Record<lang,string>, metadata }
Annotation    { id, docId, blockId, type, anchor?: StableAnchor, content?, color, tags }
StableAnchor  { prefix, suffix, offset, length, selectedText }
```

### 5.3 IndexedDB 五张表（`src/lib/db.ts`）

| 表 | 索引 | 说明 |
|---|---|---|
| `documents` | `id, title, format, metadata.created` | **只存元信息**，列表页只读这张表 |
| `blocks` | `docId` | 正文与目录，一篇一行，便于原子写入 |
| `annotations` | `id, docId, blockId, type, createdAt` | 批注 |
| `progress` | `docId` | 阅读进度，与正文分离以免翻页重写整篇 |
| `translations` | `id, targetLang` | 译文缓存，键为 `hash(原文)+语言`，**跨文档复用** |

### 5.4 状态分层（重要）

| Store | 持久化 | 内容 |
|---|---|---|
| `settingsStore` | localStorage | 主题、字号、语言、朗读参数、**公式上传开关（`formulaOcrEnabled`，默认 `false`）** |
| `libraryStore` | 无（每次从 IndexedDB 重建） | 文档列表、当前文档、导入状态 |
| `annotationsStore` | 无（同上） | 当前文档的批注 |

**铁律**：设置类存 localStorage，数据类存 IndexedDB。
混用会导致"改一次字号写一次数据库"。

> **本轮补充**：`src/lib/pwa.ts` 的 `PwaState` 新增两个成员 ——
> **`updatePending: boolean`**（有已接管的新版本、但刷新被推迟）与
> **`reloadNow: () => void`**（立刻刷新）。它属于**界面层的临时标志**，同样**刻意不做持久化**：
> 刷新之后这个标志就该消失（刷新本身即是它的目的）。
> `libraryStore` 的 `importing` 是这两个标志的判断依据 —— 正在导入/OCR 时不刷新（见 §5.9）。
>
> ⚠️ 也正因为 `libraryStore` **刻意不做持久化**（`src/store/libraryStore.ts` 第 11–13 行的注释
> 写明了理由：正文太大，这里只是 IndexedDB 的内存镜像，靠 `init()` 重读保证只有一份事实来源），
> 一次刷新会连同 `error` / `ocrProgress` / `ocrSummary` / `scannedPdfPending` 一起清空 ——
> **故障现场也随之消失**。这正是 §5.9 缺陷 21「完全没有提示」的来由。

### 5.5 PDF 解析的特殊性

**pdf.js 运行在独立 Web Worker 中**，入口是 `src/parsers/pdfWorkerEntry.ts`：

```ts
import '@/lib/polyfills';                        // ⚠️ 必须在前
import 'pdfjs-dist/build/pdf.worker.min.mjs';
```

**这两行的顺序不能改。** 原因见 §6 缺陷 1 —— Worker 有独立的原型链，
主线程打的 polyfill 补丁它看不到，而 pdf.js 需要的 `toHex` 只在 worker 里调用。

`src/parsers/pdfRuntime.ts` 负责创建并复用这个 Worker，
并通过 `copy-pdfjs-wasm.mjs` + `wasmUrl` 提供 JBIG2 / JPEG2000 解码器。

### 5.6 PWA 陈旧 chunk 故障：现象 → 真因 → 修法 → 证据

**这是本轮最重要的事件**（`d7a5bae` → `a766d3f` → `aa8827a` 三个提交都在处理它）。

#### 5.6.1 现象

用户导入 `习题5-10月19日交(1).pdf` 时报：

```
Failed to fetch dynamically imported module:
https://universal-reader.pages.dev/assets/pdfParser-CiRxJgol.js
```

特征：**页面本身正常、md / txt 正常，只有按需加载的解析器（pdf / epub / ocr）炸**。
原因是 md/txt 的 chunk 在入口依赖图里，而 pdf/epub/ocr 是动态 `import()`。

#### 5.6.2 真因（读源码证实，不是推测）

`vite.config.ts` 里原来的 `navigateFallback: '/index.html'` 会注册一条 `NavigationRoute`，
其 handler 由 `createHandlerBoundToURL` 绑定，**直接返回预缓存里的 `index.html`，不经过网络**。

证据：`workbox-build@7.4.1` 的 `build/templates/sw-template.js` 第 52–58 行显示，
`navigateFallback` 生成的 `NavigationRoute` 注册在 `runtimeCaching` 各路由**之前**，
而 Workbox 按注册顺序匹配路由 —— 因此只要设了它，**导航请求永远命中预缓存**。

失败链：

```
旧 SW 递出旧 index.html
  → 它引用的是旧构建的 chunk 哈希
  → 新部署后服务器上那些文件已被删除
  → 动态 import 一个不存在的文件
  → Failed to fetch dynamically imported module: .../pdfParser-CiRxJgol.js
```

`d7a5bae` 把 `registerType` 改成 `autoUpdate`、`skipWaiting` 改成 `true` —— 这是**错误方向**：
`skipWaiting` 管的是「新 SW 何时接管」，**管不了「已经接管的 SW 主动把旧 HTML 递给用户」**。用错了杠杆。
（它留下的副作用是「代码按 prompt 模式写、实际跑 autoUpdate」，本轮已拍板收尾，见 §5.7。）

#### 5.6.3 `a766d3f` 的修法：导航请求改走网络优先

- `navigateFallback: undefined` —— 不再注册任何 HTML 预缓存路由
- 新增显式导航路由：`urlPattern: ({request}) => request.mode === 'navigate'`、
  `handler: 'NetworkFirst'`、`cacheName: 'html-navigation'`、
  `networkTimeoutSeconds: 3`、`expiration.maxEntries: 8`、
  `cacheableResponse.statuses: [0, 200]`
- 语义：**在线拿服务器最新 HTML**（→ 它引用的 chunk 必然存在），**离线回退上次缓存**
- 新增 `src/lib/preloadRecovery.ts`（+ 11 个单测）：监听 `vite:preloadError`，
  用 DOM 直接插入提示（React 挂载前也能用），自动重载一次；
  用 `sessionStorage` 标志 `universal-reader:chunk-reload` 防止断网时无限重载

#### 5.6.4 `aa8827a` 的修法：补上 NetworkFirst 引入的新空档

NetworkFirst **只回退它自己的 `html-navigation` 缓存**，而这个缓存要等
「SW 接管之后的第一次导航」才会被写入。于是：

```
首次访问（SW 装好，但这次导航不是它处理的）
  → 用户直接断网
  → 打开已安装的应用（这是一次导航）
  → 网络失败 + 缓存为空
  → 白屏
```

「装上就能断网读」正是核心卖点，必须补。修法：

- 新增 `src/lib/pwaOffline.ts`：`NAVIGATION_CACHE_NAME = 'html-navigation'`，
  `seedNavigationFallback()` 在 `onRegisteredSW` 时趁在线 `fetch('/')` 并 `cache.put('/', response)`。
  页面与 SW 同源、共享同一套 Cache Storage，直接写入合法；失败只告警不上抛，非 2xx 不写入
- **为什么不直接用 `navigateFallback` 解决离线？** 见 5.6.2 —— 它会重新引入本次修复的 bug，
  两者**互斥**
- 新增 `src/lib/pwaOffline.test.ts`（8 个用例）：读 `vite.config.ts` 把 `NAVIGATION_CACHE_NAME`
  与配置里的 `cacheName` 钉死，并断言导航路由保持 NetworkFirst、保留超时、
  且不得出现真的 `navigateFallback`。
  **坑**：断言前必须先剥掉注释 —— 那段解释性注释里本身就写着 `navigateFallback: '/index.html'`
  （第一次写就踩了这个）
- 拆成独立模块的原因：`pwa.ts` 顶层 import 了 `virtual:pwa-register/react`，
  该虚拟模块 vitest 解析不了；把纯逻辑摘出来才能直接测

### 5.7 ✅ 已决策：保留 `autoUpdate`（本轮拍板，**不要再翻案**）

**这一条上一轮是「待决策」，本轮已拍板并落地：选 (b) 承认自动更新，把 prompt 模式那套
永不触发的 UI 删掉。** 下面是决策依据与代价。

现状（`vite.config.ts` **未改动**）：

| 位置 | 现在是什么 |
|---|---|
| `vite.config.ts` | `registerType: 'autoUpdate'` + `skipWaiting: true` + `clientsClaim: true` |
| `src/lib/pwa.ts` | `PwaState` 收窄为 **`{ offlineReady, dismiss }`**；顶部注释整段重写为记录本决策 |
| `src/components/PwaPrompt.tsx` | 只剩两种提示：离线中 / 已可离线使用（`Banner` 的 `tone` 收窄为 **`'offline' \| 'ready'`**） |

#### 为什么 prompt 模式那套 UI 是死代码

读 `node_modules/vite-plugin-pwa@1.3.0/dist/client/build/react.js` 可确认，`autoUpdate` 模式下
编译期常量 `auto === true`，于是：

1. 第 22–27 行：`updateServiceWorker()` 的函数体是 `if (!auto) { sendSkipWaitingMessage?.() }`
   → **它是个空操作**；
2. 第 56–85 行：`onNeedRefresh` 只在 `else`（prompt 分支）里被调用 → **`needRefresh` 永远为 `false`**，
   `PwaPrompt.tsx` 的「有新版本可用 / 立即更新」提示条**永远不会出现**；
3. 第 42–50 行：`activated` 事件在 `event.isUpdate || event.isExternal` 为真时调用 `window.location.reload()`
   → **页面会自动重载**。

所以 **prompt 模式留下的那段 UI 从来不会被触发**，留着只会让人误以为「用户可以选择何时更新」。
本轮按「删掉而不是留着装作能用」处理：

| 位置 | 删了什么 |
|---|---|
| `src/lib/pwa.ts` | `PwaState` 从 `{ needRefresh, offlineReady, update, dismiss }` 收窄为 **`{ offlineReady, dismiss }`**；删掉 `updateServiceWorker` 的解构与 `update()`；`dismiss()` 现在只清 `offlineReady` |
| `src/components/PwaPrompt.tsx` | 删掉 `needRefresh` 分支（「有新版本可用」文案 + 「立即更新」按钮）与 `RefreshCw` 图标导入；`Banner` 的 `tone` 类型由 `'update' \| 'offline' \| 'ready'` 收窄为 **`'offline' \| 'ready'`**；组件注释里的三行优先级表改为两行，并加了一节「为什么没有『有新版本可用』」 |

#### 代价（必须说清楚）

**页面会在无预警的情况下自动重载**：正在读的**滚动位置、展开的译文、进行中的 OCR 都会丢**。
这恰好是上一轮 `pwa.ts` 注释里明确反对的那一种行为 —— 决策的理由是：这个代价换来了
「陈旧 HTML 引用已删除 chunk」这类故障能自愈，而导航本身已走 NetworkFirst（§5.6.3），
在线时拿到的始终是服务器上最新的 HTML。

#### 将来若想减少打扰

`vite-plugin-pwa` 提供了 `onNeedReload` 钩子：`registerSW({ onNeedReload })`，
可以自己决定何时调用 `window.location.reload()`（例如「没有正在进行的 OCR 时才 reload」）。

> **更新（本轮 `fc79896`）：这件事已经做了** —— 见 §5.9 修法一。导入/OCR 期间推迟刷新，
> 并加了「新版本已就绪」横幅与「立即刷新」按钮。**§5.7 的决策本身没有翻案**
> （仍然保留 `autoUpdate`），本轮只是把上面这条代价里最严重的一项缓解掉了。
> 仍然建议**不要再做的事**：不要把 `vite.config.ts` 的 `registerType` 改回 `prompt`。

> **不要再做的事**：不要把「有新版本可用 / 立即更新」分支加回 `PwaPrompt.tsx`；
> 在没有重新决策之前，不要动 `vite.config.ts` 的 `registerType` / `skipWaiting`。

### 5.8 ✅ 已决策：公式云端识别改为默认关闭的显式开关（本轮拍板，**不要再翻案**）

**这是全应用唯一会把文档内容送出本机的路径**，本轮把它从「自动触发、无法关闭」
改为**显式 opt-in**，于是上一轮记的 T2 隐私张力**已收口**：默认路径恢复为「零上传」。

#### 改了什么

| 位置 | 改动 |
|---|---|
| `src/store/settingsStore.ts` | 新增字段 **`formulaOcrEnabled: boolean`，默认 `false`** 与 setter `setFormulaOcrEnabled`；interface 里带一段长注释说明为什么必须默认关闭 |
| `src/lib/ocrEngine.ts` | `enhanceFormulaRegions()` 在 `words.length < 3` 判断之后、`detectFormulaRegions()` **之前**插入早退：`if (!useSettingsStore.getState().formulaOcrEnabled) return words;`（开关判断早于任何网络调用，不做无用功） |
| `src/services/formulaOcrService.ts` | **第二道防线**：真正执行上传的 `recognizeFormula()` 自己也检查开关，关闭时**抛错拒绝**（而不是静默返回空串）。理由：只靠调用方自觉不够，将来任何新调用方忘了检查开关，就会静默把文档内容发出去 |
| `src/components/FileUploadZone.tsx` | OCR 对话框「识别页数」下方新增复选框 **「上传公式区域以换取更准的公式」**，文案写明「默认关闭 —— 不打开就没有任何内容离开本机，公式会保留为 OCR 的原始文字（可能是乱码）」 |
| `src/store/formulaOcrPrivacy.test.ts` | 新增 **8 个用例**：默认值为 `false`；setter 可开可关；引擎源码确实读取该设置；开关判断早于 `detectFormulaRegions(words)`；早于 `await recognizeFormula(`；关闭时是 `return words` 形式的提前返回；**服务端第二道防线关闭时拒绝执行（抛错而不是发请求）**；**服务源码里的开关检查早于 `await toPngBuffer(` 与 `await fetch(`** |

#### 已收口的部分

**默认关闭 → 一个字节都不外发、不发起任何网络请求**；上传只在用户识别前明确勾选时发生。
「文档全程留在本机浏览器」这句承诺在默认路径上重新成立。

#### 必须如实保留的残余点

- 勾选后仍会把**页面局部像素**上传到第三方 `server.simpletex.cn`（经自建 Worker 转发）
- 勾选后**需要联网**；离线时该步骤失败，并保留 OCR 的原始识别结果
- Worker 仍需配置 `SIMPLETEX_API_KEY`，否则该端点返回 500（**线上实测当前就是 500**）
- 开关**没有**在应用内提供「哪些内容被上传过」的审计视图
- 开关在**真实浏览器里的行为未验证**（只有单元测试与源码断言）：勾选 / 不勾选各跑一次 OCR
  至今没做过，见 §4.2

> **不要再做的事**：不要把默认值改回 `true`；不要绕过开关直接调用 `recognizeFormula()`；
> 不要删掉 `formulaOcrService.ts` 里那道「第二道防线」的检查。

### 5.9 缺陷 21「扫描结果全丢」故障：现象 → 真因 → 修法 → 证据

**这一条是接手者最容易误判的一条**：它长得像识别器故障，其实与识别毫无关系；
它长得像「静默失败」，却连一条诊断都没有。修复见提交 `fc79896`。

#### 5.9.1 现象（用户原话）

> 「能正常扫描，但扫描完看不到文档，识别框下方也没有创建新的项目」

更精确的特征：**没有红色错误横幅、没有「OCR 完成」摘要、书库里没有新条目 —— 什么都没有。**
用户已确认：**页面确实自己刷新过。**

#### 5.9.2 真因（三件事叠加，缺一不可）

| # | 事实 | 位置 |
|---|---|---|
| 1 | `autoUpdate` 的 SW 在新版本接管时会**无预警** `window.location.reload()` | `vite-plugin-pwa@1.3.0` 的 `client/build/react.js`：`activated` 且 `event.isUpdate` → `window.location.reload()`；本项目 `vite.config.ts` 是 `registerType: 'autoUpdate'` + `skipWaiting: true` + `clientsClaim: true` |
| 2 | 刷新会把 OCR 相关状态**全部清空** | `libraryStore` **刻意不做持久化**（`src/store/libraryStore.ts` 第 11–13 行注释写明）。刷新后 `error` / `ocrProgress` / `ocrSummary` / `scannedPdfPending` 全为初始值，`documents` 从 IndexedDB 重读 |
| 3 | 整次 OCR 的结果**只在最后一页跑完后**才写库 | 原先 `startOcr` 只在 `ocrParsePdf` 返回后才调 `saveDocument`（`libraryStore.ts`） |

叠加结果：**一次部署正好落在扫描途中 → 十几分钟的工作被清空，且没有任何痕迹。**
第 2 条是「为什么连报错都没有」的关键：状态本来就随刷新一起没了，**没有任何东西留下来报错**。

**必须与另外两件事区分开**（否则下一轮会往错的方向排查）：

| 容易误判成 | 为什么不是 |
|---|---|
| **识别器（PaddleOCR）不准 / 坏了** | **识别器本身没有任何问题**。本次现象与识别质量无关：不是"识别错了"，是"识别完了没留下" |
| `ocrParsePdf` 的「整本空白 / 没返回词」抛错分支（`!allDrafts.length`） | 那条分支会**显示很长一段诊断错误**。本轮故障的特征恰恰是**完全没有提示** —— **有长诊断的是那条，什么都没有的是这条**。两者是不同的故障，修法也毫无关系 |

#### 5.9.3 修法一：导入/OCR 期间**推迟自动刷新**

| 位置 | 改动 |
|---|---|
| `src/lib/pwa.ts` | `useRegisterSW` 现在传入 **`onNeedReload`**。不传时 `vite-plugin-pwa` 会直接 `window.location.reload()`；传了之后**由我们决定时机**。回调逻辑：`if (useLibraryStore.getState().importing) { setUpdatePending(true); return; }` —— 正在导入/OCR 就**不刷新**，只置一个标志；否则保持 autoUpdate 原有的立即刷新语义。`PwaState` 新增 **`updatePending: boolean`** 与 **`reloadNow: () => void`**（见 §5.4）|
| `src/components/PwaPrompt.tsx` | 新增**「新版本已就绪」横幅**（含**「立即刷新」按钮** + 文案「正在识别，完成后会自动刷新」），优先级排在「已可离线使用」**之前**。新增一个 `useEffect`：当 `updatePending && !importing` 时调用 `reloadNow()` —— **工作一结束就自动刷新**。理由：用户选的是 autoUpdate，推迟只是为了不毁掉进行中的工作；工作结束后结果已落盘（检查点 + 最终保存），此时刷新不会丢东西。另外把 `RefreshCw` 图标（上一轮曾随死 UI 一起删掉）与 `useLibraryStore` 的导入加了回来 |
| 单元测试 | 修法一的**顺序**断言在 `src/lib/pwaReload.test.ts`（**7 个用例 / 96 行**，`ed66ba8` 补上的）；修法二的检查点规则在 `src/lib/ocrCheckpoint.test.ts`（9 个用例，见 5.9.5）。**修法一的真机行为仍未验证**（§5.9.6）—— 单元测试只能钉住"代码写了什么"，钉不住"部署恰好落在扫描途中时会怎样" |

#### 5.9.4 修法二：OCR 期间**中途落盘**（丢失窗口从「整次扫描」降到「最多几页」）

| 位置 | 改动 |
|---|---|
| `src/lib/ocrTypes.ts` | 新增两个导出：**`OCR_CHECKPOINT_EVERY_PAGES = 5`** 与纯函数 **`shouldCheckpoint(pageNum, totalPages)`**（便于单测）。规则：`pageNum >= totalPages` 一定为真（**末页必落盘**，否则试跑 3 页这种最常见的用法永远等不到检查点）；否则 `pageNum % 5 === 0`。非法输入（0 / 负数 / NaN）返回 `false` |
| `src/parsers/pdfParser.ts` | `OcrParseOptions` 新增可选回调 **`onCheckpoint?: (snapshot: DocDocument) => void \| Promise<void>`**；**`const docId = uid()` 移到页循环之前**（原先 id 是在最后 `buildDocument({ docId: uid() })` 时才生成的，**中途落盘根本不可能** —— 每次检查点都会造出一个新 id，书库里会堆一堆半成品而不是覆盖同一条）；新增 `const snapshot = (): DocDocument => buildDocument({ docId, ... })`；每页处理完（`page.cleanup()` 之后）判断：本页确实产出了内容块 **且** `shouldCheckpoint(pageNum, totalPages)` → `await onCheckpoint(snapshot())`。落盘失败**只告警不中断**（`console.warn` + 继续）—— 保障措施不该反过来毁掉它保护的任务。最终 `buildDocument` **复用同一个 `docId`**（写的是 `docId,` 而不是 `docId: uid()`），所以最终保存是**覆盖**检查点写下的那条，不会留下「半成品 + 完整版」两条 |
| `src/store/libraryStore.ts` | 新增 `onCheckpoint`：`await saveDocument(snapshot)` + `set({ documents: await listDocuments() })`。刻意**只刷新书库列表，不设置 `currentDocId`** —— 扫描还在进行，界面应停在进度视图，不该突然跳到阅读器 |

> **与 §5.7 决策的关系**：这不是翻案。`autoUpdate` **保留不变**，`vite.config.ts` **未改动**；
> 本轮做的是把上一轮记为「已接受的代价」里**最严重的一项（进行中的 OCR 全丢）**消掉，
> 即 §5.7「将来若想减少打扰」里提到的 `onNeedReload` 思路，现在**已经做了**。

#### 5.9.5 证据

`src/lib/ocrCheckpoint.test.ts`（新增，**9 个用例 / 110 行**）：

1. 末页必落盘（10/10、3/3、1/1）
2. 每隔 5 页落一次，间隔中间不落
3. 第一页不落盘（总页数 > 1 时）
4. 丢失窗口有上界：237 页任务里相邻两次落盘的间隔 ≤ 5，且最后一次正好是末页
5. 非法输入（0 / 负数 / NaN）返回 `false`
6. parser 在页循环里调用 `await onCheckpoint(snapshot())`
7. parser 的 `docId` 声明在页循环**之前**
8. 循环之后不再出现 `docId: uid()`，且最终保存用的是 `docId,`
9. store 里 `onCheckpoint` 存在、且真的 `await saveDocument(snapshot)`

> 第 6–9 条是**读源码断言**，因为「只做一半」的实现能编译、能过测试，正是本项目记录过的
> 「看着对、跑起来不对」—— 所以链路两端都要钉。

**修法一（推迟刷新）的证据在另一个文件**：`src/lib/pwaReload.test.ts`（`ed66ba8` 补上，
**7 个用例 / 96 行**）—— 同样是读源码的**顺序**断言：`onNeedReload` 里 `importing` 的检查
必须出现在 `window.location.reload()` **之前**；被推迟时要置 `updatePending`，而不是静默什么都不做；
`PwaState` 要暴露 `updatePending` 与 `reloadNow`（界面需要它们）；`PwaPrompt` 在
`updatePending && !importing` 时才调 `reloadNow`。

其余门禁：`npx tsc -b` **exit 0**；`npx vitest run` **216 passed / 20 files**；
`npm run build` 通过产物校验。完整数字见 §4.1 的「本轮」表。

#### 5.9.6 必须如实保留的未验证点

- **两个修法都未在真实浏览器里验证过**：
  - 「部署正好落在扫描途中时不再丢失」需要**一次真实的部署落在一次真实的扫描中间**才能验；
  - 「中途落盘」只有单元测试与源码断言，**没有真机跑过一次会中断的长扫描**。
- 因此「新版本已就绪」横幅与「立即刷新」按钮**至今没有被人眼在真实浏览器里看到过**。
- 本轮的两个提交（`fc79896` + `ed66ba8`）**已推送，且部署已确认**（`fc79896` 的 `verify` 与
  `Cloudflare Pages` 两项 check 均 success；`ed66ba8` 与它产物相同）—— **但「产物已上线」
  不等于「修法已生效」**：上面两条真机行为依然未验证。见开头的表格与 §4.1。

#### 5.9.7 教训

> **保障措施的丢失窗口，必须由任务的时长来决定，而不是由实现的方便程度来决定。**
> 「最后一页跑完再落盘」在短任务上完全合理，在十几分钟的任务上等于把全部成果押在一次中断上。

> 另：本条再次印证 §6 元教训的那句话 —— 源码、类型检查、单测**全是绿的**，
> 故障发生在「**产物更新时机 × 运行时内存状态**」的组合上。

### 5.10 缺陷 22「OCR 第 1 页进程消失」：六轮排查 → 真因在浏览器内核 → 开始前的能力检测（`780c54c`）

**这一条与 §5.9 的现象几乎一样（都是「扫描完看不到文档」），但成因完全不同，必须分开读**：

| | §5.9 缺陷 21 | §5.10 缺陷 22（本节） |
|---|---|---|
| 真因在 | **应用自己**（SW 自动重载 × 状态不持久化 × 最后才落盘） | **浏览器一侧**（外壳浏览器内核过旧） |
| 触发条件 | 一次部署**正好落在**一次扫描中间 | **每次 OCR 都复现** |
| 修法 | `fc79896`：推迟刷新 + 中途落盘 | `780c54c`：**开始前做能力检测** |

**本节最重要的结论是：应用本身没有问题。** 同一条链路在 Chrome / Edge / Firefox 上正常，
只在**内核过旧的外壳浏览器**里崩溃 —— 这是用户自己一句话收束的（见 5.10.5）。

#### 5.10.1 现象（用户原话）

> 「能正常扫描，但扫描完看不到文档，识别框下方也没有创建新的项目」

后续确认：**完全没有错误提示** —— 没有红色横幅、没有「OCR 完成」摘要、书库里没有新条目。
用户能看到的只有一件事：**页面自己刷新了。**

#### 5.10.2 六轮排查：四个假设全部被证据否掉（**这是本节最有价值的部分**）

**接手的人必须知道哪些路已经走过、为什么走不通** —— 否则会把同一批实验再做一遍。

| 轮次 | 假设与改动 | 被什么否掉 |
|---|---|---|
| 1 · **SW 自动重载打断 OCR** | 导入/识别期间推迟刷新（`onNeedReload`，即 §5.9 修法一）；并加中途落盘（`OCR_CHECKPOINT_EVERY_PAGES = 5`，后改为**第一页成功就落盘**） | 应用自带诊断显示「**刷新来源：不是应用发起的**」—— 三条重载路径**都没有记录**（见 5.10.3）。**否掉** |
| 2 · **画布内存不足（OOM）** | `OCR_MAX_PIXELS` 40 MP → 20 MP | 实测画布只有 **8.3 MP（普通 A4）**，**从未碰到过上限**。**否掉** |
| 3 · **模型源不可达** | 模型改为**同源自托管**：`scripts/fetch-ocr-models.mjs` + `verify-dist` 硬校验 + `VITE_OCR_MODEL_BASE` | **这一步里确实有一个真问题**（见下方说明），但**它不是本故障的真因**：换同源之后轨迹只是往前推进到「开始识别」，然后**仍然死在同一处**。**作为「本故障的原因」被否掉** |
| 4 · **WebGPU 后端** | 强制 `executionProviders: ['wasm']` | 只启用 WASM 的版本**仍死在同一处**。**否掉** |
| 5 · **PNG 编码 + ONNX 线程池** | 直接把画布交给 `recognize()`（去掉 `toBlob`）；`ort.env.wasm.numThreads = 1` | **仍死在同一处**：轨迹停在 `onnx`，**从未到达 `onnx-done`**。**否掉** |
| 6 · **渲染 DPI 太高** | `OCR_RENDER_DPI` 300 → 200 | **仍死在同一处**。**否掉** |

> **六轮里没有一个假设成立**（第 3 轮只解决了一个**并存的**问题，见下）。
>
> **第 3 轮为什么值得单独说**：`huggingface.co` 在国内不可达；换成 `hf-mirror.com` 之后
> 浏览器**仍然**报 `TypeError: Failed to fetch`（而同一台机器上 PowerShell / Node 能完整下载，
> 镜像返回的 CORS 头也正确）—— 这一类差异（代理、扩展、DNS、公司网关……）无法从代码侧根治。
> 改成**同源发布**后模型问题**确实解决了**，但那只是让排查**向前推进了一格**：
> 轨迹从「初始化引擎」走到了「开始识别」，接着还是死。**修好一个真问题，不等于修好了这个故障** ——
> 这正是本条最容易误判的地方。

#### 5.10.3 能收敛的原因：应用自带的**会话级诊断**

用户**打不开控制台**（没有 DevTools），所以任何"看一眼 console"的排查方式都不可用。
为此在 `src/lib/sessionDiagnostics.ts` 里做了**会话级诊断**：写进 **`sessionStorage`（刷新不清空，关标签页才清）**，
并在 `DocumentLibrary` 顶部用**黄色横幅**直接显示。

| API | 作用 |
|---|---|
| `getReloadCount()` | 本页被加载了几次（> 1 就说明页面确实被重载过） |
| `noteReloadReason()` / `getLastReloadReason()` | 在**真正 reload 之前**记下原因 |
| `noteOcrStage()` / `getOcrStageTrail()` | OCR 的**阶段轨迹**，**保留最近 5 条**（`STAGE_HISTORY = 5`） |

三条（也是仅有的三条）应用内重载路径与它们的标记值：

| 路径 | 位置 | `noteReloadReason()` 的值 |
|---|---|---|
| SW 新版本接管 | `src/lib/pwa.ts` | `'sw-update'` |
| chunk 加载失败的自愈 | `src/lib/preloadRecovery.ts` | `'preload-error'` |
| 用户点「立即刷新」 | `src/lib/pwa.ts` 的 `reloadNow()` | `'manual'` |

**三条路径都没有记录 ⇒ 刷新不是应用发起的** —— 这一句就是前四轮假设的终结者：
它把「应用逻辑导致刷新」**整类原因一次性排除掉**了。

> **为什么轨迹要保留最近 5 条，而不是只留最后一条**：画布尺寸是在 `render` 阶段记的，
> 只留最后一条会被后面的 `recognize` 覆盖 —— 那正是判断「要不要继续砍内存」的关键数字
> （这个坑**已经踩过一次**，所以才有 `STAGE_HISTORY = 5`）。
>
> 阶段名一共 7 个：`engine-init` · `render` · `recognize` · `recognize-done` · `to-canvas` · `onnx` · `onnx-done`。
>
> ⚠️ **这个诊断模块本身没有自动化测试**（`src/lib/sessionDiagnostics.ts` 无对应 `.test.ts`）。
> 它是这次排查能收敛的关键工具，值得补测试。

#### 5.10.4 决定性的那条轨迹（用户原样贴回）

```
engine-init —— 开始初始化 OCR 引擎（首次需下载约 30MB 模型）
render —— 第 1 页：画布 1667×2223（15MB）
recognize —— 第 1 页：开始识别
to-canvas —— 第 1 页：原始尺寸 → 准备画布
onnx —— 第 1 页：原始尺寸 → 送入推理（1667×2223） · 设备内存约 8GB，JS 堆 32/1083MB
```

**顺序本身就是结论**：

1. 走到 `render` ⇒ **画布渲染成功**，而且只有 1667×2223（15MB）—— 不大；
2. 走到 `onnx` ⇒ **模型已加载、推理调用已经发出**；
3. **没有 `onnx-done`** ⇒ 进程死在**第一次推理**里，**没有留下任何 JS 痕迹**（没有异常、没有日志）；
4. **`JS 堆 32/1083MB`、`设备内存约 8GB`** ⇒ **内存完全空闲，OOM 假设被彻底排除**
   （32MB 是已用，1083MB 是上限 —— 不是"用了 1083MB"）。

**"进程消失、不抛异常、页面被重载"** 这三件事组合起来，只可能来自**宿主层**，不可能是 JS 逻辑错 ——
任何 `try/catch` 都拦不住它。这是那一轮唯一真正缩小了范围的推论。

#### 5.10.5 真因：用户一句话收束

> 「Firefox、Chrome、Microsoft Edge 都可以正常使用，但是 360 不行」

即：**应用本身没有问题**，是**那个浏览器的内核**：

| 事实 | 说明 |
|---|---|
| **内核过旧** | 本项目的浏览器基线是 **Chrome/Edge 119+、Firefox 121+、Safari 17.4+**（§2）；360 的内核**远低于此** |
| **内核被魔改** | 这类外壳浏览器普遍带注入模块与自有扩展，会把 ONNX 的 **WASM 运行时直接干掉** |
| **表现形式** | **进程消失、不抛异常、页面被重载** —— 所以既没有报错，也永远等不到 `onnx-done` |
| **「兼容模式」更差** | 它的「兼容模式」实际是 **IE 内核**；「极速模式」**也不一定支持 WASM SIMD** |
| **与内存无关** | 8GB 设备、JS 堆 32/1083MB 的当口进程就没了 —— 这不是 OOM 的形状（见 5.10.4） |

#### 5.10.6 修法：**在开始之前做能力检测**，而不是崩溃之后一路排查（`780c54c`）

新增 **`src/lib/ocrSupport.ts`**（104 行）：`detectOcrSupport()` 返回 `{ ok, reason?, details }`。

| 检测项 | 处理方式 | 理由 |
|---|---|---|
| `WebAssembly` 是否存在 | 不存在 ⇒ `ok: false` | 没有它，整个 OCR 无从谈起 |
| **WASM SIMD** | 用一个**最小的 `v128` 模块**（`SIMD_PROBE`，代码段用 `i8x16.splat`）跑 `WebAssembly.validate`，不通过就判不支持 | ONNX Runtime Web 用的是 **simd 构建**，内核太旧时实例化会失败乃至终止进程。**刻意不嗅探 User-Agent** —— UA 可以伪造，而且**同一款外壳浏览器的「极速模式」与「兼容模式」内核完全不同** |
| `crossOriginIsolated` | **只记录、不作为判定** | 它只影响**多线程**；本项目是**单线程**运行（`numThreads = 1`），拿它做判定会**把能用的环境误判成不能用** |

**界面**（`src/components/FileUploadZone.tsx`）：在 OCR 对话框里、**「开始识别」按钮上方**直接显示黄色提示块 ——
说明原因、**给出可执行的建议**（改用 Chrome / Edge / Firefox），并**说明文字版 PDF 与 Markdown / TXT / EPUB 不受影响**
（否则用户会以为整个应用不能用了）。

**`describeOcrSupport()`** 另给一行式摘要（`wasm=是，simd=否`），便于记进诊断轨迹。

**新增测试 `src/lib/ocrSupport.test.ts`（68 行 / 5 个用例）**：

| # | 用例 |
|---|---|
| 1 | 返回结构完整，且各字段类型正确 |
| 2 | 不支持时**必须**给出原因，且原因里含可执行建议（`Chrome\|Edge\|Firefox`）与「不受影响」 |
| 3 | 结论自洽：说支持就必须 `wasm` 与 `simd` 都为真 |
| 4 | 在 Node（vitest 环境、无 DOM）里也能安全求值，不抛异常 |
| 5 | 摘要是一行可读文本、**不含换行**（否则塞进轨迹那一行会散架） |

> **不要再做的事**：不要在开始 OCR 前跳过 `detectOcrSupport()`；不要把它改成 User-Agent 嗅探；
> 不要因为 `crossOriginIsolated === false` 就判不支持（单线程跑，那是误判）；
> 不要把「不支持」写成一句干巴巴的报错 —— 必须给出**可执行的替代方案**，并说明**哪些格式不受影响**。

#### 5.10.7 这一轮的其它关联改动（其中多数**在此之前已提交**）

| 位置 | 改动 |
|---|---|
| `scripts/fetch-ocr-models.mjs` | 构建时把模型下到 `public/ocr-models/`（**已 gitignore**，与 `public/pdfjs-wasm` 同理由：**第三方产物入库会与依赖版本漂移**）；来源按 `hf-mirror` → `huggingface.co` 顺序尝试；`OCR_MODEL_SOURCE` 可指定单一来源 |
| `scripts/verify-dist.mjs` | **模型缺失时让构建硬失败**（已做负向测试：把目录移走 → **exit 1**），而不是产出一个"能部署但 OCR 用不了"的站点 |
| `src/lib/ocrModelSource.ts` + `src/lib/ocrModelSource.test.ts`（**7 个用例**） | 默认 base **必须是同源 `/ocr-models`**，**绝不能是任何第三方域名**（断言里直接禁掉 `huggingface.co` / `hf-mirror.com`） |
| `src/lib/ocrExecutionProvider.ts` + `src/lib/ocrExecutionProvider.test.ts`（**4 个用例**） | 默认**只用 `['wasm']`**；`VITE_OCR_USE_WEBGPU=1` 才开回 `['webgpu', 'wasm']` |
| `src/lib/ocrRuntimeSafety.test.ts`（**5 个用例**） | 钉住 `ort.env.wasm.numThreads = 1`，且 `toBlob` **不再出现在** `ocrEngine.ts` 里；同时保留多档降采样（0.7 / 0.5 / 0.35）的兜底 |
| `src/lib/ocrTypes.ts` | `OCR_RENDER_DPI = 200`（原 300）、`OCR_MAX_PIXELS = 20_000_000`（原 40 MP） |
| `.env.example` 与 `src/vite-env.d.ts` | 新增 `VITE_OCR_MODEL_BASE`、`VITE_OCR_USE_WEBGPU` 两个变量的说明与类型 |

> **顺带发现、但还没有修的一处口径不一致**：模型三个文件合计 **29.9MB**
> （`src/lib/ocrEngine.ts` 自己的报错文案里写着 `检测模型 9.52MB · 识别模型 20.30MB · 字典 0.07MB（合计约 29.9MB）`，
> `scripts/fetch-ocr-models.mjs` 里的期望字节数也是这三个），
> **但界面与若干注释里仍写着「约 10MB」**（`FileUploadZone.tsx` 第 91、220 行，`ocrTypes.ts` 第 9、35 行，
> `pdfParser.ts` 第 466 行的注释）。**29.9MB 才是实测值**，接手时请把 UI 文案改过来（这是一处应当修掉的不一致）。

#### 5.10.8 一条反复踩到的工程教训：**注释里含有被断言的关键词**（本仓库踩了三次）

| 第几次 | 文件 | 踩法 |
|---|---|---|
| 第一次 | `src/lib/pwaOffline.test.ts` | 断言「配置里不得出现 `navigateFallback`」，而**解释它为什么不能用的注释里**就写着 `navigateFallback: '/index.html'` |
| 第二次 | `src/lib/pwaReload.test.ts` | 断言「`importing` 的检查在 `window.location.reload()` 之前」，而**解释「不传 `onNeedReload` 就会 reload」的注释里**就写着 `window.location.reload()` |
| 第三次 | `src/lib/ocrRuntimeSafety.test.ts` | 断言「源码里不再出现 `toBlob`」，而**解释为什么不再用 `toBlob` 的注释里**就写着 `toBlob` |

三次的形状完全一样：**读源码式断言**匹配到了**解释性注释里的同一个字符串**，从而得出**相反结论**。
正确做法是**断言前先剥掉注释** —— 这三个测试现在都这么做，例如
`SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1')`。

> **凡是"读源码做断言"的测试，第一行就该是剥注释。** 否则测试测的是"这句话有没有被提到"，
> 而不是"代码到底怎么写"。

#### 5.10.9 证据

| 检查 | 结果 |
|---|---|
| 提交 | **`780c54c`**（最新一轮的能力检测；这一轮之前还有几个提交，见 5.10.7，哈希本文未记录） |
| `npx vitest run` | **246 passed / 24 files**（上一轮记录为 20 个文件 / 216 个用例；本轮新增 `src/lib/ocrSupport.test.ts` **5 个用例**，连同 5.10.7 里的几个测试文件一起计入这 24 个文件） |
| 关键文件 | 新增 `src/lib/ocrSupport.ts`（**104 行**）· `src/lib/ocrSupport.test.ts`（**68 行**） |
| 浏览器基线（§2） | Chrome / Edge 119+、Firefox 121+、Safari 17.4+ —— 检测判据与这条基线一致（都落在 **WASM SIMD** 这一项上） |
| 用户侧的真机结论 | 「Firefox、Chrome、Microsoft Edge 都可以正常使用，但是 360 不行」（**这是本故障唯一的真机旁证，也是它的定论**） |

#### 5.10.10 必须如实保留的未验证点

- **能力检测在真机上的表现没有验证过**：本机**装不了 360**，也没有其它内核过旧的外壳浏览器可用，
  所以「真机上会不会被正确拦下」只有 `ocrSupport.test.ts` 的 5 个用例与 Node 环境下的求值，
  **没有一次真实浏览器验证**。
- **`src/lib/sessionDiagnostics.ts` 没有自动化测试**（5.10.3 里那张表全部是代码审阅的结论）。
- **PaddleOCR 在真实扫描件上的中文识别准确率仍未量化验证**（R1 依然成立）——
  已有的只是用户口径「Firefox、Chrome、Microsoft Edge 都可以正常使用」，**没有**证明"识别得准"。
- 本轮这一系列改动的**部署状态未核对**（未执行 git、未抓线上资源）。

#### 5.10.11 教训

> **与其在崩溃之后一路排查，不如在开始之前就把不支持的环境认出来。**
> 这场排查真正的成本不在修代码，而在**六轮假设全部落空**：
> 每一轮都要改代码、跑一次扫描、等结果，而每一次失败都**不提供任何新信息**，只是"还是死在这里"。

> **"进程消失、不抛异常、页面被重载"要立刻想到宿主层**（浏览器内核、GPU 进程、标签页回收），
> 而不是继续在 JS 里找。JS 侧的故障至少会留下一个异常或一条日志；
> 什么都不留，说明死的那一层**不归你的代码管**。本项目为此留下了两条可测的证据：
> **刷新来源**（三条路径有没有记录）与**阶段轨迹**（最后走到哪一步）。

> **一个问题里可能同时存在"真的坏了"和"不是它的错"两件事。**
> 模型取不到是真的（第 3 轮），但它不是本故障的原因；
> 把它当成原因，会让排查在"已经修好了"的错觉里多耗一轮。
> **判据只有一个：故障现象有没有变。** 轨迹往前推进了一格、然后死在同一处 —— 那就是**没修好**。

> **能力检测必须落在"能力"上，不是"身份"上。** UA 可伪造，同一外壳的两种模式内核还完全不同；
> 而 `WebAssembly.validate()` 问的是浏览器**能不能做这件事**，这正是我们要知道的答案。

---

## 6. 十五类真实缺陷（已修复，但要知道它们为什么发生）

完整版见 `docs/03-踩坑与修复记录.md`（⚠️ 该文件目前**不在仓库 `docs/` 下**，
只在本地归档目录 `universal-reader settings\docs\` 里；引用前请先确认）。
这里给**接手者最需要的浓缩版**。

| # | 缺陷 | 一句话教训 |
|---|---|---|
| 1 | polyfill 的上下文边界导致 PDF 完全无法导入 | **补丁只对执行它的那个 JS 上下文有效**。Worker 看不到主线程的 polyfill。修复尝试了 4 次 |
| 2 | 为一个错误类拖进整棵依赖树 | 跨模块共享的**类型与常量必须与重量级实现分离**。一行 import 让首屏包 68KB → 201KB |
| 3 | PDF 断段阈值用固定倍数 | 排版参数**必须自适应**。12pt/1.2 倍行距下"行距 > 字号"恒成立，每行都成了独立段落 |
| 4 | `File.text()` 按 UTF-8 硬解中文 txt | 浏览器原生 API 的默认行为**未必适用中文环境**。需 BOM → U+FFFD 比例 → GB18030 三级降级 |
| 5 | 解析出 0 个块却静默成功 | **静默失败比报错更糟**。用户看到"导入成功"却一片空白 |
| 6 | 批注锚点在段首误命中 | **空字符串参与匹配永远是陷阱**。`indexOf('')` 恒为 0 |
| 7 | ArrayBuffer 被转移后仍被复用 | `postMessage` 的 transfer 会让主线程侧 buffer 失效，**且不可恢复**。必须在交出前拷贝 |
| 8 | `throw` 可以抛任何值 | 捕获方写 `(err as Error).message` 会把故障变成 `undefined`。**错误处理的第一职责是不丢信息** |
| 9 | 页面 50 兆像素超出图像库上限 + 单页失败丢弃全部成果 | 长任务必须容错，**"部分成功"必须是可交付的结果** |
| 10 | tesseract v7 输出结构变了（**该引擎已在 `cdf2957` 被 PaddleOCR 取代**，但教训仍然成立） | 不信任"运行时确实存在"这类注释。**第三方库的输出结构会在小版本间悄然改变** |
| 11 | pdf.js 需要显式 `wasmUrl` | 缺解码器 → 不绘制 → 画布空白 → 被"空白页跳过"吞掉。**多层合理降级叠加会让故障完全不可见** |
| 12 | 把"能用的结果"当成"没有结果" | 识别出 7058 字却报"什么都没识别到"，只因拿不到词级坐标 |
| 13 | 断言了只在开发者机器上成立的状态 | **本地全绿、CI 必红**。验证环境与真实环境的差异恰好落在被验证的那一点 |
| 14 | 整次扫描的结果只在最后一页跑完后才写库，而 `autoUpdate` 的 SW 会无预警重载页面（**缺陷 21**，修于 `fc79896`） | **保障措施的丢失窗口必须匹配任务时长**。十几分钟的工作押在一次中断上 = 全丢，而且因为状态随刷新一起清空，**连报错都不会有**。见 §5.9 |
| 15 | 外壳浏览器（360 等）内核过旧：ONNX 的 **WASM 运行时被直接干掉**，进程消失、不抛异常、页面被重载（**缺陷 22**，修于 `780c54c`） | **「进程消失 + 不抛异常」就该往宿主层想**（内核 / GPU 进程 / 标签页回收），不要在 JS 里继续找 —— 什么都不留，说明死的那一层不归你的代码管。修法是**在开始之前做能力检测**，而不是崩溃之后一路排查。见 §5.10 |

> **行号与 `docs/03` 的编号不完全对应**：第 1–13 行对应缺陷 1–13，第 14 行对应**缺陷 21**，
> 第 15 行对应**缺陷 22**（正文里都标了编号）。

### 这十五条的元教训

> **"我验证过了"这句话本身可能是错的。**

宣布修好之前，先问三个问题：

1. 我验证时用的**环境**，和出问题的环境是同一个吗？
2. 我用的**命令**，和 CI / 部署时用的是同一条路径吗？
3. 我的**断言**，在别人的干净检出上也成立吗？

**本项目出过的最严重问题，源码、类型检查、单元测试全都是绿的。**

> **另两个尚未并入上表的缺陷**：PWA 陈旧 chunk 故障（`a766d3f` / `aa8827a` 修的就是它，
> 现象、真因、修法见 §5.6）。它与缺陷 13 同类 —— **源码、类型检查、单测全绿，错在「产物 + 运行时状态」的组合上**：
> 旧 Service Worker 递出的旧 `index.html` 引用了已被删除的 chunk。
> 教训：**离线缓存类代码的正确性无法只靠单元测试证明，必须核对真实产物与线上 `sw.js`。**
>
> **同一类的第三个案例**是缺陷 21（§5.9，「扫描结果全丢」）：源码、类型检查、单测依旧全绿，
> 错在「**部署时机 × 进行中的长任务 × 内存态未落盘**」这个组合上。
> 它比前两个更隐蔽 —— 前两个至少会报错或白屏，这一个**什么都不显示**。
>
> **第四个案例**是缺陷 22（§5.10，「OCR 第 1 页进程消失」）：源码、类型检查、单测还是全绿，
> 而错误**根本不在本项目的代码里** —— 它在外壳浏览器那过旧、且被魔改过的内核上。
> 这一类**无法用任何测试在本地抓住**（本机装不了 360，也没有别的旧内核可用）。
> 唯一可行的做法就是 §5.10 的修法：**在开始之前做能力检测，把不支持的环境认出来并说清楚**，
> 而不是等它崩了之后再一路排查。

---

## 7. 已知缺陷与限制（按严重度排序）

### P0 · 影响真实阅读质量

| 问题 | 影响 | 难度 |
|---|---|---|
| **PWA 自动更新会在阅读中静默重载**（已决策保留 `autoUpdate`，见 §5.7） | 页面仍会**无预警自动重载**：**滚动位置、展开的译文会丢**（这两项代价不变）。**「进行中的 OCR 会丢」已缓解**（§5.9，修于 `fc79896`）：导入/OCR 期间刷新被推迟，底部会出现「新版本已就绪」横幅，工作一结束即自动刷新，也可点「立即刷新」自己刷。旧的 prompt 模式「立即更新」提示条仍然删除（它在 autoUpdate 下永不触发） | **大部分已接受**；滚动位置与展开译文这两项**仍未解决** |
| **公式云端识别默认关闭**（已决策，见 §5.8） | 默认路径零上传；但**勾选后仍会把页面局部像素上传第三方**，需要联网，且 Worker 未配 `SIMPLETEX_API_KEY` 时端点返回 500、应用内无「上传了什么」的审计视图 | **残余风险已接受**（不再需要产品决策） |
| **OCR 未经真机验证**（PaddleOCR） | 真实扫描件上的中文识别准确率完全未知（见 §4.2）。已确认的只是**用户实测口径**「Firefox、Chrome、Microsoft Edge 都可以正常使用」 | 未知 |
| **内核过旧的外壳浏览器做不了 OCR**（360 等，见 §5.10） | 这类浏览器会在第一次推理时**直接干掉进程**：不抛异常、页面被重载、结果全无。**应用侧无法修复**，只能靠 `detectOcrSupport()` 在**开始之前**拦下并告知替代浏览器（§5.10）；而**这个检测本身也没有真机验证过**（本机没有可用的旧内核浏览器） | **已缓解**（能做的是提前识别与告知，不是让它能跑） |
| **文字版 PDF 的页眉页脚仍未过滤** | `3d4a2ad` 的过滤只作用在 **OCR 后处理**（`ocrPostProcess.ts`）这条路径上；走文字层的 PDF 仍是每页的页眉页码变成正文块，一本 300 页的书会产生近千个碎片 | 低 |
| **PDF 双栏排版串行** | 教材、论文的左右栏被读成一行，正文顺序完全错乱 | 中 |
| **首次 OCR 必须联网** | 模型约 30MB（**已改为与站点同源发布**，见 §5.10）+ ONNX WASM 约 28MB（jsDelivr）只在运行时缓存，未用过 OCR 的设备断网即不可用。见 §1 T1 | 中（受 jsDelivr 可达性影响；模型已不再依赖第三方域名） |

### P1 · 功能缺口

| 问题 | 影响 |
|---|---|
| 正文全文搜索 | 只能搜批注。大文档定位困难 |
| 跨设备同步 | 每台设备独立，换设备要重新导入 |
| 全量数据导出/导入 | 无法一次性备份所有文档，只能逐个导出批注 |
| 书签/收藏 | 只能靠批注标记位置 |
| Markdown 表格渲染 | 表格退化为普通文本 |

### P2 · 体验细节

| 问题 | 影响 |
|---|---|
| 手机端 OCR 体验差 | CPU 弱 + 后台降频 |
| 浏览器原生 TTS 音色差异 | Windows 与 macOS 观感不一致 |
| 无 PWA 更新日志 | 用户不知道更新了什么。**本轮起多了一条「新版本已就绪」横幅**（§5.9），但它只说"可以刷新了"，**不说这一版改了什么** —— 更新日志仍然没有 |
| OCR 语言下拉框已无实际作用 | PaddleOCR 是全字典多语言，`OcrEngine.initialize(_lang)` 的参数已不被使用，但 UI 上仍显示语言选项 |
| 源码注释残留 tesseract 表述（**部分已修**） | **会误导排查的那批已修正**：`src/lib/ocrTypes.ts`（含「语言包 22MB」文案）、`parsers/index.ts`、`parsers/pdfParser.ts`、`parsers/scannedPdfError.ts` 已改为 PaddleOCR 口径。**仍未改的是历史叙述**：`ocrPostProcess.ts` 里描述「tesseract v7 把词输出从平铺改成嵌套」等过去故障成因的段落 —— 那是历史事实，保留是对的（另一个同类文件 `ocrWordExtraction.ts` 已在本轮删除，见 §4.3） |

---

## 8. 路线图（建议执行顺序）

### R1 · 跑通并验证 OCR（**最优先**）

**为什么最优先**：这是唯一「代码写完了但从没验证过」的核心功能。
`cdf2957` 刚把引擎整条换成 PaddleOCR，**新引擎在真实扫描件上一次都没跑过**；
在它验证之前，任何新功能都建立在不确定的地基上。

**做什么**：
0. **先确认浏览器**：用 Chrome / Edge / Firefox（**Chrome/Edge 119+、Firefox 121+**）。
   如果 OCR 对话框里直接出现黄色的「这个浏览器无法运行文字识别」提示块，**不要继续排查应用** ——
   那是 §5.10 的能力检测在起作用（换成上面三种浏览器即可）
1. 用一份真实扫描版 PDF，**联网**（首次要下模型约 30MB 同源 + ONNX WASM 约 28MB），
   在浏览器里执行「前 10 页」OCR
2. 记录：成功率、失败页号、每页耗时、中文识别准确率（人眼比对）
3. 若失败，**先看文档库顶部的黄色诊断横幅**（`getReloadCount()` / `getLastReloadReason()` /
   `getOcrStageTrail()`，见 §5.10.3），它不需要控制台；再看控制台的 `[ocrEngine]` 与 `[ocrParsePdf]` 诊断输出。
   初始化超时阈值是 `INIT_TIMEOUT_MS = 180_000`（180 秒），引擎的报错文案会提示「首次使用需要下载模型（约 30MB）」
   （⚠️ **界面上的文案仍写着「约 10MB」，那是过时的**，见 §5.10.7 末尾）
4. 顺带验证 `3d4a2ad` 的**页眉页脚过滤**在真实扫描件上的效果
   （上下各 5% 边距 + 字号 < 全页中位数 0.85 倍 → 丢弃）
5. 判断：整本 OCR 是否现实？若每页 >30 秒，833 页需要 7 小时，
   应改为引导用户用 `ocrmypdf` 离线处理

**验收**：能给出"成功率 X%、平均 Y 秒/页"的实测数据。
（§5.10 已经排除了「浏览器内核」这一类原因 —— **不需要再重做那六轮实验**。）

### R2 · PDF 页眉页脚过滤（**OCR 路径已实现，文字层路径仍未做**）

**已完成的部分**：`3d4a2ad` 在 `src/lib/ocrPostProcess.ts` 里加了 `filterHeaderFooter()`
（`HEADER_FOOTER_MARGIN_RATIO = 0.05`、`HEADER_FOOTER_FONT_RATIO = 0.85`），
作用于 **OCR 结果**这条路径，有单元测试。

**还没做的部分**：走**文字层**的普通 PDF（`pdfParser.ts`）没有等价过滤 ——
真实书籍每页的页眉页码仍会变成正文块，污染阅读流与朗读顺序。

**思路**（沿用原方案）：
1. 统计全文"出现在页面顶端/底端固定 y 区间"且"跨页高度重复"的文本
2. 命中的行不进正文，记录到 `metadata` 供回跳
3. 用 `scripts/inspect-pdf.mjs` 已有的"疑似页眉/页脚碎片"指标验证

**前置**：需要 2~3 份真实书籍 PDF 量化页眉占比。**注意页眉页脚过滤目前没有用户开关**，
误杀风险需要用真实样本量化。

### R3 · PDF 双栏识别

**思路**：检测文字片段的 x 坐标是否呈双峰、页面中部是否有空白带，
按栏切分后再各自聚类。

**风险**：判定错误会让单栏文档变得更糟。**必须有"不确定时退回单栏"的保守策略**，
并准备单栏/双栏两份样本验证。

### R4 · 正文全文搜索

**思路**：借助已有的 `blocks` 表建倒排索引。注意 IndexedDB 查询能力有限，
可能需要额外的索引表。

### R5 · 全量数据导出/导入

**为什么值得做**：比云同步简单得多，不破坏隐私定位，但解决了"换设备"与"备份"。

**思路**：把 `documents` + `blocks` + `annotations` 打包成一个 zip 导出；
导入时按 id 去重合并。

### R6 · 清理技术债（可随时做）

- 决定 OCR 语言下拉框的去留（`initialize(_lang)` 已不使用该参数）
- 把源码里残留的 tesseract 注释与文案一并更正 —— **会误导的那批已在上一轮修正**（`ocrTypes.ts` 的「语言包 22MB」、`parsers/index.ts`、`pdfParser.ts`、`scannedPdfError.ts`）；剩下的 `ocrPostProcess.ts` 属历史故障叙述，**保留是对的**，不要为「一致性」把它删掉
- 为 `db.ts` / `useVirtualWindow.ts` 补单元测试（当前无覆盖）
- 为数学公式渲染补测试（`src/**/*.test.ts` 里没有任何 `katex` / `$$` 断言）

> **本轮已完成，不要再列回待办**：`pdfTextLayer.ts` 与 `ocrWordExtraction.ts`
> （连同它的 13 个孤立用例）已删除；`pdf-lib` / `jszip` / `rehype-katex` 三个未使用依赖已从
> `package.json` 移除。清单与核实方式见 §4.3 的「本轮已清理」表。

> **`fc79896` 本轮已完成，不要再列回待办**：~~「扫描结果全程只在内存里，等最后一页跑完才写库」~~
> —— 已改为 **OCR 期间中途落盘**（`OCR_CHECKPOINT_EVERY_PAGES = 5`，末页必落）
> **并且**导入/OCR 期间推迟自动刷新（`updatePending` / `reloadNow` + 「新版本已就绪」横幅）。
> 现象、真因、修法与证据见 §5.9（缺陷 21），未验证的部分见 §4.2 与 R9 第 6、7 条。

### R7 · 其他

`Markdown 表格渲染` · `书签功能` · `PWA 更新日志` · `E2E 测试（Playwright）`

### R8 · 已拍板的三项决定（**不要再翻案**）

上一轮留下来的两个「待决策」加一项清理，**本轮已全部拍板并落地**，不再是待办。
决策内容与代价见 §1 的「本轮三项决定」表；这里只列结论和「不要做什么」：

| 决定 | 结论 | 不要做什么 |
|---|---|---|
| PWA 更新模式（§5.7） | **保留 `autoUpdate`**，删除 prompt 模式那套永不触发的提示 UI（`PwaState` 曾收窄为 `{offlineReady, dismiss}`、删掉 `needRefresh` 分支与 `RefreshCw`、`Banner` 的 `tone` 收窄为 `'offline' \| 'ready'`）。**本轮补充（§5.9）**：`PwaState` 又新增了 `updatePending` / `reloadNow`，`RefreshCw` 也随「立即刷新」按钮加了回来 —— 这是**新功能**，不是把 prompt 模式那套 UI 复活 | 不要把 `registerType` 改回 `prompt`、不要在 autoUpdate 下重新引入依赖 `needRefresh` 的提示条（`needRefresh` **永远为 `false`**）；不要动 `vite.config.ts` 的 `skipWaiting` |
| 公式云端识别（§5.8） | **默认关闭的显式开关**：`settingsStore.formulaOcrEnabled`（默认 `false`）+ OCR 对话框复选框；`recognizeFormula()` 里还有第二道防线（关闭时抛错拒绝上传） | 不要把默认值改成 `true`；不要绕过开关直接调 `recognizeFormula()`；不要删掉第二道防线 |
| 死代码与冗余依赖（§4.3） | `ocrWordExtraction.ts`（含 13 个孤立用例）、`pdfTextLayer.ts` **已删**；`pdf-lib` / `jszip` / `rehype-katex` **已从 `package.json` 移除** | 不要「以防万一」把它们加回依赖或恢复文件 |

### R9 · 剩余端到端验证（见 §4.2，全部**未验证**）

1. **真实浏览器离线流程**：加载 → 刷新一次 → DevTools 切 Offline → 刷新（至今没做过）
2. **公式上传开关的真机行为**：勾选 / 不勾选各跑一次真实 OCR（只有单元测试与源码断言，没有真机验证）
3. **云端翻译端到端**（需要有效的 DeepL key）
4. **SimpleTex 公式 OCR 端到端**（需要 Worker 上配好 `SIMPLETEX_API_KEY`，否则恒返回 500）
5. **PaddleOCR 在真实扫描件上的中文识别准确率**（Node 测试跑不了它，必须浏览器）
6. **导入/OCR 期间推迟自动刷新**（§5.9 修法一）：**需要一次真实部署正好落在一次真实扫描中间**
   才能验；「新版本已就绪」横幅与「立即刷新」按钮至今没被人眼在真实浏览器里看到过。
   目前只有 `src/lib/pwaReload.test.ts` 的 7 个顺序断言（`ed66ba8` 补上）—— 它钉的是"代码写了什么"，
   替代不了这次验证
7. **OCR 中途落盘在真实中断下的效果**（§5.9 修法二）：关标签页 / 浏览器崩溃各试一次，
   确认书库里确实留着已识别的那部分（目前只有 9 个单元用例与源码断言，「最多丢 5 页」是推出的结论，不是实测）
8. **OCR 前置能力检测在真机上的表现**（§5.10，`780c54c`）：需要在**一款内核过旧的外壳浏览器**
   （360 等）里打开本站，确认出现的是 OCR 对话框里的黄色提示块，而**不是进程消失**。
   **本机装不了 360**，目前只有 `src/lib/ocrSupport.test.ts` 的 5 个用例（而且是在 Node 环境里求值）——
   这属于「代码写好了、但对它存在的理由一次都没实测过」

**已不再属于本节（本轮已完成）**：~~「扫描结果全程只在内存里，刷新即全丢」~~
—— §5.9 缺陷 21 的两个修法已落地（`fc79896`）：结果每 5 页落一次盘（末页必落），
导入/OCR 期间也不再被自动刷新打断。**注意这不等于已通过验证**：修法本身的真机行为见上面第 6、7 条。

---

## 9. 诊断工具（排查问题时会用到）

三个 Node 脚本，**不需要浏览器**，且与应用共用同一套聚类常量：

```bash
# 解析质量体检：页数、段落数、字号分布、断段是否过碎/过粗、页眉碎片占比
node scripts/inspect-pdf.mjs "book.pdf" --pages 40

# 页面结构排查：内容流里到底有没有文字/图片指令，判断是否扫描件
node scripts/diagnose-pdf.mjs "book.pdf" --pages 3

# 原始对象分析：不依赖解析器，直接数图片/字体对象
node scripts/analyze-pdf-objects.mjs "book.pdf"
```

**已知陷阱**：`page.getOperatorList()` **默认不展开 Form XObject 内部的指令**，
而扫描件恰恰把图片放在 Form XObject 里。不加 `intent: 'display'`
会得出"页面是空的"这一**错误结论**。

### 应用自带的会话诊断（**用户没有控制台时唯一的证据来源**）

`src/lib/sessionDiagnostics.ts` 把「页面被加载了几次 / 上次刷新是谁发起的 / OCR 走到了哪一步」
写进 **`sessionStorage`**（**刷新不清空**，关标签页才清），并由 `DocumentLibrary` 顶部的
**黄色横幅**直接显示 —— 只在确有异常（`reloadCount > 1` 或有中断记录）时才出现，正常使用看不到。
§5.10 那次排查能收敛，靠的就是它。

| 想知道的 | 看什么 |
|---|---|
| 页面是不是被刷新过 | `getReloadCount()` —— **> 1** 就说明被重载过 |
| 刷新是不是应用发起的 | `getLastReloadReason()`：`sw-update`（SW 接管）/ `preload-error`（chunk 自愈）/ `manual`（用户点了立即刷新）。**三者都没有记录 ⇒ 不是应用发起的**，那就是宿主层（内核 / GPU 进程 / 标签页回收） |
| 上次识别死在哪一步 | `getOcrStageTrail()`（**最近 5 条**）+ `getInterruptedOcr()` —— 例如「停在 `onnx`、没有 `onnx-done`」直接指向推理阶段 |

⚠️ 这个模块**没有自动化测试**（见 §5.10.3 与 §5.10.10）。

### 真实文件回归测试

`src/parsers/realPdf.manual.test.ts` 在检测到本机有样本时自动执行：

```bash
$env:REAL_PDF_PATH  = 'D:\samples\text-book.pdf'
$env:REAL_SCAN_PATH = 'D:\samples\scanned-book.pdf'
npx vitest run src/parsers/realPdf.manual.test.ts
```

---

## 10. 部署

| 项 | 值 |
|---|---|
| 生产地址 | `https://universal-reader.pages.dev/` |
| 前端 | Cloudflare Pages（项目名 `universal-reader`），Build command **`npm run build`**，输出 `dist` |
| API 代理 | Cloudflare Worker `universal-reader-api`（`worker/api-proxy.ts`），地址 `https://universal-reader-api.616444703.workers.dev`，可选 |
| Node 版本 | 由 `.node-version` 固定为 22（Pages v3 构建系统**不读** `engines` 字段） |
| 环境变量 | 见 `docs/05-部署与分享指南.md` |
| 仓库 | `https://github.com/Mercuryof37/universal-reader`，分支 `main` |

### ⚠️ 单文件 25MB 上限：ONNX WASM 必须走 CDN

`clean-onnx-wasm.mjs` 不是可选项。ONNX Runtime 的 `.wasm` 约 **28MB**，
**超过 Cloudflare Pages 单文件 25MB 上限**，一旦被打进 `dist/` 就部署不上去。
所以 `postbuild` 必须保留 `node scripts/clean-onnx-wasm.mjs &&`，
运行时改由 `ort.env.wasm.wasmPaths` 指向 jsDelivr（见 §3）。

### ⚠️ 本地构建哈希 ≠ 线上构建哈希

同一份源码：本地是 `index-DWhM5bxu.js` / `pdfParser-BQZ8b1PC.js`（本轮 `fc79896` 的本地构建），
上一轮本地是 `index-BBM5E4Bw.js` / `pdfParser-DJvvPlRl.js`，而那一轮的线上产物是
`index-BUj-R2J2.js` / `pdfParser-BjFMW2CJ.js`（连入口 CSS 都不同：本地 `index-edxBkGh6.css`，
线上 `index-C6dUSkX0.css`）。本轮线上入口 chunk 实测为 **`assets/index-CiMmJIqw.js`**，
同样与本地 `index-DWhM5bxu.js` 不同。
Cloudflare 的构建与本地构建**不是逐字节可复现的**。
排查线上问题时，**唯一可靠的做法是直接抓线上的 `sw.js` / `index.html`**，
不要用本地 `dist/` 里的文件名去推断线上资源名（见 §4.1）。

> **本轮 `fc79896` 的线上哈希已核对**：带 cache-buster 抓线上 `index.html`，入口 chunk 为
> **`assets/index-CiMmJIqw.js`**；部署已确认（`verify` 与 `Cloudflare Pages` 两项 check 均 **success**）。
> `ed66ba8` 只新增测试文件、**不影响产物**，因此线上产物与 `fc79896` 完全相同。
>
> ⚠️ **抓 `sw.js` 必须带 cache-buster**：不带 `?t=<时间戳>` 会读到 **Cloudflare 边缘缓存里的旧副本**，
> 第一次抓取就因此误判成「没部署」。这与 §5.6 的原始故障**是同一类错误 —— 读到了被缓存的旧产物**。
> 更稳的判据是抓响应头为 `must-revalidate` 的 `index.html`。

### ⚠️ 安全：`ALLOWED_ORIGIN` 必须配置

Worker 里放着付费 API 密钥。CORS 现在是 **fail-closed**：

| `ALLOWED_ORIGIN` | 行为 |
|---|---|
| 未配置 | 不返回 CORS 头 → 浏览器拒绝跨域（云端功能静默失效） |
| 已配置且匹配 | 放行 |
| 已配置不匹配 | 拒绝 |

当前 `wrangler.toml` 里的值是：

```toml
ALLOWED_ORIGIN = "https://universal-reader.pages.dev,https://*.universal-reader.pages.dev,http://localhost:5173"
```

**`*` 只匹配单个 DNS 标签、不跨点**，所以 Cloudflare Pages 每次推送生成的新预览地址
（`https://<hash>.universal-reader.pages.dev`）能被通配符覆盖，而**生产地址必须单独列出**。
只含通配符的规则（如 `*`、`https://*`）会被忽略，以免白名单变成放行所有人。

### ⚠️ Worker 需要 `SIMPLETEX_API_KEY`，否则公式 OCR 恒 500

```bash
npx wrangler secret put SIMPLETEX_API_KEY     # 加密环境变量，不要写进 wrangler.toml
npx wrangler deploy
```

- 缺失时 `/api/formula-ocr` **恒返回 500 `未配置 SIMPLETEX_API_KEY`**（**线上实测当前就是 500**）
- 未配置时 PaddleOCR 主流程仍然工作：公式部分退化为 PaddleOCR 的原始识别结果（只告警）
- **本轮起该端点默认根本不会被调用**：前端开关 `formulaOcrEnabled` 默认 `false`，
  只有用户在 OCR 对话框里勾选「上传公式区域以换取更准的公式」之后才会发起请求（见 §5.8）
- 服务端上限 **2,700,000** 个 base64 字符（约 2MB），超出返回 **413**；
  客户端上限 `MAX_IMAGE_SIZE = 2_000_000` 字节

**改完必须 `npx wrangler deploy` 才生效**，否则仍是旧代码。

### ⚠️ 本机网络：`git push` 需要重试

`github.com:443` 在本机**时通时断**（DNS 正常，`api.github.com:443` 与
`universal-reader.pages.dev:443` 可达，但 `github.com:443` 多数尝试失败；
本机未配 SSH key，也没有代理）。`git push` 实测**重试 1–3 次内能成功**；
本轮 `fc79896` 的推送**重试了 7 次**才成功，属同一现象的正常波动范围。
失败时不要怀疑凭据或远端配置，先重试。

> **推送成功 ≠ 部署完成**：Cloudflare Pages 需要几分钟构建。
> 本轮 `fc79896` 已经走完这一步 —— 已推送到 `origin/main`，且 `verify` 与 `Cloudflare Pages`
> 两项 check 均为 **success**，部署**已确认**（见 §4.1）。但这条纪律本身仍然成立：
> **在 check 变绿之前，不要把"已推送"说成"已上线"**。

---

## 11. 给接手者的建议

1. **先读 §1 的「本轮三项决定」**：上一轮的两个待决策（PWA 更新模式、公式上传）**已经拍板落地**，
   不要再翻案。对应代码见 §5.7（保留 `autoUpdate`，代价是会自动重载）与 §5.8（公式上传默认关闭）。
   **另加两条**：§5.9（缺陷 21，「扫描结果全丢」）—— 它**没有**改变 §5.7 的决策，
   只是缓解了那条代价里最严重的一项；§5.10（缺陷 22，「OCR 第 1 页进程消失」）——
   它的结论是**应用本身没有问题**，崩的是**内核过旧的外壳浏览器**，修法是**开始前的能力检测**
2. **先跑一遍 `npm run build` 和 `npm test`**，确认基线是绿的（应为 `246 passed / 24 files`）
3. **再跑通一次真实扫描件的 OCR**（R1）—— 这是最大的未知数：PaddleOCR 的**识别准确率**至今没有量化数据。
   但**不要**重做 §5.10 那六轮实验：那些假设已经被证据逐一否掉了
4. **读 `docs/03-踩坑与修复记录.md`** —— 22 个缺陷换来的经验都在那里
   （另加 §5.6 的 PWA 陈旧 chunk 故障、§5.9 的「扫描结果全丢」与 §5.10 的「进程消失」，四者是同一类教训：**全绿也不代表对**）
5. **改动前先看 §1 的"不要做"** —— 有些看似合理的设计会破坏项目定位
6. **改产物相关的东西时，先看 `verify-dist.mjs` 检查了什么** ——
   这个项目最贵的几个缺陷都是"源码正确但产物错误"
7. **碰到 PWA / 缓存 / 更新问题时，先读 §5.6–§5.7 与 §5.9** ——
   这里有三条已经踩过的坑：`navigateFallback` 会永远返回预缓存的旧 HTML；
   NetworkFirst 需要有人先把页面骨架写进缓存；**长任务期间不能让它被自动刷新打断，且长任务的结果必须中途落盘**。
   另外记住 §5.7 的结论：本项目**故意**选择了会自动重载的 `autoUpdate`
8. **用户说「页面自己刷新了」「什么都没有」时，先读 §5.10.3** ——
   不要问"控制台里有什么"（**用户根本打不开控制台**），直接看文档库顶部的黄色诊断横幅：
   **刷新来源**（三条路径有没有记录）+ **OCR 阶段轨迹**（最后走到哪一步）。
   这两条信息能把"应用的问题"与"宿主层的问题"直接分开。同时**问一句用户用的是什么浏览器** ——
   §5.10 那场六轮排查，最后就是被「Firefox、Chrome、Microsoft Edge 都可以正常使用，但是 360 不行」这一句收束的
9. **改完记得确认产物相关的数字**：本轮基线是 `246 passed / 24 files`、precache
   `18 entries (3579.98 KiB)`、依赖 26 个；`src/` 的「65 个文件 / 11,018 行」是**上一轮基线，本轮未复核**
   （新增了 `ocrSupport.ts` / `ocrModelSource.ts` / `ocrExecutionProvider.ts` 等文件）。这些数字散落在本文多处，改动后要一起更新
