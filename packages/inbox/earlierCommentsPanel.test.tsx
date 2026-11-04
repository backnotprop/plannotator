/**
 * The earlier comments panel in the real pane, opened through the entry seam (`earlierEntry`, a stand-in
 * button here: what opens it is not decided). What would regress: anything drawn for a file with no earlier
 * comments, Escape leaving full screen or closing the file while the panel is open, focus taken on open, the
 * panel staying through Hide tools or a step to another file, or a phone getting the desktop panel.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { useState } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { attachmentSequence, type AttachmentStep } from './stepping';
import type { InboxAnnotationRecord, InboxAttachmentState, InboxMessageWire } from '@plannotator/core/inbox-types';
import type { EarlierEntryProps } from './components/EarlierComments';

const hasDom = typeof document !== 'undefined';
const { AttachmentPane } = (hasDom ? await import('./components/AttachmentPane') : {}) as typeof import('./components/AttachmentPane');

let root: Root | null = null;
let host: HTMLElement | null = null;
const realFetch = globalThis.fetch;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = realFetch;
});

const M1 = 'msg_01K7M1MMMMMMMMMMMMMMMMMMMM';

function file(id: string, name: string): InboxAttachmentState {
  return {
    id,
    name,
    path: `/work/shop/${name}`,
    kind: 'markdown',
    named_path: null,
    sent_sha256: 'a'.repeat(64),
    size: 1000,
    sent_at: '2026-10-10T10:42:00.000Z',
    sent_mtime: '2026-10-10T10:42:00.000Z',
    message_id: M1,
    changed_since_sent: false,
    unavailable: null,
    current: { sha256: 'a'.repeat(64), size: 1000, mtime: '2026-10-10T10:42:00.000Z' },
  } as InboxAttachmentState;
}

const notes = file('att_01K7AAAAAAAAAAAAAAAAAAAAAA', 'notes.md');
const other = file('att_01K7BBBBBBBBBBBBBBBBBBBBBB', 'other.md');
const STEPS: AttachmentStep[] = attachmentSequence([{ id: M1, created_at: '2026-10-10T10:42:00.000Z', author: { kind: 'agent', host: 'claude-code', session: 'ses_a', name: 'Claude' } } as unknown as InboxMessageWire], [notes, other]);

/** A sent comment on notes.md, made on an older attachment of the same path. */
const EARLIER = {
  id: 'ann_old',
  attachment_id: 'att_01K7OLDOLDOLDOLDOLDOLDOLDO',
  path: notes.path,
  version: 'current',
  sent_reply_id: 'msg_reply',
  updated_at: '2026-10-09T10:00:00.000Z',
  annotation: { id: 'ann_old', blockId: 'block-0', startOffset: 0, endOffset: 4, type: 'COMMENT', text: 'Say why.', originalText: 'Plan', createdA: 1 },
} as unknown as InboxAnnotationRecord;

/** A stand-in for the entry point, the seam's whole contract. */
function Entry({ count, open, panelId, onToggle }: EarlierEntryProps) {
  return (
    <button type="button" data-earlier-entry="" data-count={count} aria-expanded={open} aria-controls={panelId} onClick={onToggle}>
      earlier
    </button>
  );
}

interface Harness {
  closed: number;
  toggles: number;
}

function Pane({ harness, earlier = [EARLIER], startFull = true, phone = false }: { harness: Harness; earlier?: InboxAnnotationRecord[]; startFull?: boolean; phone?: boolean }) {
  const [open, setOpen] = useState(notes);
  const [full, setFull] = useState(startFull);
  const noop = () => {};
  return (
    <AttachmentPane
      attachment={open}
      attachments={[notes, other]}
      records={[]}
      earlierRecords={earlier}
      earlierEntry={Entry}
      agent="Claude Code"
      projectName="shop"
      projectRoot="/work/shop"
      version="current"
      onVersion={noop}
      full={full || phone}
      fullLocked={phone}
      onToggleFull={() => {
        harness.toggles++;
        setFull((v) => !v);
      }}
      focusId={null}
      readOnly={false}
      onSaved={noop}
      onRemoved={noop}
      onOpenAt={noop}
      onClose={() => harness.closed++}
      strip={{ picks: 0, annotations: 0, onWriteReply: noop }}
      steps={STEPS}
      phone={phone}
      onStep={(id) => setOpen([notes, other].find((a) => a.id === id)!)}
    />
  );
}

async function settle(ms = 60) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function render(node: React.ReactNode) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const att = [notes, other].find((a) => String(input).includes(a.id));
    if (att && String(input).includes('/view')) return new Response(JSON.stringify({ attachment: att, version: 'current', text: '# Plan\n\nShip it.\n', html: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(node);
  });
  await settle();
}

const entry = () => host!.querySelector<HTMLButtonElement>('[data-earlier-entry]');
const panel = () => host!.querySelector<HTMLElement>('[data-earlier-panel]');
const panelOpen = () => panel()?.hasAttribute('data-visible') ?? false;
const click = async (el: HTMLElement | null) => {
  await act(async () => el!.click());
  await settle();
};
const escape = async (target: EventTarget = document.body) => {
  await act(async () => void target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  await settle();
};

test.skipIf(!hasDom)('a file with no earlier comments draws neither the entry nor the panel', async () => {
  await render(<Pane harness={{ closed: 0, toggles: 0 }} earlier={[]} />);
  expect(entry()).toBeNull();
  expect(panel()).toBeNull();
});

test.skipIf(!hasDom)('another file of the thread has none of this file\'s earlier comments', async () => {
  await render(<Pane harness={{ closed: 0, toggles: 0 }} earlier={[{ ...EARLIER, path: other.path }]} />);
  expect(entry()).toBeNull();
});

for (const [mode, startFull] of [['full screen', true], ['side by side', false]] as const) {
  test.skipIf(!hasDom)(`${mode}: the entry opens the panel inside the file's box without taking focus; Escape closes only the panel`, async () => {
    const harness = { closed: 0, toggles: 0 };
    await render(<Pane harness={harness} startFull={startFull} />);
    expect(entry()!.getAttribute('data-count')).toBe('1');
    expect(panel()!.closest('.ib-docarea')).not.toBeNull();
    expect(panelOpen()).toBe(false);

    entry()!.focus();
    await click(entry());
    expect(panelOpen()).toBe(true);
    expect(document.activeElement).toBe(entry());
    expect(entry()!.getAttribute('aria-expanded')).toBe('true');
    expect(panel()!.textContent).toContain('Say why.');
    expect(panel()!.textContent).toContain('on “Plan”');

    await escape(entry()!);
    expect(panelOpen()).toBe(false);
    expect(harness.closed).toBe(0);
    expect(harness.toggles).toBe(0);

    // The next Escape is the file's own again.
    await escape(entry()!);
    expect(harness.closed + harness.toggles).toBeGreaterThan(0);
  });

  test.skipIf(!hasDom)(`${mode}: × and the entry close it; × puts focus back on the entry`, async () => {
    await render(<Pane harness={{ closed: 0, toggles: 0 }} startFull={startFull} />);
    await click(entry());
    await click(entry());
    expect(panelOpen()).toBe(false);

    await click(entry());
    const close = panel()!.querySelector<HTMLButtonElement>('[data-earlier-close]')!;
    close.focus();
    await click(close);
    expect(panelOpen()).toBe(false);
    expect(document.activeElement).toBe(entry());
  });
}

test.skipIf(!hasDom)('side by side: an Escape from the thread, outside the pane, closes the panel and not the file', async () => {
  const harness = { closed: 0, toggles: 0 };
  await render(<Pane harness={harness} startFull={false} />);
  await click(entry());
  await escape(document.body);
  expect(panelOpen()).toBe(false);
  expect(harness.closed).toBe(0);
});

test.skipIf(!hasDom)('Hide tools closes the panel', async () => {
  await render(<Pane harness={{ closed: 0, toggles: 0 }} />);
  await click(entry());
  expect(panelOpen()).toBe(true);
  await click(host!.querySelector<HTMLButtonElement>('[data-full-view-hide]'));
  expect(panelOpen()).toBe(false);
});

test.skipIf(!hasDom)('a phone gets the sheet over the window, only while open: focus on its close, Escape closes it, focus back on the entry', async () => {
  const harness = { closed: 0, toggles: 0 };
  await render(<Pane harness={harness} phone />);
  expect(panel()).toBeNull();

  await click(entry());
  const sheet = panel()!;
  expect(sheet.closest('.ib-docarea')).toBeNull();
  expect(sheet.getAttribute('role')).toBe('dialog');
  expect(document.activeElement).toBe(sheet.querySelector('[data-earlier-close]'));

  await escape(document.activeElement!);
  expect(panel()).toBeNull();
  expect(harness.closed).toBe(0);
  expect(document.activeElement).toBe(entry());
});
