// The screens and OG image of the Guided Reviews for VS Code page live in
// apps/marketing/guides-vscode-assets/, outside public/, so the deployed site
// ships none of them until launch (src/lib/guides-vscode-launch.ts). With the
// switch on, a build copies them to dist/assets/guides-vscode/ and `astro dev`
// serves them from that folder under the same URL. With the switch off, neither
// happens.
import { createReadStream } from 'node:fs';
import { cp, realpath, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const GUIDES_VSCODE_ASSETS_URL = '/assets/guides-vscode/';

const CONTENT_TYPES: Record<string, string> = {
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
};

const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
};

/**
 * The file a dev request names under /assets/guides-vscode/, or null. Only a
 * regular file of a known type that stays inside `assetsDir` (by its resolved
 * path and by its real path) is answered.
 */
export async function resolveGuidesVscodeAsset(
  assetsDir: string,
  url: string | undefined,
): Promise<{ path: string; type: string; size: number } | null> {
  if (!url) return null;
  const pathname = url.split(/[?#]/, 1)[0];
  if (!pathname.startsWith(GUIDES_VSCODE_ASSETS_URL)) return null;
  let name: string;
  try {
    name = decodeURIComponent(pathname.slice(GUIDES_VSCODE_ASSETS_URL.length));
  } catch {
    return null;
  }
  if (!name || name.includes('\0') || name.includes('\\')) return null;
  const type = CONTENT_TYPES[extname(name).toLowerCase()];
  if (!type) return null;
  const root = resolve(assetsDir);
  const path = resolve(root, name);
  if (!inside(root, path)) return null;
  try {
    const [realRoot, realFile] = await Promise.all([realpath(root), realpath(path)]);
    if (!inside(realRoot, realFile)) return null;
    const info = await stat(realFile);
    if (!info.isFile()) return null;
    return { path: realFile, type, size: info.size };
  } catch {
    return null;
  }
}

type Next = (err?: unknown) => void;

/** Connect middleware for `astro dev`: serves the assets folder, passes anything else on. */
export function guidesVscodeDevMiddleware(assetsDir: string) {
  return (req: IncomingMessage, res: ServerResponse, next: Next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    resolveGuidesVscodeAsset(assetsDir, req.url).then(
      (file) => {
        if (!file) return next();
        res.statusCode = 200;
        res.setHeader('Content-Type', file.type);
        res.setHeader('Content-Length', String(file.size));
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        if (req.method === 'HEAD') return res.end();
        createReadStream(file.path).on('error', next).pipe(res);
      },
      (err) => next(err),
    );
  };
}

/** The Astro integration: copies the assets on build, serves them in dev, only while `launched`. */
export function guidesVscodeAssetsIntegration(launched: boolean, assetsDir: string | URL) {
  const dir = typeof assetsDir === 'string' ? assetsDir : fileURLToPath(assetsDir);
  return {
    name: 'guides-vscode-assets',
    hooks: {
      'astro:server:setup': ({ server }: { server: { middlewares: { use: (fn: ReturnType<typeof guidesVscodeDevMiddleware>) => void } } }) => {
        if (!launched) return;
        server.middlewares.use(guidesVscodeDevMiddleware(dir));
      },
      'astro:build:done': async ({ dir: outDir }: { dir: URL }) => {
        if (!launched) return;
        await cp(join(dir, '/'), fileURLToPath(new URL('assets/guides-vscode/', outDir)), { recursive: true });
      },
    },
  };
}
