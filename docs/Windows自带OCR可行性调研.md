# Windows 自带 OCR 接入可行性调研

> 调研对象：`universal-reader`（纯前端、零后端静态站点，浏览器端 PaddleOCR）
> 调研问题：**Windows 自带的 OCR 功能能不能接入，用于辅助现有实现？**
>
> **本文的证据纪律**：每条结论都标注了来源等级。
> - 🟢 **实测** = 本次在本机跑出结果的命令与输出
> - 📘 **官方文档** = Microsoft / W3C / webassembly.org 官方页面
> - 🔭 **推测** = 由实测或文档推断，未直接验证
> - ❓ **未验证** = 本次没有验证，或找不到权威来源
>
> 调研环境（实测）：Windows 11 `10.0.26300.9457`、Windows PowerShell `5.1.26100.9444`、Node `v25.2.1`、DSH 沙箱 `workspace-write`。

---

## 0. 结论速览

| 问题 | 结论 | 证据等级 |
|---|---|---|
| 1. 浏览器网页 JS 能直接调用 Windows OCR 吗？ | **不能。** 且没有任何标准 Web API 能间接用到系统 OCR | 📘 官方文档（决定性） |
| 2. 本机 Windows OCR 可用吗？中文呢？ | **可用，中文可用。** 本机装了 `zh-Hans-CN`，实测识别成功 | 🟢 实测 |
| 3. 能否做成「本地辅助工具」？ | **能，且已写出并跑通端到端脚本**（零额外安装、不联网） | 🟢 实测 |
| 4. 与现有浏览器端 PaddleOCR 相比？ | **是互补的 fallback，不是替代。** 中文正文很快很准，**公式/复杂排版不可用** | 🟢 实测 + ❓ 部分未验证 |

**一句话建议**：把「Windows 自带 OCR」做成**桌面端离线预处理工具**（生成 Markdown 再导入），而**不是**试图把它塞进浏览器。它能显著改善「中文纯正文扫描件」的首次体验（30MB 模型下载 → 0，速度 ~0.65 s/页），但**不能**解决公式与复杂排版的问题。

---

## 1. 浏览器里能不能直接调用 Windows OCR？

### 结论：**不能。** 三重依据，互相独立

#### 依据 A（决定性）：WinRT 的 JS 投影明确排除浏览器 📘

Microsoft 归档文档 *Windows Runtime (WinRT) for JavaScript* 原文：

> "you may request these native Windows APIs from JavaScript when your web app is **running as an installed Windows 10 app** (launched from the `wwahost.exe` process, **rather than the browser**)."

即 WinRT JS 投影只在**以已安装 Windows 应用身份运行**（`wwahost.exe`）时存在，**浏览器被明确排除**。

🔗 https://learn.microsoft.com/en-us/archive/microsoft-edge/legacy/developer/windows-runtime/

WinRT 投影实际存在于哪些宿主：

| 宿主 | 有 `Windows.*` 吗 | 依据 |
|---|---|---|
| UWP / WinJS HTML 应用（`wwahost.exe`） | ✅ 有 | 📘 同上 |
| EdgeHTML WebView（旧） | ✅ 有 | 📘 `JsProjectWinRTNamespace` — "supported only in EdgeHTML mode" 🔗 [链接](https://learn.microsoft.com/en-ca/archive/microsoft-edge/legacy/developer/hosting/chakra-hosting/jsprojectwinrtnamespace-function) |
| WebView2 宿主 App | ⚠️ 需原生侧用 `wv2winrt` + `AddHostObjectToScript` **显式投影**，JS 拿到的是 `chrome.webview.hostObjects.sync.Windows` **proxy**，不是全局 `Windows` | 📘 [winrt-from-js](https://learn.microsoft.com/en-us/microsoft-edge/webview2/how-to/winrt-from-js) |
| **普通浏览器页面（Chrome/Edge/Firefox/Safari）** | ❌ **没有** | 📘 依据 A |

- Edge Legacy (EdgeHTML)：WinRT 投影归属于 `wwahost`/WebView 宿主，**页面本身被排除**。
- Chromium Edge：**无** WinRT；相关文档整体归档（"legacy product, which is no longer being updated"）。
- 移除公告 / Origin Trial / 实验 flag：❓ **未找到权威来源**。官方 Origin Trial 入口无 WinRT 条目。

#### 依据 B：全局对象规范里根本没有 `Windows` 命名空间 📘/❓

Web IDL / HTML 的全局对象（`Window`、`WorkerGlobalScope`）从未定义 WinRT 命名空间。❓ 未找到任何权威来源把 WinRT 列为 Web 标准全局。`window.chrome.webview` 也被官方限定为"WebView2 Runtime 内可用"。

#### 依据 C：WebAssembly 也绕不过去 📘

用户可能会想"那用 WASM 呢"。**不行**，官方说明：

> 核心规范 "focused on **pure sandboxed computation**, with **host interactions factored out into higher specification layers**"
> Web 嵌入下只能 "access browser functionality through the **same Web APIs that are accessible to JavaScript**"
> "Applications **can't escape the sandbox without going through appropriate APIs**"

🔗 https://webassembly.org/docs/high-level-goals/ ｜ https://webassembly.org/docs/security/

机制上：WASM 只能调用 (a) 被显式作为 **import 传入的 host functions**，(b) 通过 JS glue 调用的 Web API。浏览器**根本不会提供** WinRT 的 host function —— 所以 WASM 不可能"凭 import 变出"系统 OCR。

### 有没有标准 Web API 能间接用到系统 OCR？**没有** 📘

| 候选 | 现状 |
|---|---|
| **Shape Detection API（`TextDetector`）** | 📘 仅 WICG CG draft，明文 "not a W3C Standard nor is it on the W3C Standards Track"，且规范把能力限定为 **Latin-1 文本**。MDN 文档页**已 404**（实测），`mdn/browser-compat-data` 中 `api/TextDetector.json` 已不存在。🔗 https://wicg.github.io/shape-detection-api/text.html |
| Chrome 移除 `TextDetector` 的具体版本 | ❓ **未能核实**。找到 Chromium issue 标题 "Deprecate native platform TextDetectionImpl (Win/Mac) after enabling in-browser OCR backend"（🔗 https://issues.chromium.org/issues/568093888），可佐证"原生后端被弃用"，但**无法确认版本号与官方公告**（相关域名在检索环境 fetch 失败） |
| 其他 W3C/WICG OCR 提案 | ❓ **未找到权威来源** |

> 注：Chromium 那个 issue 标题里的 "in-browser OCR backend" 指的是 Chrome 自己内置的 OCR 后端（服务于 PDF 无障碍等场景），**不是**暴露给网页 JS 的 API，也**不能**被本站点调用。🔭 推测。

### 扩展 / Native Messaging 路径？技术上可行，但破坏前提 📘

浏览器扩展 JS 同样在沙箱内，**没有** WinRT 访问权。唯一桥梁是 **Native Messaging**（扩展 ↔ 本地原生宿主进程），由原生宿主去调 WinRT。

对"零后端静态站点"的含义：用户必须
1. 安装浏览器扩展；2. 在系统上安装并注册原生宿主程序（Windows 还要写注册表 `NativeMessagingHosts` 清单）。

**这已经不是"纯静态、零安装"方案了。** 而且见 §2.1 的 package identity 问题。🔗 https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging （⚠️ 该 URL 在检索环境未能抓取正文，仅确认页面存在）

---

## 2. 本机实际情况 🟢 全部实测

### 2.1 OCR 引擎与语言包

```powershell
# 逐条实测命令与输出
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
# -> TYPE LOADED: Windows.Media.Ocr.OcrEngine

[Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages
# -> COUNT: 1
#    LANG: zh-Hans-CN | DisplayName=简体中文(中国大陆) | NativeName=中文(中华人民共和国)

[Windows.Media.Ocr.OcrEngine]::MaxImageDimension
# -> 10000
```

**结论：**
- 🟢 本机 **中文 OCR 可用**（`zh-Hans-CN`，唯一一个）。
- 🟢 `MaxImageDimension = 10000` 是**实测值**。📘 官方属性页只写"Gets the maximum image pixel dimensions"，**未给出具体数值** —— 常见传言"10000"在本次调研中由实测坐实，但❓官方文档无此数字，不应硬编码。
- 🟢 走通的路：**PowerShell 5.1 的 WinRT 类型投影**（`[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]`）。这是最省事的一条路，**不需要** `Get-WindowsCapability`、不需要管理员、不需要读注册表。
- ⚠️ **必须用 Windows PowerShell 5.1（`powershell.exe`），不能用 PowerShell 7（`pwsh`）** —— PS7 默认没有 WinRT 类型投影。脚本里已加守卫。

### 2.2 ⚠️ 重要发现：文档说需要 MSIX，实测不需要

📘 官方文档明确写：

> "APIs in the `Windows.Media.Ocr` namespace are **only supported for desktop apps with _package identity_**. This means that the app is installed and run from an **MSIX package**."

🔗 https://learn.microsoft.com/en-us/uwp/api/windows.media.ocr
🔗 https://learn.microsoft.com/en-us/windows/apps/desktop/modernize/winrt-api-desktop-app-support （`OcrEngine`/`OcrLine`/`OcrResult`/`OcrWord` 都在 "require package identity" 分组里）

**但本次实测直接矛盾：**

```
PACKAGE IDENTITY: ABSENT -> The process has no package identity. (Exception from HRESULT: 0x80073D54)
Process name : powershell
Executable   : C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe
PS version   : 5.1.26100.9444
```

同一个**没有 package identity** 的进程里，`OcrEngine.TryCreateFromLanguage()` 与 `RecognizeAsync()` **完全正常工作**（见 §2.3）。

**这意味着什么：**
- 🟢 在**本机这个 build（Windows 11 10.0.26300）**上，未打包的进程可以调用 `Windows.Media.Ocr`。
- 🔭 **推测**：该"package identity 限制"要么在文档上写得比实际执行更严，要么在新版 Windows 上并未对该 API 强制执行。
- ⚠️ **这是本次方案最大的风险**：因为这属于**文档明确不支持的用法**，**不能保证在其他 Windows 版本 / 未来 build 上仍然可用**。落地前必须在目标机器上先跑 `-ListLanguages` 探活（脚本已支持）。

### 2.3 实测：识别一张中文图

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\win-ocr-helper.ps1 `
    -ImagePath zh-test.png -OutFile single.json
# -> [OCR] zh-test.png  (1000x420)  ->  5 行
#    写出 single.json（1 张图，238 ms）
```

**引擎速度 🟢**：单张 1000×420 图 **238 ms**；A4@200DPI（1653×2339）页面 **93–240 ms/页**。

---

## 3. 本地辅助工具形态：**已实现并跑通** 🟢

由于 §1 的结论，浏览器路线走不通；但"用户在自己电脑上跑一次命令行工具"完全可行，且**零额外安装、不联网、不上传**。

### 3.1 交付物

| 文件 | 作用 |
|---|---|
| `scripts/win-ocr-pdf.mjs` | 主编排：PDF → 渲染 → Windows OCR → Markdown/TXT/JSON |
| `scripts/win-ocr-helper.ps1` | WinRT `Windows.Media.Ocr` 执行体：图片 → 带包围盒的 JSON |

### 3.2 流水线与关键取舍

```
PDF ──pdfjs-dist──▶ 每页 PNG ──PowerShell+WinRT──▶ JSON ──重排──▶ Markdown
     (@napi-rs/canvas)      (Windows.Media.Ocr)
```

| 关键难点 | 解决方式 | 状态 |
|---|---|---|
| PDF 渲染成图片拿什么渲染？ | **`pdfjs-dist@5.7.284` + `@napi-rs/canvas@0.1.100`** | 🟢 二者**都已在 `package.json` 里**（`@napi-rs/canvas` 是 `ppu-paddle-ocr` 的传递依赖），**未新增任何依赖**、未改 `package.json` |
| 有没有 pdfjs / canvas？ | 有。`canvas`（node-canvas）**没有**，但 `@napi-rs/canvas` 有 prebuilt binary，**不需要** node-gyp / Visual Studio | 🟢 实测 |
| 图片交给 WinRT OCR | PowerShell 5.1 反射桥接 `IAsyncOperation<T>` → `AsTask` → 同步等待 | 🟢 实测 |
| 结果写回 | 按行 + 词级包围盒 → JSON → 启发式段落重排 → Markdown | 🟢 实测 |
| 本机有没有 poppler / ghostscript / ImageMagick / tesseract？ | **全都没有**（实测 `pdftoppm`/`pdftotext`/`magick`/`gswin64c`/`qpdf`/`mutool`/`tesseract` 均 ABSENT）—— 所以**必须**走 pdfjs + napi-rs/canvas 这条路，本方案正好零安装 | 🟢 实测 |

### 3.3 ⚠️ 一个必须记录的沙箱约束

DSH 沙箱**禁止子进程通过管道（named pipe）回传输出**：Node 的 `child_process.spawn/exec` 用默认 `stdio:'pipe'` 会 EPERM。

因此脚本**刻意设计成「PowerShell 写 JSON 文件 → Node 读文件」**，而不是捕获 stdout。子进程用 `stdio: 'inherit'`。这样在沙箱内和用户正常终端里都能跑。

### 3.4 输出格式：**Markdown / TXT / JSON**，**没有**「带文字层的 PDF」

诚实说明：任务里提到的"带文字层的 PDF"这一分支**本次未实现**。原因：
- 写 PDF 需要 `pdf-lib`，而它**已在本项目中被移除**（见 `HANDOFF.md` §4.3 决定三），且本次任务**不允许改 `package.json`**。
- 🔭 推测其可行性：理论上可用纯 Node 手写 PDF（扫描图 + `Tr 3` 不可见文字层 + 按 word 包围盒定位），但需要自行处理页面尺寸/旋转/加密/压缩等，工作量大且易错。**建议不作为当前优先级** —— 本阅读器导入 `.md` 即可获得双语对照/朗读/批注，收益比文字层 PDF 更直接。

### 3.5 用法

```powershell
# 列出本机可用的 OCR 语言（探活，建议落地前先跑）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\win-ocr-helper.ps1 -ListLanguages

# 扫描版 PDF → Markdown
node scripts\win-ocr-pdf.mjs .\扫描书.pdf -o .\扫描书.md

# 只处理前 3 页、300 DPI、忠实保留 OCR 行（不做段落重排）
node scripts\win-ocr-pdf.mjs .\a.pdf --pages 1-3 --dpi 300 --layout line
```

选项：`-o/--out`、`--format md|txt|json`、`--dpi`（默认 200，与 `src` 的 `OCR_RENDER_DPI` 一致）、`--lang`、`--layout paragraph|line`、`--pages`、`--batch`、`--page-separator`、`--work-dir`、`--keep-images`、`--quiet`、`-h`。

---

## 4. 对比结论：Windows 自带 OCR vs 浏览器端 PaddleOCR

### 4.1 硬指标

| 维度 | Windows 自带 OCR | 浏览器端 PaddleOCR（现方案） | 证据 |
|---|---|---|---|
| **模型体积** | **0 MB**（系统内置） | **约 29.8 MB**（`PP-OCRv6_small_det.ort` 9.52 MB + `rec.ort` 20.3 MB） | 🟢 实测（`public/ocr-models/`） |
| **首次是否需要联网** | **否** | **是**（模型虽已随站点同源发布，但**不在预缓存清单**里，首次 OCR 必须联网拉） | 🟢 实测（`public/ocr-models/` 存在）+ 📘 `HANDOFF` §T1 |
| **是否需要联网（任何时刻）** | **否** | 首次需要 | 同上 |
| **隐私** | **完全本机**，不产生任何网络请求 | **完全本机**（除可选、默认关闭的 SimpleTex 公式云识别） | 📘 `HANDOFF` §T2 |
| **速度** | **93–240 ms/页**（A4@200DPI，不含渲染）；端到端 **约 0.65 s/页** | ❓ **未实测** | 🟢 实测（Windows 侧） |
| **能否在浏览器里用** | **不能**（§1） | 能（这是它存在的理由） | 📘 官方文档 |
| **跨平台** | **仅 Windows** | 全平台（WASM） | 📘 |
| **可维护性** | ⚠️ **依赖文档明确不支持的用法**（§2.2），且必须在 PS 5.1 下跑；升级可能失效 | ✅ 纯 TS、有 25 个测试文件、模型同源自托管 | 🟢 实测 + 📘 |

### 4.2 识别质量

**中文纯正文（合成干净渲染、200 DPI、A4）—— 🟢 实测：**

> **CER（字符错误率）= 1.41%**（213 字中 3 处编辑），**字符准确率 98.59%**

差异明细（全部 3 处）：

```
@141: 多出「另」        ← 「识别」→「识别另刂」，"别"被拆成 另+刂 两个字
@141: 应为「别」实为「刂」
@202: 应为「情」实为「庸」  ← 「情况」→「庸况」
```

> ⚠️ **这个数字必须谨慎解读**：测的是**我自己用 `@napi-rs/canvas` 合成的干净渲染图**，无倾斜、无噪点、无印章、无 JPEG 压缩伪影 —— 这是 OCR 的**最好情况**。**真实扫描件的 CER 一定会显著更高。**

**⚠️ 上述 CER 只覆盖了正文段落。标题行的全角空格丢失（「第一章　通用…」→「第一章通用…」）没有被计入**，因为我在归一化时去掉了所有空白。实际阅读体验上的错误比 1.41% 略多。

**公式与复杂排版 —— 🟢 实测：失败，且失败模式明确**

对同一页含公式的扫描页，实测输出（**未修正，原样**）：

| 原文 | Windows OCR 实测输出 | 判定 |
|---|---|---|
| `f(x) = (a+b)/2` | `f(x) = (a + b)/2` | ✅ 基本正确（多了空格） |
| `x^2` | `xA2` | ❌ **上标丢失** |
| `y_1` | `y_l` | ❌ **下标丢失**（`1`→字母 `l`） |
| `{ a + b = 5` | `{ a + b：5` | ❌ **`=` 被识别成全角冒号 `：`** |
| `{ a - b = 1` | `{ a一b：1` | ❌ **减号 `-` 变成汉字「一」** |
| `English` | `EngIish` | ❌ 小写 `l` → 大写 `I` |
| `分号；冒号：` | `分号；` + 换行 + `目：` | ❌ **一行被拆成两行**，且「冒号」→「目」 |
| （整段公式换行） | `以及xA2 + y_l` ⏎ `= 3` | ❌ 公式被从中间**断成两个 OCR 行** |

**跨行大括号 / 整行丢失 —— 🟢 实测（确定性，非随机）：**

在 1000×420 的小图 `zh-test.png` 上，两行大括号方程组

```
{ a + b = 5
{ a - b = 1
```

**只识别出第一行，第二行整行丢失。重复 3 次，3 次都丢**（确定性行为）。

但在 1653×2339 的 A4@200DPI 页面上，同样的两行排版**两行都被识别出来了**。

🔭 **推测**：这是**与渲染分辨率 / 缩进 / 版面上下文相关的确定性失败**，而非随机噪声 —— 但触发条件本次**未查清**。

**结论（§4.2 汇总）：**
- 🟢 Windows OCR 对**中文纯正文**（横向单栏、无公式）质量可用于 fallback。
- 🟢 对**数学公式、上下标、跨行大括号**：**明确不可用**。它只有"行 → 词"两层数据结构，**没有公式结构概念**。
- ❓ 📘 官方文档对公式/复杂排版**完全没有说明**（既没说支持也没说不支持），本次**实测结论是"不行"**。
- ❓ **未验证**：真实扫描件（倾斜/噪点/印章/手写）、多栏排版、表格、竖排中文。

### 4.3 段落重排：一个我实测到并修掉的坑 🟢

`--layout paragraph`（默认）会尝试把"被排版换行"的行合并回段落。这是**启发式**，我实测到并修掉了两版问题：

1. **v1 过度合并**：用「行右边缘的 90 分位」估计正文右边界 → 在一页只有 7 行的合成件上，最长的行自己就成了"右边界"，导致 **4 个视觉上完全独立的段落被粘成一段**。
2. **v2 部分合并**：改用 min-left/max-right 后，在「左对齐 + 右参差」的页面上只合并了前两行、后两行没合并 → **凭空造出一个不存在的段落边界**（比不合并更糟）。

**v3（当前）**改为「典型行宽取右边缘的 **75 分位**」+ 两道守卫：
- 一页有效行 **< 8 行** → 放弃重排（样本不足以估计页边距）
- 检测到**多栏排版**（存在竖直重叠 ≥50% 但水平不重叠的两行）→ 放弃重排

**v3 实测结果**：对合成的「左对齐+右参差」中文正文页（2 段共 8 个物理行），重排结果与原文段落**完全一致**（标题独立成块，两段各自合并正确）。

> ⚠️ 但这**只是 1 张合成图**。真实扫描件的版式远比这复杂。**建议**：对陌生版式先用 `--layout line`（忠实保留 OCR 行，不发明结构）核对。

---

## 5. 推荐的落地方案

### 方案：桌面端离线预处理工具（已实现）

**形态**：不进浏览器、不进站点产物。用户在 Windows 上跑一次 `node scripts/win-ocr-pdf.mjs 扫描书.pdf`，得到 `.md`，再拖进阅读器导入。

**为什么是这个形态**：
- ✅ 绕开了 §1 的硬约束（浏览器不可能调用 WinRT）
- ✅ 对"零后端静态站点"**零影响** —— `scripts/` 本来就不进构建产物
- ✅ **不联网、不上传**，与项目 C3「隐私是卖点」一致
- ✅ 零额外安装（不需要 poppler / tesseract / ImageMagick）
- ✅ 直击痛点：**30MB 模型下载 → 0**，中文纯正文扫描件首次体验大幅改善

**前置条件**：
1. Windows 10/11
2. Windows PowerShell **5.1**（**不是** PS7）
3. 已安装中文 OCR 语言包（本机已具备；缺则：设置 → 时间和语言 → 语言和区域 → 中文(简体) → 语言选项 → 可选语言功能 → 「光学字符识别」）
4. Node ≥ 20.19（本项目要求）
5. 已 `npm install`（用现成的 `pdfjs-dist` / `@napi-rs/canvas`）

**风险（务必写进文档告诉用户）**：
1. ⚠️ **最高风险**：📘 官方说 `Windows.Media.Ocr` 需要 MSIX package identity，🟢 但本机实测**不需要**。这是**文档不支持的用法**，**可能在别的 Windows 版本/build 上失效**。→ 脚本第一步应先 `-ListLanguages` 探活并给出可执行建议。
2. ⚠️ 必须 PS 5.1；用户若只有 PS7 会失败（脚本已守卫并给出明确提示）。
3. ⚠️ 公式/上下标/跨行大括号**不可用**，必须在文档里**明确告知**，避免用户对公式产生错误期待。
4. ⚠️ 段落重排是启发式，陌生版式可能出错 → 提供 `--layout line` 兜底。
5. ⚠️ 阅读顺序依赖 WinRT 返回的行序；**多栏 / 表格 / 图文混排的阅读顺序不保证正确**。
6. ⚠️ 大页（>10000px）会被引擎拒绝 → 脚本按 DPI 检查并提示降 DPI。

### 明确**不**建议做的事

| 不建议 | 原因 |
|---|---|
| 试图在浏览器里调 WinRT | §1，三重官方依据，不可能 |
| 做「扩展 + Native Messaging + MSIX 宿主」 | 需要用户装扩展 + 装原生宿主 + MSIX 打包，**彻底破坏"零后端零安装"**，收益不抵成本 |
| 用 Windows OCR 替代 PaddleOCR 做公式 | 🟢 实测公式识别不可用 |
| 为了文字层 PDF 而引入 `pdf-lib` | 违反 `HANDOFF` §4.3 决定三；且导入 `.md` 已能满足阅读器需求 |

---

## 6. 我验证到了哪一步 / 哪些没验证

### ✅ 已验证（🟢 实测）

- OS 版本、PowerShell 版本与 `LanguageMode`
- WinRT `Windows.Media.Ocr` 类型加载、语言枚举（1 个：`zh-Hans-CN`）、`MaxImageDimension=10000`
- 进程**无** package identity（`0x80073D54`）却能成功调用 OCR ← **关键矛盾发现**
- `TryCreateFromLanguage` + `BitmapDecoder` + `RecognizeAsync` 全链路，含词级包围盒
- 单图 OCR 速度（238 ms / 1000×420）；A4@200DPI 页面 93–240 ms/页
- **完整端到端**：图像型 PDF → pdfjs 渲染 → WinRT OCR → Markdown/TXT/JSON
- 2 页 PDF、`--batch 1`（多批次）、`--pages` 过滤、PNG 直接输入
- 8 项参数校验/错误路径（错误退出码、同文件保护、坏参数）
- **语言缺失回退**：`--lang en-US`（本机未装）→ 告警"本机没有 en-US 的 OCR 引擎，回退到用户配置文件语言" → 回退到 `zh-Hans-CN` 并**成功识别 5 行**
- **`>10000px` 大页守卫**：构造 2000×2000pt 页面 @600 DPI → 渲染为 **16667×16667** → 脚本正确跳过并提示"超过 WinRT OCR 上限 10000，请降低 --dpi"（同批次的 A4 页 @600 DPI = 4959×7017 正常送检）
- **非 A4 页面**渲染（2000×2000pt）+ **空白页**处理（0 行，不报错）
- 600 DPI 下 4959×7017 的大图能被引擎正常接受（≈34.8 MP，仍 < 10000px 边长限制）
- 中文正文 **CER = 1.41%**（合成干净渲染）
- 公式/上下标/跨行大括号的**具体错误模式**（逐条列出，§4.2）
- 整行丢失的**确定性**（同图重复 3 次均丢失）
- 段落重排 v1/v2 的失败与 v3 的修正
- 本机**没有** poppler / ghostscript / ImageMagick / tesseract / qpdf / mutool

### ❌ 未验证 / 未能验证

- **真实扫描件**（倾斜、噪点、印章、装订阴影、手写）的识别质量 —— 全部测试用的是**合成图**
- **浏览器端 PaddleOCR 的实测数字**（CER / 速度 / 同图对比）—— 见下方说明
- Edge/Chrome headless 生成对照 PDF —— ❌ **沙箱拒绝**（见 §7）
- 非中文语言包（本机未安装其它 OCR 语言）
- 多栏、表格、竖排、图文混排的阅读顺序
- 加密 PDF
- 「带文字层的 PDF」输出
- `Windows.Media.Ocr` 是否支持手写 —— ❓ 📘 官方**未声明**；手写识别是**另一个独立的 FOD 组件**（`Language.Handwriting`）
- 在**其它 Windows 版本/build** 上是否同样能免 MSIX 调用（本机 build 26300 的结论未必可移植）

---

## 7. 被沙箱拒绝的命令（如实记录，未绕道实现）

为生成"真实扫描件"对照 PDF，尝试用 Edge headless 打印 HTML → PDF：

```powershell
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --headless --disable-gpu `
    --no-pdf-header-footer --print-to-pdf="scan-test.pdf" "file:///D:/Deepseek/DSH/.ocrtest/scan.html"
```

**被拒输出（节选）：**

```
[1007/143342.669:ERROR:third_party\crashpad\...\crashpad_client_win.cc:447] OpenProcess: 拒绝访问。(0x5)
[37216:28036:FATAL:mojo\public\cpp\platform\platform_channel.cc:187] Check failed: . : 拒绝访问。(0x5)
[37216:26516:ERROR:content\browser\network_sandbox.cc:410] Failed to grant sandbox access to cache directory ...: 拒绝访问。(0x5)
PDF NOT CREATED
```

**原因**：DSH 沙箱禁止进程创建命名管道（named pipe），Chromium 的 mojo IPC 依赖它，因此 headless 浏览器无法启动。本会话审批已禁用，无法提权。

**未绕道**：没有改用浏览器去实现同样效果。作为**替代测试夹具**，改用**纯 Node 手写最小 PDF**（把 `@napi-rs/canvas` 渲染的中文 JPEG 作为 image XObject 嵌入，产出真正的**图像型/扫描型 PDF**，无文字层）—— 这是**换一种夹具**，不是绕过沙箱去实现被拒的那个命令。

---

## 8. 复现步骤

```powershell
cd D:\Deepseek\DSH\universal-reader

# 1) 探活：本机有哪些 OCR 语言
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\win-ocr-helper.ps1 -ListLanguages
# 期望： zh-Hans-CN  简体中文(中国大陆)

# 2) 单图 OCR
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\win-ocr-helper.ps1 `
    -ImagePath <某张中文图.png> -OutFile out.json

# 3) 扫描版 PDF → Markdown
node scripts\win-ocr-pdf.mjs <扫描版.pdf> -o <输出.md>
```

> ⚠️ 生成的 `.ps1` **必须带 UTF-8 BOM**。PowerShell 5.1 会把**无 BOM** 的 `.ps1` 按 ANSI（中文系统为 GBK）解码，导致里面的中文注释变成乱码并**直接语法报错**。本次实测踩到过这个坑（`Missing expression after ','`），已通过写入 BOM 修复。
