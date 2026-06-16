import { existsSync, readFileSync, statSync } from "fs";
import { dirname, isAbsolute, relative, resolve as resolvePath, posix as pathPosix } from "path";
import {
  HTML_ASSET_ROUTE_PREFIX,
  encodeHtmlAssetPath,
  htmlAssetContentType,
  normalizeHtmlAssetRoutePath,
  rewriteCssAssetReferences,
  rewriteHtmlAssetReferences,
} from "@plannotator/shared/html-assets";

const MAX_HTML_ASSET_BYTES = 50 * 1024 * 1024;

export function inlineHtmlLocalAssets(html: string, htmlFilePath: string): string {
  if (/^https?:\/\//i.test(htmlFilePath)) return html;

  try {
    const root = dirname(resolvePath(htmlFilePath));
    const activeCss = new Set<string>();

    const dataUrlFor = (assetPath: string): string | null => {
      try {
        const contentType = htmlAssetContentType(assetPath);
        if (!contentType) return null;

        const resolved = resolvePath(root, assetPath);
        if (!isWithinDirectory(resolved, root)) return null;
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

    return rewriteHtmlAssetReferences(html, dataUrlFor);
  } catch {
    return html;
  }
}

export function createHtmlAssetRegistry() {
  const rootsByToken = new Map<string, string>();
  const tokensByRoot = new Map<string, string>();

  function register(baseDir: string): string {
    const root = resolvePath(baseDir);
    const existing = tokensByRoot.get(root);
    if (existing) return existing;
    const token = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    tokensByRoot.set(root, token);
    rootsByToken.set(token, root);
    return token;
  }

  function rewriteHtml(html: string, htmlFilePath: string): string {
    if (/^https?:\/\//i.test(htmlFilePath)) return html;
    try {
      const token = register(dirname(resolvePath(htmlFilePath)));
      return rewriteHtmlAssetReferences(
        html,
        (assetPath) => `${HTML_ASSET_ROUTE_PREFIX}/${token}/${encodeHtmlAssetPath(assetPath)}`,
      );
    } catch {
      return html;
    }
  }

  function inlineHtml(html: string, htmlFilePath: string): string {
    return inlineHtmlLocalAssets(html, htmlFilePath);
  }

  async function handle(_req: Request, url: URL): Promise<Response | null> {
    const prefix = `${HTML_ASSET_ROUTE_PREFIX}/`;
    if (!url.pathname.startsWith(prefix)) return null;

    const rest = url.pathname.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash <= 0) {
      return Response.json({ error: "Missing asset token or path" }, { status: 404 });
    }

    const token = rest.slice(0, slash);
    const root = rootsByToken.get(token);
    if (!root) {
      return Response.json({ error: "Unknown asset root" }, { status: 404 });
    }

    const assetPath = normalizeHtmlAssetRoutePath(rest.slice(slash + 1));
    if (!assetPath) {
      return Response.json({ error: "Invalid asset path" }, { status: 400 });
    }

    const contentType = htmlAssetContentType(assetPath);
    if (!contentType) {
      return Response.json({ error: "Unsupported asset type" }, { status: 415 });
    }

    const resolved = resolvePath(root, assetPath);
    if (!isWithinDirectory(resolved, root)) {
      return Response.json({ error: "Access denied" }, { status: 403 });
    }

    try {
      const file = Bun.file(resolved);
      if (!(await file.exists())) {
        return Response.json({ error: "Asset not found" }, { status: 404 });
      }
      if (file.size > MAX_HTML_ASSET_BYTES) {
        return Response.json({ error: "Asset too large" }, { status: 413 });
      }
      return new Response(file, {
        headers: {
          "Content-Type": contentType,
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": "*",
        },
      });
    } catch {
      return Response.json({ error: "Failed to read asset" }, { status: 500 });
    }
  }

  return { rewriteHtml, inlineHtml, handle };
}

function isWithinDirectory(filePath: string, root: string): boolean {
  const resolved = resolvePath(filePath);
  const resolvedRoot = resolvePath(root);
  const rel = relative(resolvedRoot, resolved);
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}
