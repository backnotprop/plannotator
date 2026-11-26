/**
 * Settings → Machines' rows for linking two computers through a third ("Link two computers through a third" in
 * docs/agent-guides/inbox-machines.md), on the window's own Machines section. On Studio (linked to both): one row
 * per two links not linked to each other, "Laptop and Mini", with Link. On Laptop: "Mini · through Studio", with
 * Link. What regresses: a row missing, or drawn with nothing to link; Link sending the wrong computers, or more than
 * one request; no "Linking…" at the click; an away computer not named; a refusal not said, or Link not offered again;
 * a row left after the two are linked; a second button stacked in a row.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { LinkThroughView } from '@plannotator/core/inbox-link-through';
import type { MachineView } from './api';

const hasDom = typeof document !== 'undefined';
const { MachinesSection } = (hasDom ? await import('./components/Machines') : {}) as typeof import('./components/Machines');

const STUDIO = `ibx_${'0'.repeat(25)}S`;
const LAPTOP = `ibx_${'0'.repeat(25)}A`;
const MINI = `ibx_${'0'.repeat(25)}M`;
const SINCE = '2026-11-24T10:42:00.000Z';

function machine(id: string, name: string, extra: Partial<MachineView> = {}): MachineView {
  return { id, name, self: false, state: 'online', since: SINCE, reason: null, version: '0.29.1', address: null, both_ways: true, waiting: 0, ...extra };
}
const self = (id: string, name: string, view: LinkThroughView) => machine(id, name, { self: true, link_through: view });

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
const posted: { url: string; body: Record<string, unknown> }[] = [];
let refuse: string | null = null;

beforeEach(() => {
  if (!hasDom) return;
  posted.length = 0;
  refuse = null;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if ((init?.method ?? 'GET') === 'GET') return new Response(JSON.stringify(url.endsWith('/outbox') ? { waiting: [], notices: [] } : {}), { status: 200 });
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    posted.push({ url, body });
    if (refuse) return new Response(JSON.stringify({ error: refuse, code: 'machine_needs_update' }), { status: 409 });
    return new Response(JSON.stringify({ job: { state: 'waiting' } }), { status: 200 });
  }) as typeof fetch;
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = '';
  globalThis.fetch = savedFetch;
});

function mount(machines: MachineView[], onChanged = () => {}) {
  if (!host) {
    host = document.createElement('div');
    host.className = 'pn-inbox';
    document.body.append(host);
    root = createRoot(host);
  }
  act(() => root!.render(<MachinesSection machines={machines} onChanged={onChanged} />));
}

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
}

const rows = () => [...document.querySelectorAll<HTMLElement>('[data-link-through]')];
const line = (el: HTMLElement) => el.querySelector('.ib-desc')!.textContent;
const label = (el: HTMLElement) => el.querySelector('.ib-l')!.textContent;
const button = (el: HTMLElement) => el.querySelectorAll<HTMLButtonElement>('button');

const pairs = (status: LinkThroughView['pairs'][number]['status'] = 'idle', extra: Partial<LinkThroughView['pairs'][number]> = {}): LinkThroughView => ({
  pairs: [{ a: { id: LAPTOP, name: 'Laptop' }, c: { id: MINI, name: 'Mini' }, status, waiting_for: null, why: null, ...extra }],
  through: [],
});
const through = (status: LinkThroughView['through'][number]['status'] = 'idle', extra: Partial<LinkThroughView['through'][number]> = {}): LinkThroughView => ({
  pairs: [],
  through: [{ id: MINI, name: 'Mini', via: { id: STUDIO, name: 'Studio' }, status, waiting_for: null, why: null, ...extra }],
});

test.skipIf(!hasDom)('on the computer linked to both: one row for the two, with one Link that sends both and says Linking… at once', async () => {
  let changed = 0;
  mount([self(STUDIO, 'Studio', pairs()), machine(LAPTOP, 'Laptop'), machine(MINI, 'Mini')], () => changed++);
  expect(rows()).toHaveLength(1);
  const row = rows()[0]!;
  expect(label(row)).toBe('Laptop and Mini');
  expect(line(row)).toBe('Linked here, not to each other');
  expect(button(row)).toHaveLength(1);
  act(() => button(row)[0]!.click());
  expect(line(rows()[0]!)).toBe('Linking…');
  expect(button(rows()[0]!)).toHaveLength(0);
  await settle();
  expect(posted).toEqual([{ url: '/api/inbox/machines/link-through', body: { a: LAPTOP, c: MINI } }]);
  expect(changed).toBe(1);
  // The view says it waits for Mini: the row names it.
  mount([self(STUDIO, 'Studio', pairs('waiting', { waiting_for: 'Mini' })), machine(LAPTOP, 'Laptop'), machine(MINI, 'Mini', { state: 'offline' })]);
  expect(line(rows()[0]!)).toBe('Waiting for Mini: this links when Mini is back.');
  expect(button(rows()[0]!)).toHaveLength(0);
  // Linked: the row goes, and Mini is an ordinary linked row.
  mount([self(STUDIO, 'Studio', { pairs: [], through: [] }), machine(LAPTOP, 'Laptop'), machine(MINI, 'Mini')]);
  expect(rows()).toHaveLength(0);
  expect(document.querySelectorAll('[data-machine-row]')).toHaveLength(2);
});

test.skipIf(!hasDom)('on one of the two: "Mini · through Studio", whose Link asks Studio for Mini', async () => {
  mount([self(LAPTOP, 'Laptop', through()), machine(STUDIO, 'Studio')]);
  const row = rows()[0]!;
  expect(label(row)).toBe('Mini · through Studio');
  expect(line(row)).toBe('Linked to Studio, not to this computer');
  act(() => button(row)[0]!.click());
  await settle();
  expect(posted).toEqual([{ url: '/api/inbox/machines/link-through', body: { via: STUDIO, with: MINI } }]);
  // Studio asleep at the click: the ask waits for it.
  mount([self(LAPTOP, 'Laptop', through('waiting', { waiting_for: 'Studio' })), machine(STUDIO, 'Studio', { state: 'offline' })]);
  expect(line(rows()[0]!)).toBe('Waiting for Studio: this links when Studio is back.');
  // After linking, Mini is an ordinary linked row and the through row is gone.
  mount([self(LAPTOP, 'Laptop', { pairs: [], through: [] }), machine(STUDIO, 'Studio'), machine(MINI, 'Mini')]);
  expect(rows()).toHaveLength(0);
  expect([...document.querySelectorAll('[data-machine-row]')].map((el) => el.getAttribute('data-machine-row'))).toEqual([STUDIO, MINI]);
});

test.skipIf(!hasDom)('a refusal is said on the row and Link is offered again; a failed job says why', async () => {
  refuse = 'Update Plannotator on Mini to link it this way.';
  mount([self(STUDIO, 'Studio', pairs()), machine(LAPTOP, 'Laptop'), machine(MINI, 'Mini')]);
  act(() => button(rows()[0]!)[0]!.click());
  await settle();
  expect(line(rows()[0]!)).toBe('Not linked: Update Plannotator on Mini to link it this way.');
  expect(button(rows()[0]!)).toHaveLength(1);
  mount([self(STUDIO, 'Studio', pairs('failed', { why: 'This link code is no longer open.' })), machine(LAPTOP, 'Laptop'), machine(MINI, 'Mini')]);
  expect(line(rows()[0]!)).toBe('Not linked: Update Plannotator on Mini to link it this way.');
});

test.skipIf(!hasDom)('a failed job from the server says why, with Link to try again', () => {
  mount([self(STUDIO, 'Studio', pairs('failed', { why: 'This link code is no longer open.' })), machine(LAPTOP, 'Laptop'), machine(MINI, 'Mini')]);
  expect(line(rows()[0]!)).toBe('Not linked: This link code is no longer open.');
  expect(button(rows()[0]!)).toHaveLength(1);
});

test.skipIf(!hasDom)('nothing to link: no rows, and an older Inbox (no link_through) draws none either', () => {
  mount([self(STUDIO, 'Studio', { pairs: [], through: [] }), machine(LAPTOP, 'Laptop')]);
  expect(rows()).toHaveLength(0);
  mount([machine(STUDIO, 'Studio', { self: true }), machine(LAPTOP, 'Laptop')]);
  expect(rows()).toHaveLength(0);
});
