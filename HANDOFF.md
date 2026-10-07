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
| 当前提交 | **`769227b`**（**最新提交**，2026-10-07 22:51，作者 `Universal Reader Dev`）：**「对账容忍格式差异，而不是只容忍空白」** —— 15 个拿不到字符框的词**全部**卡在同一个失败出口，逐条对照后差别**几乎全是格式**（全角/半角标点、汉字之间有无空格、大小写），归一化由「只去空白」扩为「**去空白 + 全角转半角（U+FF01–U+FF5E）+ 忽略大小写**」，`wordsWithChars` 由 **8 → 15**；仍有 3 类**真的认错字**必须继续拒绝。<br>它的**前一个提交**是 **`f8cc1bc`**（22:44，导出里带上「重新识别得到的文本」）。**今天后半程共 8 个提交**（`d6b07e6` → `769227b`，21:44–22:51：版面分析模型、字符级坐标、导出字符框、导出 `buildId`、中线符号不是上标、导出失败原因、导出重识别文本、对账容忍格式）—— 逐条见 **§4.4**，机制见新增的 **§5.11** 与 **§5.12**。**部署状态**：只有 `1deb6c1` 经核实（`verify` 与 `Cloudflare Pages` 均 success，见 `42dd59f` 提交信息）；**`769227b` 本身的部署状态本文未核实**<br>**以下是 `c2a09b1` 当时的记录（保留作历史）**：**`c2a09b1`**（**最新提交**：① 新增 `src/lib/sessionDiagnostics.test.ts`（**11 个用例**），为**会话诊断模块**补上覆盖 —— 它是那次六轮排查**唯一能收敛的工具，而它自己此前没有测试**；② 修掉「模型约 10MB」的口径不一致，改为「**约 30MB**」。见 **§5.10.3** 与 **§5.10.7**）<br>它的**前一个提交**是 **`780c54c`**（新增 `src/lib/ocrSupport.ts` —— **在开始 OCR 之前做能力检测**，把不受支持的内核在「开始识别」之前就认出来并给出可执行建议，而不是崩在推理里；新增 5 个用例。见 **§5.10**，即 `docs/03` 的**缺陷 22**）<br>**`780c54c` 之前还落过几个提交**（模型改为同源自托管、只启用 WASM、`ort.env.wasm.numThreads = 1` 与去掉 `toBlob`、`OCR_RENDER_DPI` 300 → 200），它们的哈希本文未记录。**部署状态已核实**：`780c54c` 的 `verify` 与 `Cloudflare Pages` 两项 check **均为 success**；`c2a09b1` 是随后的一次提交 |
| 部署 | Cloudflare Pages（静态）+ 可选 Cloudflare Worker（API 代理）<br>**今天后半程的部署**：`1deb6c1` 的 `verify` 与 `Cloudflare Pages` 两项 check 均为 **success**、线上入口 chunk 已换新（`42dd59f` 提交信息记载）；它之后还有 4 个提交（`984af78` / `f8cc1bc` / `769227b` …），**它们的部署状态本文未核实** |
| 上一轮提交 | `fc79896`（「fix(ocr): stop losing a whole scan to a mid-run reload, and defer that reload」，即 §5.9 缺陷 21 的两条修法）＋ `ed66ba8`（只新增测试文件、**不影响产物**）：**二者均已推送到 `origin/main`**（`fc79896` 的 push 重试了 7 次，本机 `github.com:443` 时通时断，见 §10），**部署已确认** —— `verify` 与 `Cloudflare Pages` 两项 check 均为 **success**，线上入口 chunk 为 `assets/index-CiMmJIqw.js` |
| 更早一轮提交 | `f549173`（三项决策）与 `f331393`（文档同步）：**二者均已部署**（`verify` 与 `Cloudflare Pages` 两项 check 均为 **success**，线上已服务于那一批产物） |
| 代码规模 | （**本次实测**）`src/` **83 个文件 / 22,492 行** · `scripts/` **11 个 / 2,227 行** · `worker/` **1 个 / 453 行**<br>**统计口径**：目录下**全部文件**（`src/` 的 83 个 = `.ts` 72 + `.tsx` 10 + `.css` 1，**不排除测试文件**），用 `[System.IO.File]::ReadAllLines(...).Count` 逐文件累加。**交叉核对**：`c2a09b1` 记录的 74 个 / 12,452 行 ＋ `git diff --shortstat c2a09b1 HEAD -- src` 实测的 `25 files changed, 10206 insertions(+), 166 deletions(-)`（74 + 9 个新文件 = 83；12,452 + 10,206 − 166 = 22,492）＝ 与逐文件实测**逐字相符**<br>（历史：`c2a09b1` 当时是 74 个文件 / 12,452 行、`scripts/` 8 个 / 1,151 行） |
| 依赖 | **26** 个（dependencies 16 + devDependencies 10），本轮**不变**（上一轮由 29 降下来） |
| 测试 | **489 passed / 30 files**（**最新提交基线**）。**口径与出处（这一条要看清，因为它不是本次跑出来的）**：489 出自 `769227b` 的提交信息原文「vitest 489 passed / 30 files, with nine new cases built from the real strings」，**与用户给定值一致**；**30 个测试文件是本次目录实测**（`src/**/*.test.ts` 共 30 个）。**这个数字能被两次独立核对对上**：① 480（`f8cc1bc` 提交信息记载）＋ **9**（`769227b` 的测试 diff 实测新增 9 个 `it(`，且该提交只动 `ocrCharBoxes.ts` 与它的测试）＝ 489；② 全仓库 `it(` **静态计数 479**（本次实测）＋ **10**（`ocrPostProcess.test.ts:1399` 有一行 `import '@/lib/ocrPostProcess.layout.test'`，而该文件本身也命中 vitest 的 `include` glob，于是它的 **10 个用例被执行两次**）＝ 489。⚠️ **本次没能在本机复跑**：`vitest run` 在这个沙箱里起不来（vite 在 Windows 上探测网络驱动器时 `spawn EPERM`，§5.11 末尾有详述），所以它是**提交信息 + 用户给定值 + 上述两处交叉核对**，不是本次复现。历史基线：`c2a09b1` 25 / 257 · `780c54c` 24 / 246 · `d6b07e6` 29 / 424 · `85c3714` 30 / 478（以上均出自各自提交信息） |
| 门禁 | `tsc -b` ✅ · `vitest run` ✅ · `npm run build` ✅（含 ONNX WASM 清理 + 产物校验）<br>**今天后半程的出处**：`tsc -b` exit 0 见 `3d2e88f` / `42dd59f` / `984af78` / `f8cc1bc` / `769227b` 五条提交信息；`npm run build` 的实测值是 `d6b07e6` 提交信息里的 **precache 19 entries（`18 → 19`）· `[verify-dist]` 通过 · 产物 88 个文件 / 40.16 MB（含 4 个模型 / 34.59 MB）**；它之后的 5 个提交只记「precache 19 entries、verify-dist 通过」，**未再给数字**。⚠️ 多出来的那一条 precache 具体是什么**本次没有核实** —— 但**可以确定不是版面模型**：模型走的是运行时缓存（`vite.config.ts` 里 `cacheName: 'ocr-models'` 的那条规则），**不在预缓存清单里**，所以版面模型同样属于「首次使用必须联网」（§1 T1）。⚠️ 这三项本次**都没有在本机复跑**（沙箱限制，见 §5.11.8） |
| 文档 | `README.md`（用户手册）· `docs/`（**5 份专题**：`技术选型定稿.md`、`部署与分享指南.md`、`PWA离线能力.md`、**`字符级OCR技术调研.md`**、**`Windows自带OCR可行性调研.md`** —— 后两份是今天新增的；`字符级OCR技术调研.md` 自带**证据等级**标注（🟢本机实测 / 📘官方文档 / 🔭推测 / ❓未验证），§5.12 的字符级方案就源自它，**接手时值得先读它**）· 本文<br>⚠️ §6 与 §11 引用的 `docs/03-踩坑与修复记录.md` **不在仓库 `docs/` 下**（§6 已注明） |

> **关于「本轮」这个词**：本文其余各节大量使用「本轮」，它们指的是 **`fc79896` + `ed66ba8` 那一轮**
> （§5.9 缺陷 21）。**它之后的两轮是 `780c54c`（§5.10 缺陷 22 的能力检测）与 `c2a09b1`（最新提交：
> 会话诊断测试 + 模型体积口径修正）** —— 正文里凡涉及它们的地方都会写明提交号。
>
> ⚠️ **补记（今天后半程，2026-10-07 21:44 → 22:51）**：仓库在此之后又落了 **8 个提交**
> （`d6b07e6` → `769227b`），本文为它们新增了 **§5.11（版面分析模型）** 与 **§5.12（字符级坐标与诊断导出）**，
> 并在 §4.1 / §4.2 / §4.4 / §7 / §8 / §9 里补了对应条目。正文里出现「**今天后半程**」时都指这一轮，
> 而不是上面那个「本轮」。
>
> ⚠️ **文档缺口（必须如实说明）**：`c2a09b1`（今天 12:07）之后仓库里共有 **25 个提交**
> （`git rev-list --count c2a09b1..HEAD` 实测），**本文只逐条记录了最后 8 个**。
> 中间 **17 个（12:15 → 21:36）仍未写进本文**，其中至少 `24b0332`（导出真实识别结构）、
> `d7f9e64`（读上下标、多行构件排序）、`00c358c`（页脚泄漏与公式行误判）、`42c7af1`（字符级 OCR 调研文档）
> 是理解后半程那 8 个提交的**前置**。**清单见 §4.4 末尾的「文档缺口」表**。

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
| T1 | **C2 离线 × 首次 OCR 需要联网**（**仍未解决，但第三方域名的依赖风险已部分收口**） | OCR 引擎换成 PaddleOCR / ONNX Runtime Web 之后，**模型（约 30MB）与 ONNX WASM（约 28MB，来自 jsDelivr）都只在运行时缓存里**（`ocr-models`、`onnx-wasm`，均 CacheFirst），**不在预缓存清单里**。也就是说「用过一次之后才能离线用」。国内网络对第三方 CDN 的可达性不保证，这是**外部依赖风险**。<br>**§5.10 那一轮部分收口**：模型改为**构建时取好、与站点同源发布**（`scripts/fetch-ocr-models.mjs` → `public/ocr-models/`，默认 base 就是同源 `/ocr-models`），运行时**不再请求 `huggingface.co` / `hf-mirror.com`** —— 那正是浏览器报 `TypeError: Failed to fetch` 的来源。但模型**仍不在预缓存清单里**，所以「首次 OCR 必须联网」这一条**不变**；ONNX WASM 仍来自 `cdn.jsdelivr.net`<br>**今天后半程补记（§5.11）**：模型现在是 **4 个 / 34.59 MiB**（新增版面模型 `PP-DocLayout-S` **4.69 MiB**），**同样不在预缓存清单里** —— 它走的是 `ocr-models` 这条运行时缓存（`vite.config.ts` 里 `cacheName: 'ocr-models'` 的那条规则），所以**首次 OCR 要多取 4.7 MiB**，「首次必须联网」这一条**不变**【实测】模型字节数 / 读源码 |
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
| `ppu-paddle-ocr` | 6.6.0 | 浏览器端 OCR（PP-OCRv6 small，**替代原 Tesseract.js**） | 仅执行 OCR，模型约 **30MB**（构建时取好、与站点同源发布，见 §5.10.7） |
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
npm test             # 25 个测试文件 / 257 个用例
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
| PWA 陈旧 chunk 修复（导航路由改 NetworkFirst、不再有 `navigateFallback`） | 线上 `sw.js` 直接抓取核对 + `src/lib/pwaOffline.test.ts` 8 个用例（读 `vite.config.ts` 把 `NAVIGATION_CACHE_NAME` 钉死）；`src/lib/preloadRecovery.ts` 另有 11 个用例。**这两个文件共 19 个用例，已计入当前 257 个用例的基线** |
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

> 下表是**那一轮的实测值**（precache `3579.98 KiB`、产物 83 个文件 / 5.54 MB）；**最新实测值见下一小节**。

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

#### 最新一轮（提交 `780c54c` + `c2a09b1`）的实测证据

| 检查 | 结果 |
|---|---|
| `npx vitest run` | **257 passed / 25 files**（**最新基线**。上一个提交 `780c54c` 是 246 passed / 24 files，再上一轮记录是 216 passed / 20 files） |
| 新增测试 | `c2a09b1`：`src/lib/sessionDiagnostics.test.ts`（**11 个用例**，为会话诊断模块补覆盖，见 §5.10.3）；`780c54c`：`src/lib/ocrSupport.test.ts`（**5 个用例 / 68 行**）—— 同一轮里还有 `src/lib/ocrModelSource.test.ts` **7 例** · `src/lib/ocrExecutionProvider.test.ts` **4 例** · `src/lib/ocrRuntimeSafety.test.ts` **5 例**（见 §5.10.7） |
| `npm run build` | `PWA v1.3.0  mode generateSW  precache 18 entries (3587.32 KiB)`；`[verify-dist] 构建产物校验通过` —— 产物共 **86 个文件 / 35.44 MB**，其中 **OCR 模型 3 个 / 29.90 MB**（模型改为构建时取好、与站点同源发布后进了产物，这正是体积比上一轮的 5.54 MB 大出一个量级的原因）。注意 `verify-dist.mjs` 现在还多了一条**模型缺失就让构建硬失败**的检查（已做负向测试：移走目录 → **exit 1**，见 §5.10.7） |
| 部署 | **已核实**：`780c54c` 的 `verify` 与 `Cloudflare Pages` 两项 check **均为 success**；`c2a09b1` 是随后的一次提交 |

> 更完整的证据与未验证项在 §5.10.9 与 §5.10.10 —— 其中最重要的一条是：
> **能力检测本身没有在真机上验证过**（本机装不了 360），见 §4.2。

#### 今天后半程（提交 `d6b07e6` → `769227b`，HEAD = `769227b`）的实测证据

> **证据等级记号**（与 `docs/字符级OCR技术调研.md` 同一套口径，本文以下新增内容一律逐条标注）：
> **【实测】** = 本次在 `D:\Deepseek\DSH` 现场用命令量到的（命令随文给出）；
> **【提交记载】** = 提交信息或源码注释里的记载，**本次没有复现**；
> **【用户导出】** = 用户导出的数据、用户原话或用户运行结果；
> **【推测】** = 由上述证据推断，未直接验证；**【未验证】** = 本次没有验证。
>
> ⚠️ **读这一节前必须知道的一件事**：写这 8 个提交的那台机器**也跑不了 `vitest`**
> （原因见 §5.11.8，与本次遇到的沙箱限制是同一件事，`src/lib/ocrPostProcess.layout.test.ts`
> 的文件头注释里就记着它）。所以下表的测试与构建数字**全部是【提交记载】＋【用户导出】**，
> **不是本机复现** —— 这与前面几轮「表里每个数字都是当场跑出来的」**性质不同**，不要混为一谈。

| 检查 | 结果 | 等级 |
|---|---|---|
| 测试 | **489 passed / 30 files**（`769227b` 提交信息原文 + 用户给定值；30 个文件为本次目录实测；两处交叉核对见头部状态表的「测试」行） | 【提交记载】＋【实测】＋【用户导出】 |
| `tsc -b` | exit 0（`3d2e88f` / `42dd59f` / `984af78` / `f8cc1bc` / `769227b` 五条提交信息均记） | 【提交记载】 |
| `npm run build` | precache **19 entries**（`18 → 19`）；`[verify-dist]` 通过；产物 **88 个文件 / 40.16 MB**，其中**模型 4 个 / 34.59 MB**（`d6b07e6` 提交信息；它之后的 5 个提交只记「precache 19 entries、verify-dist 通过」，**未再给数字**）。⚠️ 多出来的那 1 条 precache **本次没有核实是什么**；但**可以确定不是版面模型** —— 模型走运行时缓存（`vite.config.ts` 里 `cacheName: 'ocr-models'` 的那条规则），不在预缓存清单里 | 【提交记载】 |
| OCR 模型资产（4 个） | `public/ocr-models/` **36,265,968 字节 = 34.59 MiB**：`detection/ort/PP-OCRv6_small_det.ort` 9,982,352 · `recognition/ort/PP-OCRv6_small_rec.ort` **21,290,816**（＝ `3d2e88f` 说的「真实 21.29MB 识别模型」）· `recognition/ppocrv6_dict.txt` 74,948 · **`layout/PP-DocLayout-S.onnx` 4,917,852** | 【实测】`Get-ChildItem -Recurse public/ocr-models` |
| 版面模型 sha256 | `33688dbee1c23e34b81777e97cb428eb40f24b242c02b5f623484959e830aec8` —— 与 `src/lib/layoutAnalysis.ts` 的 `LAYOUT_MODEL_SHA256`、来源仓库自带的声明**三者一致** | 【实测】`Get-FileHash -Algorithm SHA256` |
| 代码规模 | `src/` **83 个文件 / 22,492 行** · `scripts/` 11 个 / 2,227 行 · `worker/` 1 个 / 453 行（口径见头部状态表） | 【实测】逐文件 `ReadAllLines().Count` |
| 测试文件与门控 | `src/**/*.test.ts` = **30 个**；其中 `src/parsers/realPdf.manual.test.ts` 的 13 个用例由 `describe.skipIf(!existsSync(...))` 门控，**只有在有真实样本的机器上才真正执行** —— 这反过来印证：报出 489 的那次运行，机器上是有样本的 | 【实测】读源码 |

> 这一轮**没有**验证什么（很重要，别被上面的绿色数字误导）：**版面模型从未跑过真实推理**、
> **角标（上下标）在真实文档上仍不生效**、**Service Worker 自动更新可能根本没生效**。
> 三条都在 §4.2 与 §5.11 / §5.12 里逐条写明。

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
| **版面模型在真实扫描件上的推理**（§5.11，`d6b07e6`） | 接入代码完整、回退路径有测试，但提交信息**自己写明**「Not verified: no real inference has been run against this model」—— 它在真实扫描件上的精度（上游自评 mAP(0.5) = 70.9）**完全未知**。唯一的一条用户观察是「**日志显示它多滤掉一行页脚**」【用户导出】，没有量化数据、也没有可复现步骤 | **高**。它参与阅读顺序与页眉页脚判定，判错会直接改动正文 |
| **角标（上下标）在真实文档上仍不生效**（§5.12，`769227b`） | 字符级链路已能产出字符框，但**含指数的那一行（词 1）仍然拿不到字符框**：剩余 **8 个词**逐条对照后**全部是真的识别差异**（不是格式差异），于是那条新判据**仍然没有可用的测量值**。见 §5.12 的「仍未解决」与「下一步」 | **高**。这是用户最初的需求 |
| **字符级坐标在真实文档上的覆盖率**（§5.12） | 只有**两次用户导出**的快照：`wordsWithChars` **8 / 23 → 15 / 23**（同一份文档、同一次识别条件）【用户导出】。**没有第三份导出，也没有第二份文档** | 中。覆盖率是否稳定未知 |
| **Service Worker 自动更新是否真的生效**（§5.12 末尾） | 连续两次导出拿到**同一个 `buildId`**，说明用户浏览器仍在跑旧构建。更新逻辑在识别期间**刻意推迟**刷新（§5.9），但「推迟之后到底有没有刷新」**从未在真机确认**；若 `updatePending` 一直挂着，用户会长期停在旧版本、**界面上完全看不出来**。证据只有那一次导出 | **中高**。它会让「修复没生效」与「你还没拿到修复」长期无法区分 |
| **真实识别模型上的字符级解码**（§5.12） | `3d2e88f` 记载：用**真实 21.29MB 识别模型**解出 `ABC123` / `HELLO` / `X7` / `WELCOME` 四个字符串，置信度 0.999 级、位置单调递增【提交记载】。但这次验证**没有变成自动化用例**（本次全仓库 grep `ABC123` / `WELCOME` **零命中**），所以它**不是回归保护** —— 将来 CTC 前处理改错，测试套件不会报警 | 中 |

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

### 4.4 最近的提交做了什么（`cdf2957` → `769227b`，HEAD = `769227b`）

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
| `c2a09b1` | — | — | **最新提交**（提交主题与作者字段**未逐字复核**，本行按已知事实描述） | 两件事：① 新增 `src/lib/sessionDiagnostics.test.ts`（**11 个用例**），为**会话诊断模块**补上覆盖 —— **它是那次六轮排查唯一能收敛的工具，而它自己此前没有测试**；**它一旦静默失灵，同类故障会重新变得无从下手**。重点钉住的语义：`getLastReloadReason()` 在没有记录时**必须返回 `null`**（这个 `null` 正是区分「浏览器回收标签页」与「应用自己刷新」的**唯一依据**）；阶段轨迹**必须保留多条**（只留最后一条会毁掉画布尺寸，**这个坑真踩过**）；轨迹有上限；`sessionStorage` 抛异常时全部接口**安全降级**。② 修掉模型体积的口径不一致：`FileUploadZone.tsx`（两处，**用户可见的 OCR 对话框文案**）、`ocrTypes.ts`（两处）、`pdfParser.ts`（一处）里的「约 10MB」全部改为「**约 30MB**」。写法上有一处细节值得记：写那条降级用例时**第一次失败**，因为 **vitest 跑在 node 环境下没有 `window`**，改用 `globalThis` 后才通过 |
| `d6b07e6` | 2026-10-07 21:44 | Universal Reader Dev | feat(ocr): use a layout model for page furniture and reading order | 接入 **PP-DocLayout-S** 做**页眉页脚 + 阅读顺序**。**原定方案被体积证伪**：`PP-DocLayoutV2.onnx` **213,303,073 字节（203.42 MiB）**、`V3` **129,920,689（123.90 MiB）**，而 Cloudflare Pages 单文件上限 **25 MiB**（官方 limits 页）—— 超 **5–8 倍**；换 `.ort` 也救不了（**同样的字节**，只是加载快，且该仓库**没有**版面模型的 `.ort`）。改用 **4,917,852 字节（4.69 MiB，占上限 18.8%）** 的 PP-DocLayout-S，sha256 与声明一致、上游 Apache-2.0。新增 `src/lib/layoutAnalysis.ts`（**856 行**）＋ `layoutAnalysis.test.ts`（552 行）＋ `ocrPostProcess.layout.test.ts`（296 行），并改 `scripts/fetch-ocr-models.mjs` 与 `scripts/verify-dist.mjs`。**只接了页眉页脚与阅读顺序**，用户另外两个痛点（公式行被判成大标题、跨行大括号错误合并）**没有动**。**关键安全不变量**：没有版面信息时输出与接入前**逐字节相同**，`analyzePageLayout()` 任何失败返回 `null`、**从不抛异常**。**未验证**：从未跑过真实推理。见 **§5.11** |
| `3d2e88f` | 2026-10-07 22:05 | Universal Reader Dev | feat(ocr): character-level boxes, so superscripts become measurable | **字符级坐标**：`ppu-paddle-ocr` **内部已经在算每个字符的横向位置**（`core/recognition/ctc.d.ts` 的 `DecodedText.positions`，CTC 峰值占输入宽度的比例），但**公开 API 不暴露**（`exports` 只有 `.` / `./web` / `./mobile`，深路径不可用）—— 于是自建 CTC 贪心解码取回它，再对每个字符的横向切片做**逐列墨迹分析**得到**真实纵向范围**：上下标从「猜阈值」变成「可测几何事实」。**零新依赖、零新模型**。新增 `src/lib/ocrCharBoxes.ts`（**1,413 行**）＋ `ocrCharBoxes.test.ts`（1,039 行）＋ `src/lib/ocrInkRegions.ts`（342 行）＋ `ocrInkRegions.test.ts`，`git show --stat` 实测 **6 个文件 / +2,656 −4 行**。修掉两个真缺陷：`cropWord` **漏乘降档系数**（0.7/0.5/0.35 画布裁错位）、上下标边界的**浮点翻面**（`0.72−1.08 = −0.3600000000000001`，正确下标被误判，加 `SHIFT_EPSILON = 1e-9`）。**落地磕了三次**（交付版与另一路同时改 `ocrPostProcess.ts`；被 `git add -A` 连同未完成工作提交、主分支缺模块坏掉，由 `77372d9` revert；最终 `tsc` 报 **5 个真实类型错误**，而交付方自己的「影子工程类型检查」把 **176 条诊断**归因成「脚手架缺依赖的假报错」→ 报 0 个真实错误）。见 **§5.12** |
| `85c3714` | 2026-10-07 22:11 | Universal Reader Dev | feat(ocr): export the character boxes, or we cannot tell why scripts did not apply | `src/lib/ocrStructure.ts` **+56 行**：识别结构导出里加上 `words[].chars` 与 `wordsWithChars`。**「没有字段」≠「字段为空」**：前者说明字符级这一步**没跑成**，后者才是「跑了但没框」。起因是用户导出后**看不出为什么上标没生效** —— 整条字符级链路是「静默降级」设计（对一个用户是对的：一个字符拿不到框不该毁掉一页；对诊断是灾难）。同一次导出还确认了上一轮修的三件事在用户数据里成立：`[10]`/`[13]` 不再粘连、`[17,18]`/`[19]` 分开、该页 15 → 17 行【用户导出】 |
| `42dd59f` | 2026-10-07 22:18 | Universal Reader Dev | feat(ocr): stamp the export with the build that produced it | `ocrStructure.ts` **+16 行**：导出里带上 **`buildId`**，由 `vite.config.ts` **每次构建注入**（`__BUILD_ID__: JSON.stringify(new Date().toISOString())`，本次读源码实测）。起因：`1deb6c1` 的修复**已部署**（Cloudflare Pages 与 verify 两项 check 均 success、线上入口 chunk 已换新）而用户的导出**仍是修复前的行为** —— **分不清「修复没生效」与「你还没拿到修复」，而两者的下一步动作完全相反**。它**立刻起了作用**：下一次导出显示的 `buildId` 与上一次**完全相同**，一眼确认是旧构建【用户导出】（同时也暴露了 §4.2 里那条 SW 更新缺陷） |
| `1deb6c1` | 2026-10-07 22:16 | Universal Reader Dev | fix(ocr): a midline symbol is not a superscript | 用户导出里出现 `"text": "(2) 求 Z $^{=}$ X + Y 的概率密度."` —— **等号被包成了上标**。真实像素：`求` bbox `[296,1174.3,320,1202.8]`（高 28.5、底边 1202.8、**中心 1188.55**）；`=` bbox `[378,1186.3,398,1193.6]`（高 7.3、底边 1193.6、**中心 1189.95**）。等号又矮、底边又高，**但中心比正文还低 1.4px** —— 它**没有升高，只是矮**。原判据**只看底边**，于是把它读成「升起来了」；补上**中心位移**，门槛取 **0** 且**可推导**：`中心位移 = 抬高量 + 半自身高 − 半主字高`，实测等号为 **−0.077**、而恰好在抬高下限的浅上标为 **+0.025**，两者落在 0 两侧。**两个方向都有用例**（等号不得被判、真指数仍要判），夹具用**真实像素值**换算、不是编的。已知代价写在常量注释里：抬得极少且自身偏高的字可能被漏判 —— **宁可漏判，也不要把等号包成上标**。见 **§5.12** |
| `984af78` | 2026-10-07 22:23 | Universal Reader Dev | feat(ocr): export why each word failed to get character boxes | `attachCharBoxes` 在**三个失败出口**本来就报原因（**尺寸不合适 / 裁剪失败 / 未解出字符 / 字符序列与词文本不一致**），但只送进 **`console.warn`** —— **而用户看不到控制台**：能一轮定位问题的证据被写进了没人能读的地方。原因改为收集进 `ocrCharBoxes`（`recordCharBoxSkip` / `getCharBoxSkips` / `clearCharBoxSkips`，**按页清空**）并由导出携带成 `charBoxSkips`。`git show --stat`：3 个文件 / **+60 −2 行**。数据随后否掉了作者此前的解释：词 10 只有 **44px** 宽也没拿到框，而词 3 **825px** 宽反而拿到了 —— **宽度不是判据**；**15 / 23** 个词失败【用户导出】 |
| `f8cc1bc` | 2026-10-07 22:44 | Universal Reader Dev | feat(ocr): report what the re-recognition actually produced | `ocrCharBoxes.ts` **+18 −1 行**：15 条失败原因**全部**是「字符序列与词文本不一致」，**没有一条**命中尺寸闸、也**没有一条**是「未解出字符」—— 于是两个此前的猜测（**WebGPU**、**词太宽**）同时被否掉，真因一直就在**同一个出口**里。但「只有原因」仍然不够定位：整串错位、少字符、认错符号对应**三种不同修法**，区别**全在被丢弃的那段文本里** —— 于是失败信息带上**重新识别得到的文本与两个长度**。**同一个失误在这个序列里出现了三次**：先是**没原因**（`984af78` 之前）、然后**没内容**（`984af78` 只给了「不一致」）、再然后**内容被截断到 40 字符**（`f8cc1bc` 写的是 `${recognized.text.slice(0, 40)}`，本次读 diff 实测），最后由 `769227b` 改为完整文本 |
| `769227b` | 2026-10-07 22:51 | Universal Reader Dev | **fix(ocr): reconcile across formatting, not just whitespace**（**HEAD**） | 15 条原因带上重识别文本后**一眼看清**：差别**几乎全是格式** —— 半角括号 vs 全角（`(1)` vs `（1）`）、汉字之间空格时有时无、大小写（`P).` vs `p).`）。**内容是对的。** 归一化由「只去空白」扩为 **去空白 + 全角转半角（`[\uFF01-\uFF5E]` 码位减 `0xFEE0`，**逐字符一一对应**，所以归一化后按下标对齐仍然成立）+ `toLowerCase()`**（`reconcileWithWordText` 的 `canonical()`，本次读源码实测）。**三条必须继续失败**（是真的认错字，放行会让字符框对到**别的字**上，比没有框更糟）：`）`→`1`、`0，`→`O，`、`μ>0`→`μ0`（漏掉 `>`）。**效果**：`wordsWithChars` **8 → 15**（同一份文档、同一次识别条件）【用户导出】。测试新增 **9 个用例**，**全部用用户真实字符串**、两个方向都覆盖；剩 **8 个词**仍拿不到字符框 —— 见 §5.12 |

> ⚠️ **上表最后 8 行是本次新补的（今天后半程，2026-10-07 21:44 → 22:51）**，
> 它们的**主题、日期、作者字段本次逐字复核过**（`git log --pretty=format:"%h|%ad|%an|%s"`），
> 改动内容则以 `git show --stat` 与**读源码**为准；涉及用户实测数据的地方标了【用户导出】。
> `d6b07e6` 是这 8 个里唯一触及**模型来源**的提交（新增第二个仓库），其余 7 个都在**同一份用户扫描件**上做增量。

> 注：`a766d3f` / `aa8827a` 的作者是 `Universal Reader Dev`（其余几个是 `Mercuryof37`），
> 主题前缀也因此从 `fix:` 变成 `fix(pwa):`。
>
> 注：`ed66ba8`、`780c54c`、`c2a09b1` 的提交信息与作者字段未逐字复核，那几行按已知事实描述
> （`ed66ba8` 只新增测试文件、与 `fc79896` 产物相同；`780c54c` 的改动内容见 §5.10；
> `c2a09b1` 新增 `src/lib/sessionDiagnostics.test.ts` 并修掉模型体积口径，见 §5.10.3 与 §5.10.7）。
>
> 注（**用例数会变，不要照抄旧数字**）：`src/lib/pwaReload.test.ts` 与 `src/lib/ocrCheckpoint.test.ts`
> 现在**各有 10 个用例** —— 此后又补进了「**已导入但还没点开始识别的扫描件**也算忙」（`state.scannedPdfPending`）、
> 「离线时不自动刷新」，以及「**第一页成功产出内容时立刻落盘**」这几条。
> 上表按**提交当时的**事实记录，现状以仓库里的测试文件为准。

#### 文档缺口：`c2a09b1` 之后还有 17 个提交**没有写进本文**（2026-10-07 12:15 → 21:36）

**这是本次核对时发现的、比「8 个提交没记录」更大的缺口，必须如实留在这里。**
【实测】`git rev-list --count c2a09b1..HEAD` = **25 个提交**；本文逐条记录的只有**最后 8 个**。
下表的 17 个**只有清单**（主题、时间、规模均为 `git log` / `git show --shortstat` 实测），
**内容本次没有展开** —— 不在这一轮的任务范围内，**也请不要凭主题去猜它们改了什么**。

| commit | 时间 | 主题（原文） | 规模 | 与本轮的关系 |
|---|---|---|---|---|
| `2c30b9f` | 12:15 | fix(test): stop the diagnostics tests depending on the local Node version | 2 files, +96 −33 | 与 `c2a09b1` 新增的诊断测试同批，测试稳定性 |
| `88c2a30` | 12:29 | feat(ocr): warn about old-kernel browsers, and actually block the unsupported ones | 3 files, +323 −92 | §5.10 的能力检测真正落地（`780c54c` 之后） |
| `75cf7e2` | 13:01 | fix(ocr): remember the crash across sessions, or the warning never shows | 7 files, +226 −11 | 崩溃记忆要跨会话，否则警告永不出现 |
| `927c0f9` | 13:16 | fix(ocr): do not count an ordinary OCR error as a browser crash | 1 file, +16 | 误判防护 |
| `a72d02d` | 13:23 | fix(ui): make the diagnostic banner's close button work, and stay closed | 3 files, +154 −5 | §5.10.3 的诊断横幅 UI |
| `99fbdb7` | 14:14 | fix(ocr): count crashes per build, and let the user override a history-based block | 8 files, +176 −12 | **「按版本隔离崩溃记忆」就是它**；`__BUILD_ID__` 的最初动机之一 |
| `e38d6b9` | 14:20 | fix(ui): remove markdown asterisks from a user-facing message | 1 file, +3 −1 | 文案 |
| `d7f9e64` | 15:09 | feat(ocr): read sub/superscripts, order multi-line constructs, and find missed regions | **10 files, +3,214 −37** | **`1deb6c1` 修的就是它引入的上下标/构件判据**；§5.12 的直接前身 |
| `ad188b3` | 17:39 | chore: drop a stray probe file committed by mistake | 1 file, −1 | 清理 |
| `b9eb46b` | 17:53 | fix(ocr): start a new paragraph at every numbered item | 1 file, +25 | 断段规则 |
| `24b0332` | 19:21 | feat(ocr): export the real recognition structure, and fix a dropped character | **7 files, +1,264 −5** | **`src/lib/ocrStructure.ts` 的诞生** —— §5.12 的导出功能都建在它上面 |
| `7ccf9d2` | 19:34 | fix(ocr): a horizontally contained line is not automatically a branch | 2 files, +98 | 跨行构件合并误判 |
| `60cfb26` | 19:46 | fix(ui): raise the contrast of every warning box's text | 3 files, +15 −3 | 用户实测反馈的可读性修复 |
| `00c358c` | 20:27 | fix(ocr): stop leaking page furniture, and stop calling formulas headings | 2 files, +494 −26 | **§5.11 要用版面模型替换掉的那两个几何启发式**（页脚泄漏、公式行被判标题） |
| `9dba173` | 21:20 | fix(ocr): a sentence of prose is not a branch | 2 files, +464 −2 | 同上，分支合并 |
| `42c7af1` | 21:34 | docs: character-level OCR research, and the route it changes | 5 files, +902 −3 | **新增 `docs/字符级OCR技术调研.md`** —— §5.12 的理论依据（🟢/📘/🔭/❓ 证据分级出自它） |
| `77372d9` | 21:36 | revert: undo half-finished OCR work that a broad `git add` swept in | 4 files, +3 −459 | **`3d2e88f` 提交信息里那句「被一次 `git add -A` 弄坏主分支」就是它** |

> **补文档时按 §4.4 表格的同样格式填**（commit / 日期 / 作者 / 主题 / 实质改动），
> 改动内容以 `git show --stat` 与源码为准，**不要用主题反推**。
> 这 17 个提交的**作者全部是 `Universal Reader Dev`**（本次 `git log` 实测）。

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

> ✅ **已修复（`c2a09b1`）：模型体积的口径不一致。** 模型三个文件合计 **29.9MB**
> （`src/lib/ocrEngine.ts` 自己的报错文案里写着 `检测模型 9.52MB · 识别模型 20.30MB · 字典 0.07MB（合计约 29.9MB）`，
> `scripts/fetch-ocr-models.mjs` 里的期望字节数也是这三个），
> 而**代码里仍写着「约 10MB」**（`FileUploadZone.tsx` 第 91、220 行 —— 这两处是**用户可见的 OCR 对话框文案**，
> `ocrTypes.ts` 第 9、35 行，`pdfParser.ts` 第 466 行的注释），与实测值差了近三倍。
> **`c2a09b1` 已把这五处统一改为「约 30MB」**（检测 9.52MB + 识别 20.30MB + 字典 0.07MB）。
> **29.9MB 是实测值，约 30MB 是它对用户的口径** —— 这条**不再是待办**，接手时也不要改回 10MB。

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
| 提交 | **`c2a09b1`**（**最新提交**：会话诊断测试 + 模型体积口径修正）；本条的能力检测在 **`780c54c`**，它之前还有几个提交，见 5.10.7，哈希本文未记录 |
| `npx vitest run` | **257 passed / 25 files**（上一轮记录为 20 个文件 / 216 个用例；`780c54c` 新增 `src/lib/ocrSupport.test.ts` **5 个用例**，`c2a09b1` 又新增 `src/lib/sessionDiagnostics.test.ts` **11 个用例**，连同 5.10.7 里的几个测试文件一起计入这 **25** 个文件） |
| `npm run build` | `PWA v1.3.0  mode generateSW  precache 18 entries (3587.32 KiB)`；`[verify-dist] 构建产物校验通过` —— 产物共 **86 个文件 / 35.44 MB**，其中 **OCR 模型 3 个 / 29.90 MB** |
| 关键文件 | 新增 `src/lib/ocrSupport.ts`（**104 行**）· `src/lib/ocrSupport.test.ts`（**68 行**）· `src/lib/sessionDiagnostics.test.ts`（**11 个用例**） |
| 部署状态 | **已核实**：`780c54c` 的 `verify` 与 `Cloudflare Pages` 两项 check **均为 success**；`c2a09b1` 是随后的一次提交 |
| 浏览器基线（§2） | Chrome / Edge 119+、Firefox 121+、Safari 17.4+ —— 检测判据与这条基线一致（都落在 **WASM SIMD** 这一项上） |
| 用户侧的真机结论 | 「Firefox、Chrome、Microsoft Edge 都可以正常使用，但是 360 不行」（**这是本故障唯一的真机旁证，也是它的定论**） |

#### 5.10.10 必须如实保留的未验证点

- **能力检测在真机上的表现没有验证过**：本机**装不了 360**，也没有其它内核过旧的外壳浏览器可用，
  所以「真机上会不会被正确拦下」只有 `ocrSupport.test.ts` 的 5 个用例与 Node 环境下的求值，
  **没有一次真实浏览器验证**。
- **`src/lib/sessionDiagnostics.ts` 的自动化测试是 `c2a09b1` 才补上的**（`src/lib/sessionDiagnostics.test.ts`，
  **11 个用例**）；它跑在 **Node（vitest 默认环境）**里 —— 写降级用例时因此不能用 `window`，改用 `globalThis`。
  5.10.3 里那张表仍是**代码审阅**的结论：测试钉住的是模块的**接口语义**，**不等于**"真机上诊断一定显示正确"。
- **PaddleOCR 在真实扫描件上的中文识别准确率仍未量化验证**（R1 依然成立）——
  已有的只是用户口径「Firefox、Chrome、Microsoft Edge 都可以正常使用」，**没有**证明"识别得准"。
- 部署状态**已核实**：`780c54c` 的 `verify` 与 `Cloudflare Pages` 两项 check 均为 **success**；
  `c2a09b1` 是随后的一次提交。

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

### 5.11 版面分析：用版面模型替代几何启发式（`d6b07e6`）

> 本节与 §5.12 是**今天后半程（2026-10-07 21:44 → 22:51，8 个提交）**的记录。
> 记号：【实测】本次现场量到的 ·【提交记载】提交信息/源码注释的记载，本次未复现 ·
> 【用户导出】用户的导出数据或原话 ·【推测】由上述推断 ·【未验证】本次没有验证。

#### 5.11.1 要替换掉的是什么（现象）

用户那份扫描版习题 PDF 上，本项目**连续六轮**修复都在打**同一类**边界情况：
合并逻辑 → 行结构 → 段落切分 → 页眉页脚过滤 → 标题判定 → 过度合并。
根因不在某一处代码，而在**方法**：这些本该由版面分析直接回答的**语义**问题，此前全靠**几何启发式**猜。

| 语义问题 | 之前的猜法（`ocrPostProcess.ts`） | 猜错的后果（用户实测） |
|---|---|---|
| 这行是页眉/页脚吗 | `filterHeaderFooter()`：落在页面上下各 **5%** 边距 **且** 字号 < 全页中位数 **0.85 倍** | 页眉「概率论与数理统计习题5」与页脚「单周周一下午2点前交作业」**被当成正文**（`3d4a2ad`） |
| 这三行公式是大标题吗 | 字号 > 中位数 **1.3 倍** + 文本「像标题」 | 三行公式**被误判成大标题** |
| 跨行大括号的几个分支是一段吗 | 纯几何的两两合并 | 分支与正文行**反复错误合并** |

版面模型的输出**就是**这些区域及其类别（header / footer / formula / paragraph_title / text / …），
**语义不需要再猜**。

#### 5.11.2 选型：原定方案在**体积**上被证伪【提交记载】

这条约束是硬的：本站是零后端静态站点，部署在 Cloudflare Pages，官方 limits 页写明
**单个静态资源上限 25 MiB**（原文 "The maximum file size for a single Cloudflare Pages site asset is 25 MiB."）。
现有 OCR 三件套正是按它拆成三个文件的（**本次实测三件合计 31,348,116 字节 ≈ 29.9 MiB**）。

| 候选（`ppu-paddle-ocr-models` 仓库内） | 字节数 | MiB | 占 25 MiB | 结论 |
|---|---|---|---|---|
| `layout/PP-DocLayoutV2.onnx` | **213,303,073** | **203.42** | **813%** | ❌ 超 **8 倍** |
| `layout/PP-DocLayoutV3.onnx` | **129,920,689** | **123.90** | **495%** | ❌ 超 **5 倍** |
| `layout/PP-DocLayoutV2.ort` / `V3.ort` | — | — | — | ❌ **不存在（404）**；`.ort` 只是**加载更快、字节不减少** |
| **`stefanj0/PP-DocLayout-S-ONNX` 的 `pp_doclayout_s.onnx`** | **4,917,852** | **4.69** | **18.8%** | ✅ **采用** |

- 证据方式（据源码注释）：**HuggingFace API `blobs=true` + 逐文件 HEAD 双重核对**，
  两证一致；25 MiB 上限引自 Cloudflare 官方 limits 页原文。
  ⚠️**【未验证】本次没有联网复验这三个体积**（本机 `web_fetch` 直接失败、`huggingface.co` 不可达，
  后者与源码注释里记的「本机 `huggingface.co:443` 不可达」一致）。
- **`.ort` 救不了这件事**这一点值得单独记：`.ort` 是**同一份权重换一种容器**，
  体积不缩水；而该仓库**根本没有**版面模型的 `.ort`（`layout/*.ort` 全 404）。

#### 5.11.3 采用的模型与【实测】资产数字

| 项 | 值 | 来源 |
|---|---|---|
| 文件 | `public/ocr-models/layout/PP-DocLayout-S.onnx` | 【实测】目录 |
| 字节数 | **4,917,852**（4.69 MiB，上限的 **18.8%**） | 【实测】`Get-ChildItem` |
| sha256 | `33688dbee1c23e34b81777e97cb428eb40f24b242c02b5f623484959e830aec8` | 【实测】`Get-FileHash`，与 `LAYOUT_MODEL_SHA256` 及来源仓库声明**三者一致** |
| 许可 | 上游权重 `PaddlePaddle/PP-DocLayout-S` **Apache-2.0**；ONNX 导出件同许可 | 【提交记载】 |
| 类别数 | **23**（顺序即 `class_id`：`paragraph_title` 0 … `header` 13 · `footer` 15 · `seal` 16 · `formula_number` 19 · `aside_text` 22） | 【实测】读 `LAYOUT_LABELS`（顺序不能改，错一位会把页脚认成公式且**不报错**） |
| 模型资产合计 | `public/ocr-models/` **4 个文件 / 36,265,968 字节 = 34.59 MiB** | 【实测】 |
| 上游自评精度 | mAP(0.5) = **70.9**（自建评测集，500 张中英文论文/报纸/试卷等）；V3 精度更高但**发布不出来** | 【提交记载】 |

> ⚠️ **诚实说明**：`ppu-paddle-ocr-models` 自己**并不提供**能在 25 MiB 内发布的版面模型，
> 所以本项目现在有**两个模型来源**（`OCR_MODEL_SOURCE` / `OCR_LAYOUT_MODEL_SOURCE` 可分别覆盖）。
> 这一点写在 `layoutAnalysis.ts` 与 `fetch-ocr-models.mjs` 的注释里，不是遗漏。
>
> ⚠️ **顺带发现的一处口径漂移（本次只记录、没有改代码）**：加了这第 4 个模型之后，
> **用户可见的两处文案仍是「约 30MB」**（`FileUploadZone.tsx:110` 与 `:295`），
> 而实际是 **34.59 MiB**；`ocrEngine.ts:313` 的启动日志也仍写「合计约 29.9MB」（未算版面模型）。
> 这类「界面数字与实际不符」正是 `c2a09b1` 刚修过的那一类问题，见 §7 的 P2 表。

#### 5.11.4 I/O 契约（**逐字节解析 onnx protobuf 得到，不是抄文档**）【提交记载】

| 张量 | 形状 | 含义 |
|---|---|---|
| 入 `image` | float32 `[N,3,480,480]` | 直接**拉伸**到 480×480（`keep_ratio: false`），ImageNet 归一化（mean `[0.485,0.456,0.406]`、std `[0.229,0.224,0.225]`）→ CHW |
| 入 `scale_factor` | float32 `[N,2]` | 传 `[480/原高, 480/原宽]`，检测头据此把框**除回原图像素坐标系** |
| 出 `fetch_name_0` | float32 `[M,6]` | 每行 `[class_id, score, x1, y1, x2, y2]`（NMS 已烘焙进图内：score 0.3 / nms 0.5 / keep_top_k 100） |
| 出 `fetch_name_1` | int32 `[N]` | **有效行数**（其余是 padding，**必须信它**） |

`scale_factor` 这一项是**最容易静默出错**的地方：不除回去，所有区域坐标会整体偏一个比例因子，
**不会报错**，只表现为「页眉页脚判得莫名其妙」。因此 `decodeLayoutDetections()` 会显式校验
输出坐标是否落在图像范围内，**越界即整体放弃**。

#### 5.11.5 接入范围与三条安全设计

1. **只接了页眉页脚 + 阅读顺序**（`applyLayoutToLines`）。用户另外两个痛点
   ——「公式行被误判成大标题」与「跨行大括号错误合并」——**没有动**：
   那两个要改的是**判据本身**，回归风险大，不是能在「跑不了测试」的状态下顺手做的改动。
2. **逐字节回退不变量**：没有版面信息（模型没取到 / 推理失败 / 结果越界 / 用户关闭）时，
   输出与接入前**逐字节相同**。`src/lib/ocrPostProcess.layout.test.ts` 的**第一组用例锁的就是这条不变量**
   （而不是新功能）。【提交记载】＋【实测】读源码与用例
3. **`analyzePageLayout()` 任何失败都返回 `null`，从不抛异常**；失败会**缓存成「本会话不可用」**
   （`sessionPromise` → `null`），避免一本几百页的书每页都重试一次网络往返或建会话。
   逃生开关：`VITE_OCR_LAYOUT=0` 一键回到接入前行为（排查「是不是版面分析弄丢了内容」时用）。
   【实测】读源码
4. **构建期硬门禁**：`scripts/verify-dist.mjs` 把 `layout/PP-DocLayout-S.onnx` 列入**必需模型**，
   缺失即**构建失败**；并对产物里每个文件统一复查 25 MiB 上限。
   缺了它的表现是「版面分析静默退回几何启发式」，而几何启发式正是本次要替换掉的东西。
   【实测】读源码

#### 5.11.6 落地时的一个真 bug（已修）与一个**同形状、仍未修**的隐患

**已修（`d6b07e6`）**：下载脚本 `download()` 用 `base + file.path` 拼 URL，而那条记录的 `path`
**同时**被当成远端路径，于是拼出 `.../resolve/main/layout/PP-DocLayout-S.onnx` → **404 → 构建直接失败**。
修法是把 `path`（**本地**落盘位置）与 `remote`（**远端**文件名）**拆成两个字段** ——
该文件在 HF 仓库的**根目录**下，叫 `pp_doclayout_s.onnx`。
【提交记载】实测正确地址（hf-mirror，HTTP 200、长度与期望值一致）。

> ⚠️ **同形状的问题仍在（本次读源码发现，未验证影响面）**：
> **浏览器侧**的 `ocrModelSource.buildLayoutModelUrl(base)` **仍然只拼本地路径** ——
> `buildLayoutModelUrl(OFFICIAL_LAYOUT_MODEL_BASE)` 会得到
> `https://huggingface.co/stefanj0/PP-DocLayout-S-ONNX/resolve/main/layout/PP-DocLayout-S.onnx`，
> 也就是**同一个 404**。默认（同源 `/ocr-models`）**不受影响**，因为模型已在 `public/ocr-models/layout/`；
> 只有把 `VITE_OCR_LAYOUT_MODEL_BASE` 指向那个 HF 仓库时才会踩到 —— 而源码注释恰好把这**写成受支持的用法**
> （「自建镜像时用」），`OFFICIAL_LAYOUT_MODEL_BASE` / `MIRROR_LAYOUT_MODEL_BASE` 两个常量也是为此导出的。
> **没有任何测试钉住它**：本次 grep 实测，`ocrModelSource.test.ts` 的 7 个用例**没有一条**涉及 layout URL。
> 修法应是把 `remote` 的概念也搬到运行期（或在 `LAYOUT_MODEL_FILES` 里补一个远端名）。

#### 5.11.7 这一轮的未验证点（**必须保留**）

- **【未验证】版面模型从未跑过真实推理。** 提交信息自己写明：
  「Not verified: no real inference has been run against this model. Its accuracy on an actual scan is unknown,
  so the tests prove the plumbing and the fallback, not the quality.」
  也就是说：**测试证明的是「接得对、退得回」，不是「判得准」**。
- **【用户导出】唯一一条正面观察是「日志显示它多滤掉一行页脚」** ——
  没有量化数据、没有可复现步骤，**不要把它当成「版面模型有效」的证据**。
- **【提交记载】一个 guard（`hasUnlocated`）被发现有「行为上不可观测」的问题**，
  于是**如实报告**，而不是写一条永远不会失败的测试来假装覆盖。这条纪律值得继承。

#### 5.11.8 顺带记一条环境事实：这台机器跑不了 `vitest`（写给接手者）

- **【实测】** 本次在 `D:\Deepseek\DSH` 下执行 `node node_modules/vitest/vitest.mjs run`，
  启动即失败：`Build failed with 1 error: [plugin externalize-deps] Error: spawn EPERM
  at ChildProcess.spawn…`，栈顶是 vite 的 `optimizeSafeRealPathSync()`（`net use` 探测网络驱动器）。
  这是**沙箱的既定边界**（程序不能用管道 stdio 起子进程），**不是代码问题**。
- 同一个事实在仓库里也有留痕：`src/lib/ocrPostProcess.layout.test.ts` 的文件头注释写着
  「本机对 `universal-reader` 子树的写入被拒、`npx vitest run` 也跑不起来（vite 的 `spawn EPERM`）」，
  —— 作者当时**也**跑不了测试。
- **因此**：§4.1 那张表里今天后半程的测试与构建数字**全部是【提交记载】＋【用户导出】**。
  接手者第一次拿到可写环境时，**第一件事就是把 `vitest run` 跑出来**，确认 489 这个数字。

---

### 5.12 字符级坐标：把「更小、更靠上」变成可测几何（`d7f9e64` → `769227b`）

> 本节的主线：**用户要的「上标/指数」判了 8 轮都没成**，最后不是靠调阈值，而是靠**拿到字符级坐标**。
> 过程中暴露的两个工程教训（「静默降级对诊断是灾难」「通过解释掉自己失败而变绿的门禁」）
> 比功能本身更值得读。

#### 5.12.1 问题：指数与基字**同在一个词框里**，词级判据在几何上不可见

用户那份扫描件第 17 题，识别出来是**一个词**：

```
词 1: "17. 设 随机 变量 (X ,Y) 具有 分 布律 P {X = x ,Y = y}
      = p (1 − p )x+y−2 ,0 < p < 1,x ,y 均为 正"
      bbox [225, 212, 1604, 255]   fontSize 43
```

指数 `x+y−2` 与整行**同在这一个检测框里**。而 `ocrPostProcess.ts` 里当时**所有**上下标判据都是
**词级**的（比较两个词框的高度与中心 y）—— **同框内部的指数在几何上根本不可见**，
判据再准也判不出来。作者在 `ocrCharBoxes.ts` 顶部如实记了这一句：
「我此前告诉用户这是不可能的」。

#### 5.12.2 依据：库**内部已经在算**字符位置，只是没有暴露【实测】

- **【实测】** `node_modules/ppu-paddle-ocr/core/recognition/ctc.d.ts` 里 `DecodedText` 确有
  `positions: number[]`，注释原文：「per emitted character, the fraction (0..1) of the input width
  where its timestep fired; CTC peaks near the glyph's center」。
- **【实测】** 该包的 `package.json` 的 `exports` 只有 `.` / `./web` / `./mobile` / `./coi-serviceworker.js`，
  **深路径确实不可用**；公开 API 也不把 `positions` 交出来。
- **结论**：**横向**位置必须自己按 `core/recognition/ctc.js` 的算法**重写一遍贪心解码**才能拿到；
  **纵向**库完全不给，必须自己做像素分析（在字符中心那一列上找墨迹的 y 范围）。
  **零新依赖、零新模型** —— 这也是 `docs/字符级OCR技术调研.md` 里 A 方案被选中的理由。

> 与库的识别前处理必须**逐项一致**，否则 CTC 解码全是错的。`ocrCharBoxes.ts` 顶部用一张表
> 逐条写明依据（输入高度 48、宽度 `max(8, round(48*宽/高))`、三通道同值、归一化 `R/127.5 − 1`、
  输入名 `x`、`BLANK_INDEX = 0`），每一项都注到 `node_modules` 的具体文件与行号。

#### 5.12.3 做法与一次性实测【提交记载】

- 横向：自建 CTC 贪心解码（逐步 argmax → 合并重复 → 去 blank），**保留时间步**。
- 纵向：对每个字符的横向切片做**逐列墨迹分析**（亮度阈值 `CHAR_INK_LUMA_THRESHOLD = 160`，
  取中灰偏亮是为了不削掉浅灰抗锯齿边缘，否则「更小」这个判据会失真）。
- **【提交记载】用真实 21.29MB 识别模型（不是合成夹具）的一次性实测**：
  `ABC123` / `HELLO` / `X7` / `WELCOME` **四个已知字符串全部正确解出**，置信度 **0.999 级**，
  位置**单调递增**。其中 `X7` 最能说明问题：字形 `7` 量到高 **0.438**、`X` 是 **0.771** ——
  **纵向范围确实是逐字符量出来的，不是整块框高**。
- ⚠️ **但它不是回归保护**：【实测】本次全仓库 grep `ABC123` / `WELCOME` **零命中**，
  说明那次验证**没有落成自动化用例**（也没有留下脚本）。将来 CTC 前处理一旦改错，测试套件**不会报警**。
- **【提交记载】** 在用户真实问题行上，输出变成 `p (1 - p ){x+y-2}$` 形态 —— 指数被包了进去。

#### 5.12.4 挂载方式：`WeakMap` 旁挂，不污染 `OcrWord`

字符框**刻意不挂在 `OcrWord` 上**，而是用 `WeakMap` 旁挂，只能经 `getAttachedChars()` 取
（`ocrStructure.ts` 顶部专门为此写了一条注释：看上去像「少了一个字段」，其实是刻意设计）。
**没有字符框的词，一个额外属性都不加**；任何一步失败都只跳过**这一个词**，不影响整页识别。
【实测】读源码。

#### 5.12.5 修掉的两个真缺陷（`3d2e88f`）【提交记载】＋【实测】读源码

| 缺陷 | 现象 | 修法 |
|---|---|---|
| `cropWord` **漏乘降档系数** | 词框是在**降档画布**（0.7 / 0.5 / 0.35，内存压力下确实会发生）上量的，裁剪时没乘回去 → **裁到别处的内容**。对账会拦住（不会写出错坐标），但每个词都白跑一次推理，**字符框一个也拿不到** | `sx/sy/ex/ey` 全部乘 `scale` |
| 上下标边界的**浮点翻面** | 位移上限是 `0.5 × 主字高`；一组「正好卡在上限」的真实比例（主字高 0.72、下标高 0.36、顶边在基线上）算出 `0.72 − 1.08 = −0.3600000000000001`，而 `0.5 × 0.72 = 0.36` → `0.3600000000000001 <= 0.36` 判**假**，**一个完全正确的下标被拒之门外** | 加 `SHIFT_EPSILON = 1e-9`（`ocrCharBoxes.ts:756`），比到处改写比较符更稳妥 |

#### 5.12.6 落地磕了三次 —— 工程教训（**本节最该记住的部分**）

1. **交付版与另一路同时改 `ocrPostProcess.ts`**，而它的副本**早于**那一路上游的整合 → 冲突。
2. **被一次 `git add -A` 连同未完成工作一起提交**，主分支因此**缺模块而损坏** → 由 `77372d9` revert 掉。
   （这也是 §4.4「文档缺口」表里 `77372d9` 那条的由来。）
3. **最终落地时 `tsc` 报了 5 个真实类型错误** —— 而交付方自己的「影子工程类型检查」报了
   **0 个真实错误**：它把 **176 条诊断**归因为「脚手架缺依赖的假报错」，**这个归因把真错误一起放过了**。

> **教训（与 §6 的元教训同源，值得再写一遍）**：
> **一个靠「解释掉自己的失败」而变绿的门禁，比没有门禁更危险。**
> 本项目此前已记录过 4 次同类失误（假守卫），这是第 5 次。

#### 5.12.7 诊断导出：从「看不出为什么」到「一眼看清」（`24b0332` → `f8cc1bc`）

**起因**：用户导出后**看不出为什么上标没生效**。整条字符级链路是**静默降级**设计 ——
对一个用户是对的（一个字符拿不到框不该毁掉一页），**对诊断是灾难**：四种完全不同的失败
（识别器建不起来 / 词框尺寸不合适 / 没解出字符 / 字符序列与词不一致）从外面看**一模一样**。

**现在导出里有什么（`src/lib/ocrStructure.ts`，本次读源码实测）**：

| 字段 | 怎么读 |
|---|---|
| `buildId` | **这份导出是哪一次构建跑出来的**。由 `vite.config.ts` **每次构建注入**（`new Date().toISOString()`）。**没有它，就分不清「修复没生效」与「你还没拿到修复」** |
| `wordsWithChars` | 拿到字符框的词数。**`0` = 字符级这一步根本没跑成**（识别器建不起来等）；**非 0 但文本里没有 `^{}` = 跑了、判据没命中** —— **这是两个不同的问题** |
| `words[].chars` | 该词的字符级框。⚠️ **字段缺失 ≠ 字段为空**：缺失说明这一步没跑成，与「跑了但没框」不是一回事（`ocrStructure.ts` 里为此写了长注释） |
| `charBoxSkips` | **每个没拿到字符框的词，以及它停在哪一个出口**（含**重新识别得到的文本**、期望文本、两个长度）。每页开始前清空，否则会跨页累积 |
| `thresholds` | 本次识别**实际使用**的阈值。写进来是为了让「阈值」与「实测数据」出现在**同一份 JSON** 里，收到数据的人不必翻源码猜 |
| `lines[].stats` | 每行里**可疑的小字**（比本行基线矮 10% 以上）的实测几何：`heightRatio` / `centerShift` / `baselineShift` / `gapToHigherLeft` |

**同一个失误在这个序列里出现了三次**（作者自己记下的）：先是**没原因**（`984af78` 之前，
原因只进 `console.warn`，**而用户看不到控制台**）、然后**没内容**（`984af78` 只报「不一致」）、
再然后**内容被截断到 40 字符**（`f8cc1bc` 的 `${recognized.text.slice(0, 40)}`，本次读 diff 实测），
最后由 `769227b` 改成完整文本＋期望文本。
**每一次都白花了一轮猜测，而那一轮本来可以被一个字段省掉。**

#### 5.12.8 中线符号不是上标（`1deb6c1`）—— 判据缺一条，而不是打补丁

用户导出里出现 `"text": "(2) 求 Z $^{=}$ X + Y 的概率密度."`：**等号被包成了上标**。
真实像素（【用户导出】，也是测试夹具的来源）：

| 字形 | bbox | 高 | 底边 | 中心 |
|---|---|---|---|---|
| `求`（正文） | `[296, 1174.3, 320, 1202.8]` | 28.5 | 1202.8 | **1188.55** |
| `=` | `[378, 1186.3, 398, 1193.6]` | **7.3** | 1193.6 | **1189.95** |

等号是**中线上的两条短横**：**又矮、底边又高** —— 而原判据**只看底边**，于是把它读成「升起来了」。
但它的**中心比正文还低 1.4px**：**它没有升高，只是矮**。

- **补的判据**：**升起来的字，中心不该低于正文中心** → `SCRIPT_CHAR_MIN_CENTER_SHIFT_RATIO = 0`。
- **门槛取 0 是可推导的，不是调出来的**：归一化后
  `中心位移 = 抬高量 + 半自身高 − 半主字高`。实测那个等号是 **−0.077**（中心反而更低），
  而**恰好卡在抬高下限**的浅上标是 **+0.025** —— 两者落在 **0 的两侧**。
- **两个方向都有用例**：等号**不得**被判为上标；同时**正常指数仍然必须被判出来**
  （否则「修复」只是把失败换了个方向）。夹具里的数字由那两组真实 bbox 换算而来。
- **已知代价写在常量注释里**：抬得极少、自身又偏高的字符可能被漏判 ——
  「宁可漏判，也不要把等号包成上标」。
- ✅ **【用户导出】这条修复已被用户的下一份导出确认**：`984af78` 的提交信息记
  「导出确认等号修复生效 —— 那个被包起来的上标消失了，该行 `hasScripts` 为 `false`」。
  这是本轮**唯一**一条「改动在真实文档上被确认生效」的记录（另一条是版面模型多滤掉一行页脚，
  但它只有一句观察、没有量化数据，见 §5.11.7）。

#### 5.12.9 对账：从「只容忍空白」到「容忍格式」（`769227b`，HEAD）

**为什么必须对账**：同一个裁剪**会被识别两次**（库的 `recognize()` 进了 `OcrWord.text`；
本模块为了拿 `steps` 又重跑一次），而库走的是**批次填充**路径，数值上不保证逐比特一致。
分歧本身不可怕，**可怕的是字符数不一致时字符框会整体错位** ——
本来判 `x` 是上标，错位之后判到 `y` 头上，输出就成了错的公式。所以对账不通过就**放弃这个词**。

**原来的闸门**：只做 `replace(/\s+/g,'')` 后要求**逐字符完全相同**。结果 23 个词里 **15 个**被丢弃，
**包括含指数的词 1**（这条路存在的全部理由）。

**15 条原因带上重识别文本后，一眼看清**（【用户导出】，也成了测试夹具）：

| 期望 | 重新识别得到 | 差别 |
|---|---|---|
| `(1） 求 条件 概率 密度 f x\|Y(x \|y).` | `（1）求条件概率密度 f x\|Y(x \|y).` | 半角括号 → 全角、汉字间空格消失 |
| `24. 设随机变量(X,Y)的概率密度为` | `24. 设随机变量(X，Y）的概率密度为` | 半角逗号/括号 → 全角 |
| `P).` | `p).` | 大小写 |

**内容是对的。** 于是归一化扩为 **去空白 + 全角转半角 + 忽略大小写**：

```ts
const canonical = (s: string): string =>
  s
    .replace(/\s+/g, '')
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .toLowerCase();
```

- 全角转半角用**码位减法**（U+FF01–U+FF5E → U+0021–U+007E），**逐字符一一对应**，
  所以**归一化后按下标对齐仍然成立**（这是它敢用的前提）。
- **【实测】代码里写的是 `\uFF01-\uFF5E`**；而 `769227b` 的**提交信息**写成了
  "U+FF01-U+FF7E" —— **提交信息里那个上界是笔误，代码是对的**（FF5E 才是与 0021–007E 一一对应的上界）。
  记在这里，免得后人按提交信息去改代码。
- **三条必须继续失败**（是真的认错字，放行会让字符框对到**别的字**上，比没有框更糟）：
  `）`→`1`、`0，`→`O，`、`μ>0`→`μ0`（漏掉 `>`）。测试**两个方向都覆盖**。
- **效果**【用户导出】：`wordsWithChars` **8 → 15**（同一份文档、同一次识别条件）。
- 测试新增 **9 个用例**，**全部用用户真实字符串**（本次读 diff 实测：新增 9 行 `it(`）。

#### 5.12.10 仍未解决：剩下 8 个词，以及下一步（**这是本节最该先看的部分**）

**8 个词逐条对照后，全部是真的识别差异，不是格式**（【用户导出】）：

| 词 | 期望 | 重新识别得到 | 性质 |
|---|---|---|---|
| **词 1**（含 `x+y−2`） | `= p (1 − p )…` | `= p² (1− p )…` | **多出一个 `²`**；75 / 82 字符 —— **含指数的那一行仍然没有字符框** |
| 词 4 | `μ>0` | `μ0` | 漏 `>` |
| — | `Z= 当X>Y` | `2-, Mx` | 乱 |
| — | `=10,` | `10,` | 漏 `=` |
| 词 10 | `）` | `1` | 认错字 |
| 词 11 | `0，` | `O，` | 认错字 |
| — | `fz(e)= 0` | `20)=0` | 乱 |
| — | `n₂` | `n2` | **Unicode 下标被识别成普通数字** |

**下一步方向已经明确（不要再靠放宽阈值）**：把对账从「**长度相同 + 逐字符相同**」
换成**序列对齐**（容忍插入 / 删除，例如编辑距离 / LCS 对齐），而不是继续放宽阈值。

- 这样**词 1 能拿到字符框**（`x+y−2` 的墨迹范围就能量出来），
  而**真正认错字的仍会因对齐置信度不足被拒绝**（错位对齐的代价必须显式度量）。
- 另有**一步小改动**：把 **Unicode 上下标字符**（如 U+2082 `₂`）**并入归一化** ——
  项目里**已有**同一套映射（`BlockRow.tsx` 的 `normalizeSuperSub()`），复用它即可，不要另写一份。
- ⚠️ **判据没有变**：这一轮**没有**放松任何阈值。中线符号那次（§5.12.8）是**补一条可推导的条件**，
  这次是**换一种对账方式**；「少一点覆盖，绝不产出错的坐标」这条原则不变。

#### 5.12.11 一个**独立待查**的缺陷：连续两次导出拿到**同一个 `buildId`**

- **现象**【用户导出】：`42dd59f` 上线后，用户连续两次导出的 `buildId` **完全相同**
  —— 也就是说，**用户浏览器仍在跑旧构建**。
- **为什么值得单独记**：Service Worker 的自动更新逻辑**在识别期间刻意推迟刷新**（§5.9 缺陷 21 的修法一）。
  但如果 `updatePending` **一直挂着**而刷新始终没发生，用户会**长期停在旧版本**，
  而且**界面上完全看不出来**（横幅只在 `updatePending` 为真时出现，见 `PwaPrompt.tsx`）；
  更糟的是：**导出的 `buildId` 与「修复是否生效」看起来完全一样，无法区分**。
- **现状（本次读源码）**：`onNeedReload` 在忙时只 `setUpdatePending(true)` 就返回；
  「工作一结束就自动刷新」是**另一个组件**（`PwaPrompt.tsx` 的 effect）负责的，
  条件是 `updatePending && !busy && online`。也就是说刷新依赖**组件仍然挂载且 effect 真的重跑**。
  **【未验证】** 本次**没有**在真机上验证过「推迟之后是否真的刷新」，
  也没有证据说明那个 `buildId` 是「没刷新」还是「刷新了但仍是旧构建」。
- **下一步**：把它当成一个独立缺陷查 —— 至少要在导出里能看到
  「本次运行的是哪个构建」与「这个构建是什么时候被浏览器接管的」，而不是只看到一个字符串。

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
| **角标（上下标）在真实文档上仍不生效**（`769227b`，新增，见 §5.12.10） | 字符级链路已能产出字符框，但**含指数的那一行（词 1）仍然拿不到框**：剩余 **8 个词**逐条对照后**全部是真的识别差异**（不是格式）。方向已定：把对账从「长度相同 + 逐字符相同」换成**序列对齐**（容忍插入 / 删除），**而不是继续放宽阈值**；另有一步小改动是把 **Unicode 上下标字符**（U+2082 `₂` 等）并入归一化（项目里已有 `normalizeSuperSub()` 同一映射）。⚠️ **这一轮没有放松任何阈值** | 中（方向明确，实现待做） |
| **Service Worker 自动更新可能长期不生效、且用户看不出来**（新增，见 §5.12.11） | 连续两次导出拿到**同一个 `buildId`**。推迟刷新的逻辑在忙时只置 `updatePending` 就返回，真正的刷新由 `PwaPrompt.tsx` 的 effect 负责（`updatePending && !busy && online`）；若它一直不触发，用户会长期停在旧版本，而且**「修复没生效」与「你还没拿到修复」无法区分** | **中高**（**独立待查**，本次**未验证**） |
| **版面模型从未在真实扫描件上推理过**（`d6b07e6`，新增，见 §5.11.7） | 测试证明的是「接得对、**退得回**」，**不是「判得准」**（提交信息自己写明了这一点）。它参与**阅读顺序与页眉页脚**判定，判错会直接改动正文；唯一一条正面观察只是「日志显示它多滤掉一行页脚」【用户导出】，无量化证据 | 高（等于把一个未验证的组件放进了正文链路） |

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
| **`buildLayoutModelUrl()` 在「远端 base」下会拼出 404**（新增，见 §5.11.6） | 下载脚本 `fetch-ocr-models.mjs` 已把 `path`（本地）与 `remote`（远端）拆成两个字段，但**浏览器侧**的 `buildLayoutModelUrl(base)` 仍然只拼本地路径 —— `buildLayoutModelUrl(OFFICIAL_LAYOUT_MODEL_BASE)` 会得到 `.../resolve/main/layout/PP-DocLayout-S.onnx`，**与构建时踩过的那个 404 是同一个**。**默认同源不受影响**（模型已在 `public/ocr-models/layout/`），只有把 `VITE_OCR_LAYOUT_MODEL_BASE` 指向那个 HF 仓库时才踩到，而源码注释恰好把这写成受支持的用法。**没有任何测试钉住它**（`ocrModelSource.test.ts` 的 7 个用例**没有一条**涉及 layout URL，本次 grep 实测）。⚠️ **影响面未验证** |
| **版面分析的 10 个用例被执行两次**（新增） | `src/lib/ocrPostProcess.test.ts:1399` 有一行 `import '@/lib/ocrPostProcess.layout.test'`，而该文件本身也命中 vitest 的 `include` glob（`src/**/*.test.ts`）—— 于是那 10 个用例在每个测试文件上下文里**各注册一次、跑两遍**。无害，但它是「静态计数 479 与报告值 489 差 10」的原因，不知道会让人对不上数 |
| **用户可见的「约 30MB」现在偏小约 4.7MB**（新增，**本次只记录、没有改代码**） | 模型实际是 **4 个 / 34.59 MiB**（`d6b07e6` 加入版面模型 4.69 MiB 之后）。而**用户可见的两处文案**仍写「约 30MB」：`src/components/FileUploadZone.tsx:110`（「首次需下载约 30MB 模型」）与 `:295`（「首次使用需下载 AI 模型（约 30MB）」）；引擎日志 `ocrEngine.ts:313` 也仍是「检测 9.52 + 识别 20.30 + 字典 0.07 = 合计约 29.9MB」，**没算版面模型**。这正是 `c2a09b1` 刚修过的那一类口径不一致（当时是「约 10MB」→「约 30MB」），**本次未修** |

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
   初始化超时阈值是 `INIT_TIMEOUT_MS = 180_000`（180 秒），引擎的报错文案与**界面文案都会提示「首次使用需要下载模型（约 30MB）」**
   （界面那五处原先写着「约 10MB」，**`c2a09b1` 已统一改为「约 30MB」**，见 §5.10.7 末尾）
4. 顺带验证**页眉页脚过滤**在真实扫描件上的效果。**现在有两条路，必须分清是哪一条在起作用**：
   ① `3d4a2ad` 的几何启发式（上下各 5% 边距 + 字号 < 全页中位数 0.85 倍 → 丢弃）；
   ② **`d6b07e6` 新增的版面模型**（`PP-DocLayout-S`，见 §5.11）—— 控制台会打出
   `[layoutAnalysis] 版面模型就绪…` 与每页的 `[layoutAnalysis] 版面区域 N 个（其中页面家具 M 个：header×1、footer×1…）`。
   **这就是「模型到底有没有在工作、滤掉了什么」的唯一现场证据**（目前只有一条用户观察：
   「日志显示它多滤掉一行页脚」【用户导出】，没有量化数据）。怀疑它误删内容时用
   `VITE_OCR_LAYOUT=0` 关掉再跑一次对比 —— 关掉后行为与接入前**逐字节相同**（§5.11.5）
5. **把「复制识别结构」导出留下来，并记下 `buildId`**（§5.12.7）。它一次回答三个问题：
   这一版是不是你要的那一版（`buildId`）、字符级定位有没有跑成（`wordsWithChars`）、
   没跑成的词各自停在哪一步（`charBoxSkips`）。**没有它，后面每一轮都只能靠猜**（这是刚付过学费的教训）
6. 判断：整本 OCR 是否现实？若每页 >30 秒，833 页需要 7 小时，
   应改为引导用户用 `ocrmypdf` 离线处理

**验收**：能给出"成功率 X%、平均 Y 秒/页"的实测数据。
（§5.10 已经排除了「浏览器内核」这一类原因 —— **不需要再重做那六轮实验**。）

### R2 · PDF 页眉页脚过滤（**OCR 路径已实现，文字层路径仍未做**）

**已完成的部分**：`3d4a2ad` 在 `src/lib/ocrPostProcess.ts` 里加了 `filterHeaderFooter()`
（`HEADER_FOOTER_MARGIN_RATIO = 0.05`、`HEADER_FOOTER_FONT_RATIO = 0.85`），
作用于 **OCR 结果**这条路径，有单元测试。

**还没做的部分**：走**文字层**的普通 PDF（`pdfParser.ts`）没有等价过滤 ——
真实书籍每页的页眉页码仍会变成正文块，污染阅读流与朗读顺序。

> **补记（`d6b07e6`，见 §5.11）**：**OCR 路径**上现在多了一层更强的办法 ——
> **版面模型**（`PP-DocLayout-S`）直接给出 `header` / `footer` / `number` 区域，
> 不再靠「字号更小 + 宽度不到版心 85% + 有 1.4 倍字号的空隙」这几条猜。
> 但它**只作用于 OCR 路径**，而且**从未在真实扫描件上推理过**（§5.11.7）：
> 「模型在跑」与「模型判得准」是两件事，**文字层那条路径仍然完全没有过滤**。

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

### R10 · 角标（上下标）仍未解决：把对账换成**序列对齐**（**用户最初的需求**）

**现状（`769227b`）**：字符级坐标已经是**可测的几何事实**（§5.12），`wordsWithChars` 由 8 升到 15，
但**含指数的那一行（词 1）仍然拿不到字符框** —— 剩余 8 个词逐条对照后**全部是真的识别差异**，
不是格式差异。于是 §5.12.8 那条新判据**仍然没有可用的测量值**。**逐条清单见 §5.12.10。**

**下一步（方向已定，不要再放宽阈值）**：

1. 把对账（`reconcileWithWordText`）从「**长度相同 + 逐字符相同**」换成**序列对齐**
   （编辑距离 / LCS，**容忍插入与删除**）。这样词 1 能拿到字符框、`x+y−2` 的墨迹范围就能量出来；
   而**真正认错字的仍会因对齐置信度不足被拒绝** —— 错位对齐的代价必须**显式度量**，
   因为「框对到别的字上比没有框更糟」这条原则不变。
2. 把 **Unicode 上下标字符**（`⁰¹²…`、`₀₁₂…`）并入归一化 —— **复用已有的 `normalizeSuperSub()`**
   （`BlockRow.tsx`），不要另写一份映射。这一条直接解决清单里的 `n₂` → `n2`。
3. 每改一次都**留一份导出**：`wordsWithChars` 与 `charBoxSkips` 就是进度条（§5.12.7）。

**不要做**：不要为了让词 1 通过而放宽阈值；不要在对账失败时「照样挂上字符框」——
**错的坐标比没有坐标更糟**，这是这条链路一开始就定下的取舍，也是 `ocrCharBoxes.ts` 里那道闸存在的理由。

**验收**：真实扫描件的导出里，含指数的那一行出现 `^{…}`，且 `charBoxSkips` 里剩下的**全是认错字**。

### R11 · 待查缺陷：Service Worker 自动更新**到底有没有生效**（§5.12.11）

**现象**：连续两次导出拿到**同一个 `buildId`** —— 用户浏览器仍在跑旧构建。

**为什么不能忽略**：它让「修复没生效」与「你还没拿到修复」长期**无法区分**，
而这两件事的下一步动作**完全相反**（继续改代码 / 请用户刷新）。
更糟的是它在界面上**完全不可见**（横幅只在 `updatePending` 为真时出现）。

**要查什么**：

1. 真机上确认「`updatePending` 置位之后，忙完到底有没有触发 `reloadNow()`」——
   刷新依赖的是 `PwaPrompt.tsx` 的 effect（`updatePending && !busy && online`），不是 `pwa.ts` 自己
2. 确认 `buildId` 相同到底是**没刷新**，还是**刷新了但 SW 仍返回旧产物**
   （后者是 §5.6 那类「读到被缓存的旧产物」的另一种形态 —— 本项目已经栽过两次）
3. 考虑让导出带上「这个构建是什么时候被浏览器接管的」，而不是只给一个字符串

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

✅ 这个模块的自动化测试由 **`c2a09b1`** 补上：`src/lib/sessionDiagnostics.test.ts`（**11 个用例**），
钉住「无记录时 `getLastReloadReason()` 必须返回 `null`」「阶段轨迹保留多条且有上限」
「`sessionStorage` 抛异常时全部接口安全降级」。⚠️ 它跑在 **Node 环境**里（降级用例用的是 `globalThis`
而不是 `window`），**不是浏览器行为**。见 §5.10.3 与 §5.10.10。

### 「复制识别结构」导出（**用户没有控制台时第二重要的证据来源**）

`src/lib/ocrStructure.ts`（`24b0332` 引入，**今天后半程扩展**，见 §5.12.7）
把**一页识别的原始几何**整理成一份可复制的 JSON。它是**唯一**能看到
「上下标判据到底拿到了什么测量值」的出口。字段逐条解释在 §5.12.7，这里只给**排查顺序**：

| 你想知道 | 看哪个字段 | 结论 |
|---|---|---|
| 我拿到的是哪一版 | `buildId` | 两次导出**相同** ⇒ **你的浏览器还在跑旧构建**，先解决刷新再谈别的（§5.12.11） |
| 字符级这一步跑了没有 | `wordsWithChars` | `0` ⇒ **没跑成**（识别器建不起来 / 前置条件不满足）；非 0 ⇒ 跑了 |
| 跑了，为什么没判出上标 | `words[].chars` + `lines[].stats` + `thresholds` | 有字符框 ⇒ 把 `heightRatio` / `centerShift` 与 `thresholds` 放一起比，判据松紧一目了然。⚠️ **字段缺失 = 这一步没跑成**，与「框为空」是两件事 |
| 某个词为什么没有字符框 | `charBoxSkips` | 直接给出**停在哪一个出口**（尺寸不合适 / 裁剪失败 / 未解出字符 / 与词文本不一致），**并带上重新识别得到的文本** |

> ⚠️ **两条纪律**：① 导出里**没有** `chars` 字段 ≠「字符框为空」；
> ② 拿到导出后**先看 `buildId`**，再讨论任何行为 —— 否则很可能在分析一个
> **用户根本没在跑的版本**。这个坑刚踩过（§5.12.11），代价是整整两轮猜测。

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

> **补记（今天后半程）**：这条上限现在**直接决定了版面模型的选型**（§5.11.2）——
> 同仓库的 `PP-DocLayoutV2` / `V3` 是 **203.42 MiB / 123.90 MiB**（超上限 5–8 倍，**发布不上去**），
> 于是改用 **4.69 MiB** 的 `PP-DocLayout-S`（占上限 **18.8%**）。
> `verify-dist.mjs` 现在**对产物里每一个文件**复查这条上限（不只是模型），
> 并把 `layout/PP-DocLayout-S.onnx` 列入**必需模型**：缺失即**构建硬失败**，
> 因为缺了它的表现是「版面分析静默退回几何启发式」，**构建与测试都不会报错**。
> **推论**：任何「再加一个大模型」的提议，**先算字节数再谈精度** ——
> 发布不上去的精度等于零（这也是当初 V3 被否掉的唯一理由）。

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
2. **先跑一遍 `npm run build` 和 `npm test`**，确认基线是绿的（**应为 `489 passed / 30 files`**）。
   ⚠️ 这个数字的出处是 `769227b` 的提交信息与用户给定值，**不是上一次在本机跑出来的**：
   上一轮的机器（以及本次的沙箱）**都跑不了 `vitest`**（vite 在 Windows 上 `spawn EPERM`，见 §5.11.8）。
   你第一次拿到可写环境时，**把它跑出来**就是对文档的一次实打实的校正
3. **再跑通一次真实扫描件的 OCR**（R1）—— 这是最大的未知数：PaddleOCR 的**识别准确率**至今没有量化数据。
   但**不要**重做 §5.10 那六轮实验：那些假设已经被证据逐一否掉了。
   **顺带把两件新东西一起验了**：版面模型（`d6b07e6`，看控制台的 `[layoutAnalysis]` 日志，§5.11.7）
   与字符级导出（看 `buildId` / `wordsWithChars` / `charBoxSkips`，§5.12.7）
4. **读 `docs/03-踩坑与修复记录.md`** —— 22 个缺陷换来的经验都在那里
   （另加 §5.6 的 PWA 陈旧 chunk 故障、§5.9 的「扫描结果全丢」与 §5.10 的「进程消失」，四者是同一类教训：**全绿也不代表对**）。
   ⚠️ 该文件**不在仓库 `docs/` 下**（§6 已注明）；仓库里的 `docs/` 现在是 **5 份**，
   其中 **`docs/字符级OCR技术调研.md` 是今天新增的**，自带 🟢/📘/🔭/❓ 证据分级，
   §5.12 的方案就出自它 —— **接手字符级/角标这条线之前先读它**
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
   §5.10 那场六轮排查，最后就是被「Firefox、Chrome、Microsoft Edge 都可以正常使用，但是 360 不行」这一句收束的。
   **另外（今天后半程新增的纪律）**：动手改代码之前，**先让用户导出一次识别结构并报出 `buildId`** ——
   它是目前**唯一**能区分「修复没生效」与「你还没拿到修复」的东西（§5.12.7 / §5.12.11）。
   这一步如果省掉，代价就是「导出逐字节相同」却仍在改代码
9. **改完记得确认产物相关的数字**：**当前基线**是 `489 passed / 30 files`（出处与两次交叉核对见 §4.1
   与头部状态表 —— **本机跑不了 `vitest`**，见 §5.11.8）、precache **19 entries**、产物
   **88 个文件 / 40.16 MB**（含 OCR 模型 **4 个 / 34.59 MB**，其中**版面模型 4,917,852 字节**）、依赖 **26 个**；
   `src/` 是 **83 个文件 / 22,492 行**、`scripts/` 11 个 / 2,227 行（**口径**：目录下全部文件，含
   `.ts` / `.tsx` / `.css`、**不排除测试文件**，用 `[System.IO.File]::ReadAllLines(...).Count` 逐文件累加；
   本次还与 `git diff --shortstat c2a09b1 HEAD -- src` **交叉核对一致**）。这些数字散落在本文多处
   （头部状态表、§4.1、§11 本条），改动后要一起更新
