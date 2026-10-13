/**
 * 外发路径的**能力检测与代价文案**（本文件是叶子模块，不 import 任何 store）。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么要有这个文件，以及为什么它必须是叶子
 * ═══════════════════════════════════════════════════════════════
 *
 * 这个应用对外的核心承诺是「文档全程留在本机浏览器，不上传服务器」
 * （`vite.config.ts` 的 PWA manifest）。承诺要成立，就必须能回答一个问题：
 * **现在有哪些功能会把文档内容送出本机？** 而答案必须是机器可读的、
 * 与实际生效的开关一致的东西 —— 不能是一段会过期的文档。
 *
 * 背景：`HANDOFF.md` §1 的 T2 把公式 OCR 记成「**唯一**会把文档内容送出
 * 本机的路径」，而实际有**三条**。文档口径与代码事实差了两倍，
 * 于是「本机外发记录」那个审计缺口的真实大小也是三倍。
 * 这就是把清单放进代码、并由设置面板直接渲染的理由：
 * 声明与实现之间没有可以各自漂移的空隙。
 *
 * ⚠️ **本文件里有两份清单，不是一个**：上面那份说「什么会外发」，
 * 文件下半部那份说「什么**绝不**外发」（排除清单）。只有会外发的那份
 * 是一句不完整的承诺 —— 用户真正想知道的是「我的文件、我的批注、
 * 我的进度，到底哪一样会离开这台机器」。排除清单的写法借自 MinerU 的
 * 遥测声明（它逐项写明「不收集什么」，并给出可操作命令）。
 * 两份清单**必须互不重叠**，且这个不重叠本身是被测试钉住的。
 *
 * ⚠️ **本文件不能 import `@/store/*`**。理由是可验证的，不是洁癖：
 * `store/settingsStore.ts` 要用这里的类型与能力常量来决定**初始状态**，
 * 如果这里反过来 import store，就形成 `store ⇄ lib` 的循环依赖。
 * 在 ESM 里那会得到一个「按模块求值顺序而定」的初始化结果 ——
 * 一个只在某些打包顺序下才出现的、极难复现的 bug。
 * 所以这里只放**纯函数与常量**；需要读实时开关状态的
 * `listOutboundPaths()` 放在 `services/translationService.ts`（那里
 * 单向依赖 store，没有环）。
 */

/** 翻译引擎标识。定义在这里而不是 store 里，正是为了打断上面说的那个环。 */
export type TranslationEngineId = 'deepl' | 'openai' | 'browser';

/** 浏览器内置翻译 API 的全局名字。检测与文档用同一个出处。 */
export const BROWSER_TRANSLATOR_GLOBAL = 'Translator';

/** 云端翻译代理是否已配置（构建期环境变量）—— 这是**能力**，不是**许可** */
export function hasCloudTranslationConfig(): boolean {
  return Boolean(import.meta.env.VITE_TRANSLATE_ENDPOINT);
}

/** 云端语音代理是否已配置 —— 同样是**能力**，不是**许可** */
export function hasCloudTtsConfig(): boolean {
  return Boolean(import.meta.env.VITE_TTS_ENDPOINT);
}

/**
 * 浏览器是否具备内置翻译能力（`Translator` API）。
 *
 * `Translator` 是**实验性、非 Baseline** 的 API —— MDN 页面顶部标着
 * 「Limited availability / Experimental」，并写明
 * *"This feature is not Baseline because it does not work in some of the
 * most widely-used browsers."*
 * （<https://developer.mozilla.org/en-US/docs/Web/API/Translator>，
 * 本次实测抓取 HTTP 200）。Firefox 上没有它，而那是本项目用户主用的浏览器。
 *
 * 反过来也**不能假定它不存在**：Chromium 系上有，将来别的浏览器也可能实现。
 * 所以这里既不是 `true` 也不是 `false`，而是每次实地读一次全局对象，
 * 并且是 `typeof === 'function'`（静态方法挂在构造函数上）或 `'object'`
 * （不同实现对命名空间的暴露方式不同）两种形态都接受 —— 只认一种，
 * 会在某个浏览器上把「可用」误判成「不可用」。
 */
export function detectBrowserTranslator(): boolean {
  if (typeof globalThis === 'undefined') return false;
  const api = (globalThis as Record<string, unknown>)[BROWSER_TRANSLATOR_GLOBAL];
  return typeof api === 'function' || (typeof api === 'object' && api !== null);
}

/** `Translator` 的姊妹 API（同一份规范），用于拿到合法的源语言标签 */
export function detectLanguageDetector(): boolean {
  if (typeof globalThis === 'undefined') return false;
  const api = (globalThis as Record<string, unknown>).LanguageDetector;
  return typeof api === 'function' || (typeof api === 'object' && api !== null);
}

/**
 * 三条外发路径的静态说明。
 *
 * `key` 与 `store/settingsStore.ts` 里的字段名逐字一致 —— 测试会拿它去
 * `getState()` 里取真实值，所以「清单里写的」与「实际生效的」不可能不一致。
 */
export interface OutboundPathSpec {
  key: OutboundPathKey;
  title: string;
  /** ③ 代价透明：什么内容、发到哪、为什么需要 */
  detail: string;
}

export type OutboundPathKey =
  | 'formulaOcrEnabled'
  | 'cloudTranslationConsent'
  | 'ttsCloudConsent';

/**
 * 顺序即显示顺序。三条都必须满足四要素：
 * ① 默认关闭 ② 用户显式同意 ③ 代码层第二道防线 ④ 代价透明。
 */
export const OUTBOUND_PATH_SPECS: readonly OutboundPathSpec[] = [
  {
    key: 'formulaOcrEnabled',
    title: '公式识别增强',
    detail:
      '把页面上裁剪出的公式区域（一小块 PNG）发到自建 Worker，再转发给第三方 SimpleTex 换 LaTeX。为什么需要：本地模型认不出公式，只能得到乱码。',
  },
  {
    key: 'cloudTranslationConsent',
    title: '云端翻译',
    detail:
      '把正在阅读的段落正文，或用户主动选中并点击查译的文字，发到自建 Worker，再转发给 DeepL 或 OpenAI 换取译文。选区查译只发送所选文字，不自动附带上下文。为什么需要：浏览器内置翻译在多数浏览器上不可用，且质量不如云端。',
  },
  {
    key: 'ttsCloudConsent',
    title: '云端语音合成',
    detail:
      '把正在朗读的段落正文发到自建 Worker，再转发给 Azure 语音服务换音频。为什么需要：浏览器原生音色取决于操作系统，长文本还会被截断。',
  },
] as const;

/** 某条路径在此部署上是否具备能力（端点已配置 / 浏览器有该 API） */
export function outboundPathCapable(key: OutboundPathKey): boolean {
  switch (key) {
    case 'formulaOcrEnabled':
      // 公式 OCR 与翻译共用同一个 Worker 端点（见 worker/api-proxy.ts 的路由）
      return hasCloudTranslationConfig();
    case 'cloudTranslationConsent':
      return hasCloudTranslationConfig();
    case 'ttsCloudConsent':
      return hasCloudTtsConfig();
  }
}

/** 「本机外发记录」清单里的一项（含**实时**开关状态） */
export interface OutboundPathStatus extends OutboundPathSpec {
  /** 此刻是否真的会外发 */
  enabled: boolean;
  /** 该路径在此部署上是否具备能力 */
  capable: boolean;
}

// ═══════════════════════════════════════════════════════════════
// 二、「绝不外发」清单（排除清单）
// ═══════════════════════════════════════════════════════════════
//
// ⚠️ 写这份清单的纪律（来自 MinerU 那条声明的教训，也是本次最容易
// 犯错的地方）：**每一项都必须能对应到一条可以被断言的代码事实**。
// 做不到断言的项**不要写** —— 一句无法验证的「永不外发」比不说更糟，
// 因为它把「承诺」变成了「文案」。
//
// 所以每一项都带三个字段，缺一不可：
//   · `claim`  —— 声明（对用户说的话）
//   · `basis`  —— 依据（代码里**具体是哪个东西**保证的）
//   · `verify` —— 可验证方式（哪条测试、怎么核对）
//
// 以及一个机械字段 `forbiddenPayloadKeys`：**如果这一项外泄了，
// 它会在请求体里以什么字段名出现**。这个字段的存在是为了让
// 「排除清单 ∩ 实际请求体 = ∅」成为一条**非平凡**的断言 ——
// 两个空集合永远不相交，那种不重叠是假保护。
//
// ⚠️ 本次逐条核实的结论里有一条是**否定**的：**页面像素确实会外发**
// （公式增强开启时），而且上传的裁剪块**没有面积上界**。所以排除清单里
// **没有**「页面图像」这一项 —— 它不是被漏掉了，是被核实掉了。
// 这些「以为不该外发、其实会外发」的东西单列在 `NOT_EXCLUDED_SPECS`，
// 并且同样被测试钉住（防止有人为了清单好看把它们挪进排除清单）。

/** 「绝不外发」的每一项 */
export type ExcludedDataKey =
  | 'sourceFileBytes'
  | 'fileNameAndPath'
  | 'libraryCatalogue'
  | 'annotationsAndNotes'
  | 'readingProgress'
  | 'translationCacheContents'
  | 'apiKeysAndTokens'
  | 'telemetryAndIdentifiers'
  | 'annotationSearchQuery';

export interface ExcludedDataSpec {
  key: ExcludedDataKey;
  title: string;
  /** 声明：什么内容在任何开关状态下都不会离开本机 */
  claim: string;
  /** 依据：代码里是什么保证的（必须点名文件与机制） */
  basis: string;
  /** 可验证方式：怎么核对（测试用例名 / 命令） */
  verify: string;
  /**
   * 这一项若外发，会在请求体里出现的字段名。
   * **不允许为空** —— 空的排除项无法被证伪。
   */
  forbiddenPayloadKeys: readonly string[];
}

/**
 * 顺序即显示顺序。
 *
 * ⚠️ 三条**没有**写进来的东西，以及为什么（都是核实后的结论，不是省略）：
 *   · **页面图像** —— 公式增强开启时会外发，见 `NOT_EXCLUDED_SPECS`；
 *   · **书签** —— 本项目**没有书签功能**，只有阅读进度（`progress` 表）；
 *     写一个不存在的功能等于写一句无法证伪的话；
 *   · **全文搜索词** —— 本项目**没有全文搜索**（`HANDOFF.md` §8 R4 仍是待办）；
 *     只有批注侧栏的本地过滤，那一条单列为 `annotationSearchQuery`。
 */
export const EXCLUDED_DATA_SPECS: readonly ExcludedDataSpec[] = [
  {
    key: 'sourceFileBytes',
    title: '文档原始文件字节',
    claim:
      '你导入的 PDF / EPUB / DOCX / Markdown / TXT 文件**本身**（字节流）在任何开关状态下都不会被发送。本应用只在浏览器里解析它，不转发它。',
    basis:
      '解析全部在浏览器内完成（src/parsers/）。三个外发请求体逐个走查过：公式增强只带 image（页内裁剪的 base64 PNG），云端翻译与云端语音只带 text 等字段 —— 三者都没有能承载 File / Blob / ArrayBuffer 的字段。整个 src/ 里没有 FormData，也没有 multipart/form-data。',
    verify:
      'outboundExclusions.test.ts「运行期抓包」三条用例把真实请求体的键集合抓下来逐个断言；「排除清单与实际请求体不相交」用例断言本项声明的字段名与请求体键无交集。',
    forbiddenPayloadKeys: [
      'file',
      'files',
      'fileData',
      'fileBytes',
      'blob',
      'buffer',
      'arrayBuffer',
      'formData',
      'upload',
      'documentBytes',
    ],
  },
  {
    key: 'fileNameAndPath',
    title: '文件名与文件路径',
    claim:
      '文档的文件名（metadata.sourceFile）与任何文件系统路径都不会外发。',
    basis:
      'sourceFile 全仓库只有三处引用：lib/utils.ts 写入元数据、lib/db.ts 折进**本地** IndexedDB 的 searchText（书库列表检索用）、components/DocumentLibrary.tsx 渲染出来。三个外发函数的入参里根本没有文档对象 —— translateBlock(block, …) 只拿 ContentBlock、speak(text, …) 只拿字符串、recognizeFormula(canvas) 只拿画布。',
    verify:
      'outboundExclusions.test.ts：非测试 src/ 里搜不到 sourceFile 出现在任何网络站点文件中（NETWORK_SITE_SPECS 的 outbound 项）；运行期抓包的键集合与声明的字段名逐一比对。',
    forbiddenPayloadKeys: [
      'fileName',
      'filename',
      'sourceFile',
      'filePath',
      'path',
      'docTitle',
      'title',
    ],
  },
  {
    key: 'libraryCatalogue',
    title: '书库目录（列表、标题、作者、页数）',
    claim:
      '书库里有哪些文档、它们的标题、作者、页数与导入时间，都不会外发。',
    basis:
      '书库只落在本地：store/libraryStore.ts → lib/db.ts（Dexie 的 documents / blocks 两张表）。唯一读它的外发相关模块是 hooks/useViewportTranslation.ts，而它读 currentDoc 只是为了取出**当前这一段正文**，随后交给 translateBlock 的只有 block.content（见 blockText 那一项）。',
    verify:
      'outboundExclusions.test.ts：声明字段名列在 forbiddenPayloadKeys 里，且与运行期抓到的请求体键集合无交集。',
    forbiddenPayloadKeys: [
      'library',
      'documents',
      'catalogue',
      'docId',
      'documentId',
      'author',
      'pageCount',
      'docCount',
    ],
  },
  {
    key: 'annotationsAndNotes',
    title: '批注与高亮（笔记正文、标签、锚点引文）',
    claim:
      '你写的笔记、打的标签、高亮时选中的那句原文，都不会外发 —— 批注既不参与朗读，也不参与翻译。',
    basis:
      'store/annotationsStore.ts 与 components/AnnotationSidebar.tsx 的 import 列表里没有任何网络或外发模块（只有 Dexie、类型、zustand、图标）；批注只落在 IndexedDB 的 annotations 表。朗读读的是 block.content（hooks/useTtsReader.ts 调 engine.speak(block.content, …)），翻译读的也是 ContentBlock（hooks/useViewportTranslation.ts 调 translateBlock(block, …)）—— 批注是**另一个 store**，两条路都拿不到它。',
    verify:
      'outboundExclusions.test.ts：断言 annotationsStore.ts / AnnotationSidebar.tsx 的源码里没有出现任何网络原语；并断言 forbiddenPayloadKeys 与运行期请求体键无交集。',
    forbiddenPayloadKeys: [
      'annotations',
      'annotation',
      'notes',
      'note',
      'highlight',
      'tags',
      'anchor',
      'quote',
      'selectedText',
      'comment',
    ],
  },
  {
    key: 'readingProgress',
    title: '阅读进度',
    claim: '你读到第几段（progress 表）不会外发。',
    basis:
      'saveProgress / loadProgress（lib/db.ts）只被 components/ReaderView.tsx 调用，读写都在 IndexedDB。⚠️ 本项目**没有书签功能**，只有阅读进度（blockIndex / updatedAt）—— 所以这一项的声明里不写「书签」，写一个不存在的功能等于写一句无法证伪的话。',
    verify:
      'outboundExclusions.test.ts：progress 的字段名与运行期请求体键无交集。',
    forbiddenPayloadKeys: [
      'progress',
      'blockIndex',
      'scrollTop',
      'lastReadAt',
      'readingPosition',
    ],
  },
  {
    key: 'translationCacheContents',
    title: '译文缓存的内容',
    claim:
      '已经缓存下来的译文不会被任何请求发送；**命中缓存时一个请求都不发**。',
    basis:
      'translateBlock 的顺序是「内存 → IndexedDB 缓存 → 网络」（services/translationService.ts）：缓存命中在 fetch 之前就 return 了。缓存只被读来当译文用，从不作为请求体。⚠️ 边界：缓存**未命中**时，被翻译的那段**原文**会外发 —— 那是 blockText 那一项，不是这一项。',
    verify:
      'outboundExclusions.test.ts 的「缓存命中 ⇒ 零请求」用例：把 getCachedTranslation 换成命中值，断言 fetch 一次都没被调用、且结果标记为 cached。',
    forbiddenPayloadKeys: [
      'translations',
      'translationCache',
      'cache',
      'cachedTranslation',
      'translatedText',
    ],
  },
  {
    key: 'apiKeysAndTokens',
    title: 'API 密钥与访问令牌',
    claim:
      '本应用的前端**不存在**任何密钥 —— 没有密钥可泄漏，也没有密钥会随请求发出去。',
    basis:
      'VITE_TRANSLATE_ENDPOINT / VITE_TTS_ENDPOINT 只是**端点地址**，密钥存在自建 Worker 的环境变量里（worker/api-proxy.ts 读 env，浏览器拿不到）。前端能读到的构建期变量被 ENV_VAR_SITE_SPECS 钉成封闭清单，里面**没有**任何 *_KEY / *_TOKEN 形态的名字 —— 也就是说前端连一个能装密钥的变量都没有。',
    verify:
      'outboundExclusions.test.ts 的「前端零密钥」用例（两条，都不靠脆弱的字符串匹配）：① 扫描非测试 src/ 得到的 VITE_* 名字集合必须等于 ENV_VAR_SITE_SPECS，且其中不含 KEY/TOKEN/SECRET；② **运行期**把三条请求真的抓下来，断言请求头里没有 authorization / x-api-key / api-key，且请求体的键与 forbiddenPayloadKeys 无交集。',
    forbiddenPayloadKeys: [
      'apiKey',
      'api_key',
      'token',
      'accessToken',
      'secret',
      'authorization',
      'key',
    ],
  },
  {
    key: 'telemetryAndIdentifiers',
    title: '遥测、使用统计、崩溃上报、用户标识',
    claim:
      '本应用不含任何遥测 / 统计 / 崩溃上报代码：不收集使用数据，不生成 userId，不发心跳。这一条比 MinerU 的遥测声明更强 —— 它是**零**，不是「可关闭」。',
    basis:
      'package.json 的生产依赖里没有任何分析类库；非测试 src/ 里没有 sendBeacon / WebSocket / EventSource / XMLHttpRequest。**网络原语的全集**是 5 个文件共 6 处（见 NETWORK_SITE_SPECS）：3 处是三条外发路径，另外 3 处是模型下载与同源探测。「会话诊断」（lib/sessionDiagnostics.ts）与「复制识别结构」都只写 localStorage / 剪贴板，不联网。',
    verify:
      'outboundExclusions.test.ts 的「网络原语是封闭集合」用例：扫描非测试 src/，逐文件比对出现次数；新增任何一个站点都会让集合不相等而变红。',
    forbiddenPayloadKeys: [
      'telemetry',
      'event',
      'events',
      'analytics',
      'metrics',
      'deviceId',
      'userId',
      'sessionId',
      'fingerprint',
      'screen',
      'userAgent',
      'crashReport',
    ],
  },
  {
    key: 'annotationSearchQuery',
    title: '批注侧栏搜索框里输入的文字',
    claim: '在批注侧栏搜索时输入的词只用于本地过滤，不会外发。',
    basis:
      'components/AnnotationSidebar.tsx 的搜索框只做本地过滤（对已加载的批注数组做 useMemo 过滤），不发请求。⚠️ 本项目**没有全文搜索功能**（HANDOFF.md §8 R4 仍是待办），所以清单里不写「全文搜索词」—— 一个不存在的功能无法被断言为不外发。',
    verify:
      'outboundExclusions.test.ts：断言 AnnotationSidebar.tsx 的源码里没有网络原语；并断言 forbiddenPayloadKeys 与运行期请求体键无交集。',
    forbiddenPayloadKeys: ['query', 'searchQuery', 'keyword', 'search'],
  },
] as const;

// ───────────────────────────────────────────────────────────────
// 排除清单的**边界**：核实后发现确实会外发、因此不得写进排除清单的东西
// ───────────────────────────────────────────────────────────────
//
// ⚠️ 这一段是本次任务里最重要的部分。上面那份清单要成立，
// 前提是下面这些东西**不在**里面。所以它们不是注释，是可断言的数据：
// 测试会检查「排除清单 ∩ 本清单 = ∅」以及「本清单非空且覆盖了
// 页面像素与正文这两项」—— 将来有人为了清单好看把「页面图像」
// 挪进排除清单，会立刻变红。

export type NotExcludedKey =
  | 'pageRasterCrop'
  | 'blockText'
  | 'systemVoiceName'
  | 'requestTransportMetadata';

export interface NotExcludedSpec {
  key: NotExcludedKey;
  title: string;
  /** 它由哪条（或哪几条）外发路径送出 */
  outboundPaths: readonly OutboundPathKey[];
  /** 它在请求体里的字段名；纯粹传输层的事实用空数组 */
  payloadKeys: readonly string[];
  why: string;
}

export const NOT_EXCLUDED_SPECS: readonly NotExcludedSpec[] = [
  {
    key: 'pageRasterCrop',
    title: '页面像素的裁剪块',
    outboundPaths: ['formulaOcrEnabled'],
    payloadKeys: ['image'],
    why:
      '公式增强开启时，ocrEngine.enhanceFormulaRegions 把候选区域用 cropCanvas 裁出来、编码成 PNG、以 base64 放进 {image} 发到第三方 SimpleTex。所以「页面图像不外发」是**错的**，排除清单里没有这一项。⚠️ 面积上界：**以前没有**（本项目核实过：800×1000 全墨迹页面 + 一个 16×16 词框 → 最大候选覆盖 100.0% 页面，而且真的被发了出去）；现在**发送决定**之前有一道面积闸门 —— `lib/outboundFormulaGate.ts` 的 OUTBOUND_FORMULA_MAX_REGION_AREA_RATIO = 0.3，被挡下的候选记进导出结构的 outboundFormulaSkips（用户看得见）。⚠️ 但它**仍然不能**进排除清单：闸门只是把上界从「整页」压到「三成页面」，「页面像素不外发」这句话依旧为假；而且那条**检测**路（lib/ocrInkRegions.ts 的 detectMissedInkRegions）本身仍然不设面积上限，上界只存在于会外发的那条路上。字节数上界是另一道：formulaOcrService 的 MAX_IMAGE_SIZE = 2_000_000。',
  },
  {
    key: 'blockText',
    title: '正在翻译 / 朗读的正文片段',
    outboundPaths: ['cloudTranslationConsent', 'ttsCloudConsent'],
    payloadKeys: ['text', 'context'],
    why:
      '视口翻译与云端语音会发送当前段落正文（hooks/useViewportTranslation.ts 与 hooks/useTtsReader.ts）；选区查译只会发送用户主动选中的文字（components/ReaderView.tsx → services/translationService.ts），不会自动附带上下文。所以「文档正文不外发」也是**错的**。三条路径现在均有显式 opt-in。',
  },
  {
    key: 'systemVoiceName',
    title: '系统音色名（voice）',
    outboundPaths: ['ttsCloudConsent'],
    payloadKeys: ['voice'],
    why:
      '云端语音的请求体里带 voice: options.voiceName —— 那是**用户系统上装的音色名**（例如 Microsoft Huihui - Chinese (Simplified)）。它不是文档内容，但它确实能透露操作系统与语言环境。所以「不外发任何设备信息」这句话不能写进排除清单。',
  },
  {
    key: 'requestTransportMetadata',
    title: 'HTTP 传输层元数据（IP / Referer）',
    outboundPaths: ['formulaOcrEnabled', 'cloudTranslationConsent', 'ttsCloudConsent'],
    payloadKeys: [],
    why:
      '任何 HTTP 请求都会把来源 IP 交给服务端，这是传输层事实，不是本项目写下的采集代码。另外三条外发路径的请求都没有设 referrerPolicy（只有模型下载 lib/ocrCharBoxes.ts 设了 no-referrer）：跨源时会按浏览器默认带上**站点 origin**（不含路径与查询串），走同源代理时会带上完整路径。所以「不留任何网络痕迹」这句话也不能写。',
  },
] as const;

// ───────────────────────────────────────────────────────────────
// 请求体的**逐字**字段清单：非重叠断言靠它才不是空的
// ───────────────────────────────────────────────────────────────

export interface OutboundPayloadSpec {
  path: OutboundPathKey;
  method: 'POST';
  /** 端点来自哪个构建期环境变量 */
  endpointEnv: string;
  /**
   * 请求体里**允许出现**的字段名，与实际 JSON.stringify 的键逐字一致。
   * 测试会真的抓一次请求体，双向比对（不多、不少）。
   */
  fields: readonly string[];
}

export const OUTBOUND_PAYLOAD_SPECS: readonly OutboundPayloadSpec[] = [
  {
    path: 'formulaOcrEnabled',
    method: 'POST',
    endpointEnv: 'VITE_TRANSLATE_ENDPOINT',
    fields: ['image'],
  },
  {
    path: 'cloudTranslationConsent',
    method: 'POST',
    endpointEnv: 'VITE_TRANSLATE_ENDPOINT',
    fields: ['text', 'targetLang', 'context', 'engine'],
  },
  {
    path: 'ttsCloudConsent',
    method: 'POST',
    endpointEnv: 'VITE_TTS_ENDPOINT',
    fields: ['text', 'lang', 'rate', 'pitch', 'voice'],
  },
] as const;

// ───────────────────────────────────────────────────────────────
// 网络原语与远程地址的**封闭清单**：新增一条外发路径会在这里变红
// ───────────────────────────────────────────────────────────────
//
// ⚠️ 上面那份排除清单有一个致命弱点：它是**静态声明**。
// 只要没人更新它，它就会在「有人加了一条新的外发路径」之后
// **继续显示为真** —— 这正是本项目已经踩过的坑（HANDOFF §1 T2 把
// 三条外发路径记成了一条，缺口因此被低估成三分之一）。
//
// 所以还需要第三层：把「整个 src/ 里能做网络请求的地方」也变成
// 一份**封闭清单**并逐文件计数。测试会扫描所有非测试源码，把
// 实际出现的网络原语与这份清单逐一比对：
//   · 新文件里出现 fetch( / sendBeacon / WebSocket / EventSource /
//     XMLHttpRequest  → 集合不相等 → **红**；
//   · 既有文件里多出一处          → 计数不相等 → **红**；
//   · 新写死一个远程地址          → 远程地址清单不相等 → **红**。
// 也就是说「加一条外发路径」这件事**会失败，而不是悄悄通过**。

/**
 * 被扫描的网络原语（与测试里的实现同一份字符串）。
 *
 * 不含动态 `import()`：本项目用它来懒加载**本地**分块（如 ocrEngine），
 * 加进来会让清单被本地分块淹掉，反而看不出真正的远程站点。
 */
export const NETWORK_PRIMITIVE_PATTERN =
  '\\bfetch\\s*\\(|navigator\\s*\\.\\s*sendBeacon\\s*\\(|new\\s+WebSocket\\s*\\(|new\\s+EventSource\\s*\\(|new\\s+XMLHttpRequest\\s*\\(';

export type NetworkSiteRole =
  /** 会把文档内容**发出去**（受某条外发路径的开关控制） */
  | 'outbound'
  /** 只**取回**远端资源（模型 / WASM），不携带文档内容 */
  | 'download'
  /** 同源探测，不携带任何文档内容 */
  | 'same-origin';

export interface NetworkSiteSpec {
  /** 相对仓库根的路径，正斜杠 */
  file: string;
  role: NetworkSiteRole;
  /** role 为 outbound 时：它属于哪条外发路径 */
  path?: OutboundPathKey;
  /** 该文件里网络原语的出现次数（剥离注释之后计数） */
  count: number;
  what: string;
}

export const NETWORK_SITE_SPECS: readonly NetworkSiteSpec[] = [
  {
    file: 'src/services/formulaOcrService.ts',
    role: 'outbound',
    path: 'formulaOcrEnabled',
    count: 1,
    what: 'POST 公式区域裁剪图（base64 PNG）到自建 Worker',
  },
  {
    file: 'src/services/translationService.ts',
    role: 'outbound',
    path: 'cloudTranslationConsent',
    count: 1,
    what: 'POST 当前请求翻译的文本到自建 Worker（段落或选中文字）',
  },
  {
    file: 'src/services/ttsEngine.ts',
    role: 'outbound',
    path: 'ttsCloudConsent',
    count: 1,
    what: 'POST 朗读文本到自建 Worker（CloudTTSEngine.fetchChunk）',
  },
  {
    file: 'src/lib/ocrCharBoxes.ts',
    role: 'download',
    count: 2,
    what: 'GET 识别模型与字典（本机 public/ocr-models 或 VITE_OCR_MODEL_BASE），不携带任何文档内容',
  },
  {
    file: 'src/lib/pwaOffline.ts',
    role: 'same-origin',
    count: 1,
    what: "GET '/' 探测导航回退页是否已在缓存里",
  },
] as const;

/**
 * 写死在代码里的远程地址（剥离注释之后统计）。
 *
 * 这些**全部只用于下载**：ONNX Runtime 的 WASM 来自 jsDelivr，
 * OCR / 版面模型的镜像地址来自 ocrModelSource（默认走同源，见
 * `ocrModelSource.ts` 的 resolveModelBase）。
 */
export interface RemoteUrlSiteSpec {
  file: string;
  count: number;
  what: string;
}

export const REMOTE_URL_SITE_SPECS: readonly RemoteUrlSiteSpec[] = [
  {
    file: 'src/lib/layoutAnalysis.ts',
    count: 1,
    what: 'ort.env.wasm.wasmPaths 指向 cdn.jsdelivr.net（WASM 运行时，仅下载）',
  },
  {
    file: 'src/lib/ocrEngine.ts',
    count: 1,
    what: 'ort.env.wasm.wasmPaths 指向 cdn.jsdelivr.net（WASM 运行时，仅下载）',
  },
  {
    file: 'src/lib/ocrModelSource.ts',
    count: 4,
    what: 'OCR 与版面模型的官方/镜像 base（默认不生效，见 resolveModelBase）',
  },
] as const;

/**
 * 构建期环境变量的**封闭清单**。
 *
 * 加一条外发路径通常从「加一个端点环境变量」开始，
 * 所以这里也钉一道：非测试 src/ 里出现的 VITE_* 名字必须就是这个集合。
 */
export interface EnvVarSiteSpec {
  name: string;
  role: NetworkSiteRole | 'config';
  what: string;
}

export const ENV_VAR_SITE_SPECS: readonly EnvVarSiteSpec[] = [
  {
    name: 'VITE_TRANSLATE_ENDPOINT',
    role: 'outbound',
    what: '云端翻译与公式增强共用的自建代理端点',
  },
  { name: 'VITE_TTS_ENDPOINT', role: 'outbound', what: '云端语音的自建代理端点' },
  {
    name: 'VITE_DEFAULT_TRANSLATE_ENGINE',
    role: 'config',
    what: '界面初始引擎，只是初始值、不等于同意',
  },
  { name: 'VITE_OCR_MODEL_BASE', role: 'download', what: 'OCR 模型下载来源' },
  { name: 'VITE_OCR_LAYOUT_MODEL_BASE', role: 'download', what: '版面模型下载来源' },
  { name: 'VITE_OCR_USE_WEBGPU', role: 'config', what: '是否允许 WebGPU 推理' },
  { name: 'VITE_OCR_LAYOUT', role: 'config', what: '版面分析总开关' },
] as const;
