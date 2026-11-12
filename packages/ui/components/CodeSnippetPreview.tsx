import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ensureHighlight, highlightToHtml } from "../utils/codeHighlight";
import { useFenceTheme } from "../hooks/useFenceTheme";

const HIGHLIGHT_LEAD_IN_LINES = 40;
const VIEWPORT_MARGIN = 8;

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
  contents: string;
  filepath: string;
  line: number;
  lineEnd?: number;
  contextLines?: number;
  title?: string;
  onDismiss?: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  actions?: React.ReactNode;
  container?: Element | null;
  sheet?: boolean;
  windowRef?: React.Ref<HTMLDivElement>;
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
  actions,
  container,
  sheet = false,
  windowRef: hostWindowRef,
}) => {
  const allLines = contents.split('\n');
  const targetStart = Math.max(0, line - 1);
  const targetEnd = Math.min(allLines.length, lineEnd ?? line);
  const start = Math.max(0, targetStart - contextLines);
  const end = Math.min(allLines.length, targetEnd + contextLines);
  const snippet = allLines.slice(start, end).join('\n');
  const highlightStart = Math.max(0, start - HIGHLIGHT_LEAD_IN_LINES);
  const highlightSource = allLines.slice(highlightStart, end).join('\n');
  const marksTarget = contextLines > 0;

  const fenceTheme = useFenceTheme();
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
    if (!onDismiss || sheet) return;
    const dismiss = (event: Event) => {
      if (event.target instanceof Node && windowRef.current?.contains(event.target)) return;
      onDismiss();
    };
    window.addEventListener('scroll', dismiss, { capture: true, passive: true });
    return () => window.removeEventListener('scroll', dismiss, { capture: true });
  }, [onDismiss, sheet]);

  const highlightedLines = useMemo(() => {
    const html = lang ? highlightToHtml(highlightSource, lang, fenceTheme) : null;
    if (html !== null) return html.split('\n').slice(start - highlightStart);
    return snippet.split('\n').map(text =>
      text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
  }, [snippet, highlightSource, start, highlightStart, lang, fenceTheme, highlighterGeneration]);

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
  const room = (showAbove ? rect.top : spaceBelow) - 4 - VIEWPORT_MARGIN;
  const label = title ?? filepath.split('/').pop();

  const preview = (
    <div
      ref={(element) => {
        windowRef.current = element;
        if (typeof hostWindowRef === 'function') hostWindowRef(element);
        else if (hostWindowRef) (hostWindowRef as React.MutableRefObject<HTMLDivElement | null>).current = element;
      }}
      className={sheet
        ? 'code-snippet-preview-window fixed inset-x-0 bottom-0 z-[9999] flex max-h-[78vh] flex-col overflow-hidden rounded-t-[12px] border border-border bg-card pb-[env(safe-area-inset-bottom)] shadow-2xl'
        : 'code-snippet-preview-window fixed z-[9999] rounded-lg border border-border bg-card shadow-xl flex flex-col'}
      style={sheet ? undefined : { top, bottom, left, maxWidth: `min(600px, calc(100vw - ${VIEWPORT_MARGIN * 2}px))`, maxHeight: `${Math.min(300, Math.max(room, 120))}px` }}
      data-code-snippet-preview={filepath}
      data-code-snippet-sheet={sheet ? '' : undefined}
      role={actions || sheet ? 'dialog' : undefined}
      aria-label={actions || sheet ? label : undefined}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className={`px-3 py-1.5 border-b border-border/50 text-muted-foreground font-mono flex items-center justify-between gap-x-4 flex-shrink-0 ${sheet ? 'flex-wrap text-xs pt-3' : 'text-[10px]'}`}>
        <span className={sheet ? 'w-full [overflow-wrap:anywhere]' : 'min-w-0 truncate'}>{label}</span>
        <span className={`flex items-center gap-2 ${sheet ? 'w-full' : 'flex-shrink-0'}`}>
          <span className={`opacity-60 ${sheet ? 'mr-auto' : ''}`}>{lineEnd && lineEnd !== line ? `lines ${line}–${lineEnd}` : `line ${line}`}</span>
          {actions}
        </span>
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
    </div>
  );

  return createPortal(
    sheet ? (
      <>
        <div className="fixed inset-0 z-[9998] bg-black/30" data-code-snippet-scrim="" onClick={onDismiss} />
        {preview}
      </>
    ) : (
      preview
    ),
    container ?? document.body,
  );
};
