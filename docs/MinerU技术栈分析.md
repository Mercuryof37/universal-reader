# MinerU 技术栈分析，与 universal-reader 的对照

> **本文性质**：设计与调研文档。**未改动任何代码，未实施任何一条 TODO，未新增任何依赖。**
>
> **证据纪律**（沿用 `docs/字符级OCR技术调研.md` 的口径）：
> - 【已核实】= 本次用 `web_fetch` **真的打开了**该 URL（文中逐条给出 HTTP 状态），或在本机用命令量到；
> - 【未核实】= 本次**打不开、查不到公开资料**。**凡未核实的一律不写进任何结论性判断**；
> - 【本项目实测】= 本次在 `D:\Deepseek\DSH\universal-reader` 现场跑出来的。
>
> ⚠️ **本机环境限制（影响证据强度，先说清）**：PowerShell 的 `Invoke-WebRequest` / `Invoke-RestMethod`
> 在本会话里被沙箱拒绝（报「Windows PowerShell 处于非交互模式」），**联网取证只能靠 `web_fetch`**。
> 因此下面「已核实/未核实」的判据**只有一条**：`web_fetch` 是否返回 HTTP 200 且拿到正文。
>
> **本章最重要的一句话**：**MinerU 现在不是 AGPL，而且它的当前架构（v4.0）已经把"pipeline vs vlm 二分"取消了。**
> 任务书里基于「v2.x / 两种模式 / AGPL」的三条前提**全部是过期的**，逐条更正见 §一 与 §五。

---

## 〇、开工前的现状复核（本机实测，先钉住基线）

任务书给的现状我**复跑核对过**，三条全部相符：

| 项 | 任务书 | 本次实测 | 命令 | 结论 |
|---|---|---|---|---|
| HEAD | `70b8c50` | `70b8c50ee082f03780333199d9150b74189116b1` | `git rev-parse HEAD` | ✅ 一致 |
| `tsc -b` | exit 0 | `tsc exit=0` | `npx tsc -b` | ✅ 一致 |
| `vitest` | 773 passed / 40 files | `Test Files 40 passed (40)` / `Tests 773 passed (773)`，`vitest exit=0` | `npx vitest run` | ✅ 一致 |

> ⚠️ **一处必须指出的口径出入（不是任务书的错，是 `HANDOFF.md` 的）**：
> `HANDOFF.md` §5.11.8 与路线图 附录 A §1.5 都写着「**这台机器跑不了 `vitest`**」，
> 并据此把相关测试数字降级为【提交记载】。**本次没有复现该故障**——
> `vitest run` 一次成功、跑满 40 个文件。**我无法解释这个差异**（可能是沙箱策略或
> Vite/Rolldown 版本变化），但事实是**本机现在跑得起来**，
> 所以「测试数字只能靠提交信息」这条限制**至少现在不成立**。
> 接手者若再遇到该故障，可对照 §〇 末尾那条 reporter 踩坑记录。

> ⚠️ **顺手记一条踩坑**：我第一次跑的是 `npx vitest run --reporter=basic`，**失败的**——
> vitest 4 已经没有 `basic` 这个 reporter，它会把 `basic` 当成模块名去解析，报
> `Failed to load url basic (resolved id: basic)`。**去掉该参数即可**。这条值得写下来，
> 因为它的失败长相（`ERR_LOAD_URL`）完全不像「参数写错了」，容易被误判成环境问题。
>
> ⚠️ **与 `HANDOFF.md` §5.11.8 的关系**：那份文档多处写着「这台机器跑不了 `vitest`」
> （`vite` 的 `optimizeSafeRealPathSync()` 触发 `spawn EPERM`）。**本次没有复现该故障** ——
> `vitest run` 正常启动并跑完 40 个文件。**我无法解释这个差异**（可能是沙箱策略或 Vite/Rolldown 版本变化），
> 但事实是：**本机现在跑得起来**，所以「测试数字只能靠【提交记载】」这个限制**至少现在不成立了**。

**本文引用的本项目文件**（均**只读**，未修改）：
[HANDOFF.md](D:\Deepseek\DSH\universal-reader\HANDOFF.md)（2476 行）·
[docs/技术路线图-四功能.md](D:\Deepseek\DSH\universal-reader\docs\技术路线图-四功能.md)（1794 行）·
[src/lib/layoutAnalysis.ts](D:\Deepseek\DSH\universal-reader\src\lib\layoutAnalysis.ts) ·
[src/lib/ocrStructure.ts](D:\Deepseek\DSH\universal-reader\src\lib\ocrStructure.ts) ·
[src/lib/ocrSupport.ts](D:\Deepseek\DSH\universal-reader\src\lib\ocrSupport.ts)

---

## 一、MinerU 是什么（含官方来源链接）

### 1.1 一句话

**MinerU 是上海人工智能实验室 OpenDataLab 团队的开源文档解析引擎**，把 PDF / 扫描件 / 图片 /
Office（DOC/DOCX、PPT/PPTX、XLS/XLSX）/ RTF / ODF / EPUB / OFD / HTML / MHTML / CSV
解析成 **Markdown / JSON** 等结构化格式，主要服务于 **RAG、LLM 数据管线与 Agent 工作流**。

【已核实】官方仓库描述原文（`web_fetch` HTTP 200，`api.github.com/repos/opendatalab/MinerU`）：

> "Transforms complex documents like PDFs and Office docs into LLM-ready markdown/JSON for your Agentic workflows."

**仓库元数据**（【已核实】同上 URL，本次实测值）：

| 项 | 值 |
|---|---|
| 全名 | `opendatalab/MinerU` |
| 主语言 | `Python` |
| Stars / Forks | **81,435** / 6,764 |
| 创建 / 最后 push | `2024-02-29` / `2026-10-11T03:22:32Z` |
| 默认分支 | `master` |
| GitHub API 报的 license | ⚠️ `{"key":"other","spdx_id":"NOASSERTION"}` —— **因为它是自定义许可，GitHub 无法归类**。真实条款见 §五 |
| PyPI | `mineru`，最新 **3.1.5**（来自搜索结果标题，**本次未打开 PyPI 页面核对**，标【未核实】） |

### 1.2 它解决什么问题

**核心问题**：PDF 是"打印格式"不是"数据格式"。一份带**双栏、表格、公式、页眉页脚、扫描图像**的
学术论文或教材，用常规文本抽取拿到的是一堆**顺序错乱、公式丢失、表格散架**的碎片，
直接喂给 LLM 会污染整个 RAG 语料。

MinerU 的解法是**多模型级联的版面理解流水线 + VLM 兜底**：先做版面分析拿到区域与类别，
再按区域类型分派到专用识别器（OCR / 公式 / 表格），最后按阅读顺序重排并渲染成 Markdown。

### 1.3 输入 / 输出

【已核实】`README.md`（HTTP 200，已解码为本地副本 `_raw-mineru-README.md`，55,856 字节 / 1096 行）：

**输入**（原文表格）：

| 类型 | 扩展名 |
|---|---|
| PDF | `.pdf`，含扫描版与学术论文 |
| 图片 | `.png` `.jpg` `.jpeg` `.webp` `.gif` `.bmp` `.tiff` `.jp2` |
| Word | `.doc` `.docx` |
| PowerPoint | `.ppt` `.pptx` |
| Excel | `.xls` `.xlsx` |
| 富文本 | `.rtf` |
| OpenDocument | `.odt` `.ods` `.odp` |
| EPUB | `.epub`（按 OPF spine 顺序整本解析，保留源内链） |
| OFD | `.ofd` |
| HTML | `.html` `.htm` `.shtm` |
| MHTML | `.mhtml` `.mht` |
| CSV / TSV | `.csv` `.tsv` |
| 纯文本 | `.txt` `.md` `.markdown` `.rst` `.tex` —— **不解析，直接读** |

**输出**：一个文档模型支持 **9 种渲染目标**（【已核实】`README.md` + `reference/output_files/`）：

| `RenderFormat` | 格式 | Python 返回类型 |
|---|---|---|
| `MARKDOWN` | Markdown | `str` |
| `HTML` | HTML | `str` |
| `LATEX` | LaTeX | `str` |
| `DOCX` | Word | `bytes` |
| `EPUB` | EPUB | `bytes` |
| `PDF` | 原始块版面 **或** 语义重排 | `bytes` |
| `STRUCTURED_CONTENT` | 通用结构化内容 | `dict` |
| `CONTENT_LIST` | Content List V1 | `list[dict]` |
| `CONTENT_LIST_V2` | 按页分组的 Content List V2 | `list[list[dict]]` |

### 1.4 典型用户是谁

【已核实】`README.md` 的 Agent Guide 一节把它定位成 **"a command-line document reader for agents"**，
并明确划清了边界（原文）：

> "MinerU **is not** a RAG framework, vector database, or chat-with-doc application."

所以它的用户画像是三档：

1. **RAG / 预训练数据工程师** —— 把海量 PDF 批量转成干净的 Markdown 喂进向量库或训练集；
2. **AI Agent 运行时** —— MinerU 4.0 提供了 `mineru read "doc:{id}/tier:{tier}/page:{n}/block:{m}"`
   这种**分页/分块的渐进式阅读协议**，让 Agent 不必把整本几百页的文档塞进上下文；
3. **研究者** —— 从论文 PDF 里抽公式与表格。

> ⭐ **这一条对本项目有直接意义**：MinerU 4.0 的"**本地文档库 + 稳定定位符 + 渐进式阅读**"
> 在**功能形态上与本项目高度重叠**，见 §四。

### 1.5 论文（技术报告）

【已核实】共 **3 篇** arXiv 技术报告（从 `README.md` 的 badge 链接取得，其中一篇已下载正文页）：

| 报告 | arXiv | 本次核实 |
|---|---|---|
| MinerU 2.5：解耦式视觉语言模型，高效高分辨率文档解析 | [arXiv:2509.22186](https://arxiv.org/abs/2509.22186) | ✅ **HTTP 200，摘要已读** |
| MinerU2.5-Pro：把数据中心化文档解析推到极限 | [arXiv:2604.04771](https://arxiv.org/abs/2604.04771) | 【未核实】仅从 README badge 取到编号，**未打开** |
| MinerU：开源精确文档内容抽取方案 | [arXiv:2409.18839](https://arxiv.org/abs/2409.18839) | 【未核实】仅从 README BibTeX 取到编号，**未打开** |

**arXiv:2509.22186 摘要的关键机制**【已核实，原文】（2025-09-26 提交，v2 2025-09-29）：

> "a **1.2B-parameter** document parsing vision-language model ... employs a **coarse-to-fine, two-stage**
> parsing strategy that **decouples global layout analysis from local content recognition**.
> In the first stage, the model performs efficient **layout analysis on downsampled images** ...
> In the second stage, guided by the global layout, it performs **targeted content recognition on
> native-resolution crops** extracted from the original image."

> ⭐ **这份"先降采样判版面、再按区域原生分辨率识别"的两阶段设计，是本文认为最值得本项目借鉴的
> 单条工程思想** —— 因为本项目的 `PP-DocLayout-S` **恰好就是"缩放到 480×480 判版面"**
> （【本项目实测】`layoutAnalysis.ts:199` `LAYOUT_INPUT_SIZE = 480`，HANDOFF §5.11.4 记载
> `keep_ratio: false` 直接拉伸）。MinerU 用一篇论文证明了这条路是对的，并且给出了第二步。
> 详见 §六 T3。

---

## 二、MinerU 的完整技术栈

### 2.0 先更正三处过期前提（**这是本节存在的理由**）

任务书要求核实「v2.x 的 pipeline vs vlm 两种模式」。**查完的结论是：这个二分已经不存在了。**

| 任务书的前提 | 实际情况 | 证据 |
|---|---|---|
| MinerU 是 **v2.x** | **当前是 4.0**；3.x 系列最后一个 tag 是 `mineru-3.4.5-released`，4.0 已发布 | 【已核实】`README.md` 标题即 `# MinerU 4.0`；`reference/changelog.md` 有 `## 4.0` 一节 |
| 有 **pipeline / vlm 两种模式** | **4.0 改成 4 个质量档位**（`flash` / `basic` / `standard` / `advanced`）；`--backend` 选项**已被移除**（breaking change） | 【已核实】`usage/tiers/` + changelog「Breaking change: removed the `--backend` option from `mineru-kit parse`」 |
| 中间表示是 **middle JSON（`pdf_info`、`_backend`）** | 4.0 的新协议是 **`docvortex.middle` / protocol `2.0`**；changelog 明确 **「Fields such as `_backend` and `pdf_info` in legacy results are not templates for 4.0」** | 【已核实】`reference/output_files/` + `reference/migration_4/` |

**档位语义**【已核实】`usage/tiers/` 原文表格：

| Tier | 中文名 | 本地执行方式 |
|---|---|---|
| `flash` | 极速解析 | 原生 PDF 文字层 / 文档原生解析；扫描件与图片走 **Flash OCR** |
| `basic` | 基础解析 | **ONNX 或 Torch 小模型**；不需要本地 VLM |
| `standard` | 标准解析 | **小模型 + VLM** |
| `advanced` | 高级解析 | 标准档的模型与运行时，**花更多推理算力** |

**默认选择策略**【已核实】`usage/tiers/`：

- `mineru-kit parse` 与本地 Python `parse()` 对 PDF **默认 `standard`**；
- 文档库发现服务能力后**优先 `standard`，其次 `basic`**；
- ⭐ **两者都不可用时返回 `quality_tier_unavailable`，而"不静默选 `flash`、不上传到官方服务"**（原文）；
- `advanced` 必须显式指定。

> ⭐ **上面这一条是本项目最该抄的东西**，见 §六 T1。

### 2.1 语言 / 框架 / 运行时

【已核实】`pyproject.toml`（HTTP 200，已解码）：

| 项 | 值 |
|---|---|
| `requires-python` | `>=3.10,<3.15` |
| 深度学习框架 | **PyTorch**（`torch>=2.7.0,<3`、`torchvision`、`transformers>=5.10.1,<6`）**可选**，在 `[torch]` extra 里 |
| 小模型推理 | **ONNX Runtime**（`onnxruntime>=1.20.1`）**默认路径** |
| VLM 推理 | **llama.cpp / vLLM / LMDeploy / MLX**（`vllm` 在 `[full]` extra 里） |
| 文档/图像处理 | `pypdfium2>=5.10.1,<6`、`PyYAML`、`pillow>=11`、`opencv` 系（`shapely`、`pyclipper`） |
| PDF 表格/结构 | `ftfy`、`beautifulsoup4`、`tinycss2` |
| 服务端 | **FastAPI + uvicorn**（`mineru-kit api-server`）、**Gradio**（WebUI） |
| 核心解析依赖 | **`docvortex>=0.5.16,<1`**（原 `>=0.5.16`，README 又要求 `>=0.4.19,<1`）、`mineru-vl-utils>=2.0.5,<3`、`mineru-llama-cpp>=0.1.2,<1` |
| 许可声明 | `license = "LicenseRef-MinerU-Open-Source-License"`，`license-files = ["LICENSE.md"]` |

**核心里程碑**【已核实，changelog】**：2.0.0（2025-06-13）起**彻底弃用 `pymupdf`**，
改用 `pypdfium2`（原文理由：licensing——`pymupdf` 是 **AGPL-3.0 或商业双许可**，
与路线图 附录 A 记录的常识口径一致）。**1.3.0（2025-04-03）**把 `paddle` / `paddleocr`
整条换成 `paddleocr2torch`，理由是与 `torch` 冲突及 `paddle` 的线程安全问题。

### 2.2 版面分析（Layout Analysis）

**MinerU 的版面模型经历了三代，且第一代是 AGPL** —— 这段历史很重要，见 §五。

| 阶段 | 模型 | 证据 |
|---|---|---|
| 0.9.0（2024-10-31） | 自研 **`doclayout_yolo`**，可与 **`layoutlmv3`** 通过配置切换 | 【已核实】changelog 原文「Added the self-developed `doclayout_yolo` model ... can be freely switched with `layoutlmv3`」 |
| 1.1.0（2025-01-22） | 升级到 **`doclayout_yolo(2501)`** | 【已核实】changelog 原文 |
| **3.0.0（2026-03-29）** | ⭐ **彻底移除** `doclayoutyolo`（**AGPLv3**）与 `mfd_yolov8`（**AGPLv3**）、`layoutreader`（**CC-BY-NC-SA 4.0**） | 【已核实】changelog 原文「**Completely removed the use of two AGPLv3 models (`doclayoutyolo` and `mfd_yolov8`) and one CC-BY-NC-SA 4.0 model (`layoutreader`)**」 |
| 3.x → 4.0 | 换到 PaddleOCR 的 **`PP-DocLayout` 家族** | 【推测】—— ⚠️ **changelog 没有一句话明说 3.0.0 换成了哪个模型**。间接证据：`usage/tiers/` 原文写「**ONNX Layout, OCR, and formula models run on CPU**」，以及 `README.md` 的 Acknowledgments 里同时致谢 `PaddleOCR` 与 `PaddleOCR2Pytorch`。**标【未核实】** |

**关于任务书点名的 `DocLayout-YOLO`**：

| 项 | 值 | 证据 |
|---|---|---|
| 仓库 | `opendatalab/DocLayout-YOLO` | |
| **许可** | ⭐ **AGPL-3.0** | 【已核实】`api.github.com/repos/opendatalab/DocLayout-YOLO` 返回 `"license":{"key":"agpl-3.0","spdx_id":"AGPL-3.0"}` |
| Stars / 最后 push | 2,292 / `2025-04-14` | 【已核实】同上 |
| 论文标题 | "DocLayout-YOLO: Enhancing Document Layout Analysis through Diverse Synthetic Data and Global-to-Local Adaptive Perception" | 【已核实】同上 |
| 体积 / mAP | **【未核实】** —— 本次没有打开任何权重发布页 | |

> ⭐ **这一条同时回答了三个问题**：
> ① 路线图 附录 A 把 `DocLayout-YOLO` 的许可标成「📕 未核实（搜索结果显示可能有 AGPL 版本）」——
> **现在核实了：就是 AGPL-3.0**；
> ② MinerU 自己在 3.0.0 把它**删掉**了，这正是"AGPL 传染性会逼走商业使用者"的活标本；
> ③ **对本项目**：AGPL-3.0 意味着**任何形式的使用都不能碰**，见 §五。
>
> ⚠️ **但它的论文/机制仍可读**（思想不受版权保护），只是**代码与权重不能进本仓库**。

**PP-DocLayout 家族规格**（供本项目的"要不要换更大的版面模型"决策使用）：

【已核实】`https://www.paddleocr.ai/main/version3.x/module_usage/layout_detection.html`（HTTP 200，本次直接打开，
**与路线图 附录 A 引用的同一页，数字逐项一致**）：

| 模型 | 骨干 | mAP(0.5) | 模型存储大小 | 评测集 |
|---|---|---|---|---|
| `PP-DocLayout_plus-L` | RT-DETR-L | 83.2 | **126.01 MB** | 1300 张自建集 |
| `PP-DocLayout-L` | RT-DETR-L | 90.4 | **123.76 MB** | 500 张自建集 |
| `PP-DocLayout-M` | PicoDet-L | 75.2 | **22.578 MB** | 500 张自建集 |
| **`PP-DocLayout-S`（本项目在用）** | PicoDet-S | **70.9** | **4.834 MB** | 500 张自建集 |
| `PP-DocBlockLayout`（只 1 类：版面区域） | RT-DETR-L | 95.9 | **123.92 MB** | 1000 张自建集 |

> ⚠️ **本次新发现的一处细节，路线图没记**：该页现在的类别描述里，
> 「20 个类别」与「23 个类别」两组模型的类别列表**文字高度雷同且都出现了两次"图表标题"**，
> 官方排版疑似有笔误。本项目 `LAYOUT_LABELS` 的 **23 类顺序**取自
> `stefanj0/PP-DocLayout-S-ONNX` 的 ONNX protobuf【本项目实测，HANDOFF §5.11.3/§5.11.4】，
> **这才是权威来源**。若将来要把类别描述文案对到官方文档上，**不要照抄这段话**。

### 2.3 公式检测与识别（MFD / MFR）

【已核实】changelog 原文，**MinerU 的公式模型换代时间线**：

| 版本 | 公式模型 |
|---|---|
| 0.9.0（2024-10-31） | `unimernet 0.2.1` |
| 1.1.0（2025-01-22） | `unimernet(2501)` |
| 1.3.0（2025-04-03） | `unimernet(2503)`（**原文理由：修复多行公式的换行丢失**） |
| 3.x → 4.0 | **PaddleOCR 的 `PP-FormulaNet` 家族**【推测，同 §2.2 的理由；**未核实**】 |

**关于任务书点名的 `UniMERNet`**：

| 项 | 结论 |
|---|---|
| 体积 | **1530 MB**【已核实】PaddleOCR 官方 `formula_recognition.html`（HTTP 200，本次直接打开） |
| En-BLEU / Zh-BLEU | **85.91 / 43.50**【已核实】同上 |
| 结构与训练 | Donut Swin 编码器 + MBart 解码器，一百万级公式数据【已核实】同上 |
| GPU / CPU 推理耗时 | **1311.84 ms / 8288.07 ms**（高性能模式 CPU）【已核实】同上 |
| 官方仓库 | ⚠️ **`github.com/wenbihan/UniMERNet` 返回 404**（本次复核，与路线图 记录一致）→ **未找到官方仓库**，标【未核实】 |
| 自身许可 | **【未核实】** —— 仓库 404，无从查证 |

**`PP-FormulaNet` 家族规格**【已核实】`formula_recognition.html`（HTTP 200）：

| 模型 | En-BLEU | Zh-BLEU | 模型存储大小 |
|---|---|---|---|
| `PP-FormulaNet-S` | 87.00 | 45.71 | **224 MB** |
| `PP-FormulaNet_plus-S` | 88.71 | 53.32 | **248 MB** |
| `PP-FormulaNet-L` | 90.36 | 45.78 | **695 MB** |
| `UniMERNet` | 85.91 | 43.50 | **1530 MB** |

> ### ⭐ 结论：任务书给的「PP-FormulaNet-S = 224 MB、UniMERNet = 1530 MB」**已核实无误**
>
> 本次**直接打开了 PaddleOCR 官方文档**，两个数字**与任务书逐字相符**。
> 结合 §四·3 的体积换算：**公式 OCR 模型在本项目约束下确实不可能**，这个结论**成立且不需要再查**。

### 2.4 OCR

【已核实】changelog 原文：

| 版本 | OCR 模型 |
|---|---|
| 1.3.8（2025-04-23） | 默认 `ch` 模型 → `PP-OCRv4_server_rec_doc`（1.5 万+ 字符） |
| 1.3.12（2025-05-24） | 支持 `PPOCRv5`；`ch_server` → `PP-OCRv5_rec_server`、`ch_lite` → `PP-OCRv5_rec_mobile`（1.8 万字典） |
| 2.6.2（2025-10-24） | `ppocr-v5` 版 Cyrillic / Arabic / Devanagari / Telugu / Tamil 语系，**准确率 +40%** |
| **3.4（2026-06-18）** | ⭐ **升级到 `PP-OCRv6`**，OmniDocBench v1.6 上**准确率 +约 11%**；OCR 处理**速度 +约 100%** |
| 3.4 附带简化 | **移除日语 / 繁体中文 / 英语 / 拉丁语选项** —— 这些场景**统一路由到 `ch` 模型** |
| 2.7.0 | `hybrid` 后端支持 **109 种语言** OCR |
| 0.9.0 | 最初支持 84 种语言 |

> ⭐⭐ **`PP-OCRv6` 是本项目正在用的识别模型代次**
> （【本项目实测】`public/ocr-models/recognition/ort/PP-OCRv6_small_rec.ort`，21,290,816 字节）。
> **MinerU 3.4 选择它，并给出"OmniDocBench v1.6 上 +11%"这个官方口径的收益数字** ——
> 这为本项目"当初选 PP-OCRv6 是不是对的"提供了一个**独立于 PaddleOCR 自评的旁证**（同一来源链，但至少是
> 一个下游大项目的实测背书）。⚠️ **该 +11% 是 MinerU 的说法，不是本项目实测。**

### 2.5 表格识别

【已核实】changelog：

| 版本 | 表格方案 |
|---|---|
| 0.7.1b1（2024-08-09） | 加入 `paddle tablemaster` 表格识别选项 |
| 0.9.0 | 集成 **`RapidTable`**（原文："single-table parsing speed by more than 10 times, with higher accuracy and lower GPU memory usage"） |
| 0.9.2（2024-11-06） | 集成 **`StructTable-InternVL2-1B`**（`U4R/StructTable-InternVL2-1B`） |
| 4.0 | ⭐ **表分类 + `SLANet` + `UNet` 三个模型**，由 `MINERU_TABLE_DEVICE` 控制设备（`auto/cpu/cuda`） |

【已核实】`usage/tiers/` 原文（这是当前唯一一处能确认 4.0 表格模型名字的地方）：

> "**Table classification, SLANet, and UNet** use `MINERU_TABLE_DEVICE=auto` by default:
> the CPU `onnxruntime` package uses CPU; replacing it with a compatible `onnxruntime-gpu`
> package enables CUDA when its provider is available."

- `SLANet` → PaddleOCR 的表格结构识别（`table_structure_recognition`）系列；【未核实】体积，**本次未打开该页**。
- `UNet` → 推断为表格**单元格检测**或表格区域分割；【未核实】。
- README 的 Acknowledgments 还致谢了 **`RapidAI/TableStructureRec`**。

### 2.6 阅读顺序（Reading Order）

【已核实】changelog，**换代很清楚**：

| 版本 | 阅读顺序方案 |
|---|---|
| 0.9.0（2024-10-31） | 用 **`layoutreader`**（`ppaanngggg/layoutreader`）重构排序模块 |
| **3.0.0（2026-03-29）** | ⭐ **移除 `layoutreader`** —— 理由是它是 **CC-BY-NC-SA 4.0**（**NC = 非商业**） |

> ⭐ **这是第二个"许可是硬约束"的活标本**：`layoutreader` 是**非商业**许可，
> 于是 MinerU 为了能商用，**在 3.0.0 把它整个拿掉了**。
>
> ⚠️ **更新路线图的一条记载**：路线图 附录 A 记录「LayoutReader（微软）论文 CC BY-NC-SA 4.0
> —— ⚠️ **NC 条款，商用需注意**；代码许可 📕 未核实」。
> **现在有了新证据**：MinerU 的 changelog **明确把 `layoutreader` 的许可记为 `CC-BY-NC-SA 4.0`**
> （并把"移除它"当成 3.0.0 的卖点写进发布说明）。这**间接核实了代码侧的许可**，
> 且给出了一个**同行的处置先例：NC 模型直接删**。

4.0 的阅读顺序**没有单独的模型文档页**；从 `usage/tiers/` 看，它归入小模型包
（`basic` 档也具备阅读顺序能力）。**具体实现方式【未核实】。**

### 2.7 VLM 后端（v2.x 的 `vlm` 模式 → v4.0 的 `standard`/`advanced`）

【已核实】changelog + README：

| 版本 | VLM |
|---|---|
| 2.0.0（2025-06-13） | 自研 **`<1B`** 多模态模型，单模型覆盖多语言识别 / 手写 / 版面 / 表格 / 公式 / 阅读顺序；`sglang` 加速下单张 4090 超 **10,000 tokens/s** |
| 2.5.2（2025-09-19） | 发布 **`MinerU2.5-2509-1.2B`**（HuggingFace / ModelScope） |
| 3.1.0（2026-04-18） | VLM 主模型 → **`MinerU2.5-Pro-2604-1.2B`**；新增图像与图表解析、截断段落合并、**跨页表格合并**、表格内图像识别 |
| 3.3（2026-06-11） | → **`MinerU2.5-Pro-2605-1.2B`**；新增原生多语言 OCR |
| 4.0 | 小模型后端与 VLM 引擎**独立配置**：`model.small_backend`（`auto/onnx/torch`）+ `model.vlm.engine`（`auto/llama-cpp/vllm/lmdeploy`） |

**模型体积与资源**【已核实】`README.md` 表格（**注意这是整个档位的下载量，不是单文件**）：

| Tier | 模型引擎 | 模型下载量 | 最低内存 | 加速器 |
|---|---|---|---|---|
| `basic` | ONNX | **~0.8 GB** | 2 GB | 无（CPU 可用） |
| `basic` | PyTorch | ~0.8 GB | 8 GB | 建议 GPU/MPS |
| `standard`/`advanced` | ONNX + llama.cpp | **~2 GB** | 8 GB | CPU 可用，建议 Vulkan |
| `standard`/`advanced` | PyTorch + llama.cpp | ~2 GB | 16 GB | 需 GPU/MPS，8 GB+ 显存 |
| `standard`/`advanced` | PyTorch + vLLM/lmdeploy/mlx | **~3 GB** | 16 GB | 需 GPU/MPS，8 GB+ 显存 |

**三种远程连接**【已核实】`usage/model_source/`（MinerU 明确警告这三者**不可互换**）：

| 连接 | 用途 | 配置位置 |
|---|---|---|
| V1 文档解析服务 | 上传文档、提交解析任务、下载结果 | `MINERU_API_URL` / `MINERU_API_KEY` |
| 远程 VLM 推理服务 | 为本地解析流程提供模型推理（OpenAI 兼容） | `model.vlm.server_url` / `api_key` / `model` |
| LLM 辅助后处理 | **标题分级**、**跨页表格单元格续接**（**两者默认关闭**） | `llm_aided.api_key` / `base_url` / `model` |

### 2.8 许可速查表

| 组件 | 许可 | 证据等级 |
|---|---|---|
| **MinerU 本体** | **MinerU Open Source License**（Apache-2.0 + 附加条款） | 【已核实】`LICENSE.md` HTTP 200，全文已解 |
| `DocLayout-YOLO` | ⚠️ **AGPL-3.0** | 【已核实】GitHub API |
| `layoutreader`（<3.0.0 用过） | ⚠️ **CC-BY-NC-SA 4.0** | 【已核实】MinerU changelog 明文 |
| `PyMuPDF`（<2.0.0 用过） | ⚠️ AGPL-3.0 或商业双许可（MinerU 因此弃用） | 【已核实】changelog 记「2.0.0 完全消除对 `pymupdf` 的依赖」 |
| `PaddleOCR` / `PP-OCRv6` / `PP-DocLayout` / `PP-FormulaNet` | **Apache-2.0** | 【未核实】本次**没有打开 PaddleOCR 的 LICENSE 文件**；路线图 附录 A 亦标「📕 未复核 LICENSE 文件」。**继承路线图口径，标未核实** |
| `UniMERNet` | **【未核实】**（GitHub 404） | |
| `SLANet` / `UNet` / 表格分类模型 | **【未核实】** | |
| `MinerU2.5-*-1.2B` 权重 | **【未核实】**（HuggingFace 本机不可达） | |

---

## 三、它的文档解析流水线（含中间表示 / JSON schema）

### 3.1 两阶段解耦流水线（4.0）

【已核实】`README.md` + `usage/tiers/` + arXiv 摘要，4.0 的 `standard`/`advanced` 是：

```
输入文档
   │
   ├─(文字层可用 / Office / EPUB / HTML 等)──► flash：原生文本抽取，零推理
   │
   └─(扫描件 / 图片 / PDF)──► 按 tier 分流
                                │
        ┌───────────────────────┴────────────────────────┐
        ▼ basic                                          ▼ standard / advanced
   小模型（ONNX 或 Torch，CPU 可跑）                 小模型 + VLM
   ① 版面分析（Layout）                             VLM 做两阶段解耦解析：
   ② 文本检测 + 识别（PP-OCRv6）                     stage 1：降采样图上做版面分析
   ③ 公式检测 + 识别（PP-FormulaNet）                stage 2：按版面引导，在原生分辨率
   ④ 表格：分类 + SLANet + UNet                             裁剪块上做内容识别
   ⑤ 阅读顺序
        └───────────────────────┬────────────────────────┘
                                ▼
                   统一文档模型（pages → blocks → content spans）
                                ▼
              9 种渲染目标 / middle_json / structured_content / zip
```

**小模型与 VLM 引擎的可用组合**【已核实】`README.md`：

| Extra | 安装的模型引擎 |
|---|---|
| （base） | **ONNX + llama.cpp** |
| `torch` | ONNX + PyTorch + llama.cpp |
| `full` | ONNX + PyTorch + llama.cpp + vLLM/lmdeploy/mlx |

**平台自动选择**【已核实】`usage/tiers/`：Apple Silicon → Torch/MPS + llama.cpp；
Linux/Windows base → ONNX/CPU + llama.cpp；Linux + 加速器 + `full` → Torch + vLLM；
Windows + 加速器 + `full` → Torch + LMDeploy；纯 CPU → ONNX/CPU + llama.cpp。

### 3.2 ⭐ 中间表示：`middle_json` 的真实 schema

> 任务书说「这一条很重要」。**结论是：它有两个不兼容的版本，且当前版本的字段名与广为流传的
> `pdf_info` 完全不同。这一点如果搞错，任何"兼容 MinerU 输出"的打算都会落空。**

#### 3.2.1 当前协议（4.0）：`docvortex.middle` / protocol `2.0`

【已核实】`reference/output_files/`（HTTP 200），**官方给出的示例逐字如下**：

```json
{
  "metadata": {
    "file_suffix": "html",
    "producer": { "name": "mineru", "version": "4.0.0" }
  },
  "extensions": {
    "mineru": { "tier": "flash", "parse_mode": "txt" }
  },
  "pages": [
    {
      "page_idx": 0,
      "blocks": [
        {
          "type": "text",
          "index": 0,
          "content": [ { "type": "text", "content": "Hello MinerU" } ]
        }
      ]
    }
  ],
  "is_full_document": true,
  "schema": "docvortex.middle",
  "schema_version": "2.0"
}
```

**官方对这份契约的关键说明**【已核实，逐条原文要点】：

| # | 规则 |
|---|---|
| 1 | **两种 JSON 是两回事**：`ModelJson` 持有**分析阶段**的 `pages` 与 `page_index_map`；`MiddleJson` 持有**后处理后的有序页面与语义块** |
| 2 | ⭐ **靠序列化出来的 `schema` 与 `schema_version` 两个键识别载荷类型**（`docvortex.model` 或 `docvortex.middle`，protocol `2.0`）。**Python 属性名叫 `schema_id`，但序列化成 `schema`** —— 读写 JSON 时必须用序列化名 |
| 3 | ⚠️ **「不要只看版本号就判断文档类型」**（原文："Do not identify a document type from its version number alone."） |
| 4 | `metadata` 携带文件类型、producer、文档属性 |
| 5 | ⭐ `extensions["mineru"]` 记录**实际使用的 `tier`** 与**最终 `parse_mode`** |
| 6 | **生产版本在 `metadata.producer.version`**，不是产品扩展字段里的副本 |
| 7 | ⭐ **`page_idx` 是 0-based，而 CLI 的 PDF 页码范围是 1-based**（官方明确点出这个不对称） |
| 8 | 所有 PDF 档位还会输出 `extensions.docvortex_layout`：`version=1`，`pages` 含 `page_idx`、`width_pt`、`height_pt`、可选 `image_rotations` |
| 9 | ⭐ **PDF 导出只需要 MiddleJson + 图像资产，不需要源 PDF 或 ModelJson** |
| 10 | ⚠️ **`ParseResult.to_dict()` / `to_json()` 仍会省略块的 `image_base64`**，所以"结构化 JSON 不是完整结果包" |
| 11 | ⚠️ **`mineru parse --json` 的响应不是 MiddleJson**，不能直接喂给 `ParseResult.from_dict()` |

**`structured_content` 是另一层**【已核实】——它**不含 schema 标识**（原文：
"It carries no schema identity: **do not add `schema` or `schema_version` keys to it**"），
把自然语言 span 拍平成 `content: "Hello MinerU"` 这样的字符串。

#### 3.2.2 历史协议（≤3.4.x）：`pdf_info` / `_backend`

【已核实】`reference/migration_4/` 原文：

> "Fields such as **`_backend`** and **`pdf_info`** in legacy results are **not templates for 4.0**."

⚠️ **因此**：网上大量教程、以及大部分第三方集成代码引用的 `middle.json` 的
`pdf_info → page_info → blocks` 结构，**属于 ≤3.4.x 的旧协议**。任务书里
「它的 middle JSON schema 长什么样」这个问题，**必须回答"看你问哪一代"**。

#### 3.2.3 兼容性矩阵（4.0 对旧数据的处置）

【已核实】`reference/migration_4/` 原文表格，缩译：

| 数据 | 4.0 如何处置 |
|---|---|
| 带 `schema` 标识的当前协议（`2.0`） | `ParseResult` / HTTP / ZIP / Gradio **严格读取**；带当前标识但校验失败的载荷**不会被当作旧格式重试** |
| 可识别的 Doclib 缓存历史（**3.4.5 的 `pdf_info` 页面**、`schema_version` `1.0`、或无 `schema` 键的 `2.0`） | **仅由专用 Doclib 缓存读取器在内存里转换**；不扩展到其他入口，**且不重写历史文件** |
| 保存在 Doclib 之外的老结果 JSON | **不保证**能通过 `ParseResult.from_dict()` 载入；请重新解析源文档 |
| 缺资产或缺新几何信息的老产物 | 重新解析；**只改版本号不会迁移载荷** |

> ⭐⭐ **这最后一句是本项目最该抄的一条治理原则**（见 §六 T5）：
> **「改版本号不等于迁移」**、"能被读" / "被自动迁移" / "能重导出所有格式" 是**三个独立主张，必须分别对待**。

### 3.3 定位符（Locator）协议

【已核实】`README.md` 原文，5 级稳定定位符：

```
doc:{short_id}
doc:{short_id}/tier:{tier}
doc:{short_id}/tier:{tier}/page:{page_no}
doc:{short_id}/tier:{tier}/page:{page_no}/block:{block_no}
doc:{short_id}/tier:{tier}/page:{page_no}/block:{block_no}/char:{offset}
```

规则【已核实】：页码与块号 **1-based**；字符 offset **0-based 且在块文本内**；
`--context N` 表示页定位符取相邻页、块定位符取相邻块。

> ⭐ **`char:{offset}` 这一级值得单独看**：它把"引用"细到了**块内字符偏移**。
> 本项目的批注锚点正是缺这个（见 §六 T4）。

### 3.4 缓存与续读

【已核实】`README.md` + `usage/tiers/`：

- 按 **(文档, 档位)** 缓存解析结果；`mineru read` **只消费缓存，不发起新解析**；
- 无显式档位时，`read` 优先 **已缓存的 `advanced` → `standard` → `basic`**；
- `--force` 跳过已完成缓存（**不失效、不删除**旧结果）；
- `mineru invalidate` 让**将来的**解析与读取避开已有结果，**且不自动发起新解析**；
- ⭐ `mineru parse` **默认只解析前 10 页 PDF**，靠返回的 locator 续读；`mineru-kit parse` 默认全页。

**长文档的两条工程措施**【已核实】changelog 3.0.0：

1. **滑动窗口机制**，显著降低长文档峰值内存 ——「documents with **tens of thousands of pages**
   no longer need to be split manually」；
2. 批量推理**支持流式落盘**，完成一批就写出一批。

> ⭐ **这两条直接对应本项目**：本项目已有「每 5 页中途落盘」的检查点机制（HANDOFF §5.9），
> MinerU 把同一件事做成了框架级特性。见 §六 T6。

---

## 四、与本项目的逐项对照

### 4.1 定位差异（**这是所有技术差异的根因**）

| 维度 | MinerU 4.0 | universal-reader | 差异根因 |
|---|---|---|---|
| 形态 | Python CLI + 本地常驻服务 + 可选远程 API + Gradio WebUI | **纯前端静态站点**（Cloudflare Pages） | C1 零后端 |
| 数据边界 | 默认本地，`--remote` 才上传（**显式**） | **默认零外发**，三条外发路径全部默认关闭（**显式**） | 两者**设计哲学一致**，实现手段不同 |
| 计算资源 | 最低 2 GB 内存（`basic`），`standard` 建议 8–16 GB | **单线程 WASM**（`ort.env.wasm.numThreads = 1`） | 浏览器是客户端的客户端 |
| 模型预算 | **~0.8 GB / ~2 GB / ~3 GB** | **单文件 ≤ 25 MiB**，同源模型合计 34.59 MiB | C6 静态托管 |
| 输出 | 9 种渲染目标（md/html/latex/docx/epub/pdf/结构化） | md/txt/pdf/epub **读入** → 双语对照 + TTS + 批注 | MinerU 是**抽取器**，本项目是**阅读器** |
| 核心用户 | RAG / Agent / 数据管线 | 读文档的人 | ！**这是最关键的分歧** —— |

> ⚠️ **但这条分歧正在消失**：MinerU 4.0 新增了「**本地文档库**」——
> 文件发现、结果缓存、内容搜索、按页/块续读、稳定引用定位符。**这已经是一个阅读器了。**
> 所以 MinerU 4.0 对本项目的价值，**不只是"借鉴其解析流水线"，还包括"看它怎么组织一个阅读器"**。

### 4.2 逐项对照表

| 环节 | MinerU 怎么做 | 本项目怎么做 | 差异根因 | 能否借鉴 |
|---|---|---|---|---|
| **版面分析** | ONNX/Torch 小模型；4.0 用 `PP-DocLayout` 家族【模型名未核实】；曾用 `DocLayout-YOLO`（**AGPL-3.0**，3.0.0 已删） | `PP-DocLayout-S.onnx` **4.69 MiB**（【本项目实测】4,917,852 字节），23 类，mAP 70.9 | 体积预算差 30 倍以上 | ❌ **模型不可借鉴**；✅ **架构与治理可借鉴**（§六 T1/T2） |
| **版面模型精度评估** | 有 **OmniDocBench** 官方基准，每次发版都报分（如 3.0.0 `pipeline` = 86.2） | ❌ **从未在真实扫描件上推理过**（HANDOFF §5.11.7 明文） | 无基准、无标注预算 | ✅ **"发版必须报分"这条纪律可借鉴**（§六 T2） |
| **OCR** | **`PP-OCRv6`（3.4 起）**，OmniDocBench v1.6 上 +约 11% | **`PP-OCRv6_small`**（20.30 MiB）+ 自建 CTC 字符级解码 | **同一个模型代次！** 差异在"用官方 pipeline" vs "自己写 3000 行字符级链路" | ✅ 代次印证（**不是新建议**） |
| **公式** | `PP-FormulaNet` 家族【未核实具体档位】；曾用 `UniMERNet` | ❌ **没有本地公式识别**；只有默认关闭的云端 SimpleTex | **体积**：最小 `PP-FormulaNet-S` = **224 MB = 25 MiB 的 896%** | ❌ **不可借鉴**（本次再次核实，结论不变） |
| **表格** | 表分类 + `SLANet` + `UNet`（`MINERU_TABLE_DEVICE` 控设备） | ❌ 无表格结构识别；Markdown 表格退化为普通文本（HANDOFF §7 P1） | 体积 + 项目定位 | ❌ 模型不可借鉴；⚠️ **但"Markdown 表格渲染"这个缺口值得单列**（§六 T7 之外的独立项） |
| **阅读顺序** | 曾用 `layoutreader`（**CC-BY-NC-SA 4.0**，3.0.0 已删）；现归入小模型包【实现未核实】 | 几何 + `readingOrderKeys()` / `orderRegionsForReading()` / `detectColumns()`【本项目实测】 | MinerU 有专门的顺序模型，本项目靠纯几何 | ⚠️ **MinerU 的"机制描述"没查到**（4.0 无独立文档页）→ **无法借鉴**；路线图已有的 `XY-Cut++` 路线仍是首选 |
| **中间表示** | `docvortex.middle` / protocol `2.0`，**按 `schema` + `schema_version` 双键识别载荷**，拒绝"只看版本号" | `ContentBlock` + `ocrStructure` 导出（含 `buildId`） | MinerU 要跨代兼容历史数据；本项目**没有存量格式包袱** | ✅⭐ **"schema 双键 + 拒看版本号"可借鉴**（§六 T5） |
| **导出契约** | `metadata.producer.version` 记生产版本；`extensions.mineru.tier` 记实际档位；`is_full_document` 标记完整性 | `ocrStructure.buildId` 已是**同思想**的雏形 | — | ✅ **补 `tier`/完整性标记**（§六 T5） |
| **错误契约** | ⭐ **稳定 `error.code` 枚举**（`quality_tier_unavailable` / `no_engine` / `parse_timeout` / `remote_not_allowed` …）+ `retryable` + `user_action`；明文「**不要拿人类散文做分支判断**」 | 黄条 + 对话框文案；`detectOcrSupport()`（【本项目实测】`ocrSupport.ts`） | MinerU 要服务机器消费者；本项目面向人 | ✅⭐ **最值得借鉴的一条**（§六 T1） |
| **降级策略** | ⭐ **绝不静默降级**：`standard` 不可用 → 报 `quality_tier_unavailable`，**既不默默用 `flash`，也不默默上传** | ⚠️ `analyzePageLayout()` **任何失败返回 `null`** → **静默退回几何启发式** | MinerU 显式暴露质量，本项目隐式 | ✅⭐ **直击本项目一个真实缺口**（§六 T1） |
| **缓存** | 按 (文档, 档位) 缓存；`--force` / `invalidate` 语义分离 | OCR 结果落 DB；检查点每 5 页 | — | ✅ 语义可借鉴（§六 T6） |
| **长文档** | 滑动窗口降峰值内存 + 流式落盘；**数万页不需手工切分** | 每 5 页检查点（`OCR_CHECKPOINT_EVERY_PAGES = 5`） | — | ✅ 印证（**不是新建议**） |
| **许可** | 曾是 **AGPLv3**，3.1.0 改成 Apache-2.0+附加条款 | 本项目：**需要能公网部署且不承担传染性义务** | 商业可用性 | ⚠️ 见 §五 |
| **遥测** | ⚠️ **默认可能收集匿名遥测**，但**明确声明不含文档内容/文本/图像/文件名/路径/搜索词** | 零遥测 | — | ✅ **"排除清单"的写法可借用**（写隐私声明时） |

### 4.3 体积对照：**逐个数字与 25 MiB 上限算一遍**

> 换算口径：**1 MiB = 1048576 字节**。PaddleOCR 表里的「MB」按十进制 MB 处理（1 MB = 10⁶ 字节），
> 即 `1 MB = 0.9537 MiB`。「超限倍数」= 该文件 MiB / 25 MiB。

**A. MinerU 侧（模型下载量）**

| 项 | 原始口径 | MiB | vs 25 MiB | 判定 |
|---|---|---|---|---|
| MinerU `basic` 档 | ~0.8 GB | ≈ 762.94 MiB | **30.52×** | ❌ **超限 30 倍** |
| MinerU `standard`/`advanced`（ONNX+llama.cpp） | ~2 GB | ≈ 1907.35 MiB | **76.29×** | ❌ **超限 76 倍** |
| MinerU `standard`/`advanced`（PyTorch+VLM 引擎） | ~3 GB | ≈ 2861.02 MiB | **114.44×** | ❌ **超限 114 倍** |

⚠️ **口径诚实说明**：上表是**整个档位的模型下载总量**，MinerU **并没有承诺"单文件不超过 X"**，
所以"超限倍数"这个说法对 MinerU 严格来说**不成立**（它跑在文件系统上，没有 25 MiB 单文件限制）。
**正确的读法是**：即便把 MinerU 的模型拆成单文件，**总量也比本项目全部同源资产大 22–83 倍**，
而且**必须走外部 CDN 分发** —— 这与本项目 **C2 离线可用 + local-first 的承诺直接冲突**（不是"超限"，是"路线冲突"）。
**结论：MinerU 的模型资产整体不可引入本项目，无论拆不拆。**

**B. PaddleOCR 侧（单文件，**这才是真正的"超限倍数"**）**

| 模型 | 官方标称 | MiB | vs 25 MiB | 判定 |
|---|---|---|---|---|
| `UniMERNet` | 1530 MB | ≈ 1459.20 MiB | **5837%**（58.4×） | ❌ 需外部 CDN，与 local-first 冲突 |
| `PP-FormulaNet-L` | 695 MB | ≈ 662.82 MiB | **2651%**（26.5×） | ❌ 同上 |
| `PP-FormulaNet_plus-S` | 248 MB | ≈ 236.51 MiB | **946%**（9.5×） | ❌ 同上 |
| **`PP-FormulaNet-S`** | 224 MB | ≈ 213.62 MiB | **855%**（8.5×） | ❌ **超限 8.5 倍** |
| `PP-DocLayout_plus-L` | 126.01 MB | ≈ 120.17 MiB | **481%**（4.8×） | ❌ |
| `PP-DocLayout-L` | 123.76 MB | ≈ 118.02 MiB | **472%** | ❌ |
| `PP-DocBlockLayout` | 123.92 MB | ≈ 118.17 MiB | **473%** | ❌ |
| **`PP-DocLayout-M`** | 22.578 MB | ≈ **21.53 MiB** | **86.1%（合规）** | ⚠️ **单文件合规，但只剩 3.47 MiB 余量**（路线图 已列 P1） |
| **`PP-DocLayout-S`（在用）** | 4.834 MB（ONNX 实测 4.69 MiB） | **4.69 MiB** | **18.8%** | ✅ 合规 |

**C. 本项目现状**（【本项目实测】，HANDOFF §5.11 与「今天后半程」表）

| 文件 | 字节 | MiB | 占 25 MiB |
|---|---|---|---|
| `ocr-models/detection/ort/PP-OCRv6_small_det.ort` | 9,982,352 | 9.52 | 38.1% |
| `ocr-models/recognition/ort/PP-OCRv6_small_rec.ort` | 21,290,816 | **20.30** | **81.2%** |
| `ocr-models/recognition/ppocrv6_dict.txt` | 74,948 | 0.07 | 0.3% |
| `ocr-models/layout/PP-DocLayout-S.onnx` | 4,917,852 | 4.69 | 18.8% |
| **合计** | **36,265,968** | **34.59** | — |

> ⭐ **两条必须记住的闸门**：
> 1. **单文件余量只剩 4.70 MiB**（25 − 20.30）。**任何往识别侧新增超过 4.70 MiB 的模型都会当场撞线。**
> 2. **真正的瓶颈不是单文件上限，而是"首次可用总下载量"** —— 同源 34.59 MiB + 运行期
>    `ort-wasm-simd-threaded.jsep.wasm` 27.00 MiB ≈ **61.6 MiB**。
>    **MinerU 的 `basic` 档是它的 12.4 倍。**

> ⚠️ **顺带记录一条口径漂移（本次只记录，未改代码）**：`FileUploadZone.tsx:110` 与 `:295`
> 的用户可见文案仍写「**约 30MB**」，而实际是 **34.59 MiB**；`ocrEngine.ts:313` 的启动日志
> 仍写「合计约 29.9MB」（未算版面模型）。HANDOFF §7 P2 已登记，**未修**。

---

## 五、许可与合规（**硬性**）

### 5.1 ⚠️ 首要更正：**MinerU 本体不是 AGPL-3.0**

任务书说「MinerU 本体是什么许可（AGPL-3.0？）」并据此要求分析 AGPL 的传染性后果。
**本次核实：这个前提是过期的。**

【已核实】`LICENSE.md`（HTTP 200，3,301 字节，**全文 base64 已解码逐字读过**）开头原文：

> "MinerU is licensed under **Apache License 2.0** and is subject to the additional terms below."

【已核实】`reference/changelog.md` 3.1.0（2026-04-18）原文：

> "**MinerU has officially moved from `AGPLv3` to the MinerU Open Source License, a custom license based on `Apache 2.0`.**"
> "This change significantly reduces adoption friction for both community users and commercial deployments."

**所以时间线是**：

| 版本 | 许可 |
|---|---|
| ≤ 3.0.x | **AGPLv3** |
| **≥ 3.1.0（2026-04-18）** | **MinerU Open Source License**（Apache-2.0 + 附加条款） |
| 4.0（当前） | 同上 |

**GitHub API 显示 `NOASSERTION` 是正常的** —— 它是自定义许可，GitHub 的 SPDX 分类器无法归类，
**不代表"许可不明"**。

### 5.2 MinerU 许可的附加条款（**逐字，因为这关系到公网部署**）

【已核实】`LICENSE.md` 全文四条 + 定义。**英文原文与中文原文均在文件内**，以下照录：

**条款 1 · 商业许可与门槛（Commercial License and Thresholds）**

> "MinerU may be used for commercial purposes without a separate commercial license. However, if you
> and your Affiliates, on a consolidated basis, meet either of the following thresholds, you must
> obtain a separate commercial license from [MinerU Team] before continuing such use:
> a. **monthly active users (MAU) exceed 100 million**; or
> b. **total monthly revenue exceeds USD 20 million**."

⚠️ **一处必须指出的差异**：该文件的中文版把同一门槛写作
**「月活跃用户数（MAU）超过 1 亿；或 月总收入超过 2000 万美金」**。
**两个语言版本的数值口径一致**（1 亿 MAU / 2000 万美金），**但英文原文是 "100 million" 而不是 "1 billion"**。
引用时须以英文原文为准，或直接引中文版，避免把 `million` / `billion` 传错一个数量级。

**条款 2 · 在线服务署名义务（Online Service Attribution Obligation）** ⭐ **这一条与公网部署直接相关**

> "**If you provide online services to third parties based on MinerU, you must clearly and prominently
> indicate, in the relevant product or service interface or in publicly available documentation,
> that MinerU is used.**"

**条款 3 · 终止（Termination）**

> 未按条款 1 取得商业许可即继续使用，或未履行条款 2 的署名义务，
> **本许可及据此授予的全部权利自动终止，且许可方无需另行通知。**

**条款 4 · 定义（Definitions）**：`Affiliates`（关联方，含控制/被控制/共同控制）、`Control`（控制权）。

**版权行**：`© 2026 [MinerU Team]`；Apache-2.0 全文见 `apache.org/licenses/LICENSE-2.0`。

### 5.3 「如果许可是 AGPL，直接复用其代码对本项目意味着什么」

**先回答假设本身**（因为任务书要求明确写出）：

**AGPL-3.0 的传染性对本项目意味着什么** —— 假设某组件确实是 AGPL：

1. **AGPL 的"网络条款"（§13）会触发**：AGPL 与 GPL 的关键区别是，
   **通过网络向用户提供服务（SaaS）也算"分发"**。本项目**部署在公网**，正是 §13 的靶心。
2. **后果**：若本项目**链接/打包**了 AGPL 代码或**其衍生作品**，
   则本项目**整体**需要以 AGPL-3.0 发布，**必须向所有使用者提供完整对应源码**
   （包括任何修改），且**不得附加更严格的条款**。
3. **对纯前端静态站点，这会双重发作**：
   - **源码本来就是"分发"的** —— 前端 bundle 会**原样送到每个访客的浏览器**，
     等于对全世界完成了 AGPL 意义上的分发；
   - **构建产物也要给** —— 必须能提供"用于生成该产物的完整源码 + 构建脚本"。
4. **与本项目定位的冲突**：AGPL 并不禁止商业使用，但会**传染整个代码库**。
   对一个"单人开发、可能想保留闭源/换许可空间"的项目，这是**不可逆的许可污染**。
5. **权重文件算不算？** —— **这是法律问题，不是技术偏好，我不做断言。**
   通行的谨慎做法是：**把模型权重视为受其自身许可约束的独立作品**，
   不套用代码许可的传染逻辑，**但也绝不假设"权重随便用"**。
   **凡是要引入任何第三方权重，先看该权重的许可页，而不是看它所在仓库的代码许可。**

**再回答真正的结论**：

| 组件 | 许可 | 对本项目的含义 |
|---|---|---|
| **MinerU 本体** | **Apache-2.0 + 附加条款**（**不是 AGPL**） | ⚠️ **「直接复用其代码」是允许的**（Apache-2.0 系），但：① 若本项目作为**在线服务**提供（**它是** —— 部署在公网），条款 2 要求**在界面或公开文档里清楚显著地标明使用了 MinerU**；② 一旦 MAU > 1 亿或月收入 > 2000 万美金，**需另购商业许可**（本项目远未到，但要知道存在这条线） |
| **`DocLayout-YOLO`** | ⚠️ **AGPL-3.0**（【已核实】） | ❌ **绝对不能碰**。它的代码/权重一旦进入本项目，**整个项目被拖入 AGPL 网络条款**。**这正是 MinerU 自己在 3.0.0 删掉它的原因** |
| **`layoutreader`** | ⚠️ **CC-BY-NC-SA 4.0**（**NC = 非商业**） | ❌ **不可用**。且是 **SA（相同方式共享）**，传染性同样存在。**MinerU 3.0.0 也把它删了** |
| **`PyMuPDF`**（本项目未用，但路线图提过） | ⚠️ AGPL-3.0 或商业双许可 | ❌ 同理。**MinerU 2.0.0 为此弃用它** |
| `PaddleOCR` / `PP-OCRv6` / `PP-DocLayout` / `PP-FormulaNet` | Apache-2.0（【未核实】本次未开 LICENSE 文件） | ✅ 宽松；本项目已在用 `PP-OCRv6` 与 `PP-DocLayout-S` |
| `UniMERNet` | **【未核实】**（GitHub 404） | ⚠️ **在许可未知前不得引入** —— 而且它 1530 MB，体积上本来就不可能 |

### 5.4 「借鉴设计」与「复用代码」是两个不同的法律行为（**这是本节的核心结论**）

> **版权保护的是"表达"，不是"思想、算法、方法"。**

因此对本项目而言：

| 行为 | 是否需要许可 | 说明 |
|---|---|---|
| 读 MinerU 的**文档**，知道它"用 tier 表达质量、绝不静默降级" | ❌ 不需要 | 这是**设计思想** |
| 读 MinerU 的**文档**，知道它的 JSON 用 `schema` + `schema_version` 双键识别 | ❌ 不需要 | 这是**接口设计思想** |
| 照 MinerU 的**错误码命名风格**自己起一套错误码 | ❌ 不需要 | 命名风格不受保护；**且不应照抄字符串，应自己定义** |
| 把 MinerU 的**代码文件**复制进本项目 | ✅ 需要（Apache-2.0 允许，**但要保留版权声明**） | 本项目**不需要这样做** |
| 把 `DocLayout-YOLO` 的**代码或权重**放进本项目 | ⚠️ **AGPL-3.0：会造成不可逆的许可污染** | ❌ **明确禁止** |

> ### ✅ 本文的所有 TODO **全部只借鉴"设计"，不引入任何 MinerU 代码或权重**。
> 因此**不产生任何许可义务，也不需要在界面上署名 MinerU**。
> 唯一会改变这一点的做法是"真的把 MinerU 的代码搬进来" —— **本文不推荐，也不需要**。

### 5.5 落地建议（合规侧，**不改代码**）

1. **不要**因为"MinerU 现在是 Apache-2.0 了"就放松对 `DocLayout-YOLO`（AGPL）/ `layoutreader`（NC）的警惕 ——
   **它们是独立作品，各有各的许可**。
2. 若将来要引入任何第三方模型，**在动代码之前先打开它的许可页**，并把结论写进
   `HANDOFF.md` 的「已拍板决定」表。本项目**已经为"把过期信息当现状"付过四次学费**（路线图 〇 节）。
3. 本项目的**三条外发路径**（`formulaOcrEnabled` / `cloudTranslationConsent` / `ttsCloudConsent`）
   与 MinerU 的 `--remote` **是同一个设计**：**默认本地、外发必须显式**。
   MinerU 的 `usage/model_source/` 把三者列成一张"不可互换"的表并各自独立配置 ——
   **这个"外发路径必须在文档里并列成表"的做法，可以借来加固本项目的 `outboundPaths.ts` 文档**（纯文档改动）。

---

## 六、可借鉴清单 → TODO list

> **排序依据** = 用户可感知收益 ÷ 实现风险，**与路线图 第三节同一套标准**。
> 每条给出：做什么 / 为什么值得 / 参照 MinerU 的哪个设计 / 要改哪里 / 体积与依赖影响 / 风险 / **验收标准** / 优先级。
>
> ⚠️ **不重复路线图**：路线图 已详述的条目这里**不复述**，只写
> 「印证了路线图的 X 条」并给出 **MinerU 侧的新证据**。**本节 7 条全部是 MinerU 带来的新增项。**

---

### T1 · 用**结构化错误码**替换"静默降级"，并为版面分析补一个可用性状态

**优先级：P0**

**做什么**

1. 在 `src/lib/layoutAnalysis.ts` 里，把 `analyzePageLayout()` 的失败原因**从 `null` 变成可查询的状态**。
   【本项目实测，已逐个核对行号】该文件共 **13 处 `return null`**，其中
   **`analyzePageLayout()` 占 7 处**：`:696`（坐标越界放弃）、`:736`（功能开关关闭）、
   `:740`（页面尺寸非法）、`:744`（会话/模型建不起来）、`:791`（输出张量缺失）、
   `:801`（本页没检测出区域）、`:813`（推理异常兜底）。
   另外 **6 处在 `detectColumns()`**（`:535 :540 :546 :547 :564 :568`，多栏检测的保守放弃，
   ⚠️ **那 6 处多数是"合理放弃"而非故障，不要一起改**）。
   ⚠️ **问题正在于**：这七种原因**对上层完全不可区分** —— 调用方只看到 `null`。
2. 定义一套**本项目自己的**错误/状态码（**不要照抄 MinerU 的字符串**，用本项目语境命名），例如：
   - `layout_disabled`（`VITE_OCR_LAYOUT=0`）
   - `layout_model_unavailable`（模型没取到）
   - `layout_inference_failed`（会话/推理失败）
   - `layout_output_invalid`（坐标越界，已按 §5.11.4 整体放弃）
   - `layout_no_regions`（本页没检测出区域 —— 这是**正常**情况，不该与故障同号）
3. 把「**这一页的阅读顺序/页眉页脚判定，究竟走了版面模型还是几何启发式**」变成一个**可见字段**
   （新增到 `ocrStructure` 导出里，与 `charBoxSkips` 同一层）。
4. ⚠️ **不要顺手改判据**。本 T 只做"让状态可见"，**逐字节回退不变量必须保住**。

**为什么值得**

- 这是 MinerU **最成熟、最便宜、且本项目最缺**的一环。
  【已核实】`README.md` 的 Agent 契约里有一张**错误码表**（`quality_tier_unavailable` / `no_engine` /
  `parse_server_unavailable` / `parse_timeout` / `remote_not_allowed` …），每个码都配
  「含义 + 下一步动作」，并明确要求「**按 `error.code` 分支，不要按 `message` 里的散文分支**」。
- **它直击本项目一个已登记的严重缺口**：HANDOFF §5.11.7 明文写
  「**版面模型从未跑过真实推理**」，而 §5.11.5 写「任何失败都返回 `null`」。
  两者叠加的后果是：**用户看到"页眉被多滤掉一行"时，无法判断那是版面模型干的、还是几何启发式干的**
  （HANDOFF §7 P0 已把这个组件列为「等于把一个未验证的组件放进了正文链路」，难度**高**）。
  **这个 TODO 不提升精度，但它让"精度问题可被观测"** —— 与路线图 第 1 位
  「只导出数据，不改判据」**是同一条元方法论的第五次应用**。
- ⚠️ **与路线图的关系**：路线图 P1-1「让版面的剔除决策变得可审计」已经提出**导出被丢弃的家具文本**。
  本 T **不重复它** —— 本 T 补的是**它没覆盖的另一半**：**"版面模型到底有没有在工作"这个可用性状态**。
  路线图那条回答"它丢了什么"，本 T 回答"**它还在不在**"。**两条必须一起做才有用**：
  只有前者，无法区分"模型说这不是页眉"与"模型压根没跑"。
- **零体积、零依赖、零联网。**

**参照 MinerU 的哪个设计**

- `README.md` 的 **JSON 错误契约**：`error.code` / `error.retryable` / `error.user_action` 三件套；
- `usage/tiers/` 的 **"不可用时上报而不是静默降级"** 原则：
  原文「it returns `quality_tier_unavailable` **rather than silently choosing Flash or uploading**」；
- `mineru server status --json` / `/v1/tiers` —— **把"哪些能力当前可用"做成一等查询接口**。

**本项目要改哪里**

| 文件 | 改动性质 |
|---|---|
| `src/lib/layoutAnalysis.ts` | 把 6 处 `return null` 改为记录原因；新增导出查询函数（如 `getLayoutStatus()`） |
| `src/lib/ocrStructure.ts` | 导出里新增版面可用性字段（纯增量，与 `charBoxSkips` 同层） |
| `src/lib/ocrPostProcess.ts` | `applyLayoutToLines()` 的调用点记录"本页是否用到版面信息" |
| `src/lib/layoutAnalysis.test.ts` | 为每个失败原因补用例（**只断言状态，不断言判据**） |
| `src/lib/ocrPostProcess.layout.test.ts` | ⭐ **第一组"逐字节回退不变量"用例必须继续通过**（这是安全网） |

**体积与依赖影响**

- **体积 +0 字节、依赖 +0、联网 +0。** 纯字段与状态机。
- 唯一影响是**导出 JSON 轻微变大**：`ocrStructure.ts` 头注释已说明它刻意控制体积，
  本 T 新增的是**每页一个枚举值 + 至多一条原因**，可忽略。

**风险**

- **低。** 纯增量观测，不改判据。
- ⚠️ **唯一真实风险**：实现时"顺手"把 `null` 的语义改了，导致回退路径行为变化。
  **必须用现有的逐字节回退不变量用例兜住**（HANDOFF §5.11.5 第 2 条）。
- ⚠️ **第二条风险**：新增状态**不能在正常路径上误报**。
  `layout_no_regions`（本页没区域）在真实扫描件上可能是**常态**，它**不是故障**。

**验收标准**

1. 一份真实扫描件的 `ocrStructure` 导出里，**每一页**都能读到
   「本页阅读顺序/页眉页脚判定：用了版面模型 / 退回了几何启发式 / 功能被关闭」三者之一；
2. 把 `VITE_OCR_LAYOUT=0` 关掉再跑一次，导出里的状态**必须变成"功能被关闭"**
   （而不是继续显示"用了模型"）—— **这是对状态真实性的负向测试**；
3. 人为删掉 `public/ocr-models/layout/PP-DocLayout-S.onnx` 再跑（`verify-dist` 会拦构建，
   所以用运行时 URL 覆盖到一个不存在的地址来构造），状态**必须是 `layout_model_unavailable`**，
   **且最终输出与删模型前逐字节相同**；
4. ⚠️ **并且**：能出示「关掉模型前后，正文输出逐字节相同」这一份**独立证据**（不是"测试变绿了"）。

---

### T2 · 把「版面模型精度从未评估」变成**可发版的指标**，并明确"降级不静默"

**优先级：P1**

**做什么**

1. **先只做测量，不做决策**：在现有 `scripts/inspect-pdf.mjs` 的指标风格上，新增一个
   **版面模型的离线评估脚本**（Node，跑在既有的 Node 测试环境里，**不进浏览器**），
   输入：若干页真值（人工标注的 region 类别 + bbox），输出：**逐类别的 precision / recall**。
2. ⭐ **逐类别**，不要只报 mAP。理由：本项目的用户可见缺陷集中在**两个类别** ——
   `header` / `footer`（页眉页脚）与 `text`（正文是否被误删）。
   **mAP 会把"页脚全漏"平均掉**（路线图 附录 A 已提出这一点，本 T 给的是**执行形态**）。
3. 把评估结果写进 `HANDOFF.md` 的**版本记录**，作为"这一版版面模型是否可发"的判据。

**为什么值得**

- MinerU **每次发版都报分**，并且**报的是有名字的公开基准**（OmniDocBench v1.6 / v1.5）。
  【已核实】changelog：3.0.0「`pipeline` backend achieves a score of **86.2** on OmniDocBench (v1.5)」；
  3.4「OCR accuracy by about **11%** on OmniDocBench v1.6」；3.3「on OmniDocBench v1.6,
  `medium` reduces overall accuracy by only **0.13** points compared with `high`」。
  **这是一个可复制的纪律：模型换了就必须报分，而分数必须挂在有名字的基准上。**
- **本项目的对照面是空白的**：HANDOFF §5.11.7 与路线图 附录 A §1.1 都记着
  「**从未在真实数据上评估过精度**」，唯一证据是一条"日志显示它多滤掉一行页脚"【用户导出】。
- ⚠️ **与路线图的关系**：**这印证了路线图 附录 A §四·P1-3「给版面模型做一次真实评估」。**
  MinerU 侧的**新证据**是：① 一个同量级项目**把"发版报分"制度化了**（说明这个成本是值得付的）；
  ② MinerU 的分数**明确标注了基准版本**（v1.5 / v1.6）—— 而路线图 自己也发现官方 mAP
  有 1300/1000/500 张三套评测集口径，**"跨口径比较 mAP 是错的"**。
  **MinerU 的做法为"必须连基准一起引用"提供了同行先例。**
  ⚠️ **本 T 不重复路线图 已写的标注方法论，只补"发版门禁"这一层。**

**参照 MinerU 的哪个设计**

- changelog 的**发版即报分**惯例（每次 release note 都带基准分与增量）；
- `usage/tiers/` 的 **"质量档位是用户可见契约"** 这一视角 ——
  **分数不是内部指标，是"这一档能给你什么"的对外承诺**。

**本项目要改哪里**

| 文件 | 改动性质 |
|---|---|
| **新增** `scripts/eval-layout.mjs` | 离线评估脚本（Node） |
| **新增** `scripts/__fixtures__/layout-truth/*.json` | 人工标注的真值（COCO 风格，类别名映射 `LAYOUT_LABELS`） |
| `HANDOFF.md` | 新增一节记录评估结果与基准口径 |
| `package.json` | 新增一个 `npm run eval:layout` script —— ⚠️ **这不是新依赖** |

**体积与依赖影响**

- **产物体积 +0、运行时依赖 +0。**
- 标注重量：**建议只标 20–30 页**（覆盖用户的两类痛点文档：中文扫描习题 + 教材），
  **不要追求 DocLayNet 那种 8 万页规模**（路线图 已说明 DocLayNet 的版面是论文类，
  与本项目痛点文档不匹配）。
- ⚠️ **真值文件不要进 `public/`**（不进产物），放 `scripts/` 或 `private/`。

**风险**

- **中。** 风险不在代码，在**标注质量**：单人标注会有系统性偏差。
  **缓解**：每个类别至少 2 页，且**先标"必须拒绝的名单"（绝不能丢的正文）**，
  再标"可以丢的名单"（页眉页脚）—— 这与路线图 R10 第 3 步的"两份名单求交集"是**同一种防错手法**。
- ⚠️ **明确不做**：**不要为了报分而调阈值**。本 T 的第一个版本**只测量**。

**验收标准**

1. `npm run eval:layout` 能在本机跑出**逐类别 precision / recall 表**，且**不联网、不建浏览器会话**；
2. 表里**明确标注评测集规模与来源**（多少页、什么文档、谁标的）；
3. ⚠️ **负向测试**：把版面模型的预测结果人为打乱（例如把所有 `header` 改成 `text`），
   **`header` 的 recall 必须掉到接近 0** —— 证明这个脚本真的在测量，不是装饰
   （沿用本项目 `verify-dist.mjs` 的负向测试纪律）；
4. 结论写进 `HANDOFF.md`，并**明确标注哪些结论是"本次实测"、哪些是"未验证"**。

---

### T3 · 「降采样判版面 + 原生分辨率识别」：把版面结果**用足**（从只用两类到用全类别）

**优先级：P1**

**做什么**

1. 现状盘点（**只读，先搞清楚差距**）：`layoutAnalysis.ts` 导出了
   `FURNITURE_LABELS`（页面家具）与 `CONTENT_LABELS`（内容类），但
   **`applyLayoutToLines()` 只把结果用于两件事**：页眉页脚剔除 + 阅读顺序
   （HANDOFF §5.11.5 明文：「**只接了页眉页脚 + 阅读顺序**」，另外两个痛点
   「公式行被误判成大标题」与「跨行大括号错误合并」**没有动**）。
2. **把 `formula` / `paragraph_title` / `text` 这几个已检测出来但被忽略的类别接进判据**：
   - `formula` 区域 → 直接**免于**"字号 > 中位数 1.3 倍即判大标题"那条几何启发式
     （这正是 HANDOFF §5.11.1 表里记的"三行公式被误判成大标题"）；
   - `paragraph_title` → 作为标题判定的**正向证据**，替代纯字号阈值。
3. ⚠️ **必须保留逐字节回退不变量**，且**每个新判据都要有"模型缺席时行为不变"的用例**。

**为什么值得**

- ⭐ **MinerU 的整篇 2.5 论文就是围绕这个想法写的**。【已核实，arXiv:2509.22186 摘要原文】：
  > "employs a **coarse-to-fine, two-stage** parsing strategy that **decouples global layout
  > analysis from local content recognition**. In the first stage, the model performs efficient
  > **layout analysis on downsampled images** ... In the second stage, **guided by the global layout**,
  > it performs **targeted content recognition on native-resolution crops**."
- **本项目的 `PP-DocLayout-S` 已经是"降采样判版面"那一步**
  （【本项目实测】`LAYOUT_INPUT_SIZE = 480`，`keep_ratio: false` 拉伸到 480×480）。
  **缺的是第二步的"guided by"** —— 现在版面结果**只被当成两个布尔开关用**，
  **23 个类别里的大部分信息被丢掉了**。
- **这是"零新模型、零新依赖、零体积"就能拿到的精度提升**：模型**已经在下载了**
  （4.69 MiB，第一次 OCR 就会拉），只是**它的输出没被用足**。
- ⚠️ **与路线图的关系**：路线图 P1-1 提议**导出**被丢弃的家具（观测），
  HANDOFF §5.11.5 说另两个痛点"没动"（**因为改判据回归风险大**）。
  **本 T 是那条"没动"的路，但换了一个更安全的入口**：
  不改几何阈值，而是**用模型已有的类别去否决几何启发式的误判**。
  ⚠️ **这仍然是"改判据"，回归风险不小** —— 所以**必须排在 T1、T2 之后**
  （先有可观测性和评估，再动判据）。

**参照 MinerU 的哪个设计**

- **两阶段解耦**（arXiv:2509.22186）：全局版面分析 → **以其为引导**做局部识别。
  本项目要借鉴的是**"版面结果是引导信号，不是一个布尔标签"**这个用法。
- ⚠️ **不要照抄 MinerU 的模型**。它用的是 VLM（1.2B）做第二阶段；
  本项目要用的是**已有的 `PP-DocLayout-S` 类别 + 已有的几何**。

**本项目要改哪里**

| 文件 | 改动性质 |
|---|---|
| `src/lib/layoutAnalysis.ts` | 可能需要新增"给一个行/词找它落在哪个类别区域"的查询（`regionForWord()` 已存在，**可复用**） |
| `src/lib/ocrPostProcess.ts` | 标题判定与公式行判定的入口处，接入版面类别作为否决/确认信号 |
| `src/lib/ocrPostProcess.layout.test.ts` | ⭐ 为**每条新判据**补"模型缺席时逐字节不变"用例 |
| `src/lib/ocrPostProcess.ts` 的 `CHAR_SCRIPT_ENABLED` 旁的开关 | 考虑新增独立的逃生开关（如 `VITE_OCR_LAYOUT_TITLES=0`） |

**体积与依赖影响**

- **体积 +0、依赖 +0、联网 +0**（模型已在下载清单里）。
- ⚠️ **但要注意 `PP-DocLayout-S` 的 mAP 只有 70.9**：用它的类别去**否决**几何启发式，
  相当于**把一部分判断权交给一个从未在本项目语料上评估过的模型**。
  **这就是为什么 T2 必须先做。**

**风险**

- **中高。** 这是**改判据**。历史证据：HANDOFF §5.11.5 明确记过「改判据回归风险大，
  不是能在跑不了测试的状态下顺手做的改动」。
  ⚠️ **缓解条件**：本机现在**能跑 vitest**（§〇 实测），所以那条限制**不再成立**；
  但"能跑测试"不等于"判得准"，**T2 的评估是硬前置**。
- **紧边**：`PP-DocLayout-S` 的 23 类里有 `formula_number`（公式编号）与 `seal`（印章），
  这两类**误判后果是"正文被吞"**，必须**先验证再接入**。

**验收标准**

1. 「三行公式被误判成大标题」这一条在**真实扫描件**上**不再复现**；
2. **正文丢失量不增加** —— 用 T2 的评估脚本量化「被 `layoutFurniture` 丢弃的文本里，
   有多少是真正文」，**改前改后各跑一次，必须不上升**；
3. `VITE_OCR_LAYOUT=0` 时输出与接入前**逐字节相同**（现有用例继续通过）；
4. ⚠️ **能出示**「本 T 新增的每一条判据，在模型缺席时都不会触发」的用例清单。

---

### T4 · ⭐ 把批注锚点升级为**"块内字符偏移"**，并给它一个稳定的定位符字符串

**优先级：P1**

**做什么**

1. **先读现状**：本项目批注锚点是**文本匹配三级降级**
   （HANDOFF §4.1「批注锚点三级降级定位」有 14 个用例）。
   ⚠️ **本 T 不改存储格式、不做迁移**（那是破坏性改动）。
2. **新增一个稳定的定位符字符串**，与批注并列存储（**纯增量**），形态参考
   `doc:{id}/page:{n}/block:{m}/char:{offset}`，但**用本项目自己的语义**：
   - `doc:{documentId}` —— 本项目已有 `documents` 表主键；
   - `page:{pageIdx}` —— ⚠️ **必须明确 0-based 还是 1-based 并写进注释**；
     MinerU 专门为"JSON 里 0-based、CLI 里 1-based"这个不对称留了一段说明【已核实】；
   - `block:{blockIdx}` —— `ContentBlock` 的序号；
   - `char:{offset}` —— 块内字符偏移（0-based）。
3. **让定位符同时承担"引用"与"回跳"两个用途**：这是 MinerU 的 `doc:.../page:4/block:7`
   在 CLI 里被直接当参数用的能力【已核实】。

**为什么值得**

- **MinerU 4.0 把这个做成了产品的骨架**。【已核实】`README.md` 的 5 级 locator
  与「stable citation locators」定位；并且明文要求 Agent
  「**不要从解析内容里剥掉 locator 字段，续读与引用都要用它**」。
- **本项目有真实缺口**：HANDOFF §7 记着批注锚点**依赖文本匹配**，
  而路线图 附录 A §2.5 记着「本项目的批注锚点是文本匹配（【HANDOFF】缺陷 6：
  『批注锚点在段首误命中 —— `indexOf('')` 恒为 0』）」。
  文本匹配的固有弱点是：**重排、OCR 结果变动、同一段出现两次时都会漂**。
- ⭐ **本项目恰好具备做这件事的全部原料**：`ocrCharBoxes.ts` 已经产出了
  **字符级坐标**（`chars[]`，含 `bbox` / `confidence`），
  而 MinerU 的 `char:{offset}` **要的就是"块内第 N 个字符"这个位置**。
  **这是"已有的量换个用法"，不是新功能。**
- ⚠️ **与路线图的关系**：**路线图 没有这一条。** 路线图 的 P0-1 是"把机制 5 的比值导出"、
  P1-1 是"版面剔除可审计"，**都没有触及批注锚点**。这是 MinerU 带来的**新增项**。

**参照 MinerU 的哪个设计**

- 5 级 locator 协议（`doc` → `tier` → `page` → `block` → `char`）；
- 明文规则「页码块号 1-based、字符 offset 0-based 且在块文本内」——
  **照抄它的"把 base 写清楚"这个纪律**，但**自己定 base**（本项目可以全用 0-based，
  只要写清楚且一致）。

**本项目要改哪里**

| 文件 | 改动性质 |
|---|---|
| `src/types/content.ts` | `ContentBlock` 可能需要一个稳定序号（若没有） |
| `src/lib/annotations.ts` | 新增定位符的**构造**与**解析**两个纯函数 |
| `src/store/annotationsStore.ts` | 批注记录里**新增一个可选字段**（纯增量，**不改现有字段**） |
| `src/lib/annotations.test.ts` | 为构造/解析补往返（round-trip）用例 |
| `src/lib/db.ts` | ⚠️ Dexie **新增字段**需要注意：Dexie 是 schemaless 的，新增可选字段**不需要迁移**，但要确认现有查询不受影响 |

**体积与依赖影响**

- **体积 +0 字节、依赖 +0、联网 +0。** 纯字符串与纯函数。
- 存储影响：每条批注多一个短字符串（典型 < 40 字节）。

**风险**

- **低–中。**
- ⚠️ **风险 1：不要做破坏性迁移。** 本 T **只新增字段**，
  现有批注继续走文本匹配；新字段作为**更强的锚点**在可用时优先使用。
  **一旦把旧字段删掉，历史批注就全丢了。**
- ⚠️ **风险 2：`pageIdx` 的 base 必须写死在注释和测试里。**
  MinerU 专门为这个不对称写了说明，说明**它真的会出错**。
- ⚠️ **风险 3：块序号必须在内容模型变动后保持稳定。**
  若 `ContentBlock` 的顺序会因重新解析而变，定位符就会漂 ——
  **缓解**：把定位符与 `buildId` 或文档内容哈希绑定，**不匹配时明确降级到文本匹配**
  （而不是错误地跳到别处）。

**验收标准**

1. 对同一份文档，`构建 → 解析 → 得到同一字符串`（round-trip 用例）；
2. ⚠️ **负向用例**：把文档内容改动一个字符后，定位符**要么仍命中同一位置，要么明确报告"锚点失效"**，
   **绝不静默跳到错误位置** —— 这与本项目已确立的原则
   「**错的坐标比没有坐标更糟**」（HANDOFF R10「不要做」）**是同一条**；
3. 现有 14 个批注锚点用例**全部继续通过**（不改变旧路径行为）；
4. 真实文档上：一段**重复出现两次**的文字，两条批注**能各自锚到正确的那一处**
   （这是文本匹配做不到、而定位符能做到的**判别性测试**）。

---

### T5 · 导出/持久化契约：**schema 双键 + 生产版本 + 档位 + 完整性标记**，并明文「改版本号 ≠ 迁移」

**优先级：P1**

**做什么**

1. 给 `ocrStructure` 导出**加三个字段**（纯增量）：
   - `schema` / `schemaVersion` —— ⭐ **两个键都要有**，且**只在导出里出现**；
   - `producer`（名字 + 版本）—— ⚠️ **生产版本只放一处**，不要在多处重复（MinerU 明文规定
     「The producing version is `metadata.producer.version`, **not a duplicate product extension field**」）；
   - `isFullDocument` —— 标记这份导出是否覆盖全文（MinerU 的 `is_full_document`）。
2. **在 `ocrStructure.ts` 的头注释里写死一条规则**：
   > 「**读取本导出时，必须用 `schema` + `schemaVersion` 两个键联合判定格式，
   > 不得只看 `schemaVersion` 的数字。**」
   并把这条规则**变成一个测试**。
3. **明文写下"改版本号不等于迁移"**：在 `HANDOFF.md` 的增加一条治理规则。

**为什么值得**

- ⭐ **MinerU 在这一点上踩过坑并把它写进了契约**。【已核实】`reference/output_files/` 原文：
  - 「JSON consumers identify the payload through the **serialized `schema` and `schema_version` keys**」
  - ⚠️ 「**Do not identify a document type from its version number alone.**」
  - ⚠️ 「The schema identity is named `schema_id` as a **Python attribute**, but it **serializes as `schema`**」
- ⭐⭐ **`reference/migration_4/` 有一句几乎是为本项目写的**：
  > 「"**Can be read**" (Doclib cache), "**migrated automatically**" (**nothing rewrites files**),
  > and "**can re-export every format**" (requires current assets and geometry) are **separate claims**;
  > **treat them independently instead of inferring one from another.**」
  以及：「**changing a version number alone does not migrate a payload.**」
- **本项目有直接对应物且已经有价值**：`ocrStructure.buildId`
  （【本项目实测】`ocrStructure.ts:188 / :521`）在 HANDOFF §5.12.7 与 §5.13.6 里
  被反复当作"**这一版是不是你要的那一版**"的判据 —— 它**已经在承担 MinerU `producer.version`
  的职责，只是没有名字、没有版本、没有契约**。
- **成本几乎为零**：三个字段 + 一段注释 + 两个用例。
- ⚠️ **与路线图的关系**：**路线图 没有这一条。** 这是 **MinerU 侧的新增项**。
  路线图 P0-1 关注的是"把某个量导出"，本 T 关注的是"**导出物自身的格式契约**"。

**参照 MinerU 的哪个设计**

- `docvortex.middle` 的 `schema` / `schema_version` / `metadata.producer.version` /
  `extensions.mineru.tier` / `is_full_document` 五个字段的组合；
- `reference/migration_4/` 的**三种主张必须独立对待**这条治理原则。

**本项目要改哪里**

| 文件 | 改动性质 |
|---|---|
| `src/lib/ocrStructure.ts` | 新增 `schema` / `schemaVersion` / `producer` / `isFullDocument` 字段 + 头注释写契约 |
| `src/lib/ocrStructure.test.ts` | 新增"双键联合判定"用例 + "只改版本号不改 schema ⇒ 视为未知格式"的负向用例 |
| `src/lib/sessionDiagnostics.ts` | 若也产出可持久化结构，同一套字段应对齐 |
| `HANDOFF.md` | 新增治理规则条目 |

**体积与依赖影响**

- **体积 +0、依赖 +0、联网 +0。** 四个短字段。
- ⚠️ **导出体积**：`ocrStructure.ts` 刻意控制体积，四个短字段可忽略。

**风险**

- **极低。** 纯增量。
- ⚠️ **唯一风险**：`schemaVersion` 与 `buildId` **职责重叠**导致两者漂移。
  **缓解**：明确定义 —— `buildId` 是**构建标识**（回答"你拿到的是哪一版代码"），
  `schemaVersion` 是**格式标识**（回答"这份 JSON 该怎么读"），
  `producer.version` 是**生产程序版本**。**三者语义不同，都要保留，但只在文档里各出现一次。**

**验收标准**

1. 一份新的导出同时含 `schema`、`schemaVersion`、`producer`、`isFullDocument`；
2. ⚠️ **负向用例**：构造一份「`schemaVersion` 相同但 `schema` 不同」的载荷，
   读取方**必须拒绝**（而不是"按版本号猜着读"）；
3. `HANDOFF.md` 里能查到"改版本号不等于迁移 / 三种主张独立"这条规则；
4. 现有 `ocrStructure` 用例全部继续通过（旧导出仍可读）。

---

### T6 · 长文档：**滑动窗口 + 流式落盘**，并把"缓存 × 档位"作为显式维度

**优先级：P2**

**做什么**

1. **现状**：本项目已有 `OCR_CHECKPOINT_EVERY_PAGES = 5`、末页必落
   （HANDOFF §5.9，「最多丢 5 页」）。
2. **新增一件**：把"**这份 OCR 结果是在什么条件下产出的**"记进库
   （版面模型是否参与、是否走了 Tesseract 第二意见、`buildId`），
   使**同一文档在不同条件下有不同缓存条目**，而不是互相覆盖。
3. **滑动窗口**：本次**只做调研与设计**（记录 MinerU 的做法），**不实现**。

**为什么值得**

- ⭐ 【已核实】changelog 3.0.0 原文：MinerU 用**滑动窗口**把长文档峰值内存降下来，
  使「documents with **tens of thousands of pages** no longer need to be split manually」，
  并且批量推理**支持流式落盘**（"streaming writes to disk, allowing completed parsing results
  to be written out in time"）。
- ⭐ **这印证了路线图 / HANDOFF 已经拍板的方向**：
  HANDOFF §1「不要做」表里写着「**把 OCR 结果继续只留在内存里、等最后一页跑完才写库**
  —— 中途落盘（检查点）**不是优化，是保障措施**」。
  **MinerU 侧的"新证据"**：一个有数万页处理经验的同量级项目，
  把同一件事做成了**框架级特性**并写进发版说明（说明它确实是长文档场景的关键工程点，不是本项目的过度设计）。
  ⚠️ **本 T 不复述 HANDOFF 已拍板的结论**，只补 **MinerU 的独立印证**。
- ⭐ **"缓存 × 档位"这个维度**：【已核实】`usage/tiers/` 原文
  「Library `read` consumes cached results ... Without an explicit tier, it prefers cached
  **Advanced, Standard, then Basic** results」；且 `mineru parse` 按 **(文档, 档位)** 缓存。
  **本项目现在没有这个维度** —— 一旦接入 T3（版面类别参与判据），
  "同一份扫描件在版面模型可用/不可用下产出不同结果"就会**真实发生**，
  而现在的库里**分不开这两份结果**。

**参照 MinerU 的哪个设计**

- `--force` / `invalidate` 的**语义分离**（【已核实】"`--force` skips done cache for this request
  but does **not** invalidate or delete old results"）；
- **按 (文档, 档位) 缓存**；
- **滑动窗口 + 流式落盘**。

**本项目要改哪里**

| 文件 | 改动性质 |
|---|---|
| `src/lib/db.ts` | 若无现成字段，OCR 结果记录新增"产出条件"字段（纯增量） |
| `src/lib/ocrCheckpoint.ts` | 检查点应携带产出条件 |
| `src/lib/libraryStore.ts` | 读取时按条件选择最新/最完整的一份 |
| `src/lib/ocrCheckpoint.test.ts` | 补用例 |

**体积与依赖影响**

- **体积 +0、依赖 +0、联网 +0。**
- ⚠️ **存储影响**：同一文档可能存**多份** OCR 结果。
  **缓解**：只在**产出条件真的不同**时才新增条目；相同条件覆盖。
  并在设置里给出"清理旧结果"的入口（**不在本 T 范围**）。

**风险**

- **中。** 触及持久化层与读取路径，而 `db.ts` **当前无单元测试覆盖**
  （HANDOFF §8 R6 已登记）。
- ⚠️ **前置**：**先为 `db.ts` 补测试**（R6 里的既有条目），再做本 T。
- ⚠️ **滑动窗口部分明确不实现**：本项目的瓶颈不是内存（单线程 WASM、逐页处理），
  而是"首次下载"与"每页耗时"。**照抄滑动窗口是无效优化。**

**验收标准**

1. 同一文档在「版面模型可用」与「不可用」两种条件下产出的结果，
   在库里**能分别读出、能区分**，且**不会互相覆盖**；
2. 读取路径有明确的选择规则，且**规则有测试**；
3. ⚠️ **并且**：能在导出里看到"这份结果是哪一份"（与 T5 的 `producer` 字段对齐）。

---

### T7 · 把「隐私声明 = 排除清单」的写法借到本项目的隐私文案上

**优先级：P2**

**做什么**

1. 本项目已有机器可读的外发清单 `src/lib/outboundPaths.ts`（【已核实，HANDOFF §1】
   它同时被设置面板渲染、被 `outboundPrivacy.test.ts` 断言）。
2. **新增一件事**：把"**什么绝不会外发**"也写成**同样可测的清单**
   （当前只有"什么会外发"），例如：文档正文、页面图像、识别文本、批注、文件名、
   文件路径、搜索词、书库列表。
3. 让这两个清单**都由同一处常量驱动**，并被测试断言（与现有做法一致）。

**为什么值得**

- ⭐ MinerU 的遥测声明是**用"排除清单"写的**。【已核实】`README.md` 原文：
  > "Telemetry does **not** collect **document contents, extracted text or images, file names,
  > file paths, search queries, prompts, snippets, API keys, usernames, hostnames,
  > raw tracebacks, or exact hardware identifiers**."
  并且给了 `telemetry status / enable / disable / preview / flush` **五个可操作命令**，
  还说明了「**禁用同时停止新的聚合并清除未发送的本地遥测数据**」。
- **本项目的承诺比 MinerU 强得多**（零遥测），但**表述强度不如它**：
  本项目的"文档全程不离开浏览器"是一句**散文承诺**；
  MinerU 的排除清单是一份**可逐项核对的清单**。
- ⚠️ **这是纯文案 + 常量重构，零技术风险**，但它**保护的是本项目最核心的卖点**（C3 隐私）。
- ⚠️ **与路线图的关系**：路线图 §2.2 已提出「把 `formulaOcrEnabled` 的四要素**推广成不变量**」，
  那条**已经拍板并落地**（HANDOFF §1「本轮三项决定」）。
  **本 T 不重复它** —— 本 T 补的是**表述形态**：从"三条会外发的路径"扩成
  "三条会外发 + 一份绝不外发的排除清单"，**两者都机器可读**。

**参照 MinerU 的哪个设计**

- 遥测的**排除清单**写法（逐项枚举"不收集什么"）；
- **可操作的控制命令**（status / preview / disable）——
  本项目对应的是"**用户能在设置里看到并验证清单**"。

**本项目要改哪里**

| 文件 | 改动性质 |
|---|---|
| `src/lib/outboundPaths.ts` | 新增"绝不外发"清单常量（**与现有外发清单并列**） |
| `src/store/outboundPrivacy.test.ts` | 新增断言：排除清单里的每一项都**没有任何代码路径**会外发它 |
| 设置面板组件 | 渲染排除清单（**只加展示，不加开关**） |
| `vite.config.ts` 的 manifest | ⚠️ 现有文案「文档全程留在本机浏览器，不上传服务器」**与代码事实已相符**
  （三条路径默认关闭），**本 T 只加固，不改口径** |

**体积与依赖影响**

- **体积影响可忽略**（几个字符串常量）。
- **依赖 +0、联网 +0。**

**风险**

- **低。**
- ⚠️ **唯一风险**：把排除清单写成**绝对化且无法验证**的承诺（例如"永不外发任何数据"），
  而实际上三条 opt-in 路径确实会外发。**缓解**：清单必须**逐项可被测试断言**，
  做不到断言的项**不要写**。这条纪律与 MinerU 的"三大主张独立对待"是同一个精神。

**验收标准**

1. 设置面板里能读到"绝不外发"的逐项清单；
2. ⚠️ **每一项都有对应断言**（不是装饰）；若某项无法断言，**从清单里删掉**；
3. 清单与外发清单**不重叠**（同一项不能既在"会外发"又在"绝不外发"里）——
   **这条要写成测试**；
4. 现有 `outboundPrivacy.test.ts` 用例全部继续通过。

---

## 七、明确不可借鉴的（含理由）

> **这一节和 §六 一样重要。** 下面每一条都给出**为什么不行**，
> 其中体积类的**都算过与 25 MiB 的关系**。

### 7.1 模型资产类（**体积否决，已算过**）

| 不可借鉴 | 体积 / 结论 | 理由 |
|---|---|---|
| **MinerU 的整个模型包**（`basic` / `standard` / `advanced`） | ~0.8 GB / ~2 GB / ~3 GB = 25 MiB 的 **30.5× / 76.3× / 114.4×** | **不是"超限多少倍"的问题，是路线冲突**：必须走外部 CDN 分发，而本项目对**离线可用（C2）**与 **local-first** 有硬承诺。**结论：整体不可引入，无论拆不拆。** |
| **`PP-FormulaNet-S`**（公式识别最小档） | **224 MB ≈ 213.62 MiB = 25 MiB 的 855%（8.5×）** | ❌ **不可同源发布**。要走 CDN → 与 local-first 冲突。<br>⚠️ **本次直接打开了 PaddleOCR 官方文档复核，224 MB 与任务书给的数字逐字相符。**<br>**所以「公式 OCR 模型在本项目约束下不可能」这个结论成立，且不需要再查第二次。** |
| **`PP-FormulaNet_plus-S` / `-L` / `UniMERNet`** | 248 MB（946%）/ 695 MB（2651%）/ **1530 MB（5837%）** | ❌ 同上，且更差。`UniMERNet` 的 **CPU 推理耗时 8288.07 ms/页**【已核实】—— **即便体积合规，速度也不现实**。 |
| **`PP-DocLayout-L` / `_plus-L` / `PP-DocBlockLayout`** | 123.76 MB（472%）/ 126.01 MB（481%）/ 123.92 MB（473%） | ❌ 全部超限近 5 倍。 |
| **VLM（`MinerU2.5-Pro-*`，1.2B 参数）** | 1.2B 参数级；`standard` 档要 8–16 GB 内存【已核实】 | ❌ **数量级不对**。本项目跑 `ort.env.wasm.numThreads = 1` 的单线程 WASM，**连它的一次前向传播都放不下**。 |
| **`SLANet` / `UNet` / 表格分类模型** | 【未核实】体积 | ⚠️ **未核实就不能进决策**。但即使合规，路线图 已说明「**不要引入表格结构识别模型**」—— 因为 `PP-DocLayout-M` 若要用就已占掉 25 MiB 的 86.1%，**没有余量再放表格模型**。 |

### 7.2 架构类（**与本项目硬约束直接冲突**）

| 不可借鉴 | 理由 |
|---|---|
| **`mineru-kit api-server`（FastAPI + uvicorn）** | ⚠️ **本项目是零后端（C1）**。引入任何常驻服务进程都与「Cloudflare Pages 静态托管 + 单人开发 + 运维复杂度接近零（C6）」正面冲突。 |
| **Gradio WebUI** | 同上。本项目已经有 React 19 前端，**再叠一个 Python WebUI 是纯负担**。 |
| **vLLM / LMDeploy / llama.cpp / MLX 后端** | 需要 GPU 或至少数 GB 内存；本项目的执行环境是浏览器 WASM。**没有交集。** |
| **`mineru server start` 那套本地常驻服务 + `config.yaml`** | 本项目**没有可写的服务端配置**。本项目的等价物是 `settingsStore`（Zustand persist）+ IndexedDB，**形态已经是对的**。 |
| **`--remote` 远程解析** | 本项目**已经有**默认关闭的云端公式路径（`formulaOcrEnabled` + SimpleTex），**且已拍板不改为默认开启**（HANDOFF §5.8「不要再翻案」）。**不需要再加一条外发路径。** |
| **MinerU 的遥测**（哪怕它声明不含文档内容） | 本项目**零遥测**是更强的承诺。**引入任何遥测都是承诺的降级**，不是改进。 |
| **`docvortex` 作为依赖** | ⚠️ **Python 包**，且本项目的解析层（`pdfParser.ts` / `markdownParser.ts` / `epubParser.ts`）**已经写了并测过**。引入它等于**把已有解析层推倒重来**，且**只能服务端跑**。 |

### 7.3 许可类（**法律否决，不是技术偏好**）

| 不可借鉴 | 许可 | 后果 |
|---|---|---|
| ⚠️ **`DocLayout-YOLO` 的代码或权重** | **AGPL-3.0**（【已核实】GitHub API） | ❌ **绝对不可**。AGPL §13 的网络条款会在**公网部署**这一场景下**传染整个项目**。<br>⭐ **最强的证据来自 MinerU 自己**：它在 **3.0.0 把 `doclayoutyolo` 与 `mfd_yolov8` 两个 AGPLv3 模型整个删掉**（【已核实】changelog 原文）。**一个 8 万星的项目为了商用都得删，本项目更不该碰。** |
| ⚠️ **`layoutreader` 的代码或权重** | **CC-BY-NC-SA 4.0**（【已核实】MinerU changelog 明文标注） | ❌ **NC = 非商业**，且 **SA = 相同方式共享**。**MinerU 3.0.0 也把它删了。** |
| ⚠️ **`PyMuPDF`** | AGPL-3.0 或商业双许可 | ❌ 同上。**MinerU 2.0.0 为此弃用它、改用 `pypdfium2`** —— 这是**同行的先例**。（本项目未用，此处仅作记录。） |
| ⚠️ **`UniMERNet`** | **【未核实】**（GitHub 404） | ❌ **在许可未知前不得引入**。且体积 1530 MB 已经否决掉了。 |
| ⚠️ **`TableStructureRec` / `RapidTable` / `StructTable-InternVL2-1B`** | **【未核实】** | ⚠️ 体积或许可均未核实 → **不进任何决策**。 |

### 7.4 功能类（**MinerU 能做而我们做不了 —— 这同样是结论**）

> ⚠️ 任务书要求「**"MinerU 能做而我们做不了"的部分要明说**」。以下是**诚实清单**：

| MinerU 的能力 | 本项目为什么做不到 | 有没有出路 |
|---|---|---|
| **公式 → LaTeX（本地、离线）** | 最小模型 **224 MB = 25 MiB 的 855%**。 | ❌ **没有本地出路**。**唯一可行路径是现有的几何启发式**（`ocrPiecewise.ts` / `ocrFormulaRecovery.ts` / `ocrInkRegions.ts`），以及**默认关闭的云端 SimpleTex**。**这是被体积硬约束掉的，不是没努力。** |
| **表格结构识别（→ HTML/Markdown 表格）** | 需要 `SLANet` + `UNet` + 表格分类三个模型；而 `PP-DocLayout-M` 若要用就已占 25 MiB 的 **86.1%**，**没有余量**。 | ⚠️ **本项目现状**：表格退化为普通文本（HANDOFF §7 P1）。**在纯前端 + 25 MiB 约束下，短期内无解。** 诚实地说：**这是本项目相对 MinerU 的一个真实、且短期无法弥补的能力差距。** |
| **双栏 / 多栏阅读顺序（高可靠）** | 官方给阅读顺序的 `PP-DocLayoutV2` 是 **203.8 MB = 25 MiB 的 814%**（路线图 已核实）。 | ⚠️ **纯几何路线（XY-Cut / `detectColumns()`）是唯一出路**，且**必须保守**（不确定时退回单栏）。路线图 R3 已登记。 |
| **手写体识别** | MinerU 有专门的手写优化（`PP-OCRv5_rec_server` / 1.8 万字典）。 | ⚠️ 本项目用的是 `PP-OCRv6_small`（21.29 MiB，已占 25 MiB 的 81.2%）。**换更大的识别模型没有余量。** |
| **109 种语言 / 竖排文本 / 日文版面** | `PP-DocLayout-S` 的 23 类里**没有竖排文本**（路线图 已核实，读 `LAYOUT_LABELS`）。 | ⚠️ **本项目定位是中文/英文教材与习题**，竖排不在场景内。**明确不做。** |
| **原生 Office / PPTX / XLSX / OFD / MHTML 解析** | MinerU 靠 `docvortex` 做原生解析。 | ⚠️ **本项目只要 md/txt/pdf/epub**。**明确不做**（不是能力不足，是**不在定位内**）。 |
| **跨页表格合并 / 图表解析 / 印章识别** | 依赖 VLM + 专用模型。 | ❌ **明确不做。** |

### 7.5 一条"看起来能借、其实不能"的

| 项 | 为什么不能借 |
|---|---|
| **照抄 MinerU 的错误码字符串**（`quality_tier_unavailable` 等） | ⚠️ **不是许可问题，是设计问题**：MinerU 的码服务于 **CLI/JSON 的机器消费者**；本项目的消费者是**浏览器里的人和本项目的 UI**。**照抄字符串会带来语义错配**（本项目没有 `tier` 这个概念）。<br>✅ **可以借的是"每个错误码配一个下一步动作"这个结构**，见 T1。 |

---

## 八、参考来源（URL）+ 哪些打不开

> **核实方式只有一种**：`web_fetch` 返回 HTTP 200 **且拿到正文**。
> 本机 PowerShell 的 `Invoke-WebRequest` / `Invoke-RestMethod` 被沙箱拒绝
> （报「Windows PowerShell 处于非交互模式」），**因此不能用它做佐证**。

### 8.1 ✅ 核实成功的 URL（共 21 条，全部 HTTP 200 且拿到正文）

**MinerU 仓库与许可证**

| # | URL | 取到了什么 |
|---|---|---|
| 1 | https://api.github.com/repos/opendatalab/MinerU | 仓库元数据：81,435 stars、Python、`NOASSERTION`、最后 push 时间 |
| 2 | https://api.github.com/repos/opendatalab/MinerU/contents/ | 仓库根目录清单（确认 `LICENSE.md` / `pyproject.toml` / `docs/` 等） |
| 3 | ⭐ https://api.github.com/repos/opendatalab/MinerU/contents/LICENSE.md | **许可全文**：Apache-2.0 + 4 条附加条款（MAU 1 亿 / 月收入 2000 万美金 / 在线服务署名 / 自动终止） |
| 4 | https://api.github.com/repos/opendatalab/MinerU/contents/pyproject.toml | 依赖树、Python 版本、extras、`LicenseRef-MinerU-Open-Source-License` |
| 5 | https://api.github.com/repos/opendatalab/MinerU/contents/README.md | 4.0 全貌：4 档位、9 输出、locator 协议、错误码表、模型下载量、隐私规则、遥测排除清单、许可声明 |
| 6 | https://api.github.com/repos/opendatalab/MinerU/contents/docs | `docs/` 目录结构（确认 `reference/`、`usage/`、`en/`、`zh/` 等） |
| 7 | https://api.github.com/repos/opendatalab/MinerU/contents/docs/en/reference | 确认**没有 `model_list.md`**（该文件在当前版本不存在） |
| 8 | ⭐ https://api.github.com/repos/opendatalab/MinerU/contents/docs/en/reference/changelog.md | **完整发版史**：3.1.0 许可从 AGPLv3 改成 Apache-2.0 系；3.0.0 移除两个 AGPLv3 模型与一个 CC-BY-NC-SA 模型；PP-OCRv6 / UniMERNet / RapidTable / StructTable 时间线 |
| 9 | https://api.github.com/repos/opendatalab/MinerU/contents/docs/en/usage/model_source.md?ref=mineru-3.4.5-released | 3.4.5 的模型源配置（**该页不含模型清单**，仅有来源与本地路径机制） |

**MinerU 官方文档站**

| # | URL | 取到了什么 |
|---|---|---|
| 10 | ⭐ https://opendatalab.github.io/MinerU/reference/output_files/ | **middle_json 的 `docvortex.middle` / protocol `2.0` 示例与全部契约规则**、9 种渲染目标、`structured_content` |
| 11 | ⭐ https://opendatalab.github.io/MinerU/reference/migration_4/ | 3.x→4.0 迁移：`pdf_info`/`_backend` 不再是模板、兼容性矩阵、"三种主张独立对待" |
| 12 | https://opendatalab.github.io/MinerU/usage/model_source/ | 三类远程连接对照、模型源、远程 VLM 字段 |
| 13 | ⭐ https://opendatalab.github.io/MinerU/usage/tiers/ | 4 档位语义、后端/引擎自动选择、`SLANet`/`UNet`/`MINERU_TABLE_DEVICE`、缓存优先级、内存建议 |
| 14 | https://opendatalab.github.io/MinerU/usage/compatibility/ | MinerU <4 的遗留平台边界（13 个平台、版本约束 `<4`） |
| 15 | https://opendatalab.github.io/MinerU/usage/advanced_cli_parameters/ | 引擎参数透传、`CUDA_VISIBLE_DEVICES`（**未含模型清单**） |
| 16 | https://opendatalab.github.io/MinerU/zh/usage/model_source/ | 中文版模型源配置（与 #12 内容对应） |

**第三方模型与论文**

| # | URL | 取到了什么 |
|---|---|---|
| 17 | ⭐ https://api.github.com/repos/opendatalab/DocLayout-YOLO | **`DocLayout-YOLO` 许可 = AGPL-3.0**、2,292 stars、论文标题 |
| 18 | https://github.com/opendatalab/DocLayout-YOLO | 仓库页可达（HTML 外壳，仅供确认可达性） |
| 19 | ⭐ https://www.paddleocr.ai/main/version3.x/module_usage/layout_detection.html | **版面模型官方表**：`PP-DocLayout_plus-L` 83.2/126.01 MB、`-L` 90.4/123.76 MB、`-M` 75.2/22.578 MB、`-S` 70.9/4.834 MB、`PP-DocBlockLayout` 95.9/123.92 MB；评测集 1300/1000/500 张 |
| 20 | ⭐ https://www.paddleocr.ai/main/version3.x/module_usage/formula_recognition.html | **公式模型官方表**：`UniMERNet` 85.91/43.50/**1530 MB**/CPU 8288.07 ms、`PP-FormulaNet-S` 87.00/45.71/**224 MB**、`plus-S` 88.71/53.32/248 MB、`-L` 90.36/45.78/695 MB |
| 21 | ⭐ https://arxiv.org/abs/2509.22186 | MinerU2.5 技术报告摘要：**1.2B 参数、两阶段解耦（降采样判版面 → 原生分辨率识别）** |

### 8.2 ❌ 打不开 / 拿不到正文的 URL（共 7 条）

| # | URL | 失败形态 | 对结论的影响 |
|---|---|---|---|
| 1 | `https://raw.githubusercontent.com/opendatalab/MinerU/master/LICENSE.md` | `fetch failed` | **无影响** —— 已用 GitHub API 的 `contents` 接口拿到同一文件全文（#3） |
| 2 | `https://raw.githubusercontent.com/opendatalab/MinerU/master/docs/en/reference/model_list.md` | `fetch failed` | **无影响** —— 先确认了**该文件在当前版本不存在**（见 8.1 #7） |
| 3 | `https://raw.githubusercontent.com/opendatalab/MinerU/mineru-3.4.5-released/README.md` | `fetch failed` | ⚠️ **有影响** —— **3.x 的完整模型清单表没拿到**。所以 §2.2/§2.3 里"4.0 具体用哪个版面/公式模型"标为【未核实】 |
| 4 | `https://api.github.com/repos/opendatalab/MinerU/contents/README.md?ref=ff9bb2c` | **HTTP 404**（No commit found for the ref） | **无影响** —— 我猜的 commit 短哈希不存在 |
| 5 | ⚠️ `https://api.github.com/repos/wenbihan/UniMERNet` | **HTTP 404** | ⚠️ **有影响** —— **UniMERNet 的官方仓库地址与自身许可未核实**。与路线图 记录一致 |
| 6 | ⚠️ `https://huggingface.co/opendatalab/MinerU2.5-2509-1.2B` | `fetch failed` | ⚠️ **有影响** —— **VLM 权重的许可与精确体积未核实**。与 HANDOFF 记录的「本机 `huggingface.co:443` 不可达」一致 |
| 7 | `https://github.com/opendatalab/MinerU/blob/mineru-3.4.5-released/docs/en/usage/model_source.md` | **HTTP 200，但只返回 JS 外壳，无正文** | ⚠️ **技术性失败** —— GitHub 的 blob 页面是客户端渲染的。**已改用 API 接口重取成功**（8.1 #9）。**这条值得记：以后取 GitHub 文件内容一律走 `api.github.com/.../contents/`，不要抓 blob 页。** |

### 8.3 本次**未核实**的具体事项（**一个都没有补，如实列出**）

| 项 | 为什么未核实 |
|---|---|
| **MinerU 4.0 在小模型路径上具体用哪个版面模型** | changelog 只写了"移除了哪两个"，**没写"换成了哪个"**；`usage/tiers/` 只说"ONNX Layout"。**【推测】是 `PP-DocLayout` 家族，但没有一句话明说。** |
| **MinerU 4.0 具体用哪个公式模型** | 同上。changelog 停在 `unimernet(2503)`（1.3.0），之后没有明确的换代记录。 |
| **MinerU 3.4.5 的完整模型清单与各文件体积** | raw.githubusercontent 不可达（8.2 #3）。 |
| **`SLANet` / `UNet` / 表格分类模型的体积** | 未打开 `table_structure_recognition` / `table_cells_detection` 页。 |
| **`UniMERNet` 的仓库地址与自身许可** | GitHub 404（8.2 #5）。 |
| **`MinerU2.5-*-1.2B` 权重的许可与精确体积** | HuggingFace 不可达（8.2 #6）。 |
| **MinerU 4.0 的阅读顺序实现方式** | 4.0 文档没有独立的阅读顺序页；`usage/tiers/` 只把它归入小模型包。 |
| **`docvortex` 的许可与 4.0 的确切最低版本** | 未查 `myhloli/docvortex`。⚠️ **且 `pyproject.toml` 写 `docvortex>=0.5.16,<1`、而 `README.md` 写 `docvortex>=0.4.19,<1`，两处不一致，本次未核实哪个是准的。** |
| **PaddleOCR 各模型的 LICENSE 文件** | 本次未打开，**继承路线图 的"未核实"口径**。 |
| **MinerU 的 PyPI 最新版号** | 仅从搜索结果标题取到 `3.1.5`，**未打开 PyPI 页面**。⚠️ 且它与仓库里的 4.0 **不一致**（可能 PyPI 未同步 4.0），**未核实**。 |

### 8.4 本次在本机实测到的项目事实（【本项目实测】）

| 项 | 值 | 命令 |
|---|---|---|
| HEAD | `70b8c50ee082f03780333199d9150b74189116b1` | `git rev-parse HEAD` |
| `tsc -b` | **exit 0** | `npx tsc -b` |
| `vitest` | **773 passed / 40 files，exit 0** | `npx vitest run` |
| `HANDOFF.md` 行数 | 2476 | `[System.IO.File]::ReadAllLines().Count` |
| `docs/技术路线图-四功能.md` 行数 | 1794 | 同上 |
| `layoutAnalysis.ts` 的 `return null` 处 | **共 13 处**；其中 `analyzePageLayout()` **7 处**（`:696 :736 :740 :744 :791 :801 :813`）、`detectColumns()` **6 处**（`:535 :540 :546 :547 :564 :568`） | `grep` + 逐行核对 |
| `LAYOUT_INPUT_SIZE` | `480`（`layoutAnalysis.ts:199`） | `grep` |
| `LAYOUT_MODEL_BYTES` | `4_917_852`（`layoutAnalysis.ts:605`） | `grep` |
| `ocrStructure` 的 `buildId` | `ocrStructure.ts:188` 声明 / `:521` 赋值 | `grep` |
| MinerU README 解码后 | 55,856 字节 / **1096 行** | 本地 base64 解码 |
| MinerU changelog 解码后 | 43,256 字节 / **578 行** | 同上 |

---

## 九、结论摘要

1. **任务书的三条前提全部过期**：MinerU 现在是 **4.0**（不是 v2.x）；**pipeline/vlm 二分已取消**，
   改成 4 个质量档位；**中间表示已换成 `docvortex.middle` / protocol `2.0`**（`pdf_info` 是旧协议）。
2. **许可不是 AGPL**：MinerU 在 **3.1.0（2026-04-18）从 AGPLv3 改成 Apache-2.0 + 附加条款**
   （【已核实】`LICENSE.md` + changelog）。**「直接复用其代码」在 Apache-2.0 下是被允许的**，
   但若作为**在线服务**提供，**条款 2 要求在界面或公开文档里显著标明使用了 MinerU**。
   ⚠️ **不过本文的全部 TODO 都只借鉴设计、不引入任何 MinerU 代码，因此不产生该义务。**
3. **AGPL 的风险依然真实存在，只是在别处**：`DocLayout-YOLO` **就是 AGPL-3.0**（【已核实】），
   `layoutreader` 是 **CC-BY-NC-SA 4.0**。**MinerU 自己在 3.0.0 把这三个模型全部删掉了** ——
   这是"传染性许可会逼走商业使用者"最有说服力的活标本。
4. **本项目与 MinerU 在隐私设计上是同一个设计**（默认本地、外发必须显式），
   但 MinerU 的表达更工程化（三类连接对照表、错误码表、排除清单）。
5. **MinerU 能给本项目的最有价值的东西，不是它的模型，是它的"契约感"**：
   档位是用户可见契约、错误码配动作、schema 双键识别、三种主张独立对待、
   发版必须报分、缓存按档位分离。
6. **体积结论不变且已二次核实**：公式 OCR 模型（最小 224 MB = 25 MiB 的 **855%**）在本项目约束下
   **不可能**；MinerU 的模型包（~0.8 GB 起）**不是超限问题，是路线冲突**。
7. **最值得借鉴的一条**：**T1 —— 用结构化状态替换静默降级**（零体积、零依赖、
   直击 HANDOFF §5.11.7「版面模型从未验证」与 §5.11.5「失败即 `null`」叠加出的可观测性黑洞）。
8. **最该明确放弃的一条**：**本地公式识别（PP-FormulaNet / UniMERNet）** ——
   已两次核实体积，**这条路是死的**；本项目的几何启发式是唯一可行路径。
