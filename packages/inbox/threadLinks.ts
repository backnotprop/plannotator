/**
 * A thread's web links: every http(s) link its messages draw, once each,
 * forge links grouped by repository and every other link after them, for the
 * Links side of the Artifacts view (components/ThreadLinksView.tsx).
 *
 * What counts is what the message text draws as a link (`ui` InlineMarkdown):
 * `[text](url)`, `<url>`, a bare url, `owner/repo#12` and `#12` when the
 * project names its repo, and `<a href>` in a raw HTML block. Not: anything in
 * a code block or a code span, images, `@mentions`, local file links (they
 * have their own hover), links inside attachments. Nothing is fetched here: a
 * title is the words the message wrote for the link, when it wrote any.
 *
 * Pure: no DOM, no fetch.
 */

import { forgeRefKey, forgeRefLabel, webForgeHost } from '@plannotator/core/forge-ref-card';
import { classifyForgeHost, forgeRefLinks, matchCrossRepoRef, type ForgePlatform } from '@plannotator/core/forge-refs';
import type { InboxMessageWire, InboxProjectRepo } from '@plannotator/core/inbox-types';
import { parseTableContent } from '@plannotator/ui/components/blocks/TableBlock';
import { trimUrlTail } from '@plannotator/ui/components/InlineMarkdown';
import { parseMarkdownToBlocks } from '@plannotator/ui/utils/parser';

/** What a link on a forge is; the order a repository lists them in. */
export type ForgeLinkKind = 'pull' | 'issue' | 'file' | 'commit' | 'page';
const KIND_ORDER: readonly ForgeLinkKind[] = ['pull', 'issue', 'file', 'commit', 'page'];

export interface ThreadLink {
  href: string;
  /** Before the words, muted: "#412", a short commit. */
  lead: string | null;
  /** The row's words. */
  text: string;
  /** After the words, muted: the site's name. */
  tail: string | null;
  /** A file's whole path, for its hover. */
  path: string | null;
  /** Inside a repository: what it is. */
  kind: ForgeLinkKind | null;
  /** On a forge, whatever it names. */
  platform: ForgePlatform | null;
}

export interface RepoGroup {
  platform: ForgePlatform;
  /** `github.com`, `github.acme.dev`. */
  host: string;
  /** `acme/web`, or a GitLab project's whole path. */
  path: string;
  href: string;
  links: ThreadLink[];
}

export interface ThreadLinks {
  repos: RepoGroup[];
  /** Every other link, a site's links together. */
  others: ThreadLink[];
  /** What the list shows: every row, and a repository with nothing under it (its name is its row). */
  count: number;
}

export const NO_THREAD_LINKS: ThreadLinks = { repos: [], others: [], count: 0 };

/** A link as a message wrote it. */
export interface WrittenLink {
  href: string;
  /** The words of `[words](url)`; null for a bare url. */
  words: string | null;
  /** Built from `#12` / `owner/repo#12`: a url written out says more (a `/pull/` in it). */
  fromRef: boolean;
}

// ── Reading a message's text, in the renderer's order ──

const WEB = /^https?:\/\//i;
const BARE = /^https?:\/\/[^\s<>"']+/;
/** A quick look: no scheme, no `#12`, nothing to parse. */
const MAY_HAVE_LINK = /https?:\/\/|#\d/i;

/** `[words](url)` at `start` (the `[`), by the renderer's own scan; null when it is not a link. */
function readLink(text: string, start: number): { words: string; url: string; end: number } | null {
  let i = start + 1;
  let depth = 1;
  while (i < text.length && depth > 0) {
    const ch = text[i];
    if (ch === '\\' && i + 1 < text.length) {
      i += 2;
      continue;
    }
    if (ch === '[') depth++;
    else if (ch === ']') depth--;
    if (depth === 0) break;
    i++;
  }
  if (depth !== 0 || text[i + 1] !== '(') return null;
  let j = i + 2;
  let parens = 1;
  while (j < text.length && parens > 0) {
    const ch = text[j];
    if (ch === '\\' && j + 1 < text.length) {
      j += 2;
      continue;
    }
    if (ch === '(') parens++;
    else if (ch === ')') {
      parens--;
      if (parens === 0) break;
    } else if (ch === '\n') return null;
    j++;
  }
  if (parens !== 0) return null;
  const words = text.slice(start + 1, i);
  const url = text.slice(i + 2, j);
  return words && url ? { words, url, end: j + 1 } : null;
}

type RefRepo = { display: string; host?: string } | null;

function readInline(text: string, repo: RefRepo, out: WrittenLink[]): void {
  const refs = repo ? forgeRefLinks(repo) : null;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    const prev = i === 0 ? '' : text[i - 1]!;
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '`') {
      const close = text.indexOf('`', i + 1);
      if (close > i + 1) {
        i = close + 1;
        continue;
      }
    } else if (ch === '<') {
      if (text.startsWith('<!--', i)) {
        const close = text.indexOf('-->', i);
        i = close < 0 ? text.length : close + 3;
        continue;
      }
      const auto = /^<(https?:\/\/[^>]+)>/.exec(text.slice(i));
      if (auto) {
        out.push({ href: auto[1]!, words: null, fromRef: false });
        i += auto[0].length;
        continue;
      }
    } else if (ch === '!' && text[i + 1] === '[') {
      const image = readLink(text, i + 1);
      if (image) {
        i = image.end;
        continue;
      }
    } else if (ch === '[') {
      const link = readLink(text, i);
      if (link) {
        if (WEB.test(link.url)) out.push({ href: link.url.trim(), words: link.words, fromRef: false });
        i = link.end;
        continue;
      }
    } else if ((ch === 'h' || ch === 'H') && !/[^\W_]/.test(prev)) {
      const bare = BARE.exec(text.slice(i));
      if (bare) {
        // The renderer reads `**url**` from inside the bold: its marks are never the url's.
        const url = trimUrlTail(bare[0].replace(/[*_~]+$/, ''));
        if (url) {
          out.push({ href: url, words: null, fromRef: false });
          i += url.length;
          continue;
        }
      }
    }
    if (refs && !/[\w./@-]/.test(prev)) {
      if (ch === '#') {
        const num = /^#([1-9]\d*)(?!\w)/.exec(text.slice(i));
        if (num) {
          out.push({ href: refs.issue(num[1]!), words: null, fromRef: true });
          i += num[0].length;
          continue;
        }
      } else if (/[A-Za-z0-9]/.test(ch)) {
        const cross = matchCrossRepoRef(text.slice(i), prev, { host: repo?.host });
        if (cross?.href) {
          out.push({ href: cross.href, words: null, fromRef: true });
          i += cross.label.length;
          continue;
        }
      }
    }
    i++;
  }
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** An attribute's text as the browser reads it; null when it holds an entity this does not know (left out, never guessed). */
function attributeText(raw: string): string | null {
  let unknown = false;
  const text = raw.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (whole, name: string) => {
    const code = name[0] === '#' ? (name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)) : null;
    if (code !== null) return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ((unknown = true), whole);
    const named = ENTITIES[name.toLowerCase()];
    if (named === undefined) unknown = true;
    return named ?? whole;
  });
  return unknown ? null : text;
}

/** `<a href>` in a raw HTML block (the renderer draws them through DOMPurify): quoted or not, its entities read. */
function readHtml(html: string, out: WrittenLink[]): void {
  for (const m of html.matchAll(/<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))[^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = attributeText(m[1] ?? m[2] ?? m[3] ?? '')?.trim();
    if (href && WEB.test(href)) out.push({ href, words: m[4]!.replace(/<[^>]*>/g, '').trim() || null, fromRef: false });
  }
}

function readBlocks(markdown: string, repo: RefRepo, out: WrittenLink[]): void {
  for (const block of parseMarkdownToBlocks(markdown, { frontmatter: false })) {
    if (block.type === 'code' || block.type === 'math' || block.type === 'hr') continue;
    if (block.type === 'html') readHtml(block.content, out);
    else if (block.type === 'directive') readBlocks(block.content, repo, out);
    else if (block.type === 'table') {
      const { headers, rows } = parseTableContent(block.content);
      for (const cell of [...headers, ...rows.flat()]) readInline(cell, repo, out);
    } else readInline(block.content, repo, out);
  }
}

/** Every web link a message's text draws, in reading order, repeats included. */
export function linksOfBody(body: string, repo: RefRepo): WrittenLink[] {
  if (!MAY_HAVE_LINK.test(body)) return [];
  const out: WrittenLink[] = [];
  readBlocks(body, repo, out);
  return out;
}

/** Each message's links, read once per text: an open thread counts its links without reading every message again. */
const bodyLinks = new Map<string, { body: string; links: WrittenLink[] }>();
const BODY_LINKS_MAX = 5000;

function linksOfMessage(id: string, body: string, repo: RefRepo): WrittenLink[] {
  const key = `${repo ? `${repo.host ?? ''}/${repo.display}` : ''}\u0000${id}`;
  const hit = bodyLinks.get(key);
  if (hit && hit.body === body) return hit.links;
  const links = linksOfBody(body, repo);
  bodyLinks.delete(key);
  bodyLinks.set(key, { body, links });
  if (bodyLinks.size > BODY_LINKS_MAX) bodyLinks.delete(bodyLinks.keys().next().value!);
  return links;
}

// ── What a link is ──

const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const NUMBER = /^[1-9]\d{0,9}$/;
/** A forge's own pages: the first part of the path is no owner. */
const NOT_OWNERS: Record<ForgePlatform, ReadonlySet<string>> = {
  github: new Set(['about', 'apps', 'codespaces', 'collections', 'contact', 'customer-stories', 'enterprise', 'explore', 'features', 'issues', 'join', 'login', 'marketplace', 'new', 'notifications', 'orgs', 'pricing', 'pulls', 'readme', 'search', 'security', 'settings', 'sponsors', 'stars', 'topics', 'trending', 'users', 'watching']),
  gitlab: new Set(['admin', 'dashboard', 'explore', 'groups', 'help', 'projects', 'search', 'users']),
};

/** Readable, and never a way to turn text around (a bidi override written into a url). */
function readable(text: string): string {
  let out = text;
  try {
    out = decodeURI(text);
  } catch {
    // Not percent-encoded after all.
  }
  // Bidi overrides and isolates, direction marks, and the zero-width characters that hide text.
  return out.replace(/[\u202A-\u202E\u2066-\u2069\u200B-\u200F\u061C\u2060\uFEFF]/g, '');
}

interface Repository {
  platform: ForgePlatform;
  host: string;
  path: string;
  /** What the link names past the repository: its kind and the rest of its path. */
  section: string | null;
  rest: string[];
}

/** The repository a url is in; a forge's own page (`github.com/settings`) is only its platform. */
function readForge(url: URL): Repository | ForgePlatform | null {
  const host = webForgeHost(url.hostname);
  const platform = host ? classifyForgeHost(host) : null;
  if (!host || !platform) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  const dash = platform === 'gitlab' ? parts.indexOf('-') : -1;
  const owned = platform === 'github' ? parts.slice(0, 2) : dash >= 0 ? parts.slice(0, dash) : parts;
  if (owned.length < 2 || NOT_OWNERS[platform].has(owned[0]!.toLowerCase()) || !owned.every((p) => NAME.test(p))) return platform;
  const rest = platform === 'github' ? parts.slice(2) : dash >= 0 ? parts.slice(dash + 1) : [];
  return { platform, host, path: owned.join('/').replace(/\.git$/i, ''), section: rest[0] ?? null, rest: rest.slice(1) };
}

/** What a row says of a link in a repository, before any words the message wrote for it. */
interface RepoRow {
  kind: ForgeLinkKind;
  /** A number or a short commit: the row's words when the message wrote none. */
  mark: string | null;
  /** A file's name, a page's path. */
  name: string | null;
  /** A file's whole path. */
  path: string | null;
  /** The same item whatever its link says (a PR's `/files`, a comment on it). */
  key: string | null;
}

function repoRow({ platform, host, path, section, rest }: Repository, url: URL): RepoRow | null {
  if (!section) return null;
  const refKind = section === 'issues' || section === 'work_items' ? 'issue' : section === 'pull' || section === 'pulls' || section === 'merge_requests' ? 'pull' : null;
  if (refKind && rest[0] && NUMBER.test(rest[0])) {
    const number = Number(rest[0]);
    const cut = path.lastIndexOf('/');
    const key = forgeRefKey({ platform, host, owner: path.slice(0, cut), repo: path.slice(cut + 1), number, kind: refKind });
    return { kind: refKind, mark: forgeRefLabel({ platform, kind: refKind, number }), name: null, path: null, key };
  }
  if (section === 'blob' && rest.length > 1) {
    const file = rest.slice(1).map(readable);
    const line = /^#L(\d+)/.exec(url.hash)?.[1];
    return { kind: 'file', mark: null, name: `${file.at(-1)}${line ? `:${line}` : ''}`, path: file.join('/'), key: null };
  }
  if ((section === 'commit' || section === 'commits') && rest[0] && /^[0-9a-f]{7,40}$/i.test(rest[0])) {
    return { kind: 'commit', mark: rest[0].slice(0, 7), name: null, path: null, key: null };
  }
  return { kind: 'page', mark: null, name: readable([section, ...rest].join('/')), path: null, key: null };
}

/** The words a message wrote for a link, or null when they only repeat what the row says anyway. */
function titleOf(words: string | null, says: readonly (string | null)[]): string | null {
  if (!words) return null;
  const title = readable(
    words
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/`|\*\*|__|~~/g, '')
      .trim(),
  );
  if (!title) return null;
  const plain = (s: string) =>
    s
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^(pr|pull request|mr|merge request|issue)\s*/, '')
      .replace(/[/\s]+$/, '');
  return says.some((s) => s !== null && plain(s) === plain(title)) ? null : title;
}

/** `example.com`, `localhost:3000`: the site as a person says it. */
const siteOf = (url: URL) => url.host.replace(/^www\./i, '');

const urlKey = (url: URL) => `${url.host}${url.pathname.replace(/\/+$/, '')}${url.search}${url.hash}`;

function parseWeb(href: string): URL | null {
  try {
    const url = new URL(href);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

// ── The thread's list ──

interface Entry {
  key: string;
  href: string;
  title: string | null;
  fromRef: boolean;
  url: URL;
  /** Null: the repository's own link, or a link on no repository. */
  row: RepoRow | null;
  repository: Repository | null;
  platform: ForgePlatform | null;
}

/** A written link's entry, read once (the cached message's links keep theirs); the list copies it before changing it. */
const entries = new WeakMap<WrittenLink, Entry | null>();
function entryOfCached(written: WrittenLink): Entry | null {
  let entry = entries.get(written);
  if (entry === undefined) {
    entry = entryOf(written);
    entries.set(written, entry);
  }
  return entry;
}

function entryOf(written: WrittenLink): Entry | null {
  const url = parseWeb(written.href);
  if (!url) return null;
  const forge = readForge(url);
  const repository = forge && typeof forge === 'object' ? forge : null;
  const platform = repository?.platform ?? (typeof forge === 'string' ? forge : null);
  const base = { href: written.href, fromRef: written.fromRef, url, repository, platform };
  const whole = [url.href, `${url.host}${url.pathname}`, siteOf(url)];
  if (!repository) return { ...base, key: urlKey(url), row: null, title: titleOf(written.words, whole) };
  const row = repoRow(repository, url);
  const repoKey = `${repository.host}/${repository.path}`.toLowerCase();
  if (!row) return { ...base, key: `repo:${repoKey}`, row: null, title: null };
  const says = [...whole, row.mark, row.name, row.mark && `${repository.path}${row.mark}`];
  return { ...base, key: row.key ?? urlKey(url), row, title: titleOf(written.words, says) };
}

function linkOf(entry: Entry): ThreadLink {
  const { href, title, row, url, platform } = entry;
  const base = { href, platform, path: row?.path ?? null };
  if (row) {
    if (row.kind === 'file') return { ...base, kind: row.kind, lead: null, text: row.name!, tail: null };
    if (row.mark) return { ...base, kind: row.kind, lead: title ? row.mark : null, text: title ?? row.mark, tail: null };
    return { ...base, kind: row.kind, lead: null, text: title ?? row.name!, tail: null };
  }
  const site = siteOf(url);
  const path = readable(`${url.pathname.replace(/\/+$/, '')}${url.search}${url.hash}`).replace(/^\//, '');
  const text = title ?? (path || site);
  return { ...base, kind: null, lead: null, text, tail: text === site ? null : site };
}

/**
 * The thread's links, newest message first, each once. A link written twice
 * keeps its words wherever they were, and the url written out over one built
 * from a `#12`. A repository keeps its kinds together: pull requests, issues,
 * files, commits, the rest. Repositories and sites by their newest link.
 */
export function threadLinks(messages: readonly Pick<InboxMessageWire, 'id' | 'body'>[], repo: InboxProjectRepo | null | undefined): ThreadLinks {
  const refRepo: RefRepo = repo?.display ? { display: repo.display, ...(repo.host ? { host: repo.host } : {}) } : null;
  const seen = new Map<string, Entry>();
  for (let m = messages.length - 1; m >= 0; m--) {
    const message = messages[m]!;
    for (const written of linksOfMessage(message.id, message.body, refRepo)) {
      const entry = entryOfCached(written);
      if (!entry) continue;
      const had = seen.get(entry.key);
      if (!had) {
        seen.set(entry.key, { ...entry });
        continue;
      }
      had.title ??= entry.title;
      if (had.fromRef && !entry.fromRef) Object.assign(had, { href: entry.href, url: entry.url, row: entry.row, fromRef: false });
    }
  }
  const repos = new Map<string, RepoGroup>();
  const sites = new Map<string, ThreadLink[]>();
  for (const entry of seen.values()) {
    const { repository } = entry;
    if (repository) {
      const key = `${repository.host}/${repository.path}`.toLowerCase();
      let group = repos.get(key);
      if (!group) {
        group = { platform: repository.platform, host: repository.host, path: repository.path, href: `${entry.url.origin}/${repository.path}`, links: [] };
        repos.set(key, group);
      }
      if (entry.row) group.links.push(linkOf(entry));
      continue;
    }
    const site = siteOf(entry.url);
    const links = sites.get(site);
    if (links) links.push(linkOf(entry));
    else sites.set(site, [linkOf(entry)]);
  }
  for (const group of repos.values()) {
    group.links.sort((a, b) => KIND_ORDER.indexOf(a.kind!) - KIND_ORDER.indexOf(b.kind!));
  }
  const others = [...sites.values()].flat();
  let count = others.length;
  for (const group of repos.values()) count += group.links.length || 1;
  return { repos: [...repos.values()], others, count };
}
