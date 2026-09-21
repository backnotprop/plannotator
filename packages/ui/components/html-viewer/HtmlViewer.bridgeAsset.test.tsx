/**
 * HtmlViewer on the `bridgeScriptUrl` path (DOM-gated).
 *
 * Guards: the srcdoc carries a `<script src>` instead of the inline literal
 * only when the prop is set; a ready without the protocol stamp (a cached
 * asset from an older package) produces one console warning naming both
 * versions plus the surface's error banner and host callback; a missing
 * ready within `bridgeReadyTimeoutMs` produces the timeout banner and a
 * late ready clears it; and the inline path runs no timer and shows no
 * banner, so Plannotator's surface is unchanged.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { BRIDGE_PROTOCOL_VERSION, BRIDGE_SCRIPT } from './bridge-script';
import type { BridgeUnavailableInfo } from './HtmlViewer';

const hasDom = typeof document !== 'undefined';
const htmlViewerModule = hasDom ? await import('./HtmlViewer') : null;

const mountedRoots: Array<{ unmount: () => void }> = [];
const originalWarn = console.warn;
const originalError = console.error;

afterEach(async () => {
  console.warn = originalWarn;
  console.error = originalError;
  if (!hasDom) return;
  await act(async () => {
    for (const root of mountedRoots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
});

const ASSET_URL = 'https://host.example/assets/bridge-script.deadbeef.js';

type MountProps = {
  bridgeScriptUrl?: string;
  bridgeReadyTimeoutMs?: number;
  onBridgeUnavailable?: (info: BridgeUnavailableInfo) => void;
  bridgeErrorDisplay?: 'banner' | 'none';
  rawHtml?: string;
};

const DEFAULT_HTML = "<html><head><title>t</title></head><body><p>Target</p></body></html>";

async function mount(props: MountProps) {
  if (!htmlViewerModule) throw new Error('DOM test environment is not registered');
  const HtmlViewer = htmlViewerModule.HtmlViewer;
  // happy-dom parses the srcdoc and, with script file loading disabled,
  // reports the <script src> as a NotSupportedError through console.error.
  // That is the environment, not the viewer (a browser fetches the asset):
  // keep it out of the test output. Restored in afterEach.
  if (props.bridgeScriptUrl) console.error = () => {};
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedRoots.push(root);
  const render = async (next: MountProps) => {
    await act(async () => {
      root.render(
        <HtmlViewer
          rawHtml={next.rawHtml ?? DEFAULT_HTML}
          annotations={[]}
          onAddAnnotation={() => {}}
          onSelectAnnotation={() => {}}
          selectedAnnotationId={null}
          mode="selection"
          inputMethod="pinpoint"
          bridgeScriptUrl={next.bridgeScriptUrl}
          bridgeReadyTimeoutMs={next.bridgeReadyTimeoutMs}
          onBridgeUnavailable={next.onBridgeUnavailable}
          bridgeErrorDisplay={next.bridgeErrorDisplay}
        />,
      );
    });
  };
  await render(props);
  const rerender = (patch: Partial<MountProps>) => render({ ...props, ...patch });
  const iframe = host.querySelector<HTMLIFrameElement>('iframe');
  if (!iframe?.contentWindow) throw new Error('HTML iframe missing');
  const postedToIframe: Array<Record<string, unknown>> = [];
  const realPost = iframe.contentWindow.postMessage.bind(iframe.contentWindow);
  (iframe.contentWindow as unknown as { postMessage: (data: unknown) => void }).postMessage =
    ((data: unknown, ...rest: unknown[]) => {
      if (data && typeof data === 'object') postedToIframe.push(data as Record<string, unknown>);
      return (realPost as (...args: unknown[]) => unknown)(data, ...rest);
    }) as typeof iframe.contentWindow.postMessage;
  const postReady = async (data: Record<string, unknown>) => {
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', { source: iframe.contentWindow, data }));
    });
  };
  const banner = () => host.querySelector<HTMLElement>('[data-bridge-error]');
  return { host, iframe, postReady, postedToIframe, banner, rerender };
}

function captureWarnings(): string[] {
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };
  return warnings;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe.if(hasDom)('HtmlViewer bridgeScriptUrl', () => {
  test('the srcdoc loads the bridge by URL instead of inlining it', async () => {
    const { iframe } = await mount({ bridgeScriptUrl: ASSET_URL });
    const srcdoc = iframe.getAttribute('srcdoc') ?? '';
    expect(srcdoc).toContain(`<script src="${ASSET_URL}"></script>`);
    expect(srcdoc).not.toContain(BRIDGE_SCRIPT);
    // The sandbox is unchanged by the delivery path.
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts');
  });

  test("a relative URL is resolved against the PARENT document, so a page's own <base href> cannot redirect it", async () => {
    // happy-dom's document lives at about:blank; give the PARENT a real base
    // the way a host page has one, and remove it afterwards.
    const parentBase = document.createElement('base');
    parentBase.setAttribute('href', 'http://host.test:4000/workspace/');
    document.head.appendChild(parentBase);
    try {
      expect(document.baseURI).toBe('http://host.test:4000/workspace/');
      const { iframe } = await mount({
        bridgeScriptUrl: '/assets/bridge-script.deadbeef.js',
        rawHtml: '<html><head><base href="https://attacker.example/"><title>t</title></head><body><p>x</p></body></html>',
      });
      const srcdoc = iframe.getAttribute('srcdoc') ?? '';
      expect(srcdoc).toContain('<script src="http://host.test:4000/assets/bridge-script.deadbeef.js"></script>');
      // The page's base tag still precedes the injected tag (end of <head>),
      // which is exactly why the src must already be absolute.
      expect(srcdoc.indexOf('<base href')).toBeLessThan(srcdoc.indexOf('<script src='));
      expect(srcdoc).not.toContain('src="/assets/');
      expect(srcdoc).not.toContain('attacker.example/assets');
    } finally {
      parentBase.remove();
    }
  });

  test('without the prop the srcdoc inlines the bridge, as before', async () => {
    const { iframe, banner } = await mount({});
    const srcdoc = iframe.getAttribute('srcdoc') ?? '';
    expect(srcdoc).toContain(`<script>${BRIDGE_SCRIPT}</script>`);
    expect(srcdoc).not.toContain('<script src=');
    expect(banner()).toBeNull();
  });

  test('a stale asset (ready without the stamp) warns once naming both versions, shows the banner, and still honors the ready', async () => {
    const warnings = captureWarnings();
    const unavailable: BridgeUnavailableInfo[] = [];
    const { postReady, postedToIframe, banner } = await mount({
      bridgeScriptUrl: ASSET_URL,
      onBridgeUnavailable: (info) => unavailable.push(info),
    });
    await postReady({ type: 'plannotator-bridge-ready' });

    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain(`expects ${BRIDGE_PROTOCOL_VERSION}`);
    expect(warnings[0]).toContain('reported none');
    expect(warnings[0]).toContain(ASSET_URL);

    const el = banner();
    expect(el?.getAttribute('data-bridge-error')).toBe('version-mismatch');
    expect(el?.getAttribute('role')).toBe('alert');
    expect(el?.textContent).toContain(ASSET_URL);
    expect(unavailable).toEqual([
      { kind: 'version-mismatch', url: ASSET_URL, expectedVersion: BRIDGE_PROTOCOL_VERSION, reportedVersion: undefined },
    ]);
    // Not a refusal: the parent still configures the older bridge.
    expect(postedToIframe.some((m) => m.type === 'plannotator-bridge-sync-annotations')).toBe(true);
  });

  test('a matching ready shows no banner and cancels the ready timer', async () => {
    const warnings = captureWarnings();
    const unavailable: BridgeUnavailableInfo[] = [];
    const { postReady, banner } = await mount({
      bridgeScriptUrl: ASSET_URL,
      bridgeReadyTimeoutMs: 40,
      onBridgeUnavailable: (info) => unavailable.push(info),
    });
    await postReady({ type: 'plannotator-bridge-ready', protocolVersion: BRIDGE_PROTOCOL_VERSION });
    await act(async () => { await wait(80); });
    expect(warnings).toEqual([]);
    expect(banner()).toBeNull();
    expect(unavailable).toEqual([]);
  });

  test('no ready within bridgeReadyTimeoutMs shows the timeout banner; a late ready clears it', async () => {
    const unavailable: BridgeUnavailableInfo[] = [];
    const { postReady, banner } = await mount({
      bridgeScriptUrl: ASSET_URL,
      bridgeReadyTimeoutMs: 30,
      onBridgeUnavailable: (info) => unavailable.push(info),
    });
    expect(banner()).toBeNull();
    await act(async () => { await wait(70); });
    const el = banner();
    expect(el?.getAttribute('data-bridge-error')).toBe('timeout');
    expect(el?.textContent).toContain('30 ms');
    expect(el?.textContent).toContain(ASSET_URL);
    expect(unavailable).toEqual([{ kind: 'timeout', url: ASSET_URL, timeoutMs: 30 }]);

    await postReady({ type: 'plannotator-bridge-ready', protocolVersion: BRIDGE_PROTOCOL_VERSION });
    expect(banner()).toBeNull();
  });

  test('changing bridgeReadyTimeoutMs after a successful ready never re-arms the timer', async () => {
    const unavailable: BridgeUnavailableInfo[] = [];
    const { postReady, banner, rerender } = await mount({
      bridgeScriptUrl: ASSET_URL,
      bridgeReadyTimeoutMs: 5000,
      onBridgeUnavailable: (info) => unavailable.push(info),
    });
    await postReady({ type: 'plannotator-bridge-ready', protocolVersion: BRIDGE_PROTOCOL_VERSION });
    await rerender({ bridgeReadyTimeoutMs: 20 });
    await act(async () => { await wait(80); });
    expect(banner()).toBeNull();
    expect(unavailable).toEqual([]);
  });

  test('the version-mismatch banner is dismissible; the timeout banner is not', async () => {
    captureWarnings();
    const unavailable: BridgeUnavailableInfo[] = [];
    const { postReady, banner, host } = await mount({
      bridgeScriptUrl: ASSET_URL,
      onBridgeUnavailable: (info) => unavailable.push(info),
    });
    await postReady({ type: 'plannotator-bridge-ready' });
    const dismiss = host.querySelector<HTMLButtonElement>('[data-bridge-error-dismiss]');
    expect(dismiss).not.toBeNull();
    await act(async () => { dismiss!.click(); });
    expect(banner()).toBeNull();
    // Dismissing hides the strip only: the host was told exactly once.
    expect(unavailable.length).toBe(1);

    const timedOut = await mount({ bridgeScriptUrl: ASSET_URL, bridgeReadyTimeoutMs: 20 });
    await act(async () => { await wait(70); });
    expect(timedOut.banner()?.getAttribute('data-bridge-error')).toBe('timeout');
    expect(timedOut.host.querySelector('[data-bridge-error-dismiss]')).toBeNull();
  });

  // 0.34.0: a host that renders its own notice from onBridgeUnavailable
  // could not suppress the package strip, so both showed. What regresses:
  // 'none' still renders a strip (double banner), or 'none' also mutes the
  // callback or the version-mismatch console warning the host relies on.
  test("bridgeErrorDisplay='none' renders no strip while the callback and the mismatch warning still fire", async () => {
    const warnings = captureWarnings();
    const unavailable: BridgeUnavailableInfo[] = [];
    const { postReady, banner, host } = await mount({
      bridgeScriptUrl: ASSET_URL,
      bridgeErrorDisplay: 'none',
      onBridgeUnavailable: (info) => unavailable.push(info),
    });
    await postReady({ type: 'plannotator-bridge-ready' });
    expect(banner()).toBeNull();
    expect(host.querySelector('[data-bridge-error-dismiss]')).toBeNull();
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain(`expects ${BRIDGE_PROTOCOL_VERSION}`);
    expect(unavailable.map((info) => info.kind)).toEqual(['version-mismatch']);

    const timedOut = await mount({
      bridgeScriptUrl: ASSET_URL,
      bridgeErrorDisplay: 'none',
      bridgeReadyTimeoutMs: 20,
      onBridgeUnavailable: (info) => unavailable.push(info),
    });
    await act(async () => { await wait(70); });
    expect(timedOut.banner()).toBeNull();
    expect(unavailable.map((info) => info.kind)).toEqual(['version-mismatch', 'timeout']);
  });

  test("bridgeErrorDisplay='banner' is the default and renders the strip as before", async () => {
    captureWarnings();
    const explicit = await mount({ bridgeScriptUrl: ASSET_URL, bridgeErrorDisplay: 'banner' });
    await explicit.postReady({ type: 'plannotator-bridge-ready' });
    expect(explicit.banner()?.getAttribute('data-bridge-error')).toBe('version-mismatch');

    const implicit = await mount({ bridgeScriptUrl: ASSET_URL });
    await implicit.postReady({ type: 'plannotator-bridge-ready' });
    expect(implicit.banner()?.getAttribute('data-bridge-error')).toBe('version-mismatch');
  });

  test('inline path: no timer, no banner, no callback; a stamp-less ready only warns', async () => {
    const warnings = captureWarnings();
    const unavailable: BridgeUnavailableInfo[] = [];
    const { postReady, banner, postedToIframe } = await mount({
      // A tiny timeout that would fire if the inline path ever armed a timer.
      bridgeReadyTimeoutMs: 10,
      onBridgeUnavailable: (info) => unavailable.push(info),
    });
    await act(async () => { await wait(50); });
    expect(banner()).toBeNull();
    expect(unavailable).toEqual([]);

    await postReady({ type: 'plannotator-bridge-ready' });
    expect(warnings.length).toBe(1);
    expect(warnings[0]).not.toContain(ASSET_URL);
    expect(banner()).toBeNull();
    expect(unavailable).toEqual([]);
    expect(postedToIframe.some((m) => m.type === 'plannotator-bridge-sync-annotations')).toBe(true);
  });
});
