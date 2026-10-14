import { resolve as resolvePath } from "path";
import {
  HTML_ASSET_ERROR_CSP,
  HTML_ASSET_DOCUMENT_CSP,
  HTML_ASSET_ROUTE_PREFIX,
  buildHtmlAssetErrorDocument,
  encodeHtmlAssetPath,
  htmlAssetBaseHref,
  htmlAssetDocumentHeaders,
  htmlAssetHeaders,
  isFramedEmbeddedDocumentRequest,
  resolveHtmlAssetRoute,
  rewriteHtmlAssetReferences,
} from "@plannotator/shared/html-assets";
import {
  inlineHtmlLocalAssets,
  folderSessionAssetAllowed,
  htmlAssetContext,
  htmlAssetPathRefused,
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

/**
 * Options a host opts into; annotate passes none and keeps its behaviour.
 * The Inbox serves the folder of an HTML file an agent attached from
 * anywhere (a home folder, say), so it refuses hidden paths and secret
 * names, and gives nested documents no network.
 */
export interface HtmlAssetRegistryOptions {
  /**
   * Refuse (404) an asset whose path, as requested or as its realpath under
   * the root, names something this host never serves: the Inbox refuses any
   * segment starting with `.` and the dotenv family.
   */
  refuseAssetPath?: (relativePath: string) => boolean;
  /** The CSP of an embedded `.html` document. Default HTML_ASSET_DOCUMENT_CSP. */
  documentCsp?: string;
  /**
   * Annotate folder sessions: the selected folder is the asset root for every
   * document inside it, so `../assets/x.css` resolves. Outside the page's own
   * directory such a root refuses hidden paths and the dotenv family
   * (`folderSessionAssetAllowed`).
   */
  folderPath?: string;
}

export function createHtmlAssetRegistry(options: HtmlAssetRegistryOptions = {}) {
  const folderPath = options.folderPath;
  const rootsByToken = new Map<string, string>();
  const tokensByScope = new Map<string, string>();
  /**
   * Folder-session tokens: one per (selected folder, document directory), so
   * the route knows which page's directory a request comes from.
   */
  const docDirByToken = new Map<string, string>();

  function register(baseDir: string, docDir: string | null = null): string {
    const root = resolvePath(baseDir);
    const scope = docDir ? `${root}\0${docDir}` : root;
    const existing = tokensByScope.get(scope);
    if (existing) return existing;
    const token = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    tokensByScope.set(scope, token);
    rootsByToken.set(token, root);
    if (docDir) docDirByToken.set(token, docDir);
    return token;
  }

  function rewriteHtml(html: string, htmlFilePath: string): string {
    if (/^https?:\/\//i.test(htmlFilePath)) return html;
    try {
      const { root, basePath, docDir } = htmlAssetContext(htmlFilePath, folderPath);
      const token = register(root, docDir);
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

  /**
   * The asset-route URL of an HTML file itself (`/api/html-assets/<token>/<name>`),
   * so a top-level tab of it resolves its relative assets, anchors and frames
   * from its own folder, with the document CSP. Null for a URL.
   */
  function documentUrl(htmlFilePath: string): string | null {
    if (/^https?:\/\//i.test(htmlFilePath)) return null;
    const { root, basePath, docDir } = htmlAssetContext(htmlFilePath, folderPath);
    const token = register(root, docDir);
    const name = htmlFilePath.split(/[\\/]/).pop() ?? "";
    return `${htmlAssetBaseHref(token)}${encodeHtmlAssetPath(basePath ? `${basePath}/${name}` : name)}`;
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

    const { token, root, assetPath, contentType, document, asDocument, maxBytes } = decision;
    const resolved = resolvePath(root, assetPath);
    if (!isWithinDirectory(resolved, root)) {
      return assetError(403, "Access denied", asDocument, assetPath);
    }
    // The host's own rule (the Inbox), judged as requested and by where the
    // path really leads under the root; and a folder session's rule (the
    // page's own directory as before, the rest of the folder minus hidden
    // paths).
    const docDir = docDirByToken.get(token);
    if (
      (options.refuseAssetPath && htmlAssetPathRefused(root, assetPath, options.refuseAssetPath)) ||
      (docDir && !folderSessionAssetAllowed(root, docDir, assetPath))
    ) {
      return assetError(404, "Not found", asDocument, assetPath);
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
            ...htmlAssetDocumentHeaders(options.documentCsp ?? HTML_ASSET_DOCUMENT_CSP),
            // Kept for parity with the other assets: a nested document load is
            // not a CORS request, but a `fetch('./page.html')` from the
            // opaque-origin frame is.
            "Access-Control-Allow-Origin": "*",
          },
        });
      }
      return new Response(file, {
        headers: {
          // Sandboxed: an SVG or XML asset opened as a document never runs script on this origin.
          ...htmlAssetHeaders(contentType),
          "Access-Control-Allow-Origin": "*",
        },
      });
    } catch {
      return assetError(500, "Failed to read asset", asDocument, assetPath);
    }
  }

  return { rewriteHtml, inlineHtml, documentUrl, handle };
}

