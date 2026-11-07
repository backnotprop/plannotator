/**
 * Tag agents in a reply (approval "inbox-tag-agents", Lines variant), as the
 * window draws it: the whole window (InboxApp) over a REAL Inbox in a temp
 * data dir (its own process, tests/helpers/inbox-dom-server.ts `tags`, with
 * live connections polling as the mod, Pi and OpenCode do, a Pi on an older
 * Plannotator, and Codex through MCP only). What is proved: `@` opens the
 * live sessions grouped by agent with the owner first and the MCP agents
 * last, as a listbox the field controls; nothing is active until arrowed
 * onto; a pick inserts the readable `@Pi` and says what it means; a session on
 * an older Plannotator cannot be picked and says to update; the one line under
 * the field says Send asks the agents tagged (approval "inbox-tag-handoff",
 * A2) and which cannot be woken; Send carries the
 * tags; the sent reply shows one line per agent, each with its own Send now;
 * the thread head and the row show the agents' marks.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { InboxListSection, InboxMessageWire } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { InboxApp } = (hasDom ? await import('./App') : {}) as typeof import('./App');

const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');

type Tags = { ids: { t1: string; t1msg: string; t2: string; r2: string; t3: string }; sessions: Record<string, string> };
let child: ReturnType<typeof Bun.spawn> | null = null;
let port = 0;
let tags: Tags;
let dir: string | null = null;
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedEventSource: unknown;
let posted: { path: string; body: Record<string, unknown> }[] = [];

function loopback(path: string, method = 'GET', body?: string): Promise<{ status: number; text: string }> {
  return new Promise((done, fail) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { 'Content-Type': 'application/json', Host: `127.0.0.1:${port}` } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => done({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', fail);
    if (body) req.write(body);
    req.end();
  });
}

async function api<T>(path: string): Promise<T> {
  return JSON.parse((await loopback(path)).text) as T;
}

async function serverMessages(threadId: string): Promise<InboxMessageWire[]> {
  return (await api<{ thread: { messages: InboxMessageWire[] } }>(`/api/inbox/threads/${threadId}`)).thread.messages;
}

beforeAll(async () => {
  if (!hasDom) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-tags-dom-')));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'tailscale'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(dir, 'bin', 'tailscale'), 0o755);
  child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), '1', 'tags'], {
    env: { ...process.env, DOM_TESTS: '0', PLANNOTATOR_DATA_DIR: join(dir, 'data'), HOME: dir, PATH: `${join(dir, 'bin')}:${process.env.PATH}` },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
  let line = '';
  while (!line.includes('\n')) {
    const { value, done } = await reader.read();
    if (done) throw new Error('the Inbox did not start');
    line += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  const started = JSON.parse(line.trim()) as { port: number; tags: Tags };
  port = started.port;
  tags = started.tags;
});

afterAll(async () => {
  if (!hasDom) return;
  child?.kill();
  await child?.exited;
  child = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? String(init.body) : undefined;
    if (method === 'POST') posted.push({ path, body: body ? JSON.parse(body) : {} });
    const answer = await loopback(path, method, body);
    return new Response(answer.text, { status: answer.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  savedEventSource = (globalThis as Record<string, unknown>).EventSource;
  (globalThis as Record<string, unknown>).EventSource = class {
    addEventListener() {}
    close() {}
  };
  posted = [];
  window.location.hash = '';
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = savedFetch;
  (globalThis as Record<string, unknown>).EventSource = savedEventSource;
});

async function settle(ms = 40) {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, ms));
    });
  }
}

async function until(check: () => boolean | Promise<boolean>, what: string) {
  for (let i = 0; i < 120; i++) {
    if (await check()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function renderApp(hash = '') {
  window.location.hash = hash;
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<InboxApp />);
  });
  await settle();
  return host;
}

async function type(el: HTMLTextAreaElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
  await act(async () => {
    if (setter) setter.call(el, value);
    else el.value = value;
    el.selectionStart = el.selectionEnd = value.length;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: value.slice(-1) || 'a', bubbles: true }));
  });
  await settle(10);
}

async function press(el: HTMLElement, key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  await act(async () => {
    el.dispatchEvent(event);
  });
  await settle(10);
  return event;
}

const replyBox = (el: HTMLElement) => el.querySelector('section.ib-pane .ib-rbox textarea[aria-label^="Reply to"]') as HTMLTextAreaElement | null;
const picker = () => document.querySelector('[data-tag-picker]');
const optionIds = () => [...document.querySelectorAll('[data-tag-option]')].map((o) => o.getAttribute('data-tag-option'));
const groups = () => [...document.querySelectorAll('[data-tag-picker] [role="group"]')].map((g) => g.getAttribute('data-tag-group'));

async function openReply(el: HTMLElement): Promise<HTMLTextAreaElement> {
  await until(() => el.querySelector('section.ib-pane .ib-pfoot') !== null, 'the thread');
  const reply = [...el.querySelectorAll('section.ib-pane .ib-pfoot button')].find((b) => b.textContent?.trim() === 'Reply') as HTMLButtonElement;
  act(() => reply.click());
  await until(() => replyBox(el) !== null, 'the reply box');
  // The live sessions and the MCP agents are read once the box is open.
  await settle(60);
  return replyBox(el)!;
}

test.skipIf(!hasDom)('@ opens the agents grouped by agent, the owner first and the MCP agents last; nothing is active until arrowed onto; a pick inserts @Pi and says what it means', async () => {
  const el = await renderApp(`#thread=${tags.ids.t1}`);
  const box = await openReply(el);
  await type(box, 'Queue it, and cap retries at 5. @');
  await until(() => picker() !== null && optionIds().length >= 7, 'the picker');
  const S = tags.sessions;
  expect(groups()).toEqual(['Claude Code', 'Pi', 'OpenCode', 'Reads the Inbox, not woken']);
  expect(optionIds()[0]).toBe(S.owner);
  // The agents that read the Inbox only come last, after every live session (the DOM server's own seed adds more of them).
  const readers = [...document.querySelectorAll('[data-tag-group="Reads the Inbox, not woken"] [data-tag-option]')].map((o) => o.getAttribute('data-tag-option'));
  expect(readers).toContain(S.codex);
  expect(optionIds().slice(-readers.length)).toEqual(readers);
  // Listbox semantics: the field controls it, nothing selected yet, and each group is named by its heading.
  expect(box.getAttribute('aria-controls')).toBe(picker()!.id);
  expect(box.getAttribute('aria-autocomplete')).toBe('list');
  expect(box.getAttribute('aria-activedescendant')).toBeNull();
  expect(document.querySelector('[data-tag-option][aria-selected="true"]')).toBeNull();
  for (const g of document.querySelectorAll('[data-tag-picker] [role="group"]')) {
    expect(document.getElementById(g.getAttribute('aria-labelledby')!)?.textContent).toBe(g.getAttribute('data-tag-group') ?? undefined);
  }
  const owner = document.querySelector(`[data-tag-option="${S.owner}"]`)!;
  expect(owner.textContent).toContain('Owns this thread');
  expect(document.querySelector(`[data-tag-option="${S.codex}"]`)!.textContent).toContain('Not woken');
  // The Pi on an older Plannotator: listed, never picked, and says to update.
  const old = document.querySelector(`[data-tag-option="${S.oldPi}"]`)!;
  expect(old.getAttribute('aria-disabled')).toBe('true');
  expect(old.textContent).toContain('Update Plannotator to tag this session');
  // Enter with nothing active is the field's own key (a newline), not a pick.
  const enter = await press(box, 'Enter');
  expect(enter.defaultPrevented).toBe(false);

  await type(box, 'Queue it, and cap retries at 5. @pi');
  expect(optionIds()).toEqual([S.pi, S.oldPi]);
  await press(box, 'ArrowDown');
  expect(box.getAttribute('aria-activedescendant')).toBe(document.querySelector('[data-tag-option][aria-selected="true"]')!.id);
  await press(box, 'Enter');
  await settle(30);
  expect(box.value).toBe('Queue it, and cap retries at 5. @Pi ');
  expect(picker()).toBeNull();
  expect(el.querySelector('[data-tag-live]')!.textContent).toContain("Tagged Pi. It doesn't own this thread; it gets your reply and a pointer to this thread.");
  // What Send does, in one line described on the field (approval "inbox-tag-handoff", A2): an Ask, with the two switches.
  const line = el.querySelector('[data-tag-mode]')!;
  expect(line.getAttribute('data-tag-mode')).toBe('ask');
  expect(line.querySelector('[data-tag-mode-words]')!.textContent).toBe('Asks Pi');
  expect([...line.querySelectorAll('[data-tag-mode-to]')].map((b) => b.textContent)).toEqual(['Add instead', 'Hand off instead']);
  expect(el.querySelector('[data-tag-notes]')).toBeNull();
  expect(box.getAttribute('aria-describedby')).toContain(line.id);

  // Picking the older Pi inserts nothing and says why.
  await type(box, `${box.value}@pi`);
  const oldIndex = optionIds().indexOf(S.oldPi);
  for (let i = 0; i <= oldIndex; i++) await press(box, 'ArrowDown');
  await press(box, 'Enter');
  expect(box.value).toBe('Queue it, and cap retries at 5. @Pi @pi');
  expect(el.querySelector('[data-tag-live]')!.textContent).toContain('Update Plannotator to tag this session');
  // Escape closes the picker before the reply box.
  await type(box, 'Queue it, and cap retries at 5. @Pi and @');
  expect(picker()).not.toBeNull();
  await press(box, 'Escape');
  expect(picker()).toBeNull();
  expect(replyBox(el)).not.toBeNull();
}, 30_000);

test.skipIf(!hasDom)('an MCP agent gets the other heads-up; Send carries the tags; the sent reply shows one line per agent, each with its own Send now', async () => {
  const S = tags.sessions;
  const el = await renderApp(`#thread=${tags.ids.t1}`);
  const box = await openReply(el);
  await type(box, 'Queue it. @pi');
  await press(box, 'ArrowDown');
  await press(box, 'Enter');
  await type(box, `${box.value}raise the timeout. @codex`);
  // The DOM server's own seed has a Codex in another project too: this one reads "Codex (docs-site)".
  const codexLabel = document.querySelector(`[data-tag-option="${S.codex}"] .ib-tg-on`)!.textContent!;
  expect(codexLabel).toBe('Codex (docs-site)');
  while (document.querySelector('[data-tag-option][aria-selected="true"]')?.getAttribute('data-tag-option') !== S.codex) await press(box, 'ArrowDown');
  await press(box, 'Enter');
  await type(box, `${box.value}the runbook needs the alert.`);
  // One line: an Ask to both, saying which one is not woken; Add and Hand off reach live sessions only, so no switch.
  const line = el.querySelector('[data-tag-mode]')!;
  expect(line.querySelector('[data-tag-mode-words]')!.textContent).toBe(
    `Asks Pi and ${codexLabel} · ${codexLabel} isn't woken: it sees your reply the next time it reads this thread`,
  );
  expect(line.querySelectorAll('[data-tag-mode-to]')).toHaveLength(0);
  await press(box, 'Enter', { metaKey: true });
  await until(async () => posted.some((p) => p.path.endsWith('/reply')), 'the Send');
  const sent = posted.filter((p) => p.path.endsWith('/reply'));
  expect(sent.at(-1)!.body.tags).toEqual([
    { host: 'pi', session: S.pi, label: 'Pi' },
    { host: 'codex', session: S.codex, label: codexLabel },
  ]);
  const stored = (await serverMessages(tags.ids.t1)).at(-1)!;
  expect(stored.tags?.map((t) => [t.session, t.wakes])).toEqual([
    [S.pi, true],
    [S.codex, false],
  ]);
  // The lines: the owner first, then each tagged session with its own state.
  await until(() => el.querySelectorAll('[data-tag-lines] > li').length === 3, 'the lines');
  await until(() => el.querySelector(`[data-tag-line="${S.pi}"] [data-send-now]`) !== null, "Pi's Send now");
  const lines = [...el.querySelectorAll('[data-tag-lines] > li')].map((li) => [li.getAttribute('data-tag-line'), li.getAttribute('data-delivery')]);
  expect(lines[0]![0]).toBe(S.owner);
  expect(lines.slice(1)).toEqual([
    [S.pi, 'queued'],
    [S.codex, 'saved'],
  ]);
  expect(el.querySelector(`[data-tag-line="${S.pi}"]`)!.textContent).toContain('Undelivered · Pi is working · goes in by itself in 5 min');
  expect(el.querySelector(`[data-tag-line="${S.codex}"]`)!.textContent).toContain(`Saved for ${codexLabel}. It sees it the next time it reads this thread.`);
  // The message head names who it was tagged to.
  expect(el.querySelector('[data-tagged-names]')!.textContent).toBe(` · tagged Pi, ${codexLabel}`);
  // Pi's own Send now posts for Pi alone.
  act(() => (el.querySelector(`[data-tag-line="${S.pi}"] [data-send-now]`) as HTMLButtonElement).click());
  await until(() => posted.some((p) => p.path.endsWith('/send-now')), 'Send now');
  expect(posted.find((p) => p.path.endsWith('/send-now'))!.body).toMatchObject({ session: S.pi });
  expect((await serverMessages(tags.ids.t1)).at(-1)!.tags![0]!.deliver_now_at).toBeString();
  // Pi's connection delivers: its line reads Delivered; the owner's still waits.
  (child!.stdin as { write(data: string): void }).write(`${JSON.stringify({ deliver: { session: S.pi } })}\n`);
  await until(async () => !!(await serverMessages(tags.ids.t1)).at(-1)!.tags![0]!.delivery, "Pi's delivery");
  // The window reads the thread again (the event stream is stubbed here): a fresh load.
  act(() => root?.unmount());
  host?.remove();
  const again = await renderApp(`#thread=${tags.ids.t1}`);
  await until(() => again.querySelector(`[data-tag-line="${S.pi}"]`)?.getAttribute('data-delivery') === 'delivered', "Pi's line");
  expect(again.querySelector(`[data-tag-line="${S.pi}"]`)!.textContent).toMatch(/^Delivered to Pi, /);
  expect(again.querySelector(`[data-tag-line="${S.owner}"]`)!.getAttribute('data-delivery')).not.toBe('delivered');
}, 30_000);

test.skipIf(!hasDom)('the thread head shows the agents in the thread overlapping, the row beside its project; the Sent row counts deliveries', async () => {
  const el = await renderApp(`#thread=${tags.ids.t3}`);
  await until(() => el.querySelector('[data-thread-participants]') !== null, 'the thread head');
  expect(el.querySelector('[data-thread-participants]')!.textContent).toBe('Claude Code and Pi');
  expect(el.querySelector('[data-thread-participants] [data-tag-stack]')!.getAttribute('data-tag-stack')).toBe('2');
  const model = await api<{ sections: InboxListSection[] }>('/api/inbox/threads');
  const rows = model.sections.flatMap((s) => s.threads);
  expect(rows.find((r) => r.thread_id === tags.ids.t3)!.participants?.map((p) => p.host)).toEqual(['claude-code', 'pi']);
  const row = el.querySelector(`.ib-lbody [data-thread-id="${tags.ids.t2}"]`)!;
  expect(row.querySelector('[data-row-agents]')!.getAttribute('data-row-agents')).toBe('3');
  // Pi's connection took its copy in the test before (it delivers everything it is handed): the owner still waits.
  expect(row.textContent).toContain('1 of 3 delivered · Claude Code queued');
}, 30_000);
