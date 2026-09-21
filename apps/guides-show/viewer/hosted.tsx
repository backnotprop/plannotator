/**
 * The hosted side of the portable viewer: what changes when the page came from
 * a guide host (guides.show `/g/<id>` or a self-hosted origin) instead of a
 * downloaded file.
 *
 *   - `readHostedPage` reads the two metas a host stamps into the head
 *     (`GUIDE_HOSTED_META_NAME`: this is a hosted page; `GUIDE_PAYLOAD_META_NAME`:
 *     the guide is encrypted, fetch the ciphertext from here).
 *   - `loadHostedEncryptedSnapshot` is the encrypted boot: key from the URL
 *     fragment, fetch, decrypt, decompress, parse. Each failure maps to one of
 *     the three cards the contract names (missing key / unavailable / wrong
 *     key) so the reader knows whether the link, the host, or the key is at
 *     fault.
 *   - `HostedDownloadButton` builds the portable file CLIENT-SIDE from the
 *     snapshot already in memory and the viewer assets this very page loaded,
 *     so the download never round-trips the host and never carries the hosted
 *     meta (it is a plain export, byte-compatible with the in-app one).
 *
 * Contract: adr/implementation/guide-share-hosting.md section 6.
 */
import React, { useMemo, useState } from 'react';
import {
  GUIDE_HOSTED_META_NAME,
  GUIDE_PAYLOAD_META_NAME,
  GUIDE_SHARE_KEY_PARAM,
  createGuideHtml,
  guideExportFilename,
  parseGuideSnapshot,
  type GuideSnapshot,
  type GuideViewerAssets,
} from '@plannotator/core/guide-format';
import { decrypt } from '@plannotator/core/crypto';
import { decompress } from '@plannotator/core/compress';

export interface HostedPageInfo {
  /** Canonical URL of the hosted page (the hosted meta), or null on a downloaded file. */
  readonly hostedUrl: string | null;
  /** Where the ciphertext lives (the payload meta), or null when the snapshot is embedded. */
  readonly payloadUrl: string | null;
}

/** Read the host metas. A downloaded file has neither. */
export function readHostedPage(doc: Document): HostedPageInfo {
  const meta = (name: string): string | null => {
    const el = doc.querySelector(`meta[name="${name}"]`);
    const content = el?.getAttribute('content')?.trim();
    return content ? content : null;
  };
  return { hostedUrl: meta(GUIDE_HOSTED_META_NAME), payloadUrl: meta(GUIDE_PAYLOAD_META_NAME) };
}

/** The key an encrypted link carries in its fragment (`#key=...`), or null. */
export function readShareKey(hash: string): string | null {
  const fragment = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!fragment) return null;
  const key = new URLSearchParams(fragment).get(GUIDE_SHARE_KEY_PARAM)?.trim();
  return key ? key : null;
}

export type HostedLoadResult =
  | { readonly kind: 'ok'; readonly snapshot: GuideSnapshot }
  /** No `#key=` in the URL: the reader pasted the link without its fragment. */
  | { readonly kind: 'missing-key' }
  /** The host did not hand back a body (404 after delete/expiry, network down, CSP). */
  | { readonly kind: 'unavailable'; readonly detail: string }
  /** The body arrived but AES-GCM rejected the key (wrong or truncated fragment). */
  | { readonly kind: 'wrong-key' }
  /** Decrypted fine but the payload is not a guide snapshot this viewer reads. */
  | { readonly kind: 'invalid'; readonly path: string; readonly message: string };

/**
 * Encrypted boot. Never throws: every step folds into a `HostedLoadResult` so
 * the caller only has to pick a card. `fetchImpl` is injectable for tests.
 */
export async function loadHostedEncryptedSnapshot(
  payloadUrl: string,
  hash: string,
  fetchImpl: typeof fetch = fetch,
  baseUrl: string | undefined = typeof document !== 'undefined' ? document.baseURI : undefined,
): Promise<HostedLoadResult> {
  const key = readShareKey(hash);
  if (!key) return { kind: 'missing-key' };

  let body: string;
  try {
    // Relative payload URLs (`/api/g/<id>`) resolve against the page, which
    // is the host origin the page's CSP `connect-src` allows.
    const url = new URL(payloadUrl, baseUrl).href;
    const response = await fetchImpl(url, { mode: 'cors', credentials: 'omit' });
    if (!response.ok) return { kind: 'unavailable', detail: `${response.status} ${response.statusText}`.trim() };
    body = (await response.text()).trim();
    if (!body) return { kind: 'unavailable', detail: 'empty payload' };
  } catch (error) {
    return { kind: 'unavailable', detail: error instanceof Error ? error.message : String(error) };
  }

  let compressed: string;
  try {
    compressed = await decrypt(body, key);
  } catch {
    // Web Crypto reports a bad key, a bad IV and a tampered body all as one
    // opaque OperationError; from the reader's seat every one of them means
    // "this key does not open this guide".
    return { kind: 'wrong-key' };
  }

  let value: unknown;
  try {
    value = await decompress(compressed);
  } catch (error) {
    return { kind: 'invalid', path: '$', message: error instanceof Error ? error.message : 'payload is not deflate-raw JSON' };
  }
  const parsed = parseGuideSnapshot(value);
  if (parsed.ok === false) return { kind: 'invalid', path: parsed.error.path, message: parsed.error.message };
  return { kind: 'ok', snapshot: parsed.value };
}

/** The slice of `Document` the pin rebuild reads; structural so tests need no DOM. */
export interface ViewerDocumentLike {
  readonly baseURI: string;
  querySelectorAll(selectors: string): ArrayLike<{ getAttribute(name: string): string | null }>;
}

/**
 * Rebuild the viewer pin from what this page actually loaded: the module
 * script (this bundle, `import.meta.url`) and its stylesheet, integrity
 * attributes included. `baseUrl` is the script's directory, so a self-hosted
 * origin pins itself and guides.show pins `/v1/`. No `langs`: the exported
 * file then skips the grammar modulepreloads, which only cost a round-trip.
 * Returns null when the script URL is not absolute or no stylesheet under the
 * script's directory can be found; `buildPortableGuideFile` then separately
 * refuses a base `createGuideHtml` rejects (plain http off localhost).
 */
export function readViewerAssetsFromDocument(doc: ViewerDocumentLike, scriptUrl: string): GuideViewerAssets | null {
  let script: URL;
  try {
    script = new URL(scriptUrl);
  } catch {
    return null;
  }
  const baseHref = new URL('.', script).href;
  const relativeTo = (href: string | null): string | null =>
    href !== null && href.startsWith(baseHref) ? href.slice(baseHref.length) : null;
  const js = relativeTo(script.href);
  if (!js) return null;

  const scripts = Array.from(doc.querySelectorAll('script[type="module"][src]'));
  const scriptEl = scripts.find((el) => safeHref(el.getAttribute('src'), doc.baseURI) === script.href) ?? null;

  const links = Array.from(doc.querySelectorAll('link[rel="stylesheet"][href]'));
  const cssEl = links.find((el) => relativeTo(safeHref(el.getAttribute('href'), doc.baseURI)) !== null) ?? null;
  const css = cssEl ? relativeTo(safeHref(cssEl.getAttribute('href'), doc.baseURI)) : null;
  if (!css) return null;

  const jsIntegrity = scriptEl?.getAttribute('integrity')?.trim() || undefined;
  const cssIntegrity = cssEl?.getAttribute('integrity')?.trim() || undefined;
  return { baseUrl: baseHref, js, css, jsIntegrity, cssIntegrity };
}

function safeHref(value: string | null, base: string): string | null {
  if (value === null) return null;
  try {
    return new URL(value, base).href;
  } catch {
    return null;
  }
}

/** Build the portable file for `snapshot` against `viewer`; null when the head cannot be built (non-https base). */
export function buildPortableGuideFile(snapshot: GuideSnapshot, viewer: GuideViewerAssets): { html: string; filename: string } | null {
  try {
    return { html: createGuideHtml(snapshot, { viewer }), filename: guideExportFilename(snapshot.guide.title) };
  } catch {
    return null;
  }
}

/** Hand the reader a file through a blob URL and a synthetic `<a download>` click. */
function saveBlob(html: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoke after the click has been dispatched; revoking synchronously races
  // the download start in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/**
 * The lucide `Download` glyph, drawn inline: the CDN viewer does not carry
 * lucide-react (isolated workspace install), and one icon is not worth the
 * dependency. Same viewBox, stroke and caps as `<Download size={13} />`.
 */
function DownloadIcon({ size = 13 }: { size?: number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 15V3" />
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m7 10 5 5 5-5" />
    </svg>
  );
}

/**
 * "Download portable guide" for hosted pages, styled like the in-app
 * `GuideExportButton`. Renders nothing when the viewer pin cannot be
 * reconstructed from this page, so a page that cannot produce a valid export
 * never shows a dead control.
 */
export function HostedDownloadButton({ snapshot, scriptUrl }: { snapshot: GuideSnapshot; scriptUrl: string }) {
  const viewer = useMemo(() => readViewerAssetsFromDocument(document, scriptUrl), [scriptUrl]);
  const [failed, setFailed] = useState(false);
  if (!viewer) return null;

  // A <button>, not an <a href="#">: a hash navigation would wipe the
  // `#key=` fragment the encrypted page depends on.
  const onClick = () => {
    const file = buildPortableGuideFile(snapshot, viewer);
    if (!file) {
      setFailed(true);
      return;
    }
    setFailed(false);
    saveBlob(file.html, file.filename);
  };

  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-background px-2.5 py-1.5 text-[11.5px] text-muted-foreground transition-colors hover:border-border hover:text-foreground pointer-coarse:px-3.5 pointer-coarse:py-2.5"
      title={
        failed
          ? 'The portable file could not be built from this page.'
          : 'Download this guide as one portable HTML file. Opens anywhere, no Plannotator needed.'
      }
      data-testid="guide-download"
    >
      <DownloadIcon size={13} />
      <span>{failed ? 'Download failed' : 'Download portable guide'}</span>
    </button>
  );
}
