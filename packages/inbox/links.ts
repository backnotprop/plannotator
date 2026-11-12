import { useMemo } from 'react';
import type { InboxAttachment, InboxProjectRepo } from '@plannotator/core/inbox-types';
import { parseSettingsHash } from './settingsRoute';

export type LinkableAttachment = Pick<InboxAttachment, 'id' | 'path' | 'named_path' | 'name' | 'kind'>;

const WINDOWS_DRIVE = /^[a-z]:[\\/]/i;

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || path.startsWith('\\') || WINDOWS_DRIVE.test(path);
}

export function normalizeLinkPath(path: string): string {
  const slashed = path.replace(/\\/g, '/');
  const drive = /^[a-z]:/i.test(slashed) ? slashed.slice(0, 2).toLowerCase() : '';
  const rest = drive ? slashed.slice(2) : slashed;
  const absolute = rest.startsWith('/');
  const out: string[] = [];
  for (const segment of rest.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (!absolute) out.push('..');
      continue;
    }
    out.push(segment);
  }
  return `${drive}${absolute ? '/' : ''}${out.join('/')}`;
}

function linkCandidates(href: string): string[] {
  const stripped = href.trim().replace(/[?#].*$/s, '');
  if (!stripped) return [];
  const out = [stripped];
  if (stripped.includes('%')) {
    try {
      const decoded = decodeURIComponent(stripped);
      if (decoded !== stripped) out.push(decoded);
    } catch {
    }
  }
  return out;
}

export function attachmentForLink<T extends LinkableAttachment>(
  href: string,
  options: { attachments: readonly T[]; root: string; base?: string | null },
): T | null {
  const { attachments } = options;
  if (attachments.length === 0) return null;
  const known = new Map<string, T>();
  for (const attachment of attachments) {
    known.set(normalizeLinkPath(attachment.path), attachment);
    if (attachment.named_path) known.set(normalizeLinkPath(attachment.named_path), attachment);
  }
  const dirs = [...new Set([options.base, options.root].filter((dir): dir is string => typeof dir === 'string' && dir !== ''))];
  const candidates = linkCandidates(href);
  for (const candidate of candidates) {
    const absolute = isAbsolutePath(candidate)
      ? [normalizeLinkPath(candidate)]
      : dirs.map((dir) => normalizeLinkPath(`${dir}/${candidate}`));
    for (const path of absolute) {
      const hit = known.get(path);
      if (hit) return hit;
    }
  }
  for (const candidate of candidates) {
    if (/[\\/]/.test(candidate)) continue;
    const named = attachments.filter((attachment) => attachment.name === candidate);
    if (named.length === 1) return named[0]!;
  }
  return null;
}

export function projectFileOfLink(href: string): { path: string; line?: number; lineEnd?: number } | null {
  const candidate = linkCandidates(href).at(-1);
  if (!candidate) return null;
  const fragment = /^#L(\d+)(?:-L?(\d+))?/.exec(href.trim().replace(/^[^#]*/, ''));
  const written = /:(\d+)(?:-(\d+)|:\d+)?$/.exec(candidate);
  const line = fragment?.[1] ?? written?.[1];
  const lineEnd = fragment ? fragment[2] : written?.[2];
  const path = candidate.replace(/:\d+(?:-\d+|:\d+)?$/, '').replace(/\\/g, '/');
  if (!path || path.endsWith('/')) return null;
  return { path, ...(line ? { line: Number(line) } : {}), ...(line && lineEnd ? { lineEnd: Number(lineEnd) } : {}) };
}

export function attachmentDisplayPath(attachment: Pick<LinkableAttachment, 'path' | 'named_path'>, root: string): string {
  const path = normalizeLinkPath(attachment.named_path || attachment.path);
  const base = normalizeLinkPath(root);
  if (base && path.startsWith(`${base.replace(/\/$/, '')}/`)) return path.slice(base.replace(/\/$/, '').length + 1);
  return path;
}

export function openAttachmentTitle(displayPath: string): string {
  return `Open ${displayPath} beside the thread`;
}

export function attachmentDeepLink(threadId: string, attachmentId: string, version: 'current' | 'sent' = 'current'): string {
  const params = new URLSearchParams();
  params.set('thread', threadId);
  params.set('file', attachmentId);
  if (version === 'sent') params.set('v', 'sent');
  return `#${params.toString()}`;
}

export const NOT_ATTACHED_TITLE = 'Not attached to this message';

export interface InboxHere {
  origin: string;
  addresses: readonly (string | null | undefined)[];
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const OTHER_PAGES = ['whats-new', 'tour', 'drafts', 'board'];

function urlOf(href: string, base?: string): URL | null {
  try {
    return new URL(href, base);
  } catch {
    return null;
  }
}

function sameInbox(a: URL, b: URL): boolean {
  if (a.origin === b.origin) return true;
  return a.protocol === b.protocol && a.port === b.port && LOOPBACK_HOSTS.has(a.hostname) && LOOPBACK_HOSTS.has(b.hostname);
}

function namesRoute(hash: string, bare: boolean): boolean {
  if (parseSettingsHash(hash)) return !bare;
  const params = new URLSearchParams(hash);
  if (OTHER_PAGES.some((page) => params.has(page))) return false;
  return !!params.get('thread') || !!params.get('project');
}

export function inboxLinkHash(href: string, here: InboxHere): string | null {
  const target = href.trim();
  const bare = target.startsWith('#');
  const link = urlOf(target, here.origin);
  if (!link || !namesRoute(link.hash.slice(1), bare)) return null;
  if (bare) return link.hash;
  if (link.pathname !== '/') return null;
  const addresses = [here.origin, ...here.addresses].flatMap((address) => {
    const url = address ? urlOf(address) : null;
    return url ? [url] : [];
  });
  return addresses.some((address) => sameInbox(link, address)) ? link.hash : null;
}

export function useRefRepo(repo: InboxProjectRepo | null | undefined): { display: string; host?: string } | null {
  const display = repo?.display ?? null;
  const host = repo?.host ?? undefined;
  return useMemo(() => (display ? { display, ...(host ? { host } : {}) } : null), [display, host]);
}
