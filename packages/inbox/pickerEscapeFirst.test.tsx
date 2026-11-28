/**
 * Escape with a list open closes the list, never the box under it, also before a query was typed. What regressed: in
 * the reply box, `/` (or `Hold on /`) opened the skill list, and one Escape closed the list AND the box (a bare
 * trigger let Escape through to the box). With `/pic` or the `@` list it already closed only the list.
 *
 * The real reply box (ThreadPane, a computer and a phone, its network stubbed): the first Escape closes the list and
 * leaves the box open with its words; the second closes the box. The `#` and `@` lists on a bare trigger, and `$`,
 * in the Inbox's field with the host's own Escape counted, as the reply box and New message hand it theirs.
 *
 * Assertions compare booleans, numbers and strings, never elements (a failed `expect(element)` prints a happy-dom node).
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAuthor, InboxInitiative, InboxProject, InboxReplyDraft, InboxThread } from '@plannotator/core/inbox-types';
import type { SkillCatalogEntry } from '@plannotator/ui/utils/skillReferences';
import type { InitiativeTags } from './hashtags';

const hasDom = typeof document !== 'undefined';
// Viewer pulls in web-highlighter, which reads `window` at module-eval time.
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');
const { InboxComposerField } = (hasDom ? await import('./components/ComposerField') : {}) as typeof import('./components/ComposerField');
const { InitiativeTagsContext } = (hasDom ? await import('./hashtags') : {}) as typeof import('./hashtags');
const { replyDraftUnsaved } = (hasDom ? await import('./replyDraft') : {}) as typeof import('./replyDraft');
const catalog = (hasDom ? await import('@plannotator/ui/utils/skillCatalog') : {}) as typeof import('@plannotator/ui/utils/skillCatalog');

const SKILLS: SkillCatalogEntry[] = [
  { name: 'picture', root: 'claude', description: 'Draw it', humanOnly: false },
  { name: 'readback', root: 'claude', description: 'Read it back', humanOnly: false },
];
const PROJECT: InboxProject = { id: 'prj_1', key: 'harbor-abcdef', name: 'harbor', root: '/work/harbor', created_at: '2026-11-02T09:00:00.000Z' };
const A: Extract<InboxAuthor, { kind: 'agent' }> = { kind: 'agent', host: 'codex', session: 'ses_a', name: 'Codex' };
const THREAD = 'msg_01M6RF0000000000000000001';
const THE_THREAD: InboxThread = {
  thread_id: THREAD,
  project: PROJECT,
  subject: 'Retry worker',
  thread_name: null,
  resolved_at: null,
  messages: [
    { id: THREAD, project_id: PROJECT.id, thread_id: THREAD, reply_to: null, author: A, subject: 'Retry worker', body: 'The worker drains in order.', created_at: '2026-11-02T10:01:00.000Z', resolved_at: null, idempotency_key: null },
  ],
};
const ini = (id: string, name: string): InboxInitiative => ({ id, name, created_at: '', created_by: { kind: 'person' }, updated_at: '', deleted_at: null }) as InboxInitiative;
const SHAPE = ini('ini_shape', 'Shape');
const INITIATIVES: InitiativeTags = { initiatives: [SHAPE], counts: new Map([[SHAPE.id, 1]]), cards: [], rows: new Map(), projects: new Map(), mentions: new Map() };
const AGENT = { group: 'Claude Code', agent: 'Claude Code', host: 'claude-code', owner: false, wakes: true, taggable: true, project: 'harbor' };
const TAGS = { options: [{ ...AGENT, id: 'ses_b', label: 'Claude Code', detail: 'harbor · idle', owner: true }], onChange: () => {} };

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
/** The words of each draft save the pane made. */
let draftSaves: string[] = [];
let hostEscapes = 0;

beforeEach(() => {
  if (!hasDom) return;
  draftSaves = [];
  hostEscapes = 0;
  catalog.resetSkillCatalogCache();
  catalog.setSkillCatalogTransport(async () => SKILLS);
  savedFetch = globalThis.fetch;
  const draft = (body: string): InboxReplyDraft => ({ v: 1, thread_id: THREAD, body, created_at: '2026-11-02T10:10:00.000Z', updated_at: new Date().toISOString() });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/draft') && init?.method === 'POST') {
      const body = String(JSON.parse(String(init.body)).body);
      draftSaves.push(body);
      return Response.json({ serverSession: 's', draft: draft(body) });
    }
    // A saved draft: the box opens holding it.
    if (url.includes('/draft')) return Response.json({ serverSession: 's', draft: draft('Hold on') });
    if (url.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], annotations: [] });
    if (url.includes('/sessions')) return Response.json({ serverSession: 's', home: '/home/me', project: PROJECT, sessions: [] });
    if (url.endsWith(`/threads/${THREAD}`)) return Response.json({ serverSession: 's', thread: THE_THREAD });
    return Response.json({});
  }) as typeof fetch;
});

afterEach(async () => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  for (let i = 0; i < 100 && replyDraftUnsaved(); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  const left = replyDraftUnsaved();
  globalThis.fetch = savedFetch;
  catalog.resetSkillCatalogTransport();
  catalog.resetSkillCatalogCache();
  if (left) throw new Error('the test left a reply draft save on its way, or words not saved');
});

async function settle(turns = 4, ms = 20) {
  for (let i = 0; i < turns; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  }
}

function mount(node: React.ReactNode) {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<div className="pn-inbox">{node}</div>);
  });
}

const replyField = () => host?.querySelector<HTMLTextAreaElement>('.ib-rbox textarea') ?? null;
const skillList = () => document.querySelector('[data-skill-menu]') !== null;
const hashList = () => [...document.querySelectorAll('[data-skill-menu] [role="option"]')].some((row) => row.textContent?.includes('Shape'));
const tagList = () => document.querySelector('[data-tag-picker]') !== null;

/** One edit as the browser types it: the value and the caret change, then `input` with its `inputType`. */
async function type(el: HTMLTextAreaElement, next: string) {
  await act(async () => {
    el.focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, next);
    el.setSelectionRange(next.length, next.length);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    document.dispatchEvent(new Event('selectionchange'));
  });
}

async function escape(el: HTMLTextAreaElement) {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
  await settle(2);
}

for (const phone of [false, true]) {
  for (const words of ['/', 'Hold on /']) {
    test.skipIf(!hasDom)(`${phone ? 'a phone' : 'a computer'}'s reply box, "${words}": the first Escape closes the list and keeps the box and its words; the second closes the box`, async () => {
      mount(<ThreadPane thread={THE_THREAD} sent={null} onQuestions={() => {}} onChanged={async () => {}} onClose={() => {}} file={null} onOpenFile={() => {}} onOpenGuide={() => {}} phone={phone} />);
      await settle();
      const field = replyField();
      expect(field !== null).toBe(true);
      await type(field!, words);
      await settle(2);
      expect(skillList()).toBe(true);
      await escape(field!);
      expect(skillList()).toBe(false);
      expect(replyField() !== null).toBe(true);
      expect(replyField()?.value).toBe(words);
      await escape(replyField()!);
      expect(replyField() === null).toBe(true);
      // Closed with its words kept as the draft.
      await settle(4);
      expect(draftSaves.at(-1)).toBe(words);
    });
  }
}

function Field() {
  const [value, setValue] = useState('');
  return (
    <InitiativeTagsContext.Provider value={INITIATIVES}>
      <InboxComposerField
        value={value}
        onChange={setValue}
        placeholder="Write a reply"
        ariaLabel="Reply"
        destination="your reply"
        tags={TAGS}
        onKeyDown={(event) => {
          if (event.key === 'Escape') hostEscapes++;
        }}
      />
    </InitiativeTagsContext.Provider>
  );
}

const LISTS: Array<[string, string, () => boolean]> = [
  ['the / list', '/', skillList],
  ['the $ list', 'Hold on $', skillList],
  ['the # list', 'Hold on #', hashList],
  ['the @ list', 'Hold on @', tagList],
];

for (const [name, words, open] of LISTS) {
  test.skipIf(!hasDom)(`${name} on a bare "${words.at(-1)}": the first Escape closes only the list, the next reaches the box`, async () => {
    mount(<Field />);
    await act(async () => {}); // the catalog's fetch
    const field = host!.querySelector('textarea')!;
    await type(field, words);
    await settle(2);
    expect(open()).toBe(true);
    await escape(field);
    expect(open()).toBe(false);
    expect(hostEscapes).toBe(0);
    expect(field.value).toBe(words);
    await escape(field);
    expect(hostEscapes).toBe(1);
  });
}
