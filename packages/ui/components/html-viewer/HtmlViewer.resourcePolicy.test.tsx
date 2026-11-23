import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { HtmlViewerProps } from './HtmlViewer';
import { NO_NETWORK_CSP_META, SELF_CONTAINED_CSP } from './srcdoc';

const hasDom = typeof document !== 'undefined';
const viewer = hasDom ? await import('./HtmlViewer') : null;
const roots: Array<ReturnType<typeof createRoot>> = [];
const rawHtml = '<!doctype html><html><head><title>Policy</title></head><body><p>Target</p></body></html>';

afterEach(async () => {
  if (!hasDom) return;
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  document.body.replaceChildren();
});

function mount() {
  if (!viewer) throw new Error('DOM test environment is not registered');
  const { HtmlViewer } = viewer;
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  return {
    host,
    async render(props: Partial<HtmlViewerProps> = {}) {
      await act(async () => root.render(<HtmlViewer rawHtml={rawHtml} annotations={[]}
        onAddAnnotation={() => {}} onSelectAnnotation={() => {}} selectedAnnotationId={null}
        mode="selection" inputMethod="pinpoint" {...props} />));
      return host.querySelector('iframe')!;
    },
  };
}

describe.if(hasDom)('HtmlViewer resourcePolicy', () => {
  const conflicts: Partial<HtmlViewerProps>[] = [
    { src: '' }, { liveSession: { origin: 'http://localhost', token: 'test' } },
    { liveSandbox: '' }, { bridgeScriptUrl: '' }, { frameUrl: async () => null },
    { hostNavigates: true }, { sandbox: 'allow-scripts allow-same-origin' }, { sandbox: '' },
  ];
  for (const conflict of conflicts) {
    test(`rejects ${Object.keys(conflict)[0]}=${String(Object.values(conflict)[0])} without mounting an iframe`, async () => {
      const mounted = mount();
      await expect(mounted.render({ resourcePolicy: 'self-contained', ...conflict }))
        .rejects.toThrow(Object.keys(conflict)[0]);
      expect(mounted.host.querySelector('iframe')).toBeNull();
    });
  }
  test('forces the restricted sandbox and puts the host CSP before author markup', async () => {
    const { render } = mount();
    const frame = await render({ resourcePolicy: 'self-contained' });
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.srcdoc.startsWith(`<!doctype html><meta http-equiv="Content-Security-Policy" content="${SELF_CONTAINED_CSP}"><script>`)).toBe(true);
    expect((await render({ resourcePolicy: 'self-contained', sandbox: 'allow-scripts', hostNavigates: false })))
      .toBe(frame);
  });
  test('policy changes replace the frame in both directions, while unchanged policies keep it', async () => {
    const { render } = mount();
    const original = await render();
    const originalDocument = original.srcdoc;
    expect(await render()).toBe(original);
    expect(original.srcdoc).toBe(originalDocument);
    const restricted = await render({ resourcePolicy: 'self-contained' });
    expect(restricted).not.toBe(original);
    expect(restricted.getAttribute('sandbox')).toBe('allow-scripts');
    const restored = await render();
    expect(restored).not.toBe(restricted);
    expect(restored.srcdoc).not.toContain('Content-Security-Policy');
    expect(restored.getAttribute('sandbox')).toBe('allow-scripts allow-modals');
  });
  test('the server marker still restricts connections when the host policy is off', async () => {
    const { render } = mount();
    const marked = rawHtml.replace('<head>', '<head><meta name="plannotator-network" content="none">');
    const restricted = await render({ rawHtml: marked, resourcePolicy: 'self-contained' });
    expect(restricted.srcdoc).toContain(SELF_CONTAINED_CSP);
    expect(restricted.srcdoc).not.toContain(NO_NETWORK_CSP_META);
    const frame = await render({ rawHtml: marked });
    expect(frame.srcdoc.startsWith(`<!doctype html>${NO_NETWORK_CSP_META}`)).toBe(true);
    expect(frame.srcdoc).not.toContain(SELF_CONTAINED_CSP);
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-modals');
  });
});
