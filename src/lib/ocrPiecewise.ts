/**
 * 跨行大括号分段函数的版面重组（KaTeX `cases`）。
 *
 * ═══════════════════════════════════════════════════════════════
 * 这一层要解决的问题（用户报障的原文）
 * ═══════════════════════════════════════════════════════════════
 *
 * 「为什么你还是不能显示跨行的大括号「{」？」
 *
 * 扫描件里的分段函数是这样排的：
 *
 *            λe^{−λx},  x > 0
 *     f_X(x) = {                     ← 大括号跨两行
 *            0,         x ≤ 0
 *
 * 而识别器的检测框是按**墨迹块**切的，这个形状会被切成：
 *  · 上分支单独一个词（实测 `(λe−x, x>0`）—— 大括号的上钩常被认成 `(`；
 *  · **标签 + 大括号 + 下分支**合成一个「高词」（实测 `fx(x) = { 0, x ≤ 0`）：
 *    它的框高 52px 是参考字号 36px 的 **1.44 倍** —— 高出来的部分正是
 *    「这个词框同时盖住了标签行与下分支行」这一事实；
 *  · 上分支与高词之间**严丝合缝**（gap = 0）：它们本来就是紧挨着的两行。
 *
 * 成行时上分支与高词会落到不同的行里（见 `mergeContainedBranches`），
 * 输出成两个互不相干的段落，大括号只开向「下分支」那一行 ——
 * 这正是用户看到的「没有跨行大括号」。
 *
 * ═══════════════════════════════════════════════════════════════
 * 办法：把两行重新装回一个构造，交给 KaTeX 渲染带大括号的公式
 * ═══════════════════════════════════════════════════════════════
 *
 * 输出形态（`BlockRow.tsx` 的 `type:'math'` 分支已支持显示级公式）：
 *
 *   fx(x) =\begin{cases} λe−x, x>0 \\ 0, x ≤ 0 \end{cases}
 *
 * ── 判据全部来自实测几何（习题5 第 1 页，画布 1667×2223，参考字号 36）──
 *
 *  ① 锚点（构造头）：框高 ≥ 参考字号 × 1.35，文本以「标签 = 构造符」开头
 *     · 构造符通常是 `{`：f_X/f_Y 合并词 h=52（1.44 倍）✓、Z 词 h=52 ✓、
 *       f_z 词 h=64（1.78 倍）✓；
 *     · 构造符也可以是**误读形态**：大括号上钩被认成关系符
 *       （第 24 题实测 `f(x,y) = ≥(x +y)…`，h=56）—— 关系符语法上不可能
 *       紧跟 `=`，出现在构造位就只可能是大括号的替身（见 `CONSTRUCT_SRC`）；
 *     · 第 17 题的长句也含 `{`（`P {X = x…}`）但 h=43 → 拒。
 *
 *  ② 分支行：横向中心落在锚点跨度内，纵向空隙 ≤ 参考字号 × 1.4（=50.4px）
 *     · 实测空隙：上分支 0px、下分支 8px、24 题下分支 12px ✓；
 *     · Z 的上分支与 f_X 锚点的空隙 67px → 只归 Z、不归 f_X；
 *     · f_z 下方的正文行空隙 52px → 拒（正是 1.4 倍这条线）。
 *
 *  ③ 分支得**像公式行**：清洗后 ≤ 12 字符、含数字或数学符号、连续汉字 ≤ 2
 *     · 默认逐词判定；行里有词**单独当不了分支**时，整行并起来再判：
 *       24 题的下分支是 `0，` 与 `其他`（相距 119px，`其他` 单独不含数学
 *       符号），并成 `0， 其他` 才是一份完整分支；并起来也不像公式行就
 *       退回逐词（20 题并排的两个上分支并起来 18 字 > 12，仍然各自成支）；
 *     · 排除同页的散文（`其中λ>0，μ>0是常数.引入随机变量` 19 字、
 *       `验证随机变量 Z = √X2 + Y 的概率密度为` 更长）。
 *
 *  ④ 结构自洽：每个构造**恰好两行** —— 锚点自带一行 + 恰好一侧的一行分支
 *     · 上分支数既不是 0 也不是构造数 → 拒（无法可靠配对）；
 *     · 配对按横向位置的比例分桶，每个构造必须恰好分到一个，否则拒 ——
 *       宁可不重组，也不把别的构造的分支塞进来。
 *
 *  ⑤ 最终 TeX 过 KaTeX **验证门**（`throwOnError: true`）：渲染不出来就整个
 *     放弃这个锚点（保留原有的段落输出，一个字不丢）。
 *
 * ⚠️ 本版**不发明内容**：识别出的字一个不增不减，只做「清理大括号残影」
 * （`_(` 前缀、悬空的 `^`）与版面重排。上分支里丢掉的指数
 * （`λe^{−λx}` 被认成 `λe−x`）是识别本身的极限，这里不猜。
 */
import katex from 'katex';
import type { OcrWord } from '@/lib/ocrTypes';

/** 参与重组的最小行结构（`ocrPostProcess` 的 OcrLine 在结构上兼容） */
export interface PiecewiseLineLike {
  words: OcrWord[];
  text: string;
}

export interface PiecewisePlan {
  /** 含构造头（`{` 或误读成关系符的替身）的锚点词：它的行将被改写为独立公式块 */
  anchor: OcrWord;
  /** 整段 LaTeX（一个锚点里有两个构造时用 `\qquad` 并排） */
  latex: string;
  /** 被并入公式、应从各自原行摘掉的分支词 */
  claimed: OcrWord[];
}

/** 锚点词的最小框高（参考字号倍数）。实测 1.44 / 1.78 通过、1.19 被拒。 */
export const PIECEWISE_ANCHOR_MIN_HEIGHT_RATIO = 1.35;
/** 分支词到锚点的最大纵向空隙（参考字号倍数）。实测 0px / 8px 通过、52px 被拒。 */
export const PIECEWISE_BRANCH_MAX_GAP_RATIO = 1.4;
/** 分支词的最大字符数（超过就按正文看待）。实测分支最长 11 字、散文最短 19 字。 */
export const PIECEWISE_BRANCH_MAX_CHARS = 12;

/**
 * 「标签 + 等号 + 构造符」的形状：`fx(x) = {`、`Z = {`、`fz(z) = {`，
 * 以及大括号被误读时的替身形态 `f(x,y) = ≥`。
 *
 * 标签只允许「1–4 个字母数字 + 可选的小括号参数」：真实标签是 `fx(x)`、
 * `fy(y)`、`fz(z)`、`Z` 这样的名字，不可能是别的形状。写宽了会把
 * 公式里的任意 `= {` 都当成构造头。
 *
 * 替身只收**关系符**（`≥ ≤ > < ≠`）：它们语法上不可能紧跟 `=`，出现在
 * 「标签 = 构造符」的位置就只可能是大括号的误读（第 24 题实测上钩被认成
 * `≥`）。`∑` 不在其列 —— `f(x) = ∑…` 是合法的级数写法，收它会把正常
 * 公式误判成分段函数。匹配顺序是「先 `=` 后关系符」，所以 `a >= b`
 * 这类「先关系符后等号」的写法不会匹配。
 */
const CONSTRUCT_SRC =
  '([A-Za-zα-ωΑ-Ω][A-Za-z0-9α-ωΑ-Ω]{0,3}\\s*(?:\\([^()\\s]{0,6}\\))?\\s*=\\s*)(\\{|[≥≤><≠])';
/** 分支行该有的数学痕迹：数字 / 希腊字母 / 比较符 / 根号 / 角标 */
const BRANCH_HINT_RE = /[0-9λμσαβγθφ≤≥−√²^_=]/;
/** 连续 3 个以上汉字按正文看待（真实分支 `0， 其他` 只有 2 个汉字） */
const PROSE_CJK_RUN_RE = /[\u4e00-\u9fff]{3,}/;
const OPEN_PAREN_CHARS = '（(';
const CLOSE_PAREN_CHARS = '）)';

const heightOf = (word: OcrWord): number => word.bbox.y1 - word.bbox.y0;
const centerX = (word: OcrWord): number => (word.bbox.x0 + word.bbox.x1) / 2;
const centerY = (word: OcrWord): number => (word.bbox.y0 + word.bbox.y1) / 2;

function countChars(text: string, chars: string): number {
  let n = 0;
  for (const ch of text) if (chars.includes(ch)) n++;
  return n;
}

/**
 * 悬空的 `^` / `_`（后面没有可作参数的字符）会让 KaTeX **直接报错**，
 * 一律去掉：实测 `(µe−^, y>0` 的那个 `^` 后面是逗号 —— 它只是
 * 上标 `−μy` 没被认出来的残影，留着就会让整个构造过不了验证门。
 * `x^2`、`e^{...}` 这类后面跟了字符的照常保留。
 */
function fixDanglingScriptMarkers(text: string): string {
  return text.replace(/[\^_](?![A-Za-z0-9{])/g, '');
}

/**
 * 清理分支词文本里的大括号残影。
 *
 *  · `_(1，当 X≤Y` → `1，当 X≤Y`（下划线残影 + 被认成左括号的上钩）；
 *  · `(λe−x, x>0` → `λe−x, x>0`（上钩残影）；
 *  · `(1−p)` / `(−1)` 这类**配对括号**原样保留 —— 括号不配对才是残影，
 *    这是「只剥上钩、不剥真括号」唯一可用的判别。
 */
function cleanBranchText(raw: string): string {
  let text = raw.trim();
  text = text.replace(/^[_^]+/, '');
  while (
    text.length > 0 &&
    OPEN_PAREN_CHARS.includes(text[0] ?? '') &&
    countChars(text, OPEN_PAREN_CHARS) > countChars(text, CLOSE_PAREN_CHARS)
  ) {
    text = text.slice(1);
  }
  return fixDanglingScriptMarkers(text).trim();
}

/**
 * 文本 → 行内 LaTeX。
 *
 * ⚠️ 顺序不能反：**先转义、后映射**。映射产物（`\mu `、`^{2}`）
 * 里含反斜杠与花括号，若先映射后转义会被转义毁掉。
 *
 * `^` / `_` **不转义**：它们在这里就是 TeX 语义 —— 清洗阶段已经把
 * 悬空的那类去掉了，剩下的后面一定跟着字符或 `{`。
 * 希腊字母与比较符映射成 TeX 命令只是为了字形正确（`\mu` 斜体、
 * `\le` 的标准字形），语义与原文一一对应。
 */
function toLatex(text: string): string {
  const escaped = text
    .replace(/\\/g, '\\backslash ')
    .replace(/[%&#{}$]/g, (m) => `\\${m}`);
  return escaped
    .replace(/[µμ]/g, '\\mu ')
    .replace(/λ/g, '\\lambda ')
    .replace(/σ/g, '\\sigma ')
    .replace(/≥/g, '\\ge ')
    .replace(/≤/g, '\\le ')
    .replace(/−/g, '-')
    .replace(/²/g, '^{2}')
    // 映射自带的分隔空格可能与原文的空格叠成双空格，统一收一下
    .replace(/\s+/g, ' ')
    .trim();
}

interface ParsedConstruct {
  /** `fx(x) =`（含等号） */
  label: string;
  /** 大括号之后、下一个构造之前的那段文本（锚点自带的那一行） */
  after: string;
}

function parseConstructs(text: string): ParsedConstruct[] | null {
  const trimmed = text.trim();
  const braces = countChars(trimmed, '{');

  const re = new RegExp(CONSTRUCT_SRC, 'g');
  const matches = [...trimmed.matchAll(re)];
  if (!matches.length) return null;
  // 构造不能在文本中间：锚点必须**以构造头开头**（`= {` 出现在词中间
  // 说明前面还有别的内容，改写成公式会把它们吞掉）
  if ((matches[0]?.index ?? -1) !== 0) return null;
  if (braces) {
    // 有真大括号时维持原判据：每个 `{` 恰好属于一个构造，且匹配到的
    // 构造符全是 `{`。替身匹配混进来意味着有 `{` 没被匹配上（计数相等
    // 也可能是「一个 `{` + 一个替身」），同样一票否决 —— 不做拼接。
    if (matches.length !== braces) return null;
    if (matches.some((m) => m[2] !== '{')) return null;
  }

  const out: ParsedConstruct[] = [];
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    if (!match) return null;
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[i + 1]?.index ?? trimmed.length;
    const after = fixDanglingScriptMarkers(trimmed.slice(start, end).trim());
    const label = (match[1] ?? '').trim();
    if (!after || !label) return null;
    out.push({ label, after });
  }
  return out;
}

/** 原始文本 → 清洗后的分支文本；不像公式行时返回 `null` */
function branchTextOfRaw(raw: string): string | null {
  // 另一个锚点（含 `{`）不能当分支 —— 否则两个构造会互相吞并
  if (raw.includes('{')) return null;
  const cleaned = cleanBranchText(raw);
  if (!cleaned || cleaned.length > PIECEWISE_BRANCH_MAX_CHARS) return null;
  if (!BRANCH_HINT_RE.test(cleaned)) return null;
  if (PROSE_CJK_RUN_RE.test(cleaned)) return null;
  return cleaned;
}

/** 分支词 → 清洗后的文本；不像公式行时返回 `null` */
function branchTextOf(word: OcrWord): string | null {
  return branchTextOfRaw(word.text);
}

/**
 * 同一视觉行的判定：垂直区间重叠 ≥ 较矮者的一半。
 * 同一行上的词（哪怕横向隔了 119px，如 24 题的 `0，` 与 `其他`）算一行；
 * 相邻两行的词（高度几乎不重叠）不算。
 */
function sameVisualLine(a: OcrWord, b: OcrWord): boolean {
  const overlap = Math.min(a.bbox.y1, b.bbox.y1) - Math.max(a.bbox.y0, b.bbox.y0);
  return overlap > 0 && overlap >= Math.min(heightOf(a), heightOf(b)) * 0.5;
}

/** 一个候选分支：单个词，或同一视觉行上并起来的一串词 */
interface BranchUnit {
  words: OcrWord[];
  text: string;
}

/**
 * 候选词 → 分支单元。
 *
 * 默认逐词判定（与并入前逐字节一致）；只有**行里有词单独当不了分支**
 * 时才把整行并起来再判 —— 24 题的 `0，` + `其他`：`其他` 单独不含数学
 * 符号，并成 `0， 其他` 才是完整分支。并起来的文本若不像公式行，
 * 仍然退回逐词（20 题并排的两个上分支并起来 18 字 > 12，各自成支）。
 */
function branchUnitsOf(words: readonly OcrWord[]): BranchUnit[] {
  const groups: OcrWord[][] = [];
  for (const word of [...words].sort((a, b) => centerY(a) - centerY(b))) {
    const group = groups.find((g) => sameVisualLine(g[0]!, word));
    if (group) group.push(word);
    else groups.push([word]);
  }

  const units: BranchUnit[] = [];
  for (const group of groups) {
    const singles = group.map((word) => ({ word, text: branchTextOf(word) }));
    if (group.length > 1 && singles.some((s) => s.text === null)) {
      const joined = branchTextOfRaw(group.map((w) => w.text).join(' '));
      if (joined !== null) {
        units.push({ words: group, text: joined });
        continue;
      }
    }
    for (const s of singles) {
      if (s.text !== null) units.push({ words: [s.word], text: s.text });
    }
  }
  return units;
}

/**
 * 找出页面上所有「可信的」分段函数构造。
 *
 * 纯函数：只看几何与文本，产出计划；**不改任何东西**（落行见
 * `ocrPostProcess.applyPiecewiseRecovery`）。计划是「全或无」的 ——
 * 任一判据不成立，这个锚点整个不产出。
 */
export function planPiecewise(
  lines: readonly PiecewiseLineLike[],
  refFont: number,
): PiecewisePlan[] {
  if (!Number.isFinite(refFont) || refFont <= 0) return [];

  const allWords: OcrWord[] = [];
  for (const line of lines) allWords.push(...line.words);

  const claimed = new Set<OcrWord>();
  const plans: PiecewisePlan[] = [];

  for (const anchor of allWords) {
    if (claimed.has(anchor)) continue;
    if (heightOf(anchor) < refFont * PIECEWISE_ANCHOR_MIN_HEIGHT_RATIO) continue;

    const constructs = parseConstructs(anchor.text);
    if (!constructs) continue;

    const aboveWords: OcrWord[] = [];
    const belowWords: OcrWord[] = [];
    for (const word of allWords) {
      if (word === anchor || claimed.has(word)) continue;
      const cx = centerX(word);
      if (cx < anchor.bbox.x0 || cx > anchor.bbox.x1) continue;
      const isAbove = centerY(word) < centerY(anchor);
      const gap = isAbove ? anchor.bbox.y0 - word.bbox.y1 : word.bbox.y0 - anchor.bbox.y1;
      if (gap < -2 || gap > refFont * PIECEWISE_BRANCH_MAX_GAP_RATIO) continue;
      (isAbove ? aboveWords : belowWords).push(word);
    }

    // 同一视觉行上的候选词先并成一个分支单元（24 题的 `0，` + `其他`），
    // 并起来不像公式行时 `branchUnitsOf` 内部退回逐词（20 题的两个上分支）
    const above = branchUnitsOf(aboveWords);
    const below = branchUnitsOf(belowWords);

    const n = constructs.length;
    // 每个构造恰好两行：锚点自带一行 + 恰好一侧的一行分支
    if (above.length !== 0 && above.length !== n) continue;
    if (below.length !== 0 && below.length !== n) continue;
    if ((above.length === 0) === (below.length === 0)) continue;

    // 分支与构造一一对应：按横向位置的比例分桶，桶里必须恰好一个
    const side = above.length ? above : below;
    const width = anchor.bbox.x1 - anchor.bbox.x0;
    const assignment = new Map<number, BranchUnit>();
    let paired = width > 0;
    for (const unit of side) {
      const unitX0 = Math.min(...unit.words.map((w) => w.bbox.x0));
      const unitX1 = Math.max(...unit.words.map((w) => w.bbox.x1));
      const ratio = ((unitX0 + unitX1) / 2 - anchor.bbox.x0) / width;
      const bucket = Math.min(n - 1, Math.max(0, Math.floor(ratio * n)));
      if (assignment.has(bucket)) {
        paired = false;
        break;
      }
      assignment.set(bucket, unit);
    }
    if (!paired || assignment.size !== n) continue;

    // 锚点所在行除了锚点与已归属的分支不能有别的词 —— 否则整行改写会吞掉它们
    const anchorLine = lines.find((line) => line.words.includes(anchor));
    if (!anchorLine) continue;
    const claimedWords = [...assignment.values()].flatMap((unit) => unit.words);
    const claimedHere = new Set(claimedWords);
    if (anchorLine.words.some((word) => word !== anchor && !claimedHere.has(word))) continue;

    const constructTex: string[] = [];
    let rowsOk = true;
    for (let k = 0; k < n; k++) {
      const construct = constructs[k];
      const unit = assignment.get(k);
      if (!construct || !unit) {
        rowsOk = false;
        break;
      }
      const rows = above.length ? [unit.text, construct.after] : [construct.after, unit.text];
      constructTex.push(
        `${toLatex(construct.label)}\\begin{cases} ${toLatex(rows[0] ?? '')} \\\\ ${toLatex(rows[1] ?? '')} \\end{cases}`,
      );
    }
    if (!rowsOk) continue;

    const latex = constructTex.join(' \\qquad ');
    try {
      // 验证门：渲染不出来就不重组（宁可不显示大括号，也不产出半截公式）
      katex.renderToString(latex, { displayMode: true, throwOnError: true, strict: false, trust: true });
    } catch {
      continue;
    }

    plans.push({ anchor, latex, claimed: claimedWords });
    for (const word of claimedWords) claimed.add(word);
  }

  return plans;
}
