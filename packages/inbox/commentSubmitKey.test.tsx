import { afterEach, beforeEach } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAnnotationRecord, InboxAttachmentState } from '@plannotator/core/inbox-types';
import { describeCommentSubmitKeys, typeInto } from '../ui/test-setup/commentSubmitKeys';

const hasDom = typeof document !== 'undefined';
const skip = !hasDom;

const { ImageAttachmentView } = (hasDom ? await import('./components/ImageAttachmentView') : {}) as typeof import('./components/ImageAttachmentView');
const { VideoAttachmentView } = (hasDom ? await import('./components/VideoAttachmentView') : {}) as typeof import('./components/VideoAttachmentView');
const { AnnotationsChip } = (hasDom ? await import('./components/AnnotationsChip') : {}) as typeof import('./components/AnnotationsChip');

let root: Root | null = null;
let host: HTMLElement | null = null;
const restores: (() => void)[] = [];

beforeEach(() => {
  if (!hasDom) return;
  // The video row pauses the film while you type; happy-dom has no media.
  const previous = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'pause');
  Object.defineProperty(HTMLMediaElement.prototype, 'pause', { configurable: true, writable: true, value: () => {} });
  restores.push(() => (previous ? Object.defineProperty(HTMLMediaElement.prototype, 'pause', previous) : undefined));
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  host = null;
  for (const restore of restores.splice(0).reverse()) restore();
  if (hasDom) document.body.replaceChildren();
});

async function render(node: React.ReactNode): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(node);
  });
  await act(async () => {});
}

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 10)));

function must<T extends Element>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`nothing matches ${selector}`);
  return el;
}

const base = {
  named_path: null,
  sent_sha256: 'a'.repeat(64),
  sent_at: '2026-10-15T10:42:00.000Z',
  sent_mtime: '2026-10-15T10:42:00.000Z',
  message_id: 'msg_01K7ZZZZZZZZZZZZZZZZZZZZZZ',
  changed_since_sent: false,
  unavailable: null,
};

const picture: InboxAttachmentState = {
  ...base,
  id: 'att_01K7IIIIIIIIIIIIIIIIIIIIII',
  name: 'checkout.png',
  path: '/work/shots/checkout.png',
  kind: 'image',
  media_type: 'image/png',
  width: 1280,
  height: 800,
  size: 80_000,
  current: { sha256: 'a'.repeat(64), size: 80_000, mtime: base.sent_mtime },
};

const film: InboxAttachmentState = {
  ...base,
  id: 'att_01K7VVVVVVVVVVVVVVVVVVVVVV',
  name: 'launch.mp4',
  path: '/work/film/launch.mp4',
  kind: 'video',
  media_type: 'video/mp4',
  duration_ms: 60_000,
  width: 1920,
  height: 1080,
  size: 1_000_000,
  current: { sha256: 'a'.repeat(64), size: 1_000_000, mtime: base.sent_mtime },
};

describeCommentSubmitKeys('Inbox image comment', async (text) => {
  let saves = 0;
  await render(
    <ImageAttachmentView
      attachment={picture}
      version="current"
      annotations={[]}
      selectedId={null}
      readOnly={false}
      onSave={async () => { saves++; return true; }}
      onError={() => {}}
    />,
  );
  const field = `textarea[aria-label="Comment on ${picture.name}"]`;
  await typeInto(must<HTMLTextAreaElement>(field), text);
  return { field: () => must(field), saves: () => saves };
}, { skip });

describeCommentSubmitKeys('Inbox video comment', async (text) => {
  let saves = 0;
  await render(
    <VideoAttachmentView
      attachment={film}
      version="current"
      annotations={[]}
      selectedId={null}
      onSelect={() => {}}
      readOnly={false}
      onSave={async () => { saves++; return true; }}
      onError={() => {}}
    />,
  );
  const field = '[data-video-composer] textarea';
  await typeInto(must<HTMLTextAreaElement>(field), text);
  await settle();
  return {
    field: () => must(field),
    // The row saves after it tries to keep the paused frame; let that finish.
    saves: () => saves,
  };
}, { skip });

const waiting: InboxAnnotationRecord = {
  id: 'ann-1',
  project_id: 'prj_x',
  thread_id: 'msg_x',
  message_id: picture.message_id,
  attachment_id: picture.id,
  path: picture.path,
  version: 'current',
  annotation: { id: 'ann-1', blockId: 'image', type: 'COMMENT', text: 'too tight', originalText: '', startOffset: 0, endOffset: 0, createdA: 1 },
  created_at: base.sent_at,
  updated_at: base.sent_at,
  removed_at: null,
  sent_reply_id: null,
};

describeCommentSubmitKeys('Inbox reply box: editing a waiting comment', async (text) => {
  let saves = 0;
  await render(
    <AnnotationsChip
      records={[waiting]}
      attachments={[picture]}
      onEdit={async () => { saves++; }}
      onRemove={async () => {}}
      onOpen={() => {}}
    />,
  );
  await act(async () => must<HTMLButtonElement>('[data-annotations-chip]').click());
  const edit = [...document.querySelectorAll<HTMLButtonElement>('[data-annotation-row] button')].find((b) => b.textContent?.trim() === 'Edit');
  await act(async () => edit!.click());
  const field = 'textarea[aria-label="Edit the comment"]';
  await typeInto(must<HTMLTextAreaElement>(field), text);
  return { field: () => must(field), saves: () => saves };
}, { skip });
