/**
 * Response headers for `GET /api/image?path=` (plan, annotate and review
 * servers, Bun and Pi). Vendored to Pi.
 *
 * The route serves any local file whose name ends in an image extension, SVG
 * included. An SVG opened directly (a top-level tab, a frame) is a document,
 * and served from the session's origin it could run script with the session's
 * cookies and API. Every response therefore carries:
 *
 * - `Content-Security-Policy: sandbox; …`: an opaque origin and no script for
 *   a document opened directly. As an `<img>` (or CSS background) an image is
 *   never a document, so the policy does not change how the page shows it.
 * - `X-Content-Type-Options: nosniff`: the browser keeps the declared type.
 * - `Cross-Origin-Resource-Policy: same-origin`: only the session's own pages
 *   embed these images (the app, the VS Code panel through its proxy, Glimpse),
 *   so another site, or a sandboxed (opaque-origin) frame, cannot load them.
 *
 * The other image routes (`/api/review-image`, the Inbox's image routes) send
 * the same protections; `img-src 'self' data:` here lets an SVG opened
 * directly still draw its own embedded and same-origin images.
 */

export const LOCAL_IMAGE_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:";

const LOCAL_IMAGE_CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  tiff: "image/tiff",
  tif: "image/tiff",
  avif: "image/avif",
};

/** The Content-Type `/api/image` declares for a path, by its extension. */
export function localImageContentType(filePath: string): string {
  const lastDot = filePath.lastIndexOf(".");
  const ext = lastDot === -1 ? "" : filePath.slice(lastDot + 1).toLowerCase();
  return LOCAL_IMAGE_CONTENT_TYPES[ext] ?? "application/octet-stream";
}

/** Headers for every `/api/image` response, image bytes and refusals alike. */
export function localImageResponseHeaders(contentType: string): Record<string, string> {
  return {
    "Content-Type": contentType,
    "Content-Security-Policy": LOCAL_IMAGE_CSP,
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "same-origin",
  };
}
