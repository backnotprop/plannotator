import React, { useState, useMemo } from "react";
import { isCodeFilePath, isCodeFilePathStrict, CODE_PATH_BARE_REGEX, parseCodePath } from "@plannotator/core/code-file";
import { findCrossRepoRef, forgeRefLinks, matchCrossRepoRef, type CrossRepoRef } from "@plannotator/core/forge-refs";
import { CodeSnippetPreview } from "./CodeSnippetPreview";
import { useHoverPreview } from "../hooks/useHoverPreview";
import { transformPlainText } from "../utils/inlineTransforms";
import { hasLinkedDocExtension } from "../utils/markdownExtensions";
import { getImageSrc } from "./ImageThumbnail";
import { UNAVAILABLE_IMAGE_CLASS, useImageResolver } from "./ImageResolverContext";
import { useCodePathValidation, type CodePathValidationContextValue } from "./CodePathValidationContext";
import { isLocalLinkTarget, isNewTabClick, useLocalLinkResolver } from "./LocalLinkContext";
import type { ValidationEntry } from "../hooks/useValidatedCodePaths";
import { CodeFilePicker } from "./CodeFilePicker";
import { normalizeMathTex, renderMathToHtml } from "../utils/math";
import { useMathRenderer } from "../hooks/useMathRenderer";
import { HostTitle } from "./HostTitle";

export interface DocPreviewResult {
  contents?: string;
  filepath?: string;
}
export type DocPreviewFetcher = (path: string, base?: string) => Promise<DocPreviewResult | null>;

/**
 * Default code-file hover-preview fetcher — Plannotator's `/api/doc` behavior, verbatim.
 */
const defaultDocPreviewFetcher: DocPreviewFetcher = async (path, base) => {
  const params = new URLSearchParams({ path });
  if (base) params.set('base', base);
  const res = await fetch(`/api/doc?${params}`);
  return await res.json();
};

// Module-level fetcher, stable identity. Defaults to Plannotator's `/api/doc`.
// A host (e.g. Workspaces) calls setDocPreviewFetcher once at startup to load
// hover previews from its own backend.
let docPreviewFetcher: DocPreviewFetcher = defaultDocPreviewFetcher;

/** Override how code-file hover previews are fetched. Call once at app startup. */
export const setDocPreviewFetcher = (fetcher: DocPreviewFetcher): void => {
  docPreviewFetcher = fetcher;
};

/** Reset to the default (Plannotator `/api/doc`) fetcher. Mainly for tests. */
export const resetDocPreviewFetcher = (): void => {
  docPreviewFetcher = defaultDocPreviewFetcher;
};

/** Read the active fetcher at call time (so a late override is honored). */
export const getDocPreviewFetcher = (): DocPreviewFetcher => docPreviewFetcher;

/**
 * Decide how a candidate code-file path should render based on validation state:
 *   - 'link'           → clickable, opens directly via onOpenCodeFile(resolvedOrInput)
 *   - 'ambiguous-link' → clickable, opens a picker over `matches`
 *   - 'plain'          → not a link (file does not exist anywhere in the repo)
 *
 * No provider or `ready: false` falls back to optimistic 'link' behavior.
 */
function gateCodePath(
  candidate: string,
  validation: CodePathValidationContextValue | null,
): { render: 'link'; resolved?: string } | { render: 'ambiguous-link'; matches: string[] } | { render: 'plain' } {
  if (!validation || !validation.ready) return { render: 'link' };
  const entry = validation.validated.get(candidate);
  // If the validator is ready but has no entry for this candidate, the
  // extractor intentionally excluded it (e.g., inside an HTML comment or
  // fenced code block). Demote rather than optimistically linking.
  if (!entry) return { render: 'plain' };
  switch ((entry as ValidationEntry).status) {
    case 'found':       return { render: 'link', resolved: (entry as Extract<ValidationEntry, { status: 'found' }>).resolved };
    case 'ambiguous':   return { render: 'ambiguous-link', matches: (entry as Extract<ValidationEntry, { status: 'ambiguous' }>).matches };
    case 'unavailable': return { render: 'link' };
    case 'missing':     return { render: 'plain' };
    default:            return { render: 'link' }; // unknown status — degrade to optimistic
  }
}

const CodeFileLink: React.FC<{
  candidate: string;
  display: string;
  onOpenCodeFile: (path: string) => void;
  baseDir?: string;
}> = ({ candidate, display, onOpenCodeFile, baseDir }) => {
  const validation = useCodePathValidation();
  const gate = gateCodePath(candidate, validation);
  const [pickerOpen, setPickerOpen] = useState(false);
  const parsed = parseCodePath(candidate);
  const hasLineRef = parsed.line != null;
  const hover = useHoverPreview<{ contents: string; filepath: string }>(async () => {
    const data = await docPreviewFetcher(candidate, baseDir);
    return data?.contents ? { contents: data.contents, filepath: data.filepath ?? candidate } : null;
  }, hasLineRef && gate.render !== 'plain');
  const hoverPreview = hover.preview;
  const anchorRef = hover.anchorRef;
  const handleMouseEnter = hover.onEnter;
  const handleMouseLeave = hover.onLeave;

  if (gate.render === 'plain') {
    return (
      <code className="px-1.5 py-0.5 rounded bg-muted text-sm font-mono">
        {display}
      </code>
    );
  }

  const isAmbiguous = gate.render === 'ambiguous-link';
  const lineSuffix = parsed.line != null ? `:${parsed.line}${parsed.lineEnd != null ? `-${parsed.lineEnd}` : ''}` : '';
  const handleClick = () => {
    handleMouseLeave();
    if (isAmbiguous) {
      setPickerOpen(true);
      return;
    }
    const resolvedPath = gate.render === 'link' && gate.resolved ? gate.resolved : candidate;
    onOpenCodeFile(gate.render === 'link' && gate.resolved ? resolvedPath + lineSuffix : candidate);
  };

  return (
    <>
      <code
        ref={(el) => { anchorRef.current = el; }}
        role="button"
        tabIndex={0}
        data-ambiguous={isAmbiguous ? "true" : undefined}
        onClick={handleClick}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleClick(); } }}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        className="code-file-link px-1.5 py-0.5 rounded bg-muted text-sm font-mono cursor-pointer hover:text-primary inline-flex items-center gap-1 transition-colors"
        title={isAmbiguous ? `${display} — multiple matches` : `View: ${display}`}
      >
        {display}
        <CodeFileIcon />
        {isAmbiguous && (
          <sup className="text-[0.6rem] opacity-70 -ml-0.5">{(gate as { matches: string[] }).matches.length}</sup>
        )}
      </code>
      {hoverPreview && hasLineRef && (
        <CodeSnippetPreview
          anchorEl={anchorRef.current}
          contents={hoverPreview.contents}
          filepath={hoverPreview.filepath}
          line={parsed.line!}
          lineEnd={parsed.lineEnd}
          {...hover.previewHandlers}
        />
      )}
      {pickerOpen && isAmbiguous && (
        <CodeFilePicker
          anchorEl={anchorRef.current}
          matches={(gate as { matches: string[] }).matches}
          onPick={(path) => { setPickerOpen(false); onOpenCodeFile(path + lineSuffix); }}
          onDismiss={() => setPickerOpen(false)}
        />
      )}
    </>
  );
};

const DANGEROUS_PROTOCOL = /^\s*(javascript|data|vbscript|file)\s*:/i;
function sanitizeLinkUrl(url: string): string | null {
  if (DANGEROUS_PROTOCOL.test(url)) return null;
  return url;
}

const CodeFileIcon = () => (
  <svg
    className="w-3 h-3 opacity-50 flex-shrink-0"
    fill="none"
    viewBox="0 0 24 24"
    stroke="currentColor"
    strokeWidth={2}
    aria-hidden="true"
  >
    <path strokeLinecap="round" strokeLinejoin="round" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
  </svg>
);

const InlineMath: React.FC<{ tex: string }> = ({ tex }) => {
  const normalizedTex = normalizeMathTex(tex);
  const renderer = useMathRenderer();
  const html = useMemo(() => renderMathToHtml(normalizedTex, false, renderer), [normalizedTex, renderer]);

  // Same wrapper in both branches (see MathBlock): the placeholder carries the
  // attributes annotation restore keys on, with the TeX as a text child.
  if (html === null) {
    return (
      <span
        className="math-inline math-annotatable text-foreground"
        data-math-tex={normalizedTex}
        data-math-display="false"
        aria-label={normalizedTex}
      >
        {normalizedTex}
      </span>
    );
  }

  return (
    <span
      className="math-inline math-annotatable text-foreground"
      data-math-tex={normalizedTex}
      data-math-display="false"
      aria-label={normalizedTex}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
};

function canRenderSpacedDollarMath(tex: string): boolean {
  const trimmed = normalizeMathTex(tex);
  if (!trimmed) return false;
  if (!/^\s|\s$/.test(tex)) return true;
  // Padding must be symmetric (`$ y $`). In `$write-better on the copy, and $`
  // the closing `$` is really the opener of the next `$skill` token.
  if (/^\s/.test(tex) !== /\s$/.test(tex)) return false;
  return (
    /\\[a-zA-Z]+/.test(trimmed) ||
    /[=^_{}+\-*/<>|]/.test(trimmed) ||
    /^[a-zA-Z]$/.test(trimmed)
  );
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

// Index of the first bare `http(s)://` URL that starts after index 0 and
// before `end` at a word boundary AND runs past `end`, or -1. Only such a
// URL needs the chunk split: one that ends inside the chunk is linked by
// emitPlainTextWithBareUrls in the same pass, exactly as before, so a
// paragraph of many URLs stays one pass instead of a loop turn (and a
// rescan of the rest of the text) per URL. Index 0 is left to the caller's
// own bare-URL check, which already ran for it.
const BARE_URL_SCHEME = /https?:\/\//g;
const BARE_URL_AT = /https?:\/\/[^\s<>"']+/y;
function bareUrlRunningPast(text: string, end: number): number {
  // Only a scheme that starts before `end` counts, so read no further than
  // `end` plus the longest scheme ("https://" less its first character).
  const window = text.slice(0, end + 7);
  BARE_URL_SCHEME.lastIndex = 1;
  let m: RegExpExecArray | null;
  while ((m = BARE_URL_SCHEME.exec(window)) !== null && m.index < end) {
    if (/\w/.test(window[m.index - 1])) continue;
    BARE_URL_AT.lastIndex = m.index;
    const url = BARE_URL_AT.exec(text);
    if (!url) continue;
    const urlEnd = m.index + trimUrlTail(url[0]).length;
    if (urlEnd > end) return m.index;
    // The URL ends inside the chunk; look for the next one after it.
    BARE_URL_SCHEME.lastIndex = Math.max(urlEnd, m.index + 1);
  }
  return -1;
}

// Scan a plain-text chunk for bare https?:// URLs and bare code file paths
// at word boundaries, emitting them as interactive nodes. Surrounding text
// passes through transformPlainText for emoji shortcodes + smart punctuation.
function emitPlainTextWithBareUrls(
  text: string,
  previousChar: string,
  parts: React.ReactNode[],
  nextKey: () => number,
  onOpenCodeFile?: (path: string) => void,
  validation?: CodePathValidationContextValue | null,
  baseDir?: string,
): void {
  if (text.length === 0) return;

  type Span = { start: number; end: number; kind: 'url'; value: string }
    | { start: number; end: number; kind: 'path'; value: string };
  const spans: Span[] = [];

  // Collect bare URLs
  const urlRe = /https?:\/\/[^\s<>"']+/g;
  let m: RegExpExecArray | null;
  while ((m = urlRe.exec(text)) !== null) {
    const before = m.index === 0 ? previousChar : text[m.index - 1];
    if (/\w/.test(before)) continue;
    const url = trimUrlTail(m[0]);
    const safe = url.length > 0 ? sanitizeLinkUrl(url) : null;
    if (!safe) continue;
    spans.push({ start: m.index, end: m.index + url.length, kind: 'url', value: url });
    urlRe.lastIndex = m.index + url.length;
  }

  // Collect bare code file paths (require /)
  if (onOpenCodeFile) {
    const pathRe = new RegExp(CODE_PATH_BARE_REGEX.source, 'g');
    while ((m = pathRe.exec(text)) !== null) {
      const before = m.index === 0 ? previousChar : text[m.index - 1];
      if (/\w/.test(before)) continue;
      const candidate = m[0];
      if (!isCodeFilePathStrict(candidate)) continue;
      const overlaps = spans.some(s => m!.index < s.end && m!.index + candidate.length > s.start);
      if (overlaps) continue;
      spans.push({ start: m.index, end: m.index + candidate.length, kind: 'path', value: candidate });
    }
  }

  if (spans.length === 0) {
    parts.push(transformPlainText(text));
    return;
  }

  spans.sort((a, b) => a.start - b.start);

  let last = 0;
  for (const span of spans) {
    if (span.start > last) {
      parts.push(transformPlainText(text.slice(last, span.start)));
    }
    if (span.kind === 'url') {
      parts.push(
        <a
          key={nextKey()}
          href={span.value}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary underline underline-offset-2 hover:text-primary/80"
        >
          {span.value}
        </a>,
      );
    } else {
      const cleanPath = span.value.replace(/#.*$/, '');
      const gate = gateCodePath(cleanPath, validation ?? null);
      if (gate.render === 'plain') {
        // Bare prose, file doesn't exist — emit as plain text, no link styling.
        parts.push(transformPlainText(span.value));
      } else {
        parts.push(
          <CodeFileLink
            key={nextKey()}
            candidate={cleanPath}
            display={span.value}
            onOpenCodeFile={onOpenCodeFile!}
            baseDir={baseDir}
          />,
        );
      }
    }
    last = span.end;
  }
  if (last < text.length) {
    parts.push(transformPlainText(text.slice(last)));
  }
}

/**
 * An image a host resolver chose; a load failure shows the placeholder.
 *
 * The `<img>` element itself never leaves the document: on failure the
 * placeholder is inserted BEFORE it (React's reference node is then the
 * `<img>`, which it owns) and the `<img>` is hidden. Replacing the `<img>`
 * would make React insert before the node that follows it, and when that is
 * a text node the annotation highlighter already moved into a `<mark>` (a
 * restored comment starting right after the image), `insertBefore` throws
 * and the whole document unmounts. A loaded image's DOM is unchanged.
 */
const HostResolvedImage: React.FC<{
  src: string;
  alt: string;
  /** The src as written in the markdown (`data-image-src`, read by the image viewer's region comments). */
  writtenSrc?: string;
  onImageClick?: (src: string, alt: string) => void;
}> = ({ src, alt, writtenSrc, onImageClick }) => {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const failed = failedSrc === src;
  return (
    <>
      {failed && (
        <span key="unavailable" className={`${UNAVAILABLE_IMAGE_CLASS} annotation-exclude`} title="Image could not be loaded" data-image-unavailable="">
          {alt || 'Image'}
        </span>
      )}
      <img
        key="image"
        src={src}
        alt={failed ? '' : alt}
        data-image-src={writtenSrc}
        data-image-failed={failed ? '' : undefined}
        hidden={failed || undefined}
        aria-hidden={failed || undefined}
        className={failed ? undefined : 'max-w-full rounded my-2 cursor-zoom-in'}
        loading="lazy"
        onError={() => setFailedSrc(src)}
        onClick={(e) => {
          e.stopPropagation();
          if (!failed) onImageClick?.(src, alt);
        }}
      />
    </>
  );
};

/**
 * Whether a digit-only 6/8-digit `#123456` is an issue ref (when a ref link can
 * be built) rather than a hex swatch. Off by default: every host renders such
 * values as colours. The Plannotator Inbox turns it on through
 * `configurePlannotatorUI({ digitHexIssueRefs: true })` (#1932).
 */
let digitHexIssueRefs = false;

export function setDigitHexIssueRefs(on: boolean): void {
  digitHexIssueRefs = on;
}

export function resetDigitHexIssueRefs(): void {
  digitHexIssueRefs = false;
}

export function getDigitHexIssueRefs(): boolean {
  return digitHexIssueRefs;
}

/**
 * Scanner that walks a text string and emits React nodes for inline markdown:
 * emphasis (**bold**, *italic*, _italic_, ***both***), `code`, ~~strikethrough~~,
 * [label](url) / ![alt](src) / <autolink>, bare https:// URLs, [[wiki-links]],
 * inline math ($...$), hex color swatches (#fff / #123abc), @mentions, #issue-refs, and backslash
 * escapes. Plain-text chunks outside these patterns pass through
 * `transformPlainText` for emoji shortcodes + smart punctuation.
 */
export const InlineMarkdown: React.FC<{
  text: string;
  onOpenLinkedDoc?: (path: string) => void;
  /**
   * SYNCHRONOUS wiki-link resolution (host-backed, e.g. an in-memory cache).
   * Called with the RAW stored target of a `[[target]]` / `[[target|label]]`
   * wiki-link — before any path normalization (no `.md` appended), so opaque
   * ids like `doc_01XYZ` arrive verbatim.
   *
   * Absent, or returning null/undefined → exactly today's rendering (stored
   * label, live link). `label` → displayed instead of the stored label (the
   * stored label is the fallback, the target the last resort). `status:
   * 'deleted'` → a muted, non-interactive span (no anchor, no link icon,
   * `onOpenLinkedDoc` is NOT wired) titled "Document deleted".
   *
   * Deliberately sync-only: no async variant, no loading states. Back it
   * with a cache you keep hydrated.
   */
  resolveLinkedDoc?: (target: string) => { label?: string; status?: 'active' | 'deleted' } | null;
  onOpenCodeFile?: (path: string) => void;
  onNavigateAnchor?: (hash: string) => void;
  imageBaseDir?: string;
  onImageClick?: (src: string, alt: string) => void;
  /** Repo path (`owner/repo`, `group/sub/project`) bare `#123` / `@user` refs link into. */
  githubRepo?: string;
  /** Host of that repo's git remote; picks the forge refs link to. Absent means github.com. */
  repoHost?: string;
}> = ({ text, onOpenLinkedDoc, resolveLinkedDoc, onOpenCodeFile, onNavigateAnchor, imageBaseDir, onImageClick, githubRepo, repoHost }) => {
  const validation = useCodePathValidation();
  const resolveLocalLink = useLocalLinkResolver();
  const resolveImage = useImageResolver();
  const refLinks = forgeRefLinks({ display: githubRepo, host: repoHost });
  // Cross-repo `owner/repo#123` refs: only for a caller that names its
  // project's repo (it knows the forge); otherwise they stay plain text, never
  // a guessed github.com link. With a code-file handler, an `owner/repo` that
  // is a code path not known to be missing stays the file (`src/app.js#12`).
  const crossRepoProject = githubRepo ? { host: repoHost } : null;
  const crossRepoAccept = (ref: CrossRepoRef): boolean =>
    !(onOpenCodeFile && isCodeFilePathStrict(ref.path) && gateCodePath(ref.path, validation ?? null).render !== 'plain');
  const parts: React.ReactNode[] = [];
  let remaining = text;
  let key = 0;
  let previousChar = "";

  while (remaining.length > 0) {
    // HTML comments: skip entirely — they should be invisible per CommonMark.
    // The parser doesn't recognize <!-- --> as a block-level construct, so
    // comments inside paragraphs land here. Without this, path detection
    // would linkify paths inside comments.
    let match = remaining.match(/^<!--[\s\S]*?-->/);
    if (match) {
      remaining = remaining.slice(match[0].length);
      previousChar = ">";
      continue;
    }

    // Inline math: \( ... \) or $...$ — require non-space content and avoid
    // display fences.
    if (remaining.startsWith('\\(')) {
      let end = -1;
      for (let i = 2; i < remaining.length - 1; i++) {
        if (remaining[i] === '\\' && remaining[i + 1] === ')') {
          if (i > 0 && remaining[i - 1] === '\\') continue;
          end = i;
          break;
        }
      }
      if (end > 1) {
        const tex = remaining.slice(2, end);
        if (tex.trim()) {
          parts.push(<InlineMath key={key++} tex={tex} />);
          remaining = remaining.slice(end + 2);
          previousChar = ')';
          continue;
        }
      }
    }

    // Backslash escaping: \. \* \_ \` \[ \~ \$ etc. — emit literal char, hide backslash
    match = remaining.match(/^\\([\\*_`\[\]~!.()\-#>+|{}&$])/);
    if (match) {
      parts.push(match[1]);
      remaining = remaining.slice(2);
      previousChar = match[1];
      continue;
    }

    // Inline math: $...$ — require non-space content and avoid $$ display fences.
    if (remaining.startsWith('$') && previousChar !== '$' && !remaining.startsWith('$$')) {
      let end = -1;
      for (let i = 1; i < remaining.length; i++) {
        if (remaining[i] === '\\') {
          i++;
          continue;
        }
        if (remaining[i] === '$') {
          end = i;
          break;
        }
      }
      if (end > 1) {
        const tex = remaining.slice(1, end);
        // Money guard: `$A$B` where a digit immediately follows the closing `$`
        // is almost always two currency amounts ("$5-$10", "$50,000-$100,000",
        // "$5/mo and tier B is $10/mo"), not inline math — real inline math never
        // abuts a digit across the closing delimiter. Leave such text literal.
        const afterClose = remaining[end + 1];
        const looksLikeMoney = /^\s*\d/.test(tex) && afterClose !== undefined && /\d/.test(afterClose);
        if (!looksLikeMoney && canRenderSpacedDollarMath(tex)) {
          parts.push(<InlineMath key={key++} tex={tex} />);
          remaining = remaining.slice(end + 1);
          previousChar = '$';
          continue;
        }
      }
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

    // Cross-repo ref: owner/repo#123, shown as written, linked on the
    // project's forge host. Read before file-path detection, so
    // `vercel/next.js#1` is a ref, not a path (unless the viewer knows that
    // file, see crossRepoAccept); `docs/guide.md#2` stays a path.
    const crossRepoRef = crossRepoProject ? matchCrossRepoRef(remaining, previousChar, crossRepoProject) : null;
    if (crossRepoRef && crossRepoAccept(crossRepoRef)) {
      parts.push(
        crossRepoRef.href ? (
          <a
            key={key++}
            href={crossRepoRef.href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary font-medium hover:underline"
          >
            {crossRepoRef.label}
          </a>
        ) : (
          crossRepoRef.label
        ),
      );
      remaining = remaining.slice(crossRepoRef.label.length);
      previousChar = crossRepoRef.label[crossRepoRef.label.length - 1];
      continue;
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

    // Keep custom autolinks literal; their contents should not
    // recurse into markdown parsing.
    match = remaining.match(/^<([A-Za-z][A-Za-z0-9.+-]{0,31}:[^\s<>]*)>/);
    if (match) {
      const content = match[1];
      parts.push(<span key={key++}>{`<${content}>`}</span>);
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
            resolveLinkedDoc={resolveLinkedDoc}
            onOpenCodeFile={onOpenCodeFile}
            onNavigateAnchor={onNavigateAnchor}
            githubRepo={githubRepo}
            repoHost={repoHost}
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
              resolveLinkedDoc={resolveLinkedDoc}
              onOpenCodeFile={onOpenCodeFile}
              onNavigateAnchor={onNavigateAnchor}
              githubRepo={githubRepo}
              repoHost={repoHost}
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
            resolveLinkedDoc={resolveLinkedDoc}
            onOpenCodeFile={onOpenCodeFile}
            onNavigateAnchor={onNavigateAnchor}
            githubRepo={githubRepo}
            repoHost={repoHost}
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
            resolveLinkedDoc={resolveLinkedDoc}
            onOpenCodeFile={onOpenCodeFile}
            onNavigateAnchor={onNavigateAnchor}
            githubRepo={githubRepo}
            repoHost={repoHost}
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
            resolveLinkedDoc={resolveLinkedDoc}
            onOpenCodeFile={onOpenCodeFile}
            onNavigateAnchor={onNavigateAnchor}
            githubRepo={githubRepo}
            repoHost={repoHost}
          />
        </em>,
      );
      remaining = remaining.slice(match[0].length);
      previousChar = match[0][match[0].length - 1] || previousChar;
      continue;
    }

    // Inline code: `code` — when the content is a code file path, render as clickable
    match = remaining.match(/^`([^`]+)`/);
    if (match) {
      const codeContent = match[1];
      if (isCodeFilePath(codeContent) && onOpenCodeFile) {
        const cleanPath = codeContent.replace(/#.*$/, '');
        parts.push(
          <CodeFileLink
            key={key++}
            candidate={cleanPath}
            display={codeContent}
            onOpenCodeFile={onOpenCodeFile}
            baseDir={imageBaseDir}
          />,
        );
      } else {
        parts.push(
          <code
            key={key++}
            className="px-1.5 py-0.5 rounded bg-muted text-sm font-mono"
          >
            {codeContent}
          </code>,
        );
      }
      remaining = remaining.slice(match[0].length);
      previousChar = match[0][match[0].length - 1] || previousChar;
      continue;
    }

    // Hex color swatch — 3/4-digit forms need an a-f letter to avoid matching issue refs like #123.
    // 6/8-digit forms with no letter (#186379) are ambiguous. By default they
    // stay swatches (greys like #333333 are common in docs; six-digit issues are
    // rare). A host that opts in with `configurePlannotatorUI({ digitHexIssueRefs:
    // true })` (the Plannotator Inbox, #1932) gets an issue ref instead, but only
    // when a ref link can actually be built (`refLinks`: a repo path on a known
    // forge) and the ref branch below would take it: a word boundary and no
    // leading zero (issue numbers never start with 0, so #000000 stays a colour).
    match = remaining.match(
      /^(#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|(?=[0-9a-fA-F]*[a-fA-F])[0-9a-fA-F]{4}|(?=[0-9a-fA-F]*[a-fA-F])[0-9a-fA-F]{3}))(?![0-9a-fA-F\w])/,
    );
    if (match && digitHexIssueRefs && refLinks && /^#[1-9]\d*$/.test(match[1]) && !/\w/.test(previousChar)) {
      match = null;
    }
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
    // Hex-swatch branch above already consumed #fff / #123abc etc. (and digit-only
    // #123456 / #12345678 unless the host opted in), so a bare #\d+ here is an issue ref.
    if (!/\w/.test(previousChar)) {
      match = remaining.match(/^#(\d+)(?!\w)/);
      if (match) {
        const num = match[1];
        const href = refLinks?.issue(num) ?? null;
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
        const href = refLinks?.user(handle) ?? null;
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
      const storedLabel = match[2]?.trim();
      // Host resolution gets the RAW target (pre-`.md` normalization): host
      // targets are opaque doc ids, not paths. null → today's rendering.
      const resolution = resolveLinkedDoc?.(target) ?? null;
      const display = resolution?.label || storedLabel || target;
      const targetPath = hasLinkedDocExtension(target)
        ? target
        : `${target}.md`;

      if (resolution?.status === 'deleted') {
        // Deleted doc: muted NON-link — no anchor, no pointer, no link icon —
        // even when onOpenLinkedDoc is present.
        parts.push(
          <span
            key={key++}
            className="text-muted-foreground line-through decoration-muted-foreground/60"
            title="Document deleted"
          >
            {display}
          </span>,
        );
      } else if (onOpenLinkedDoc) {
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
      // A host's resolver (RenderedMarkdown `resolveImage`) decides first;
      // null from it, or no resolver, keeps the default resolution.
      const resolvedImage = resolveImage ? resolveImage(src) : null;
      if (resolvedImage?.kind === 'unavailable') {
        parts.push(
          <span
            key={key++}
            className={UNAVAILABLE_IMAGE_CLASS}
            title={resolvedImage.title}
            data-image-unavailable=""
          >
            {alt || 'Image'}
          </span>,
        );
        remaining = remaining.slice(match[0].length);
        previousChar = match[0][match[0].length - 1] || previousChar;
        continue;
      }
      const imgSrc = resolvedImage?.kind === 'src'
        ? resolvedImage.src
        : /^(https?:\/\/|data:|blob:)/i.test(src)
          ? src
          : getImageSrc(src, imageBaseDir);
      parts.push(
        resolveImage ? (
          // With a host resolver, an image that fails to load becomes the
          // same placeholder instead of a broken-image icon.
          <HostResolvedImage key={key++} src={imgSrc} alt={alt} writtenSrc={src} onImageClick={onImageClick} />
        ) : (
          <img
            key={key++}
            src={imgSrc}
            alt={alt}
            data-image-src={src}
            className="max-w-full rounded my-2 cursor-zoom-in"
            loading="lazy"
            onClick={(e) => {
              e.stopPropagation();
              onImageClick?.(imgSrc, alt);
            }}
          />
        ),
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

      // Local doc: .md / .mdx / .txt / .html / .htm, optionally with #fragment.
      // Fragment is stripped before handing to onOpenLinkedDoc (overlay has
      // no anchor-scroll support today).
      const isLocalDoc =
        hasLinkedDocExtension(linkUrl, { allowFragment: true }) &&
        !linkUrl.startsWith("http://") &&
        !linkUrl.startsWith("https://");
      const isCodeFile = !isLocalDoc && isCodeFilePath(linkUrl);
      const linkedDocPath = isLocalDoc ? linkUrl.replace(/#.*$/, '') : linkUrl;
      const codeFilePath = isCodeFile ? linkUrl.replace(/#.*$/, '') : linkUrl;
      const isInPageAnchor = safeLinkUrl.startsWith('#');
      // A host's resolver (Viewer `resolveLocalLink`) decides local paths
      // first; null from it, or no resolver, keeps the branches below.
      const localLink = resolveLocalLink && isLocalLinkTarget(linkUrl) ? resolveLocalLink(linkUrl) : null;

      if (localLink?.kind === 'open') {
        const openLink = localLink.open;
        const hostHref = localLink.href;
        parts.push(
          <HostTitle key={key++} title={localLink.title}>
          <a
            href={hostHref ?? safeLinkUrl}
            onClick={(e) => {
              // With the host's own address, a new-tab click goes there.
              if (hostHref && isNewTabClick(e)) return;
              e.preventDefault();
              e.stopPropagation();
              openLink();
            }}
            // Without it, a middle click would open the path on the host's own origin.
            onAuxClick={hostHref ? undefined : (e) => e.preventDefault()}
            className="text-primary underline underline-offset-2 hover:text-primary/80 inline-flex items-center gap-1 cursor-pointer"
            data-local-link="open"
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
          </a>
          </HostTitle>,
        );
      } else if (localLink?.kind === 'unavailable') {
        parts.push(
          <HostTitle key={key++} title={localLink.title}>
            <span className="text-muted-foreground underline decoration-dotted underline-offset-2" data-local-link="unavailable">
              {linkText}
            </span>
          </HostTitle>,
        );
      } else if (isInPageAnchor) {
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
      } else if (isCodeFile && onOpenCodeFile) {
        parts.push(
          <a
            key={key++}
            href={safeLinkUrl}
            onClick={(e) => {
              e.preventDefault();
              onOpenCodeFile(codeFilePath);
            }}
            className="text-primary underline underline-offset-2 hover:text-primary/80 inline-flex items-center gap-1 cursor-pointer"
            title={`View: ${linkUrl}`}
          >
            {linkText}
            <CodeFileIcon />
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
            resolveLinkedDoc={resolveLinkedDoc}
            onOpenCodeFile={onOpenCodeFile}
            onNavigateAnchor={onNavigateAnchor}
            githubRepo={githubRepo}
            repoHost={repoHost}
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
    const nextSpecial = remaining.slice(1).search(/[\*_`\[!~\\<#@$]/);
    // A bare URL that starts inside this plain-text chunk and runs past its
    // end would be cut there, and `_`, `~`, `#`, `@`, `$` and `!` all end a
    // chunk (`…/w/ws_01…` rendered a link to `…/w/ws`). Stop the chunk where
    // that URL starts instead, so the bare-URL branch above takes it whole.
    const chunkEnd = nextSpecial === -1 ? remaining.length : nextSpecial + 1;
    // Same for an owner/repo#123 ref: `#` (and `_` in a name) ends a chunk, so
    // stop before the ref and let the cross-repo branch above take it whole.
    // A ref inside a URL never splits it: the URL starts first and wins.
    const urlAt = bareUrlRunningPast(remaining, chunkEnd);
    const refAt = crossRepoProject ? findCrossRepoRef(remaining, urlAt === -1 ? chunkEnd : urlAt, crossRepoProject, crossRepoAccept) : -1;
    const splitAt = refAt !== -1 ? refAt : urlAt;
    if (splitAt !== -1) {
      const before = remaining.slice(0, splitAt);
      emitPlainTextWithBareUrls(before, previousChar, parts, () => key++, onOpenCodeFile, validation, imageBaseDir);
      previousChar = before[before.length - 1] || previousChar;
      remaining = remaining.slice(splitAt);
      continue;
    }
    const plainText = nextSpecial === -1 ? remaining : remaining.slice(0, nextSpecial + 1);
    emitPlainTextWithBareUrls(plainText, previousChar, parts, () => key++, onOpenCodeFile, validation, imageBaseDir);
    previousChar = plainText[plainText.length - 1] || previousChar;
    if (nextSpecial === -1) {
      break;
    }
    remaining = remaining.slice(nextSpecial + 1);
  }

  return <>{parts}</>;
};
