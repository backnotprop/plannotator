/**
 * Where a link in a PR's description goes. A body is written for the forge, so a path in it (`docs/guide.md`) means a
 * file of the repository, never an address of this window: it opens on the forge at the PR's head. Only the web's
 * schemes stay links; a body is someone else's words, and `vscode:` or `ssh:` would launch an app from a click.
 */

import type { InboxPull } from '@plannotator/core/inbox-types';
import { GITHUB_SHORTCODES } from './githubShortcodes';

type Layer = Pick<InboxPull, 'url' | 'platform' | 'repo' | 'head' | 'head_repo' | 'head_sha'>;

/** The commit a file link names: the head commit, or the branch unless it lives in a fork (not found in this repo). */
function fileRef(layer: Layer, headSha: string | null | undefined): string | null {
  const sha = headSha ?? layer.head_sha;
  if (sha) return sha;
  return !layer.head_repo || layer.head_repo === layer.repo ? layer.head : null;
}

/** The forge's address for a path in this layer's description, or null when it has none (it climbs out of the repo). */
let shortcodes: Map<string, string> | null = null;

/**
 * `:robot:` as the forge draws it, 🤖, wherever its alias is GitHub's; any other `:word:` stays. ui's Markdown knows a
 * few dozen (`inlineTransforms`), the same pattern; a forge's words use the whole set, bots' most of all.
 */
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

/**
 * A forge's body as the Inbox's Markdown should read it: HTML comments gone (a PR template's, which the forge hides too),
 * a line holding nothing but `<br>` (dependabot's), which would draw as those words, and `:shortcodes:` as their emoji.
 * In code, each stays.
 */
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
      const next = /(`+).*?\1|<!--/.exec(rest);
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

/** Whether a click on this link stays in the browser: the web's schemes, as the link's own parsing reads them. */
export function isLiveLink(link: { protocol: string }): boolean {
  return LIVE_SCHEMES.has(link.protocol);
}
