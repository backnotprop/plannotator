import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAttachmentState, InboxDraftFile, InboxReplyDraft, InboxUpload } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { GlobalCommentComposer } = (hasDom ? await import('./components/GlobalCommentComposer') : {}) as typeof import('./components/GlobalCommentComposer');
const { AttachmentPane } = (hasDom ? await import('./components/AttachmentPane') : {}) as typeof import('./components/AttachmentPane');
const { dispatchInboxFrame } = (hasDom ? await import('./api') : {}) as typeof import('./api');
const { adoptVoiceSettings, browserDeps } = (hasDom ? await import('./voice') : {}) as typeof import('./voice');
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedXhr: typeof XMLHttpRequest;
let drafts: Map<string, InboxReplyDraft>;
let uploads: Map<string, InboxUpload>;
let submitted: { text: string; files: unknown }[];
let revision = 0;
let number = 0;
let messageId: string;
let refuseUpload = false;
let refuseSave = false;
let closed = 0;
let pendingUpload: (() => void) | null = null;
let holdUpload = false;
let holdSave = false;
let pendingSave: (() => void) | null = null;

class Upload {
  status = 0;
  responseText = '';
  upload: { onprogress: ((event: { loaded: number; total: number; lengthComputable: boolean }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  path = '';
  aborted = false;
  open(_method: string, path: string) { this.path = path; }
  setRequestHeader() {}
  abort() { this.aborted = true; this.onabort?.(); }
  send(file: File) {
    const finish = () => {
      if (this.aborted) return;
      this.status = refuseUpload ? 413 : 200;
      const upload: InboxUpload = { upload_id: `upl_${++revision}`, name: new URL(this.path, 'http://local').searchParams.get('name')!, size: file.size, kind: 'file', sha256: 'a'.repeat(64), created_at: new Date().toISOString() };
      uploads.set(upload.upload_id, upload);
      this.responseText = JSON.stringify(refuseUpload ? { code: 'too_large', error: 'Not attached: the file is too large.' } : { upload });
      this.upload.onprogress?.({ loaded: file.size, total: file.size, lengthComputable: true });
      this.onload?.();
    };
    if (holdUpload) pendingUpload = finish;
    else queueMicrotask(finish);
  }
}

beforeEach(() => {
  if (!hasDom) return;
  messageId = `message_${++number}`;
  drafts = new Map(); uploads = new Map(); submitted = []; closed = 0;
  refuseUpload = false; refuseSave = false; holdUpload = false; pendingUpload = null;
  holdSave = false; pendingSave = null;
  savedFetch = globalThis.fetch;
  savedXhr = globalThis.XMLHttpRequest;
  globalThis.XMLHttpRequest = Upload as unknown as typeof XMLHttpRequest;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.includes('/comment-draft')) {
      const key = path.replace('/delete', '');
      const current = drafts.get(key) ?? null;
      if (init?.method !== 'POST') return Response.json({ draft: current });
      const body = JSON.parse(String(init.body));
      if (path.includes('/delete')) {
        if (body.base === undefined || body.base === current?.updated_at) drafts.delete(key);
        return Response.json({ deleted: true });
      }
      if ((current?.updated_at ?? null) !== body.base && body.base_body !== current?.body) return Response.json({ code: 'draft_conflict' }, { status: 409 });
      const files = new Map((current?.files ?? []).map((file) => [file.upload_id, file]));
      for (const id of body.files_remove ?? []) files.delete(id);
      for (const file of body.files_add ?? []) {
        const upload = uploads.get(file.upload_id);
        if (upload) files.set(file.upload_id, { ...upload, ...(file.pasted ? { pasted: file.pasted } : {}) } as InboxDraftFile);
      }
      const draft: InboxReplyDraft = { v: 1, thread_id: 'thread', body: body.body, files: [...files.values()], created_at: current?.created_at ?? new Date().toISOString(), updated_at: new Date(Date.now() + ++revision).toISOString() };
      if (draft.body.trim() || files.size) drafts.set(key, draft);
      else drafts.delete(key);
      const response = Response.json({ draft: drafts.get(key) ?? null });
      if (holdSave) {
        holdSave = false;
        return new Promise<Response>((resolve) => { pendingSave = () => { pendingSave = null; resolve(response); }; });
      }
      return response;
    }
    if (path.includes('/skills')) return Response.json({ skills: [] });
    return Response.json({});
  }) as typeof fetch;
});
afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount()); host?.remove(); root = null; host = null;
  globalThis.fetch = savedFetch; globalThis.XMLHttpRequest = savedXhr;
  adoptVoiceSettings(null);
});
async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await act(async () => { await new Promise((done) => setTimeout(done, 10)); });
  expect(check()).toBe(true);
}
const field = () => document.querySelector<HTMLTextAreaElement>('textarea')!;
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === text);
async function type(text: string) {
  const input = field();
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set?.call(input, text);
  await act(async () => input.dispatchEvent(new Event('input', { bubbles: true })));
}
async function mount(scope = 'document', anchorEl?: HTMLElement) {
  if (!host) { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); }
  await act(async () => root!.render(<GlobalCommentComposer key={scope} messageId={messageId} scope={scope} anchorEl={anchorEl} isGlobal contextText="" initialText="" anchorRect={new DOMRect(100, 100, 50, 30)} onClose={() => { closed++; root!.render(null); }} onSubmit={(text, _images, _mentions, files) => { submitted.push({ text, files }); return !refuseSave; }} />));
  await until(() => field() != null);
  await act(async () => { await new Promise((done) => setTimeout(done, 20)); });
}
async function attach(name = 'evidence.txt') {
  const input = document.querySelector<HTMLInputElement>('[data-global-attach]')!;
  Object.defineProperty(input, 'files', { configurable: true, value: [new File(['evidence'], name)] });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
}

test.skipIf(!hasDom)('a file-only comment carries its upload; expanded mode preserves the file and draft', async () => {
  await mount();
  expect(button('Add')!.disabled).toBe(true);
  await attach();
  await until(() => !button('Add')!.disabled);
  await act(async () => document.querySelector<HTMLButtonElement>('[title="Expand"]')!.click());
  await until(() => document.querySelector('[role="dialog"]') !== null);
  expect(document.querySelector('[data-compose-file-name="evidence.txt"]')).not.toBeNull();
  await act(async () => button('Add')!.click());
  await until(() => submitted.length === 1 && drafts.size === 0);
  expect(submitted[0]).toMatchObject({ text: '', files: [{ name: 'evidence.txt' }] });
});

test.skipIf(!hasDom)('Close restores text and files; another document starts empty; Discard removes only this draft', async () => {
  await mount(); await type('keep these words'); await attach();
  await until(() => [...drafts.values()].some((draft) => draft.body === 'keep these words' && draft.files?.length === 1));
  await act(async () => document.querySelector<HTMLButtonElement>('[title="Close"]')!.click());
  expect(closed).toBe(1);
  await mount('other'); expect(field().value).toBe('');
  await type('other words');
  await until(() => drafts.size === 2);
  await mount();
  await until(() => field().value === 'keep these words');
  expect(document.querySelector('[data-compose-file-name="evidence.txt"]')).not.toBeNull();
  await act(async () => button('Discard')!.click());
  await until(() => drafts.size === 1);
  expect([...drafts.values()][0]!.body).toBe('other words');
  expect(field().value).toBe('');
});

test.skipIf(!hasDom)('failed upload blocks Add until removed; a failed Add keeps its text and completed files', async () => {
  await mount(); refuseUpload = true; await attach('too-big.txt');
  await until(() => document.querySelector('[data-compose-file="refused"]') !== null);
  await type('do not lose this'); expect(button('Add')!.disabled).toBe(true);
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Remove too-big.txt"]')!.click());
  refuseUpload = false; await attach(); await until(() => !button('Add')!.disabled);
  refuseSave = true;
  await act(async () => button('Add')!.click());
  await until(() => document.querySelector('[role="alert"]') !== null);
  expect(field().value).toBe('do not lose this');
  expect(document.querySelector('[data-compose-file-name="evidence.txt"]')).not.toBeNull();
  expect(drafts.size).toBe(1);
});

test.skipIf(!hasDom)('an upload finishing after Close joins the correct draft', async () => {
  await mount(); await type('still uploading'); holdUpload = true; await attach();
  expect(button('Add')!.disabled).toBe(true);
  await act(async () => document.querySelector<HTMLButtonElement>('[title="Close"]')!.click());
  await mount('other'); await type('other document');
  await act(async () => pendingUpload!());
  await until(() => [...drafts.values()].some((draft) => draft.body === 'still uploading' && draft.files?.length === 1));
  expect(field().value).toBe('other document');
});

test.skipIf(!hasDom)('draft events refresh an unchanged box; conflicting words stay until the person chooses', async () => {
  await mount(); await type('saved here');
  await until(() => drafts.size === 1);
  const [path, previous] = [...drafts][0]!;
  drafts.set(path, { ...previous, body: 'changed elsewhere', updated_at: new Date(Date.now() + 1000).toISOString() });
  await act(async () => dispatchInboxFrame({ id: null, name: 'drafts', data: JSON.stringify({ thread_id: 'thread' }) }, { onRecord: () => {}, onStatus: () => {} }));
  await until(() => field().value === 'changed elsewhere');
  await type('keep my words');
  drafts.set(path, { ...drafts.get(path)!, body: 'newer elsewhere', updated_at: new Date(Date.now() + 2000).toISOString() });
  await until(() => document.querySelector('[data-draft-conflict]') !== null);
  expect(field().value).toBe('keep my words');
  await act(async () => button('Keep mine')!.click());
  await until(() => drafts.get(path)?.body === 'keep my words');
});

test.skipIf(!hasDom)('Discard cancels an unfinished upload so it cannot recreate the draft', async () => {
  await mount(); await type('throw this away');
  await until(() => drafts.size === 1);
  holdUpload = true; await attach();
  await act(async () => button('Discard')!.click());
  await act(async () => pendingUpload!());
  await until(() => drafts.size === 0);
  expect(document.querySelector('[data-compose-file]')).toBeNull();
  expect(field().value).toBe('');
});

test.skipIf(!hasDom)('a pasted image and a dropped file use the reply upload path; a long paste can be put back', async () => {
  await mount();
  const image = new File(['png bytes'], 'image.png', { type: 'image/png' });
  const paste = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(paste, 'clipboardData', { value: { files: [image], items: [{ kind: 'file', type: 'image/png', getAsFile: () => image }], types: ['Files'], getData: () => '' } });
  await act(async () => field().dispatchEvent(paste));
  expect(paste.defaultPrevented).toBe(true);
  await until(() => document.querySelector('[data-compose-file-name^="pasted-image-"]') !== null);
  const dropped = new File(['notes'], 'dropped.txt');
  const drop = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(drop, 'dataTransfer', { value: { files: [dropped], types: ['Files'] } });
  await act(async () => document.querySelector('.ib-rbox')!.dispatchEvent(drop));
  await until(() => document.querySelector('[data-compose-file-name="dropped.txt"]') !== null);
  const words = 'evidence line\n'.repeat(3000);
  const long = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(long, 'clipboardData', { value: { files: [], items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }], types: ['text/plain'], getData: (type: string) => type === 'text/plain' ? words : '' } });
  await act(async () => field().dispatchEvent(long));
  await until(() => document.querySelector('[data-pasted-undo]') !== null);
  await act(async () => document.querySelector<HTMLButtonElement>('[data-pasted-undo]')!.click());
  expect(field().value).toBe(words);
  expect(document.querySelector('[data-pasted-text]')).toBeNull();
});

test.skipIf(!hasDom)('voice respects settings, cancels with Escape and inserts a simulated transcript', async () => {
  await mount(); expect(document.querySelector('[data-voice-mic]')).toBeNull();
  const savedOpen = browserDeps.open;
  const savedPrompts = browserDeps.prompts;
  const savedTranscribe = browserDeps.transcribe;
  const savedSecure = Object.getOwnPropertyDescriptor(window, 'isSecureContext');
  const savedMedia = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
  const savedWorklet = Object.getOwnPropertyDescriptor(globalThis, 'AudioWorkletNode');
  try {
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({}) } });
    Object.defineProperty(globalThis, 'AudioWorkletNode', { configurable: true, value: class {} });
    browserDeps.open = () => new Promise(() => {});
    browserDeps.prompts = async () => false;
    await act(async () => adoptVoiceSettings({ on: true, phones_only: false, engine: 'codex', key: { source: null, last4: null }, computer: null, intro_due: false, guest: false }));
    await until(() => document.querySelector('[data-voice-mic]') !== null);
    const mic = document.querySelector('[data-voice-mic]')!;
    await act(async () => { mic.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, button: 0 })); mic.dispatchEvent(new window.PointerEvent('pointerup', { bubbles: true, button: 0 })); });
    await until(() => document.querySelector('[data-voice-line="opening"]') !== null);
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(closed).toBe(0);
    expect(document.querySelector('[data-voice-line="opening"]')).toBeNull();
    browserDeps.open = async () => ({ rate: 24000, db: () => -10, stop: async () => [new Float32Array(2400).fill(0.2)], abort: () => {}, onEnded: () => {} });
    browserDeps.transcribe = async () => ({ text: 'Use the smaller legend.' });
    const press = async () => act(async () => {
      mic.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, button: 0 }));
      mic.dispatchEvent(new window.PointerEvent('pointerup', { bubbles: true, button: 0 }));
    });
    await press();
    await until(() => document.querySelector('[data-voice-line="tap"]') !== null);
    await act(async () => { await new Promise((done) => setTimeout(done, 150)); });
    await press();
    await until(() => field().value === 'Use the smaller legend.');
  } finally {
    browserDeps.open = savedOpen; browserDeps.prompts = savedPrompts; browserDeps.transcribe = savedTranscribe;
    for (const [owner, name, descriptor] of [[window, 'isSecureContext', savedSecure], [navigator, 'mediaDevices', savedMedia], [globalThis, 'AudioWorkletNode', savedWorklet]] as const) {
      if (descriptor) Object.defineProperty(owner, name, descriptor); else Reflect.deleteProperty(owner, name);
    }
  }
});

test.skipIf(!hasDom)('an older save acknowledgement keeps a file queued behind it', async () => {
  await mount();
  holdSave = true;
  await attach('first.txt');
  await until(() => pendingSave !== null);
  await attach('second.txt');
  await until(() => document.querySelector('[data-compose-file-name="second.txt"]') !== null);
  await act(async () => pendingSave!());
  expect(document.querySelector('[data-compose-file-name="second.txt"]')).not.toBeNull();
  await until(() => [...drafts.values()].some((draft) => draft.files?.length === 2));
});

test.skipIf(!hasDom)('native Undo puts a long paste back after its draft save is acknowledged', async () => {
  await mount();
  const words = 'evidence line\n'.repeat(3000);
  const paste = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(paste, 'clipboardData', { value: { files: [], items: [], types: ['text/plain'], getData: (type: string) => type === 'text/plain' ? words : '' } });
  await act(async () => field().dispatchEvent(paste));
  await until(() => [...drafts.values()].some((draft) => draft.files?.length === 1));
  const undo = new Event('beforeinput', { bubbles: true, cancelable: true });
  Object.defineProperty(undo, 'inputType', { value: 'historyUndo' });
  await act(async () => field().dispatchEvent(undo));
  expect(undo.defaultPrevented).toBe(true);
  expect(field().value).toBe(words);
  expect(document.querySelector('[data-pasted-text]')).toBeNull();
});

test.skipIf(!hasDom)('Escape closes a compact comment and collapses an expanded one before returning focus', async () => {
  const opener = document.createElement('button');
  document.body.appendChild(opener);
  opener.focus();
  const escape = async () => act(async () => field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  try {
    await mount('document', opener);
    await type('Keep this draft.');
    await escape();
    await until(() => closed === 1 && document.activeElement === opener);
    await mount('document', opener);
    expect(field().value).toBe('Keep this draft.');
    await act(async () => document.querySelector<HTMLButtonElement>('[title="Expand"]')!.click());
    await until(() => document.querySelector('[role="dialog"]') !== null);
    await escape();
    expect(closed).toBe(1);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await escape();
    await until(() => closed === 2 && document.activeElement === opener);
  } finally {
    opener.remove();
  }
});


test.skipIf(!hasDom)('a missing current file shares its draft with the displayed sent version, never the restored current file', async () => {
  const attachment: InboxAttachmentState = {
    id: 'att_version_test', message_id: messageId, name: 'notes.md', path: '/work/notes.md', kind: 'markdown',
    named_path: null, size: 30, sent_sha256: 'a'.repeat(64), sent_at: '2026-11-07T10:00:00Z', sent_mtime: '2026-11-07T10:00:00Z',
    current: null, unavailable: { code: 'attachment_missing', message: 'gone' }, changed_since_sent: false,
  };
  const draftFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://local');
    if (!url.pathname.endsWith('/view')) return draftFetch(input, init);
    const sent = url.searchParams.get('version') === 'sent';
    return Response.json({ serverSession: 's', attachment, version: sent ? attachment.sent_sha256 : 'current', text: sent ? '# Sent words' : '# Current words', html: null });
  }) as typeof fetch;
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  const draw = async (version: 'current' | 'sent', missing: boolean) => {
    await act(async () => root!.render(null));
    await act(async () => root!.render(<AttachmentPane
      attachment={missing ? attachment : { ...attachment, unavailable: null, current: { sha256: 'b'.repeat(64), size: 30, mtime: attachment.sent_mtime } }}
      attachments={[attachment]} records={[]} agent="Review" projectName="notes" projectRoot="/work" version={version}
      onVersion={() => {}} full={false} onToggleFull={() => {}} focusId={null} readOnly={false}
      onSaved={() => {}} onRemoved={() => {}} onOpenAt={() => {}} onClose={() => {}}
      strip={{ picks: 0, annotations: 0, onWriteReply: () => {} }}
    />));
    await until(() => host!.textContent!.includes(missing || version === 'sent' ? 'Sent words' : 'Current words'));
    await act(async () => document.querySelector<HTMLButtonElement>('[title="Add global comment"]')!.click());
    await until(() => field() !== null && !document.querySelector('fieldset[disabled]'));
  };
  await draw('current', true);
  await type('Only about the sent document.');
  await until(() => drafts.size === 1);
  expect(decodeURIComponent([...drafts.keys()][0]!)).toContain(`attachment:${attachment.id}:${attachment.sent_sha256}`);
  await act(async () => field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  expect(button('Save it')).toBeUndefined();
  expect(document.querySelector('[data-global-composer]')).toBeNull();
  expect(document.querySelector('[data-attachment-pane]')).not.toBeNull();
  await draw('current', false);
  expect(field().value).toBe('');
  await draw('sent', false);
  expect(field().value).toBe('Only about the sent document.');
});
