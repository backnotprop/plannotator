/**
 * New message to several agents (swarm/useSwarmPicks.tsx, wired into the real ComposeDialog over a mocked fetch).
 * What this catches: Add an agent or the Swarm badge missing once To has an agent while Swarm is on, or drawn while it
 * is off; a second agent that replaces the first instead of joining it; a picked agent that is not checked in the
 * picker (so it cannot be taken out); the badge not putting `/swarm` in the words; and a Send that drops the other
 * agents (no `tags`), or sends `tags` while Swarm is off (the server refuses them then).
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt. Fetch is mocked: no server.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxProject } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { ComposeDialog } = (hasDom ? await import('../compose/ComposeDialog') : {}) as typeof import('../compose/ComposeDialog');
const { adoptSwarmOn } = (hasDom ? await import('./swarmOn') : {}) as typeof import('./swarmOn');

const PROJECT: InboxProject = { id: 'prj_1', key: 'ledger-abcdef', name: 'ledger', root: '/work/ledger', created_at: '2026-11-24T10:00:00.000Z' };
const live = (session: string, host: string) => ({ session, host, started_at: '2026-11-24T14:00:00.000Z', last_seen_at: '2026-11-24T15:00:00.000Z', busy: false, idle_since: null, last_thread: null });

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let posts: { path: string; body: Record<string, unknown> }[] = [];
/** The Inbox's answer to the Swarm tip's claim: shown (one test), else not. */
let revealShows = false;

beforeEach(() => {
  if (!hasDom) return;
  posts = [];
  revealShows = false;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === 'POST') {
      const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      posts.push({ path, body });
      if (path === '/api/inbox/messages') return Response.json({ thread_id: 'msg_01M4XXVG0ZCPSD10B1KPG7DPMZ' });
      if (path.includes('/reveal')) return Response.json({ show: revealShows && body.id === 'swarm_tip', reveal: { next: null }, board: { on: false }, steps: { on: false } });
      return Response.json({});
    }
    if (path.startsWith('/api/inbox/sessions')) {
      return Response.json({
        serverSession: 's',
        home: '/home/charlie',
        projects: [{ project: { id: PROJECT.id, name: PROJECT.name, root: PROJECT.root }, sessions: [live('ses_claude', 'claude-code'), live('ses_codex', 'codex'), live('ses_pi', 'pi')] }],
      });
    }
    if (path.startsWith('/api/inbox/skills')) return Response.json({ skills: [] });
    return Response.json({});
  }) as typeof fetch;
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = savedFetch;
  adoptSwarmOn(false);
});

const inDialog = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector('dialog[data-compose]')?.querySelector<T>(selector) ?? null;
const words = () => inDialog<HTMLTextAreaElement>('[data-compose-text] textarea')!;
const starts = () => posts.filter((p) => p.path === '/api/inbox/messages');

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 150; i++) {
    if (check()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
  throw new Error(`timed out waiting for ${what}`);
}

function type(input: HTMLTextAreaElement, text: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const click = (el: Element | null) => {
  if (!el) throw new Error('nothing to press');
  act(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
};

async function open(options: { phone?: boolean; onClose?: () => void } = {}) {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<ComposeDialog request={{ session: 'ses_claude' }} phone={options.phone ?? false} current={null} lastSent={null} home="/home/charlie" onSent={() => {}} onJoined={() => {}} onSaved={() => {}} onDeleted={() => {}} onClose={options.onClose ?? (() => {})} />);
  });
  await until(() => inDialog('[data-compose-to]:not([data-loading])') !== null, 'To');
}

test.skipIf(!hasDom)('the Swarm tip up, one Escape still closes New message', async () => {
  const { resetSwarmTipForTests } = await import('./useSwarmTip');
  resetSwarmTipForTests();
  revealShows = true;
  adoptSwarmOn(true);
  let closed = 0;
  await open({ onClose: () => (closed += 1) });
  click(inDialog('[data-compose-add-agent]'));
  click(document.querySelector('[data-compose-session="ses_codex"]'));
  for (let i = 0; i < 300 && !document.querySelector('[data-swarm-tip]'); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
  expect(document.querySelector('[data-swarm-tip]')).not.toBeNull();
  act(() => words().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  await until(() => closed > 0, 'New message closed');
  expect(closed).toBe(1);
});

test.skipIf(!hasDom)('the Swarm tip says only what is true today (no task list yet), and goes for good once Swarm is turned on', async () => {
  const { resetSwarmTipForTests } = await import('./useSwarmTip');
  resetSwarmTipForTests();
  revealShows = true;
  adoptSwarmOn(true);
  await open();
  click(inDialog('[data-compose-add-agent]'));
  click(document.querySelector('[data-compose-session="ses_codex"]'));
  // It shows once the badge has settled (about two seconds).
  for (let i = 0; i < 300 && !document.querySelector('[data-swarm-tip]'); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
  const tip = document.querySelector('[data-swarm-tip]')!;
  expect([...tip.querySelectorAll<HTMLElement>('[data-swarm-tip-line]')].map((l) => [l.dataset.swarmTipLine, l.textContent])).toEqual([
    ['together', 'Agents work together'],
    ['ghost', 'Ghost thread'],
  ]);
  // Typing `/swarm` turns it on as the badge does: the tip goes.
  type(words(), 'Refunds are off by a cent. /swarm ');
  await until(() => document.querySelector('[data-swarm-tip]') === null, 'the tip gone');
  expect(inDialog('[data-swarm-badge]')?.getAttribute('aria-pressed')).toBe('true');
});

test.skipIf(!hasDom)('a phone: the other agents sit inline after To in the foot\'s row, never a row of their own', async () => {
  adoptSwarmOn(true);
  await open({ phone: true });
  const foot = inDialog('.ib-cp-foot')!;
  const line = inDialog('[data-compose-swarm-line]')!;
  expect(line.parentElement).toBe(foot);
  expect(line.previousElementSibling?.matches('[data-compose-to]') || line.previousElementSibling?.querySelector('[data-compose-to]') !== null).toBe(true);
  expect(line.tagName).toBe('SPAN');
});

test.skipIf(!hasDom)('Swarm on: two more agents join To beside the first, each checked in the picker, the badge puts /swarm in the words, and Send carries them as tags', async () => {
  adoptSwarmOn(true);
  await open();
  expect(inDialog('[data-swarm-badge]')?.getAttribute('aria-pressed')).toBe('false');
  click(inDialog('[data-compose-add-agent]'));
  click(document.querySelector('[data-compose-session="ses_codex"]'));
  click(inDialog('[data-compose-add-agent]'));
  click(document.querySelector('[data-compose-session="ses_pi"]'));
  // The first stays in To; the others sit beside it.
  expect(inDialog('[data-compose-to]')?.textContent).toContain('Claude Code');
  expect([...document.querySelectorAll('[data-compose-also]')].map((el) => el.getAttribute('data-compose-also'))).toEqual(['ses_codex', 'ses_pi']);
  // Both are checked when the picker opens again, so a second press takes one out.
  click(inDialog('[data-compose-add-agent]'));
  expect(document.querySelector('[data-compose-session="ses_codex"] .ib-cp-check svg')).not.toBeNull();
  expect(document.querySelector('[data-compose-session="ses_pi"] .ib-cp-check svg')).not.toBeNull();
  click(document.querySelector('[data-compose-session="ses_pi"]'));
  expect(document.querySelector('[data-compose-also="ses_pi"]')).toBeNull();
  click(inDialog('[data-compose-add-agent]'));
  click(document.querySelector('[data-compose-session="ses_pi"]'));

  type(words(), 'Split the refunds work between you.');
  click(inDialog('[data-swarm-badge]'));
  expect(inDialog('[data-swarm-badge]')?.getAttribute('aria-pressed')).toBe('true');
  expect(words().value).toContain('/swarm');

  click(inDialog('[data-compose-send]'));
  await until(() => starts().length === 1, 'the send');
  const body = starts()[0]!.body;
  expect(body.to).toMatchObject({ session: 'ses_claude' });
  expect(body.tags).toEqual([
    { host: 'codex', session: 'ses_codex' },
    { host: 'pi', session: 'ses_pi' },
  ]);
});

test.skipIf(!hasDom)('an agent picked on another computer than the thread\'s is tagged with its computer; one on the thread\'s computer is not', async () => {
  const { swarmPickTags } = await import('./useSwarmPicks');
  const target = (session: string, host: string) => ({ ...live(session, host), root: PROJECT.root, project: { id: PROJECT.id, name: PROJECT.name, root: PROJECT.root } });
  const machines = [
    { key: 'here', machine: null },
    { key: 'ibx_studio', machine: 'ibx_studio' },
  ] as unknown as Parameters<typeof swarmPickTags>[1];
  const picks = [
    { target: target('ses_codex', 'codex'), machineKey: 'here' },
    { target: target('ses_far', 'pi'), machineKey: 'ibx_studio' },
  ];
  // A thread made on this computer: the far agent carries its computer.
  expect(swarmPickTags(picks, machines, null, 'ibx_self')).toEqual([
    { host: 'codex', session: 'ses_codex' },
    { host: 'pi', session: 'ses_far', machine: 'ibx_studio' },
  ]);
  // A thread made on the studio computer: this computer's agent is named by this computer's id, the studio's by none.
  expect(swarmPickTags(picks, machines, 'ibx_studio', 'ibx_self')).toEqual([
    { host: 'codex', session: 'ses_codex', machine: 'ibx_self' },
    { host: 'pi', session: 'ses_far' },
  ]);
});

test.skipIf(!hasDom)('Swarm off: New message has no Add an agent and no badge, and Send carries no tags', async () => {
  await open();
  expect(inDialog('[data-compose-add-agent]')).toBeNull();
  expect(inDialog('[data-swarm-badge]')).toBeNull();
  type(words(), 'Look at the refunds.');
  click(inDialog('[data-compose-send]'));
  await until(() => starts().length === 1, 'the send');
  expect('tags' in starts()[0]!.body).toBe(false);
});
