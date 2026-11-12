import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAttachmentState, InboxInlineImage, InboxMessageWire } from '@plannotator/core/inbox-types';
import { resetImageSrcResolver, setImageSrcResolver } from '@plannotator/ui/components/ImageThumbnail';
import { inboxImageSrcResolver } from './images';
import { attachmentSequence, type AttachmentStep } from './stepping';
import { optionOf, optionSetAddress, optionSetId, optionSetOf, parseOptionSetId } from './optionSets';

const hasDom = typeof document !== 'undefined';
const { MessageBody } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');
const { AttachmentPane } = (hasDom ? await import('./components/AttachmentPane') : {}) as typeof import('./components/AttachmentPane');

let root: Root | null = null;
let host: HTMLElement | null = null;
const realFetch = globalThis.fetch;

const GIF = Uint8Array.from(atob('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw=='), (c) => c.charCodeAt(0));
let images: ReturnType<typeof Bun.serve> | null = null;
let savedUrl = '';
beforeAll(() => {
  if (!hasDom) return;
  images = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(GIF, { headers: { 'Content-Type': 'image/gif' } }) });
  savedUrl = window.location.href;
  (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(`http://127.0.0.1:${images.port}/`);
});
afterAll(() => {
  if (!hasDom) return;
  if (savedUrl) (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(savedUrl);
  images?.stop(true);
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = realFetch;
  resetImageSrcResolver();
  for (const stray of document.querySelectorAll('.pn-inbox')) stray.remove();
});

const ID = 'msg_01K7SHAREDSHAREDSHAREDSHAR';
const KEY = 'q-5a1e0001';

function captured(id: string, ref: string): InboxInlineImage {
  return {
    id,
    ref,
    path: `/work/shop/${ref}`,
    named_path: null,
    name: ref.split('/').pop()!,
    kind: 'image',
    sent_sha256: 'a'.repeat(64),
    size: 10,
    sent_at: '2026-10-15T11:22:00.000Z',
    sent_mtime: '2026-10-15T11:20:00.000Z',
    media_type: 'image/png',
  };
}
const STRIP = captured('att_01K7STRIPSTRIPSTRIPSTRIPST', 'shots/strip.png');
const BAR = captured('att_01K7BARBARBARBARBARBARBARB', 'shots/bar.png');

const BODY = [
  'Which variant?',
  '',
  ':::question',
  'Which variant should ship?',
  '',
  '- [ ] A · Strip left — ![Strip](shots/strip.png) aligned left',
  '- [ ] B · Strip right — ![Strip](shots/strip.png) aligned right',
  '- [ ] C · Bar — ![Bar](shots/bar.png) a bar beside the word',
  ':::',
].join('\n');

const choice = (label: string, src: string) => ({ label, description: null, recommended: false, settled: false, image: { alt: label, src } });
const QUESTION = { key: KEY, prompt: 'Which variant should ship?', choices: [choice('A · Strip left', STRIP.ref), choice('B · Strip right', STRIP.ref), choice('C · Bar', BAR.ref)] };

const MESSAGE = {
  id: ID,
  project_id: 'prj_01K7PPPPPPPPPPPPPPPPPPPPPP',
  thread_id: ID,
  reply_to: null,
  author: { kind: 'agent', host: 'claude-code', session: 'ses_a', name: 'Claude' },
  subject: 'Variants',
  body: BODY,
  created_at: '2026-10-15T11:22:00.000Z',
  resolved_at: null,
  idempotency_key: null,
  inline_images: [STRIP, BAR],
  questions: [QUESTION],
} as unknown as InboxMessageWire;

const FILES = [STRIP, BAR].map((image) => ({ ...image, message_id: ID, changed_since_sent: false, unavailable: null, current: { sha256: 'a'.repeat(64), size: 10, mtime: image.sent_mtime } }) as unknown as InboxAttachmentState);
const STEPS: AttachmentStep[] = attachmentSequence([MESSAGE], FILES).map((s) => ({ ...s, inline: true }));

test('the set has a step for each choice, the shared picture twice, and the address names the choice', () => {
  const set = optionSetOf([MESSAGE], STEPS, optionSetId(ID, KEY))!;
  expect(set.steps.map((s) => s.attachment.id)).toEqual([STRIP.id, STRIP.id, BAR.id]);
  expect(set.choices.map((c) => c.letter)).toEqual(['A', 'B', 'C']);
  const address = optionSetAddress(set, 1);
  expect(parseOptionSetId(address)).toEqual({ messageId: ID, questionKey: KEY, choice: 1 });
  expect(optionSetOf([MESSAGE], STEPS, address)?.id).toBe(set.id);
  expect(optionOf(set, STRIP.id, parseOptionSetId(address)!.choice)?.choice.letter).toBe('B');
  expect(optionOf(set, STRIP.id, parseOptionSetId(optionSetId(ID, KEY))!.choice)?.choice.letter).toBe('A');
  expect(optionOf(set, BAR.id, 0)?.choice.letter).toBe('C');
});

test.skipIf(!hasDom)('the zoom on each tile hands the thread that choice, the second of two sharing a picture too', async () => {
  setImageSrcResolver(inboxImageSrcResolver);
  const opened: { key: string; image: string; choice: number }[] = [];
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <MessageBody
        message={MESSAGE}
        projectRoot="/work/shop"
        onOpenAttachment={() => {}}
        onOpenInlineImage={() => {}}
        onOpenOptionSet={(key, image, choice) => opened.push({ key, image: image.id, choice })}
        readOnly={false}
        answers={new Map()}
        onPick={() => {}}
        footerFor={() => null}
      />,
    );
  });
  const zooms = [...host.querySelectorAll<HTMLButtonElement>('[data-question-zoom]')];
  expect(zooms).toHaveLength(3);
  for (const zoom of [zooms[1]!, zooms[0]!, zooms[2]!]) await act(async () => zoom.click());
  expect(opened.map(({ image, choice }) => ({ image, choice }))).toEqual([
    { image: STRIP.id, choice: 1 },
    { image: STRIP.id, choice: 0 },
    { image: BAR.id, choice: 2 },
  ]);
  expect(new Set(opened.map((o) => o.key)).size).toBe(1);
});

function Pane({ startAt, steps }: { startAt: number; steps: { id: string; at: number | null }[] }) {
  const set = optionSetOf([MESSAGE], STEPS, optionSetId(ID, KEY))!;
  const [at, setAt] = useState(startAt);
  const noop = () => {};
  const open = FILES.find((f) => f.id === set.steps[at]!.attachment.id)!;
  return (
    <AttachmentPane
      attachment={open}
      attachments={FILES}
      records={[]}
      agent="Claude Code"
      projectName="shop"
      projectRoot="/work/shop"
      version="current"
      onVersion={noop}
      full
      onToggleFull={noop}
      focusId={null}
      readOnly={false}
      onSaved={noop}
      onRemoved={noop}
      onOpenAt={noop}
      onClose={noop}
      strip={{ picks: 0, annotations: 0, onWriteReply: noop }}
      steps={set.steps}
      allSteps={STEPS}
      optionSet={set}
      stepAt={at}
      onStep={(id, _version, next) => {
        steps.push({ id, at: next ?? null });
        if (next !== null && next !== undefined) setAt(next);
      }}
    />
  );
}

test.skipIf(!hasDom)('the viewer opens the second of two choices sharing a picture as itself, and steps A → B → C through it', async () => {
  globalThis.fetch = (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch;
  const steps: { id: string; at: number | null }[] = [];
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(<Pane startAt={1} steps={steps} />);
  });
  const caption = () => host!.querySelector<HTMLElement>('[data-option-caption]')!.getAttribute('data-option-caption');
  const arrow = (dir: 'prev' | 'next') => host!.querySelector<HTMLButtonElement>(`[data-option-step="${dir}"]`)!;
  expect(caption()).toBe('B');
  await act(async () => arrow('prev').click());
  expect(caption()).toBe('A');
  await act(async () => arrow('next').click());
  expect(caption()).toBe('B');
  await act(async () => arrow('next').click());
  expect(caption()).toBe('C');
  expect(steps).toEqual([
    { id: STRIP.id, at: 0 },
    { id: STRIP.id, at: 1 },
    { id: BAR.id, at: 2 },
  ]);
});
