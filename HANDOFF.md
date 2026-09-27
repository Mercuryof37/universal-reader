# HANDOFF · 项目交接文档

> **本文的读者**：接手本项目的开发者或 AI 模型。假设你**没有任何上下文**。
>
> **本文的目标**：让你在读完这一份文档后，能够准确判断
> 「什么已经能用、什么还没验证过、下一步最该做什么」。
>
> **一句话定位**：一个**纯前端、零后端、本地优先**的文档阅读器。
> 用户导入 md / txt / pdf / epub，获得双语对照、语音朗读、批注能力，
> **文档全程不离开浏览器**。

| 项 | 值 |
|---|---|
| 仓库 | `Mercuryof37/universal-reader` |
| 部署 | Cloudflare Pages（静态）+ 可选 Cloudflare Worker（API 代理） |
| 代码规模 | 82 个源文件 / 约 9,800 行（不含 `package-lock.json`） |
| 测试 | 14 个文件 / **160 个用例全部通过** |
| 门禁 | `tsc -b` ✅ · `vitest run` ✅ · `npm run build` ✅（含产物校验） |
| 文档 | `README.md`（用户手册）· `docs/`（4 份专题）· 本文 |

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

### 由此推出的"不要做"

以下改动看起来是改进，实则会破坏项目定位，**请先与维护者确认**：

| 不要做 | 原因 |
|---|---|
| 引入 Next.js / Nuxt / Remix | 它们解决服务端渲染与服务端数据获取，本项目没有服务端 |
| 加云同步 / 用户账号 | 一旦有服务端存文档，C3 的核心卖点消失。若要做，必须端到端加密 |
| 把 API 密钥放进前端 | 等同于公开。前端代码、产物、localStorage 对用户完全可见 |
| 引入 CJK 字体子集化 | 当前用系统字体栈，中文显示成本为零。子集化要引入几 MB 字体与构建步骤，且易产生"生僻字变豆腐块"。**投入产出比为负** |
| 把 PDF 解析移回 Web Worker | 见 §6 缺陷 1 —— 已尝试三次失败，当前方案是唯一可用的 |

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
| `unified` / `remark-parse` / `remark-gfm` / `unist-util-visit` | 11.0.5 / 11.0.0 / 4.0.1 / 5.1.0 | Markdown 解析 | 导入 md/txt |
| `pdfjs-dist` | 5.7.284 | PDF 解析（**含 WASM 解码器**） | 仅导入 PDF |
| `epubjs` | 0.3.93 | EPUB 解析 | 仅导入 EPUB |
| `tesseract.js` | 7.0.0 | 浏览器端 OCR | 仅执行 OCR |
| `pdf-lib` | 1.17.1 | 将 OCR 结果写回 PDF | **未接线，见 §4.3** |
| `jszip` | 3.10.2 | ZIP 解包 | **实际未使用** |

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
npm run build        # 完整构建（含 WASM 复制 + 图标生成 + 产物校验）
npm test             # 160 个单元测试
npm run typecheck    # 三个 TS project：app / node / worker
```

### ⚠️ 必须用 `npm run build`，不能用 `npx vite build`

`package.json` 挂了三个钩子，直接调 `vite build` 会全部跳过：

| 钩子 | 脚本 | 作用 |
|---|---|---|
| `predev` / `prebuild` | `copy-pdfjs-wasm.mjs` + `make-icons.mjs` | 复制 WASM 解码器；生成 PWA 图标 |
| `postbuild` | `verify-dist.mjs` | 校验产物 |

**跳过 `copy-pdfjs-wasm` 的后果是：扫描版 PDF 全部渲染成白页，且不报任何错。**
（见 §6 缺陷 11 —— 这个坑排查了很多轮。）

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

### 4.2 已实现但**从未在真机上跑通**

| 功能 | 状态 | 风险 |
|---|---|---|
| **扫描版 PDF 的 OCR** | 代码完整，最后一次修复后**未再验证** | **最高**。见下方说明 |
| 云端翻译（DeepL / OpenAI） | Worker 已部署，前端已配端点 | 中。未做端到端验证 |
| 云端 TTS（Azure） | 代码完整 | 中。未验证 |
| PWA 离线实际效果 | 产物正确，**未在浏览器里断网验证** | 中 |
| 「安装到桌面」 | manifest 正确 | 低 |

> **OCR 的特别说明**：这条链路在真机上失败过 4 次，
> 每次修完都以为好了，结果又出现新的 API 缺失或数据结构不匹配。
> 最后一次修复（`data.blocks` 嵌套结构 + 纯文本兜底 + 多档降采样）
> **通过了全部单元测试，但没有真机验证过**。
>
> 如果你要接手，**第一件事应该是跑通一次真实扫描件的 OCR**，
> 而不是加新功能。

### 4.3 已知的未接线代码（技术债）

| 位置 | 问题 | 建议 |
|---|---|---|
| `src/lib/pdfTextLayer.ts` | 定义了 `addTextLayerToPdf`，**无任何调用方**。功能是把 OCR 结果写回 PDF 文字层供外部阅读器使用 | 要么接线，要么删除。**当前是死代码** |
| `jszip` 依赖 | `package.json` 声明了，`epubParser.ts` 引用了，但实际解析走 `epubjs` | 确认后移除依赖 |
| 旧的 `pdfWorker.ts` | 已删除，但 `docs/03` 里仍有它的历史记录 | 保留（是历史，不是错误） |

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
| `settingsStore` | localStorage | 主题、字号、语言、朗读参数 |
| `libraryStore` | 无（每次从 IndexedDB 重建） | 文档列表、当前文档、导入状态 |
| `annotationsStore` | 无（同上） | 当前文档的批注 |

**铁律**：设置类存 localStorage，数据类存 IndexedDB。
混用会导致"改一次字号写一次数据库"。

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

---

## 6. 十三类真实缺陷（已修复，但要知道它们为什么发生）

完整版见 `docs/03-踩坑与修复记录.md`。这里给**接手者最需要的浓缩版**。

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
| 10 | tesseract v7 输出结构变了 | 不信任"运行时确实存在"这类注释。**第三方库的输出结构会在小版本间悄然改变** |
| 11 | pdf.js 需要显式 `wasmUrl` | 缺解码器 → 不绘制 → 画布空白 → 被"空白页跳过"吞掉。**多层合理降级叠加会让故障完全不可见** |
| 12 | 把"能用的结果"当成"没有结果" | 识别出 7058 字却报"什么都没识别到"，只因拿不到词级坐标 |
| 13 | 断言了只在开发者机器上成立的状态 | **本地全绿、CI 必红**。验证环境与真实环境的差异恰好落在被验证的那一点 |

### 这十三条的元教训

> **"我验证过了"这句话本身可能是错的。**

宣布修好之前，先问三个问题：

1. 我验证时用的**环境**，和出问题的环境是同一个吗？
2. 我用的**命令**，和 CI / 部署时用的是同一条路径吗？
3. 我的**断言**，在别人的干净检出上也成立吗？

**本项目出过的最严重问题，源码、类型检查、单元测试全都是绿的。**

---

## 7. 已知缺陷与限制（按严重度排序）

### P0 · 影响真实阅读质量

| 问题 | 影响 | 难度 |
|---|---|---|
| **PDF 页眉页脚未过滤** | 每页的页眉与页码变成正文块。一本 300 页的书会产生近千个碎片 | 低 |
| **PDF 双栏排版串行** | 教材、论文的左右栏被读成一行，正文顺序完全错乱 | 中 |
| **OCR 未经真机验证** | 功能可能不可用（见 §4.2） | 未知 |

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
| 无 OCR 结果写回 PDF | `pdfTextLayer.ts` 未接线 |
| 无 PWA 更新日志 | 用户不知道更新了什么 |

---

## 8. 路线图（建议执行顺序）

### R1 · 跑通并验证 OCR（**最优先**）

**为什么最优先**：这是唯一「代码写完了但从没验证过」的核心功能。
在它验证之前，任何新功能都建立在不确定的地基上。

**做什么**：
1. 用一份真实扫描版 PDF，在浏览器里执行「前 10 页」OCR
2. 记录：成功率、失败页号、每页耗时
3. 若失败，看控制台的 `[ocrEngine]` 与 `[ocrParsePdf]` 诊断输出
4. 判断：整本 OCR 是否现实？若每页 >30 秒，833 页需要 7 小时，
   应改为引导用户用 `ocrmypdf` 离线处理

**验收**：能给出"成功率 X%、平均 Y 秒/页"的实测数据。

### R2 · PDF 页眉页脚过滤

**为什么优先**：真实书籍**每一页**都有页眉页码，直接污染阅读流与朗读顺序。

**思路**：
1. 统计全文"出现在页面顶端/底端固定 y 区间"且"跨页高度重复"的文本
2. 命中的行不进正文，记录到 `metadata` 供回跳
3. 用 `scripts/inspect-pdf.mjs` 已有的"疑似页眉/页脚碎片"指标验证

**前置**：需要 2~3 份真实书籍 PDF 量化页眉占比。

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

- 决定 `pdfTextLayer.ts` 是接线还是删除
- 移除未使用的 `jszip`
- 为 `db.ts` / `useVirtualWindow.ts` 补单元测试（当前无覆盖）

### R7 · 其他

`Markdown 表格渲染` · `书签功能` · `PWA 更新日志` · `E2E 测试（Playwright）`

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
| 前端 | Cloudflare Pages，Build command **`npm run build`**，输出 `dist` |
| API 代理 | Cloudflare Worker（`worker/api-proxy.ts`），可选 |
| Node 版本 | 由 `.node-version` 固定为 22（Pages v3 构建系统**不读** `engines` 字段） |
| 环境变量 | 见 `docs/05-部署与分享指南.md` |

### ⚠️ 安全：`ALLOWED_ORIGIN` 必须配置

Worker 里放着付费 API 密钥。CORS 现在是 **fail-closed**：

| `ALLOWED_ORIGIN` | 行为 |
|---|---|
| 未配置 | 不返回 CORS 头 → 浏览器拒绝跨域（云端功能静默失效） |
| 已配置且匹配 | 放行 |
| 已配置不匹配 | 拒绝 |

**改完必须 `npx wrangler deploy` 才生效**，否则仍是旧代码。

---

## 11. 给接手者的建议

1. **先跑一遍 `npm run build` 和 `npm test`**，确认基线是绿的
2. **再跑通一次真实扫描件的 OCR**（R1）—— 这是最大的未知数
3. **读 `docs/03-踩坑与修复记录.md`** —— 13 个缺陷换来的经验都在那里
4. **改动前先看 §1 的"不要做"** —— 有些看似合理的设计会破坏项目定位
5. **改产物相关的东西时，先看 `verify-dist.mjs` 检查了什么** ——
   这个项目最贵的几个缺陷都是"源码正确但产物错误"
