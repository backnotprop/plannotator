/**
 * Reactions on every agent message (approval "inbox-reactions-every-message", 2026-11-24), on the real ThreadPane:
 * - every live agent message has its face, an earlier one too; the person's messages have none;
 * - the pointer on the face opens it into 👍, the saved emoji and the face, and an emoji reacts on THAT message;
 * - a right-click anywhere in a message's body opens the one menu, emoji first; on a link or selected text it does not;
 * - a skill emoji carries the "/" mark and, pressed, sends a reply with exactly a typed `/bro` reply's words and its
 *   `skill_reaction`, never an ack; that reply draws as one line.
 * DOM (happy-dom): `DOM_TESTS=1 bun test packages/inbox/reactEveryMessage.test.tsx --isolate`.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAuthor, InboxMessageWire, InboxProject, InboxReaction, InboxThread } from '@plannotator/core/inbox-types';
import { resetSkillCatalogCache, resetSkillCatalogTransport, setSkillCatalogTransport } from '@plannotator/ui/utils/skillCatalog';
import { resetSavedReactionsForTests } from './reactions';

const hasDom = typeof document !== 'undefined';
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');

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

beforeEach(() => {
  if (!hasDom) return;
  acks = [];
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

async function render(t: InboxThread) {
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
        onAck={(id, on, _agent, reaction) => acks.push({ id, on, reaction })}
      />,
    );
  });
  await settle();
}

const face = (id: string) => document.querySelector<HTMLButtonElement>(`[data-react-face="${id}"]`);
const article = (id: string) => document.querySelector<HTMLElement>(`[data-message-article="${id}"]`)!;
const menu = () => document.querySelector<HTMLElement>('[data-message-menu][data-context]');

async function hoverFace(id: string) {
  await act(async () => void face(id)!.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' })));
  await act(async () => void face(id)!.dispatchEvent(new PointerEvent('pointerenter', { bubbles: false, pointerType: 'mouse' })));
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
