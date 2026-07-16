/**
 * Lightweight block-level markdown renderer for GitHub-sourced text
 * (PR descriptions, PR comments, commit messages). No annotation
 * infrastructure — the full document surface is Viewer/BlockRenderer.
 */
import React, { useMemo, useRef, useEffect } from 'react';
import { parseMarkdownToBlocks } from '@plannotator/ui/utils/parser';
import { parseTableContent } from '@plannotator/ui/components/blocks/TableBlock';
import { sanitizeInlineHtml } from '@plannotator/ui/utils/sanitizeHtml';
import { renderInlineMarkdown } from '../utils/renderInlineMarkdown';



/** Check if content contains HTML tags that should be rendered natively. */
const HTML_TAG_RE = /<[a-z][a-z0-9]*[\s/>]/i;
const containsHtml = (text: string) => HTML_TAG_RE.test(text);

/** Renders sanitized HTML and hides broken images via ref (no inline event handlers). */
function SafeHtml({ html, as: Tag = 'div' }: { html: string; as?: 'div' | 'span' }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const imgs = ref.current.querySelectorAll('img');
    imgs.forEach((img) => {
      img.onerror = () => { img.style.display = 'none'; img.onerror = null; };
    });
  }, [html]);
  return <Tag ref={ref as any} dangerouslySetInnerHTML={{ __html: html }} />;
}

/**
 * Render inline content — if it contains HTML tags, sanitize and render.
 * Otherwise use our markdown renderer.
 */
function renderContent(content: string): React.ReactNode {
  if (containsHtml(content)) {
    return <SafeHtml html={sanitizeInlineHtml(content)} as="span" />;
  }
  return renderInlineMarkdown(content);
}

/** Video file links (GitHub can't inline-play these either, but we can). */
const VIDEO_EXT_RE = /\.(webm|mp4|mov|m4v|ogg)(\?[^\s)]*)?$/i;

/** A paragraph that is exactly one markdown link (or bare URL) to a video file. */
function parseLoneVideoLink(content: string): { url: string; label: string } | null {
  const t = content.trim();
  const md = t.match(/^\[([^\]]*)\]\(([^)\s]+)\)$/);
  if (md && VIDEO_EXT_RE.test(md[2])) return { url: md[2], label: md[1] || md[2] };
  if (/^https?:\/\/\S+$/.test(t) && VIDEO_EXT_RE.test(t)) return { url: t, label: t };
  return null;
}

/** Render a simplified block-level markdown view (no annotation infrastructure). */
export function MarkdownBody({ markdown, textClassName = 'text-xs' }: { markdown: string; textClassName?: string }) {
  const blocks = useMemo(() => parseMarkdownToBlocks(markdown), [markdown]);

  return (
    <div className={`space-y-2.5 ${textClassName} text-foreground/90 leading-relaxed`}>
      {blocks.map((block) => {
        switch (block.type) {
          case 'heading': {
            const Tag = `h${Math.min(block.level ?? 1, 6)}` as keyof JSX.IntrinsicElements;
            const sizes: Record<number, string> = {
              1: 'text-base font-bold',
              2: 'text-sm font-semibold',
              3: 'text-xs font-semibold',
            };
            return (
              <Tag key={block.id} className={`${sizes[block.level ?? 1] ?? 'text-xs font-medium'} text-foreground`}>
                {renderContent(block.content)}
              </Tag>
            );
          }
          case 'code':
            return (
              <pre key={block.id} className="bg-muted/50 rounded-md p-2 text-[11px] font-mono overflow-x-auto whitespace-pre-wrap">
                <code>{block.content}</code>
              </pre>
            );
          case 'list-item':
            return (
              <div key={block.id} className="flex gap-1.5" style={{ paddingLeft: (block.level ?? 0) * 12 }}>
                <span className="text-muted-foreground shrink-0">{block.checked !== undefined ? (block.checked ? '☑' : '☐') : '•'}</span>
                <span>{renderContent(block.content)}</span>
              </div>
            );
          case 'blockquote':
            return (
              <blockquote key={block.id} className="border-l-2 border-border pl-2 text-muted-foreground italic">
                {renderContent(block.content)}
              </blockquote>
            );
          case 'hr':
            return <hr key={block.id} className="border-border/50" />;
          case 'table': {
            const { headers, rows } = parseTableContent(block.content);
            if (!headers.length) return null;
            return (
              <div key={block.id} className="overflow-x-auto">
                <table className="min-w-full border-collapse">
                  <thead>
                    <tr className="border-b border-border">
                      {headers.map((header, i) => (
                        <th key={i} className="px-2 py-1 text-left font-semibold text-foreground/90 bg-muted/30">
                          {renderContent(header)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, ri) => (
                      <tr key={ri} className="border-b border-border/50">
                        {row.map((cell, ci) => (
                          <td key={ci} className="px-2 py-1 align-top">
                            {renderContent(cell)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          }
          default: {
            if (!block.content) return null;
            // A paragraph that is just a link to a video file → inline player
            const video = parseLoneVideoLink(block.content);
            if (video) {
              return (
                <div key={block.id} className="my-1">
                  <video
                    controls
                    preload="metadata"
                    src={video.url}
                    className="max-w-full rounded-md border border-border bg-black"
                  />
                  <a
                    href={video.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-1 block text-[11px] text-muted-foreground hover:text-foreground truncate"
                  >
                    {video.label}
                  </a>
                </div>
              );
            }
            // If the entire paragraph is HTML, sanitize and render
            if (containsHtml(block.content)) {
              return <SafeHtml key={block.id} html={sanitizeInlineHtml(block.content)} />;
            }
            return <p key={block.id}>{renderInlineMarkdown(block.content)}</p>;
          }
        }
      })}
    </div>
  );
}
