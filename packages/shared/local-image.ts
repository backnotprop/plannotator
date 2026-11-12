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

export function localImageContentType(filePath: string): string {
  const lastDot = filePath.lastIndexOf(".");
  const ext = lastDot === -1 ? "" : filePath.slice(lastDot + 1).toLowerCase();
  return LOCAL_IMAGE_CONTENT_TYPES[ext] ?? "application/octet-stream";
}

export function localImageResponseHeaders(contentType: string): Record<string, string> {
  return {
    "Content-Type": contentType,
    "Content-Security-Policy": LOCAL_IMAGE_CSP,
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "same-origin",
  };
}
