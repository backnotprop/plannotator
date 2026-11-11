import { afterEach, beforeEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseInboxQuestionBlocks } from '@plannotator/core/inbox-questions';
import type { InboxAnnotationRecord, InboxAttachmentState, InboxAuthor, InboxMessageWire, InboxProject, InboxQuestion, InboxReplyDraft, InboxThread } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
// Viewer pulls in web-highlighter, which reads `window` at module-eval time.
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');
const { replyDraftUnsaved } = (hasDom ? await import('./replyDraft') : {}) as typeof import('./replyDraft');

const PROJECT: InboxProject = { id: 'prj_1', key: 'ledger-abcdef', name: 'ledger', root: '/work/ledger', created_at: '2026-11-02T09:00:00.000Z' };
const A: Extract<InboxAuthor, { kind: 'agent' }> = { kind: 'agent', host: 'codex', session: 'ses_a', name: 'Codex (northwind-industries-holdings platform reviewer)' };
const THREAD = 'msg_01M6RF0000000000000000001';
const id = (n: number) => (n === 1 ? THREAD : `msg_01M6RF000000000000000000${n}`);

const question = (prompt: string, choices: string[]) => [':::question', prompt, '', ...choices.map((c) => `- [ ] ${c}`), ':::'].join('\n');
const CARD = [
  'Four decisions before I go on.',
  '',
  question('Which backoff should the worker use?', ['Exponential', 'Fixed 5 s']),
  '',
  question('Ship it behind a flag?', ['Yes', 'No']),
  '',
  question('Keep the dead-letter queue for 7 days or 30?', ['7 days', '30 days']),
  '',
  question('Who reviews the migration?', ['You', 'Me']),
].join('\n');
const PROSE = 'The worker drains in order, and the dead-letter path is wired.';

type Tweak = (q: InboxQuestion) => InboxQuestion;
const answerOf = (q: InboxQuestion) => ({ v: 1, key: q.key, kind: q.kind, prompt: q.prompt, selected: [q.choices[0]!.label] }) as InboxQuestion['answer'];
function questionsOf(messageId: string, body: string, tweak: Tweak): InboxQuestion[] {
  return parseInboxQuestionBlocks(body).map((q) =>
    tweak({
      key: q.key,
      position: q.position,
      kind: q.kind,
      prompt: q.prompt,
      context: q.parsed.context,
      choices: q.parsed.choices,
      recommendation: null,
      suggested_text: null,
      stopped: q.stopped,
      holds_up: q.holds_up,
      asked_by_agent_id: A.session,
      orphaned: false,
      state: 'open',
      answer: null,
      revision: 0,
      sent_revision: 0,
      picked_by: null,
      picked_at: null,
      sent_reply_id: null,
      message_id: messageId,
      superseded_by: null,
    }),
  );
}

function message(n: number, body: string, tweak: Tweak): InboxMessageWire {
  return {
    id: id(n),
    project_id: PROJECT.id,
    thread_id: THREAD,
    reply_to: n === 1 ? null : id(n - 1),
    author: A,
    subject: n === 1 ? 'Retry worker' : null,
    body,
    created_at: `2026-11-02T10:0${n}:00.000Z`,
    resolved_at: null,
    idempotency_key: null,
    ...(body.includes(':::question') ? { questions: questionsOf(id(n), body, tweak) } : {}),
  };
}

const thread = (questions: boolean, tweak: Tweak = (q) => q): InboxThread => ({
  thread_id: THREAD,
  project: PROJECT,
  subject: 'Retry worker',
  thread_name: null,
  resolved_at: null,
  messages: [message(1, PROSE, tweak), message(2, questions ? CARD : PROSE, tweak)],
});

const file: InboxAttachmentState = {
  id: 'att_1',
  message_id: id(1),
  name: 'notes.md',
  path: 'docs/notes.md',
  kind: 'markdown',
  size: 10,
  sha256: 'a'.repeat(64),
  sent_at: '2026-11-02T10:00:00.000Z',
  changed: false,
} as unknown as InboxAttachmentState;
const comment = (n: number): InboxAnnotationRecord => ({
  id: `ann-${n}`,
  project_id: PROJECT.id,
  thread_id: THREAD,
  message_id: id(1),
  attachment_id: file.id,
  path: file.path,
  version: 'current',
  annotation: { id: `ann-${n}`, blockId: 'block-0', type: 'COMMENT', text: `note ${n}`, originalText: 'The worker', startOffset: 0, endOffset: 10, createdA: n },
  created_at: '2026-11-02T10:05:00.000Z',
  updated_at: '2026-11-02T10:05:00.000Z',
  removed_at: null,
  sent_reply_id: null,
});

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let comments: InboxAnnotationRecord[] = [];
let closes = 0;
let replyAnswer: (() => Response) | null = null;
let draftAnswer: ((init?: RequestInit) => Response) | null = null;
let draftDeletes = 0;

beforeEach(() => {
  if (!hasDom) return;
  comments = [];
  closes = 0;
  replyAnswer = null;
  draftAnswer = null;
  draftDeletes = 0;
  savedFetch = globalThis.fetch;
  const draft = (body: string): InboxReplyDraft => ({ v: 1, thread_id: THREAD, body, created_at: '2026-11-02T10:10:00.000Z', updated_at: new Date().toISOString() });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.includes('/draft') && init?.method === 'DELETE') draftDeletes += 1;
    if (path.includes('/draft') && draftAnswer) return draftAnswer(init);
    if (path.includes('/draft')) return Response.json({ serverSession: 's', draft: draft(init?.method === 'POST' ? JSON.parse(String(init.body)).body : 'Mostly yes.') });
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: comments.length ? [file] : [], annotations: comments });
    if (path.includes('/sessions')) return Response.json({ serverSession: 's', home: '/home/me', project: PROJECT, sessions: [] });
    if (path.endsWith('/reply') && replyAnswer) return replyAnswer();
    if (path.endsWith(`/threads/${THREAD}`) && (!init?.method || init.method === 'GET')) return Response.json({ serverSession: 's', thread: thread(false) });
    return Response.json({});
  }) as typeof fetch;
});

afterEach(async () => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  // The box's words the pane saves as it goes (a failed Send leaves them in the box) land on this stub before the real
  // fetch is back: nothing is left unsaved in the drafts' module state for a later test (the restart guard reads it).
  for (let i = 0; i < 100 && replyDraftUnsaved(); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  globalThis.fetch = savedFetch;
});

async function settle(turns = 4, ms = 20) {
  for (let i = 0; i < turns; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  }
}

function draw(questions: boolean, tweak: Tweak | undefined, phone: boolean) {
  root!.render(
    <div className="pn-inbox">
      <ThreadPane thread={thread(questions, tweak)} sent={null} onQuestions={() => {}} onChanged={async () => {}} onClose={() => (closes += 1)} file={null} onOpenFile={() => {}} onOpenGuide={() => {}} phone={phone} />
    </div>,
  );
}

async function open({ questions, n = 0, phone = true, tweak }: { questions: boolean; n?: number; phone?: boolean; tweak?: Tweak }): Promise<HTMLElement> {
  comments = Array.from({ length: n }, (_, i) => comment(i + 1));
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    draw(questions, tweak, phone);
  });
  await settle();
  expect(!!(host.querySelector('.ib-rbox textarea'))).toBe(true);
  return host;
}

const line = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('.ib-rbox [data-foot-summary]');
const words = (el: HTMLElement) => line(el)?.querySelector('[data-foot-summary-text]')?.textContent ?? null;
const sheet = () => document.querySelector<HTMLElement>('[data-foot-sheet] [role="dialog"]');
const press = async (button: HTMLElement | null | undefined) => {
  expect(!!button).toBe(true);
  await act(async () => button!.click());
  await settle(2);
};
const description = (el: HTMLElement | null) => {
  const id = el?.getAttribute('aria-describedby');
  return id ? (document.getElementById(id)?.textContent ?? null) : null;
};
const buttonIn = (el: ParentNode | null, name: string) =>
  [...(el?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((b) => b.textContent?.trim() === name || b.getAttribute('aria-label') === name) ?? null;

const rowOrder = (el: HTMLElement) =>
  [...el.querySelectorAll<HTMLElement>('.ib-rbox [data-reply-row] :is([data-reply-attach], [data-reply-skills], [data-recipient], [data-voice-mic], [data-reply-send], [data-reply-discard])')].map((c) =>
    c.hasAttribute('data-reply-attach') ? 'attach' : c.hasAttribute('data-reply-skills') ? 'skills' : c.hasAttribute('data-recipient') ? 'recipient' : c.hasAttribute('data-voice-mic') ? 'mic' : c.hasAttribute('data-reply-send') ? 'send' : 'bin',
  );

test.skipIf(!hasDom)('a phone: the row is the paperclip first, Skills, then the mic and Send (an arrow named "Send") at the right edge; no bin, and Discard is on the Draft line above the box', async () => {
  const { adoptVoiceSettings } = await import('./voice');
  adoptVoiceSettings({ on: true, phones_only: false, engine: 'codex', key: { source: null, last4: null }, computer: null, intro_due: false, guest: false });
  try {
    const el = await open({ questions: false });
    expect(rowOrder(el)).toEqual(['attach', 'skills', 'mic', 'send']);
    const send = el.querySelector('.ib-rbox [data-reply-send]')!;
    expect(!!send.querySelector('svg.ib-rsend-i')).toBe(true);
    expect(send.textContent?.trim()).toBe('Send');
    expect(!!el.querySelector('.ib-rbox [data-reply-discard]')).toBe(false);
    expect(el.querySelector('[data-draft-above] [data-draft-stamp]')?.textContent).toContain('Saved');
    expect(!!el.querySelector('[data-draft-above] [data-draft-discard]')).toBe(true);
    expect(!!(line(el))).toBe(false);
    expect(!!(el.querySelector('.ib-rbox [data-annotations-chip], .ib-rbox [data-skip-chip], .ib-rbox [data-picks-chip]'))).toBe(false);
  } finally {
    adoptVoiceSettings(null);
  }
});

test.skipIf(!hasDom)('a computer: Send first, the paperclip, Skills and the mic, and the bin at the far right', async () => {
  const { adoptVoiceSettings } = await import('./voice');
  adoptVoiceSettings({ on: true, phones_only: false, engine: 'codex', key: { source: null, last4: null }, computer: null, intro_due: false, guest: false });
  try {
    const el = await open({ questions: false, phone: false });
    expect(rowOrder(el)).toEqual(['send', 'attach', 'skills', 'mic', 'bin']);
    expect(!!el.querySelector('[data-draft-above]')).toBe(false);
    expect(el.querySelector('.ib-rbox [data-reply-discard]')?.getAttribute('aria-label')).toBe('Discard draft');
  } finally {
    adoptVoiceSettings(null);
  }
});

test.skipIf(!hasDom)('a computer: Send says Send and no more: no tooltip on hover and no keycap, the key named for a screen reader', async () => {
  const { tooltipOf, unhover } = await import('./testing/tooltip');
  const el = await open({ questions: false, phone: false });
  const send = el.querySelector<HTMLButtonElement>('.ib-rbox [data-reply-send]')!;
  expect(await tooltipOf(send.closest('[data-tip-wrap]') ?? send)).toBeNull();
  unhover(send.closest('[data-tip-wrap]') ?? send);
  expect(!!send.querySelector('kbd, [data-shortcut-hint]')).toBe(false);
  expect(send.getAttribute('aria-keyshortcuts') ?? '').toMatch(/^(Meta|Control)\+Enter$/);
});

function typeInBox(el: HTMLElement, words: string) {
  const text = el.querySelector('.ib-rbox textarea') as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(text, words);
    text.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

test.skipIf(!hasDom)('a computer, after a conflict: the bin is "Discard mine": only this window\'s words go, the other window\'s draft stays and comes into the box', async () => {
  const el = await open({ questions: false, phone: false });
  let stored = 'Mostly yes.';
  const draftOf = (body: string): InboxReplyDraft => ({ v: 1, thread_id: THREAD, body, created_at: '2026-11-02T10:10:00.000Z', updated_at: new Date().toISOString() });
  draftAnswer = (init) => {
    if (init?.method === 'POST') {
      stored = 'Theirs.';
      return Response.json({ error: 'The draft changed in another window.', code: 'draft_conflict' }, { status: 409 });
    }
    if (init?.method === 'DELETE') return Response.json({ serverSession: 's', draft: null });
    return Response.json({ serverSession: 's', draft: draftOf(stored) });
  };
  typeInBox(el, 'Mine.');
  await settle(4, 200);
  expect(!!el.querySelector('[data-draft-conflict]')).toBe(true);
  const bin = el.querySelector<HTMLButtonElement>('.ib-rbox [data-reply-discard]');
  expect(bin?.getAttribute('aria-label')).toBe('Discard my words');
  await press(bin);
  await settle();
  expect(draftDeletes).toBe(0);
  expect(stored).toBe('Theirs.');
  expect((el.querySelector('.ib-rbox textarea') as HTMLTextAreaElement | null)?.value).toBe('Theirs.');
  expect(!!el.querySelector('[data-draft-conflict]')).toBe(false);
});

for (const phone of [false, true]) {
  test.skipIf(!hasDom)(`${phone ? 'a phone' : 'a computer'}: Skills with no skill to pick says "No skills are installed" in the row for a moment; no "/", and the field (a phone's keyboard) is not focused`, async () => {
    const catalog = await import('@plannotator/ui/utils/skillCatalog');
    catalog.resetSkillCatalogCache();
    catalog.setSkillCatalogTransport(async () => []);
    try {
      const el = await open({ questions: false, phone });
      const field = el.querySelector('.ib-rbox textarea') as HTMLTextAreaElement;
      act(() => (document.activeElement as HTMLElement | null)?.blur());
      await press(el.querySelector<HTMLButtonElement>('.ib-rbox [data-reply-skills]'));
      expect(field.value).toBe('Mostly yes.');
      expect(document.activeElement === field).toBe(false);
      expect(el.querySelector('.ib-rbox [data-reply-row] .ib-rmid [data-reply-hint]')?.textContent).toBe('No skills are installed');
      expect([...el.querySelectorAll('[aria-live]')].map((n) => n.textContent).join(' ')).toContain('No skills are installed to pick from.');
      await settle(4, 600);
      expect(!!el.querySelector('[data-reply-hint]')).toBe(false);
    } finally {
      catalog.resetSkillCatalogTransport();
      catalog.resetSkillCatalogCache();
    }
  });
}

test.skipIf(!hasDom)('Skills with a skill to pick types a real "/" at the caret, in the focused field, and says nothing in the row', async () => {
  const catalog = await import('@plannotator/ui/utils/skillCatalog');
  catalog.resetSkillCatalogCache();
  catalog.setSkillCatalogTransport(async () => [{ name: 'release-notes', root: 'claude', humanOnly: false }]);
  // happy-dom has no editing commands: the browser's insertText, as a field takes it.
  const saved = document.execCommand;
  document.execCommand = ((command: string, _ui?: boolean, value?: string) => {
    const field = document.activeElement as HTMLTextAreaElement;
    if (command !== 'insertText' || !(field instanceof HTMLTextAreaElement)) return false;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, field.value + (value ?? ''));
    field.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }) as typeof document.execCommand;
  try {
    const el = await open({ questions: false, phone: false });
    const field = el.querySelector('.ib-rbox textarea') as HTMLTextAreaElement;
    act(() => field.setSelectionRange(field.value.length, field.value.length));
    await press(el.querySelector<HTMLButtonElement>('.ib-rbox [data-reply-skills]'));
    expect(document.activeElement === field).toBe(true);
    expect(field.value).toBe('Mostly yes. /');
    expect(!!el.querySelector('[data-reply-hint]')).toBe(false);
  } finally {
    document.execCommand = saved;
    catalog.resetSkillCatalogTransport();
    catalog.resetSkillCatalogCache();
  }
});

const failure = (el: HTMLElement) => {
  const alert = el.querySelector<HTMLElement>('.ib-pfoot .ib-error[role="alert"]');
  const details = alert?.querySelector<HTMLDetailsElement>('[data-error-details]') ?? null;
  return {
    line: alert ? [...alert.childNodes].filter((n) => !(n instanceof HTMLElement && n.matches('[data-error-details]'))).map((n) => n.textContent).join('').trim() : null,
    details: details?.querySelector('.ib-errd-t')?.textContent ?? null,
    folded: details ? !details.open : null,
  };
};

for (const phone of [false, true]) {
  test.skipIf(!hasDom)(`${phone ? 'a phone' : 'a computer'}: a Send the Inbox fails says so in one plain line, its own words folded behind Details; the words stay in the box (decision D3)`, async () => {
    replyAnswer = () =>
      Response.json({ error: "EACCES: permission denied, open '/Users/me/.plannotator/inbox/projects/ledger-abcdef/threads/msg_01M6RF.jsonl'", code: 'internal' }, { status: 500 });
    const el = await open({ questions: false, phone });
    await press(el.querySelector<HTMLButtonElement>('.ib-rbox [data-reply-send]'));
    await settle();
    expect(failure(el)).toEqual({
      line: 'The reply was not sent: the Inbox could not write it. Send again to retry.',
      details: "EACCES: permission denied, open '/Users/me/.plannotator/inbox/projects/ledger-abcdef/threads/msg_01M6RF.jsonl'",
      folded: true,
    });
    expect((el.querySelector('.ib-rbox textarea') as HTMLTextAreaElement | null)?.value).toBe('Mostly yes.');
    expect(el.querySelector<HTMLButtonElement>('.ib-rbox [data-reply-send]')?.disabled).toBe(false);
  });
}

test.skipIf(!hasDom)('a refusal written for people stays the line as it is, with no Details (decision D3)', async () => {
  replyAnswer = () => Response.json({ error: 'That question was already answered in another window.', code: 'question_closed' }, { status: 409 });
  const el = await open({ questions: false, phone: false });
  await press(el.querySelector<HTMLButtonElement>('.ib-rbox [data-reply-send]'));
  await settle();
  expect(failure(el)).toEqual({ line: 'That question was already answered in another window.', details: null, folded: null });
});

test.skipIf(!hasDom)('comments only: the line names them and opens their list in one press; closing it puts focus back on the line', async () => {
  const el = await open({ questions: false, n: 3 });
  expect(words(el)).toBe('3 comments');
  await press(line(el));
  expect(!!(sheet())).toBe(false);
  const list = el.querySelector<HTMLElement>('[data-comments-list]');
  expect(list?.querySelectorAll('[data-annotation-row]').length).toBe(3);
  await press(buttonIn(list, 'Close the list'));
  expect(!!(el.querySelector('[data-comments-list]'))).toBe(false);
  expect(document.activeElement === line(el)).toBe(true);
});

test.skipIf(!hasDom)('questions only: the line opens a sheet whose Skip them skips them for this Send, and the line says so', async () => {
  const el = await open({ questions: true });
  expect(words(el)).toBe('4 questions open');
  const status = () => [...el.querySelectorAll('.ib-sr[role="status"]')].map((s) => s.textContent).join(' ');
  expect(status()).not.toContain('will be skipped');
  await press(line(el));
  expect(sheet()?.textContent).toContain('4 questions stay open');
  await press(buttonIn(sheet(), 'Skip them'));
  expect(status()).toContain('4 questions will be skipped when you send.');
  expect(words(el)).toBe('4 questions to skip');
  await press(buttonIn(sheet(), 'Keep open'));
  expect(status()).not.toContain('will be skipped');
  expect(words(el)).toBe('4 questions open');
});

test.skipIf(!hasDom)('both: one line for both; the sheet holds both, and Review opens the comments list', async () => {
  const el = await open({ questions: true, n: 3 });
  expect(words(el)).toBe('4 questions open · 3 comments');
  await press(line(el));
  expect(!!(sheet()?.querySelector('[data-foot-sheet-row="questions"]'))).toBe(true);
  expect(sheet()?.querySelector('[data-foot-sheet-row="comments"]')?.textContent).toContain('3 comments');
  await press(buttonIn(sheet(), 'Review comments'));
  expect(!!(sheet())).toBe(false);
  expect(el.querySelectorAll('[data-comments-list] [data-annotation-row]').length).toBe(3);
});

test.skipIf(!hasDom)('Escape and × close the sheet, focus back on the line', async () => {
  const el = await open({ questions: true, n: 1 });
  await press(line(el));
  expect(document.activeElement === sheet()).toBe(true);
  await act(async () => sheet()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  await settle(2);
  expect(!!(sheet())).toBe(false);
  expect(document.activeElement === line(el)).toBe(true);
  expect(!!(el.querySelector('.ib-rbox textarea'))).toBe(true);
  expect(closes).toBe(0);
  await press(line(el));
  await press(buttonIn(sheet(), 'Close'));
  expect(!!(sheet())).toBe(false);
  expect(document.activeElement === line(el)).toBe(true);
});

test.skipIf(!hasDom)('the sheet is modal; a press on its scrim stays there, and the click that ends it closes the sheet, focus back on the line', async () => {
  const el = await open({ questions: true });
  await press(line(el));
  expect(sheet()?.getAttribute('aria-modal')).toBe('true');
  const scrim = document.querySelector<HTMLElement>('[data-foot-sheet] .ib-fsheet-scrim');
  expect(!!scrim).toBe(true);
  let kept = false;
  await act(async () => {
    const down = new PointerEvent('pointerdown', { bubbles: true, cancelable: true });
    scrim!.dispatchEvent(down);
    kept = down.defaultPrevented;
  });
  await settle(1);
  expect(kept).toBe(true);
  expect(!!sheet()).toBe(true);
  await press(scrim);
  expect(!!sheet()).toBe(false);
  expect(document.activeElement === line(el)).toBe(true);
});

const allPicked: Tweak = (q) => ({ ...q, state: 'picked', answer: answerOf(q) });
const oneOpen: Tweak = (q) => (q.position < 3 ? { ...q, state: 'picked', answer: answerOf(q) } : q);

test.skipIf(!hasDom)('questions gone while the sheet is open (answered elsewhere): it closes for good, and a new question neither opens it nor takes the field’s focus', async () => {
  const el = await open({ questions: true });
  await press(line(el));
  expect(document.activeElement === sheet()).toBe(true);
  act(() => draw(true, allPicked, true));
  await settle(2);
  expect(!!sheet()).toBe(false);
  expect(!!line(el)).toBe(false);
  expect(document.activeElement?.hasAttribute('data-reply-attach') ?? false).toBe(true);
  const field = el.querySelector<HTMLTextAreaElement>('.ib-rbox textarea')!;
  act(() => field.focus());
  act(() => draw(true, oneOpen, true));
  await settle(2);
  expect(words(el)).toBe('1 question open');
  expect(!!sheet()).toBe(false);
  expect(line(el)?.getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement === field).toBe(true);
});

test.skipIf(!hasDom)('questions gone while the sheet is open, a comment left: the line says the comment, not open, and has focus', async () => {
  const el = await open({ questions: true, n: 1 });
  await press(line(el));
  act(() => draw(true, allPicked, true));
  await settle(2);
  expect(!!sheet()).toBe(false);
  expect(words(el)).toBe('1 comment');
  expect(line(el)?.getAttribute('aria-expanded')).toBe('false');
  expect(line(el)?.classList.contains('ib-on')).toBe(false);
  expect(document.activeElement === line(el)).toBe(true);
});

test.skipIf(!hasDom)('removing the last comment from the list: focus goes to the field, as the desktop chip does (the line goes with it)', async () => {
  const el = await open({ questions: false, n: 1 });
  await press(line(el));
  const row = el.querySelector<HTMLElement>('[data-comments-list] [data-annotation-row]');
  await press(buttonIn(row, 'Remove'));
  await settle(3);
  expect(!!el.querySelector('[data-comments-list]')).toBe(false);
  expect(!!line(el)).toBe(false);
  expect(document.activeElement === el.querySelector('.ib-rbox textarea')).toBe(true);
});

test.skipIf(!hasDom)('no "2 picks" chip: the answers list above already says it', async () => {
  const picked: Tweak = (q) => (q.position < 2 ? { ...q, state: 'picked', answer: answerOf(q) } : q);
  const el = await open({ questions: true, tweak: picked });
  expect(!!(el.querySelector('.ib-rbox .ib-ranswers'))).toBe(true);
  expect(!!(el.querySelector('[data-picks-chip]'))).toBe(false);
  expect(words(el)).toBe('2 questions open');
});

test.skipIf(!hasDom)('picks on a replaced question that will not be sent are in the sheet', async () => {
  const replaced: Tweak = (q) => (q.position === 0 ? { ...q, state: 'superseded', answer: answerOf(q) } : q);
  const el = await open({ questions: true, tweak: replaced });
  expect(!!(el.querySelector('[data-dropped-picks-chip]'))).toBe(false);
  await press(line(el));
  expect(sheet()?.querySelector('[data-foot-sheet-row="dropped"]')?.textContent).toContain('1 pick on a replaced question won’t be sent');
});

test.skipIf(!hasDom)('where the full words do not fit (a 320 px phone), the line reads "4 open · 3 comments"', async () => {
  // The line's text box is 170 px wide; its words take 8 px a character.
  const proto = HTMLElement.prototype;
  const saved = { scroll: Object.getOwnPropertyDescriptor(proto, 'scrollWidth'), client: Object.getOwnPropertyDescriptor(proto, 'clientWidth') };
  const isText = (el: HTMLElement) => el.hasAttribute('data-foot-summary-text');
  Object.defineProperty(proto, 'scrollWidth', { configurable: true, get(this: HTMLElement) { return isText(this) ? (this.textContent?.length ?? 0) * 8 : (saved.scroll?.get?.call(this) ?? 0); } });
  Object.defineProperty(proto, 'clientWidth', { configurable: true, get(this: HTMLElement) { return isText(this) ? 170 : (saved.client?.get?.call(this) ?? 0); } });
  try {
    const el = await open({ questions: true, n: 3 });
    expect(words(el)).toBe('4 open · 3 comments');
    expect(line(el)?.hasAttribute('aria-label')).toBe(false);
    expect(description(line(el))).toBe('4 questions stay open, 3 comments');
  } finally {
    if (saved.scroll) Object.defineProperty(proto, 'scrollWidth', saved.scroll);
    if (saved.client) Object.defineProperty(proto, 'clientWidth', saved.client);
  }
});

test.skipIf(!hasDom)('a smaller text size, the row as wide as before: the line is fitted again and says it whole', async () => {
  const { chooseTextSize, resetInboxTextSizeForTests } = await import('./textSize');
  const proto = HTMLElement.prototype;
  const saved = { scroll: Object.getOwnPropertyDescriptor(proto, 'scrollWidth'), client: Object.getOwnPropertyDescriptor(proto, 'clientWidth') };
  const isText = (el: HTMLElement) => el.hasAttribute('data-foot-summary-text');
  const room = () => (document.documentElement.style.getPropertyValue('--inbox-text-size') === '12' ? 400 : 170);
  Object.defineProperty(proto, 'scrollWidth', { configurable: true, get(this: HTMLElement) { return isText(this) ? (this.textContent?.length ?? 0) * 8 : (saved.scroll?.get?.call(this) ?? 0); } });
  Object.defineProperty(proto, 'clientWidth', { configurable: true, get(this: HTMLElement) { return isText(this) ? room() : (saved.client?.get?.call(this) ?? 0); } });
  try {
    const el = await open({ questions: true, n: 3 });
    expect(words(el)).toBe('4 open · 3 comments');
    await act(async () => void chooseTextSize(12));
    await settle(2);
    expect(words(el)).toBe('4 questions open · 3 comments');
  } finally {
    if (saved.scroll) Object.defineProperty(proto, 'scrollWidth', saved.scroll);
    if (saved.client) Object.defineProperty(proto, 'clientWidth', saved.client);
    resetInboxTextSizeForTests();
  }
});

test.skipIf(!hasDom)('a computer shows the chips while they fit: the skip chip and "3 comments" in the row, no line', async () => {
  const el = await open({ questions: true, n: 3, phone: false });
  expect(!!(line(el))).toBe(false);
  expect(el.querySelector('.ib-rbox [data-reply-row] [data-skip-chip]')?.textContent).toContain('4 questions stay open');
  expect(el.querySelector('.ib-rbox [data-reply-row] [data-annotations-chip]')?.textContent).toBe('3 comments');
});

test.skipIf(!hasDom)('a narrow computer pane (the summary line in place of the chips): Skip them in its sheet keeps the sheet open and focus in it', async () => {
  // The chips need 900 px; the cell has 300.
  const proto = HTMLElement.prototype;
  const saved = { scroll: Object.getOwnPropertyDescriptor(proto, 'scrollWidth'), client: Object.getOwnPropertyDescriptor(proto, 'clientWidth') };
  const isLayer = (el: HTMLElement) => el.classList.contains('ib-rlayer');
  Object.defineProperty(proto, 'scrollWidth', { configurable: true, get(this: HTMLElement) { return isLayer(this) ? (this.querySelector('.ib-rchips') ? 900 : 120) : (saved.scroll?.get?.call(this) ?? 0); } });
  Object.defineProperty(proto, 'clientWidth', { configurable: true, get(this: HTMLElement) { return isLayer(this) ? 300 : (saved.client?.get?.call(this) ?? 0); } });
  try {
    const el = await open({ questions: true, n: 3, phone: false });
    expect(!!el.querySelector('.ib-rbox [data-reply-row] [data-skip-chip]')).toBe(false);
    expect(words(el)).toMatch(/^4 (questions )?open · 3 comments$/);
    await press(line(el));
    const skip = buttonIn(sheet(), 'Skip them');
    act(() => skip?.focus());
    await press(skip);
    expect(!!sheet()).toBe(true);
    expect(document.activeElement === buttonIn(sheet(), 'Keep open')).toBe(true);
    expect(words(el)).toMatch(/^4 (questions )?to skip · 3 comments$/);
  } finally {
    if (saved.scroll) Object.defineProperty(proto, 'scrollWidth', saved.scroll);
    if (saved.client) Object.defineProperty(proto, 'clientWidth', saved.client);
  }
});

test.skipIf(!hasDom)('a computer with the comments list open from its chip: a change in what goes with the reply keeps the chip and its list (the open list is never measured as chips)', async () => {
  const proto = HTMLElement.prototype;
  const saved = { scroll: Object.getOwnPropertyDescriptor(proto, 'scrollWidth'), client: Object.getOwnPropertyDescriptor(proto, 'clientWidth') };
  const isLayer = (el: HTMLElement) => el.classList.contains('ib-rlayer');
  Object.defineProperty(proto, 'scrollWidth', { configurable: true, get(this: HTMLElement) { return isLayer(this) ? (this.querySelector('[data-comments-list]') ? 900 : 200) : (saved.scroll?.get?.call(this) ?? 0); } });
  Object.defineProperty(proto, 'clientWidth', { configurable: true, get(this: HTMLElement) { return isLayer(this) ? 300 : (saved.client?.get?.call(this) ?? 0); } });
  try {
    const el = await open({ questions: true, n: 3, phone: false });
    const chip = () => el.querySelector<HTMLButtonElement>('.ib-rbox [data-reply-row] [data-annotations-chip]');
    expect(!!chip()).toBe(true);
    await press(chip());
    expect(!!el.querySelector('[data-comments-list]')).toBe(true);
    act(() => draw(true, oneOpen, false));
    await settle(2);
    expect(!!chip()).toBe(true);
    expect(!!line(el)).toBe(false);
    expect(!!el.querySelector('.ib-rbox [data-reply-row] .ib-annchip [data-comments-list]')).toBe(true);
  } finally {
    if (saved.scroll) Object.defineProperty(proto, 'scrollWidth', saved.scroll);
    if (saved.client) Object.defineProperty(proto, 'clientWidth', saved.client);
  }
});

test('the closed foot is today\'s bar: no style redraws the open questions button\'s words as a bare count, or moves its buttons', () => {
  const css = readFileSync(join(import.meta.dir, 'inbox.css'), 'utf8');
  expect(css).not.toMatch(/attr\(data-oq-(?:n|actions|permission|label)\)/);
  expect(css).not.toMatch(/\[data-open-questions\][^{}]*\{[^}]*(?:^|[;\s])order\s*:/m);
  expect(css).not.toMatch(/\.ib-footbtns[^{}]*\.ib-pri[^{}]*\{[^}]*(?:^|[;\s])order\s*:/m);
});
