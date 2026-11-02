/**
 * Relative links in an attached Markdown file (#2230) must not cost the
 * document its state: the pane's link resolver is stable across renders, so
 * ui's HtmlBlock does not redraw a raw HTML block on every pane render (its
 * nodes, and any state the person gave them, would be replaced). Checked for
 * the attached file and for a linked document drawn over it.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeAll, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAttachmentState } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
// The pane pulls in the Viewer, which reads `window` at module-eval time.
const { AttachmentPane } = (hasDom ? await import('./components/AttachmentPane') : {}) as typeof import('./components/AttachmentPane');

let root: Root | null = null;
let host: HTMLElement | null = null;
const realFetch = globalThis.fetch;

beforeAll(() => {
  if (hasDom) (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL('http://localhost:4000/');
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = realFetch;
});

const GUIDE = '# Guide\n\n[Peer notes](peer.md)\n\n<details><summary>Attached details</summary>Inside the guide.</details>\n';
const PEER = '# Peer notes\n\n[Back](guide.md)\n\n<details><summary>Linked details</summary>Inside the peer.</details>\n';

const attachment: InboxAttachmentState = {
  id: 'att_01K7ZZZZZZZZZZZZZZZZZZZZZZ',
  path: '/work/api/docs/guide.md',
  named_path: null,
  name: 'guide.md',
  kind: 'markdown',
  sent_sha256: 'a'.repeat(64),
  size: GUIDE.length,
  sent_at: '2026-10-10T10:00:00.000Z',
  sent_mtime: '2026-10-10T10:00:00.000Z',
  message_id: 'msg_01K7ZZZZZZZZZZZZZZZZZZZZZZ',
  current: { sha256: 'a'.repeat(64), size: GUIDE.length, mtime: '2026-10-10T10:00:00.000Z' },
  changed_since_sent: false,
  unavailable: null,
};

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

/** Draw the pane (`linked`: the linked document the route names), or draw it again with fresh props. */
async function renderPane(linked: string | null, round: number): Promise<void> {
  const noop = () => {};
  await act(async () => {
    root!.render(
      <AttachmentPane
        attachment={attachment}
        attachments={[attachment]}
        records={[]}
        agent="Claude Code"
        projectName="api"
        projectRoot="/work/api"
        version="current"
        onVersion={noop}
        full={false}
        onToggleFull={noop}
        focusId={null}
        readOnly={false}
        onSaved={noop}
        onRemoved={noop}
        onOpenAt={noop}
        onClose={noop}
        linked={linked}
        onLinked={noop}
        // A new object each render, as the thread passes it.
        strip={{ picks: round, annotations: 0, onWriteReply: noop }}
      />,
    );
  });
}

async function waitFor(found: () => Element | null | undefined): Promise<Element> {
  await act(async () => {
    for (let i = 0; i < 200 && !found(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  });
  const el = found();
  expect(el).toBeTruthy();
  return el!;
}

async function mount(linked: string | null) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/linked-page')) {
      return json({ serverSession: 's', path: '/work/api/docs/peer.md', name: 'peer.md', html: null, text: PEER, url: null });
    }
    return json({ serverSession: 's', attachment, version: 'current', text: GUIDE, html: null });
  }) as unknown as typeof fetch;
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  root = createRoot(host);
  await renderPane(linked, 0);
}

for (const where of ['attached', 'linked'] as const) {
  test.skipIf(!hasDom)(`a raw HTML block in the ${where} document keeps its nodes when the pane renders again`, async () => {
    await mount(where === 'linked' ? 'peer.md' : null);
    const scope = where === 'linked' ? '.ib-linkeddoc' : '.ib-docscroll:not(.ib-linkeddoc)';
    // A node of the raw HTML block, marked: a redraw replaces it (and with it any state the person gave it).
    const node = (await waitFor(() => host!.querySelector(`${scope} [data-block-type="html"] summary`))) as HTMLElement;
    expect(node.textContent).toBe(where === 'linked' ? 'Linked details' : 'Attached details');
    node.dataset.marked = 'yes';
    for (let round = 1; round <= 3; round++) await renderPane(where === 'linked' ? 'peer.md' : null, round);
    expect(node.isConnected).toBe(true);
    expect(host!.querySelector(`${scope} [data-block-type="html"] [data-marked="yes"]`)).toBe(node);
  });
}
