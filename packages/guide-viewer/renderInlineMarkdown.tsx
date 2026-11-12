import React from 'react';
import { isCodeFilePath } from '@plannotator/core/code-file';
import { GUIDE_LINK_TARGET_SOURCE } from '@plannotator/core/guide-links';

export type GuideLinkRenderer = (href: string, label: React.ReactNode, key: number) => React.ReactNode | null;

export type GuideCodeSpanRenderer = (text: string, code: React.ReactNode) => React.ReactNode;
export const GuideCodeSpanContext = React.createContext<GuideCodeSpanRenderer | null>(null);

function GuideCodeSpan({ text, children }: { text: string; children: React.ReactNode }) {
  const wrap = React.useContext(GuideCodeSpanContext);
  return <>{wrap && isCodeFilePath(text) ? wrap(text, children) : children}</>;
}

export interface InlineMarkdownOptions {
  renderLink?: GuideLinkRenderer;
  resolveImageSrc?: (src: string) => string;
}

export function renderInlineMarkdown(text: string, opts?: InlineMarkdownOptions): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let key = 0;

  const parts = text.split(/(```[\s\S]*?```)/g);

  for (const part of parts) {
    if (part.startsWith('```') && part.endsWith('```')) {
      const inner = part.slice(3, -3);
      const newlineIdx = inner.indexOf('\n');
      const code = newlineIdx >= 0 ? inner.slice(newlineIdx + 1) : inner;
      nodes.push(
        <pre key={key++} className="inline-code-block">
          <code>{code.trim()}</code>
        </pre>
      );
    } else {
      nodes.push(...renderInline(part, key, opts));
      key++;
    }
  }

  return nodes;
}

function renderInline(text: string, startKey: number, opts?: InlineMarkdownOptions, inLink = false): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let key = startKey;

  const regex = new RegExp(
    String.raw`(\[([^\]]+)\]\((https?:\/\/[^)]+)\)|` + '`[^`]+`' + String.raw`|\*\*[^*]+\*\*|(?<!\w)_([^_\s](?:[\s\S]*?[^_\s])?)_(?!\w)|\*[^*]+\*|https?:\/\/[^\s<)\]]+|\[([^\]]+)\]\((${GUIDE_LINK_TARGET_SOURCE})\))`,
    'g',
  );
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const isImage = !!(match[1] && match[2] && match[3]) && text[match.index - 1] === '!';

    if (match.index > lastIndex) {
      let before = text.slice(lastIndex, match.index);
      if (isImage && before.endsWith('!')) before = before.slice(0, -1);
      if (before) nodes.push(before);
    }

    const token = match[0];
    if (match[5] !== undefined && match[6] !== undefined) {
      const label = renderInline(match[5], 0, undefined, true);
      const rendered = opts?.renderLink?.(match[6], label, key);
      nodes.push(rendered ?? <span key={key} data-guide-link={match[6]}>{label}</span>);
      key++;
    } else if (match[1] && match[2] && match[3]) {
      if (isImage) {
        nodes.push(
          <img
            key={key++}
            src={opts?.resolveImageSrc?.(match[3]) ?? match[3]}
            alt={match[2]}
            loading="lazy"
            className="max-w-full h-auto rounded my-1"
            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
          />
        );
      } else {
        nodes.push(
          <a key={key++} href={match[3]} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
            {match[2]}
          </a>
        );
      }
    } else if (token.startsWith('`')) {
      const code = <code className="inline-code">{token.slice(1, -1)}</code>;
      nodes.push(inLink ? <React.Fragment key={key++}>{code}</React.Fragment> : <GuideCodeSpan key={key++} text={token.slice(1, -1)}>{code}</GuideCodeSpan>);
    } else if (token.startsWith('**')) {
      nodes.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('_')) {
      const italicText = match[4];
      nodes.push(<em key={key++}>{italicText}</em>);
    } else if (token.startsWith('*')) {
      nodes.push(<em key={key++}>{token.slice(1, -1)}</em>);
    } else if (token.startsWith('http')) {
      nodes.push(
        <a key={key++} href={token} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline break-all">
          {token}
        </a>
      );
    }

    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}
