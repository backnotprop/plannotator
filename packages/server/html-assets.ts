import { resolve as resolvePath } from "path";
import {
  HTML_ASSET_ERROR_CSP,
  HTML_ASSET_DOCUMENT_CSP,
  HTML_ASSET_ROUTE_PREFIX,
  buildHtmlAssetErrorDocument,
  encodeHtmlAssetPath,
  htmlAssetBaseHref,
  htmlAssetDocumentHeaders,
  isFramedEmbeddedDocumentRequest,
  resolveHtmlAssetRoute,
  rewriteHtmlAssetReferences,
} from "@plannotator/shared/html-assets";
import {
  inlineHtmlLocalAssets,
  htmlAssetContext,
  isWithinDirectory,
  MAX_HTML_ASSET_BYTES,
} from "@plannotator/shared/html-assets-node";

export { inlineHtmlLocalAssets };

/**
 * A failure inside the asset route. Framed and `.html` requests get a tiny
 * HTML document naming the file; everything else keeps the JSON shape the
 * route has always answered with.
 */
function assetError(
  status: number,
  message: string,
  asDocument: boolean,
  name?: string,
): Response {
  if (!asDocument) return Response.json({ error: message }, { status });
  return new Response(buildHtmlAssetErrorDocument(status, message, name), {
    status,
    headers: htmlAssetDocumentHeaders(HTML_ASSET_ERROR_CSP),
  });
}

/**
 * The catch-all's guard: a request the browser will render as a nested
 * document, AND whose path names a file, must never receive the editor app.
 * That is the bug this whole change is about — Plannotator rendering inside an
 * annotated page's embed — and the `<base href>` fix removes the usual way of
 * getting here, so anything still arriving is a genuinely missing file and
 * deserves to say so. The path condition is what keeps the app document itself
 * (`/`) out of it: see `pathNamesEmbeddedDocument` for why the shape of the
 * path, and not `Sec-Fetch-Site`, is the signal.
 */
export function framedDocumentNotFound(req: Request, url: URL): Response | null {
  if (!isFramedEmbeddedDocumentRequest(req.headers.get("sec-fetch-dest"), url.pathname)) {
    return null;
  }
  const name = url.pathname.split("/").filter(Boolean).pop();
  return new Response(buildHtmlAssetErrorDocument(404, "Not found", name), {
    status: 404,
    headers: htmlAssetDocumentHeaders(HTML_ASSET_ERROR_CSP),
  });
}

export function createHtmlAssetRegistry(folderPath?: string) {
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
      const { root, basePath } = htmlAssetContext(htmlFilePath, folderPath);
      const token = register(root);
      return rewriteHtmlAssetReferences(
        html,
        (assetPath) => `${HTML_ASSET_ROUTE_PREFIX}/${token}/${encodeHtmlAssetPath(assetPath)}`,
        // The base is root-relative on purpose: a srcdoc document resolves its
        // own <base href> against the PARENT's URL, which is this server, so
        // `/api/html-assets/<token>/` lands on the right origin without the
        // rewrite needing to know the port.
        { baseHref: htmlAssetBaseHref(token) + (basePath ? `${encodeHtmlAssetPath(basePath)}/` : ""), assetBasePath: basePath },
      );
    } catch {
      return html;
    }
  }

  function inlineHtml(html: string, htmlFilePath: string): string {
    return inlineHtmlLocalAssets(html, htmlFilePath, folderPath);
  }

  async function handle(req: Request, url: URL): Promise<Response | null> {
    const decision = resolveHtmlAssetRoute(
      { pathname: url.pathname, secFetchDest: req.headers.get("sec-fetch-dest") },
      (token) => rootsByToken.get(token),
    );
    if (decision.kind === "not-asset-route") return null;
    if (decision.kind === "error") {
      return assetError(decision.status, decision.message, decision.asDocument, decision.name);
    }

    const { root, assetPath, contentType, document, asDocument, maxBytes } = decision;
    const resolved = resolvePath(root, assetPath);
    if (!isWithinDirectory(resolved, root)) {
      return assetError(403, "Access denied", asDocument, assetPath);
    }

    try {
      const file = Bun.file(resolved);
      if (!(await file.exists())) {
        return assetError(404, "Not found", asDocument, assetPath);
      }
      const cap = Math.min(maxBytes, MAX_HTML_ASSET_BYTES);
      if (file.size > cap) {
        return assetError(413, "Asset too large", asDocument, assetPath);
      }
      if (document) {
        return new Response(file, {
          headers: {
            ...htmlAssetDocumentHeaders(HTML_ASSET_DOCUMENT_CSP),
            // Kept for parity with the other assets: a nested document load is
            // not a CORS request, but a `fetch('./page.html')` from the
            // opaque-origin frame is.
            "Access-Control-Allow-Origin": "*",
          },
        });
      }
      return new Response(file, {
        headers: {
          "Content-Type": contentType,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Access-Control-Allow-Origin": "*",
        },
      });
    } catch {
      return assetError(500, "Failed to read asset", asDocument, assetPath);
    }
  }

  return { rewriteHtml, inlineHtml, handle };
}

