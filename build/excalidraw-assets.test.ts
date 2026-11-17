/**
 * The thread canvas loads nothing from another site (excalidraw-assets.ts). Excalidraw falls back to esm.sh for its
 * fonts; the Inbox build points that at the Inbox itself. What regresses: an Excalidraw upgrade that moves or renames
 * the fallback (the build must fail, not quietly reach esm.sh from a person's window), or a new CDN URL in the
 * package the canvas would fetch from.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { EXCALIDRAW_ASSET_BASE, localExcalidrawFallback } from './excalidraw-assets';

const SAMPLE = 'P(jn,"ASSETS_FALLBACK_URL",`https://esm.sh/${M.PKG_NAME?`${M.PKG_NAME}@${M.PKG_VERSION}`:"@excalidraw/excalidraw"}/dist/prod/`);';

describe('localExcalidrawFallback', () => {
  test('the esm.sh fallback becomes this Inbox\'s own address', () => {
    const out = localExcalidrawFallback(SAMPLE)!;
    expect(out).not.toContain('esm.sh');
    expect(out).toContain(`"ASSETS_FALLBACK_URL", window.location.origin + ${JSON.stringify(EXCALIDRAW_ASSET_BASE)}`);
  });

  test('a file without the fallback is left alone; a changed fallback fails the build', () => {
    expect(localExcalidrawFallback('export const x = 1;')).toBeNull();
    expect(() => localExcalidrawFallback('P(jn,"ASSETS_FALLBACK_URL",`https://unpkg.com/@excalidraw/excalidraw/dist/prod/`);')).toThrow();
    expect(() => localExcalidrawFallback('P(jn,"ASSETS_FALLBACK_URL",someOtherBase);')).toThrow();
  });
});

describe('the installed Excalidraw, as the Inbox bundles it', () => {
  const require = createRequire(join(import.meta.dir, '../packages/inbox/package.json'));
  const prod = dirname(require.resolve('@excalidraw/excalidraw'));
  const scripts: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.js')) scripts.push(p);
    }
  };
  walk(prod);
  const built = scripts.map((p) => {
    const code = readFileSync(p, 'utf8');
    return localExcalidrawFallback(code) ?? code;
  });

  test('exactly one script has the font fallback, and it is pointed at the Inbox', () => {
    expect(built.filter((c) => c.includes('ASSETS_FALLBACK_URL')).length).toBe(1);
    expect(built.some((c) => c.includes(`window.location.origin + ${JSON.stringify(EXCALIDRAW_ASSET_BASE)}`))).toBe(true);
  });

  test('no CDN address is left for the canvas to load code or fonts from', () => {
    for (const code of built) expect(code).not.toMatch(/esm\.sh|unpkg\.com|jsdelivr\.net|cdnjs\.|skypack\.dev/);
  });

  test('every other site the package names belongs to a part the canvas leaves out (or is a link or an embed allowlist)', () => {
    const hosts = new Set<string>();
    for (const code of built) for (const m of code.matchAll(/https?:\/\/([a-zA-Z0-9.-]+)/g)) hosts.add(m[1]);
    // Reviewed for 0.18.1. Share link and AI backends, collaboration, the shape library: the canvas leaves those
    // features out. The rest are help and social links (opened only by a click) and the embed allowlist (links are
    // nulled on every element the canvas stores). A new host here means: check it is never fetched, then add it.
    const known = [
      'app.excalidraw.com', 'discord.gg', 'docs.excalidraw.com', 'embed.reddit.com', 'excalidraw-room-persistence.firebaseio.com', 'giphy.com',
      'gist.github.com', 'github.com', 'json.excalidraw.com', 'libraries.excalidraw.com', 'mermaid.js.org', 'oss-ai.excalidraw.com',
      'oss-collab.excalidraw.com', 'platform.twitter.com', 'player.vimeo.com', 'plus.excalidraw.com', 'reddit.com', 'twitter.com',
      'us-central1-excalidraw-room-persistence.cloudfunctions.net', 'www.figma.com', 'www.w3.org', 'www.youtube.com', 'x.com', 'youtube.com',
    ];
    expect([...hosts].filter((h) => !known.includes(h)).sort()).toEqual([]);
  });
});
