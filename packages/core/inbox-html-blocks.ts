/**
 * The live `html` blocks of an Inbox message's text (```html fences, drawn as
 * sandboxed pages in the message: approval "inbox-inline-html"), as artifacts
 * of their thread (the owner, 2026-11-25: "render html inline still and offer
 * same UX there ... Ideally it would show in artifacts"). A block is not a
 * file: nothing is saved, it opens its own page, big, from the Artifacts grid
 * and the Artifacts wall (packages/inbox/htmlArtifactOpen.ts).
 *
 * Its key is `html:<message id>:<hash>`, the hash a short digest of the
 * block's source: the same key on every read, on this Inbox and a linked one,
 * in the window and in the store. A block whose source is the same as an
 * earlier block of the same message is that block (one artifact). Another
 * block of the message changing or moving never moves a pin onto the wrong
 * block; the pinned block itself changing ends its pin, as a deleted file's.
 *
 * The scan follows the block parser's top level (packages/ui/utils/parser.ts):
 * a fence inside a quote, a `:::` directive, a raw HTML block, display math or
 * a table is not a block of the message. Pure.
 */

import {
  DIRECTIVE_OPEN_RE,
  codeFenceCloseIndex,
  directiveCloseIndex,
  htmlBlockEndAt,
  scanDisplayMath,
  type TagCloseIndex,
} from "./markdown-structure";
import { isInboxId } from "./inbox-types";

/** One live html block of a message's text. */
export interface InboxHtmlBlock {
  /** Its place among the message's html fences, from 1, in text order (as `HtmlBlockAnchor.index` counts them). */
  index: number;
  /** A digest of the source, 16 hex digits: with the message's id, the artifact's key. */
  hash: string;
  /** The fence's source, as the message draws it. */
  content: string;
  /** The fence's opening line in the text, from 1. */
  startLine: number;
  /** The page's first heading (else its `<title>`), as plain words; null when it has none. */
  title: string | null;
  /** The source's size in bytes (UTF-8). */
  size: number;
}

export const INBOX_HTML_ARTIFACT_PREFIX = "html:";
const HASH = /^[a-f0-9]{16}$/;

/** The key of a message's html block. */
export function inboxHtmlArtifactKey(messageId: string, hash: string): string {
  return `${INBOX_HTML_ARTIFACT_PREFIX}${messageId}:${hash}`;
}

/** The message and hash an html block's key names, or null for any other key. */
export function readInboxHtmlArtifactKey(key: unknown): { messageId: string; hash: string } | null {
  if (typeof key !== "string" || !key.startsWith(INBOX_HTML_ARTIFACT_PREFIX)) return null;
  const rest = key.slice(INBOX_HTML_ARTIFACT_PREFIX.length);
  const at = rest.lastIndexOf(":");
  const messageId = rest.slice(0, at);
  const hash = rest.slice(at + 1);
  return at > 0 && isInboxId("msg", messageId) && HASH.test(hash) ? { messageId, hash } : null;
}

/** A short, stable digest of a block's source (two 32-bit lanes, cyrb53's mix): not a security hash. */
export function inboxHtmlBlockHash(source: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < source.length; i++) {
    const ch = source.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

const TITLE_MAX = 120;
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** How much of a page its name is read from, and how much of a heading: a name is short, and a block may be huge. */
const TITLE_SCAN = 64 * 1024;
const TITLE_INNER = 1024;
const TITLE_TAG = /<(h[1-6]|title|script|style|template)(?=[\s/>]|$)/y;

/**
 * The words of the page's first heading (`<h1>`…`<h6>`) outside a comment, script, style or template, else of
 * its `<title>`; null when it has neither. One pass of indexOf over the first 64 KB: a tag with no close is
 * remembered, so a page of many unclosed tags costs no more than one.
 */
function titleInner(source: string): string | null {
  const text = source.length > TITLE_SCAN ? source.slice(0, TITLE_SCAN) : source;
  const lower = text.toLowerCase();
  const unclosed = new Set<string>();
  let title: string | null = null;
  let at = 0;
  for (;;) {
    const lt = lower.indexOf("<", at);
    if (lt === -1) break;
    if (lower.startsWith("<!--", lt)) {
      const end = lower.indexOf("-->", lt + 4);
      if (end === -1) break;
      at = end + 3;
      continue;
    }
    TITLE_TAG.lastIndex = lt;
    const tag = TITLE_TAG.exec(lower)?.[1];
    if (!tag || unclosed.has(tag)) {
      at = lt + 1;
      continue;
    }
    const close = lower.indexOf(`</${tag}`, lt);
    if (close === -1) {
      unclosed.add(tag);
      at = lt + 1;
      continue;
    }
    at = close + tag.length + 2;
    if (tag === "script" || tag === "style" || tag === "template") continue;
    const open = lower.indexOf(">", lt);
    if (open === -1 || open > close) continue;
    const inner = text.slice(open + 1, Math.min(close, open + 1 + TITLE_INNER));
    if (tag !== "title") return inner;
    title ??= inner;
  }
  return title;
}

/** The page's first heading (`<h1>`…`<h6>`), else its `<title>`, as plain words; null when it has none. */
export function inboxHtmlBlockTitle(source: string): string | null {
  const inner = titleInner(source);
  if (inner === null) return null;
  const words = inner
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, name: string) => {
      if (name[0] === "#") {
        const code = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
        return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
      }
      return ENTITIES[name.toLowerCase()] ?? whole;
    })
    .replace(/\s+/g, " ")
    .trim();
  if (!words) return null;
  return words.length > TITLE_MAX ? `${words.slice(0, TITLE_MAX - 1).trimEnd()}…` : words;
}

/** ```html (any case), a word after it allowed: the fences the message draws as live pages (ui's `isHtmlEmbedLanguage`). */
function isHtmlFence(language: string): boolean {
  return language.trim().split(/\s+/, 1)[0]?.toLowerCase() === "html";
}

const byteLength = (text: string): number => new TextEncoder().encode(text).length;

/** Bodies already read (a thread is read again and again): the newest kept, a few hundred at most. */
const scanned = new Map<string, readonly InboxHtmlBlock[]>();
const SCANNED_MAX = 400;
const NONE: readonly InboxHtmlBlock[] = Object.freeze([]);
const HTML_FENCE_HINT = /```[ \t]*html/i;

/** A message text's live html blocks in text order, each source once (its first place). */
export function inboxMessageHtmlBlocks(body: string): readonly InboxHtmlBlock[] {
  // One pass, no allocation: a text with no html fence (nearly all of them) is never scanned or cached.
  if (!HTML_FENCE_HINT.test(body)) return NONE;
  const kept = scanned.get(body);
  if (kept) return kept;
  const blocks = scan(body);
  scanned.set(body, blocks);
  if (scanned.size > SCANNED_MAX) scanned.delete(scanned.keys().next().value!);
  return blocks;
}

function scan(body: string): readonly InboxHtmlBlock[] {
  const lines = body.split("\n");
  const out: InboxHtmlBlock[] = [];
  const seen = new Set<string>();
  const closeCache = new Map<string, TagCloseIndex>();
  let index = 0;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (trimmed.startsWith(">")) {
      // A quote's run: a fence inside it is the quote's.
      while (i + 1 < lines.length && lines[i + 1]!.trim().startsWith(">")) i++;
      continue;
    }
    if (trimmed.startsWith("```")) {
      const fence = trimmed.match(/^`+/)![0].length;
      const close = codeFenceCloseIndex(lines, i);
      if (isHtmlFence(trimmed.slice(fence))) {
        index += 1;
        const content = lines.slice(i + 1, close).join("\n");
        const hash = inboxHtmlBlockHash(content);
        if (!seen.has(hash)) {
          seen.add(hash);
          out.push({ index, hash, content, startLine: i + 1, title: inboxHtmlBlockTitle(content), size: byteLength(content) });
        }
      }
      i = close;
      continue;
    }
    const math = trimmed.startsWith("$$") ? scanDisplayMath(lines, i, "$$") : trimmed.startsWith("\\[") ? scanDisplayMath(lines, i, "\\[") : null;
    if (math) {
      // Text after the close is read again as its own line, as the parser does.
      if (math.remainder) {
        lines[math.closeLine] = math.remainder;
        i = math.closeLine - 1;
      } else i = math.closeLine;
      continue;
    }
    if (trimmed.startsWith("|")) {
      while (i + 1 < lines.length && lines[i + 1]!.trim().startsWith("|")) i++;
      continue;
    }
    if (DIRECTIVE_OPEN_RE.test(trimmed)) {
      i = directiveCloseIndex(lines, i);
      continue;
    }
    const html = htmlBlockEndAt(lines, i, closeCache);
    if (html !== -1) i = html;
  }
  return out.length === 0 ? NONE : out;
}
