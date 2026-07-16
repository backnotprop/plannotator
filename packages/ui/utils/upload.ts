/**
 * Host-overridable image upload transport.
 *
 * Default = today's literal Plannotator behavior (POST /api/upload with the
 * file as multipart form-data, response `{ path, originalName }`). A host
 * (e.g. Workspaces) calls `setUploadTransport` once at startup to send the
 * bytes to its own asset backend instead. Mirrors the swappable transports in
 * ./storage.ts and ../hooks/useAnnotationDraft.ts.
 */

export interface UploadResult {
  /**
   * Stored reference the UI round-trips and feeds to the image-src resolver.
   * Plannotator returns the server file path. A host may return its own opaque
   * ref or a fully-resolved URL (the default image-src resolver passes http(s)
   * URLs through unchanged, so a returned URL renders directly).
   */
  path: string;
  /** Original file name, when the backend echoes it. */
  originalName?: string;
}

export interface UploadTransport {
  /** Upload one image file and resolve to its stored reference. */
  upload(file: File): Promise<UploadResult>;
}

/** Default transport — Plannotator's `/api/upload` multipart POST, verbatim. */
const defaultUploadTransport: UploadTransport = {
  async upload(file) {
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch('/api/upload', { method: 'POST', body: formData });
    const data = await res.json();
    return { path: data.path, originalName: data.originalName };
  },
};

// Module-level transport, stable identity. Defaults to Plannotator's behavior so
// callers are unchanged. A host overrides it once at startup.
let uploadTransport: UploadTransport = defaultUploadTransport;

/** Override how image attachments are uploaded. Call once at app startup. */
export function setUploadTransport(t: UploadTransport): void {
  uploadTransport = t;
}

/** Reset to the default (Plannotator `/api/upload`) transport. Mainly for tests. */
export function resetUploadTransport(): void {
  uploadTransport = defaultUploadTransport;
}

/** Read the active upload transport at call time (so a late override is honored). */
export function getUploadTransport(): UploadTransport {
  return uploadTransport;
}
