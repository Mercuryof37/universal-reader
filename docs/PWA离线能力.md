# 06 · PWA 离线能力

> 本文说明**离线访问与安装到桌面**是怎么实现的、为什么这么设计，以及**如何验证它真的生效**。
>
> 这一节补上的是项目核心约束里最后一个缺口。

---

## 一、为什么需要 PWA

项目从第一天就把「离线可用」列为核心约束（见 `README.md` 的 C2），
但**在此之前它只在"页面已经加载"的前提下成立**：

```
断网
  → index.html 拿不到
  → 页面根本打不开
  → IndexedDB 里的书虽然还在，但进不去
```

文档本身早就存在本地（IndexedDB 不依赖网络），**卡住的是"进入应用"这一步**。
Service Worker 正好解决这一环：把页面骨架缓存下来，离线时直接由缓存响应。

---

## 二、实现要点

### 2.1 技术选型

用 **`vite-plugin-pwa@1.3.0`**，其 peer 依赖明确声明支持 Vite 8：

```
vite: ^3.1.0 || ^4.0.0 || ^5.0.0 || ^6.0.0 || ^7.0.0 || ^8.0.0
```

这一点在选型时**先核实过**——本项目用的是 Rolldown 内核的 Vite 8，
生态兼容性不能想当然。手写 Service Worker 也能做，但缓存版本管理、
更新流程、过期清理这些细节容易出错，交给 Workbox 更可靠。

### 2.2 缓存策略

| 类别 | 策略 | 内容 | 理由 |
|---|---|---|---|
| 应用壳 | **预缓存** | `index.html`、全部 JS chunk、CSS、图标、manifest | 这是"能打开页面"的最小集合，必须离线可用 |
| PDF 解码器 | **预缓存** | `jbig2.wasm`、`openjpeg.wasm`、`qcms_bg.wasm` 等（WASM 解码器共 7 个，合计 1.41 MB） | 扫描版 PDF 依赖它们，缺失时页面渲染成白页且**不报错** |
| 导航请求（HTML） | **运行时 NetworkFirst** | 页面导航请求，`cacheName: 'html-navigation'` | 在线取服务器最新 HTML，离线回退上次缓存。见 2.5 |
| PDF WASM 解码器 | **运行时 CacheFirst** | `/pdfjs-wasm/*.(wasm\|js)`，`cacheName: 'pdfjs-wasm'` | 按需下载，用一次后离线可用 |
| OCR 模型 | **运行时 CacheFirst** | HuggingFace CDN 上的 PaddleOCR 模型，`cacheName: 'ocr-models'` | 约 10 MB，不适合预缓存；用过一次后离线可用 |
| ONNX Runtime WASM | **运行时 CacheFirst** | jsDelivr 上的 `ort-wasm*.(wasm\|js\|mjs)`，`cacheName: 'onnx-wasm'` | 约 28 MB，**超过 Cloudflare Pages 单文件 25 MB 上限**，只能在运行时从 CDN 取 |

预缓存共 **18 项，3,578.19 KiB**（构建日志原文：`PWA v1.3.0  mode generateSW  precache 18 entries (3578.19 KiB)`）。

> **本次同步的变更说明**：原表中「OCR 语言包 | 运行时 CacheFirst | jsDelivr / unpkg / tessdata 的资源 | 中文包约 22 MB」这一行**已作废** —— `cdf2957` 移除了 `tesseract.js@^7.0.0`，改用 `ppu-paddle-ocr@^6.6.0` + `onnxruntime-web@^1.30.0`，语言包方案随之消失，替换为上面两行。原记录的「预缓存共 18 项，约 2.8 MB」体积也不再成立，现为实测的 3,578.19 KiB。

### 2.3 刻意排除的内容

`copy-pdfjs-wasm.mjs` 会把 `pdfjs-dist/wasm/` 整个目录复制过来，
但其中三样本项目**永远不会请求**：

| 文件 | 体积 | 为什么不需要 |
|---|---:|---|
| `quickjs-eval.wasm` + `.js` | 428 KB | pdf.js 的 JS 沙箱求值特性，本项目未启用 |
| `openjpeg_nowasm_fallback.js` | 441 KB | 浏览器不支持 WASM 时的纯 JS 兜底 |
| `jbig2_nowasm_fallback.js` | 142 KB | 同上 |

合计约 **1 MB**。通过 `globIgnores` 排除出预缓存清单后，
首访安装体积的实测值为 **3,578.19 KiB**（见 2.2）。

> 本次同步补记：`globIgnores` 现在还多排除一项 `**/ort-wasm*` —— ONNX Runtime 的 WASM 约 28 MB，
> 由 `scripts/clean-onnx-wasm.mjs` 在构建后从 `dist/` 里删除，运行时改从 jsDelivr 取
> （实测日志：`Removed ort-wasm-simd-threaded.jsep-MDYUKy93.wasm (served from CDN at runtime)` →
> `Cleaned 1 ONNX WASM file(s) from dist.`）。`postbuild` 因此变为
> `node scripts/clean-onnx-wasm.mjs && node scripts/verify-dist.mjs`。

**注意**：它们仍会被复制到 `dist/`——真遇到不支持 WASM 的环境时，
pdf.js 有机会去取兜底版本。排除的只是"预缓存"，不是"交付"。

### 2.4 为什么用「提示更新」而不是「自动更新」

> ⚠️ **本节所述配置已经不再成立，且冲突未解决 —— 状态：未解决 / 待决策。**
>
> `d7a5bae` 把 `vite.config.ts` 改成了 **`registerType: 'autoUpdate'` + `skipWaiting: true`**，
> 而 `src/lib/pwa.ts` 与 `src/components/PwaPrompt.tsx` **仍然是按 prompt 模式设计的**。
> 下面这段设计理由**依然有效、依然代表设计意图**，但代码现状与它相反。
> 已验证的副作用与待决策项见 **2.8**。

**原设计**是 `registerType: 'prompt'` + `skipWaiting: false`，
新版本装好后处于 **waiting** 状态，**等用户点确认才接管**。

自动更新（`autoUpdate` / `skipWaiting: true`）看起来更省事，但对本应用有害：

> 用户可能正在读一份长文档。页面在毫无预警的情况下重载，
> **滚动位置、展开的译文、正在进行的 OCR 全部丢失。**

阅读类应用最不能容忍"读到一半被打断"。因此把更新时机交给用户：
提示条出现，他可以选"立即更新"或稍后。

### 2.5 陈旧 chunk 故障：现象 → 真因 → 修法 → 证据

> 本项目上线以来最难定位的一次故障。根因由 `a766d3f` 修复，它留下的空档由 `aa8827a` 补上。

**现象**

用户导入 `习题5-10月19日交(1).pdf` 时报：

```
Failed to fetch dynamically imported module:
https://universal-reader.pages.dev/assets/pdfParser-CiRxJgol.js
```

**特征极具迷惑性**：页面本身正常、md/txt 也能导入，**只有按需加载的解析器（pdf / epub / ocr）会炸**。
原因是 md/txt 的 chunk 在入口依赖图里，而 pdf / epub / ocr 是动态 import。

**真因（已由源码证实）**

`vite.config.ts` 里的 `navigateFallback: '/index.html'` 会注册一条 `NavigationRoute`，
其 handler 由 `createHandlerBoundToURL` 绑定，**直接返回预缓存里的 `index.html`，不经过网络**。

**证据（读源码，不是推测）**：`workbox-build@7.4.1` 的
`build/templates/sw-template.js` **第 52–58 行**显示：`navigateFallback` 生成的 `NavigationRoute`
注册在 `runtimeCaching` 各路由**之前**（第 52–55 行是 `NavigationRoute`，第 58 行才是 `runtimeCaching` 的循环）；
而 **Workbox 按注册顺序匹配路由**。因此只要设了它，**导航请求永远命中预缓存**。

失败链：

```
旧 SW 递出旧 index.html
  → 它引用的是旧构建的 chunk 哈希
  → 新部署后服务器上那些文件已被删除
  → 动态 import 一个不存在的文件
  → Failed to fetch dynamically imported module: .../pdfParser-CiRxJgol.js
```

**`d7a5bae` 曾试图用 `autoUpdate` + `skipWaiting: true` 解决它，那是错误方向**：
`skipWaiting` 管的是「新 SW 何时接管」，**管不了「已经接管的 SW 主动把旧 HTML 递给用户」**。用错了杠杆。

**修法（`a766d3f`）**

- `navigateFallback: undefined` —— 不再注册任何 HTML 预缓存路由；
- 新增一条显式导航路由：

| 配置项 | 值 |
|---|---|
| `urlPattern` | `({ request }) => request.mode === 'navigate'` |
| `handler` | `'NetworkFirst'` |
| `cacheName` | `'html-navigation'` |
| `networkTimeoutSeconds` | `3` |
| `expiration.maxEntries` | `8` |
| `cacheableResponse.statuses` | `[0, 200]` |

语义：**在线拿服务器最新 HTML**（→ 它引用的 chunk 必然存在，从源头消除错配），**离线回退上次缓存**。
用 `NetworkFirst` 而不是 `NetworkOnly`：后者会让离线彻底打不开网站，而「离线可用」是本项目的核心约束。

与之配套的是**三条 CacheFirst 运行时缓存**（`pdfjs-wasm`、`ocr-models`、`onnx-wasm`，见 2.2）
加上**预缓存 18 个条目**，共同构成完整的离线资源集合。

**线上实测证据**

抓 `https://universal-reader.pages.dev/sw.js` 实测确认：

| 检查项 | 结果 |
|---|---|
| 含 `NetworkFirst` | ✅ |
| 含 `html-navigation` | ✅ |
| 含 `createHandlerBoundToURL` | ❌ **不含** → 修复确已上线 |

线上 `index.html` 响应头实测为 `Cache-Control: public, max-age=0, must-revalidate`。

线上 precache 清单包含 `assets/index-DewjVU_A.js`、`assets/pdfParser-BC0kRy96.js`、
`assets/epubParser-BQ_LEFRG.js`、`assets/ocrEngine-3Cz6SoQl.js` 等。

> **不要用本地 `dist/` 里的文件名去推断线上资源名。** 同一次提交，本地是
> `index-BWQq926L.js` / `pdfParser-qWOY3aHL.js`，线上是 `index-DewjVU_A.js` / `pdfParser-BC0kRy96.js` ——
> Cloudflare 的构建与本地构建**不是逐字节可复现的**。

### 2.6 离线兜底：`seedNavigationFallback()`（`aa8827a`）

**为什么需要它**：NetworkFirst **只回退它自己的 `html-navigation` 缓存**，
而这个缓存要等「SW 接管之后的第一次导航」才会被写入。于是有一个很窄但很致命的空档：

```
首次访问（SW 装好，但这次导航不是它处理的）
  → 用户直接断网
  → 打开已安装的应用（这是一次导航）
  → 网络失败 + 缓存为空
  → 白屏
```

「装上就能断网读」正是核心卖点，所以这个空档必须补。

**怎么做的**（`src/lib/pwaOffline.ts`）：

- `NAVIGATION_CACHE_NAME = 'html-navigation'` —— 必须与 `vite.config.ts` 里导航路由的 `cacheName` 完全一致，
  改动其一而忘了另一个，兜底会**静默失效**；
- `seedNavigationFallback()` 在 `onRegisteredSW` 时趁在线 `fetch('/')`，成功后 `cache.put('/', response)`；
- 页面与 SW 同源、**共享同一套 Cache Storage**，因此直接写入合法且可靠；
- **失败只告警、不上抛**（兜底是为了帮忙，不能反过来影响正常使用）；非 2xx 不写入，避免把错误页当成离线兜底。

**为什么不能改用 `navigateFallback` 来解决离线**：见 2.5 —— 它会**重新引入本次修复的 bug**，
两者**互斥**。这是本小节最容易被"想当然地简化掉"的地方。

**为什么拆成独立模块**：`pwa.ts` 顶层 import 了 `virtual:pwa-register/react`，
该虚拟模块只在 Vite 构建/开发时存在，vitest 里解析不了；把纯逻辑摘出来才能直接测。
`src/lib/pwaOffline.test.ts`（**8 个用例**）会读 `vite.config.ts`，把 `NAVIGATION_CACHE_NAME`
与配置里的 `cacheName` 钉死，并断言导航路由保持 NetworkFirst、保留超时、且不得出现真的 `navigateFallback`。

> **写测试时踩过的坑**：断言前必须先剥掉注释 —— 那段解释性注释里本身就写着 `navigateFallback: '/index.html'`，第一次写就踩了这个坑。

### 2.7 chunk 加载失败的自愈：`preloadRecovery.ts`（`a766d3f`）

2.5 是**根因修复**，本模块是**兜底**：即便因为浏览器缓存、CDN 边缘节点，
或用户长时间开着旧标签页而仍然发生错配，也要能**自愈**，而不是把原始报错甩给用户。

- 监听 **`vite:preloadError`**（Vite 的公开契约），用 `isChunkLoadError()` 判定是否为动态 import 失败；
- 在 `src/main.tsx` 里、**React 挂载之前**装配（`installPreloadErrorRecovery()`）——
  这个事件只在 `window` 上抛一次，错过就没了；
- 用 **DOM 直接插入提示**，而不是复用应用里的 Banner 组件 —— 这个模块要在 React 挂载**之前**就可用，
  而且在刷新的瞬间就要显示，走 DOM 直插比等 React 渲染可靠；
- 自动**重载一次**页面（拿到最新 HTML）；
- 用 `sessionStorage` 标志 **`universal-reader:chunk-reload`** 防止断网时无限重载；
  隐私模式下 `sessionStorage` 不可用时，保守地视为"已重试过"——宁可少刷新一次，也不冒无限刷新的风险；
- 刷新后依然失败，说明不是版本错配，此时才提示用户：「资源加载失败，请检查网络后刷新页面。」；
- 入口 chunk 能执行到模块顶层就说明本次加载是完整的，随即清零标志，
  让下一次部署后的错配仍然享有一次自动刷新。

配套 **11 个单测**。

### 2.8 待决策：`autoUpdate` 的已验证副作用 —— **未解决**

> **状态：未解决，需要产品决策。** 不得按「已修好」理解。这一条与 2.5 的修复**互相独立**。

`d7a5bae` 把 `registerType: 'prompt' → 'autoUpdate'`、`skipWaiting: false → true`，
但**并没有解决它想解决的问题**（见 2.5：用错了杠杆），反而留下了下面这些**已验证的**副作用。

读 `node_modules/vite-plugin-pwa@1.3.0/dist/client/build/react.js` 可确认：
`autoUpdate` 模式下编译期常量 `auto === true`，于是：

| # | 已验证后果 |
|---|---|
| 1 | `updateServiceWorker()` 的函数体是 `if (!auto) { sendSkipWaitingMessage?.() }` → **它是个空操作** |
| 2 | `onNeedRefresh` 只在 `else`（prompt 分支）里被调用 → **`needRefresh` 永远为 false**，于是 `PwaPrompt.tsx` 的「有新版本可用 / 立即更新」提示条**永远不会出现** |
| 3 | `activated` 事件在 `event.isUpdate` 为真时调用 `window.location.reload()` → **页面会自动重载** |

这与 `src/lib/pwa.ts` 里写明的设计理由**直接冲突**（即 2.4 引用的那段：
「阅读类应用最不能容忍的就是"读到一半被打断"」）。**现在的行为正是它要避免的那一种。**

**待决策的二选一**：保留自动重载并删掉再也用不上的提示条 UI，
还是回到 `prompt` 让用户自己决定更新时机。

---

## 三、图标设计：四次返工

这是本次唯一"必须看图才能判断对错"的部分。

| 版本 | 画法 | 渲染结果 |
|---|---|---|
| 1 | U 形外框 + 中缝，竖边只画下半段 | 上方大片空白，完全不像书 |
| 2 | 实心书体 + 居中 7% 细缝 | 两根并排的柱子 |
| 3 | 加一条 6% 宽的左侧装订脊 | 仍是柱子——细脊与中缝在缩放后糊成一片 |
| **4** | **金色封面轮廓 + 米白内页 + 中缝** | ✅ 读得出是"一本翻开的书" |

**前三版的共同错误是想靠细线传达信息。** 6~7% 宽的线在 512px 下只有约 30px，
到浏览器标签页的 16~32px 就彻底消失。第四版改用**色块对比**：
轮廓勾出外形，浅色内页填充内容区——缩到很小仍能分辨。

> **教训：图标是纯视觉产物，不看渲染结果就无法判断对错。**
> 前三版我都是"脚本执行成功"就以为完成了。

图标由 `scripts/make-icons.mjs` 生成，**零依赖**：
用 Node 内置的 `zlib` 手写了一个最小 PNG 编码器
（magic + IHDR + IDAT + IEND，每段都是 长度+类型+数据+CRC32）。
常见的 `sharp` / `@vite-pwa/assets-generator` 会带来几十兆原生依赖，
而本项目只需要两张纯色几何图形。

---

## 四、如何验证离线真的生效

> ⚠️ **必须如实标注：下面这套流程至今没有在真实硬件上做过。**
>
> 目前的离线结论来自源码阅读、Workbox 模板逐行对照，以及线上 `sw.js` 的抓取，
> **都不等于真实浏览器里的行为**。其中
> **真实浏览器离线流程（加载 → 刷新一次 → DevTools 切 Offline → 刷新）至今没有在真实硬件上做过**，
> 在 `04-已知限制与路线图.md` 的 1.8 里也按**未验证**登记。
> 谁第一次跑完这套流程，请把结果补进本节，并把 1.8 的那一行改成已验证。

**这一步不能跳。** Service Worker 的失败方式是静默的——
页面照常能跑，只是断网后打不开，而开发时几乎不会发现。

### 4.1 部署后首次访问

```
1. 打开你的 Pages 网址，等页面完全加载
2. 刷新一次（关键）
3. F12 → Application → Service Workers
   应看到 sw.js 状态为 "activated and is running"
```

**为什么要刷新一次**：首次访问时 Service Worker 刚安装完，
页面还未处于它的控制之下。

> **本次同步更正**：本段原先写的是「`skipWaiting: false` 意味着它要等到下一次导航才接管」。
> 现在实际配置是 **`skipWaiting: true` + `clientsClaim: true`**（起因见 2.8 的待决策项），
> 新 SW 会立即接管，"刷新一次"**不再是接管的前提**。
> 保留这一步的理由变成了：让下面的核对能看到一个已激活、已在运行的 SW 状态。

### 4.2 验证离线可打开

```
1. F12 → Network 标签 → 勾选 "Offline"（或直接断网）
2. 刷新页面
3. 期望：页面正常打开，出现「已离线」提示条
4. 打开一个已导入的文档 → 期望：正常阅读
```

> **这一条尤其需要真机确认**：它同时验证了两件互相独立的机制 ——
> 导航请求由 NetworkFirst 回退到 `html-navigation` 缓存（2.5），
> 以及首次访问后由 `seedNavigationFallback()` 预置好的那份兜底页面（2.6）。
> 如果 2.6 的兜底没生效，**首次访问后直接断网冷启动会白屏**。

### 4.3 验证缓存内容

```
F12 → Application → Cache Storage
应看到这些缓存：
  workbox-precache-*   ← 18 项应用壳（3,578.19 KiB）
  html-navigation      ← 导航用 HTML。seedNavigationFallback() 会在注册后立即写入 '/'
  pdfjs-wasm           ← 首次导入 PDF 后出现
  ocr-models           ← 首次执行 OCR 后出现（从 HuggingFace CDN 取，约 10 MB）
  onnx-wasm            ← 首次执行 OCR 后出现（从 jsDelivr 取，约 28 MB）
```

> **本次同步更正**：原先这里写的是 `ocr-assets`。`cdf2957` 移除 `tesseract.js` 之后该缓存已不存在，
> 取而代之的是 `ocr-models` 与 `onnx-wasm` 两个（见 2.2），并新增了 `html-navigation`。

### 4.4 验证可安装

```
Chrome / Edge：地址栏右侧出现「安装」图标
Android Chrome：菜单 →「添加到主屏幕」
iOS Safari：分享 →「添加到主屏幕」
```

安装后从桌面图标启动，**没有浏览器地址栏**（`display: standalone`）。

### 4.5 直接抓线上 `sw.js` 核对（已实测，可复现）

这是目前**唯一真正做过**的线上核对，不依赖浏览器交互，随时可以重跑：

```
抓 https://universal-reader.pages.dev/sw.js
  → 应含 NetworkFirst
  → 应含 html-navigation
  → 应不含 createHandlerBoundToURL
```

实测结果见 2.5。另外可核对线上 `index.html` 的响应头：
`Cache-Control: public, max-age=0, must-revalidate`——这条保证浏览器不会拿旧 HTML。

---

## 五、已知限制

> 已解决的与**未解决 / 待决策 / 未验证**的分开列 —— 每条都在「状态」列里标明它属于哪一类，不混写。

| 限制 | 说明 | 状态 |
|---|---|---|
| **首次访问必须先联网** | 这是所有 PWA 的固有性质：Service Worker 本身需要下载 | 固有边界 |
| 预缓存 **3,578.19 KiB** | 首次访问会下载这些内容。相比"离线打不开"，这个代价是值得的 | 固有边界 |
| **首次 OCR 必须先联网** | PaddleOCR 模型（约 10 MB，HuggingFace CDN）与 ONNX Runtime WASM（约 28 MB，jsDelivr）**都不在预缓存清单里**，只在运行时 CacheFirst 缓存 —— 即「**用过一次之后才能离线用**」。首次 OCR 的初始化上限是 180 秒 | 固有边界（随 `cdf2957` 新增） |
| **国内可达性不保证** | 上述两个 CDN 在国内的可达性都不保证；改自托管会撞上 Cloudflare Pages 25 MB 单文件上限 | 新增的外部依赖风险 |
| **`SIMPLETEX_API_KEY` 是部署前提** | Worker 未配置该加密环境变量时，`/api/formula-ocr` **恒返回 500**（`未配置 SIMPLETEX_API_KEY`）。此时 PaddleOCR 主流程仍工作，公式部分退化为原始识别结果 | 部署前提 |
| **公式识别会把页面局部像素上传到第三方云** | `server.simpletex.cn`。这是本项目**第一次把文档内容送出本机**，与「文档全程留在本机」的宣传口径存在**直接张力**；触发是**自动的**（检测到公式候选就发），不需要用户逐次确认 | **未解决**，见 `04-已知限制与路线图.md` 的 1.4 与 R10 |
| **更新策略自相矛盾** | 实际配置是 `autoUpdate` + `skipWaiting: true`，但 UI 与逻辑仍按 prompt 设计：提示条永不出现、SW 激活即自动重载，与 2.4 的设计理由冲突 | **未解决 / 待决策**，见 2.8 |
| **真实浏览器离线行为未验证** | 加载 → 刷新一次 → DevTools 切 Offline → 刷新，**至今没有在真实硬件上做过** | **未验证**，见第四节开头 |
| 开发环境不启用 SW | `devOptions.enabled: false`。开启它会让改动看不到效果——"明明改了代码却没生效"的经典来源 | 刻意设计 |

---

## 六、相关文件

| 文件 | 作用 |
|---|---|
| `vite.config.ts` | `VitePWA(...)` 配置：manifest、workbox、预缓存与运行时缓存、导航路由（2.5）。**226 行** |
| `scripts/make-icons.mjs` | 生成 3 个 PNG 图标（零依赖的 PNG 编码器） |
| `scripts/clean-onnx-wasm.mjs` | 构建后把打进 `dist/` 的 ONNX WASM 删掉（约 28 MB，改由 jsDelivr 在运行时提供） |
| `src/lib/pwa.ts` | Service Worker 注册与在线状态订阅；`onRegisteredSW` 里调用 `seedNavigationFallback()` |
| `src/lib/pwaOffline.ts` | `NAVIGATION_CACHE_NAME` 与 `seedNavigationFallback()`：预置离线兜底页面（2.6） |
| `src/lib/pwaOffline.test.ts` | **8 个用例**：把缓存名与 `vite.config.ts` 钉死，断言导航路由仍是 NetworkFirst |
| `src/lib/preloadRecovery.ts` | 监听 `vite:preloadError`，chunk 错配时提示并自动重载一次（2.7） |
| `src/lib/preloadRecovery.test.ts` | **11 个单测** |
| `src/components/PwaPrompt.tsx` | 三种提示条：有新版本 / 已离线 / 已可离线使用。⚠️ **当前 `autoUpdate` 配置下「有新版本」分支永不触发**（见 2.8） |
| `src/App.tsx` | 挂载提示条 |
| `src/main.tsx` | 应用入口：`installPreloadErrorRecovery()` 在 React 挂载（`createRoot`）之前调用 |
| `index.html` | iOS 需要的 `apple-*` meta（iOS 不读 manifest 的 display 与图标） |
| `scripts/verify-dist.mjs` | 构建产物门禁：`sw.js` 存在与含导航回退、图标齐备、未预缓存无用解码器。实测输出：产物共 **83 个文件，5.54 MB**；WASM 解码器 **7 个，合计 1.41 MB** |
| `worker/api-proxy.ts` | `/api/formula-ocr` 代理：转发到 `server.simpletex.cn`，需要 `SIMPLETEX_API_KEY`（358 行） |
| `src/services/formulaOcrService.ts` | 客户端裁剪区域 → PNG → base64 上传（73 行） |

**iOS 的坑**：Safari 不读 manifest 里的 `display` 与图标，
必须用 `apple-mobile-web-app-capable` 与 `apple-touch-icon` 单独声明，
否则"添加到主屏幕"后会用网页截图当图标、且仍带浏览器地址栏。
