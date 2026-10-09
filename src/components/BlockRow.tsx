import { Fragment, memo, useMemo, useRef } from 'react';
import {
  AlertTriangle,
  Bug,
  Check,
  CheckCircle2,
  ClipboardList,
  Flame,
  HelpCircle,
  Info,
  List,
  Loader2,
  Pencil,
  Quote,
  Square,
  Volume2,
  X,
  Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import katex from 'katex';
import type {
  Annotation,
  BilingualLayout,
  CalloutSpec,
  ContentBlock,
  ListSpec,
  TableSpec,
} from '@/types/content';
import {
  buildStyledSegments,
  selectionOffsets,
  sliceSegments,
  splitStyledLines,
  type StyledLine,
  type TextSegment,
} from '@/lib/annotations';
import { normalizeAnchor } from '@/lib/utils';
import { useAnnotationsStore } from '@/store/annotationsStore';
import { useMeasuredHeight } from '@/hooks/useVirtualWindow';
import { useSettingsStore } from '@/store/settingsStore';

export interface BlockSelection {
  blockId: string;
  blockIndex: number;
  start: number;
  end: number;
  text: string;
  /** 选区在视口中的位置，用于定位浮动工具栏 */
  rect: { top: number; left: number; width: number };
}

interface BlockRowProps {
  block: ContentBlock;
  index: number;
  annotations: Annotation[];
  layout: BilingualLayout;
  targetLang: string;
  /** 该段是否是当前朗读段 */
  speaking: boolean;
  /** 该段是否正在等待/进行翻译 */
  translating: boolean;
  /** 文档标题锚点集合，用于判断文内链接能否跳转 */
  headingAnchors: ReadonlySet<string>;
  onJumpAnchor: (anchor: string) => void;
  reportHeight: (index: number, height: number) => void;
  onToggleSpeak: (index: number) => void;
  onSelection: (sel: BlockSelection) => void;
}

/**
 * 单个内容块。
 *
 * 用 memo 包住是必要的：一篇长文可能有几千个块，
 * 任何一次无关的状态变化（比如切换侧边栏）都会让整棵树重新渲染。
 * 因此 props 全部是原始值或稳定引用，annotations 也只传该块相关的子集。
 */
export const BlockRow = memo(function BlockRow({
  block,
  index,
  annotations,
  layout,
  targetLang,
  speaking,
  translating,
  headingAnchors,
  onJumpAnchor,
  reportHeight,
  onToggleSpeak,
  onSelection,
}: BlockRowProps) {
  const wrapperRef = useMeasuredHeight(index, reportHeight);
  const textRef = useRef<HTMLDivElement | null>(null);
  const setActive = useAnnotationsStore((s) => s.setActive);
  const activeId = useAnnotationsStore((s) => s.activeAnnotationId);
  const fontSize = useSettingsStore((s) => s.fontSize);
  const lineHeight = useSettingsStore((s) => s.lineHeight);

  const md = block.metadata.inline !== undefined;
  const showOriginal = layout !== 'translation-only';
  const showTranslation = layout !== 'original-only' && !!block.translations[targetLang];
  const sideBySide = layout === 'side-by-side';

  const handleMouseUp = () => {
    const container = textRef.current;
    const selection = window.getSelection();
    if (!container || !selection || selection.isCollapsed) return;

    const offsets = selectionOffsets(selection, container);
    if (!offsets) return;

    const rect = selection.getRangeAt(0).getBoundingClientRect();
    onSelection({
      blockId: block.id,
      blockIndex: index,
      start: offsets.start,
      end: offsets.end,
      text: offsets.text,
      rect: { top: rect.top, left: rect.left + rect.width / 2, width: rect.width },
    });
  };

  const ctx: RenderCtx = {
    allowBareScripts: !md,
    headingAnchors,
    onJumpAnchor,
    onPick: setActive,
    activeId,
    fontSize,
    lineHeight,
  };

  const body = showOriginal ? (
    <RichText
      block={block}
      annotations={annotations}
      ctx={ctx}
      containerRef={textRef}
      onMouseUp={handleMouseUp}
      clickable
    />
  ) : null;

  const translation = showTranslation ? (
    <p
      className="translation-text"
      style={{ fontSize: `${Math.round(fontSize * 0.92)}px`, lineHeight: lineHeight - 0.1 }}
      lang={targetLang}
    >
      {block.translations[targetLang]}
    </p>
  ) : null;

  return (
    <div
      ref={wrapperRef}
      data-block-id={block.id}
      data-index={index}
      // flow-root：让块内的上下外边距留在这一层的盒子里。
      // 否则子元素的外边距会折叠到 wrapper 外面，虚拟列表量到的高度
      // 就比实际占位小，累计起来会让"当前读到第几段"和跳转位置持续偏前。
      className={md ? 'group relative flow-root md-prose' : 'group relative flow-root'}
    >
      <div className={speaking ? 'block-speaking' : undefined}>
        {sideBySide ? (
          <div className="grid grid-cols-1 gap-x-6 md:grid-cols-2">
            <div>{body}</div>
            <div>{translation}</div>
          </div>
        ) : (
          <>
            {body}
            {translation}
          </>
        )}

        {translating && (
          <p className="mt-1 flex items-center gap-1.5 text-xs text-[var(--reader-muted)]">
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
            翻译中…
          </p>
        )}
      </div>

      {/* 逐段朗读按钮：hover 才出现，避免每段都挂一个按钮把版面切碎 */}
      {block.type !== 'image' && block.content.trim().length > 0 && (
        <button
          type="button"
          onClick={() => onToggleSpeak(index)}
          aria-label={speaking ? `停止朗读第 ${index + 1} 段` : `朗读第 ${index + 1} 段`}
          className={[
            'no-print absolute -left-10 top-1 rounded-full p-1.5 transition-opacity',
            'text-[var(--reader-muted)] hover:bg-[var(--reader-panel)] hover:text-[var(--reader-accent)]',
            speaking ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus:opacity-100',
          ].join(' ')}
        >
          {speaking ? (
            <Square className="h-3.5 w-3.5" aria-hidden />
          ) : (
            <Volume2 className="h-3.5 w-3.5" aria-hidden />
          )}
        </button>
      )}
    </div>
  );
});

// ═══════════════════════════════════════════════════════════════
// 文本渲染
// ═══════════════════════════════════════════════════════════════

interface RenderCtx {
  /**
   * 是否启用 OCR 专用的 `x^2` / `n_1` 猜测。
   *
   * Markdown 块关闭它：那里的 `^` `_` 是字面量（下划线还常见于
   * `snake_case` 这类标识符，猜错比不猜更糟），公式必须写成 `$...$`。
   */
  allowBareScripts: boolean;
  headingAnchors: ReadonlySet<string>;
  onJumpAnchor: (anchor: string) => void;
  onPick: (id: string | null) => void;
  activeId: string | null;
  fontSize: number;
  lineHeight: number;
}

/**
 * 内容块渲染。
 *
 * 与批注层的核心约定：DOM 里的文本必须逐字符等于 block.content
 * （见 annotations.ts 的 domTextOffset）。因此：
 * - 行容器用 `data-sep="1"` 声明"子元素之间有一个分隔字符"；
 * - 公式用 `data-math-src` 声明"按原文计长，不要进 KaTeX 内部数"。
 * 任何新增的装饰元素（复选框、图标、项目符号）都只能是空文本元素。
 */
function RichText({
  block,
  annotations,
  ctx,
  containerRef,
  onMouseUp,
  clickable,
}: {
  block: ContentBlock;
  annotations: Annotation[];
  ctx: RenderCtx;
  containerRef: React.RefObject<HTMLDivElement | null>;
  onMouseUp: () => void;
  clickable?: boolean;
}) {
  const md = block.metadata.inline !== undefined;
  const segments = useMemo(
    () => buildStyledSegments(block.content, annotations, block.metadata.inline),
    [block.content, annotations, block.metadata.inline],
  );
  const lines = useMemo(() => splitStyledLines(segments, block.content), [segments, block.content]);

  if (block.type === 'code') {
    return (
      <pre className="block-code" style={{ fontSize: `${Math.round(ctx.fontSize * 0.9)}px` }}>
        <code>{block.content}</code>
      </pre>
    );
  }

  if (block.type === 'image') {
    return block.metadata.src ? (
      <figure className="my-4">
        <img
          src={block.metadata.src}
          alt={block.content || '文档插图'}
          className="mx-auto max-h-[70vh] rounded-lg border border-[var(--reader-border)]"
        />
        {block.content && (
          <figcaption className="mt-2 text-center text-xs text-[var(--reader-muted)]">
            {block.content}
          </figcaption>
        )}
      </figure>
    ) : null;
  }

  if (block.type === 'math') {
    return (
      <div
        className="block-math my-4 overflow-x-auto text-center"
        data-math-src={block.content}
        dangerouslySetInnerHTML={{ __html: renderMath(block.content, true) }}
      />
    );
  }

  if (block.type === 'divider') {
    return <hr className="md-hr" />;
  }

  // 注意：分隔符标记 data-sep 只加在"子元素之间恰好差一个字符"的容器上
  // （行容器、表格行/单元格、列表项、Callout 正文），且这些容器的子元素
  // 必须全是行 / 单元格这类结构元素；标题、段落内不放，避免相邻的行内
  // 元素（如 **粗** *斜*）被误数出一个分隔符。
  const common = {
    ref: containerRef,
    onMouseUp: clickable ? onMouseUp : undefined,
    'data-annotatable': true,
    style: { fontSize: `${ctx.fontSize}px`, lineHeight: ctx.lineHeight },
  } as Record<string, unknown>;

  if (block.type === 'table' && block.metadata.table) {
    return <TableBody spec={block.metadata.table} lines={lines} ctx={ctx} common={common} />;
  }

  if (block.type === 'callout' && block.metadata.callout) {
    return <CalloutBody spec={block.metadata.callout} lines={lines} ctx={ctx} common={common} />;
  }

  if (block.type === 'list' && block.metadata.list) {
    return <ListBody spec={block.metadata.list} lines={lines} ctx={ctx} common={common} />;
  }

  if (block.type === 'heading') {
    const level = Math.min(6, Math.max(1, block.metadata.level ?? 2));
    const Tag = `h${level}` as 'h1';
    return (
      <Tag
        className="block-heading"
        data-level={level}
        {...common}
        // 标题字号必须按当前正文字号算：CSS 的 em 阶梯会挂到 16px 的父级上，
        // 用户拖动字号滑块时标题就不跟手了
        style={{ fontSize: `${Math.round(ctx.fontSize * (md ? HEADING_SCALE[level - 1]! : 1))}px` }}
      >
        {lines[0]?.segments.map((seg, i) => renderSegment(seg, ctx, i))}
      </Tag>
    );
  }

  const lineNodes = lines.map((line, i) => (
    <p key={i} className="reader-line">
      {line.segments.map((seg, j) => renderSegment(seg, ctx, j))}
    </p>
  ));

  if (block.type === 'quote') {
    return (
      <blockquote className="block-quote reader-lines" data-sep="1" {...common}>
        {lineNodes}
      </blockquote>
    );
  }

  // paragraph 与"无结构化元数据的旧列表"（EPUB 等）：逐行渲染，
  // 旧列表的 '- ' 前缀本来就在 content 里，渲染层不再另加符号
  return (
    <div
      className={block.type === 'list' ? 'block-list reader-lines' : 'reader-lines'}
      data-sep="1"
      {...common}
    >
      {lineNodes}
    </div>
  );
}

/** Obsidian 默认主题的标题字号阶梯（h1→h6，相对正文） */
const HEADING_SCALE = [1.618, 1.462, 1.318, 1.188, 1.076, 1];

/** 渲染一个片段：先按行内格式包裹，再套批注底色 */
function renderSegment(seg: TextSegment, ctx: RenderCtx, key: number): React.ReactNode {
  const node = renderInlineFormats(seg, ctx);
  if (!seg.annotationIds.length || !seg.color) {
    return <Fragment key={key}>{node}</Fragment>;
  }
  const isActive = ctx.activeId !== null && seg.annotationIds.includes(ctx.activeId);
  return (
    <mark
      key={key}
      className="annotation-highlight"
      data-color={seg.color}
      data-active={isActive}
      onClick={() => ctx.onPick(seg.annotationIds[0] ?? null)}
      title="点击查看该批注"
    >
      {node}
    </mark>
  );
}

const CALLOUT_ICONS: Record<string, LucideIcon> = {
  abstract: ClipboardList,
  summary: ClipboardList,
  tldr: ClipboardList,
  info: Info,
  todo: CheckCircle2,
  important: Flame,
  tip: Flame,
  hint: Flame,
  success: Check,
  check: Check,
  done: Check,
  question: HelpCircle,
  help: HelpCircle,
  faq: HelpCircle,
  warning: AlertTriangle,
  caution: AlertTriangle,
  attention: AlertTriangle,
  failure: X,
  fail: X,
  missing: X,
  danger: Zap,
  error: Zap,
  bug: Bug,
  example: List,
  quote: Quote,
  cite: Quote,
  note: Pencil,
  default: Pencil,
};

/** 未知类型按 note 的默认色渲染（与 Obsidian 一致） */
function calloutPalette(type: string): string {
  return CALLOUT_ICONS[type] ? type : 'note';
}

function CalloutBody({
  spec,
  lines,
  ctx,
  common,
}: {
  spec: CalloutSpec;
  lines: StyledLine[];
  ctx: RenderCtx;
  common: Record<string, unknown>;
}) {
  const palette = calloutPalette(spec.type);
  const Icon = CALLOUT_ICONS[spec.type] ?? Pencil;
  const title = lines[0];
  const body = lines.slice(1);

  return (
    <div className="md-callout" data-callout={palette}>
      <div className="md-callout-inner reader-lines" data-sep="1" {...common}>
        <div className="md-callout-title reader-line">
          {/* data-dec：纯装饰元素，不参与文本偏移统计 */}
          <span className="md-callout-icon" data-dec="1" aria-hidden>
            <Icon className="h-4 w-4" />
          </span>
          <span className="md-callout-title-text">
            {title?.segments.map((seg, i) => renderSegment(seg, ctx, i))}
          </span>
        </div>
        {body.map((line, i) => (
          <p key={i} className="reader-line md-callout-body">
            {line.segments.map((seg, j) => renderSegment(seg, ctx, j))}
          </p>
        ))}
      </div>
    </div>
  );
}

function ListBody({
  spec,
  lines,
  ctx,
  common,
}: {
  spec: ListSpec;
  lines: StyledLine[];
  ctx: RenderCtx;
  common: Record<string, unknown>;
}) {
  return (
    <div className="md-list reader-lines" data-sep="1" {...common}>
      {spec.items.map((item, i) => {
        const checked = item.checked;
        return (
          <div
            key={i}
            className={checked === null ? 'md-li reader-line' : 'md-li md-li-task reader-line'}
            data-marker={checked === null ? item.marker : undefined}
            data-checked={checked === null ? undefined : checked ? 'true' : 'false'}
            style={{ '--li-indent': `${item.indent * 1.4}em` } as React.CSSProperties}
          >
            {checked !== null && (
              // data-dec：复选框是装饰元素，不参与文本偏移统计
              <span
                className="md-task"
                data-dec="1"
                data-checked={checked ? 'true' : 'false'}
                role="img"
                aria-label={checked ? '已完成' : '未完成'}
              />
            )}
            {lines[i]?.segments.map((seg, j) => renderSegment(seg, ctx, j))}
          </div>
        );
      })}
    </div>
  );
}

function TableBody({
  spec,
  lines,
  ctx,
  common,
}: {
  spec: TableSpec;
  lines: StyledLine[];
  ctx: RenderCtx;
  common: Record<string, unknown>;
}) {
  // 单元格偏移按解析器写 content 的同一规则重建：cell 之间 1 个空格、行之间 1 个换行
  return (
    <div className="md-table-wrap" data-sep="1" {...common}>
      <table className="md-table">
        <tbody data-sep="1">
          {spec.rows.map((row, rowIndex) => {
            const rowSegments = lines[rowIndex]?.segments ?? [];
            let offset = 0;
            return (
              <tr key={rowIndex} data-sep="1" className={rowIndex === 0 ? 'md-tr-head' : undefined}>
                {row.map((cell, colIndex) => {
                  const start = offset;
                  offset += cell.length + 1;
                  const Tag = rowIndex === 0 ? 'th' : 'td';
                  return (
                    <Tag
                      key={colIndex}
                      className="md-cell"
                      style={{ textAlign: spec.align[colIndex] ?? undefined }}
                    >
                      {sliceSegments(rowSegments, start, start + cell.length).map((seg, i) =>
                        renderSegment(seg, ctx, i),
                      )}
                    </Tag>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** 行内格式与链接：从内到外依次包裹 */
function renderInlineFormats(seg: TextSegment, ctx: RenderCtx): React.ReactNode {
  const kinds = new Set(seg.inlines.map((s) => s.kind));
  const link = seg.inlines.find((s) => s.kind === 'link');
  const wiki = seg.inlines.find((s) => s.kind === 'wikilink');

  let node: React.ReactNode;
  if (kinds.has('math')) {
    node = <MathSpan tex={seg.text.slice(1, -1)} original={seg.text} />;
  } else if (kinds.has('fnref')) {
    node = <sup className="md-fnref">{seg.text}</sup>;
  } else if (kinds.has('code')) {
    node = seg.text;
  } else {
    node = renderPlain(seg.text, ctx.allowBareScripts);
  }

  if (kinds.has('code')) node = <code className="md-code">{node}</code>;
  if (kinds.has('mark')) node = <mark className="md-mark">{node}</mark>;
  if (kinds.has('del')) node = <del className="md-del">{node}</del>;
  if (kinds.has('emphasis')) node = <em>{node}</em>;
  if (kinds.has('strong')) node = <strong>{node}</strong>;
  if (link) node = <MarkdownLink href={link.href ?? ''} ctx={ctx}>{node}</MarkdownLink>;
  else if (wiki) node = <WikiLink target={wiki.href ?? ''} ctx={ctx}>{node}</WikiLink>;
  return node;
}

/**
 * 文内链接：`[文本](#标题)` 与 `[[#标题]]` 跳到对应标题块。
 *
 * 标题不存在时渲染为"失效链接"而不是普通文本 —— 与 Obsidian 的
 * 未解析链接观感一致，也让"链接断在哪里"一目了然。
 */
function MarkdownLink({
  href,
  ctx,
  children,
}: {
  href: string;
  ctx: RenderCtx;
  children: React.ReactNode;
}) {
  const jump = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    ctx.onJumpAnchor(href);
  };

  if (href.startsWith('#')) {
    if (!ctx.headingAnchors.has(normalizeAnchor(href))) {
      return (
        <span className="md-link md-link-missing" title={`找不到标题：${href.slice(1)}`}>
          {children}
        </span>
      );
    }
    return (
      <a href={href} className="md-link" onClick={jump} title="跳转到该标题">
        {children}
      </a>
    );
  }

  return (
    <a
      href={href}
      className="md-link"
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </a>
  );
}

function WikiLink({
  target,
  ctx,
  children,
}: {
  target: string;
  ctx: RenderCtx;
  children: React.ReactNode;
}) {
  const resolvable = target.startsWith('#') && ctx.headingAnchors.has(normalizeAnchor(target));
  if (!resolvable) {
    return (
      <span className="md-wikilink md-wikilink-missing" title="指向其他笔记的链接无法在本阅读器里跳转">
        {children}
      </span>
    );
  }
  return (
    <a
      href={target}
      className="md-wikilink"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        ctx.onJumpAnchor(target);
      }}
      title="跳转到该标题"
    >
      {children}
    </a>
  );
}

/** 行内公式：按原文计长（data-math-src），KaTeX 的双份字形不参与偏移统计 */
function MathSpan({ tex, original }: { tex: string; original: string }) {
  const html = useMemo(() => renderMath(tex, false), [tex]);
  return <span className="md-math" data-math-src={original} dangerouslySetInnerHTML={{ __html: html }} />;
}

/** 用 KaTeX 渲染 LaTeX 公式为 HTML 字符串 */
function renderMath(tex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(tex, {
      displayMode,
      throwOnError: false,
      strict: false,
      trust: true,
    });
  } catch {
    return `<code>${tex}</code>`;
  }
}

// ═══════════════════════════════════════════════════════════════
// 上下标识别（OCR / 纯文本专用）
// ═══════════════════════════════════════════════════════════════

const SUPER_CHARS: Record<string, string> = {
  '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4',
  '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9',
  'ⁿ': 'n', 'ᵃ': 'a', 'ᵇ': 'b', 'ᶜ': 'c', 'ᵈ': 'd',
  'ᵉ': 'e', 'ᶠ': 'f', 'ᵍ': 'g', 'ʰ': 'h', 'ⁱ': 'i',
  'ʲ': 'j', 'ᵏ': 'k', 'ˡ': 'l', 'ᵐ': 'm', 'ᵒ': 'o',
  'ᵖ': 'p', 'ʳ': 'r', 'ˢ': 's', 'ᵗ': 't', 'ᵘ': 'u',
  'ᵛ': 'v', 'ʷ': 'w', 'ˣ': 'x', 'ʸ': 'y', 'ᶻ': 'z',
  '⁺': '+', '⁻': '-', '⁽': '(', '⁾': ')',
};

const SUB_CHARS: Record<string, string> = {
  '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4',
  '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9',
  'ₐ': 'a', 'ₑ': 'e', 'ₕ': 'h', 'ᵢ': 'i', 'ⱼ': 'j',
  'ₖ': 'k', 'ₗ': 'l', 'ₘ': 'm', 'ₙ': 'n', 'ₒ': 'o',
  'ₚ': 'p', 'ᵣ': 'r', 'ₛ': 's', 'ₜ': 't', 'ᵤ': 'u',
  'ᵥ': 'v', 'ₓ': 'x',
  '₊': '+', '₋': '-', '₍': '(', '₎': ')',
};

const SUPER_RE = '[⁰¹²³⁴⁵⁶⁷⁸⁹ⁿᵃᵇᶜᵈᵉᶠᵍʰⁱʲᵏˡᵐᵒᵖʳˢᵗᵘᵛʷˣʸᶻ⁺⁻⁽⁾]+';
const SUB_RE = '[₀₁₂₃₄₅₆₇₈₉ₐₑₕᵢⱼₖₗₘₙₒₚᵣₛₜᵤᵥₓ₊₋₍₎]+';

type ScriptPiece = string | { tex: string; original: string };

/**
 * 把普通文本切成"文本 / 上下标公式"两种片段。
 *
 * 两条规则：
 * 1. Unicode 上下标字符（x²、n₁）—— 任何来源都安全，永远转换；
 * 2. ASCII 的 `x^2` / `n_1` —— 只在 allowBare 时转换（OCR / 纯文本）。
 *    原始字符数被完整记录在 original 里，供偏移收集器使用。
 */
function scriptPieces(text: string, allowBare: boolean): ScriptPiece[] {
  const pattern =
    `${SUPER_RE}|${SUB_RE}` + (allowBare ? '|(\\w)\\^(\\{[^}]+\\}|\\w+)|(\\w)_(\\{[^}]+\\}|\\w+)' : '');
  const re = new RegExp(pattern, 'g');
  const out: ScriptPiece[] = [];
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));

    if (m[1] !== undefined || m[3] !== undefined) {
      // `x^2` / `n_1`：底数留在正文里，只有 `^...` 这一段被公式替换
      const base = m[1] ?? m[3]!;
      const content = m[2] ?? m[4]!;
      const inner = content.startsWith('{') ? content.slice(1, -1) : content;
      out.push(base);
      out.push({
        tex: `${m[1] !== undefined ? '^' : '_'}{${inner}}`,
        original: m[0].slice(base.length),
      });
    } else {
      const run = m[0];
      const isSuper = run[0]! in SUPER_CHARS;
      const map = isSuper ? SUPER_CHARS : SUB_CHARS;
      const latex = [...run].map((ch) => map[ch] ?? ch).join('');
      out.push({ tex: `${isSuper ? '^' : '_'}{${latex}}`, original: run });
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** 把普通文本渲染为节点：`$...$` 公式 + Unicode 上下标 */
function renderPlain(text: string, allowBareScripts: boolean): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const regex = /\$([^$]+)\$/g;
  let last = 0;
  let match: RegExpExecArray | null;

  const pushScripted = (chunk: string, keyBase: number) => {
    scriptPieces(chunk, allowBareScripts).forEach((piece, i) => {
      if (typeof piece === 'string') nodes.push(piece);
      else nodes.push(<MathSpan key={`s${keyBase}-${i}`} tex={piece.tex} original={piece.original} />);
    });
  };

  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) pushScripted(text.slice(last, match.index), last);
    nodes.push(<MathSpan key={`m${match.index}`} tex={match[1]!} original={match[0]} />);
    last = regex.lastIndex;
  }
  if (last < text.length) pushScripted(text.slice(last), last);
  return nodes;
}
