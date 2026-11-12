import { afterEach, beforeAll, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAuthor, InboxMessageWire, InboxProject, InboxThread } from '@plannotator/core/inbox-types';
import type { SkillCatalogEntry } from '@plannotator/ui/utils/skillReferences';

const hasDom = typeof document !== 'undefined';
const { ThreadPane } = (hasDom ? await import('../components/Thread') : {}) as typeof import('../components/Thread');
const { useInboxAsk } = (hasDom ? await import('./useInboxAsk') : {}) as typeof import('./useInboxAsk');
const { resetSkillCatalogCache, setSkillCatalogTransport, resetSkillCatalogTransport } = (hasDom ? await import('@plannotator/ui/utils/skillCatalog') : {}) as typeof import('@plannotator/ui/utils/skillCatalog');
const { INBOX_REPLY_SKILL_AUDIENCE, inboxSkillFilter, inboxSkillsBlock } = (hasDom ? await import('../skills') : {}) as typeof import('../skills');

const PROJECT: InboxProject = { id: 'prj_1', key: 'retry-abcdef', name: 'retry', root: '/work/retry', created_at: '2026-11-08T09:00:00.000Z' };
const AGENT: InboxAuthor = { kind: 'agent', host: 'claude-code', session: 'ses_a', name: 'Claude Code' };
const ROOT = 'msg_01K7SIDECMDSIDECMDSIDECM01';

const MESSAGE = {
  id: ROOT,
  project_id: PROJECT.id,
  thread_id: ROOT,
  reply_to: null,
  author: AGENT,
  subject: 'Retry budget',
  subject_question: null,
  body: 'I moved the retry loop into the client.',
  created_at: '2026-11-08T10:00:00.000Z',
  resolved_at: null,
  idempotency_key: null,
  attachments: [],
  questions: [],
} as unknown as InboxMessageWire;

const THREAD: InboxThread = { thread_id: ROOT, project: PROJECT, subject: 'Retry budget', thread_name: null, resolved_at: null, messages: [MESSAGE] } as unknown as InboxThread;

const CURATE: SkillCatalogEntry = { name: 'review-curate', root: 'plannotator', description: 'A review of only the parts of the change that need you', humanOnly: true };
const SHAPE: SkillCatalogEntry = { name: 'shape', root: 'plannotator', description: 'Ask the agent to picture this thread.', humanOnly: true };
const READBACK: SkillCatalogEntry = { name: 'readback', root: 'claude', description: 'State the request back.', humanOnly: true };
const OWN_SIDE: SkillCatalogEntry = { name: 'side', root: 'claude', description: 'The B side of the record.', humanOnly: false };

let root: Root | null = null;
let host: HTMLElement | null = null;
const realFetch = globalThis.fetch;

beforeAll(() => {
  if (hasDom) (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL('http://localhost:4000/');
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = realFetch;
  if (hasDom) {
    resetSkillCatalogTransport();
    resetSkillCatalogCache();
    document.body.replaceChildren();
    window.sessionStorage.clear();
  }
});

let wrote: { url: string; body: Record<string, unknown> }[] = [];
let draft: string | null = null;

function serve(canAsk: boolean, skills: SkillCatalogEntry[] = []) {
  wrote = [];
  draft = null;
  resetSkillCatalogCache();
  setSkillCatalogTransport(async () => skills);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (method === 'GET' && url.endsWith(`/threads/${ROOT}/ask`)) {
      return Response.json({ subject: 'Retry budget', project: PROJECT.name, conversation: null, running: null, can_ask: canAsk, agent: { host: 'claude-code', name: 'Claude Code' } });
    }
    if (url.includes('/draft')) {
      if (url.endsWith('/draft/delete')) draft = null;
      else if (method === 'POST' && typeof body.body === 'string') draft = body.body;
      return Response.json({ draft: null });
    }
    if (method !== 'GET') wrote.push({ url, body });
    if (url.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], annotations: [] });
    return Response.json({});
  }) as typeof fetch;
}

const settle = async () => {
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
};

async function until(check: () => boolean | Promise<boolean>, what: string, ms = 3000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  }
}

function ThreadWithAsk({ phone = false }: { phone?: boolean }) {
  const ask = useInboxAsk({ on: true, codeReview: false, threadId: ROOT, phone, openThread: () => {}, replyInThread: () => {} });
  return (
    <div className="pn-inbox">
      <ThreadPane
        thread={THREAD}
        sent={null}
        onQuestions={() => {}}
        onChanged={async () => {}}
        onClose={() => {}}
        file={null}
        onOpenFile={() => {}}
        onOpenGuide={() => {}}
        phone={phone}
        onSide={ask.side}
        onSideWords={ask.sideWords}
      />
      {ask.layer}
    </div>
  );
}

const replyBox = () => document.querySelector<HTMLTextAreaElement>('.ib-rbox:not(.ib-askbox) textarea.ib-rtext');
const askBox = () => document.querySelector<HTMLTextAreaElement>('[data-chat-window] textarea');
const listed = () => [...document.querySelectorAll<HTMLElement>('[data-skill-menu] [data-skill-item]')].map((row) => row.dataset.skillItem);
const row = (name: string) => document.querySelector<HTMLElement>(`[data-skill-menu] [data-skill-item="${name}"]`);

async function openReply(canAsk: boolean, skills: SkillCatalogEntry[] = [], phone = false) {
  serve(canAsk, skills);
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(<ThreadWithAsk phone={phone} />);
  });
  await settle();
  await until(() => document.querySelector('[data-reply-button]') !== null, 'the Reply button');
  await act(async () => document.querySelector<HTMLElement>('[data-reply-button]')!.click());
  await until(() => replyBox() !== null, 'the reply box');
  await act(async () => replyBox()!.focus());
  await settle();
}

async function type(el: HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value);
    el.selectionStart = el.selectionEnd = value.length;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
}

const key = async (el: HTMLElement, name: string) => {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: name, code: name, bubbles: true, cancelable: true }));
  });
  await settle();
};

const press = async (el: HTMLElement) => {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
  });
  await settle();
};

test.skipIf(!hasDom)('a thread that can ask: /side is listed after the other built-ins, and a pick moves the words to the side chat, unsent', async () => {
  await openReply(true, [CURATE, SHAPE, READBACK]);
  await type(replyBox()!, 'Why is the cap five attempts? /');
  await until(() => listed().length > 0, 'the "/" list');
  expect(listed()).toEqual(['review-curate', 'shape', 'side', 'readback']);
  const parts = (name: string) => [...row(name)!.querySelectorAll<HTMLElement>('[data-skill-item-part]')].map((part) => part.dataset.skillItemPart);
  expect(parts('side')).toEqual(parts('shape'));
  expect(row('side')!.querySelector('[data-skill-item-part="root"]')!.textContent).toBe(row('shape')!.querySelector('[data-skill-item-part="root"]')!.textContent);
  expect(row('side')!.querySelector('[data-skill-item-part="description"]')!.textContent!.trim()).not.toBe('');
  expect(row('side')!.getAttribute('role')).toBe('option');
  expect(askBox()).toBeNull();

  await until(() => draft === 'Why is the cap five attempts? /', 'the draft to save', 5000);

  await press(row('side')!);
  await until(() => askBox() !== null, 'the side chat');
  expect(askBox()!.value).toBe('Why is the cap five attempts?');
  await until(() => document.activeElement === askBox(), 'focus in the chat box');
  await until(() => replyBox() === null || replyBox()!.value === '', 'the reply to clear');
  expect(listed()).toEqual([]);
  await until(() => draft === null || draft === '', 'the draft to clear', 5000);
  expect(wrote).toEqual([]);
});

test.skipIf(!hasDom)('the keyboard: a typed query, an arrow and Enter pick /side; words already in the chat box stay above the new ones', async () => {
  await openReply(true);
  await type(replyBox()!, '/');
  await until(() => listed().length > 0, 'the "/" list');
  expect(listed()).toEqual(['side']);
  await press(row('side')!);
  await until(() => askBox() !== null, 'the side chat');
  expect(askBox()!.value).toBe('');
  await until(() => document.activeElement === askBox(), 'focus in the chat box');
  expect(replyBox()!.value).toBe('');
  await type(askBox()!, 'First thought');

  await act(async () => replyBox()!.focus());
  await type(replyBox()!, 'Second thought /si');
  await until(() => listed().length > 0, 'the "/" list');
  await key(replyBox()!, 'ArrowDown');
  expect(row('side')!.getAttribute('aria-selected')).toBe('true');
  expect(replyBox()!.getAttribute('aria-activedescendant')).toBe(row('side')!.id);
  await key(replyBox()!, 'Enter');
  await until(() => askBox()!.value === 'First thought\nSecond thought', 'both thoughts in the chat box');
  await until(() => replyBox()!.value === '', 'the reply to clear');
  expect(wrote).toEqual([]);
});

test.skipIf(!hasDom)('a thread that cannot ask: /side is not listed, alone or beside skills', async () => {
  await openReply(false, [SHAPE, READBACK]);
  await type(replyBox()!, 'Why five? /');
  await until(() => listed().length > 0, 'the "/" list');
  expect(listed()).toEqual(['shape', 'readback']);
  await type(replyBox()!, 'Why five? /side');
  await settle();
  expect(listed()).toEqual([]);
  expect(askBox()).toBeNull();
});

test.skipIf(!hasDom)('the phone layout, where Ask has no way in: /side is not listed', async () => {
  await openReply(true, [SHAPE], true);
  await type(replyBox()!, '/');
  await until(() => listed().length > 0, 'the "/" list');
  expect(listed()).toEqual(['shape']);
});

test.skipIf(!hasDom)('/side typed and not picked is plain words: not painted, no skill instructions, nothing for the agent; $ never lists it', async () => {
  await openReply(true, [SHAPE]);
  await type(replyBox()!, 'see /side and /shape');
  await settle();
  const painted = () => [...document.querySelectorAll<HTMLElement>('[data-composer-field] [data-skill-ref-token]')].map((el) => el.dataset.skillRefToken);
  await until(() => painted().length > 0, 'the painted reference');
  expect(painted()).toEqual(['shape']);
  expect(document.querySelector('[data-skill-human-only-notice] .font-mono')!.textContent).toBe('shape');
  const block = await inboxSkillsBlock(['see /side and /shape'], INBOX_REPLY_SKILL_AUDIENCE, undefined, inboxSkillFilter(false));
  const named = block.split('--- BEGIN')[0]!.split('\n').filter((line) => line.startsWith('- `'));
  expect(named).toHaveLength(1);
  expect(named[0]).toContain('`shape`');
  expect(await inboxSkillsBlock(['take this /side'], INBOX_REPLY_SKILL_AUDIENCE, undefined, inboxSkillFilter(false))).toBe('');

  await type(replyBox()!, '$');
  await until(() => listed().length > 0, 'the "$" list');
  expect(listed()).toEqual(['shape']);
});

test.skipIf(!hasDom)("a skill of the person's own named side wins: it is inserted as a skill, and no chat opens", async () => {
  await openReply(true, [SHAPE, OWN_SIDE]);
  await type(replyBox()!, 'play /si');
  await until(() => listed().length > 0, 'the "/" list');
  expect(listed()).toEqual(['side']);
  expect(row('side')!.querySelector('[data-skill-item-part="root"]')!.textContent).toBe('Claude');
  await press(row('side')!);
  await until(() => replyBox()!.value === 'play /side ', 'the reference in the reply');
  expect(askBox()).toBeNull();
});

const listChildren = () =>
  [...document.querySelector('[data-skill-menu] [data-skill-menu-list]')!.children].map((el) => ((el as HTMLElement).dataset.skillMenuDivider ? '|' : (el as HTMLElement).dataset.skillItem));
const options = () =>
  [...document.querySelectorAll<HTMLElement>('[data-skill-menu] [role="option"]')].map((el) => ({ name: el.dataset.skillItem, at: el.id.split('-option-')[1], builtin: el.dataset.skillItemHost === 'true' }));

test.skipIf(!hasDom)("the built-ins are one group above the person's skills: one hairline between two groups that both have rows, never otherwise, and the options are as before", async () => {
  const WALK: SkillCatalogEntry = { name: 'review-walkthrough', root: 'plannotator', description: 'A walkthrough of how something works', humanOnly: true };
  const WRITE: SkillCatalogEntry = { name: 'write-better', root: 'claude', description: 'Make the words clear.', humanOnly: false };
  await openReply(true, [WALK, SHAPE, READBACK, WRITE]);
  await type(replyBox()!, '/');
  await until(() => listed().length > 0, 'the "/" list');
  expect(listChildren()).toEqual(['review-walkthrough', 'shape', 'side', '|', 'readback', 'write-better']);
  const divider = document.querySelector<HTMLElement>('[data-skill-menu-divider]')!;
  expect(divider.getAttribute('aria-hidden')).toBe('true');
  expect(divider.getAttribute('role')).toBeNull();
  expect(divider.closest('[role="option"]')).toBeNull();
  expect(options()).toEqual([
    { name: 'review-walkthrough', at: '0', builtin: true },
    { name: 'shape', at: '1', builtin: true },
    { name: 'side', at: '2', builtin: true },
    { name: 'readback', at: '3', builtin: false },
    { name: 'write-better', at: '4', builtin: false },
  ]);

  const icon = (name: string) => row(name)!.querySelector('svg')!;
  expect(['review-walkthrough', 'shape', 'side', 'readback', 'write-better'].map((name) => icon(name).hasAttribute('data-plannotator-mark'))).toEqual([true, true, true, false, false]);
  const frame = (name: string) => `${icon(name).getAttribute('viewBox')} ${icon(name).getAttribute('aria-hidden')} ${['w-4', 'h-4', 'shrink-0'].filter((cls) => icon(name).classList.contains(cls)).join(' ')}`;
  for (const name of ['review-walkthrough', 'shape', 'side', 'write-better']) expect(frame(name)).toBe(frame('readback'));
  expect(frame('readback')).toBe('0 0 24 24 true w-4 h-4 shrink-0');
  expect(icon('side').classList.contains('text-primary')).toBe(true);
  expect(icon('side').outerHTML).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i);
  expect(row('side')!.textContent).toBe(`side${row('side')!.querySelector('[data-skill-item-part="description"]')!.textContent}Plannotator`);

  await type(replyBox()!, '/w');
  await type(replyBox()!, '/w');
  await until(() => listed().length === 3, 'the filtered list');
  expect(listChildren()).toEqual(['review-walkthrough', 'side', '|', 'write-better']);
  await key(replyBox()!, 'ArrowDown');
  await key(replyBox()!, 'ArrowDown');
  expect(replyBox()!.getAttribute('aria-activedescendant')).toBe(row('side')!.id);
  await key(replyBox()!, 'ArrowDown');
  expect(replyBox()!.getAttribute('aria-activedescendant')).toBe(row('write-better')!.id);
  await key(replyBox()!, 'ArrowDown');
  expect(replyBox()!.getAttribute('aria-activedescendant')).toBe(row('review-walkthrough')!.id);

  await type(replyBox()!, '/si');
  await until(() => listed().length === 1, 'only side');
  expect(listChildren()).toEqual(['side']);
  await type(replyBox()!, '/readb');
  await until(() => listed()[0] === 'readback', 'only a skill');
  expect(listChildren()).toEqual(['readback']);
});

test.skipIf(!hasDom)("only built-ins, or only the person's skills: no hairline", async () => {
  await openReply(true, [SHAPE]);
  await type(replyBox()!, '/');
  await until(() => listed().length > 0, 'the "/" list');
  expect(listChildren()).toEqual(['shape', 'side']);
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  await openReply(false, [READBACK]);
  await type(replyBox()!, '/');
  await until(() => listed().length > 0, 'the "/" list');
  expect(listChildren()).toEqual(['readback']);
  expect(options()).toEqual([{ name: 'readback', at: '0', builtin: false }]);
});
