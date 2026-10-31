import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve as resolvePath, posix as pathPosix, sep } from "node:path";
import {
  HTML_ASSET_DOCUMENT_CSP,
  htmlAssetContentType,
  refusesHiddenHtmlAssetPath,
  rewriteCssAssetReferences,
  rewriteHtmlAssetReferences,
} from "./html-assets";

export const MAX_HTML_ASSET_BYTES = 50 * 1024 * 1024;

/**
 * The CSP of an HTML document served from an asset root outside the session's
 * roots (#2291): no network, so a page opened from anywhere cannot send what
 * its scripts load (the Inbox's INBOX_HTML_DOCUMENT_CSP is the same rule).
 */
export const OUTSIDE_ROOT_HTML_DOCUMENT_CSP = `${HTML_ASSET_DOCUMENT_CSP}; connect-src 'none'`;

/**
 * Whether an asset file may be read: a regular file by its real path (a FIFO
 * or device would block the read) within `maxBytes`. "missing", "not-file" or
 * "too-large" otherwise.
 */
export function htmlAssetFileState(path: string, maxBytes: number): "ok" | "missing" | "not-file" | "too-large" {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return "missing";
  }
  if (!stat.isFile()) return "not-file";
  return stat.size > maxBytes ? "too-large" : "ok";
}

/**
 * Where an HTML document's relative assets are served from. Normally the
 * document's own folder. In an annotate folder session (`folderPath`) a
 * document inside the selected folder gets the whole folder as its root, so
 * `../assets/x.css` from `lessons/page.html` resolves, with `basePath` naming
 * the document's folder under that root. `docDir` (that folder, absolute)
 * marks the wider root; `folderSessionAssetAllowed` then decides each asset.
 * A document that itself sits in a hidden folder (`.drafts/page.html`) is not
 * widened: its own folder stays its root, as for a single file.
 */
export function htmlAssetContext(
  htmlFilePath: string,
  folderPath?: string,
): { root: string; basePath: string; docDir: string | null } {
  const directory = dirname(resolvePath(htmlFilePath));
  const ownFolder = { root: directory, basePath: "", docDir: null };
  if (!folderPath || !isWithinDirectory(htmlFilePath, folderPath)) return ownFolder;
  const root = realpathSync(folderPath);
  const documentDirectory = dirname(realpathSync(htmlFilePath));
  const basePath = relative(root, documentDirectory).split(sep).join("/");
  if (basePath.split("/").some((segment) => segment.startsWith("."))) return ownFolder;
  return { root, basePath, docDir: documentDirectory };
}

/** What an HTML page needs to render: images, media, styles, fonts, scripts and nested pages. */
const RENDER_ASSET_RE = /\.(?:apng|avif|bmp|css|gif|ico|jpe?g|js|mjs|mp3|mp4|ogg|otf|png|svg|ttf|wav|webm|webp|woff2?|html?)$/i;

/**
 * The rule for an asset root outside the session's roots: an HTML document a
 * tab on this machine opened from anywhere (#2291). Its folder may be a home
 * folder, so it serves only render types, never a hidden path, the dotenv
 * family or a data/config file (`.json`, `.xml`, `.webmanifest`).
 */
export function refusesOutsideRootHtmlAsset(relativePath: string): boolean {
  return refusesHiddenHtmlAssetPath(relativePath) || !RENDER_ASSET_RE.test(relativePath);
}

/**
 * Whether an asset response from a root outside the session's roots carries
 * `Access-Control-Allow-Origin: *`: fonts only, which the browser loads in CORS
 * mode. Everything else stays readable by the page (`<img>`, `<link>`,
 * `<script>`) but not by its scripts (`fetch`).
 */
export function outsideRootAssetAllowsCors(relativePath: string): boolean {
  return /\.(?:otf|ttf|woff2?)$/i.test(relativePath);
}

/**
 * A folder session's rule for one asset (the caller has already checked it
 * stays inside the selected folder `root`): allowed when it resolves inside
 * the requesting document's own directory, hidden segments included, exactly
 * as when that directory was the root (v0.28.18); otherwise only when no
 * segment of its path under the folder, as requested and by realpath, is
 * hidden or in the dotenv family. A symlink in the document's directory that
 * leads elsewhere in the folder is judged by the second rule.
 */
export function folderSessionAssetAllowed(root: string, docDir: string, assetPath: string): boolean {
  if (isWithinDirectory(resolvePath(root, assetPath), docDir)) return true;
  return !htmlAssetPathRefused(root, assetPath, refusesHiddenHtmlAssetPath);
}

/**
 * Whether `refuse` rejects an asset, judged on the path as requested AND on
 * where it really leads under the root, so an innocent name symlinked to a
 * hidden file is refused too. Shared by the Bun route, the Pi route and the
 * share-link inliner.
 */
export function htmlAssetPathRefused(
  root: string,
  assetPath: string,
  refuse: (relativePath: string) => boolean,
): boolean {
  if (refuse(assetPath)) return true;
  let real = resolvePath(root, assetPath);
  let realRoot = resolvePath(root);
  try {
    real = realpathSync(real);
    realRoot = realpathSync(realRoot);
  } catch {
    // Not on disk: the read answers 404 (the inliner skips it).
  }
  return refuse(relative(realRoot, real).split(sep).join("/"));
}

export function inlineHtmlLocalAssets(
  html: string,
  htmlFilePath: string,
  folderPath?: string,
  refuseAssetPath?: (relativePath: string) => boolean,
): string {
  if (/^https?:\/\//i.test(htmlFilePath)) return html;

  try {
    const { root, basePath, docDir } = htmlAssetContext(htmlFilePath, folderPath);
    const activeCss = new Set<string>();

    const dataUrlFor = (assetPath: string): string | null => {
      try {
        const contentType = htmlAssetContentType(assetPath);
        if (!contentType) return null;

        const resolved = resolvePath(root, assetPath);
        if (!isWithinDirectory(resolved, root)) return null;
        if (docDir && !folderSessionAssetAllowed(root, docDir, assetPath)) return null;
        if (refuseAssetPath && htmlAssetPathRefused(root, assetPath, refuseAssetPath)) return null;
        if (!existsSync(resolved)) return null;

        const stat = statSync(resolved);
        if (!stat.isFile() || stat.size > MAX_HTML_ASSET_BYTES) return null;

        let bytes = readFileSync(resolved);
        if (contentType.startsWith("text/css") && !activeCss.has(assetPath)) {
          activeCss.add(assetPath);
          try {
            const cssBase = pathPosix.dirname(assetPath);
            const rewrittenCss = rewriteCssAssetReferences(
              bytes.toString("utf-8"),
              dataUrlFor,
              cssBase === "." ? "" : cssBase,
            );
            bytes = Buffer.from(rewrittenCss, "utf-8");
          } finally {
            activeCss.delete(assetPath);
          }
        }

        return `data:${contentType.replace(/;\s*/g, ";")};base64,${Buffer.from(bytes).toString("base64")}`;
      } catch {
        return null;
      }
    };

    // Embedded local documents do not travel: a portable share carries one
    // file, and inlining a sibling page as a data: URL would lose that page's
    // own relative assets anyway. `inertBase` gives a document that HAS embeds
    // a base nothing resolves against, so an embed renders EMPTY on the share
    // portal instead of resolving onto the portal's own catch-all and rendering
    // the app inside the frame (which is exactly the bug this fixes locally).
    return rewriteHtmlAssetReferences(html, dataUrlFor, { inertBase: true, assetBasePath: basePath });
  } catch {
    return html;
  }
}

/**
 * Single source of truth for "is this file inside this root?" containment used
 * by every HTML asset / share-html sink (Bun route handler, share inliner, and
 * the Pi server via the vendored copy). Resolves symlinks on BOTH the root and
 * the target so an in-directory symlink pointing outside the root cannot escape.
 * Keep all sinks importing this — duplicating it is how the escape was missed in
 * one runtime before (#927/#929).
 */
export function isWithinDirectory(filePath: string, root: string): boolean {
  let resolvedRoot: string;
  try {
    resolvedRoot = realpathSync(resolvePath(root));
  } catch {
    return false;
  }
  // Resolve symlinks on the asset so an in-directory symlink pointing outside
  // the root (e.g. evil.css -> ~/.ssh/id_rsa) is rejected, not followed. A
  // nonexistent target keeps the lexical path; the later read simply fails.
  let resolved = resolvePath(filePath);
  try {
    resolved = realpathSync(resolved);
  } catch {
    // asset does not exist yet — fall through with the lexical path
  }
  const rel = relative(resolvedRoot, resolved);
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Resolve the absolute file an /api/open-in request may launch and confirm it
 * stays within an allowed root — the security boundary for the open-in
 * endpoints, shared by the Bun and Pi servers so the resolve + containment
 * can't drift between runtimes (same reason isWithinDirectory is single-sourced).
 *
 * `resolveRoot` may return one root or several: annotate scopes opens to the
 * same set of reference roots `/api/doc` serves from, so any linked doc the
 * user can view can also be opened. Root precedence: server-supplied root(s)
 * override the client `base`; then `base`; then an absolute `filePath`'s own
 * directory; then cwd. Each root resolves `filePath` independently, so a
 * relative path is resolved correctly per-root (not only against the first).
 * Returns the absolute path, or null when it escapes every allowed root.
 */
export function resolveOpenInTarget(
  filePath: string,
  base: string | null,
  resolveRoot?: () => string | string[],
): string | null {
  const provided = resolveRoot?.();
  const roots = (
    provided == null
      ? [
          base
            ? resolvePath(base)
            : isAbsolute(filePath)
              ? dirname(resolvePath(filePath))
              : resolvePath(process.cwd()),
        ]
      : Array.isArray(provided)
        ? provided
        : [provided]
  )
    .filter((r): r is string => !!r)
    .map((r) => resolvePath(r));
  // Resolve against each root and return the first that contains its own
  // resolution. For an absolute filePath the resolution is identical for every
  // root (a pure containment check); for a relative filePath this avoids the
  // duplicate-basename trap of resolving only against roots[0].
  for (const root of roots) {
    const abs = resolvePath(root, filePath);
    if (isWithinDirectory(abs, root)) return abs;
  }
  return null;
}
