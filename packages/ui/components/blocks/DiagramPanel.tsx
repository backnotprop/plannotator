import React, { useRef, useEffect, useMemo } from 'react';
import { sanitizeBlockHtml } from '../../utils/sanitizeHtml';

interface DiagramPanelProps {
  blockId: string;
  body: string;
  caption?: string;
}

/**
 * Detect whether the body contains inline SVG or a code fence.
 * - Inline SVG: body starts with `<svg` (possibly after whitespace)
 * - Code fence: body starts with ``` (mermaid, graphviz, etc.)
 * For code fences, we strip the fence markers and pass through to the
 * existing code-block rendering via a placeholder. For inline SVG, we
 * sanitize and render directly.
 */
function detectContent(body: string): { type: 'svg' | 'code'; content: string; language?: string } {
  const trimmed = body.trim();

  // Inline SVG
  if (trimmed.startsWith('<svg') || trimmed.startsWith('<SVG')) {
    return { type: 'svg', content: trimmed };
  }

  // Code fence — extract language and content
  const fenceMatch = trimmed.match(/^```(\w*)\s*\n([\s\S]*?)(?:\n```\s*)?$/);
  if (fenceMatch) {
    return {
      type: 'code',
      content: fenceMatch[2] || '',
      language: fenceMatch[1] || undefined,
    };
  }

  // Fallback: treat as raw SVG if it contains svg tags somewhere
  if (/<svg[\s>]/i.test(trimmed)) {
    return { type: 'svg', content: trimmed };
  }

  // Otherwise treat as code content without fence
  return { type: 'code', content: trimmed };
}

/**
 * Sanitize SVG for safe rendering. Uses the same DOMPurify path as HtmlBlock
 * but with SVG-specific tags allowed. CSS variables (var(--primary)) are
 * preserved since they resolve at render time.
 */
function sanitizeSvg(svg: string): string {
  // Use the block sanitizer — it strips scripts and event handlers.
  // SVG-specific tags (circle, rect, path, etc.) need to be in the allowlist,
  // but since we're using dangerouslySetInnerHTML inside a scoped div,
  // and the SVG is from the agent (same trust model as HtmlBlock), we
  // sanitize with the general block sanitizer for consistency.
  return sanitizeBlockHtml(svg);
}

const SvgContent: React.FC<{ svg: string }> = ({ svg }) => {
  const ref = useRef<HTMLDivElement>(null);
  const sanitized = useMemo(() => sanitizeSvg(svg), [svg]);

  useEffect(() => {
    if (!ref.current) return;
    ref.current.innerHTML = sanitized;
  }, [sanitized]);

  return <div ref={ref} className="diagram-svg flex justify-center" />;
};

export const DiagramPanel: React.FC<DiagramPanelProps> = ({ blockId, body, caption }) => {
  const detected = detectContent(body);

  return (
    <div
      className="directive-diagram my-4 rounded-lg border border-border/60 bg-card/30 overflow-hidden"
      data-block-id={blockId}
      data-block-type="directive"
      data-directive-kind="diagram"
    >
      <div className="p-4">
        {detected.type === 'svg' ? (
          <SvgContent svg={detected.content} />
        ) : (
          <pre className="text-sm font-mono overflow-x-auto">
            <code className={detected.language ? `language-${detected.language}` : ''}>
              {detected.content}
            </code>
          </pre>
        )}
      </div>
      {caption && (
        <div className="px-4 py-2 border-t border-border/40 bg-muted/30">
          <p className="text-xs text-muted-foreground text-center italic">{caption}</p>
        </div>
      )}
    </div>
  );
};
