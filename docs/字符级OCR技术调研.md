# 字符级 OCR 技术调研

> 调研对象：`universal-reader`（纯前端、零后端静态站点，浏览器端 PaddleOCR + ONNX Runtime Web）
> 调研问题：**能不能拿到「单个字符」的识别结果——字符级包围盒——用来替掉现在这套几何启发式？**
>
> **本文的证据纪律**：每条结论都标注来源等级。
> - 🟢 **本机实测** = 本次在本机用命令量到的字节数、或本机已安装包（`node_modules`）里的源码与 `.d.ts` 原文
> - 📘 **官方注册表 / 官方文档** = npm registry、jsDelivr 文件清单、MSYS2 包页、上游官方文档的原文
> - 🔭 **推测** = 由上述两类证据推断，**未直接验证**
> - ❓ **未验证** = 本次没有验证
>
> 调研环境（🟢 实测）：Windows、Node `v25.2.1`、仓库 `universal-reader`。
> **⚠️ 本次全程只做了「读」**：`universal-reader\` 子树在本会话里是**只读**的（写入被沙箱拒绝），
> 因此**没有装任何包、没有改任何代码、没有跑任何 OCR 基准**。详见 §9。

---

## 0. 结论速览

| 路径 | 字符级框 | 体积成本 | 隐私 | 工作量 | 风险 | 结论 |
|---|---|---|---|---|---|---|
| **A · 自接 CTC 字符位置**<br>（复用现有模型） | ✅ 字符级（可反推词级） | **+0 MB**（模型与依赖都不变） | 本机，零外发 | ~150 行 TS | CTC 峰值对齐在中文上的精度 ❓未验证 | **首选**。证据是「库内部已经在算，只是没暴露」 |
| **B · tesseract.js + `hocr_char_boxes`** | ✅ 字符级（`ocrx_cinfo`） | **+5.2 MB**（core 2.87 + `chi_sim` 2.35），对比现状 29.8 MB **小 5.7×** | 本机（`langPath` 自托管 → 零第三方请求） | 中（新增一条引擎支路） | 中文识别质量弱于 PP-OCRv6 → **只做懒加载的第二意见，不替换** | **次选**。唯一「开箱即用」的字符框 |
| **C · Scribe.js（ScribeOCR）** | ✅ `OcrWord.chars: Array<OcrChar> \| null` | core 4.09 MB（npm 包解包 46 MB，另含 10.5 MB CJK 字体） | 本机 | 中 | ⚠️ **AGPL-3.0** | **先做许可决策，再谈技术** |
| **D · 云 OCR 与视觉大模型** | 一般有 | 按次计费 | ❌ **必须上传** | — | — | **违反本项目两条硬约束，不建议** |

**一句话建议**：**先走 A**（零新依赖、零新模型、零新增下载）；真要「开箱字符框」时再按需懒加载 B；C 的技术最完整但许可证是**法律问题**；D 直接排除。

---

## 1. 现状：本机实测的资产与能力边界

### 1.1 资产实测表 🟢 本机实测

> 量法：对 `public/ocr-models/` 与 `node_modules/<pkg>/dist/` 逐个文件累计字节数。
> **这些数字是量出来的，不是查文档抄的。**

| 资产 | 实测大小 | 位置 | 备注 |
|---|---|---|---|
| `PP-OCRv6_small_det.ort`（检测） | **9.52 MB** | `public/ocr-models/` | 随站点同源发布 |
| `PP-OCRv6_small_rec.ort`（识别） | **20.30 MB** | 同上 | **离 Cloudflare Pages 25 MiB 单文件上限只剩约 4.7 MB 余量** |
| `ppocrv6_dict.txt`（字典） | **0.07 MB** | 同上 | |
| 小计（模型三件） | **29.82 MB** | | `ocrEngine.ts` 启动日志写的是「合计约 29.9MB」 |
| `ort-wasm-simd-threaded.jsep.wasm` | **27.00 MB** | `node_modules/onnxruntime-web/dist/` | **运行时真正下载的就是它**，见 §6.6 |
| `ort-wasm-simd-threaded.wasm` | **13.58 MB** | 同上 | **当前没有被使用**，见 §6.6 |
| `ort-wasm-simd-threaded.jspi.wasm` | 15.98 MB | 同上 | 未使用 |
| `ort-wasm-simd-threaded.asyncify.wasm` | 25.54 MB | 同上 | 未使用 |
| `opencv.js`（`@techstark/opencv-js`） | **12.68 MB** | `node_modules/@techstark/opencv-js/dist/` | **⚠️ 运行时并没有加载它**，见 §1.2 |

### 1.2 ⚠️ 必须先纠正的一个口径：那 12.68 MB 的 `opencv.js` **没有在运行时加载**

`src/lib/ocrEngine.ts` 第 285–296 行构造服务时写的是：

```ts
const service = new PaddleOcrService({
  model,
  processing: { engine: 'canvas-native' },   // ← 第 287 行
  session: { executionProviders, onSessionFallback: … },
});
```

而 `ppu-paddle-ocr` 的 `interface.d.ts` 对这个选项的定义是（📘 原文）：

> - `"opencv"` - Uses OpenCV.js (`ImageProcessor` / `Contours` from `ppu-ocv`). More accurate region detection; recommended for production use. **(default)**
> - `"canvas-native"` - Uses pure HTML Canvas operations (`CanvasProcessor` from `ppu-ocv/canvas`). **No OpenCV dependency**; suitable for lightweight or browser-extension environments.

🟢 **本机实测（构建产物）**：`dist/` 里**没有任何 opencv 文件** ——
`Get-ChildItem dist -Recurse | Where-Object Name -match 'opencv'` 零命中；
`dist/` 里最大的两个文件就是那两个 `.ort` 模型（20.30 / 9.52 MB）。

**结论（这是一个已获得的收益，不是待办）**：

| 口径 | 数字 | 状态 |
|---|---|---|
| 「56 MB」这类把 `opencv.js` 算进去的汇总 | ≈ 56 MB | ❌ **是过度计数**，已被构建产物否掉 |
| 实际浏览器侧下载量 | **模型 29.82 MB + 运行时 WASM 27.00 MB ≈ 56.8 MB** | ⚠️ 数值接近，但**构成不同**：里面没有 `opencv.js` |
| 若继续沿用 `opencv` 引擎会多付 | +12.68 MB 资产 + OpenCV 堆内存 | **本项目已经避开了**（`engine: 'canvas-native'` 已在用） |

> **纪律提醒**：把 `node_modules` 里存在的包体当成「运行时成本」是错的 ——
> 这类误判只能靠**看构建产物**（`dist/`）而不是看 `node_modules/` 来避免。

### 1.3 现有链路只到**词级**

`src/lib/ocrTypes.ts` 的 `OcrWord` 只有 `{ text, confidence, bbox, fontSize }`；
`ppu-paddle-ocr` 的公开结果类型（📘 `core/base-recognition.service.d.ts` 原文）是：

```ts
export type RecognitionResult = {
  text: string;        // 识别文本
  box: Box;            // 文本区域在原图坐标下的包围盒
  confidence: number;  // 0-1
};
```

**没有字符级字段。** 这正是过去几轮只能靠几何启发式（合并逻辑 → 行结构 → 段落切分 → 页眉页脚过滤 → 标题判定 → 过度合并）打边界情况的根因。

---

## 2. 路径 A · 自接 CTC 字符位置（零新依赖、零新模型）

### 2.1 依据：位置信息**已经在算了，只是没暴露** 🟢 本机实测（读 `node_modules/ppu-paddle-ocr@6.6.0`）

`core/recognition/ctc.d.ts` 原文（逐字摘录）：

```ts
/**
 * `positions` holds, per emitted character, the fraction (0..1) of the input
 * width where its timestep fired; CTC peaks near the glyph's center, so this
 * locates each character in the crop for position-based text splitting.
 */
/** Text decoded from a recognition tensor, with its per-character offsets. */
export type DecodedText = {
    text: string;
    confidence: number;
    positions: number[];
};
export declare function ctcGreedyDecode(
  logits: Float32Array,
  sequenceLength: number,
  numClasses: number,
  charDict: string[],
  spaceRecovery?: boolean,
): DecodedText;
```

也就是说：**每个输出字符对应的「时间步 → 图宽比例」已经在 CTC 贪心解码里算好了**，还配套三个保持「字符 ↔ 位置」索引对齐的工具：

| 函数 | 作用 |
|---|---|
| `injectGapSpaces(chars, positions)` | 在超宽空隙处插入空格（位置取空隙中点，保持索引对齐） |
| `refineDecodedChars(chars, positions)` | 折叠连续空格、按需把全角映射为半角（**只在全文无 CJK 时**） |
| `splitTextByPositions(text, positions, segmentWidths)` | 把整行文本按字符位置切回各个拼接段 |

**但它是内部模块**（同一文件也证实了这一点）：

| 事实 | 证据 |
|---|---|
| `positions` 只出现在 `ctc.d.ts` / `batched.d.ts` / `line-grouping.d.ts` 这些**内部**声明里 | 🟢 全包 grep `positions` 只命中这几处 |
| 公开的 `RecognitionResult` **不含** `positions` | 🟢 `core/base-recognition.service.d.ts` |
| `package.json` 的 `exports` **没有深路径通配** | 🟢 只有 `"."` / `"./web"` / `"./mobile"` / `"./coi-serviceworker.js"` |
| 库自身用它做什么 | 🟢 `line-grouping.d.ts`：`mergeLineCrop()` 把同一行的多个框拼成一张图识别，再用 `splitTextByPositions()` 按字符位置把文本切回各自的框 |

> 许可：`ppu-paddle-ocr` 是 **MIT**（🟢 本机 `package.json`）。因此**向上游提 PR**（把 `positions` 暴露到 `RecognitionResult`）比 fork 更可持续 —— 见 §6.5。

### 2.2 落地步骤

| 步 | 动作 | 用到的现有能力 |
|---|---|---|
| 1 | `service.detect(canvas, { crop: true })` → `{ boxes, crops }` | 🟢 公开 API（`core/base-paddle-ocr.service.d.ts` 第 77 行），**无需自建检测逻辑** |
| 2 | 用 `ort.InferenceSession.create()` 自建**识别** session，加载**已在同源托管的** `PP-OCRv6_small_rec.ort` | 🟢 `onnxruntime-web@1.30.0` 已是直接依赖；模型已自托管 |
| 3 | 对每张 crop 跑识别，**CTC 贪心解码时保留时间步**（不要只返回字符串） | 🔭 需自己实现（约 60 行）或向上游提 PR 后直接用 |
| 4 | 时间步 → 横向位置：`charX = box.x0 + (timestep / T) × (box.x1 − box.x0)` | 🔭 由 `positions` 的定义直接推出 |
| 5 | 合并相邻同类字符 → 既得字符框，也能顺手生成**更准的词框** | 🔭 |

**⚠️ 必须诚实写明的一点（用户特别要求）**：
**CTC 的 `positions` 只有横向，没有纵向。**
每个字符的真实上下沿（尤其上下标、分数、根号）**必须另外取得** ——
可行做法是**逐列墨迹分析**（在字符 x 区间内扫描该列的暗像素纵向范围），
而这一能力**已经在依赖树里**：`ppu-ocv` 有 `deskew.js` / `deskew-angles.js` / `contours.js` / `image-analysis.js`
（🟢 本机文件清单），且 `ppu-paddle-ocr` 的 README 就推荐用它做预处理。
**纵向范围这一环没有现成 API，是要自己写的部分。**

### 2.3 成本、风险、验收

| 项 | 内容 |
|---|---|
| **依赖** | 无新增（`ppu-paddle-ocr` / `onnxruntime-web` / `ppu-ocv` 都已在树里） |
| **体积成本** | **0 新增下载、0 新增模型** |
| **风险 1** | 🔭 深路径未导出 → 要么自建 rec session，要么向上游提 PR（MIT，成本低） |
| **风险 2** | ❓ **CTC 峰值对齐在中文（等宽汉字）与中英混排下的精度未实测** —— 拉丁比例字体里字符宽度差异大，位置误差可能明显 |
| **风险 3** | ❓ 逐列墨迹分析在低对比度 / 有噪点 / 有印章的扫描件上可能失效（阈值本身就是新的启发式） |
| **验收方式** | 用现有 `ocr-structure` 导出做前后对照：判据是**词框 `yRange` 不再跨行**（上一轮实测过一个跨度 **184px** 的焊死行），以及上下标能被**几何**判定而不是阈值猜测 |

---

## 3. 路径 B · tesseract.js + `hocr_char_boxes`（唯一「开箱字符框」）

### 3.1 数字 📘 官方注册表 / 官方文件清单

| 项 | 数字 | 出处 |
|---|---|---|
| `tesseract.js` | **7.0.0**，Apache-2.0，解包 1.41 MB（纯 JS） | [npm registry](https://registry.npmjs.org/tesseract.js/latest) |
| `tesseract.js-core` 的 **SIMD + LSTM** wasm | **2.87 MB**（`tesseract-core-simd-lstm.wasm`） | [jsDelivr 文件清单](https://data.jsdelivr.com/v1/package/npm/tesseract.js-core@6.1.2/flat)（逐个文件大小，非估算） |
| 其它 wasm 变体（供对照） | `tesseract-core-simd.wasm` 3.47 MB · `tesseract-core-lstm.wasm` 2.87 MB | 同上 |
| `chi_sim.traineddata`（tessdata_**fast**） | **2.35 MB** 安装后（包体 1.62 MB） | [MSYS2 包页](https://packages.msys2.org/packages/mingw-w64-ucrt-x86_64-tesseract-data-chi_sim?repo=ucrt64)（基于官方 `tessdata_fast`） |
| **合计** | **≈ 5.2 MB** | 对比现状模型 **29.82 MB** → **小 5.7×** |

### 3.2 用法

```ts
// 1) 自托管语言包 → 零第三方请求（满足「不上传、可离线」）
const worker = await createWorker('chi_sim', 1, { langPath: '/tessdata', gzip: true });

// 2) 打开字符级框（Tesseract 变量，输出的 hOCR 里是 <span class='ocrx_cinfo'>）
await worker.setParameters({ hocr_char_boxes: '1' });

// 3) output 里要 hocr
const { data } = await worker.recognize(image, {}, { hocr: true });
```

依据（三处独立）：

| 事实 | 出处 |
|---|---|
| `recognize(image, options, output)` 的 `output` 支持 **`hocr` / `tsv` / `blocks`** | 📘 [tesseract.js 官方 `docs/api.md`](https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/docs/api.md) |
| `setParameters` 走 Tesseract 的 `SetVariable()`，且官方明说「**all parameters supported by the underlying version of Tesseract should also be supported**」 | 同上 |
| 该变量的官方描述是「**Add per-character bounding-box coordinates to hOCR output as `ocrx_cinfo`**」 | 📘 tesseract 官方 man page（`doc/tesseract.1.asc`） |
| 社区同题答案同样是「把 `hocr_char_boxes` 设成 1」 | 📘 [StackOverflow](https://stackoverflow.com/posts/57766860/revisions) |
| `langPath` 支持自托管 traineddata（`null` 时才走 jsDelivr） | 📘 tesseract.js api.md |

### 3.3 定位建议：**懒加载的第二意见，不是替换**

| 判断 | 理由 |
|---|---|
| **不替换** | 中文（尤其扫描件、公式、上下标）识别质量普遍弱于 PP-OCRv6。本项目 `docs/Windows自带OCR可行性调研.md` 里对系统 OCR（Tesseract 3 时代引擎）的实测就是：中文正文可用，**公式那一栏全错**（`x^2` → `xA2`、`-` → 汉字「一」、整行丢失） |
| **做补充** | 用户点某个词要看**逐字框**、或需要一次独立复核时**才加载**这 5.2 MB —— 平时内存零成本 |
| **代价** | 多一条引擎支路要维护（两套坐标口径、两套置信度口径） |

### 3.4 风险

- ❓ `hocr_char_boxes` 在 tesseract.js v7 里的**端到端输出未实测**（本次只做到文档级核实）。
- ❓ tesseract.js 在**真实扫描件**（倾斜/噪点/印章）上的中文识别率未实测。
- 🔭 字符框是行内相对坐标，仍要按行框做一次映射，才能与现有 `OcrWord` 坐标空间对齐。

---

## 4. 路径 C · Scribe.js（ScribeOCR）—— 技术上最完整，许可证是拦路虎

### 4.1 唯一把「字符级数据」写进公开类型的浏览器 OCR 库

📘 [官方 API 文档](https://cdn.jsdelivr.net/npm/scribe.js-ocr@0.12.6/docs/API.md)原文：

```
OcrWord  { text, conf, bbox, style, chars, ... }

| `chars` | `Array<OcrChar> | null` | Character-level data when available. |
```

- 作者 `balearica` **同时是 tesseract.js 的现任维护者**（📘 npm registry `maintainers`），是 [naptha/tesseract.js](https://github.com/naptha/tesseract.js) 的 fork 分支 [scribeocr/tesseract.js](https://github.com/scribeocr/tesseract.js)
- 支持 `scribe.opt.langPath` 自托管 traineddata、`workerN` 控制 worker 数（内存）、`usePdfSharedBuffer` 共享 PDF
- 自带 tesseract core：`/tess/core/tesseract-core-simd.wasm` **4.09 MB**（📘 jsDelivr 文件清单）

### 4.2 ⚠️ AGPL-3.0 —— 这是**法律问题，不是技术问题**

| 事实 | 证据 |
|---|---|
| `scribe.js-ocr` 许可证 = **`AGPL-3.0`** | 📘 [npm registry](https://registry.npmjs.org/scribe.js-ocr/latest) 的 `license` 字段 |
| npm 包解包 **46 MB**（404 个文件） | 同上（`unpackedSize`） |
| 另含 `fonts/NotoSansSC-Regular.ttf` **10.5 MB**（PDF 导出用 CJK 字体） | 📘 jsDelivr 文件清单 |

**为什么这是决策而不是实现细节**：AGPL-3.0 是**强 copyleft + 网络条款**——
只要把 AGPL 代码作为**网络服务**提供给用户，就触发了「向使用者提供对应源码」的义务，
而本项目的形态正是「**公开部署的 PWA**」（线上 `universal-reader.pages.dev`）。
因此**在任何代码改动之前**，必须先回答：

| 待决策问题 | 说明 |
|---|---|
| 本项目愿不愿意整体改用 AGPL-3.0？ | 会改变 `manifest.description` 的口径与分发条件 |
| 或者只把它当**开发期工具**（不进产物、不对用户提供）？ | 可行，但那就拿不到「浏览器里的字符级」这项收益 |
| 或者放弃 C，只走 A/B？ | A 零成本、B 5.2 MB 且 Apache-2.0，**都无许可证负担** |

> ❓ 未核实：`chars` 在**哪种识别模式下**才会被填充（文档只写 "when available"）。

---

## 5. 路径 D · 云 OCR 与视觉大模型 —— **违反本项目两条硬约束，不建议**

| 候选 | 为什么不做 |
|---|---|
| 云 OCR API（百度/腾讯/阿里等） | **必须上传**文档像素；且按次计费（本项目定位是「隐私 + 零成本」，README 与 `01-配置总览.md` 都以此为前提） |
| 视觉大模型（Qwen2-VL、GOT-OCR2.0、dots.ocr、PaddleOCR-VL 等） | ① 体积/算力远超浏览器能力（GB 级）；② 多数只能走服务端 → **要上传**；③ 用 API 就要钱。**「超过正常时段的花费就算贵」这类模型一律排除** |
| 本项目已有的 SimpleTex 公式云识别 | **不新增**。它已是**默认关闭的 opt-in 开关**（见 `04` §1.4 / `03` 缺陷 17），且只送**页面局部像素**；本次调研**不建议扩大**这条外发路径 |

---

## 6. 省内存 / 省流量的补强项（不改识别器）

### 6.1 总表

| 项 | 收益 | 状态 |
|---|---|---|
| `processing.engine: 'canvas-native'` | 不加载 `opencv.js`（−12.68 MB 资产 + OpenCV 堆） | ✅ **已获得**（`ocrEngine.ts` 第 287 行已在用，§1.2） |
| 识别模型 **INT8 量化** | x86-64 VNNI 与 **WebAssembly** 上**提速 20–50%**，官方标称精度不变 | ⏳ 待办（未见代码中使用） |
| **`onnxruntime-web/wasm` 入口** | 运行时 WASM 从 **27.00 MB → 13.58 MB**（−13.4 MB） | ⏳ 待办（详见 §6.6） |
| `V6_TINY_MODEL` | 模型 29.82 MB → **约 6 MB**，快 3–4× | ❌ **教材场景不建议**：字典只有 **~6.9k 字**（`ppocrv6_tiny_dict.txt` 实测 **27,157 字节**，全量字典 `ppocrv6_dict.txt` 是 **74,948 字节**），会掉常用字外的字 |
| `recognition.strategy: 'cross-line'` | 密排正文吞吐更高 | ⏳ 可选（当前未设置 → 用库默认 `per-line`） |
| `ppu-ocv` 的 `DeskewService` 预处理 | 倾斜超过几度时所有模型档位都明显掉点 | ⏳ 可选（依赖已在树里，零新增） |
| 同源模型仓库里的 `correction/PP-LCNet_x1_0_textline_ori.onnx`（行方向分类） | 竖排/倒置行方向判定 | ⏳ 可选（见 R14） |

### 6.2 `canvas-native` —— 已在用，**不是待办**

见 §1.2。这里只补一句：它同时解释了为什么「`node_modules/@techstark/opencv-js` 有 12.68 MB」这件事**不影响线上体积**。

### 6.3 INT8 量化

📘 `ppu-paddle-ocr` README §INT8 Quantization 原文要点：

- 「The recognition model's transformer MatMul operations can be dynamically quantized to INT8 with **no accuracy loss**（measured **99.22% → 99.22%**）and a **20-50% speedup** on x86-64 CPUs with VNNI and **WebAssembly**」
- ⚠️ 同一节也写明：**Apple Silicon（M 系列）上 INT8 并不会更快**，应保持 FP32
- 现成产物：模型仓库里已有 `*_int8.onnx` / `*_int8.ort`（例如 `recognition/multi/en/v5/en_PP-OCRv5_mobile_rec_infer_int8.ort`）
- ❓ 未核实：**中文版 PP-OCRv6 small rec 的 INT8 产物是否已发布**（GitHub API 对该仓库只返回 132–134 字节的 Git LFS 指针，读不到真实体积与文件全集）

### 6.4 模型档位与体积（📘 包内 README 原文）

| 档位 | 语言/字典 | 下载体积 | 速度 | 适用 |
|---|---|---|---|---|
| `V6_TINY_MODEL`（库默认） | 多语言，**~6.9k 字字典** | **~6 MB** | 3–4× 快 | 截图、UI、低延迟 |
| `V6_SMALL_MODEL`（**本项目在用**） | 50+ 语言，**全字典** | **~30 MB** | 基线 | 密排页面、生僻 CJK |
| `V6_MEDIUM_MODEL` | 50+ 语言，全字典 | ~139 MB | ~3× 慢 | 照片、低对比度 |
| `V5_*` 单语言族 | 单语言 | ~12 MB | 相当 | 语言已知且单一 |

### 6.5 上游 PR：把 `positions` 暴露出来（MIT，成本低）🟢

库内部**已经在算** `positions`（§2.1），只是没放进公开的 `RecognitionResult`。
MIT 许可下提一个 PR（加一个可选字段）比自己 fork 更可持续；
`line-grouping.d.ts` 的 `splitTextByPositions()` 已经证明了「字符位置 ↔ 各段框」的映射是库自己认可的用法。

### 6.6 ⚠️ 一个**已定位但未验证**的浪费：运行时下载了 27 MB 的 WASM，而 13.58 MB 那个就够

这是本次调研里最"可执行"的发现之一，逐条给证据：

| 步 | 事实 | 证据等级 |
|---|---|---|
| 1 | `dist/` 里**没有** ONNX WASM；构建后被 `scripts/clean-onnx-wasm.mjs` 删除，运行时从 jsDelivr CDN 取（`ort.env.wasm.wasmPaths`） | 🟢 本机：`dist/` 无 any `ort-wasm*` 文件；脚本原文写「These files are ~28MB each and exceed Cloudflare Pages' 25MB file limit」 |
| 2 | 被删掉的那个文件名是 `ort-wasm-simd-threaded.**jsep**.wasm` = **27.00 MB** | 🟢 本机：`04` §1.5 记录的实际构建日志；文件大小本机实测 |
| 3 | 为什么是 **jsep** 而不是普通的 `simd-threaded`：因为 `import * as ort from 'onnxruntime-web'`（裸标识符）在 `onnxruntime-web@1.30.0` 的 `exports` 里落到 `"." → import → default: ./dist/ort.bundle.min.mjs`（**全 EP 包**），它对应的 wasm 就是 jsep | 🟢 本机：`onnxruntime-web/package.json` 的 `exports` 原文 + 三处 import 原文（`src/lib/ocrEngine.ts:10`、`ppu-paddle-ocr/web/paddle-ocr.service.web.js:1`、`…/platform.web.js`） |
| 4 | 该包**确实提供**只含 wasm EP 的入口：`"./wasm" → ./dist/ort.wasm.bundle.min.mjs`，对应 `ort-wasm-simd-threaded.wasm` = **13.58 MB** | 🟢 同上（`exports` 有 `./wasm`、`./webgl`、`./webgpu`、`./all`、`./jspi`） |

**可行动作**：用 Vite `resolve.alias` 把裸标识符 `onnxruntime-web` 指到 `onnxruntime-web/wasm`，
即可让三处 import **一并**落到 wasm-only 包 → 运行时下载 **−13.4 MB**（≈ 减半）。

**⚠️ 前置条件与风险（必须一起看）**：

| 项 | 说明 |
|---|---|
| 只在本项目**坚持 `executionProviders: ['wasm']`** 时成立 | `src/lib/ocrExecutionProvider.ts` 当前默认返回 `['wasm']`；但 `VITE_OCR_USE_WEBGPU=1` 时会返回 `['webgpu','wasm']`，而 wasm-only 包里**没有 WebGPU EP** → 开那个开关就会失效 |
| 🔭 未实测 | alias 会同时改写 `ppu-paddle-ocr` 内部的裸 import（Vite 对裸标识符的标准行为），但**没有在本机验证过**它不会破坏库的会话创建 |
| 与 `04`/`03` 既有结论一致 | 「不用 WebGPU」本来就是已决策（缺陷 22：WebGPU 会加载 27 MB 的 jsep 且实测出现页面被回收）—— 这条改动是**把这个决策落到实处**，而不只是写在配置里 |

> 这一条**不是**字符级方案的一部分，但它是本次读源码顺带定位到的、**收益最大的单点改动**（−13.4 MB 网络流量），因此记在这里。

---

## 7. 明确不建议清单

| 不建议 | 原因 |
|---|---|
| 云 OCR API | **必须上传** + 按次计费 → 违反两条硬约束（§5） |
| 视觉大模型（Qwen2-VL / GOT-OCR2.0 / dots.ocr / PaddleOCR-VL…） | 体积与算力远超浏览器；多需服务端 → 要上传；贵（§5） |
| `rapidocr_web` | 是 **Python 本地 Web 服务**（`pip install rapidocr_web`，浏览器打开 `http://localhost:9003`），**不是浏览器方案**。它的定位与本项目已有的「桌面端离线预处理工具」同类，若要做也只能做成外部工具 |
| `paddleocr-browser`（npm） | 📘 解包 **65.9 MB**（模型塞进包里），且结果仍是**词级**（`OcrLine = { text, box, confidence }`） |
| `@ocr-web/core`（MIT，实现质量高） | 📘 公开类型 `OcrLine = { text, box: [4 点], confidence }`，**没有字符框**。可作「纯 JS 几何、不依赖 opencv」的实现参考 |
| `ffocr`（MIT） | 太新（2026-03 建仓，3 star / 1 fork），不适合做生产依赖；可读其 WebGPU/WASM 选择逻辑 |
| `ocrad.js` | 纯 JS 字符级，但 **CJK 基本不可用**，且 **GPL** |
| 在浏览器里调 Windows 自带 OCR | `docs/Windows自带OCR可行性调研.md` 已用三重官方依据证死（WinRT 的 JS 投影明确排除浏览器、全局对象无 `Windows` 命名空间、WASM 绕不过去）。已有结论：做成**桌面端离线工具**，不是塞进浏览器 |
| 用 WebGPU 换速度 | 要加载 **27 MB** 的 `jsep.wasm`，且本项目**已实测**出现过「第一次推理时页面被回收」（`03` 缺陷 22 / `src/lib/ocrExecutionProvider.ts` 的设计说明）。保持 WASM 是**可预测优于快**的取舍 |
| 为字符级而整体替换掉 PaddleOCR | 字符级与识别质量是两件事：A 能在**不动模型**的前提下拿到字符位置（§2），没有理由为字符框牺牲中文识别率 |

---

## 8. 落地顺序建议

| 序 | 动作 | 依赖 | 体积 | 为什么排这个位置 |
|---|---|---|---|---|
| 1 | **路径 A**：给 `OcrWord` 加 `chars?: OcrChar[]`，用 `detect(crop:true)` + 自建 rec session 补上字符框；纵向用逐列墨迹分析 | 无新增 | **0** | 零成本、直击过去六轮都在打的那些边界情况 |
| 2 | **§6.6 的 `onnxruntime-web/wasm` 别名** | 无新增 | **−13.4 MB 流量** | 单点收益最大，且与「不用 WebGPU」的既有决策一致 |
| 3 | **§6.3 的 INT8 识别模型** | 需先确认中文版 INT8 产物 | 模型可再小 | 官方标称精度不变、WASM 上提速 20–50% |
| 4 | **路径 B**：tesseract.js 作为**懒加载的第二意见** | +5.2 MB（懒加载，不进首屏） | 小 | 需要"独立复核/逐字框"场景时才值得 |
| 5 | **路径 C**：Scribe.js | **先解决 AGPL 决策** | 46 MB 解包 | 技术最完整，但许可证先于技术 |
| — | 路径 D | — | — | **不做** |

---

## 9. ⚠️ 必须说清的边界

> **这一节是本文档的纪律核心，不得删减。**

### 9.1 本次是「文献 / 注册表 / 本机包体」三级证据，**不是端到端实测**

| 我做到的 | 我**没有**做到的 |
|---|---|
| 读本机 `node_modules` 里已安装包的**源码与 `.d.ts` 原文**（`ppu-paddle-ocr@6.6.0`、`onnxruntime-web@1.30.0`、`ppu-ocv@4.0.0`、`@techstark/opencv-js`） | **没有装任何新包**（`tesseract.js`、`scribe.js-ocr` 都只在注册表层面核实） |
| 量本机 `public/ocr-models/`、`node_modules/**/dist/` 与**已存在的 `dist/` 构建产物**的逐文件字节数 | **没有跑任何 OCR 基准**，没有测过识别率、耗时、内存峰值 |
| 读 npm registry、jsDelivr 文件清单、MSYS2 包页、上游官方文档的原文 | **没有在浏览器里验证**任何一条 API 的真实行为 |

**原因**：`universal-reader\` 子树在本会话里**只读**（写入被沙箱拒绝），
既不能 `npm install`，也不能改代码跑基准。**实证部分到此为止。**

### 9.2 逐条列出的未核实项（❓）

| # | 未核实项 |
|---|---|
| 1 | **`hocr_char_boxes` 在 tesseract.js v7（及 v8）里的端到端效果** —— 只核实到「官方文档说该变量存在、`setParameters` 透传所有 Tesseract 变量、`output` 支持 `hocr`」，**没有真跑过一次拿到 `ocrx_cinfo`** |
| 2 | **ScribeOCR 的 `chars` 在哪种识别模式下被填充** —— 文档只写 "Character-level data when available" |
| 3 | **CTC 位置映射在中文与中英混排下的精度** —— 拉丁比例字体的字符宽度差异大，误差可能明显；等宽汉字的预期更好，但没有数据 |
| 4 | **tesseract.js 的中文在真实扫描件（倾斜/噪点/印章）上的识别率** —— 本次只有「弱于 PP-OCRv6」这一方向性判断，**没有数字** |
| 5 | **`onnxruntime-web/wasm` 别名是否真的不破坏会话创建**（§6.6）—— 只有 `exports` 与 import 原文的证据，没有跑过 |
| 6 | **中文版 PP-OCRv6 small rec 的 INT8 产物是否存在**（模型仓库用 Git LFS，GitHub API 只返回 132–134 字节的指针，读不到全集） |
| 7 | **`PP-DocLayoutV2/V3` 等版面模型的真实体积**（同上，LFS 指针不可读）—— 这是 R14 的**第一道门槛**，见 `04` 的 R14 |
| 8 | **逐列墨迹分析在低对比度扫描件上的可靠性**（§2.2 步 5 的纵向范围） |

> **纪律**：在这 8 项里有任何一项被真机跑通之前，本文档中相应的方案一律保持「**未验证**」措辞，
> 不得写成"已实现/已可用"。**§6.6 那一条（−13.4 MB）虽然证据链最完整，也仍然属于"未实测"。**

---

## 10. 来源

**上游官方文档 / 官方注册表**

- [PaddleOCR 官方文档 · 返回识别位置](https://www.paddleocr.ai/v2.9/ppstructure/blog/return_word_pos.html)（「识别模型不仅返回识别的内容，还返回每个文字的位置」）
- [PaddleOCR 官方文档 · 网页前端部署（Paddle.js）](http://www.paddleocr.ai/v2.9/ppocr/infer_deploy/paddle_js.html)
- [RapidOCR · Word Box Calculation](https://deepwiki.com/rapidai/rapidocr/3.4-word-box-calculation)（同一套 CTC 位置 → 词框的做法）
- [tesseract.js 官方 `docs/api.md`](https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/docs/api.md)
- [tesseract.js-core 6.1.2 文件清单（含逐个 wasm 大小）](https://data.jsdelivr.com/v1/package/npm/tesseract.js-core@6.1.2/flat)
- [tesseract.js on npm](https://registry.npmjs.org/tesseract.js/latest) · [tesseract.js-core on npm](https://registry.npmjs.org/tesseract.js-core/latest)
- [MSYS2 · tesseract-data-chi_sim（2.35 MB，基于 tessdata_fast）](https://packages.msys2.org/packages/mingw-w64-ucrt-x86_64-tesseract-data-chi_sim?repo=ucrt64)
- [tesseract 官方 · Traineddata Files（tessdata_fast / best / 标准三套的区别）](https://tesseract-ocr.github.io/tessdoc/Data-Files.html)
- [scribe.js-ocr 官方 API 文档](https://cdn.jsdelivr.net/npm/scribe.js-ocr@0.12.6/docs/API.md) · [scribe.js-ocr on npm（AGPL-3.0）](https://registry.npmjs.org/scribe.js-ocr/latest)
- [ScribeOCR 文档站](http://docs.scribeocr.com/faq.html) · [GitHub scribeocr/tesseract.js](https://github.com/scribeocr/tesseract.js) · [GitHub scribeocr/scribe.js](https://github.com/scribeocr/scribe.js)
- [RapidOCR 文档 · rapidocr_web 安装及使用](https://rapidai.github.io/RapidOCRDocs/v3.1.1/install_usage/rapidocr_web/usage/)
- [paddleocr-browser on Socket（解包 65.9 MB）](https://socket.dev/npm/package/paddleocr-browser/overview/1.0.4)
- [@ocr-web/core on npm](https://www.npmjs.com/package/@ocr-web/core) · [GitHub bent2685/ocr-web](https://github.com/bent2685/ocr-web)
- [GitHub zxc88645/ffocr（超快速純前端 ocr 套件）](https://github.com/zxc88645/ffocr) · [demo](https://zxc88645.github.io/ffocr/demo/) · [ffocr on npm](https://registry.npmjs.org/ffocr/latest)
- [GitHub DayBreak-u/chineseocr_lite（dbnet 1.8M + crnn 2.5M + anglenet 378KB，合计 4.7M）](https://github.com/DayBreak-u/chineseocr_lite)
- [PaddleOCR Discussion #14825 · 返回单个字符位置](https://github.com/PaddlePaddle/PaddleOCR/discussions/14825) · [#14828 · 能精确返回单个字符坐标的模型](https://github.com/PaddlePaddle/PaddleOCR/discussions/14828) · [#14395 · 字符级 OCR 功能](https://github.com/PaddlePaddle/PaddleOCR/discussions/14395)
- [GitHub siva-sub/client-ocr（ONNX Runtime + PaddleOCR 的纯客户端实现，MIT）](https://github.com/siva-sub/client-ocr)

**中文技术社区 / 视频**

- [浏览器里跑 OCR：PaddleOCR + ONNX WASM 是怎么做到不上传图片的](https://www.toolbox365.cn/tutorials/ocr-paddleocr-onnx-wasm-browser/)（27 MB 构成、两阶段架构、不上传的验证方法）
- B 站：[\[每日一库\] Tesseract.js 开源的 OCR 库](https://www.bilibili.com/video/BV1QC4y1c79N/) · [【开源项目】JavaScript 文字识别库](https://www.bilibili.com/video/BV12g411H7n9/)
- [Tesseract.js OCR 中文识别](https://jishuzhan.net/article/2018275642488963073) · [Tesseract.js 实现 OCR 文字识别（华为云社区）](https://bbs.huaweicloud.com/blogs/451020)
- [用 Node.js + 浏览器端 Tesseract.js 搭建高拍仪申请单自动归档系统（腾讯云）](https://cloud.tencent.cn/developer/article/2732993)

**本机实测（只读）**

- `node_modules/ppu-paddle-ocr@6.6.0`：`core/recognition/ctc.d.ts`、`core/base-recognition.service.d.ts`、`core/base-paddle-ocr.service.d.ts`、`core/recognition/line-grouping.d.ts`、`interface.d.ts`、`model-catalogue.d.ts`、`package.json`、`README.md`
- `node_modules/onnxruntime-web@1.30.0/package.json`（`exports` 原文）+ `dist/` 里各 wasm 的字节数
- `node_modules/ppu-ocv@4.0.0`（`deskew.js` / `contours.js` / `image-analysis.js` 等）
- `public/ocr-models/`（三个模型文件字节数）· `dist/`（构建产物里有无 opencv / 有无 ONNX WASM）
- `src/lib/ocrEngine.ts`、`src/lib/ocrExecutionProvider.ts`、`scripts/clean-onnx-wasm.mjs`
- 本项目既有文档：`docs/Windows自带OCR可行性调研.md`、`04-已知限制与路线图.md`、`03-踩坑与修复记录.md`
