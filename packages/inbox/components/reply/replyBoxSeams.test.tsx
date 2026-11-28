/**
 * The reply box as a second host renders it (components/reply/ReplyBox.tsx, its seams in replyBoxSeams.ts): its own
 * words store, its own uploader, recipients as data, and nothing else. Failures this catches: two boxes on one page
 * sharing words, files or a recipient list; a list that still ticks with `maxRecipients: 1` (or picks one only when
 * unset); a microphone or a Skills button drawn for a host that passed no voice or skills, or a skill list read for
 * it; a reloaded draft's image with no preview though the host gave its address; a Send that goes while a file still
 * uploads.
 *
 * Assertions compare strings and numbers, never elements (a failed `expect(element)` can take bun down).
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act, createRef, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DraftFileUploader } from '@plannotator/core/inbox-reply-draft';
import type { InboxDraftFile, InboxUpload } from '@plannotator/core/inbox-types';
import type { ComposeFile } from '../../compose/ComposeFiles';
import type { RecipientRow } from '../../replyRecipients';
import type { ReplyText } from '../../replyText';
import type { ReplyBoxRecipients, ReplyBoxSkills } from './replyBoxSeams';

const hasDom = typeof document !== 'undefined';
const { ReplyBox } = (hasDom ? await import('./ReplyBox') : {}) as typeof import('./ReplyBox');
const { useComposeFiles } = (hasDom ? await import('../../compose/ComposeFiles') : {}) as typeof import('../../compose/ComposeFiles');
const { useReplyTextStore } = (hasDom ? await import('../../replyText') : {}) as typeof import('../../replyText');
const { setSkillCatalogTransport, resetSkillCatalogTransport, resetSkillCatalogCache } = (hasDom ? await import('@plannotator/ui/utils/skillCatalog') : {}) as typeof import('@plannotator/ui/utils/skillCatalog');

const STAMP = '2026-11-02T10:10:00.000Z';
const ROWS: RecipientRow[] = [
  { session: 'ses_harbor', host: 'claude-code', label: 'harbor', short: 'harbor', state: 'live' },
  { session: 'ses_fern', host: 'pi', label: 'fern-api', short: 'fern-api', state: 'live' },
  { session: 'ses_quill', host: 'codex', label: 'quill-docs', short: 'quill-docs', state: 'live' },
];

/** A host's uploader: what it was asked to upload, each upload held until the test lets it end. */
function hostUploader(previewUrl?: (id: string) => string | null) {
  const asked: string[] = [];
  const finish: ((upload: InboxUpload) => void)[] = [];
  const uploader: DraftFileUploader = {
    upload: (file) =>
      new Promise<InboxUpload>((resolve) => {
        asked.push(file.name);
        finish.push(resolve);
      }),
    readText: async () => '',
    ...(previewUrl ? { previewUrl } : {}),
  };
  return { uploader, asked, finish };
}

interface Hosted {
  replyText: ReplyText;
  files: ReturnType<typeof useComposeFiles>;
  sent: number;
  held: number;
  to: (readonly string[])[];
}

/** A second host's box: its own store, uploader and recipients; voice and skills only when given. */
function Host({ threadId, uploader, recipients, skills, out }: { threadId: string; uploader: DraftFileUploader; recipients?: { max?: number }; skills?: ReplyBoxSkills; out: { current: Hosted } }) {
  const replyText = useReplyTextStore();
  const files = useComposeFiles([], { uploader });
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState<readonly string[]>(['ses_harbor']);
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const hosted = useRef<Hosted>({ replyText, files, sent: 0, held: 0, to: [] });
  hosted.current.replyText = replyText;
  hosted.current.files = files;
  out.current = hosted.current;
  const box: ReplyBoxRecipients | undefined = recipients
    ? {
        rows: ROWS,
        chosen: ROWS.filter((row) => to.includes(row.session)),
        open,
        onOpen: setOpen,
        onChange: (next) => {
          hosted.current.to.push(next);
          setTo(next);
        },
        maxRecipients: recipients.max,
      }
    : undefined;
  return (
    <div className="pn-inbox" data-host={threadId}>
      <ReplyBox
        phone={false}
        threadId={threadId}
        offerShown={false}
        onRestoreDraft={() => {}}
        conflict={null}
        takeBack={null}
        onJump={() => {}}
        draftStamp={null}
        draftAboveRef={createRef<HTMLDivElement>()}
        draftNotSaved={false}
        dropOver={false}
        dropHandlers={{} as never}
        onPaste={() => {}}
        onClose={() => {}}
        quote={null}
        quotedMessage={undefined}
        onRemoveQuote={() => {}}
        scrollRef={createRef<HTMLDivElement>()}
        replyText={replyText}
        sendingWords={false}
        textRef={textRef}
        replyToNames="harbor"
        placeholder="Write to harbor"
        askerNoteId={null}
        recipients={box}
        skills={skills}
        tags={undefined}
        onChange={(text) => replyText.set(text)}
        onFieldKeyDown={() => {}}
        files={files.files as readonly ComposeFile[]}
        onRemoveFile={files.remove}
        onPutBackFile={() => {}}
        onAttachFiles={(list) => files.add(list)}
        onShowFiles={() => {}}
        draftAnswers={[]}
        draftActions={[]}
        replySkip={{ count: 0, keepOpen: false, onToggle: () => {} }}
        dropped={0}
        comments={null}
        replySummaryShown={false}
        chips={null}
        fold={false}
        onFold={() => {}}
        fitKey=""
        routeChoiceOpen={false}
        routeChoice={null}
        sending={false}
        sendRef={createRef<HTMLButtonElement>()}
        sendAria={undefined}
        onSend={() => (hosted.current.sent += 1)}
        onSendWhileUploading={() => (hosted.current.held += 1)}
        onDiscardDraft={() => {}}
        errorLine={null}
      />
    </div>
  );
}

let roots: { root: Root; el: HTMLElement }[] = [];
let catalogReads = 0;

beforeEach(() => {
  if (!hasDom) return;
  catalogReads = 0;
  resetSkillCatalogCache();
  setSkillCatalogTransport(async () => {
    catalogReads += 1;
    return [{ name: 'write-better', root: 'universal', description: 'Write it better.', humanOnly: false }];
  });
});

afterEach(() => {
  if (!hasDom) return;
  for (const { root, el } of roots) {
    act(() => root.unmount());
    el.remove();
  }
  roots = [];
  resetSkillCatalogTransport();
  resetSkillCatalogCache();
});

async function settle(turns = 3) {
  for (let i = 0; i < turns; i += 1) await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 15))));
}

function mount(node: React.ReactNode): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => root.render(node));
  roots.push({ root, el });
  return el;
}

function typeIn(el: HTMLElement, words: string) {
  const text = el.querySelector<HTMLTextAreaElement>('.ib-rbox textarea')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    text.focus();
    setter.call(text, words);
    text.setSelectionRange(words.length, words.length);
    text.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const holder = (): { current: Hosted } => ({ current: null as unknown as Hosted });
const notes = (name: string) => new File(['the notes'], name, { type: 'text/plain' });

test.skipIf(!hasDom)('two boxes on one page share no words, files or recipient list', async () => {
  const a = holder();
  const b = holder();
  const upA = hostUploader();
  const upB = hostUploader();
  const el = mount(
    <>
      <Host threadId="thr_harbor" uploader={upA.uploader} recipients={{}} out={a} />
      <Host threadId="thr_ledger" uploader={upB.uploader} recipients={{}} out={b} />
    </>,
  );
  await settle();
  const [boxA, boxB] = [...el.querySelectorAll<HTMLElement>('[data-host]')];
  typeIn(boxA!, 'Ship it on Friday.');
  await settle();
  expect(a.current.replyText.get()).toBe('Ship it on Friday.');
  expect(b.current.replyText.get()).toBe('');
  expect(boxB!.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('');
  act(() => void a.current.files.add([notes('notes.txt')]));
  await settle();
  expect(upA.asked).toEqual(['notes.txt']);
  expect(upB.asked).toEqual([]);
  expect(boxA!.querySelector('[data-reply-files]') !== null).toBe(true);
  expect(boxB!.querySelector('[data-reply-files]') === null).toBe(true);
  // A's list opens in A's root only.
  act(() => boxA!.querySelector<HTMLButtonElement>('[data-recipient]')!.click());
  await settle();
  expect(boxA!.querySelectorAll('[data-recipient-list]').length).toBe(1);
  expect(boxB!.querySelectorAll('[data-recipient-list]').length).toBe(0);
  upA.finish[0]!({ upload_id: 'upl_01', name: 'notes.txt', size: 9, kind: 'text', sha256: 'a'.repeat(64), created_at: STAMP });
  await settle();
});

test.skipIf(!hasDom)('recipients unset: the list ticks a second agent in, and says who gets it as a list', async () => {
  const a = holder();
  const el = mount(<Host threadId="thr_harbor" uploader={hostUploader().uploader} recipients={{}} out={a} />);
  await settle();
  act(() => el.querySelector<HTMLButtonElement>('[data-recipient]')!.click());
  await settle();
  expect(el.querySelectorAll('[data-recipient-tick]').length).toBe(3);
  act(() => el.querySelector<HTMLButtonElement>('[data-recipient-tick="ses_fern"]')!.click());
  await settle();
  expect(a.current.to.map((to) => to.join(' '))).toEqual(['ses_harbor ses_fern']);
  // A name pressed sends to it alone and closes the list.
  act(() => [...el.querySelectorAll<HTMLButtonElement>('.ib-rpick-name')].find((name) => name.textContent?.includes('quill-docs'))!.click());
  await settle();
  expect(a.current.to.map((to) => to.join(' '))).toEqual(['ses_harbor ses_fern', 'ses_quill']);
  expect(el.querySelectorAll('[data-recipient-list]').length).toBe(0);
});

test.skipIf(!hasDom)('maxRecipients: 1 makes the list pick one: no ticks, a row pressed is the one', async () => {
  const a = holder();
  const el = mount(<Host threadId="thr_harbor" uploader={hostUploader().uploader} recipients={{ max: 1 }} out={a} />);
  await settle();
  act(() => el.querySelector<HTMLButtonElement>('[data-recipient]')!.click());
  await settle();
  expect(el.querySelectorAll('[data-recipient-row]').length).toBe(3);
  expect(el.querySelectorAll('[data-recipient-tick]').length).toBe(0);
  act(() => [...el.querySelectorAll<HTMLButtonElement>('.ib-rpick-name')].find((name) => name.textContent?.includes('fern-api'))!.click());
  await settle();
  expect(a.current.to.map((to) => to.join(' '))).toEqual(['ses_fern']);
});

test.skipIf(!hasDom)('maxRecipients: 2 stops the ticks at two', async () => {
  const a = holder();
  const el = mount(<Host threadId="thr_harbor" uploader={hostUploader().uploader} recipients={{ max: 2 }} out={a} />);
  await settle();
  act(() => el.querySelector<HTMLButtonElement>('[data-recipient]')!.click());
  await settle();
  act(() => el.querySelector<HTMLButtonElement>('[data-recipient-tick="ses_fern"]')!.click());
  await settle();
  expect(el.querySelector<HTMLButtonElement>('[data-recipient-tick="ses_quill"]')!.disabled).toBe(true);
  expect(el.querySelector<HTMLButtonElement>('[data-recipient-tick="ses_harbor"]')!.disabled).toBe(false);
});

test.skipIf(!hasDom)('no voice and no skills: no microphone, no Skills button, no skill list read', async () => {
  const el = mount(<Host threadId="thr_harbor" uploader={hostUploader().uploader} out={holder()} />);
  await settle();
  expect(el.querySelector('.ib-rbox') !== null).toBe(true);
  expect(el.querySelector('[data-voice-mic]') === null).toBe(true);
  expect(el.querySelector('[data-reply-skills]') === null).toBe(true);
  expect(el.querySelector<HTMLTextAreaElement>('textarea')!.placeholder).toBe('Write to harbor');
  typeIn(el, '/wri');
  await settle();
  expect(catalogReads).toBe(0);
  expect(document.querySelector('[role="listbox"]') === null).toBe(true);
});

test.skipIf(!hasDom)('skills given: the Skills button shows and the list is read', async () => {
  let opened = 0;
  const el = mount(<Host threadId="thr_harbor" uploader={hostUploader().uploader} skills={{ onOpen: () => (opened += 1), noneHint: false }} out={holder()} />);
  await settle();
  act(() => el.querySelector<HTMLButtonElement>('[data-reply-skills]')!.click());
  expect(opened).toBe(1);
  expect(catalogReads > 0).toBe(true);
});

test.skipIf(!hasDom)('a reloaded draft\'s image shows the host\'s preview address, and no preview without one', async () => {
  const image: InboxDraftFile = { upload_id: 'upl_img', name: 'chart.png', size: 2048, kind: 'image', sha256: 'b'.repeat(64), created_at: STAMP };
  const a = holder();
  const b = holder();
  const el = mount(
    <>
      <Host threadId="thr_harbor" uploader={hostUploader((id) => `/spaces/files/${id}/preview`).uploader} out={a} />
      <Host threadId="thr_ledger" uploader={hostUploader().uploader} out={b} />
    </>,
  );
  await settle();
  act(() => {
    a.current.files.restoreDraft([image], '');
    b.current.files.restoreDraft([image], '');
  });
  await settle();
  const [boxA, boxB] = [...el.querySelectorAll<HTMLElement>('[data-host]')];
  expect(boxA!.querySelector<HTMLImageElement>('[data-reply-files] img')?.getAttribute('src') ?? null).toBe('/spaces/files/upl_img/preview');
  expect(boxB!.querySelector('[data-reply-files] img') === null).toBe(true);
  expect(boxB!.querySelector('[data-reply-files]') !== null).toBe(true);
});

test.skipIf(!hasDom)('Send while a file uploads does not send; once it is in, Send sends', async () => {
  const a = holder();
  const up = hostUploader();
  const el = mount(<Host threadId="thr_harbor" uploader={up.uploader} out={a} />);
  await settle();
  act(() => void a.current.files.add([notes('notes.txt')]));
  await settle();
  const send = () => act(() => el.querySelector<HTMLButtonElement>('[data-reply-send]')!.click());
  send();
  expect(a.current.sent).toBe(0);
  expect(a.current.held).toBe(1);
  up.finish[0]!({ upload_id: 'upl_01', name: 'notes.txt', size: 9, kind: 'text', sha256: 'a'.repeat(64), created_at: STAMP });
  await settle();
  send();
  expect(a.current.sent).toBe(1);
  expect(a.current.held).toBe(1);
});
