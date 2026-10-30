import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ensureHighlight, highlightToHtml } from "../utils/codeHighlight";
import { useFenceTheme } from "../hooks/useFenceTheme";

/**
 * The floating code window a code-file reference opens on hover: a few lines
 * of one file, syntax highlighted, with line numbers. Portalled to the body
 * and positioned under (or above) its anchor.
 *
 * Used by plan / annotate code-file links (`CodeFileLink` in InlineMarkdown,
 * the exact range only) and by code review's Call Flow locations
 * (`CallFlowTreeView`, with `contextLines` around the target).
 */

/** Lines highlighted above the shown ones so a range opening inside a block comment or string tokenises as one. */
const HIGHLIGHT_LEAD_IN_LINES = 40;
/** Gap kept between the window and the viewport edge. */
const VIEWPORT_MARGIN = 8;

/** The highlighter language for a file path, by extension; undefined renders plain text. */
export function codeSnippetLanguage(filepath: string): string | undefined {
  const ext = filepath.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    mts: 'typescript', cts: 'typescript', mjs: 'javascript', cjs: 'javascript',
    py: 'python', rb: 'ruby', rs: 'rust', go: 'go', java: 'java',
    css: 'css', scss: 'scss', json: 'json', yml: 'yaml', yaml: 'yaml',
    sql: 'sql', sh: 'bash', bash: 'bash', zsh: 'bash', md: 'markdown',
    html: 'html', xml: 'xml', toml: 'toml', swift: 'swift', kt: 'kotlin',
    lua: 'lua', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cs: 'csharp',
    scala: 'scala', dart: 'dart', ex: 'elixir', exs: 'elixir', zig: 'zig',
    vue: 'vue', svelte: 'svelte', astro: 'astro', php: 'php',
  };
  return ext ? map[ext] : undefined;
}

export interface CodeSnippetPreviewProps {
  anchorEl: HTMLElement | null;
  /** The whole file; the preview slices the lines it shows. */
  contents: string;
  filepath: string;
  /** One-based first line of the target range. */
  line: number;
  lineEnd?: number;
  /** Lines shown above and below the target range, the target rows marked. 0 (default) shows the range alone. */
  contextLines?: number;
  /** Header label; defaults to the file's basename. */
  title?: string;
  /** Called when the page or a scroller scrolls: the window is placed once and would drift from its anchor. */
  onDismiss?: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}

export const CodeSnippetPreview: React.FC<CodeSnippetPreviewProps> = ({
  anchorEl,
  contents,
  filepath,
  line,
  lineEnd,
  contextLines = 0,
  title,
  onDismiss,
  onMouseEnter,
  onMouseLeave,
}) => {
  const allLines = contents.split('\n');
  const targetStart = Math.max(0, line - 1);
  const targetEnd = Math.min(allLines.length, lineEnd ?? line);
  const start = Math.max(0, targetStart - contextLines);
  const end = Math.min(allLines.length, targetEnd + contextLines);
  const snippet = allLines.slice(start, end).join('\n');
  // Highlight from a little earlier than the first shown line: a range that
  // starts inside a block comment or template literal would otherwise colour
  // that text as code.
  const highlightStart = Math.max(0, start - HIGHLIGHT_LEAD_IN_LINES);
  const highlightSource = allLines.slice(highlightStart, end).join('\n');
  const marksTarget = contextLines > 0;

  const fenceTheme = useFenceTheme();
  // Bumped once the grammar is attached, to re-run the memo below with the
  // highlighter warm. Until then the snippet renders as plain text — no
  // auto-detection, and an unknown extension simply stays plain.
  const [highlighterGeneration, setHighlighterGeneration] = useState(0);
  const lang = codeSnippetLanguage(filepath);

  useEffect(() => {
    if (!lang) return;
    let cancelled = false;
    void ensureHighlight(lang, fenceTheme).then((ok) => {
      if (ok && !cancelled) setHighlighterGeneration((n) => n + 1);
    });
    return () => { cancelled = true; };
  }, [lang, fenceTheme]);

  useEffect(() => {
    if (!onDismiss) return;
    const dismiss = () => onDismiss();
    window.addEventListener('scroll', dismiss, { capture: true, passive: true });
    return () => window.removeEventListener('scroll', dismiss, { capture: true });
  }, [onDismiss]);

  const highlightedLines = useMemo(() => {
    // Highlight the snippet as one unit so multi-line constructs (block
    // comments, template literals) tokenise correctly, then split back into
    // rows: the highlighter joins lines with "\n" and never emits one inside a
    // span, so the split is exact.
    const html = lang ? highlightToHtml(highlightSource, lang, fenceTheme) : null;
    if (html !== null) return html.split('\n').slice(start - highlightStart);
    return snippet.split('\n').map(text =>
      text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
    // highlighterGeneration is the "grammar just became available" signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snippet, highlightSource, start, highlightStart, lang, fenceTheme, highlighterGeneration]);

  // Clamp against the window's rendered width (it sizes to its longest line,
  // up to its max width) so a wide snippet never runs off the right edge.
  const windowRef = useRef<HTMLDivElement | null>(null);
  const [renderedWidth, setRenderedWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const width = windowRef.current?.offsetWidth ?? null;
    if (width !== renderedWidth) setRenderedWidth(width);
  });

  if (!anchorEl) return null;

  const rect = anchorEl.getBoundingClientRect();
  const spaceBelow = window.innerHeight - rect.bottom;
  const showAbove = spaceBelow < 200 && rect.top > spaceBelow;
  const top = showAbove ? undefined : rect.bottom + 4;
  const bottom = showAbove ? window.innerHeight - rect.top + 4 : undefined;
  const left = Math.max(VIEWPORT_MARGIN, Math.min(rect.left, window.innerWidth - (renderedWidth ?? 520) - VIEWPORT_MARGIN));

  return createPortal(
    <div
      ref={windowRef}
      className="code-snippet-preview-window fixed z-[9999] rounded-lg border border-border bg-card shadow-xl flex flex-col"
      style={{ top, bottom, left, maxWidth: `min(600px, calc(100vw - ${VIEWPORT_MARGIN * 2}px))`, maxHeight: '300px' }}
      data-code-snippet-preview={filepath}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="px-3 py-1.5 border-b border-border/50 text-[10px] text-muted-foreground font-mono flex items-center justify-between gap-4 flex-shrink-0">
        <span>{title ?? filepath.split('/').pop()}</span>
        <span className="opacity-60">{lineEnd && lineEnd !== line ? `lines ${line}–${lineEnd}` : `line ${line}`}</span>
      </div>
      <div className="code-snippet-preview overflow-auto text-[12px] leading-5 min-h-0" style={{ padding: 0, background: 'var(--code-bg, #1e293b)' }}>
        <table className="border-collapse w-full">
          <tbody>
            {snippet.split('\n').map((_, i) => {
              const index = start + i;
              const target = marksTarget && index >= targetStart && index < targetEnd;
              return (
                <tr
                  key={index}
                  className={target ? 'bg-primary/15' : 'hover:bg-white/5'}
                  data-target-line={target ? 'true' : undefined}
                >
                  <td className={`select-none text-right pr-3 pl-3 py-0 align-top font-mono w-8 whitespace-nowrap ${target ? 'text-primary' : 'text-muted-foreground/40'}`} style={{ userSelect: 'none' }}>{index + 1}</td>
                  <td
                    className="font-mono pr-3 py-0 whitespace-pre"
                    dangerouslySetInnerHTML={{ __html: highlightedLines[i] ?? '' }}
                  />
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>,
    document.body,
  );
};
