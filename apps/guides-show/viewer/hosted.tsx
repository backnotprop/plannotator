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
  readonly hostedUrl: string | null;
  readonly payloadUrl: string | null;
}

export function readHostedPage(doc: Document): HostedPageInfo {
  const meta = (name: string): string | null => {
    const el = doc.querySelector(`meta[name="${name}"]`);
    const content = el?.getAttribute('content')?.trim();
    return content ? content : null;
  };
  return { hostedUrl: meta(GUIDE_HOSTED_META_NAME), payloadUrl: meta(GUIDE_PAYLOAD_META_NAME) };
}

export function readShareKey(hash: string): string | null {
  const fragment = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!fragment) return null;
  const key = new URLSearchParams(fragment).get(GUIDE_SHARE_KEY_PARAM)?.trim();
  return key ? key : null;
}

export type HostedLoadResult =
  | { readonly kind: 'ok'; readonly snapshot: GuideSnapshot }
  | { readonly kind: 'missing-key' }
  | { readonly kind: 'unavailable'; readonly detail: string }
  | { readonly kind: 'wrong-key' }
  | { readonly kind: 'invalid'; readonly path: string; readonly message: string };

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

export interface ViewerDocumentLike {
  readonly baseURI: string;
  querySelectorAll(selectors: string): ArrayLike<{ getAttribute(name: string): string | null }>;
}

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

export function buildPortableGuideFile(snapshot: GuideSnapshot, viewer: GuideViewerAssets): { html: string; filename: string } | null {
  try {
    return { html: createGuideHtml(snapshot, { viewer }), filename: guideExportFilename(snapshot.guide.title) };
  } catch {
    return null;
  }
}

function saveBlob(html: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

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

export function HostedDownloadButton({ snapshot, scriptUrl }: { snapshot: GuideSnapshot; scriptUrl: string }) {
  const viewer = useMemo(() => readViewerAssetsFromDocument(document, scriptUrl), [scriptUrl]);
  const [failed, setFailed] = useState(false);
  if (!viewer) return null;

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
