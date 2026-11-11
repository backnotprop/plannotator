/** A path in a PR body means a file of the repository: it opens on the forge at the PR's head. Only the web's schemes stay links, since `vscode:` or `ssh:` would launch an app from a click. */

import type { InboxPull } from '@plannotator/core/inbox-types';
import { GITHUB_SHORTCODES } from './githubShortcodes';

type Layer = Pick<InboxPull, 'url' | 'platform' | 'repo' | 'head' | 'head_repo' | 'head_sha'>;

function fileRef(layer: Layer, headSha: string | null | undefined): string | null {
  const sha = headSha ?? layer.head_sha;
  if (sha) return sha;
  return !layer.head_repo || layer.head_repo === layer.repo ? layer.head : null;
}

let shortcodes: Map<string, string> | null = null;

export function withEmoji(text: string): string {
  if (!text.includes(':')) return text;
  if (!shortcodes) {
    const parts = GITHUB_SHORTCODES.split(' ');
    shortcodes = new Map();
    for (let i = 0; i + 1 < parts.length; i += 2) shortcodes.set(parts[i]!, parts[i + 1]!);
  }
  const known = shortcodes;
  return text.replace(/:([a-z0-9_+-]+):/g, (whole, code: string) => known.get(code) ?? whole);
}

export function forgeBody(markdown: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  let inComment = false;
  for (const line of markdown.split('\n')) {
    if (!inComment) {
      const mark = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (mark && (!fence || mark[0] === fence)) {
        fence = fence ? null : mark[0]!;
        out.push(line);
        continue;
      }
      if (fence) {
        out.push(line);
        continue;
      }
    }
    let kept = '';
    let rest = line;
    let cut = inComment;
    while (rest) {
      if (inComment) {
        const end = rest.indexOf('-->');
        if (end < 0) break;
        rest = rest.slice(end + 3);
        inComment = false;
        continue;
      }
      // Code, a comment's start, and an address (a link's `](…)`, an autolink, a bare URL), which an emoji would break.
      const next = /(`+).*?\1|<!--|\]\((?:<[^>\n]*>|[^)\s]*)|<[a-z][a-z0-9+.-]*:[^\s<>]*>|\bhttps?:\/\/[^\s<>]+/i.exec(rest);
      if (!next) {
        kept += withEmoji(rest);
        break;
      }
      kept += withEmoji(rest.slice(0, next.index));
      rest = rest.slice(next.index + next[0].length);
      if (next[0] === '<!--') {
        inComment = true;
        cut = true;
      } else {
        kept += next[0];
      }
    }
    if (cut && !kept.trim()) continue;
    if (/^\s*<br\s*\/?>\s*$/i.test(kept)) continue;
    out.push(kept);
  }
  return out.join('\n');
}

export function forgeFileUrl(layer: Layer, headSha: string | null | undefined, href: string): string | null {
  const ref = fileRef(layer, headSha);
  const root = layer.url.replace(/(?:\/-)?\/(?:pull|merge_requests)\/\d+.*$/, '');
  if (!ref || root === layer.url) return null;
  const blob = `${root}${layer.platform === 'gitlab' ? '/-' : ''}/blob/${ref.split('/').map(encodeURIComponent).join('/')}/`;
  try {
    const url = new URL(href.trim().replace(/^[\\/]+/, ''), blob).href;
    return url.startsWith(blob) && url.length > blob.length ? url : null;
  } catch {
    return null;
  }
}

const LIVE_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

export function isLiveLink(link: { protocol: string }): boolean {
  return LIVE_SCHEMES.has(link.protocol);
}
