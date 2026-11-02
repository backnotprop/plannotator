/**
 * The name of the open document, in the three places it is shown (#2061):
 * the browser tab's title, the desktop header beside the logo, and the
 * compact (phone) header. One resolver, so the three never disagree about
 * which document is open; each place then words it its own way.
 *
 * Pure: everything it reads comes in through `DocumentTitleInput`.
 */
import { annotateBundleBaseName } from '@plannotator/shared/annotate-bundle';

export interface DocumentTitleRepo {
  display: string;
  branch?: string;
  host?: string;
}

export interface DocumentTitleInput {
  /** The server answered /api/plan (false: a share link or the demo). */
  apiMode: boolean;
  annotateMode: boolean;
  archiveMode: boolean;
  goalSetupMode: boolean;
  /** 'file' (one file or URL, and live apps), 'message' (annotate-last), 'folder' (folder and several files). */
  annotateSource: 'file' | 'message' | 'folder' | null;
  /** A linked document that is open in place of the session's own. */
  linkedPath?: string | null;
  /** A one-file session's own file, or its URL. */
  sourceFilePath?: string | null;
  /** The file chosen in a folder session's file list. */
  activeFile?: string | null;
  /** A folder session's folder (absent for several files). */
  folderPath?: string | null;
  /** A review of several files: the open file's place (0-based, -1 none) and the count. */
  bundle?: { index: number; total: number } | null;
  /** A live app session's app address (`http://localhost:5173/…`). */
  liveAppUrl?: string | null;
  /** The plan's first heading, as written. */
  planHeading?: string | null;
  /** Archive browsing: the archived plan's title. */
  archiveTitle?: string | null;
  repo?: DocumentTitleRepo | null;
}

/** What the desktop header shows beside the logo; `title` rides its tooltip. */
export interface DocumentHeaderName {
  name: string;
  title?: string;
  /** `name` is a path: cut from the start when the header runs short, so its last name stays whole. */
  cutsFromStart?: boolean;
}

const URL_PATTERN = /^https?:\/\//i;
const HEADING_MAX = 80;

/** HTML elements a heading may carry inline. Only these are stripped, so
 *  `Result<T>` or `Vec<String>` keep their angle brackets. */
const HTML_TAG = /<\/?(?:a|abbr|b|bdi|bdo|br|cite|code|del|dfn|em|i|img|ins|kbd|mark|q|s|samp|small|span|strong|sub|sup|time|u|var|wbr)(?:\s[^<>]*)?\/?>|<!--[\s\S]*?-->/gi;

/** The text's user-perceived characters (grapheme clusters where the engine knows them). */
function graphemes(text: string): string[] {
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    return Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), (part) => part.segment);
  }
  return Array.from(text);
}

function openPath(input: DocumentTitleInput): string | null {
  return input.linkedPath || input.sourceFilePath || input.activeFile || null;
}

/** `docs.stripe.com/refunds`: host and path, no scheme, query or trailing slash. */
export function urlDisplayName(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/, '');
    return `${parsed.host}${path}`;
  } catch {
    return url.replace(URL_PATTERN, '').replace(/^[^/?#]*@/, '').replace(/[?#].*$/, '').replace(/\/+$/, '');
  }
}

/**
 * A URL as the header's tooltip may show it: host and path, a query reduced to
 * `?…`, no fragment and no credentials, so a token in the address is never on
 * screen (the rule Ask AI's element context follows).
 */
export function scrubbedUrl(url: string): string {
  let hasQuery: boolean;
  try {
    hasQuery = new URL(url).search.length > 1;
  } catch {
    hasQuery = /\?[^#]/.test(url);
  }
  return `${urlDisplayName(url)}${hasQuery ? '?…' : ''}`;
}

function urlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return urlDisplayName(url).split('/')[0];
  }
}

/** A path's file name, or a URL's host and path. */
function pathDisplayName(path: string): string {
  return URL_PATTERN.test(path) ? urlDisplayName(path) : annotateBundleBaseName(path) || path;
}

/** The open bundle file: `spec.md (1 of 2)`. */
function bundleName(path: string, bundle: { index: number; total: number }): string {
  return `${annotateBundleBaseName(path)} (${bundle.index + 1} of ${bundle.total})`;
}

/**
 * A plan heading as plain text: inline markdown marks removed, a leading
 * "Plan:" dropped (the title already says "(plan)"), cut at 80 characters.
 */
export function planHeadingText(heading: string): string {
  let text = heading
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(HTML_TAG, '')
    .replace(/`+/g, '')
    .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])\*(?!\s)(.+?)\*(?!\w)/g, '$1$2')
    .replace(/(^|\W)_(?!\s)(.+?)_(?!\w)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
  const withoutPrefix = text.replace(/^(implementation\s+)?plan\s*:\s*/i, '');
  if (withoutPrefix) text = withoutPrefix;
  const chars = graphemes(text);
  return chars.length > HEADING_MAX ? `${chars.slice(0, HEADING_MAX - 1).join('').trimEnd()}…` : text;
}

/** What the name sits beside in the tab: the repository, or "Plannotator" outside one. */
function repoSuffix(repo: DocumentTitleRepo | null | undefined): string {
  // A directory name with no branch and no remote is the server's last
  // fallback: not a git repository.
  return repo && (repo.branch || repo.host) ? repo.display : 'Plannotator';
}

/** Today's title, kept for code paths the change leaves alone. */
function defaultTabTitle(repo: DocumentTitleRepo | null | undefined): string {
  return repo ? `${repo.display} · Plannotator` : 'Plannotator';
}

/** The name the document is known by, with the place it came from. */
function documentName(input: DocumentTitleInput): { name: string; title?: string; web: boolean } | null {
  if (input.liveAppUrl) {
    return { name: urlHost(input.liveAppUrl), title: scrubbedUrl(input.liveAppUrl), web: true };
  }
  const path = openPath(input);
  if (path) {
    if (input.bundle && input.bundle.index >= 0) {
      return { name: bundleName(path, input.bundle), title: path, web: false };
    }
    const web = URL_PATTERN.test(path);
    return { name: pathDisplayName(path), title: web ? scrubbedUrl(path) : path, web };
  }
  if (input.annotateSource === 'message') return { name: 'Last message', web: false };
  if (input.annotateSource === 'folder' && input.folderPath) {
    return { name: `${annotateBundleBaseName(input.folderPath)}/`, title: input.folderPath, web: false };
  }
  return null;
}

/**
 * The browser tab's title, name first: `rollout-plan.md · acme/payments`,
 * `docs.stripe.com/refunds · Plannotator`, `Add partial refunds (plan) · …`.
 * Archive, goal setup, share links and an unnamed plan keep today's title.
 */
export function documentTabTitle(input: DocumentTitleInput): string {
  if (!input.apiMode || input.archiveMode || input.goalSetupMode) return defaultTabTitle(input.repo);
  const named = documentName(input);
  if (named) return `${named.name} · ${named.web ? 'Plannotator' : repoSuffix(input.repo)}`;
  if (!input.annotateMode && input.planHeading) {
    const heading = planHeadingText(input.planHeading);
    if (heading) return `${heading} (plan) · ${repoSuffix(input.repo)}`;
  }
  return defaultTabTitle(input.repo);
}

/**
 * The name beside the logo in the desktop header, or null when it shows
 * none: plan review, archive, goal setup, share links, and a review of
 * several files (its switcher already names the open file).
 *
 * A folder session's header names its folder, as a path, whichever file is
 * open, a document linked from one included: the folder is what the session
 * is about, and the open file is named by the file list's selected row and the
 * chip at the top of the document. The tab title still names the open file,
 * so several tabs stay apart (#2061).
 */
export function documentHeaderName(input: DocumentTitleInput): DocumentHeaderName | null {
  if (!input.apiMode || !input.annotateMode || input.archiveMode || input.goalSetupMode) return null;
  if (input.bundle) return null;
  if (input.annotateSource === 'folder' && input.folderPath) {
    return { name: input.folderPath, title: input.folderPath, cutsFromStart: true };
  }
  const named = documentName(input);
  if (!named) return null;
  return named.title ? { name: named.name, title: named.title } : { name: named.name };
}

/** The compact (phone) header's title. Unchanged by #2061. */
export function compactDocumentTitle(input: DocumentTitleInput): string {
  const path = openPath(input);
  if (path && input.bundle && input.bundle.index >= 0) return bundleName(path, input.bundle);
  if (path) return path.replace(/\\/g, '/').split('/').pop() || path;
  if (input.archiveTitle) return input.archiveTitle;
  if (input.annotateSource === 'message') return 'Message';
  if (input.annotateSource === 'folder') return 'Choose a file';
  return 'Plan';
}
