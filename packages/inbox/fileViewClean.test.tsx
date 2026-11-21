/**
 * An attached markdown file is always drawn in the Clean look: the document on
 * the card colour, never plan review's grid paper, whatever plan review's
 * `gridEnabled` setting says (owner, 2026-10-22).
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAttachmentState } from '@plannotator/core/inbox-types';
import { resetImageSrcResolver, setImageSrcResolver } from '@plannotator/ui/components/ImageThumbnail';
import { inboxImageSrcResolver } from './images';

const hasDom = typeof document !== 'undefined';
// The pane pulls in the Viewer, which reads `window` at module-eval time.
const { AttachmentPane } = (hasDom ? await import('./components/AttachmentPane') : {}) as typeof import('./components/AttachmentPane');

let root: Root | null = null;
let host: HTMLElement | null = null;
const realFetch = globalThis.fetch;
const GRID_COOKIE = 'plannotator-grid-enabled';

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = realFetch;
  resetImageSrcResolver();
  if (hasDom) document.cookie = `${GRID_COOKIE}=; path=/; max-age=0`;
});

const PLAN = '# Retry worker\n\nRetry the failed webhooks one by one.\n';
const attachment: InboxAttachmentState = {
  id: 'att_01K7ZZZZZZZZZZZZZZZZZZZZZZ',
  path: '/work/api/retry-plan.md',
  named_path: null,
  name: 'retry-plan.md',
  kind: 'markdown',
  sent_sha256: 'a'.repeat(64),
  size: PLAN.length,
  sent_at: '2026-10-10T10:00:00.000Z',
  sent_mtime: '2026-10-10T10:00:00.000Z',
  message_id: 'msg_01K7ZZZZZZZZZZZZZZZZZZZZZZ',
  current: { sha256: 'a'.repeat(64), size: PLAN.length, mtime: '2026-10-10T10:00:00.000Z' },
  changed_since_sent: false,
  unavailable: null,
};

/** The pane for one attachment whose view route answers `text`, once its document has drawn. */
async function renderPane(shown: InboxAttachmentState, text: string): Promise<void> {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ serverSession: 's', attachment: shown, version: shown.unavailable ? 'sent' : 'current', text, html: null }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch;
  const noop = () => {};
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <AttachmentPane
        attachment={shown}
        attachments={[shown]}
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
        strip={{ picks: 0, annotations: 0, onWriteReply: noop }}
      />,
    );
  });
  await act(async () => {
    for (let i = 0; i < 200 && !host!.querySelector('.ib-docscroll article')?.textContent?.includes('Retry worker'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  });
}

test.skipIf(!hasDom)('an attached markdown file renders Clean even with Grid chosen in plan review', async () => {
  // The cookie plan review's Settings writes for "Grid".
  document.cookie = `${GRID_COOKIE}=true; path=/`;
  await renderPane(attachment, PLAN);
  const scroll = host!.querySelector('.ib-docscroll');
  expect(scroll).not.toBeNull();
  expect(scroll!.getAttribute('data-look')).toBe('clean');
  expect(scroll!.classList.contains('bg-card')).toBe(true);
  expect(scroll!.classList.contains('bg-grid')).toBe(false);
  // Viewer's Clean article: no grid card (shadow and border) around the document.
  const article = scroll!.querySelector('article');
  expect(article?.textContent).toContain('Retry worker');
  expect(article!.classList.contains('shadow-xl')).toBe(false);
});

test.skipIf(!hasDom)('an image in the file loads from its attachment route, for the version on screen (#2228)', async () => {
  setImageSrcResolver(inboxImageSrcResolver);
  // The file is gone from disk, so the sent version opens, and its images ask for that version.
  await renderPane({ ...attachment, current: null, unavailable: { code: 'attachment_missing', message: 'gone' } }, `${PLAN}\n![the admin view](shots/admin.png)\n`);
  const src = host!.querySelector('.ib-docscroll img[data-image-src="shots/admin.png"]')?.getAttribute('src');
  expect(src).toBe(`/api/inbox/attachments/${attachment.id}/markdown-image?path=shots%2Fadmin.png&version=sent`);
});
