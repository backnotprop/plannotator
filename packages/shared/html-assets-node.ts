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

/** No network, so a page opened from anywhere cannot send what its scripts load. */
export const OUTSIDE_ROOT_HTML_DOCUMENT_CSP = `${HTML_ASSET_DOCUMENT_CSP}; connect-src 'none'`;

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

/** In an annotate folder session a document gets the whole selected folder as its root (so `../assets/x.css` resolves), except a document inside a hidden folder, which keeps its own folder. */
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

const RENDER_ASSET_RE = /\.(?:apng|avif|bmp|css|gif|ico|jpe?g|js|mjs|mp3|mp4|ogg|otf|png|svg|ttf|wav|webm|webp|woff2?|html?)$/i;

/** Serves only render types, never a hidden path, the dotenv family or a data/config file: the folder may be a home folder. */
export function refusesOutsideRootHtmlAsset(relativePath: string): boolean {
  return refusesHiddenHtmlAssetPath(relativePath) || !RENDER_ASSET_RE.test(relativePath);
}

/** Fonts only get `Access-Control-Allow-Origin: *` (browsers load them in CORS mode); everything else stays unreadable by page scripts. */
export function outsideRootAssetAllowsCors(relativePath: string): boolean {
  return /\.(?:otf|ttf|woff2?)$/i.test(relativePath);
}

export function folderSessionAssetAllowed(root: string, docDir: string, assetPath: string): boolean {
  if (isWithinDirectory(resolvePath(root, assetPath), docDir)) return true;
  return !htmlAssetPathRefused(root, assetPath, refusesHiddenHtmlAssetPath);
}

/** Judged on the path as requested AND by realpath, so an innocent name symlinked to a hidden file is refused. */
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

    // Embedded local documents do not travel in a share: `inertBase` gives a document with embeds a base nothing resolves against, so an embed renders empty instead of the portal's own app.
    return rewriteHtmlAssetReferences(html, dataUrlFor, { inertBase: true, assetBasePath: basePath });
  } catch {
    return html;
  }
}

/** Single containment check for every HTML asset sink. Resolves symlinks on both root and target so an in-directory symlink cannot escape; keep all sinks importing this. */
export function isWithinDirectory(filePath: string, root: string): boolean {
  let resolvedRoot: string;
  try {
    resolvedRoot = realpathSync(resolvePath(root));
  } catch {
    return false;
  }
  // Resolve symlinks so an in-directory link pointing outside the root is rejected, not followed. A nonexistent target keeps the lexical path.
  let resolved = resolvePath(filePath);
  try {
    resolved = realpathSync(resolved);
  } catch {
    // asset does not exist yet — fall through with the lexical path
  }
  const rel = relative(resolvedRoot, resolved);
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

/** Resolves the file an /api/open-in request may launch and confirms it stays within an allowed root: the security boundary for open-in. Returns null when it escapes every root. */
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
  // Each root resolves filePath independently, so a relative path is not tested only against roots[0].
  for (const root of roots) {
    const abs = resolvePath(root, filePath);
    if (isWithinDirectory(abs, root)) return abs;
  }
  return null;
}
