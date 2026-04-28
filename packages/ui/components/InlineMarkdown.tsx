import React from "react";
import { transformPlainText } from "../utils/inlineTransforms";
import { getImageSrc } from "./ImageThumbnail";

const DANGEROUS_PROTOCOL = /^\s*(javascript|data|vbscript|file)\s*:/i;
function sanitizeLinkUrl(url: string): string | null {
  if (DANGEROUS_PROTOCOL.test(url)) return null;
  return url;
}

// Trim trailing sentence punctuation from a bare URL, but keep closing
// brackets when they balance an opener inside the URL (Wikipedia-style
// https://…/Function_(mathematics) should keep its closing paren).
export function trimUrlTail(url: string): string {
  const balanced = (u: string, close: string, open: string): boolean => {
    let opens = 0, closes = 0;
    for (const c of u) {
      if (c === open) opens++;
      else if (c === close) closes++;
    }
    return opens >= closes;
  };
  while (url.length > 0) {
    const last = url[url.length - 1];
    if (!/[.,;:!?)\]}>"']/.test(last)) break;
    if (last === ')' && balanced(url, ')', '(')) break;
    if (last === ']' && balanced(url, ']', '[')) break;
    if (last === '}' && balanced(url, '}', '{')) break;
    url = url.slice(0, -1);
  }
  return url;
}

// Scan a plain-text chunk for bare https?:// URLs at word boundaries and
// emit them as anchor nodes, passing surrounding text through
// transformPlainText so emoji shortcodes and smart punctuation still apply
// to the non-URL slices.
function emitPlainTextWithBareUrls(
  text: string,
  previousChar: string,
  parts: React.ReactNode[],
  nextKey: () => number,
): void {
  if (text.length === 0) return;
  const re = /https?:\/\/[^\s<>"']+/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const before = m.index === 0 ? previousChar : text[m.index - 1];
    if (/\w/.test(before)) continue;
    const raw = m[0];
    const url = trimUrlTail(raw);
    const safe = url.length > 0 ? sanitizeLinkUrl(url) : null;
    if (!safe) continue;
    if (m.index > last) {
      parts.push(transformPlainText(text.slice(last, m.index)));
    }
    parts.push(
      <a
        key={nextKey()}
        href={safe}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary underline underline-offset-2 hover:text-primary/80"
      >
        {url}
      </a>,
    );
    last = m.index + url.length;
    re.lastIndex = last;
  }
  if (last < text.length) {
    parts.push(transformPlainText(text.slice(last)));
  }
}

/**
 * Scanner that walks a text string and emits React nodes for inline markdown:
 * emphasis (**bold**, *italic*, _italic_, ***both***), `code`, ~~strikethrough~~,
 * [label](url) / ![alt](src) / <autolink>, bare https:// URLs, [[wiki-links]],
 * hex color swatches (#fff / #123abc), @mentions, #issue-refs, and backslash
 * escapes. Plain-text chunks outside these patterns pass through
 * `transformPlainText` for emoji shortcodes + smart punctuation.
 */
export const InlineMarkdown: React.FC<{
  text: string;
  onOpenLinkedDoc?: (path: string) => void;
  onNavigateAnchor?: (hash: string) => void;
  imageBaseDir?: string;
  onImageClick?: (src: string, alt: string) => void;
  githubRepo?: string;
}> = ({ text, onOpenLinkedDoc, onNavigateAnchor, imageBaseDir, onImageClick, githubRepo }) => {
  const parts: React.ReactNode[] = [];
  let remaining = text;
  let key = 0;
  let previousChar = "";

  while (remaining.length > 0) {
    // Backslash escaping: \. \* \_ \` \[ \~ etc. — emit literal char, hide backslash
    let match = remaining.match(/^\\([\\*_`\[\]~!.()\-#>+|{}&])/);
    if (match) {
      parts.push(match[1]);
      remaining = remaining.slice(2);
      previousChar = match[1];
      continue;
    }

    // Bare URL autolink: https://… preceded by word boundary.
    // Trailing sentence punctuation is trimmed so "See https://x.com."
    // renders the period outside the link. Closing brackets are kept when
    // they balance an earlier opener inside the URL (e.g. Wikipedia's
    // https://…/Function_(mathematics) keeps its trailing paren).
    if (!/\w/.test(previousChar)) {
      const bareMatch = remaining.match(/^https?:\/\/[^\s<>"']+/);
      if (bareMatch) {
        const url = trimUrlTail(bareMatch[0]);
        const safe = url.length > 0 ? sanitizeLinkUrl(url) : null;
        if (safe) {
          parts.push(
            <a
              key={key++}
              href={safe}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline underline-offset-2 hover:text-primary/80"
            >
              {url}
            </a>,
          );
          remaining = remaining.slice(url.length);
          previousChar = url[url.length - 1];
          continue;
        }
      }
    }

    // Autolinks: <https://url> or <email@domain.com>
    match = remaining.match(/^<(https?:\/\/[^>]+)>/);
    if (match) {
      const url = match[1];
      parts.push(
        <a
          key={key++}
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary underline underline-offset-2 hover:text-primary/80"
        >
          {url}
        </a>,
      );
      remaining = remaining.slice(match[0].length);
      previousChar = ">";
      continue;
    }
    match = remaining.match(/^<([^@>\s]+@[^>\s]+)>/);
    if (match) {
      const email = match[1];
      parts.push(
        <a
          key={key++}
          href={`mailto:${email}`}
          className="text-primary underline underline-offset-2 hover:text-primary/80"
        >
          {email}
        </a>,
      );
      remaining = remaining.slice(match[0].length);
      previousChar = ">";
      continue;
    }

    // Strikethrough: ~~text~~
    match = remaining.match(/^~~([\s\S]+?)~~/);
    if (match) {
      parts.push(
        <del key={key++}>
          <InlineMarkdown
            imageBaseDir={imageBaseDir}
            onImageClick={onImageClick}
            text={match[1]}
            onOpenLinkedDoc={onOpenLinkedDoc}
            onNavigateAnchor={onNavigateAnchor}
            githubRepo={githubRepo}
          />
        </del>,
      );
      remaining = remaining.slice(match[0].length);
      previousChar = match[0][match[0].length - 1] || previousChar;
      continue;
    }

    // Bold + italic: ***text***
    match = remaining.match(/^\*\*\*([\s\S]+?)\*\*\*/);
    if (match) {
      parts.push(
        <strong key={key++} className="font-semibold">
          <em>
            <InlineMarkdown
              imageBaseDir={imageBaseDir}
              onImageClick={onImageClick}
              text={match[1]}
              onOpenLinkedDoc={onOpenLinkedDoc}
              onNavigateAnchor={onNavigateAnchor}
              githubRepo={githubRepo}
            />
          </em>
        </strong>,
      );
      remaining = remaining.slice(match[0].length);
      previousChar = match[0][match[0].length - 1] || previousChar;
      continue;
    }

    // Bold: **text** ([\s\S]+? allows matching across hard line breaks)
    match = remaining.match(/^\*\*([\s\S]+?)\*\*/);
    if (match) {
      parts.push(
        <strong key={key++} className="font-semibold">
          <InlineMarkdown
            imageBaseDir={imageBaseDir}
            onImageClick={onImageClick}
            text={match[1]}
            onOpenLinkedDoc={onOpenLinkedDoc}
            onNavigateAnchor={onNavigateAnchor}
            githubRepo={githubRepo}
          />
        </strong>,
      );
      remaining = remaining.slice(match[0].length);
      previousChar = match[0][match[0].length - 1] || previousChar;
      continue;
    }

    // Italic: *text* or _text_ (avoid intraword underscores)
    match = remaining.match(/^\*([\s\S]+?)\*/);
    if (match) {
      parts.push(
        <em key={key++}>
          <InlineMarkdown
            imageBaseDir={imageBaseDir}
            onImageClick={onImageClick}
            text={match[1]}
            onOpenLinkedDoc={onOpenLinkedDoc}
            onNavigateAnchor={onNavigateAnchor}
            githubRepo={githubRepo}
          />
        </em>,
      );
      remaining = remaining.slice(match[0].length);
      previousChar = match[0][match[0].length - 1] || previousChar;
      continue;
    }

    match = !/\w/.test(previousChar)
      ? remaining.match(/^_([^_\s](?:[\s\S]*?[^_\s])?)_(?!\w)/)
      : null;
    if (match) {
      parts.push(
        <em key={key++}>
          <InlineMarkdown
            imageBaseDir={imageBaseDir}
            onImageClick={onImageClick}
            text={match[1]}
            onOpenLinkedDoc={onOpenLinkedDoc}
            onNavigateAnchor={onNavigateAnchor}
            githubRepo={githubRepo}
          />
        </em>,
      );
      remaining = remaining.slice(match[0].length);
      previousChar = match[0][match[0].length - 1] || previousChar;
      continue;
    }

    // Inline code: `code`
    match = remaining.match(/^`([^`]+)`/);
    if (match) {
      parts.push(
        <code
          key={key++}
          className="px-1.5 py-0.5 rounded bg-muted text-sm font-mono"
        >
          {match[1]}
        </code>,
      );
      remaining = remaining.slice(match[0].length);
      previousChar = match[0][match[0].length - 1] || previousChar;
      continue;
    }

    // Hex color swatch — 3/4-digit forms need an a-f letter to avoid matching issue refs like #123.
    match = remaining.match(
      /^(#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|(?=[0-9a-fA-F]*[a-fA-F])[0-9a-fA-F]{4}|(?=[0-9a-fA-F]*[a-fA-F])[0-9a-fA-F]{3}))(?![0-9a-fA-F\w])/,
    );
    if (match) {
      const hex = match[1];
      parts.push(
        <span
          key={key++}
          className="inline-flex items-center gap-1 align-middle"
        >
          <span
            className="inline-block w-3.5 h-3.5 rounded-sm border border-black/20 dark:border-white/20 flex-shrink-0"
            style={{ backgroundColor: hex }}
            title={hex}
          />
          <code className="px-1.5 py-0.5 rounded bg-muted text-sm font-mono">
            {hex}
          </code>
        </span>,
      );
      remaining = remaining.slice(match[0].length);
      previousChar = match[0][match[0].length - 1] || previousChar;
      continue;
    }

    // Issue / PR reference: #123 — only at word boundary, digits only.
    // Hex-swatch branch above already consumed #fff / #123abc etc., so a bare
    // #\d+ here is safe to treat as an issue ref.
    if (!/\w/.test(previousChar)) {
      match = remaining.match(/^#(\d+)(?!\w)/);
      if (match) {
        const num = match[1];
        const href = githubRepo && githubRepo.includes('/')
          ? `https://github.com/${githubRepo}/issues/${num}`
          : null;
        const label = `#${num}`;
        parts.push(
          href ? (
            <a
              key={key++}
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary font-medium hover:underline"
            >
              {label}
            </a>
          ) : (
            <span key={key++} className="text-primary font-medium">{label}</span>
          ),
        );
        remaining = remaining.slice(match[0].length);
        previousChar = match[0][match[0].length - 1];
        continue;
      }
    }

    // @mention — only at word boundary. GitHub-style handle pattern.
    if (!/\w/.test(previousChar)) {
      match = remaining.match(/^@([a-zA-Z][a-zA-Z0-9_-]{0,38})(?!\w)/);
      if (match) {
        const handle = match[1];
        const href = githubRepo && githubRepo.includes('/')
          ? `https://github.com/${handle}`
          : null;
        const label = `@${handle}`;
        parts.push(
          href ? (
            <a
              key={key++}
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary font-medium hover:underline"
            >
              {label}
            </a>
          ) : (
            <span key={key++} className="text-primary font-medium">{label}</span>
          ),
        );
        remaining = remaining.slice(match[0].length);
        previousChar = match[0][match[0].length - 1];
        continue;
      }
    }

    // Wikilinks: [[filename]] or [[filename|display text]]
    match = remaining.match(/^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/);
    if (match) {
      const target = match[1].trim();
      const display = match[2]?.trim() || target;
      const targetPath = /\.(mdx?|html?)$/i.test(target)
        ? target
        : `${target}.md`;

      if (onOpenLinkedDoc) {
        parts.push(
          <a
            key={key++}
            href={targetPath}
            onClick={(e) => {
              e.preventDefault();
              onOpenLinkedDoc(targetPath);
            }}
            className="text-primary underline underline-offset-2 hover:text-primary/80 inline-flex items-center gap-1 cursor-pointer"
            title={`Open: ${target}`}
          >
            {display}
            <svg
              className="w-3 h-3 opacity-50 flex-shrink-0"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"
              />
            </svg>
          </a>,
        );
      } else {
        parts.push(
          <span key={key++} className="text-primary">
            {display}
          </span>,
        );
      }
      remaining = remaining.slice(match[0].length);
      previousChar = match[0][match[0].length - 1] || previousChar;
      continue;
    }

    // Images: ![alt](path)
    match = remaining.match(/^!\[([^\]]*)\]\(([^)]+)\)/);
    if (match) {
      const alt = match[1];
      const src = match[2];
      const imgSrc = /^(https?:\/\/|data:|blob:)/i.test(src)
        ? src
        : getImageSrc(src, imageBaseDir);
      parts.push(
        <img
          key={key++}
          src={imgSrc}
          alt={alt}
          className="max-w-full rounded my-2 cursor-zoom-in"
          loading="lazy"
          onClick={(e) => {
            e.stopPropagation();
            onImageClick?.(imgSrc, alt);
          }}
        />,
      );
      remaining = remaining.slice(match[0].length);
      previousChar = match[0][match[0].length - 1] || previousChar;
      continue;
    }

    // Links: [text](url) — url may contain balanced parens (e.g. Wikipedia
    // /Function_(mathematics)). Plain `[^)]+` would truncate at the first
    // inner close-paren, so we scan the destination manually tracking depth.
    const linkParsed = (() => {
      if (remaining[0] !== '[') return null;
      let i = 1;
      let depth = 1;
      while (i < remaining.length && depth > 0) {
        const ch = remaining[i];
        if (ch === '\\' && i + 1 < remaining.length) { i += 2; continue; }
        if (ch === '[') depth++;
        else if (ch === ']') depth--;
        if (depth === 0) break;
        i++;
      }
      if (depth !== 0 || remaining[i + 1] !== '(') return null;
      const textEnd = i;
      let j = i + 2;
      let parenDepth = 1;
      while (j < remaining.length && parenDepth > 0) {
        const ch = remaining[j];
        if (ch === '\\' && j + 1 < remaining.length) { j += 2; continue; }
        if (ch === '(') parenDepth++;
        else if (ch === ')') { parenDepth--; if (parenDepth === 0) break; }
        else if (ch === '\n') return null;
        j++;
      }
      if (parenDepth !== 0) return null;
      const linkText = remaining.slice(1, textEnd);
      const linkUrl = remaining.slice(i + 2, j);
      if (!linkText || !linkUrl) return null;
      return { linkText, linkUrl, consumed: j + 1 };
    })();
    if (linkParsed) {
      const { linkText, linkUrl, consumed } = linkParsed;
      const safeLinkUrl = sanitizeLinkUrl(linkUrl);

      // Dangerous protocol stripped — render as plain text, not a dead link
      if (safeLinkUrl === null) {
        parts.push(<span key={key++}>{linkText}</span>);
        remaining = remaining.slice(consumed);
        previousChar = ')';
        continue;
      }

      // Local doc: .md / .mdx / .html / .htm, optionally with #fragment.
      // Fragment is stripped before handing to onOpenLinkedDoc (overlay has
      // no anchor-scroll support today).
      const isLocalDoc =
        /\.(mdx?|html?)(#.*)?$/i.test(linkUrl) &&
        !linkUrl.startsWith("http://") &&
        !linkUrl.startsWith("https://");
      const linkedDocPath = isLocalDoc ? linkUrl.replace(/#.*$/, '') : linkUrl;
      const isInPageAnchor = safeLinkUrl.startsWith('#');

      if (isInPageAnchor) {
        parts.push(
          <a
            key={key++}
            href={safeLinkUrl}
            onClick={onNavigateAnchor ? (e) => {
              e.preventDefault();
              onNavigateAnchor(safeLinkUrl);
            } : undefined}
            className="text-primary underline underline-offset-2 hover:text-primary/80"
          >
            {linkText}
          </a>,
        );
      } else if (isLocalDoc && onOpenLinkedDoc) {
        parts.push(
          <a
            key={key++}
            href={safeLinkUrl}
            onClick={(e) => {
              e.preventDefault();
              onOpenLinkedDoc(linkedDocPath);
            }}
            className="text-primary underline underline-offset-2 hover:text-primary/80 inline-flex items-center gap-1 cursor-pointer"
            title={`Open: ${linkUrl}`}
          >
            {linkText}
            <svg
              className="w-3 h-3 opacity-50 flex-shrink-0"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"
              />
            </svg>
          </a>,
        );
      } else if (isLocalDoc) {
        // No handler — render as plain link (e.g., in shared/portal views)
        parts.push(
          <a
            key={key++}
            href={safeLinkUrl}
            className="text-primary underline underline-offset-2 hover:text-primary/80"
          >
            {linkText}
          </a>,
        );
      } else {
        parts.push(
          <a
            key={key++}
            href={safeLinkUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline underline-offset-2 hover:text-primary/80"
          >
            {linkText}
          </a>,
        );
      }
      remaining = remaining.slice(consumed);
      previousChar = ')';
      continue;
    }

    // Hard line break: two+ trailing spaces + newline, or backslash + newline
    match = remaining.match(/ {2,}\n|\\\n/);
    if (match && match.index !== undefined) {
      const before = remaining.slice(0, match.index);
      if (before) {
        parts.push(
          <InlineMarkdown
            key={key++}
            text={before}
            onOpenLinkedDoc={onOpenLinkedDoc}
            onNavigateAnchor={onNavigateAnchor}
            githubRepo={githubRepo}
            imageBaseDir={imageBaseDir}
            onImageClick={onImageClick}
          />,
        );
      }
      parts.push(<br key={key++} />);
      remaining = remaining.slice(match.index + match[0].length);
      previousChar = "\n";
      continue;
    }

    // Find next special character or consume one regular character.
    // `h` is intentionally NOT in this class — plain-text chunks may contain
    // `h` mid-word (e.g. ":heart:", "hello"), and splitting on it breaks
    // multi-char patterns like emoji shortcodes. Bare URLs are instead
    // detected inline via emitPlainTextWithBareUrls() below.
    const nextSpecial = remaining.slice(1).search(/[\*_`\[!~\\<#@]/);
    const plainText = nextSpecial === -1 ? remaining : remaining.slice(0, nextSpecial + 1);
    emitPlainTextWithBareUrls(plainText, previousChar, parts, () => key++);
    previousChar = plainText[plainText.length - 1] || previousChar;
    if (nextSpecial === -1) {
      break;
    }
    remaining = remaining.slice(nextSpecial + 1);
  }

  return <>{parts}</>;
};
