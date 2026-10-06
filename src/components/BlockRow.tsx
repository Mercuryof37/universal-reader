import { memo, useMemo, useRef } from 'react';
import { Loader2, Volume2, Square } from 'lucide-react';
import katex from 'katex';
import type { Annotation, BilingualLayout, ContentBlock } from '@/types/content';
import { buildSegments, selectionOffsets } from '@/lib/annotations';
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

  const body = showOriginal ? (
    <RichText
      block={block}
      annotations={annotations}
      activeId={activeId}
      containerRef={textRef}
      onMouseUp={handleMouseUp}
      onPick={setActive}
      fontSize={fontSize}
      lineHeight={lineHeight}
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
    <div ref={wrapperRef} data-block-id={block.id} data-index={index} className="group relative">
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

/** 带批注底色的文本渲染 */
function RichText({
  block,
  annotations,
  activeId,
  containerRef,
  onMouseUp,
  onPick,
  fontSize,
  lineHeight,
  clickable,
}: {
  block: ContentBlock;
  annotations: Annotation[];
  activeId: string | null;
  containerRef: React.RefObject<HTMLDivElement | null>;
  onMouseUp: () => void;
  onPick: (id: string | null) => void;
  fontSize: number;
  lineHeight: number;
  clickable?: boolean;
}) {
  const segments = useMemo(() => buildSegments(block.content, annotations), [block.content, annotations]);

  const style = { fontSize: `${fontSize}px`, lineHeight } as const;

  if (block.type === 'code') {
    return (
      <pre className="block-code" style={{ fontSize: `${Math.round(fontSize * 0.9)}px` }}>
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
    const html = renderMath(block.content, true);
    return (
      <div
        className="block-math my-4 overflow-x-auto text-center"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }

  const inner = segments.map((seg, i) => {
    if (!seg.color || seg.annotationIds.length === 0) {
      return <span key={i}>{renderInlineMath(seg.text)}</span>;
    }
    const isActive = activeId !== null && seg.annotationIds.includes(activeId);
    return (
      <mark
        key={i}
        className="annotation-highlight"
        data-color={seg.color}
        data-active={isActive}
        onClick={() => onPick(seg.annotationIds[0] ?? null)}
        title="点击查看该批注"
      >
        {renderInlineMath(seg.text)}
      </mark>
    );
  });

  const common = {
    ref: containerRef,
    onMouseUp: clickable ? onMouseUp : undefined,
    'data-annotatable': true,
    style,
    // 这里刻意放宽类型：同一套 props 会被挂到 h1~h6 / blockquote / p 上，
    // 逐一写联合类型只会让代码更难读，运行期行为完全一致。
  } as Record<string, unknown>;

  switch (block.type) {
    case 'heading': {
      const level = Math.min(6, Math.max(1, block.metadata.level ?? 2));
      const Tag = `h${level}` as 'h1';
      return (
        <Tag className="block-heading" {...common}>
          {inner}
        </Tag>
      );
    }
    case 'quote':
      return (
        <blockquote className="block-quote" {...common}>
          {inner}
        </blockquote>
      );
    case 'list':
      return (
        <div className="block-list" {...common}>
          {block.content.split('\n').map((line, i) => (
            <p key={i} className="my-0.5">
              {line}
            </p>
          ))}
        </div>
      );
    default:
      return (
        <p className="my-3" {...common}>
          {inner}
        </p>
      );
  }
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

/**
 * Convert Unicode superscripts/subscripts and common ^/_ patterns to LaTeX.
 * Only applied to plain text segments (not inside existing $...$ math).
 */
function normalizeSuperSub(text: string): string {
  const SUPER_MAP: Record<string, string> = {
    '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4',
    '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9',
    'ⁿ': 'n', 'ᵃ': 'a', 'ᵇ': 'b', 'ᶜ': 'c', 'ᵈ': 'd',
    'ᵉ': 'e', 'ᶠ': 'f', 'ᵍ': 'g', 'ʰ': 'h', 'ⁱ': 'i',
    'ʲ': 'j', 'ᵏ': 'k', 'ˡ': 'l', 'ᵐ': 'm', 'ᵒ': 'o',
    'ᵖ': 'p', 'ʳ': 'r', 'ˢ': 's', 'ᵗ': 't', 'ᵘ': 'u',
    'ᵛ': 'v', 'ʷ': 'w', 'ˣ': 'x', 'ʸ': 'y', 'ᶻ': 'z',
    '⁺': '+', '⁻': '-', '⁽': '(', '⁾': ')',
  };
  const SUB_MAP: Record<string, string> = {
    '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4',
    '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9',
    'ₐ': 'a', 'ₑ': 'e', 'ₕ': 'h', 'ᵢ': 'i', 'ⱼ': 'j',
    'ₖ': 'k', 'ₗ': 'l', 'ₘ': 'm', 'ₙ': 'n', 'ₒ': 'o',
    'ₚ': 'p', 'ᵣ': 'r', 'ₛ': 's', 'ₜ': 't', 'ᵤ': 'u',
    'ᵥ': 'v', 'ₓ': 'x',
    '₊': '+', '₋': '-', '₍': '(', '₎': ')',
  };

  const SUPER_RE = /[⁰¹²³⁴⁵⁶⁷⁸⁹ⁿᵃᵇᶜᵈᵉᶠᵍʰⁱʲᵏˡᵐᵒᵖʳˢᵗᵘᵛʷˣʸᶻ⁺⁻⁽⁾]+/g;
  const SUB_RE = /[₀₁₂₃₄₅₆₇₈₉ₐₑₕᵢⱼₖₗₘₙₒₚᵣₛₜᵤᵥₓ₊₋₍₎]+/g;

  let result = text;

  result = result.replace(SUPER_RE, (match) => {
    const latex = [...match].map((ch) => SUPER_MAP[ch] ?? ch).join('');
    return `$^{${latex}}$`;
  });

  result = result.replace(SUB_RE, (match) => {
    const latex = [...match].map((ch) => SUB_MAP[ch] ?? ch).join('');
    return `$_{${latex}}$`;
  });

  // Bare ^ and _ patterns in plain text only
  result = result.replace(/(\w)\^\{([^}]+)\}/g, '$1$^{$2}$$');
  result = result.replace(/(\w)\^(\w+)/g, '$1$^{$2}$$');
  result = result.replace(/(\w)_\{([^}]+)\}/g, '$1$_{$2}$$');
  result = result.replace(/(\w)_(\w+)/g, '$1$_{$2}$$');

  return result;
}

/** 将含 $...$ 的文本拆分为普通文本 + 行内公式的 React 节点数组 */
function renderInlineMath(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const regex = /\$([^$]+)\$/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const plainText = text.slice(lastIndex, match.index);
      const normalized = normalizeSuperSub(plainText);
      // Re-parse normalized text for any new $...$ created by normalizeSuperSub
      const subParts = parseNormalizedText(normalized, lastIndex);
      parts.push(...subParts);
    }
    const html = renderMath(match[1], false);
    parts.push(
      <span key={`m-${match.index}`} dangerouslySetInnerHTML={{ __html: html }} />,
    );
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    const plainText = text.slice(lastIndex);
    const normalized = normalizeSuperSub(plainText);
    const subParts = parseNormalizedText(normalized, lastIndex);
    parts.push(...subParts);
  }

  return parts;
}

/** Parse text that may contain $...$ from normalizeSuperSub conversion */
function parseNormalizedText(text: string, offsetBase: number): React.ReactNode[] {
  const result: React.ReactNode[] = [];
  const regex = /\$([^$]+)\$/g;
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = regex.exec(text)) !== null) {
    if (m.index > last) {
      result.push(text.slice(last, m.index));
    }
    const html = renderMath(m[1], false);
    result.push(
      <span key={`ms-${offsetBase + m.index}`} dangerouslySetInnerHTML={{ __html: html }} />,
    );
    last = regex.lastIndex;
  }

  if (last < text.length) {
    result.push(text.slice(last));
  }

  return result;
}
