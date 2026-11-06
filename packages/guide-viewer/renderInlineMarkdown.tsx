import React from 'react';
import { isCodeFilePath } from '@plannotator/core/code-file';
import { GUIDE_LINK_TARGET_SOURCE } from '@plannotator/core/guide-links';

/**
 * Renders a guide link (`[label](code:…)`, `symbol:…`, `chapter:…`). Hosts that
 * can act on the link return a control; `null` falls back to the label as
 * plain text, which is also what happens when no renderer is given.
 */
export type GuideLinkRenderer = (href: string, label: React.ReactNode, key: number) => React.ReactNode | null;

/**
 * A host's own wrap for an inline code span that names a code file (`src/a.ts:12`): `text` is the span's words, `code`
 * the span as it is drawn without a host. With no provider, nothing changes.
 */
export type GuideCodeSpanRenderer = (text: string, code: React.ReactNode) => React.ReactNode;
export const GuideCodeSpanContext = React.createContext<GuideCodeSpanRenderer | null>(null);

function GuideCodeSpan({ text, children }: { text: string; children: React.ReactNode }) {
  const wrap = React.useContext(GuideCodeSpanContext);
  return <>{wrap && isCodeFilePath(text) ? wrap(text, children) : children}</>;
}

/**
 * A host's say over a guide's pictures (`![alt](https://…)`), given the src as written: the src to load, or
 * null to draw no picture (the Plannotator Inbox window loads none from the web). With no provider, every
 * picture loads as written.
 */
export type GuideImageSrcResolver = (src: string) => string | null;
export const GuideImageSrcContext = React.createContext<GuideImageSrcResolver | null>(null);

function GuideImage({ src, alt, resolveImageSrc }: { src: string; alt: string; resolveImageSrc?: (src: string) => string }) {
  const host = React.useContext(GuideImageSrcContext);
  const shown = host ? host(src) : src;
  if (shown === null) return null;
  return (
    <img
      src={resolveImageSrc?.(shown) ?? shown}
      alt={alt}
      loading="lazy"
      className="max-w-full h-auto rounded my-1"
      onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
    />
  );
}

export interface InlineMarkdownOptions {
  renderLink?: GuideLinkRenderer;
  resolveImageSrc?: (src: string) => string;
}

/**
 * Renders simple inline markdown: `code`, **bold**, *italic*, _italic_, and
 * fenced code blocks (```...```). Enough for review comments. Guide links
 * (`code:`, `symbol:`, `chapter:`) go through `opts.renderLink`.
 */
export function renderInlineMarkdown(text: string, opts?: InlineMarkdownOptions): React.ReactNode[] {
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
      nodes.push(...renderInline(part, key, opts));
      key++;
    }
  }

  return nodes;
}

function renderInline(text: string, startKey: number, opts?: InlineMarkdownOptions, inLink = false): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let key = startKey;

  // Match inline patterns: [text](url), `code`, **bold**, *italic*, _italic_, bare URLs
  // The last alternative is a guide link: [label](code:…|symbol:…|chapter:…),
  // its target read as guide-links reads it (balanced parentheses allowed).
  const regex = new RegExp(
    String.raw`(\[([^\]]+)\]\((https?:\/\/[^)]+)\)|` + '`[^`]+`' + String.raw`|\*\*[^*]+\*\*|(?<!\w)_([^_\s](?:[\s\S]*?[^_\s])?)_(?!\w)|\*[^*]+\*|https?:\/\/[^\s<)\]]+|\[([^\]]+)\]\((${GUIDE_LINK_TARGET_SOURCE})\))`,
    'g',
  );
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    // A `[text](url)` match preceded by `!` is a markdown image `![alt](url)`.
    const isImage = !!(match[1] && match[2] && match[3]) && text[match.index - 1] === '!';

    // Text before match (drop the trailing '!' that marks an image).
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
        // Markdown image: ![alt](url). Broken sources hide themselves; a host may refuse one (GuideImageSrcContext).
        nodes.push(<GuideImage key={key++} src={match[3]} alt={match[2]} resolveImageSrc={opts?.resolveImageSrc} />);
      } else {
        // Markdown link: [text](url)
        nodes.push(
          <a key={key++} href={match[3]} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
            {match[2]}
          </a>
        );
      }
    } else if (token.startsWith('`')) {
      // A span inside a guide link's label is that link's words: the link decides what a click does.
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
