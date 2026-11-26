/**
 * Reactions on every agent message (approval "inbox-reactions-every-message", 2026-11-24), on the real ThreadPane:
 * - every live agent message has its face, an earlier one too; the person's messages have none;
 * - the pointer on the face opens it into 👍, the saved emoji and the face, and an emoji reacts on THAT message;
 * - a right-click anywhere in a message's body opens the one menu, emoji first; on a link or selected text it does not;
 * - a skill emoji carries the "/" mark and, pressed, sends a reply with exactly a typed `/bro` reply's words and its
 *   `skill_reaction`, never an ack; that reply draws as one line.
 * DOM (happy-dom): `DOM_TESTS=1 bun test packages/inbox/reactEveryMessage.test.tsx --isolate`.
 */
import { afterEach, beforeEach, expect, jest, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseInboxQuestionBlocks } from '@plannotator/core/inbox-questions';
import type { InboxAuthor, InboxMessageWire, InboxProject, InboxQuestion, InboxReaction, InboxThread } from '@plannotator/core/inbox-types';
import { resetSkillCatalogCache, resetSkillCatalogTransport, setSkillCatalogTransport } from '@plannotator/ui/utils/skillCatalog';
import { resetSavedReactionsForTests } from './reactions';
import { rememberLocal, rememberMachine } from './inboxUrl';
import { FACE_CLOSE_MS, FACE_OPEN_MS } from './thread/messageReact';
import { skillPreviewText } from './data/skillPreview';

const hasDom = typeof document !== 'undefined';
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');
const { PHONE_HOLD } = (hasDom ? await import('./thread/MessageReactHost') : { PHONE_HOLD: { opensSheet: false } }) as typeof import('./thread/MessageReactHost');

const PROJECT: InboxProject = { id: 'prj_1', key: 'fern-api-abcdef', name: 'fern-api', root: '/work/fern-api', created_at: '2026-11-24T09:00:00.000Z' };
const CLAUDE: Extract<InboxAuthor, { kind: 'agent' }> = { kind: 'agent', host: 'claude-code', session: 'ses_a', name: null };
const [M1, M2, M3, M4] = ['msg_01M8A00000000000000000001', 'msg_01M8A00000000000000000002', 'msg_01M8A00000000000000000003', 'msg_01M8A00000000000000000004'] as const;
const SAVED: InboxReaction[] = [{ emoji: '🎉', label: 'Ship it' }, { emoji: '😵‍💫', skill: 'bro' }];

const message = (id: string, author: InboxAuthor, body: string, minute: number, extra: Partial<InboxMessageWire> = {}): InboxMessageWire =>
  ({ id, thread_id: M1, project_id: PROJECT.id, reply_to: id === M1 ? null : M1, author, subject: id === M1 ? 'Duplicate webhooks after a retry' : null, body, created_at: `2026-11-24T14:${String(minute).padStart(2, '0')}:00.000Z`, resolved_at: null, idempotency_key: null, seq: minute, ...extra }) as InboxMessageWire;

function sample(extra: InboxMessageWire[] = []): InboxThread {
  return {
    thread_id: M1,
    project: PROJECT,
    subject: 'Duplicate webhooks after a retry',
    thread_name: 'webhooks',
    resolved_at: null,
    messages: [
      message(M1, CLAUDE, 'The duplicate webhooks come from the retry loop in `sender/retry.ts`.', 1),
      message(M2, { kind: 'person' }, 'Go. Keep the jitter under 2 s.', 2),
      message(M3, CLAUDE, 'Done. The run: [fern-api CI #482](https://ci.example.test/482).', 3),
      message(M4, CLAUDE, 'One more thing: the idempotency-key derivation is non-canonical over map ordering.', 4),
      ...extra,
    ],
  };
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let acks: { id: string; on: boolean; reaction: InboxReaction | null | undefined }[] = [];
let posts: { path: string; body: Record<string, unknown> }[] = [];
/** The agent each 👍 or emoji names (the toast's "Goes to <agent>"). */
let ackAgents: string[] = [];

beforeEach(() => {
  if (!hasDom) return;
  acks = [];
  ackAgents = [];
  posts = [];
  resetSavedReactionsForTests(SAVED);
  resetSkillCatalogCache();
  setSkillCatalogTransport(async () => [{ name: 'bro', root: 'claude', description: 'Say your last message simply', humanOnly: false }]);
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === 'POST') {
      posts.push({ path, body: JSON.parse(String(init.body ?? '{}')) });
      return Response.json({ reply: null, questions: [], replayed: false });
    }
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], annotations: [] });
    if (path.includes('/sessions')) return Response.json({ serverSession: 's', home: '/home/me', project: PROJECT, sessions: [] });
    return Response.json({});
  }) as typeof fetch;
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  document.querySelectorAll('.ib-pm-pos, .ib-pm-scrim, .ib-react-pos, .ib-skcard-pos').forEach((n) => n.remove());
  root = null;
  host = null;
  globalThis.fetch = savedFetch;
  resetSkillCatalogTransport();
  resetSkillCatalogCache();
  resetSavedReactionsForTests();
});

async function settle(times = 2) {
  for (let i = 0; i < times; i++) await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
}

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 60; i++) {
    if (check()) return;
    await settle(1);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function render(t: InboxThread, extra: { phone?: boolean } = {}) {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <ThreadPane
        thread={t}
        sent={null}
        lookSeq={0}
        onQuestions={() => {}}
        onChanged={async () => {}}
        onClose={() => {}}
        file={null}
        onOpenFile={() => {}}
        onOpenGuide={() => {}}
        onAck={(id, on, agent, reaction) => {
          acks.push({ id, on, reaction });
          ackAgents.push(agent);
        }}
        phone={extra.phone ?? false}
      />,
    );
  });
  await settle();
}

const face = (id: string) => document.querySelector<HTMLButtonElement>(`[data-react-face="${id}"]`);
const article = (id: string) => document.querySelector<HTMLElement>(`[data-message-article="${id}"]`)!;
const menu = () => document.querySelector<HTMLElement>('[data-message-menu][data-context]');

const pointer = (el: Element, type: 'over' | 'enter' | 'out' | 'leave') =>
  el.dispatchEvent(new PointerEvent(`pointer${type}`, { bubbles: type === 'over' || type === 'out', pointerType: 'mouse' }));

async function hoverFace(id: string) {
  await act(async () => void pointer(face(id)!, 'over'));
  await act(async () => void pointer(face(id)!, 'enter'));
  // The pointer rests on it past the intent delay.
  await act(async () => void (await new Promise((resolve) => setTimeout(resolve, FACE_OPEN_MS + 20))));
  await settle();
}

async function rightClick(el: Element) {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 300, clientY: 200 });
  await act(async () => void el.dispatchEvent(event));
  await settle();
  return event;
}

test.skipIf(!hasDom)('every open agent message has a face, an earlier one too; the person’s message has none', async () => {
  await render(sample());
  // M1 is folded to one line here (no text line to sit on); M3 is an earlier agent message than M4.
  expect(face(M3)).not.toBeNull();
  expect(face(M4)).not.toBeNull();
  expect(face(M2)).toBeNull();
  // Not a tab stop: the keyboard reaches reactions through ⋯.
  expect(face(M3)!.tabIndex).toBe(-1);
});

test.skipIf(!hasDom)('the pointer on an earlier message’s face opens it into the emoji; 🎉 reacts on that message', async () => {
  await render(sample());
  await hoverFace(M3);
  await until(() => !!document.querySelector(`[data-react-strip="${M3}"]`), 'the face opened');
  const strip = document.querySelector<HTMLElement>(`[data-react-strip="${M3}"]`)!;
  // Inside the face's own slot (no positioning), 👍, the saved emoji, then the face.
  expect(strip.parentElement?.getAttribute('data-react-face-slot')).toBe(M3);
  const cells = [...strip.querySelectorAll<HTMLButtonElement>('button')];
  expect(cells.map((c) => c.querySelector('.ib-react-e')?.textContent ?? 'face')).toEqual(['👍', '🎉', '😵‍💫', 'face']);
  expect(cells[2]!.querySelector('.ib-skillmark')).not.toBeNull();
  expect(cells[1]!.querySelector('.ib-skillmark')).toBeNull();
  await act(async () => cells[1]!.click());
  expect(acks).toEqual([{ id: M3, on: true, reaction: { emoji: '🎉', label: 'Ship it' } }]);
});

test.skipIf(!hasDom)('the face at the end of the opened face opens the full tray at the first press', async () => {
  await render(sample());
  await hoverFace(M3);
  await until(() => !!document.querySelector(`[data-react-strip="${M3}"]`), 'the face opened');
  await act(async () => document.querySelector<HTMLButtonElement>('[data-react-all]')!.click());
  await until(() => !!document.querySelector('[data-reaction-tray]'), 'the full tray');
  expect(document.querySelector(`[data-react-strip="${M3}"]`)).toBeNull();
});

test.skipIf(!hasDom)('a right-click in a message’s body opens the one menu, emoji first; a link keeps the browser’s menu', async () => {
  await render(sample());
  const event = await rightClick(article(M3).querySelector('.ib-msg p, .ib-msg')!);
  expect(event.defaultPrevented).toBe(true);
  await until(() => !!menu(), 'the message menu');
  expect(menu()!.getAttribute('data-message-menu')).toBe(M3);
  const reactions = [...menu()!.querySelectorAll('[data-menu-reaction]')].map((el) => el.getAttribute('data-menu-reaction'));
  expect(reactions).toEqual(['👍', '🎉', '😵‍💫', 'all']);
  const labels = [...menu()!.querySelectorAll('[role="menuitem"].ib-pmi')].map((el) => el.textContent?.trim());
  expect(labels).toEqual(['Reply', 'New thread from this message', 'Copy message', 'Copy link to message', 'Copy thread']);
  await act(async () => (menu()!.querySelector('[data-menu-reaction="👍"]') as HTMLElement).click());
  expect(acks).toEqual([{ id: M3, on: true, reaction: null }]);
  await until(() => !menu(), 'the menu to close');
  // On a link: the browser's own menu (Open link, Copy link).
  const onLink = await rightClick(article(M3).querySelector('a[href]')!);
  expect(onLink.defaultPrevented).toBe(false);
  expect(menu()).toBeNull();
});

test.skipIf(!hasDom)('a right-click on selected text keeps the browser’s menu', async () => {
  await render(sample());
  const text = article(M4).querySelector('.ib-msg p, .ib-msg')!;
  const range = document.createRange();
  range.selectNodeContents(text);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  const event = await rightClick(text);
  expect(event.defaultPrevented).toBe(false);
  expect(menu()).toBeNull();
  window.getSelection()!.removeAllRanges();
});

test.skipIf(!hasDom)('a skill emoji sends a reply with a typed /bro reply’s words and skill_reaction, never an ack', async () => {
  await render(sample());
  await rightClick(article(M3).querySelector('.ib-msg')!);
  await until(() => !!menu(), 'the message menu');
  await act(async () => (menu()!.querySelector('[data-menu-reaction="😵‍💫"]') as HTMLElement).click());
  await until(() => posts.some((p) => p.path.endsWith('/reply')), 'the reply');
  expect(acks).toEqual([]);
  const sent = posts.find((p) => p.path.endsWith('/reply'))!;
  expect(sent.path).toContain(M3);
  expect(sent.body.words).toBe('/bro');
  expect(sent.body.skill_reaction).toEqual({ emoji: '😵‍💫', skill: 'bro' });
  expect(String(sent.body.feedback)).toStartWith('**Skills referenced** (the person is asking you to invoke these skills when acting on this reply):');
  expect(String(sent.body.feedback)).toContain('`bro`');
  // An earlier message (the agent wrote M4 after it): the reply quotes it, so the agent knows what "/bro" is about.
  expect((sent.body.quote as { of: string }).of).toBe(M3);
});

test.skipIf(!hasDom)('a skill emoji on the newest agent message quotes nothing, as a plain reply', async () => {
  await render(sample());
  await rightClick(article(M4).querySelector('.ib-msg')!);
  await until(() => !!menu(), 'the message menu');
  await act(async () => (menu()!.querySelector('[data-menu-reaction="😵‍💫"]') as HTMLElement).click());
  await until(() => posts.some((p) => p.path.endsWith('/reply')), 'the reply');
  const sent = posts.find((p) => p.path.endsWith('/reply'))!;
  expect(sent.path).toContain(M4);
  expect(sent.body.quote).toBeUndefined();
});

test.skipIf(!hasDom)('on a linked machine’s thread, a skill this computer lacks is read from that machine and its text travels in the reply', async () => {
  const far = 'ibx_01M8A00000000000000000FAR1';
  const t = sample();
  rememberMachine([t.thread_id, ...t.messages.map((m) => m.id)], far);
  resetSavedReactionsForTests([{ emoji: '🧪', label: 'Test it', skill: 'test-it' }]);
  const local = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path === `/api/inbox/m/${far}/skills`) return Response.json({ skills: [{ name: 'test-it', root: 'claude', description: 'Run it and show me', humanOnly: true }] });
    if (path.startsWith(`/api/inbox/m/${far}/skills/content`)) return Response.json({ skill: { name: 'test-it', content: 'Run the change for real before you say it works.', dir: '/home/far/.claude/skills/test-it', path: '/home/far/.claude/skills/test-it/SKILL.md' } });
    return local(input, init);
  }) as typeof fetch;
  try {
    await render(t);
    await rightClick(article(M3).querySelector('.ib-msg')!);
    await until(() => !!menu(), 'the message menu');
    await act(async () => (menu()!.querySelector('[data-menu-reaction="🧪"]') as HTMLElement).click());
    await until(() => posts.some((p) => p.path.endsWith('/reply')), 'the reply');
    const sent = posts.find((p) => p.path.endsWith('/reply'))!;
    expect(sent.path).toBe(`/api/inbox/m/${far}/messages/${M3}/reply`);
    expect(sent.body.words).toBe('/test-it');
    expect(String(sent.body.feedback)).toContain('--- BEGIN SKILL INSTRUCTIONS: test-it ---');
    expect(String(sent.body.feedback)).toContain('Run the change for real before you say it works.');
  } finally {
    rememberLocal([t.thread_id, ...t.messages.map((m) => m.id)]);
  }
});

test.skipIf(!hasDom)('a skill reaction’s reply draws as one line: You, the emoji and /bro, with no words under it', async () => {
  const reply = message('msg_01M8A00000000000000000005', { kind: 'person' }, '/bro\n\n**Skills referenced** (the person is asking you to invoke these skills when acting on this reply):\n- `bro`', 5, {
    reply_to: M4,
    skill_reaction: { emoji: '😵‍💫', skill: 'bro' },
  } as Partial<InboxMessageWire>);
  await render(sample([reply]));
  const row = article(reply.id);
  expect(row.querySelector('[data-skill-reaction="bro"]')?.textContent).toBe('😵‍💫/bro');
  expect(row.textContent).not.toContain('Skills referenced');
  expect(face(reply.id)).toBeNull();
});

const strip = (id: string) => document.querySelector<HTMLElement>(`[data-react-strip="${id}"]`);
const M5 = 'msg_01M8A00000000000000000005';
const ASK = 'Which retry cap?\n\n:::question\nKeep the cap at 3?\n\n- [ ] Yes\n- [ ] No\n:::';

/** An agent message with its question open, as the thread read serves it. */
function asking(): InboxMessageWire {
  const questions = parseInboxQuestionBlocks(ASK).map(
    (q) =>
      ({
        key: q.key, position: q.position, kind: q.kind, prompt: q.prompt, context: q.parsed.context, choices: q.parsed.choices,
        recommendation: q.parsed.recommendation, suggested_text: q.parsed.suggested_text, stopped: q.stopped, holds_up: q.holds_up,
        asked_by_agent_id: CLAUDE.session, orphaned: false, state: 'open', answer: null, revision: 1, sent_revision: 0, picked_by: null,
        picked_at: null, sent_reply_id: null, message_id: M5, superseded_by: null,
      }) as unknown as InboxQuestion,
  );
  return message(M5, CLAUDE, ASK, 5, { questions } as Partial<InboxMessageWire>);
}

test.skipIf(!hasDom)('the opened face: a flick across it opens nothing; it stays open from face to strip and closes off both, on a press outside, a scroll and Escape', async () => {
  await render(sample());
  jest.useFakeTimers();
  try {
    const f = face(M3)!;
    // A flick: on and off inside the intent delay.
    act(() => void pointer(f, 'over'));
    act(() => void jest.advanceTimersByTime(FACE_OPEN_MS - 40));
    act(() => void pointer(f, 'out'));
    act(() => void jest.advanceTimersByTime(FACE_OPEN_MS * 3));
    expect(strip(M3)).toBeNull();
    // Resting on it opens it.
    act(() => void pointer(f, 'over'));
    act(() => void jest.advanceTimersByTime(FACE_OPEN_MS));
    expect(strip(M3)).not.toBeNull();
    // From the face onto the strip inside the grace: it stays open.
    act(() => void f.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse', relatedTarget: strip(M3)!.querySelector('button') })));
    act(() => void jest.advanceTimersByTime(FACE_CLOSE_MS * 3));
    expect(strip(M3)).not.toBeNull();
    // Off both: closed after the grace.
    act(() => void pointer(strip(M3)!.querySelector('button')!, 'out'));
    act(() => void jest.advanceTimersByTime(FACE_CLOSE_MS));
    expect(strip(M3)).toBeNull();

    const open = () => {
      act(() => void pointer(f, 'over'));
      act(() => void jest.advanceTimersByTime(FACE_OPEN_MS));
      expect(strip(M3)).not.toBeNull();
    };
    open();
    // A press inside it keeps it; one outside closes it.
    act(() => void strip(M3)!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' })));
    expect(strip(M3)).not.toBeNull();
    act(() => void article(M1).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' })));
    expect(strip(M3)).toBeNull();
    act(() => void pointer(f, 'out'));
    open();
    act(() => void article(M4).parentElement!.dispatchEvent(new Event('scroll')));
    expect(strip(M3)).toBeNull();
    act(() => void pointer(f, 'out'));
    open();
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(strip(M3)).toBeNull();
  } finally {
    jest.useRealTimers();
  }
});

test.skipIf(!hasDom)('while a question waits: the face and the menu offer only skill emoji, and a plain one is never sent', async () => {
  await render(sample([asking()]));
  // The foot's 👍 is hidden, as it always was.
  expect(document.querySelector('.ib-pfoot [data-ack]')).toBeNull();
  await hoverFace(M3);
  await until(() => !!strip(M3), 'the face opened');
  const cells = [...strip(M3)!.querySelectorAll<HTMLButtonElement>('button')];
  expect(cells.map((c) => c.querySelector('.ib-react-e')?.textContent ?? 'face')).toEqual(['😵‍💫']);
  await rightClick(article(M4).querySelector('.ib-msg')!);
  await until(() => !!menu(), 'the message menu');
  expect([...menu()!.querySelectorAll('[data-menu-reaction]')].map((el) => el.getAttribute('data-menu-reaction'))).toEqual(['😵‍💫']);
  // The rest of the menu is all there.
  expect([...menu()!.querySelectorAll('[role="menuitem"].ib-pmi')].map((el) => el.textContent?.trim())).toEqual(['Reply', 'New thread from this message', 'Copy message', 'Copy link to message', 'Copy thread']);
  await act(async () => (menu()!.querySelector('[data-menu-reaction="😵‍💫"]') as HTMLElement).click());
  await until(() => posts.some((p) => p.path.endsWith('/reply')), 'the reply');
  expect(acks).toEqual([]);
});

test.skipIf(!hasDom)('while a question waits and no saved emoji has a skill: no face, and no emoji row in the menu', async () => {
  resetSavedReactionsForTests([{ emoji: '🎉', label: 'Ship it' }]);
  await render(sample([asking()]));
  expect(face(M3)).toBeNull();
  expect(face(M4)).toBeNull();
  await rightClick(article(M4).querySelector('.ib-msg')!);
  await until(() => !!menu(), 'the message menu');
  expect(menu()!.querySelector('[data-menu-reactions]')).toBeNull();
  expect(acks).toEqual([]);
});

test.skipIf(!hasDom)('a phone, as it ships (`PHONE_HOLD.opensSheet` false): a hold is the browser’s (text selection works); no sheet opens', async () => {
  expect(PHONE_HOLD.opensSheet).toBe(false);
  await render(sample(), { phone: true });
  const text = article(M3).querySelector('.ib-msg')!;
  jest.useFakeTimers();
  try {
    act(() => void text.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', clientX: 40, clientY: 40 })));
    act(() => void jest.advanceTimersByTime(900));
  } finally {
    jest.useRealTimers();
  }
  await settle();
  expect(menu()).toBeNull();
  const select = new Event('selectstart', { bubbles: true, cancelable: true });
  text.dispatchEvent(select);
  expect(select.defaultPrevented).toBe(false);
  const press = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  text.dispatchEvent(press);
  expect(press.defaultPrevented).toBe(false);
});

test.skipIf(!hasDom)('a phone (no face): “All reactions” in an earlier message’s ⋯ opens the tray, and its emoji reacts on that message', async () => {
  await render(sample(), { phone: true });
  expect(face(M3)).toBeNull();
  const more = () => document.querySelector<HTMLButtonElement>(`[data-message-more="${M3}"]`);
  await act(async () => more()!.click());
  await until(() => !!document.querySelector(`[data-message-menu="${M3}"] [data-menu-reaction="all"]`), 'the message’s sheet');
  await act(async () => document.querySelector<HTMLElement>(`[data-message-menu="${M3}"] [data-menu-reaction="all"]`)!.click());
  await until(() => !!document.querySelector('[data-reaction-tray]'), 'the full tray');
  // Opened from that message's ⋯, in its place.
  expect(document.querySelector('[data-reaction-tray]')!.closest('.ib-react-pos') !== null).toBe(true);
  await act(async () => document.querySelector<HTMLElement>('[data-reaction-tray] [data-reaction="saved-0"]')!.click());
  expect(acks).toEqual([{ id: M3, on: true, reaction: { emoji: '🎉', label: 'Ship it' } }]);
});

test.skipIf(!hasDom)('a phone with `PHONE_HOLD.opensSheet` on: a still hold opens the message’s sheet', async () => {
  PHONE_HOLD.opensSheet = true;
  try {
    await render(sample(), { phone: true });
    const text = article(M3).querySelector('.ib-msg')!;
    jest.useFakeTimers();
    try {
      act(() => void text.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', clientX: 40, clientY: 40 })));
      act(() => void jest.advanceTimersByTime(500));
    } finally {
      jest.useRealTimers();
    }
    await until(() => !!document.querySelector(`[data-message-menu="${M3}"]`), 'the sheet');
  } finally {
    PHONE_HOLD.opensSheet = false;
  }
});

test.skipIf(!hasDom)('a skill that needs a reviewed thread is sent as words in a thread with no review, as a typed reply sends it', async () => {
  resetSavedReactionsForTests([{ emoji: '🔁', skill: 'review-recheck' }]);
  resetSkillCatalogCache();
  setSkillCatalogTransport(async () => [{ name: 'review-recheck', root: 'plannotator', description: 'Check the fixes', humanOnly: false }]);
  await render(sample());
  await rightClick(article(M4).querySelector('.ib-msg')!);
  await until(() => !!menu(), 'the message menu');
  await act(async () => (menu()!.querySelector('[data-menu-reaction="🔁"]') as HTMLElement).click());
  await until(() => posts.some((p) => p.path.endsWith('/reply')), 'the reply');
  const sent = posts.find((p) => p.path.endsWith('/reply'))!;
  expect(sent.body.words).toBe('/review-recheck');
  expect(sent.body.feedback).toBeUndefined();
});

test.skipIf(!hasDom)('a skill emoji’s card on a linked machine’s thread reads a skill this computer lacks from that machine', async () => {
  const far = 'ibx_01M8A00000000000000000FAR2';
  const local = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path === `/api/inbox/m/${far}/skills`) return Response.json({ skills: [{ name: 'test-it', root: 'claude', description: 'Run it and show me', humanOnly: true }] });
    if (path.startsWith(`/api/inbox/m/${far}/skills/content`)) return Response.json({ skill: { name: 'test-it', content: 'Run the change for real before you say it works.', dir: '/home/far/.claude/skills/test-it', path: '/home/far/.claude/skills/test-it/SKILL.md' } });
    return local(input, init);
  }) as typeof fetch;
  const read = await skillPreviewText('test-it', far);
  expect(read).toMatchObject({ description: 'Run it and show me', missing: false });
  expect(read.excerpt).toContain('Run the change for real');
  expect((await skillPreviewText('test-it-nowhere', far)).missing).toBe(true);
});

test.skipIf(!hasDom)("a script's message (no session, host or name): its face, its 👍 and its skill emoji name Script, as its head does", async () => {
  const script: InboxAuthor = { kind: 'agent', host: null, session: null, name: null };
  await render({ ...sample(), messages: [message(M1, script, 'Disk at 91% on node 3.', 1), message(M2, script, 'Disk at 93% on node 3.', 2)] });
  await hoverFace(M1);
  await until(() => !!strip(M1), 'the face opened');
  expect(strip(M1)!.getAttribute('aria-label')).toBe("React to Script's message");
  await act(async () => strip(M1)!.querySelector<HTMLButtonElement>('button')!.click());
  expect(acks).toEqual([{ id: M1, on: true, reaction: null }]);
  expect(ackAgents).toEqual(['Script']);
  // The menu's skill emoji: said sent to Script.
  await rightClick(article(M2).querySelector('.ib-msg')!);
  await until(() => !!menu(), 'the message menu');
  await act(async () => (menu()!.querySelector('[data-menu-reaction="😵‍💫"]') as HTMLElement).click());
  await until(() => document.querySelector('[data-fold-live]')?.textContent === 'Sent /bro to Script.', 'the skill said sent to Script');
});
