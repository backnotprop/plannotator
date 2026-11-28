/**
 * A window reads its settings at load, before it listens: its event stream opens only once the first list read has
 * landed (firstListRead.ts). A capability switch flipped in between (in another window, by an agent, or on a linked
 * computer whose flip this Inbox takes: one set of capabilities, inbox-capability-set.ts) is told only to the streams
 * open at that moment, and a stream that opens later is never told it. What regresses if this fails: Settings on that
 * window keeps showing the switch as it was until a reload (seen in the two-computer browser test,
 * inbox-decision-mode-linked.spec.ts step 5: Laptop's new Settings window kept Decision mode on after Studio turned
 * it off and Laptop took the flip). So every connect reads the settings again; this checks each shared switch.
 *
 * The whole window (InboxApp) over a stubbed fetch and EventSource; no Inbox. DOM-gated: runs under DOM_TESTS=1
 * (happy-dom), from tests/dom-test-list.txt.
 */
import { afterAll, afterEach, beforeAll, test } from 'bun:test';
import type { SettingsModel } from './api';

const hasDom = typeof document !== 'undefined';
const { act } = (hasDom ? await import('react') : {}) as typeof import('react');
const { createRoot } = (hasDom ? await import('react-dom/client') : {}) as typeof import('react-dom/client');
const { InboxApp } = (hasDom ? await import('./App') : {}) as typeof import('./App');

const SESSION = 'srv_settings_after_connect';

/** The switches as this stub Inbox holds them now; a test flips one "on the server" while the window is not listening. */
let held: Record<string, { on: boolean }> = {};

function settingsModel(): SettingsModel {
  return {
    serverSession: SESSION,
    version: '0.29.0',
    port: 1,
    url: 'http://localhost:1/',
    mcp_url: 'http://127.0.0.1:1/mcp',
    mcp_command: ['plannotator', 'inbox', 'mcp'],
    home: '/home/u',
    data_dir: '/home/u/.plannotator',
    inbox_tool: { hosts: { 'claude-code': true, pi: false, opencode: false }, env: null },
    notifications: { enabled: true, dismissed: true, allowed_origin: null },
    phones: false,
    store_dir: '/home/u/.plannotator/inbox',
    board: held.board,
    steps: held.steps,
    decision_mode: { ...held.decision_mode!, env: null },
    code_review: held.code_review,
    chapter_diagrams: held.code_review!.on ? held.chapter_diagrams : undefined,
    bro: held.bro,
    float_drafts: held.float_drafts,
    experimental: { decision_mode: { ...held.decision_mode!, env: null }, grid: { ...held.grid!, env: null } },
  } as unknown as SettingsModel;
}

const list = {
  serverSession: SESSION,
  version: '0.29.0',
  cursor: 0,
  update: null,
  notice: null,
  projects: [],
  project: null,
  sections: [],
};

let savedFetch: typeof fetch;
let savedEventSource: unknown;
/** Each stream the window opened, with its listeners. */
let streams: Map<string, ((event: MessageEvent) => void)[]>[] = [];
let settingsReads = 0;
let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLElement | null = null;

beforeAll(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input).split('?')[0]!;
    const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (url === '/api/inbox/settings') {
      settingsReads++;
      return answer(settingsModel());
    }
    if (url === '/api/inbox/threads') return answer(list);
    return answer({ error: { code: 'not_found', message: 'Not here.' } }, 404);
  }) as typeof fetch;
  savedEventSource = (globalThis as Record<string, unknown>).EventSource;
  (globalThis as Record<string, unknown>).EventSource = class {
    readonly listeners = new Map<string, ((event: MessageEvent) => void)[]>();
    constructor() {
      streams.push(this.listeners);
    }
    addEventListener(name: string, listener: (event: MessageEvent) => void) {
      this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
    }
    removeEventListener() {}
    close() {}
  };
});

afterAll(() => {
  if (!hasDom) return;
  globalThis.fetch = savedFetch;
  (globalThis as Record<string, unknown>).EventSource = savedEventSource;
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  streams = [];
});

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
  }
  throw new Error(`timed out waiting for ${what}`);
}

const pause = (ms: number) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));

/** The shared switches with a row in Settings → Capabilities, and the row each is drawn in. */
const ROWS = [
  { key: 'decision_mode', row: '[data-settings-decision-mode]', from: true },
  { key: 'steps', row: '[data-settings-steps]', from: false },
  { key: 'board', row: '[data-settings-board]', from: false },
  { key: 'code_review', row: '[data-settings-code-review]', from: false },
] as const;

for (const { key, row, from } of ROWS) {
  test.skipIf(!hasDom)(`${key}: flipped while the window was not yet listening, its Settings row shows the flip once the stream opens`, async () => {
    held = { board: { on: false }, steps: { on: false }, decision_mode: { on: true }, code_review: { on: false }, chapter_diagrams: { on: false }, bro: { on: false }, float_drafts: { on: false }, grid: { on: false } };
    held[key] = { on: from };
    window.location.hash = '#settings/capabilities';
    host = document.createElement('div');
    document.body.appendChild(host);
    act(() => {
      root = createRoot(host!);
      root.render(<InboxApp />);
    });
    const switchOf = () => host!.querySelector(`${row} [role="switch"]`);
    await until(() => switchOf()?.getAttribute('aria-checked') === String(from), `the ${key} switch as read at load`);
    await until(() => streams.length > 0, 'the event stream');
    await pause(200);
    // The flip lands on the server now: this window's stream is not open there yet, so no frame will ever name it.
    held[key] = { on: !from };
    const before = settingsReads;
    for (const listener of streams[0]!.get('hello') ?? []) listener(new MessageEvent('hello', { data: JSON.stringify({ serverSession: SESSION, cursor: 0 }) }));
    await until(() => switchOf()?.getAttribute('aria-checked') === String(!from), `the ${key} switch after the stream opened (${settingsReads - before} settings reads)`);
  }, 30_000);
}
