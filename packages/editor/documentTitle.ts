import { annotateBundleBaseName } from '@plannotator/shared/annotate-bundle';

export interface DocumentTitleRepo {
  display: string;
  branch?: string;
  host?: string;
}

export interface DocumentTitleInput {
  apiMode: boolean;
  annotateMode: boolean;
  archiveMode: boolean;
  goalSetupMode: boolean;
  annotateSource: 'file' | 'message' | 'folder' | null;
  linkedPath?: string | null;
  sourceFilePath?: string | null;
  activeFile?: string | null;
  folderPath?: string | null;
  // `index` is 0-based; -1 means the open file is not in the bundle.
  bundle?: { index: number; total: number } | null;
  liveAppUrl?: string | null;
  planHeading?: string | null;
  archiveTitle?: string | null;
  repo?: DocumentTitleRepo | null;
  sessionTitle?: string | null;
}

export interface DocumentHeaderName {
  name: string;
  title?: string;
  cutsFromStart?: boolean;
}

const URL_PATTERN = /^https?:\/\//i;
const HEADING_MAX = 80;

// Only these inline tags are stripped, so `Result<T>` or `Vec<String>` keep their angle brackets.
const HTML_TAG = /<\/?(?:a|abbr|b|bdi|bdo|br|cite|code|del|dfn|em|i|img|ins|kbd|mark|q|s|samp|small|span|strong|sub|sup|time|u|var|wbr)(?:\s[^<>]*)?\/?>|<!--[\s\S]*?-->/gi;

function graphemes(text: string): string[] {
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    return Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), (part) => part.segment);
  }
  return Array.from(text);
}

function openPath(input: DocumentTitleInput): string | null {
  return input.linkedPath || input.sourceFilePath || input.activeFile || null;
}

export function urlDisplayName(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/, '');
    return `${parsed.host}${path}`;
  } catch {
    return url.replace(URL_PATTERN, '').replace(/^[^/?#]*@/, '').replace(/[?#].*$/, '').replace(/\/+$/, '');
  }
}

// Host and path only; a query shows as `?…`, with no credentials or fragment, so a token never reaches the screen.
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

function pathDisplayName(path: string): string {
  return URL_PATTERN.test(path) ? urlDisplayName(path) : annotateBundleBaseName(path) || path;
}

function bundleName(path: string, bundle: { index: number; total: number }): string {
  return `${annotateBundleBaseName(path)} (${bundle.index + 1} of ${bundle.total})`;
}

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

function repoSuffix(repo: DocumentTitleRepo | null | undefined): string {
  return repo && (repo.branch || repo.host) ? repo.display : 'Plannotator';
}

function defaultTabTitle(repo: DocumentTitleRepo | null | undefined): string {
  return repo ? `${repo.display} · Plannotator` : 'Plannotator';
}

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

export function documentTabTitle(input: DocumentTitleInput): string {
  if (!input.apiMode || input.archiveMode || input.goalSetupMode) return defaultTabTitle(input.repo);
  if (input.sessionTitle) return input.sessionTitle;
  const named = documentName(input);
  if (named) return `${named.name} · ${named.web ? 'Plannotator' : repoSuffix(input.repo)}`;
  if (!input.annotateMode && input.planHeading) {
    const heading = planHeadingText(input.planHeading);
    if (heading) return `${heading} (plan) · ${repoSuffix(input.repo)}`;
  }
  return defaultTabTitle(input.repo);
}

export function documentHeaderName(input: DocumentTitleInput): DocumentHeaderName | null {
  if (!input.apiMode || !input.annotateMode || input.archiveMode || input.goalSetupMode) return null;
  if (input.bundle) return null;
  if (input.sessionTitle) {
    const tooltip = input.annotateSource === 'folder' && input.folderPath ? input.folderPath : documentName(input)?.title;
    return tooltip ? { name: input.sessionTitle, title: tooltip } : { name: input.sessionTitle };
  }
  if (input.annotateSource === 'folder' && input.folderPath) {
    return { name: input.folderPath, title: input.folderPath, cutsFromStart: true };
  }
  const named = documentName(input);
  if (!named) return null;
  return named.title ? { name: named.name, title: named.title } : { name: named.name };
}

export function compactDocumentTitle(input: DocumentTitleInput): string {
  const path = openPath(input);
  if (path && input.bundle && input.bundle.index >= 0) return bundleName(path, input.bundle);
  if (path) return path.replace(/\\/g, '/').split('/').pop() || path;
  if (input.archiveTitle) return input.archiveTitle;
  if (input.annotateSource === 'message') return 'Message';
  if (input.annotateSource === 'folder') return 'Choose a file';
  return 'Plan';
}
