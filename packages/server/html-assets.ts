import { dirname, resolve as resolvePath } from "path";
import {
  HTML_ASSET_ROUTE_PREFIX,
  encodeHtmlAssetPath,
  htmlAssetContentType,
  normalizeHtmlAssetRoutePath,
  rewriteHtmlAssetReferences,
} from "@plannotator/shared/html-assets";
import {
  inlineHtmlLocalAssets,
  isWithinDirectory,
  MAX_HTML_ASSET_BYTES,
} from "@plannotator/shared/html-assets-node";

export { inlineHtmlLocalAssets };

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

