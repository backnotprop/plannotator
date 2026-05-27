import React from 'react';

/**
 * Renders simple inline markdown: `code`, **bold**, *italic*, _italic_, and
 * fenced code blocks (```...```). Enough for review comments.
 */
export function renderInlineMarkdown(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let key = 0;

  // Split by fenced code blocks first
  const parts = text.split(/(```[\s\S]*?```)/g);

  for (const part of parts) {
    if (part.startsWith('```') && part.endsWith('```')) {
      const inner = part.slice(3, -3);
      // Strip optional language identifier on first line
      const newlineIdx = inner.indexOf('\n');
      const code = newlineIdx >= 0 ? inner.slice(newlineIdx + 1) : inner;
      nodes.push(
        <pre key={key++} className="inline-code-block">
          <code>{code.trim()}</code>
        </pre>
      );
    } else {
      // Process inline markdown
      nodes.push(...renderInline(part, key));
      key++;
    }
  }

  return nodes;
}

function renderInline(text: string, startKey: number): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let key = startKey;

  // Match inline patterns: [text](url), `code`, **bold**, *italic*, _italic_, bare URLs
  const regex = /(\[([^\]]+)\]\((https?:\/\/[^)]+)\)|`[^`]+`|\*\*[^*]+\*\*|(?<!\w)_([^_\s](?:[\s\S]*?[^_\s])?)_(?!\w)|\*[^*]+\*|https?:\/\/[^\s<)\]]+)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    // Text before match
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }

    const token = match[0];
    if (match[1] && match[2] && match[3]) {
      // Markdown link: [text](url)
      nodes.push(
        <a key={key++} href={match[3]} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
          {match[2]}
        </a>
      );
    } else if (token.startsWith('`')) {
      nodes.push(<code key={key++} className="inline-code">{token.slice(1, -1)}</code>);
    } else if (token.startsWith('**')) {
      nodes.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('_')) {
      const italicText = match[4];
      nodes.push(<em key={key++}>{italicText}</em>);
    } else if (token.startsWith('*')) {
      nodes.push(<em key={key++}>{token.slice(1, -1)}</em>);
    } else if (token.startsWith('http')) {
      // Bare URL
      nodes.push(
        <a key={key++} href={token} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline break-all">
          {token}
        </a>
      );
    }

    lastIndex = match.index + token.length;
  }

  // Remaining text
  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}
