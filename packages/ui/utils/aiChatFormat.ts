import { createElement, type ReactNode } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

export function renderChatMarkdown(text: string): ReactNode {
  const html = marked.parse(text, { async: false, breaks: true }) as string;
  const clean = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      'p', 'br', 'strong', 'em', 'code', 'pre', 'ul', 'ol', 'li',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'a', 'blockquote',
    ],
    ALLOWED_ATTR: ['href', 'rel', 'class'],
  });

  return createElement('div', {
    className: 'ai-markdown',
    dangerouslySetInnerHTML: { __html: clean },
  });
}

export function formatRelativeTime(ts: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return 'now';
  if (minutes < 60) return `${minutes}m`;
  if (hours < 24) return `${hours}h`;
  if (days < 7) return `${days}d`;

  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
