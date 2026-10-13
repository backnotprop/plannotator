/**
 * A code attachment in the window: the pane draws the file in the code review
 * engine's single-file view with line comments (a shell `#` comment never
 * becomes a heading), and the tile names the kind. The phone surface's one
 * code block stays plain text over the highlight bound, never one long
 * synchronous Shiki pass.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAttachmentState } from '@plannotator/core/inbox-types';
import { CODE_HIGHLIGHT_MAX_CHARS, codeDocumentBlocks } from './attachments';

const hasDom = typeof document !== 'undefined';
// The pane pulls in the Viewer, which reads `window` at module-eval time.
const { AttachmentPane } = (hasDom ? await import('./components/AttachmentPane') : {}) as typeof import('./components/AttachmentPane');
const { AttachmentTiles } = (hasDom ? await import('./components/AttachmentTiles') : {}) as typeof import('./components/AttachmentTiles');

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

const SCRIPT = '#!/bin/sh\n# Replay the failed webhook\ncurl -X POST http://localhost:4242/hooks\n';
const attachment: InboxAttachmentState = {
  id: 'att_01K7ZZZZZZZZZZZZZZZZZZZZZZ',
  path: '/work/api/scripts/replay.sh',
  named_path: null,
  name: 'replay.sh',
  kind: 'code',
  sent_sha256: 'a'.repeat(64),
  size: SCRIPT.length,
  sent_at: '2026-10-10T10:00:00.000Z',
  sent_mtime: '2026-10-10T10:00:00.000Z',
  message_id: 'msg_01K7ZZZZZZZZZZZZZZZZZZZZZZ',
  current: { sha256: 'a'.repeat(64), size: SCRIPT.length, mtime: '2026-10-10T10:00:00.000Z' },
  changed_since_sent: false,
  unavailable: null,
};

async function render(node: React.ReactNode) {
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(node);
  });
}

async function openPane(text: string, file: InboxAttachmentState = attachment) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ serverSession: 's', attachment: file, version: 'current', text, html: null }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch;
  const noop = () => {};
  await render(
    <AttachmentPane
      attachment={file}
      attachments={[file]}
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
      strip={{ picks: 0, annotations: 0, onBack: noop, onWriteReply: noop }}
    />,
  );
  await act(async () => {
    for (let i = 0; i < 200 && !host!.querySelector('[data-code-view] diffs-container'); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

test.skipIf(!hasDom)('the pane draws a script in the code view (Pierre), with line comments offered and no document toolstrip', async () => {
  await openPane(SCRIPT);
  const view = host!.querySelector('[data-code-view]');
  expect(view).not.toBeNull();
  // The code review engine's single-file view, never the markdown pipeline (a `#` comment is not a heading).
  expect(view!.querySelector('diffs-container')).not.toBeNull();
  expect(host!.querySelector('.ib-docscroll')).toBeNull();
  expect(host!.querySelector('.ib-toolstrip')).toBeNull();
  expect(view!.textContent).toContain('Click a line number');
});

test('a code file over the highlight bound is one block with no language (plain text, no Shiki pass)', () => {
  const small = codeDocumentBlocks('const a = 1;\n', 'app.ts');
  expect(small[0]!.language).toBe('ts');
  const large = codeDocumentBlocks('x'.repeat(CODE_HIGHLIGHT_MAX_CHARS + 1), 'bundle.min.js');
  expect(large).toHaveLength(1);
  expect(large[0]!.language).toBeUndefined();
});

test.skipIf(!hasDom)('the tile names the kind of a code attachment', async () => {
  await render(<AttachmentTiles attachments={[attachment]} annotationCounts={new Map()} onOpen={() => {}} />);
  expect(host!.querySelector(`[data-attachment-id="${attachment.id}"]`)?.textContent).toContain('Code (.sh)');
});
