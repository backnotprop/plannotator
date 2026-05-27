/**
 * Markdown renderer for AI chat responses in the review sidebar.
 *
 * Distinct from the plan editor's markdown rendering (packages/ui) which
 * parses into Block objects for annotation. This is a simpler HTML pipeline
 * for streaming chat messages: marked → DOMPurify → dangerouslySetInnerHTML.
 */
import type React from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

export function renderChatMarkdown(text: string): React.ReactNode {
  const html = marked.parse(text, { async: false, breaks: true }) as string;
  const clean = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      'p', 'br', 'strong', 'em', 'code', 'pre', 'ul', 'ol', 'li',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'a', 'blockquote',
    ],
    ALLOWED_ATTR: ['href', 'target', 'rel', 'class'],
  });

  return (
    <div
      className="ai-markdown"
      dangerouslySetInnerHTML={{ __html: clean }}
    />
  );
}
