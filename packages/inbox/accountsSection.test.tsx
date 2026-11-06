/**
 * Settings → Accounts and the sidebar's Usage row (approval "accounts-page"):
 * the whole window (InboxApp) over a REAL Inbox in a temp data dir
 * (tests/helpers/inbox-dom-server.ts, `accounts` mode), which reads usage on a
 * PATH of only a fake `cswap`'s folder (tests/helpers/fake-cswap.ts). No test
 * here can reach a real claude-swap.
 *
 * The layout (week's column, the wrap, nothing overflowing) is the browser's:
 * tests/e2e/inbox-accounts.spec.ts. The server's refusals are
 * packages/server/inbox-accounts.test.ts.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fakeCswapCalls, removeFakeCswap, writeFakeCswap, type FakeCswapAnswer } from '../../tests/helpers/fake-cswap';
import { INBOX_ACCOUNT_SWITCHING } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
/** The switch's own tests run only while switching is on; the tests that it is off run only while it is off. */
const withSwitching = !hasDom || !INBOX_ACCOUNT_SWITCHING;
const withoutSwitching = !hasDom || INBOX_ACCOUNT_SWITCHING;
/** What a row not in use is: the switch's button, or a plain row while switching is off. */
const OTHER_ROW = INBOX_ACCOUNT_SWITCHING ? 'BUTTON' : 'DIV';
const { InboxApp } = (hasDom ? await import('./App') : {}) as typeof import('./App');
const { PHONE_QUERY } = (hasDom ? await import('./phone') : {}) as typeof import('./phone');

const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');
const FIXTURES = resolve(import.meta.dir, '../../tests/fixtures/cswap');
const LIST = hasDom ? readFileSync(join(FIXTURES, 'list.json'), 'utf8') : '';
const WINDOWS = (hasDom ? JSON.parse(readFileSync(join(FIXTURES, 'usage-windows.json'), 'utf8')) : {}) as Record<string, unknown>;
const INSTALL_COMMAND = 'uv tool install claude-swap';

let dir: string | null = null;
let child: ReturnType<typeof Bun.spawn> | null = null;
let port = 0;
let bin = '';
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedEventSource: unknown;
let savedMatchMedia: typeof window.matchMedia;
let phone = false;
/** Set by a test: what the window's accounts read gets instead of the server. */
let accountsRoute: (() => Promise<Response>) | null = null;
/** Set by a test: runs before the window's settings read reaches the server. */
let settingsRoute: (() => Promise<void>) | null = null;
/** Set by a test: what the window's switch gets instead of the server. */
let switchRoute: (() => Promise<Response>) | null = null;
/** Every switch the window asked for, by body. */
let switches: Record<string, unknown>[] = [];
/** Every accounts read the window asked for, by URL. */
let accountReads: string[] = [];
let readsAnswered = 0;
/** Set by a test: the machines linked here, and what each one's read answers. The link itself is packages/server/inbox-accounts.test.ts's. */
let linked: { id: string; name: string; answer: () => unknown }[] = [];
/** Every read of a linked machine, by URL. */
let machineReads: string[] = [];
/** Set by a test: the merged list has not named the machines, this one included. */
let listNamesNoMachine = false;

function call(path: string, method = 'GET', body?: string): Promise<{ status: number; text: string }> {
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

beforeAll(async () => {
  if (!hasDom) return;
  (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL('http://localhost:4000/');
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-accounts-dom-')));
  const dataDir = join(dir, 'data');
  bin = join(dataDir, 'cswap-bin');
  mkdirSync(join(dir, 'projects'), { recursive: true });
  child = Bun.spawn(['bun', SERVER_SCRIPT, dataDir, join(dir, 'projects'), '1', 'accounts'], {
    env: { ...process.env, DOM_TESTS: '0', PLANNOTATOR_DATA_DIR: dataDir, HOME: dir },
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
  let line = '';
  while (!line.includes('\n')) {
    const { value, done } = await reader.read();
    if (done) throw new Error('the Inbox did not start');
    line += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  port = (JSON.parse(line.trim()) as { port: number }).port;
}, 60_000);

afterAll(async () => {
  if (!hasDom) return;
  child?.kill();
  await child?.exited;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

beforeEach(async () => {
  if (!hasDom) return;
  phone = false;
  accountsRoute = null;
  switchRoute = null;
  switches = [];
  settingsRoute = null;
  accountReads = [];
  linked = [];
  machineReads = [];
  listNamesNoMachine = false;
  // A window leaves a read behind when it closes, and the server's next caller would join that run: see it out first.
  await call('/api/inbox/accounts');
  readsAnswered = 0;
  rmSync(bin, { recursive: true, force: true });
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === '/api/inbox/machines' && linked.length > 0) {
      const machines = [{ id: 'ibx_self', name: 'Studio', self: true }, ...linked.map(({ id, name }) => ({ id, name, self: false }))];
      return Response.json({ self: 'ibx_self', machines });
    }
    const machine = linked.find(({ id }) => String(input).startsWith(`/api/inbox/accounts/${id}`));
    if (machine) {
      machineReads.push(String(input));
      return Response.json(await machine.answer());
    }
    if (String(input) === '/api/inbox/accounts/switch') {
      switches.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (switchRoute) return switchRoute();
    } else if (String(input).startsWith('/api/inbox/accounts')) {
      accountReads.push(String(input));
      if (accountsRoute) return accountsRoute();
    }
    // The route without its query: the window reads `/api/inbox/settings?store=0`.
    if (settingsRoute && String(input).split('?')[0] === '/api/inbox/settings') await settingsRoute();
    const answer = await call(String(input), init?.method ?? 'GET', init?.body ? String(init.body) : undefined);
    if (String(input).startsWith('/api/inbox/accounts') && String(input) !== '/api/inbox/accounts/switch') readsAnswered += 1;
    if (listNamesNoMachine && String(input).includes('machines=1')) return Response.json({ ...JSON.parse(answer.text), machines: undefined }, { status: answer.status });
    return new Response(answer.text, { status: answer.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  savedEventSource = (globalThis as Record<string, unknown>).EventSource;
  (globalThis as Record<string, unknown>).EventSource = class {
    addEventListener() {}
    close() {}
  };
  savedMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    media: query,
    matches: query === PHONE_QUERY ? phone : false,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
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
  window.matchMedia = savedMatchMedia;
});

/**
 * An element as a short string, for `expect`: a failed expect that has to print a rendered
 * happy-dom element crashes Bun (exit 133, the file's report lost), so expect on this instead.
 */
const shown = (node: Element | null | undefined) => (node ? node.outerHTML.slice(0, 300) : null);

/** Waits up to 3 s: well under Bun's 5 s test limit, so a wait that never ends fails by its name, with nothing left running. */
async function until(check: () => boolean, what: string) {
  const end = Date.now() + 3000;
  while (Date.now() < end) {
    if (check()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
  }
  throw new Error(`timed out waiting for ${what}`);
}

function answer(fake: FakeCswapAnswer) {
  writeFakeCswap(bin, fake);
}

/** The window has the first read's answer on screen: the row alone no longer says so, since it comes from settings. */
async function firstReadShown() {
  await until(() => readsAnswered > 0, 'the first read');
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}

/** A `list --json` of these rows. */
function listOf(...accounts: Record<string, unknown>[]) {
  return JSON.stringify({ schemaVersion: 1, accounts: accounts.map((row, i) => ({ number: i + 1, email: `user${i + 1}@fake.test`, organizationName: '', active: false, usageStatus: 'ok', usage: null, ...row })) });
}

const stateOf = (el: ParentNode) => el.querySelector('[data-settings-accounts]')?.getAttribute('data-settings-accounts') ?? null;

async function openAccounts() {
  window.location.hash = '#settings/accounts';
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<InboxApp />);
  });
  await until(() => stateOf(host!) !== null, 'the Accounts section');
  return host;
}

async function open(state: string) {
  const el = await openAccounts();
  await until(() => stateOf(el) === state, `the ${state} state`);
  return el;
}

const refresh = (el: ParentNode) => el.querySelector('[data-accounts-refresh]') as HTMLButtonElement;
/** A machine's block: this machine's by default. */
const machineOf = (el: ParentNode, key = 'self') => el.querySelector(`[data-machine-key="${key}"]`) as HTMLElement | null;
const row = (el: ParentNode, number: number, key = 'self') => machineOf(el, key)?.querySelector(`[data-account="${number}"]`) as HTMLElement;
const nameOf = (rowEl: Element) => rowEl.querySelector('.ib-acct-name')?.textContent;
/** The muted notes beside a name ("on Mac mini"), as they read, or null. */
const notesOf = (rowEl: Element) => {
  const notes = rowEl.querySelector('[data-account-notes]');
  return notes ? [...notes.querySelectorAll('small')].map((note) => note.textContent).join(' ') : null;
};
/** A row's limit as `label pct`: the one nearest to running out. Its label is in no text on the row, only on its figure. */
const bars = (rowEl: Element) => [...rowEl.querySelectorAll('[data-account-use="bars"]')].map((use) => `${use.querySelector('b')?.getAttribute('data-usage')} ${use.querySelector('b')?.textContent}`);
/** Everything a row keeps off its face: its hover title, one fact a line. */
const detailOf = (rowEl: Element) => rowEl.getAttribute('title')?.split('\n') ?? [];
/** What a row says on its face: its name, notes and figure. Not the words kept for a screen reader. */
const faceOf = (rowEl: Element) => {
  const face = rowEl.cloneNode(true) as Element;
  face.querySelectorAll('.ib-sr').forEach((hidden) => hidden.remove());
  return face.textContent ?? '';
};
/** A machine's rows by name, in the order the list shows them. */
const order = (el: ParentNode, key = 'self') => [...(machineOf(el, key)?.querySelectorAll('[data-account]') ?? [])].map((rowEl) => rowEl.querySelector('.ib-acct-n > .ib-acct-name')?.textContent);
/** What the page calls this machine. */
const machineName = (el: ParentNode) => machineOf(el)?.getAttribute('data-accounts-machine');
/** Every machine's block, by name, in page order. */
const blocks = (el: ParentNode) => [...el.querySelectorAll('[data-accounts-machine]')].map((block) => block.getAttribute('data-accounts-machine') ?? '');
const confirmOf = (el: ParentNode) => el.querySelector('[data-accounts-confirm]') as HTMLElement | null;

test.skipIf(!hasDom)('the sample: alias, else the start of the address, else "API key"; no placeholder address anywhere', async () => {
  answer({ stdout: LIST });
  const el = await open('accounts');
  expect(nameOf(row(el, 1))).toBe('personal');
  expect(nameOf(row(el, 2))).toBe('b');
  expect(nameOf(row(el, 3))).toBe('API key');
  expect(el.textContent).not.toContain('token.local');
  expect(el.querySelector('.ib-spg')?.textContent ?? el.textContent).not.toContain('@');
});

test.skipIf(!hasDom)('the login in use is first, a plain row with the filled circle; the others follow, most room first, no reading next, API keys last', async () => {
  answer({
    stdout: listOf(
      { alias: 'key', usageStatus: 'api_key' },
      { alias: 'full', usage: { fiveHour: limit(80), sevenDay: limit(20) } },
      { alias: 'new' },
      { alias: 'roomy', usage: { sevenDay: limit(12) } },
      { alias: 'work', active: true, usage: { fiveHour: limit(41) } },
    ),
  });
  const el = await open('accounts');
  expect(order(el)).toEqual(['work', 'roomy', 'full', 'new', 'key']);
  const inUse = row(el, 5);
  expect(inUse.tagName).toBe('DIV');
  expect(inUse.hasAttribute('data-in-use')).toBe(true);
  expect(inUse.querySelector('.ib-acct-dot')?.hasAttribute('data-on')).toBe(true);
  for (const number of [1, 2, 3, 4]) {
    expect(row(el, number).tagName).toBe(OTHER_ROW);
    expect(row(el, number).querySelector('.ib-acct-dot')?.hasAttribute('data-on')).toBe(false);
  }
  // Every row shows one figure and no limit's name; each of its limits is on hover.
  expect(bars(row(el, 2))).toEqual(['5h 80%']);
  expect(faceOf(row(el, 2))).not.toMatch(/5h|week/);
  expect(detailOf(row(el, 2))[0]).toBe('5h 80% · week 20%');
});

test.skipIf(!hasDom)('a row shows its limit nearest to running out, with no limit names; every limit, week included, is on hover; a window not reported is never 0%', async () => {
  answer({
    stdout: listOf(
      { alias: 'work', active: true, usage: { fiveHour: limit(21), sevenDay: limit(58), scoped: [{ ...limit(33), name: 'Fable' }] } },
      { alias: 'scoped', usage: { sevenDay: limit(30), scoped: [{ ...limit(64), name: 'Fable' }] } },
      { alias: 'ultra', usage: WINDOWS.ultra_five_hour_absent },
      { alias: 'hollow', usage: WINDOWS.hollow_five_hour },
      { alias: 'over', usage: { sevenDay: limit(104) } },
    ),
  });
  const el = await open('accounts');
  expect(bars(row(el, 1))).toEqual(['week 58%']);
  expect(faceOf(row(el, 1))).not.toMatch(/5h|week|Fable|21%|33%/);
  expect(detailOf(row(el, 1))[0]).toBe('5h 21% · Fable 33% · week 58%');
  expect(bars(row(el, 2))).toEqual(['Fable 64%']);
  expect(bars(row(el, 3))).toEqual(['week 30%']);
  expect(detailOf(row(el, 3))[0]).not.toContain('5h');
  // A 0% with no reset time shows as reported (the decided difference from the mock); here week is the nearer limit.
  expect(bars(row(el, 4))).toEqual(['week 30%']);
  // Over 100 reads as reported; the bar stops at full.
  expect(bars(row(el, 5))).toEqual(['week 104%']);
  expect(row(el, 5).querySelector('i')?.getAttribute('style')).toContain('100%');
});

test.skipIf(!hasDom)('amber at 90% and over, judged on the figure shown: the in-use row\'s circle too; when the limit resets is on hover, not on the row', async () => {
  const inTwoHours = new Date(Date.now() + 2 * 3_600_000);
  answer({
    stdout: listOf(
      { alias: 'work', active: true, usage: { fiveHour: { pct: 89.6, resetsAt: inTwoHours.toISOString(), clock: 'cswap clock' }, sevenDay: limit(40) } },
      { alias: 'near', usage: { fiveHour: limit(89.4) } },
      { alias: 'far', usage: { fiveHour: limit(92) } },
    ),
  });
  const el = await open('accounts');
  const use = (number: number) => row(el, number).querySelector('[data-account-use]')!;
  expect(use(1).getAttribute('data-l')).toBe('hot');
  expect(row(el, 1).querySelector('.ib-acct-dot')?.hasAttribute('data-hot')).toBe(true);
  // The person's own clock, from the reset time: "5h resets 6:20 PM".
  expect(detailOf(row(el, 1))).toContain(`5h resets ${inTwoHours.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`);
  expect(faceOf(row(el, 1))).not.toContain('resets');
  expect(use(2).hasAttribute('data-l')).toBe(false);
  // Another login near its limit is amber too, though quiet.
  expect(use(3).getAttribute('data-l')).toBe('hot');
  expect(row(el, 3).querySelector('.ib-acct-dot')?.hasAttribute('data-hot')).toBe(false);
});

test.skipIf(!hasDom)('an old reading: muted, never amber, and its hover says how old; a reading under 10 minutes is left alone', async () => {
  answer({
    stdout: listOf(
      { alias: 'old', active: true, usageAgeSeconds: 7_200, usage: { fiveHour: limit(95) } },
      { alias: 'edge', usageAgeSeconds: 600, usage: { fiveHour: limit(95) } },
      { alias: 'older', usageAgeSeconds: 601, usage: { fiveHour: limit(95) } },
    ),
  });
  const el = await open('accounts');
  const use = (number: number) => row(el, number).querySelector('[data-account-use]')!;
  expect(use(1).hasAttribute('data-stale')).toBe(true);
  expect(use(1).hasAttribute('data-l')).toBe(false);
  expect(row(el, 1).querySelector('.ib-acct-dot')?.hasAttribute('data-hot')).toBe(false);
  expect(detailOf(row(el, 1))).toContain('Last read 2h ago');
  expect(faceOf(row(el, 1))).not.toContain('Last read');
  expect(detailOf(row(el, 2)).some((line) => line.startsWith('Last read'))).toBe(false);
  expect(use(2).hasAttribute('data-stale')).toBe(false);
  expect(use(2).getAttribute('data-l')).toBe('hot');
  expect(use(3).hasAttribute('data-stale')).toBe(true);
  expect(use(3).hasAttribute('data-l')).toBe(false);
});

test.skipIf(!hasDom)('"Most room", on hover, only once the login in use is at 90% or more, and only on the row with the most room', async () => {
  const others = [
    { alias: 'half', usage: { fiveHour: limit(50) } },
    { alias: 'roomy', usage: { fiveHour: limit(10), sevenDay: limit(35) } },
    { alias: 'key', usageStatus: 'api_key' },
    { alias: 'empty', usage: null },
    { alias: 'stale', usageAgeSeconds: 7_200, usage: { fiveHour: limit(1) } },
    { alias: 'expired', usageStatus: 'relogin_required', usage: { fiveHour: limit(2) } },
  ];
  const withNote = (el: ParentNode) => {
    const rows = [...machineOf(el)!.querySelectorAll('[data-account]')];
    // Never on a row's face.
    for (const rowEl of rows) expect(faceOf(rowEl).toLowerCase()).not.toContain('most room');
    return rows.filter((rowEl) => detailOf(rowEl).includes('Most room')).map((rowEl) => nameOf(rowEl));
  };
  const reopen = async (inUse: Record<string, unknown>) => {
    act(() => root?.unmount());
    host?.remove();
    answer({ stdout: listOf({ alias: 'work', active: true, ...inUse }, ...others) });
    return open('accounts');
  };

  answer({ stdout: listOf({ alias: 'work', active: true, usage: { fiveHour: limit(89) } }, ...others) });
  expect(withNote(await open('accounts'))).toEqual([]);
  // 89.6 shows as 90%: the note goes by the figure shown. Its most room is its tightest limit, 35%, not its 5h.
  expect(withNote(await reopen({ usage: { fiveHour: limit(89.6) } }))).toEqual(['roomy']);
  expect(withNote(await reopen({ usage: { sevenDay: limit(100) } }))).toEqual(['roomy']);
  // A reading that can't be trusted is no reason to say it.
  expect(withNote(await reopen({ usageAgeSeconds: 7_200, usage: { fiveHour: limit(99) } }))).toEqual([]);
  expect(withNote(await reopen({ usageStatus: 'relogin_required', usage: { fiveHour: limit(99) } }))).toEqual([]);
  // No other login has room: no note. It is never a button or a colour.
  act(() => root?.unmount());
  host?.remove();
  answer({ stdout: listOf({ alias: 'work', active: true, usage: { fiveHour: limit(95) } }, { alias: 'worse', usage: { fiveHour: limit(97) } }, { alias: 'key', usageStatus: 'api_key' }) });
  expect(withNote(await open('accounts'))).toEqual([]);
});

test.skipIf(!hasDom)('API-key rows: just the name, no bar; "API key" on hover', async () => {
  answer({
    stdout: listOf(
      { alias: 'work', active: true, usage: { fiveHour: limit(95) } },
      { alias: 'build key', email: 'api-key-2@token.local', usageStatus: 'api_key' },
      { email: 'api-key-3@token.local', usageStatus: 'api_key' },
    ),
  });
  const el = await open('accounts');
  expect(row(el, 2).querySelector('[data-account-use]')?.getAttribute('data-account-use')).toBe('api-key');
  expect(faceOf(row(el, 2))).toBe(INBOX_ACCOUNT_SWITCHING ? 'build keySwitch' : 'build key');
  expect(row(el, 2).querySelector('i')).toBeNull();
  expect(detailOf(row(el, 2))).toEqual(['API key, billed per token']);
  expect(nameOf(row(el, 3))).toBe('API key');
  expect(row(el, 3).querySelector('[data-account-use]')?.textContent).toBe('');
  expect(notesOf(row(el, 2))).toBeNull();
});

test.skipIf(withSwitching)("an API key's confirm alone says billed per token: a phone has no hover", async () => {
  answer({
    stdout: listOf(
      { alias: 'work', active: true, usage: { fiveHour: limit(95) } },
      { alias: 'build key', email: 'api-key-2@token.local', usageStatus: 'api_key' },
    ),
  });
  const el = await open('accounts');
  act(() => row(el, 2).click());
  expect(confirmOf(el)?.textContent).toContain('Billed per token');
  expect(confirmOf(el)?.querySelector('[data-accounts-billed]')).not.toBeNull();
});

test.skipIf(!hasDom)('no reading: no bar, and the reason in plain words beside the name; never the code itself', async () => {
  const later = new Date(Date.now() + 3_600_000).toISOString();
  answer({
    stdout: listOf(
      { usageStatus: 'unavailable', usageError: 'network' },
      { usageStatus: 'relogin_required' },
      { usageStatus: 'unavailable', usageError: 'http-429', usageRetryAt: later },
      { usageStatus: 'unavailable', usageError: 'http-429', usageRetryAt: '2020-01-01T00:00:00Z' },
      { usageStatus: 'constructor' },
    ),
  });
  const el = await open('accounts');
  for (const number of [1, 2, 3, 4, 5]) {
    expect(row(el, number).querySelector('[data-account-use]')?.getAttribute('data-account-use')).toBe('none');
    expect(notesOf(row(el, number))).not.toBeNull();
    expect(row(el, number).querySelector('i')).toBeNull();
    expect(row(el, number).textContent).not.toMatch(/relogin_required|http-429|unavailable|constructor/);
  }
  expect(notesOf(row(el, 1))).toBe('Could not reach Anthropic');
  expect(notesOf(row(el, 2))).toBe('Sign in again');
  expect(notesOf(row(el, 3))).toStartWith('Anthropic rate limit. Try again after');
  expect(notesOf(row(el, 4))).toBe('Anthropic rate limit');
});

test.skipIf(!hasDom)("an organization named after the address is no organization; a real one tells namesakes apart, and cswap's number tells the rest", async () => {
  answer({
    stdout: listOf(
      { email: 'mira@a.test', organizationName: "mira@a.test's Organization", active: true },
      { email: 'mira@b.test', organizationName: 'Fake MIRA@B.TEST' },
      { email: 'a@fake.test', organizationName: 'North' },
      { email: 'a@fake.test', organizationName: 'South' },
      { email: 'solo@c.test', organizationName: 'West' },
    ),
  });
  const el = await open('accounts');
  expect(nameOf(row(el, 1))).toBe('mira #1');
  expect(nameOf(row(el, 2))).toBe('mira #2');
  expect(notesOf(row(el, 1))).not.toContain('@');
  expect(notesOf(row(el, 3))).toStartWith('North');
  expect(notesOf(row(el, 4))).toStartWith('South');
  expect(notesOf(row(el, 5))).not.toContain('West');
  expect(el.textContent).not.toContain('@');
});

test.skipIf(withSwitching)('a non-current row opens the confirm under it; another row moves it there; Cancel closes it, switches nothing, and gives focus back', async () => {
  answer({ stdout: LIST });
  const el = await open('accounts');
  const personal = row(el, 1);
  act(() => personal.click());
  expect(personal.getAttribute('aria-expanded')).toBe('true');
  expect(personal.querySelector('.ib-acct-dot')?.hasAttribute('data-pending')).toBe(true);
  // Right under the row it opened from, before the next row.
  expect(personal.nextElementSibling).toBe(confirmOf(el));
  // One short question: the block names the machine and tool, and only a screen reader hears them again.
  expect(confirmOf(el)!.querySelector('b')?.textContent).toBe('Switch to personal?');
  expect(confirmOf(el)!.getAttribute('aria-label')).toBe(`Switch Claude Code on ${machineName(el)} to personal?`);
  expect(confirmOf(el)!.textContent).toBe('Switch to personal?CancelSwitch');
  expect(document.activeElement?.hasAttribute('data-accounts-cancel')).toBe(true);
  // One confirm at a time: pressing another row moves it.
  act(() => row(el, 3).click());
  expect(el.querySelectorAll('[data-accounts-confirm]')).toHaveLength(1);
  expect(row(el, 3).nextElementSibling).toBe(confirmOf(el));
  expect(personal.getAttribute('aria-expanded')).toBe('false');
  act(() => (confirmOf(el)!.querySelector('[data-accounts-cancel]') as HTMLButtonElement).click());
  expect(confirmOf(el)).toBeNull();
  expect(document.activeElement).toBe(row(el, 3));
  expect(switches).toEqual([]);
  expect(switchRuns()).toEqual([]);
});

test.skipIf(withSwitching)('on a desktop a non-current row carries a quiet "Switch" at its end; on a phone no row does, and the row itself is still the switch', async () => {
  answer({ stdout: LIST });
  const el = await open('accounts');
  const hoverText = (number: number) => row(el, number).querySelector('.ib-acct-sw')?.textContent;
  expect(hoverText(1)).toBe('Switch');
  expect(hoverText(3)).toBe('Switch');
  expect(hoverText(2)).toBe('');
  act(() => root?.unmount());
  host?.remove();

  phone = true;
  const onPhone = await open('accounts');
  for (const number of [1, 2, 3]) expect(row(onPhone, number).querySelector('.ib-acct-sw')?.textContent).toBe('');
  expect(onPhone.textContent).not.toContain('Switch');
  expect(row(onPhone, 1).tagName).toBe('BUTTON');
  act(() => row(onPhone, 1).click());
  expect(row(onPhone, 1).nextElementSibling).toBe(confirmOf(onPhone));
});

test.skipIf(!hasDom)('no saved accounts: the command that saves one, to copy', async () => {
  answer({ stdout: listOf() });
  const el = await open('accounts');
  // Pinned on purpose: the command a person runs, from claude-swap's README.
  expect(el.querySelector('[data-accounts-none] .ib-cbox pre')?.textContent).toBe('cswap add');
  expect(el.querySelector('[data-account]')).toBeNull();
});

test.skipIf(!hasDom)('not installed: the mock\'s line in this machine\'s block, the install command to copy; once installed, Refresh finds it', async () => {
  const el = await open('not_installed');
  const missing = machineOf(el)!.querySelector('[data-accounts-missing]')!;
  expect(missing.querySelector('div')?.textContent).toBe(`claude-swap isn't installed on ${machineName(el)}.`);
  // Pinned on purpose: the command a person runs, from claude-swap's README.
  expect(missing.querySelector('.ib-cbox pre')?.textContent).toBe(INSTALL_COMMAND);
  expect(missing.querySelector('.ib-cbox button')?.textContent).toBe('Copy');
  // The Inbox looks only on the PATH it started with, so Refresh can't fix this one.
  expect(missing.querySelector('small')?.textContent).toBe('Already installed? Restart the Inbox there.');
  expect(el.querySelector('[data-account]')).toBeNull();
  answer({ stdout: LIST });
  act(() => refresh(el).click());
  await until(() => stateOf(el) === 'accounts', 'the accounts');
  removeFakeCswap(bin);
  await until(() => !refresh(el).disabled, 'the read done');
  act(() => refresh(el).click());
  await until(() => stateOf(el) === 'not_installed', 'not installed again');
});

test.skipIf(!hasDom)("failed: a plain line for each reason, never cswap's own words; Refresh recovers", async () => {
  answer({ stdout: JSON.stringify({ schemaVersion: 1, error: { message: 'words-of-cswap' } }), stderr: 'words-of-cswap', exit: 1 });
  const el = await open('failed');
  const line = () => el.querySelector('[data-accounts-failed]');
  expect(line()?.getAttribute('data-accounts-failed')).toBe('run_failed');
  expect(line()?.closest('[data-machine-key]')?.getAttribute('data-machine-key')).toBe('self');
  expect(el.textContent).not.toContain('words-of-cswap');
  const seen = new Set<string>([line()!.textContent!]);
  for (const [fake, reason] of [
    [{ stdout: 'Traceback' }, 'bad_output'],
    [{ stdout: JSON.stringify({ schemaVersion: 9, accounts: [] }) }, 'unknown_schema'],
  ] as [FakeCswapAnswer, string][]) {
    answer(fake);
    act(() => refresh(el).click());
    await until(() => line()?.getAttribute('data-accounts-failed') === reason, reason);
    seen.add(line()!.textContent!);
  }
  // Update is what a person can do about a format this build doesn't know.
  expect(line()?.textContent).toContain('Update');
  expect(seen.size).toBe(3);
  expect(el.querySelector('[data-account]')).toBeNull();
  answer({ stdout: LIST });
  act(() => refresh(el).click());
  await until(() => stateOf(el) === 'accounts', 'the accounts after a failure');
  expect(line()).toBeNull();
});

test.skipIf(!hasDom)('a failed Refresh keeps the good list and says so above it; the next good read clears the line', async () => {
  answer({ stdout: LIST });
  const el = await open('accounts');
  const line = () => el.querySelector('[data-accounts-failed]');
  answer({ stdout: 'Traceback' });
  act(() => refresh(el).click());
  await until(() => line() !== null, 'the failure line');
  expect(line()?.getAttribute('data-accounts-failed')).toBe('bad_output');
  expect(nameOf(row(el, 1))).toBe('personal');
  expect(line()!.compareDocumentPosition(row(el, 2)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

  accountsRoute = async () => {
    throw new TypeError('Failed to fetch');
  };
  act(() => refresh(el).click());
  await until(() => line()?.getAttribute('data-accounts-failed') === 'unreachable', 'the Inbox not answering');
  expect(nameOf(row(el, 1))).toBe('personal');

  accountsRoute = null;
  answer({ stdout: LIST });
  act(() => refresh(el).click());
  await until(() => line() === null, 'the line gone');
});

test.skipIf(!hasDom)("the read that takes seconds: a clear wait first; Refresh keeps the list up, can't be pressed twice, and reads once", async () => {
  answer({ stdout: LIST, delay: 0.4 });
  const el = await openAccounts();
  expect(stateOf(el)).toBe('reading');
  expect(el.querySelector('[data-accounts-wait]')).not.toBeNull();
  expect(refresh(el).disabled).toBe(true);
  await until(() => stateOf(el) === 'accounts', 'the accounts');
  expect(el.querySelector('[data-accounts-wait]')).toBeNull();
  expect(refresh(el).disabled).toBe(false);
  const before = fakeCswapCalls(bin).length;
  act(() => refresh(el).click());
  expect(refresh(el).disabled).toBe(true);
  expect(row(el, 1)).not.toBeNull();
  await until(() => !refresh(el).disabled, 'the refresh done');
  expect(fakeCswapCalls(bin).length).toBe(before + 1);
});

test.skipIf(!hasDom)('Refresh sits beside the page title, not in a list', async () => {
  answer({ stdout: LIST });
  const el = await open('accounts');
  expect(refresh(el).parentElement?.querySelector('h1')?.textContent).toBe('Accounts');
  expect(refresh(el).closest('[data-machine-key]')).toBeNull();
});

test.skipIf(!hasDom)('a read happens when the window opens and when this page opens: other sections run nothing, and nothing runs by itself', async () => {
  answer({ stdout: LIST });
  window.location.hash = '#settings/general';
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<InboxApp />);
  });
  await firstReadShown();
  await act(async () => {
    await new Promise((r) => setTimeout(r, 300));
  });
  expect(fakeCswapCalls(bin)).toEqual(['list --json']);
  act(() => (host!.querySelector('[data-settings-link="accounts"]') as HTMLAnchorElement).click());
  await until(() => fakeCswapCalls(bin).length === 2 && !refresh(host!)?.disabled, 'the page read');
  await act(async () => {
    await new Promise((r) => setTimeout(r, 300));
  });
  expect(fakeCswapCalls(bin)).toEqual(['list --json', 'list --json']);
});

test.skipIf(!hasDom)('a tailnet guest is told so and offered no Refresh or machine; an Inbox that does not answer says that, and Refresh recovers', async () => {
  accountsRoute = async () => new Response(JSON.stringify({ error: 'refused', code: 'owner_only' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
  linked = [{ id: 'ibx_mini', name: 'Mini', answer: () => farList({ alias: 'personal', active: true }) }];
  const el = await open('owner_only');
  expect(el.querySelector('[data-accounts-owner-only]')).not.toBeNull();
  expect(refresh(el)).toBeNull();
  await until(() => machineReads.length > 0, 'the far read');
  await act(async () => new Promise((r) => setTimeout(r, 30)));
  expect(blocks(el)).toEqual([]);
  expect(el.querySelector('[data-account]')).toBeNull();
  act(() => root?.unmount());
  host?.remove();

  linked = [];
  accountsRoute = async () => {
    throw new TypeError('Failed to fetch');
  };
  const down = await open('unreachable');
  expect(down.querySelector('[data-accounts-failed]')?.getAttribute('data-accounts-failed')).toBe('unreachable');
  accountsRoute = null;
  answer({ stdout: LIST });
  act(() => refresh(down).click());
  await until(() => stateOf(down) === 'accounts', 'the accounts');
});

test.skipIf(!hasDom)("on a phone it is a row in Settings' list of sections, and opens with ‹ Settings", async () => {
  phone = true;
  answer({ stdout: LIST });
  window.location.hash = '#settings';
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<InboxApp />);
  });
  await until(() => host!.querySelector('[data-settings-list] [data-settings-link="accounts"]') !== null, 'the Accounts row');
  act(() => (host!.querySelector('[data-settings-link="accounts"]') as HTMLAnchorElement).click());
  await until(() => stateOf(host!) === 'accounts', 'the accounts on a phone');
  expect(window.location.hash).toBe('#settings/accounts');
  expect(host.querySelector('.ib-pback')?.textContent).toContain('Settings');
});

/** The sidebar's Usage row and its peek (components/Usage.tsx), over the same read as the page. */
const limit = (pct: number, clock = '3:40 PM') => ({ pct, resetsAt: '2099-11-05T12:00:00+00:00', countdown: '1h 02m', clock });
const usageRow = (el: ParentNode) => el.querySelector('[data-usage-nav]') as HTMLButtonElement | null;
const figure = (el: ParentNode) => usageRow(el)?.querySelector('[data-usage-figure]')?.textContent ?? null;
const peek = () => document.querySelector('[data-usage-peek]') as HTMLElement | null;
const peekLines = () => [...peek()!.querySelectorAll('.ib-usage-k')].map((label) => label.textContent);
const foot = (el: ParentNode) => [...el.querySelector('.ib-side-foot')!.querySelectorAll('button')].map((button) => button.textContent);

async function openInbox() {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<InboxApp />);
  });
  await until(() => host!.querySelector('.ib-side-foot') !== null, 'the sidebar');
  return host;
}

async function openPeek(el: ParentNode) {
  await until(() => usageRow(el) !== null, 'the Usage row');
  await act(async () => usageRow(el)!.click());
  await until(() => peek() !== null && !peek()!.textContent!.includes('Reading accounts…'), 'the peek');
}

test.skipIf(!hasDom)('without cswap the sidebar is what it was: no Usage, no figure, on a desktop and on a phone', async () => {
  answer({ stdout: listOf({ alias: 'work', active: true, usage: { fiveHour: limit(92) } }) });
  const withUsage = await openInbox();
  await until(() => figure(withUsage) !== null, 'the figure');
  const before = foot(withUsage);
  act(() => root?.unmount());
  host?.remove();

  for (const asPhone of [false, true]) {
    phone = asPhone;
    removeFakeCswap(bin);
    window.location.hash = '#settings/accounts';
    const el = await open('not_installed');
    await until(() => !el.querySelector('.ib-side-foot')?.hasAttribute('data-held'), 'the foot');
    expect(usageRow(el)).toBeNull();
    expect(el.querySelector('[data-usage-figure]')).toBeNull();
    expect(peek()).toBeNull();
    if (!asPhone) expect(foot(el)).toEqual(before.filter((label) => !label?.startsWith('Usage')));
    act(() => root?.unmount());
    host?.remove();
  }
});

test.skipIf(!hasDom)('the foot stays hidden until settings answer, then draws with the row in it, whatever the read is doing', async () => {
  answer({ stdout: LIST });
  accountsRoute = () => new Promise(() => {});
  let answerSettings = () => {};
  const held = new Promise<void>((go) => {
    answerSettings = go;
  });
  settingsRoute = () => held;
  const el = await openInbox();
  const footer = el.querySelector('.ib-side-foot')!;
  expect(footer.hasAttribute('data-held')).toBe(true);
  expect(usageRow(el)).toBeNull();
  await act(async () => answerSettings());
  await until(() => !footer.hasAttribute('data-held'), 'the foot');
  expect(foot(el).filter(Boolean).slice(-2)).toEqual(['Usage', 'Settings']);
  expect(accountReads).toHaveLength(1);
});

test.skipIf(!hasDom)('settings that fail never leave the foot hidden', async () => {
  answer({ stdout: LIST });
  settingsRoute = async () => {
    throw new TypeError('Failed to fetch');
  };
  const el = await openInbox();
  await until(() => !el.querySelector('.ib-side-foot')!.hasAttribute('data-held'), 'the foot');
  expect(foot(el).filter(Boolean).at(-1)).toBe('Settings');
});

test.skipIf(!hasDom)('a peek opened before the first read answers says so, then shows the answer', async () => {
  answer({ stdout: listOf({ alias: 'work', active: true, usage: { fiveHour: limit(41) } }) });
  let answerRead = () => {};
  const reading = new Promise<void>((go) => {
    answerRead = go;
  });
  accountsRoute = async () => {
    await reading;
    const { text } = await call('/api/inbox/accounts');
    return new Response(text, { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const el = await openInbox();
  await until(() => usageRow(el) !== null, 'the Usage row');
  await act(async () => usageRow(el)!.click());
  await until(() => peek() !== null, 'the peek');
  expect(peek()!.textContent).toContain('Reading accounts…');
  await act(async () => answerRead());
  await until(() => peek()?.querySelector('.ib-usage-nm')?.textContent === 'work', 'the answer');
  expect(peekLines()).toEqual(['5h']);
});

test.skipIf(!hasDom)('a read that finds cswap gone closes the peek instead of leaving it empty, and the row goes', async () => {
  answer({ stdout: listOf({ alias: 'work', active: true, usage: { fiveHour: limit(92) } }) });
  const el = await openInbox();
  await until(() => figure(el) !== null, 'the first read');
  removeFakeCswap(bin);
  await act(async () => usageRow(el)!.click());
  await until(() => usageRow(el) === null, 'the row to go');
  await until(() => peek() === null, 'the peek to close');
});

test.skipIf(!hasDom)('Escape closes the peek when focus is on the row', async () => {
  answer({ stdout: listOf({ alias: 'work', active: true, usage: { fiveHour: limit(41) } }) });
  const el = await openInbox();
  await openPeek(el);
  const rowEl = usageRow(el)!;
  await act(async () => {
    rowEl.focus();
    rowEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
  await until(() => peek() === null, 'the peek to close');
});

test.skipIf(!hasDom)('the row is plain until the account in use reaches 90%, then shows its highest limit; other accounts never move it', async () => {
  answer({ stdout: listOf({ alias: 'quiet', active: true, usage: { fiveHour: limit(89.4), sevenDay: limit(40) } }, { alias: 'near', usage: { fiveHour: limit(99) } }) });
  const el = await openInbox();
  await firstReadShown();
  expect(figure(el)).toBeNull();
  expect(usageRow(el)?.textContent).toBe('Usage');
  act(() => root?.unmount());
  host?.remove();

  answer({ stdout: listOf({ alias: 'near', active: true, usage: { fiveHour: limit(90), sevenDay: limit(94), scoped: [{ ...limit(91), name: 'Fable' }] } }) });
  const high = await openInbox();
  await until(() => figure(high) !== null, 'the figure');
  expect(figure(high)).toBe('94%');
  expect(usageRow(high)?.getAttribute('aria-label')).toBe('Usage: 94 percent used');
});

test.skipIf(!hasDom)('an old reading or an expired login is no warning: the row stays plain, and the peek mutes what it has', async () => {
  answer({ stdout: listOf({ alias: 'old', active: true, usageAgeSeconds: 7_200, usage: { fiveHour: limit(95) } }) });
  const el = await openInbox();
  await openPeek(el);
  expect(figure(el)).toBeNull();
  expect(peek()!.querySelector('[data-high]')).toBeNull();
  expect(peek()!.querySelector('.ib-usage-lines')?.hasAttribute('data-muted')).toBe(true);
  act(() => root?.unmount());
  host?.remove();

  answer({ stdout: listOf({ alias: 'gone', active: true, usageStatus: 'relogin_required', usage: { fiveHour: limit(95) } }) });
  const expired = await openInbox();
  await openPeek(expired);
  expect(figure(expired)).toBeNull();
  // Pinned on purpose: the approval names these words ("Login expired" stays in the peek).
  expect(peek()!.querySelector('.ib-usage-note')?.textContent).toBe('Login expired');
});

test.skipIf(!hasDom)('the peek: the account in use and its limits, week last, a reset time only beside a limit at 90%, and no address', async () => {
  answer({ stdout: listOf({ alias: 'work', email: 'mira@northwind.io', organizationName: 'Northwind', active: true, usage: { fiveHour: limit(92), sevenDay: limit(67, 'Nov 5 12:00'), scoped: [{ ...limit(41), name: 'Fable' }] } }, { alias: 'other' }) });
  const el = await openInbox();
  await openPeek(el);
  expect(peek()!.querySelector('.ib-usage-nm')?.textContent).toBe('work');
  expect(peekLines()).toEqual(['5h', 'Fable', 'week']);
  expect([...peek()!.querySelectorAll('.ib-usage-t')].map((time) => time.textContent)).toEqual(['3:40 PM', '', '']);
  expect([...peek()!.querySelectorAll('.ib-usage-v[data-high]')].map((value) => value.textContent)).toEqual(['92%']);
  expect(peek()!.textContent).not.toContain('@');
  expect(peek()!.textContent).not.toContain('other');
  expect(peek()!.querySelector('input, select, [role="menu"]')).toBeNull();
});

test.skipIf(!hasDom)('what the peek says with nothing to draw: an API key, no reading, no accounts, a failed read', async () => {
  const note = () => peek()!.querySelector('.ib-usage-note')?.textContent;
  const name = () => peek()!.querySelector('.ib-usage-nm')?.textContent;
  const reopen = async (stdout: string, exit = 0) => {
    act(() => root?.unmount());
    host?.remove();
    answer({ stdout, exit });
    const el = await openInbox();
    await openPeek(el);
  };
  answer({ stdout: listOf({ alias: 'build key', active: true, usageStatus: 'api_key' }) });
  await openPeek(await openInbox());
  // Pinned on purpose: each state's few words are the owner's rule for this page, and agents must not grow them into sentences.
  expect(note()).toBe('API key');
  await reopen(listOf({ alias: 'new', active: true }));
  expect(note()).toBe('No reading yet');
  await reopen(listOf());
  expect(name()).toBe('No accounts yet');
  await reopen(listOf({ alias: 'saved' }));
  expect(name()).toBe('No account in use');
  await reopen('Traceback');
  expect(name()).toBe('claude-swap gave an unreadable answer.');
});

test.skipIf(!hasDom)('the block opens Settings → Accounts and closes the peek', async () => {
  answer({ stdout: listOf({ alias: 'work', active: true, usage: { fiveHour: limit(41) } }) });
  const el = await openInbox();
  await openPeek(el);
  await act(async () => (peek()!.querySelector('[data-usage-block]') as HTMLButtonElement).click());
  await until(() => stateOf(el) === 'accounts' && peek() === null, 'Settings → Accounts');
  expect(window.location.hash).toBe('#settings/accounts');
});

test.skipIf(!hasDom)('the row and the page show one read: opening the peek reads again, and Settings moves the row without a read of its own', async () => {
  answer({ stdout: listOf({ alias: 'work', active: true, usage: { fiveHour: limit(41) } }) });
  const el = await openInbox();
  await firstReadShown();
  expect(fakeCswapCalls(bin).length).toBe(1);
  answer({ stdout: listOf({ alias: 'work', active: true, usage: { fiveHour: limit(96) } }) });
  await openPeek(el);
  await until(() => figure(el) === '96%', 'the peek to read');
  expect(fakeCswapCalls(bin).length).toBe(2);
  await act(async () => (peek()!.querySelector('[data-usage-block]') as HTMLButtonElement).click());
  await until(() => stateOf(el) === 'accounts' && fakeCswapCalls(bin).length === 3 && !refresh(el).disabled, 'the page read');
  answer({ stdout: listOf({ alias: 'work', active: true, usage: { fiveHour: limit(12) } }) });
  act(() => refresh(el).click());
  await until(() => figure(el) === null && bars(row(el, 1))[0] === '5h 12%', 'Refresh to reach the row');
  expect(fakeCswapCalls(bin).length).toBe(4);
  // Only Refresh skips the answer the Inbox keeps.
  expect(accountReads).toEqual(['/api/inbox/accounts', '/api/inbox/accounts', '/api/inbox/accounts', '/api/inbox/accounts?fresh=1']);
});

test.skipIf(!hasDom)('a read that refuses takes the row away, even over a settings answer that said cswap is here', async () => {
  answer({ stdout: LIST });
  accountsRoute = async () => new Response(JSON.stringify({ error: 'refused', code: 'owner_only' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
  const el = await open('owner_only');
  await until(() => !el.querySelector('.ib-side-foot')?.hasAttribute('data-held'), 'the foot');
  expect(usageRow(el)).toBeNull();
});

test.skipIf(!hasDom)('Tab past either end of the peek closes it; Tab between its blocks does not', async () => {
  answer({ stdout: listOf({ alias: 'work', active: true, usage: { fiveHour: limit(41) } }) });
  linked = [{ id: 'ibx_mini', name: 'Mini', answer: () => farList({ alias: 'far', active: true, usage: { fiveHour: limit(95) } }) }];
  const el = await openInbox();
  await openPeek(el);
  await until(() => nearBlock() !== null, 'the other machine');
  const tab = (target: Element, shiftKey = false) => act(async () => void target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true })));

  await tab(peek()!.querySelector('[data-usage-block]')!);
  expect(peek()).not.toBeNull();
  await tab(nearBlock()!, true);
  expect(peek()).not.toBeNull();
  await tab(nearBlock()!);
  await until(() => peek() === null, 'Tab past the last block');

  await openPeek(el);
  await tab(peek()!.querySelector('[data-usage-block]')!, true);
  await until(() => peek() === null, 'Shift+Tab past the first block');

  // Focus on the popup itself, after a click on its padding: it is the first stop going back.
  await openPeek(el);
  await tab(peek()!, true);
  await until(() => peek() === null, 'Shift+Tab from the popup');
});

test.skipIf(!hasDom)('a far answer that grows an open peek leaves it in place, with focus where it was', async () => {
  answer({ stdout: listOf({ alias: 'work', active: true, usage: { fiveHour: limit(41) } }) });
  let letGo = (_read: unknown) => {};
  linked = [{ id: 'ibx_mini', name: 'Mini', answer: () => new Promise((done) => (letGo = done)) }];
  const el = await openInbox();
  await openPeek(el);
  await until(() => machineReads.length > 0, 'the far read');
  const popup = peek()!;
  const block = popup.querySelector('[data-usage-block]') as HTMLButtonElement;
  await act(async () => block.focus());
  await act(async () => letGo(farList({ alias: 'far', active: true, usage: { fiveHour: limit(95) } })));
  await until(() => nearBlock() !== null, 'the machine at 95%');
  expect(peek()).toBe(popup);
  expect(document.activeElement).toBe(block);
});

/** Linked machines: a `GET accounts/<machine>` answer holding these rows. */
const farList = (...accounts: Record<string, unknown>[]) => ({ state: 'accounts', accounts: accounts.map(farAccount) });
const farAccount = (row: Record<string, unknown>, i: number) => ({
  number: i + 1,
  alias: null,
  email: `far${i + 1}@fake.test`,
  organizationName: null,
  isOrganization: false,
  active: false,
  usageStatus: 'ok',
  usageError: null,
  usageRetryAt: null,
  usage: null,
  usageAgeSeconds: 10,
  ...row,
  ...(row.usage ? { usage: { fiveHour: null, sevenDay: null, scoped: [], ...(row.usage as object) } } : {}),
});
const nearBlock = () => document.querySelector('[data-usage-machine]') as HTMLButtonElement | null;

test.skipIf(!hasDom)('the peek shows another machine only at 90% or more, with its name and that limit; the row never moves for it', async () => {
  answer({ stdout: listOf({ alias: 'work', active: true, usage: { fiveHour: limit(41) } }) });
  linked = [
    { id: 'ibx_near', name: 'Mini', answer: () => farList({ alias: 'far', active: true, usage: { fiveHour: limit(41), sevenDay: limit(93) } }) },
    { id: 'ibx_calm', name: 'Calm', answer: () => farList({ active: true, usage: { fiveHour: limit(89) } }) },
    { id: 'ibx_old', name: 'Stale', answer: () => farList({ active: true, usageAgeSeconds: 7_200, usage: { fiveHour: limit(99) } }) },
    { id: 'ibx_expired', name: 'Expired', answer: () => farList({ active: true, usageStatus: 'relogin_required', usage: { fiveHour: limit(99) } }) },
    { id: 'ibx_spare', name: 'Spare', answer: () => farList({ alias: 'spare', usage: { fiveHour: limit(99) } }) },
    { id: 'ibx_away', name: 'Away', answer: () => ({ state: 'offline' }) },
  ];
  const el = await openInbox();
  await openPeek(el);
  await until(() => nearBlock() !== null, 'the machine at 93%');
  expect([...document.querySelectorAll('[data-usage-machine]')].map((block) => block.textContent)).toEqual(['Miniweek 93%']);
  expect(nearBlock()!.getAttribute('aria-label')).toBe('Mini, week 93 percent. Open Accounts in Settings.');
  expect(figure(el)).toBeNull();
  await act(async () => nearBlock()!.click());
  await until(() => stateOf(el) === 'accounts' && peek() === null, 'Settings → Accounts');
});

test.skipIf(!hasDom)('"Login expired" stays in the peek, with another machine at 90% under it', async () => {
  answer({ stdout: listOf({ alias: 'work', active: true, usageStatus: 'relogin_required', usage: { fiveHour: limit(41) } }) });
  linked = [{ id: 'ibx_near', name: 'Mini', answer: () => farList({ active: true, usage: { fiveHour: limit(91) } }) }];
  const el = await openInbox();
  await openPeek(el);
  await until(() => nearBlock() !== null, 'the machine at 91%');
  expect(peek()!.querySelector('.ib-usage-note')?.textContent).toBe('Login expired');
});

test.skipIf(!hasDom)('one block per machine, this one first, each with its own list; a linked machine reads as its own cswap prints it', async () => {
  answer({ stdout: listOf({ alias: 'work', email: 'w@fake.test', active: true, usage: { fiveHour: limit(41) } }, { alias: 'personal', email: 'p@fake.test', usage: { sevenDay: limit(58) } }) });
  linked = [
    { id: 'ibx_mini', name: 'Mac mini', answer: () => farList({ alias: 'personal', email: 'p@fake.test', active: true, usage: { sevenDay: limit(58) } }, { alias: 'work', email: 'w@fake.test', usage: { fiveHour: limit(41) } }) },
    { id: 'ibx_vm', name: 'Build VM', answer: () => farList({ alias: 'ci', email: 'ci@fake.test', active: true }) },
  ];
  const el = await open('accounts');
  await until(() => order(el, 'ibx_vm').length === 1, 'the last machine');
  expect(blocks(el)).toEqual([machineName(el)!, 'Mac mini', 'Build VM']);
  expect(order(el)).toEqual(['work', 'personal']);
  expect(order(el, 'ibx_mini')).toEqual(['personal', 'work']);
  expect(order(el, 'ibx_vm')).toEqual(['ci']);
  // Each machine's in-use row is its own.
  expect(row(el, 1, 'ibx_mini').hasAttribute('data-in-use')).toBe(true);
  expect(machineOf(el, 'ibx_mini')!.querySelector('[data-accounts-tool]')?.textContent).toContain('Claude Code');
});

/** Studio (this machine) and three linked machines, where some logins are in use elsewhere. */
function sharedLogins() {
  answer({
    stdout: listOf(
      { alias: 'work', email: 'w@fake.test', active: true, usage: { fiveHour: limit(92) } },
      { alias: 'personal', email: 'p@fake.test', organizationName: 'Home', usage: { sevenDay: limit(58) } },
      { alias: 'side', email: 's@fake.test', usage: { sevenDay: limit(70) } },
      { alias: 'build key', usageStatus: 'api_key' },
    ),
  });
  linked = [
    // The same address under another organization is another login: Studio's "personal" is not this one.
    { id: 'ibx_mini', name: 'Mac mini', answer: () => farList({ alias: 'personal', email: 'P@fake.test', organizationName: 'Home', active: true, usage: { sevenDay: limit(58) } }, { alias: 'work', email: 'w@fake.test', usage: { fiveHour: limit(92) } }) },
    { id: 'ibx_studio', name: 'Studio', answer: () => farList({ alias: 'personal', email: 'p@fake.test', organizationName: 'Other', active: true }) },
    { id: 'ibx_key', name: 'Key box', answer: () => farList({ alias: 'build key', usageStatus: 'api_key', active: true }) },
  ];
}

async function openShared() {
  sharedLogins();
  const el = await open('accounts');
  await until(() => order(el, 'ibx_key').length === 1 && order(el, 'ibx_studio').length === 1 && order(el, 'ibx_mini').length === 2, 'every machine');
  return el;
}

test.skipIf(!hasDom)('a login another machine is using says "on <machine>" beside its name, and only there', async () => {
  const el = await openShared();
  expect(notesOf(row(el, 2))).toBe('on Mac mini');
  expect(notesOf(row(el, 3))).toBeNull();
  // An API key has no address: no other machine shares it.
  expect(notesOf(row(el, 4))).toBeNull();
  // The in-use row says it too, on the other side.
  expect(notesOf(row(el, 2, 'ibx_mini'))).toBe(`on ${machineName(el)}`);
  expect(notesOf(row(el, 1, 'ibx_mini'))).toBeNull();
});

test.skipIf(withSwitching)('the confirm for a login another machine is using does not repeat "on <machine>"', async () => {
  const el = await openShared();
  act(() => row(el, 2).click());
  expect(confirmOf(el)!.textContent).toBe('Switch to personal?CancelSwitch');
});

test.skipIf(!hasDom)('a linked machine that does not give a list says so in its own block in a few words; its not installed is the same block as here', async () => {
  answer({ stdout: listOf({ alias: 'work', active: true }) });
  linked = [
    { id: 'ibx_away', name: 'Away', answer: () => ({ state: 'offline' }) },
    // What the window's call answers once the server found the far door older.
    { id: 'ibx_old', name: 'Old', answer: () => ({ state: 'needs_update' }) },
    { id: 'ibx_odd', name: 'Odd', answer: () => ({ state: 'unreachable' }) },
    { id: 'ibx_slow', name: 'Slow', answer: () => ({ state: 'failed', reason: 'timed_out' }) },
    { id: 'ibx_bare', name: 'Bare', answer: () => ({ state: 'not_installed' }) },
    { id: 'ibx_wait', name: 'Wait', answer: () => new Promise(() => {}) },
  ];
  const el = await open('accounts');
  await until(() => machineOf(el, 'ibx_bare')?.querySelector('[data-accounts-missing]') != null, 'the last answer');
  const quiet = (key: string) => machineOf(el, key)!.querySelector('[data-machine-state]')?.textContent;
  expect(quiet('ibx_away')).toBe('Asleep');
  expect(quiet('ibx_old')).toBe('Update Plannotator');
  expect(quiet('ibx_odd')).toBe('The Inbox did not answer.');
  expect(quiet('ibx_slow')).toBe('claude-swap timed out.');
  expect(quiet('ibx_wait')).toBe('Reading accounts…');
  expect(machineOf(el, 'ibx_bare')!.querySelector('[data-accounts-missing] div')?.textContent).toBe("claude-swap isn't installed on Bare.");
  // None of it is this machine's alert, and none holds up this machine's list.
  expect(el.querySelectorAll('[role="alert"]')).toHaveLength(0);
  expect(order(el)).toEqual(['work']);
});

test.skipIf(!hasDom)("a linked machine's rows are not a switch in this build: no button, no confirm", async () => {
  answer({ stdout: listOf({ alias: 'work', active: true }, { alias: 'side' }) });
  linked = [{ id: 'ibx_mini', name: 'Mac mini', answer: () => farList({ alias: 'personal', active: true }, { alias: 'build' }) }];
  const el = await open('accounts');
  await until(() => order(el, 'ibx_mini').length === 2, "the other machine's rows");
  expect(shown(machineOf(el, 'ibx_mini')!.querySelector('button'))).toBeNull();
  expect(row(el, 2, 'ibx_mini').querySelector('.ib-acct-sw')?.textContent).toBe('');
  expect(row(el, 2).tagName).toBe(OTHER_ROW);
});

test.skipIf(!hasDom)('Refresh reads every machine again, and one slow machine holds up only its own block', async () => {
  answer({ stdout: listOf({ alias: 'work', active: true }) });
  let letGo = (_read: unknown) => {};
  linked = [
    { id: 'ibx_slow', name: 'Slow', answer: () => new Promise((done) => (letGo = done)) },
    { id: 'ibx_mini', name: 'Mini', answer: () => farList({ alias: 'personal', active: true }) },
  ];
  const el = await open('accounts');
  await until(() => order(el, 'ibx_mini').length === 1, 'the quick machine');
  expect(machineOf(el, 'ibx_slow')!.textContent).toContain('Reading accounts…');
  const before = machineReads.filter((url) => url.includes('ibx_mini')).length;
  act(() => refresh(el).click());
  await until(() => machineReads.filter((url) => url.includes('ibx_mini')).length === before + 1, 'the quick machine read again');
  expect(machineReads.filter((url) => url.includes('ibx_mini')).at(-1)).toContain('fresh=1');
  await act(async () => letGo(farList({ alias: 'late', active: true })));
  await until(() => order(el, 'ibx_slow')[0] === 'late', 'the slow machine');
});

test.skipIf(!hasDom)("the hover's words reach a screen reader too: every row with a hover says the same words, hidden, inside the row", async () => {
  answer({
    stdout: listOf(
      { alias: 'work', active: true, usage: { fiveHour: limit(95), sevenDay: limit(40) } },
      { alias: 'roomy', usage: { fiveHour: limit(10) } },
      { alias: 'old', usageAgeSeconds: 7_200, usage: { fiveHour: limit(30) } },
      { alias: 'build key', email: 'api-key-4@token.local', usageStatus: 'api_key' },
    ),
  });
  const el = await open('accounts');
  for (const number of [1, 2, 3, 4]) {
    const hidden = row(el, number).querySelector('[data-account-detail]');
    expect(hidden?.classList.contains('ib-sr')).toBe(true);
    expect(hidden?.textContent).toBe(detailOf(row(el, number)).join('. '));
  }
  expect(row(el, 2).querySelector('[data-account-detail]')?.textContent).toContain('Most room');
  expect(row(el, 3).querySelector('[data-account-detail]')?.textContent).toContain('Last read 2h ago');
  expect(row(el, 4).querySelector('[data-account-detail]')?.textContent).toBe('API key, billed per token');
});

test.skipIf(!hasDom)('a named API key says "API key" beside its name on a phone, which has no hover; on a desktop its hover says it', async () => {
  const keys = listOf({ alias: 'work', active: true }, { alias: 'build key', email: 'api-key-2@token.local', usageStatus: 'api_key' }, { email: 'api-key-3@token.local', usageStatus: 'api_key' });
  answer({ stdout: keys });
  const desk = await open('accounts');
  expect(notesOf(row(desk, 2))).toBeNull();
  act(() => root?.unmount());
  host?.remove();
  phone = true;
  const onPhone = await open('accounts');
  expect(notesOf(row(onPhone, 2))).toBe('API key');
  // A key with no name already reads "API key": not twice.
  expect(nameOf(row(onPhone, 3))).toBe('API key');
  expect(notesOf(row(onPhone, 3))).toBeNull();
});

test.skipIf(!hasDom)('"on <machine>" has its own box after the other notes, so they shorten first and it keeps its words', async () => {
  answer({ stdout: listOf({ alias: 'work', email: 'w@fake.test', active: true }, { alias: 'side', email: 'p@fake.test', organizationName: 'Home', usageStatus: 'relogin_required' }, { alias: 'side', email: 'q@fake.test', organizationName: 'Away' }) });
  linked = [{ id: 'ibx_mini', name: 'Mac mini', answer: () => farList({ alias: 'side', email: 'p@fake.test', organizationName: 'Home', active: true }) }];
  const el = await open('accounts');
  await until(() => order(el, 'ibx_mini').length === 1, "the other machine's row");
  const rowEl = machineOf(el)!.querySelector('[data-account="2"]')!;
  expect(notesOf(rowEl)).toBe('Home · Sign in again · on Mac mini');
  expect(rowEl.querySelector('.ib-acct-on')?.textContent).toBe('on Mac mini');
  expect(rowEl.querySelector('.ib-acct-cut')?.textContent).toBe('Home · Sign in again ·');
});

/** Everything in the list a person could press or Tab to. Refresh sits by the page's title, outside it. */
const pressable = (el: ParentNode) => [...(el.querySelector('.ib-accts')?.querySelectorAll('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"]), [role="button"], [aria-expanded]') ?? [])];

test.skipIf(withoutSwitching)('switching is off: no row is a switch by mouse, keyboard or tap, no word or hover says switch, and nothing is asked or run', async () => {
  // A switch would work here if anything reached it.
  writeFakeCswap(bin, { stdout: LIST }, { stdout: SWITCH_OK, listAfter: LIST_AFTER });
  linked = [{ id: 'ibx_mini', name: 'Mac mini', answer: () => farList({ alias: 'personal', email: 'a@fake.test', organizationName: 'Fake a@fake.test', active: true }, { alias: 'build' }) }];
  for (const onPhone of [false, true]) {
    phone = onPhone;
    const el = await open('accounts');
    await until(() => order(el, 'ibx_mini').length === 2, "the other machine's rows");
    const rows = [...el.querySelectorAll('[data-account]')];
    expect(rows).toHaveLength(5);
    for (const rowEl of rows) {
      expect(rowEl.tagName).toBe('DIV');
      expect(['tabindex', 'role', 'aria-expanded', 'aria-disabled'].filter((name) => rowEl.hasAttribute(name))).toEqual([]);
      // No dead hover word, and the hover's detail never offers one.
      expect(rowEl.querySelector('.ib-acct-sw')?.textContent).toBe('');
      expect(detailOf(rowEl).join(' ')).not.toMatch(/switch/i);
    }
    expect(pressable(el).map(shown)).toEqual([]);
    expect(el.querySelector('.ib-accts')?.textContent).not.toMatch(/switch|tap|press|click/i);
    // A click (a tap), Enter and Space on every row open nothing.
    for (const rowEl of rows) {
      act(() => (rowEl as HTMLElement).click());
      for (const key of ['Enter', ' ']) act(() => void rowEl.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })));
    }
    expect(shown(confirmOf(el))).toBeNull();
    if (!onPhone) {
      act(() => root?.unmount());
      host?.remove();
    }
  }
  expect(switches).toEqual([]);
  expect(switchRuns()).toEqual([]);
});

test.skipIf(withoutSwitching)('switching is off: the Inbox has no switch route, so nothing runs whatever is sent to it', async () => {
  writeFakeCswap(bin, { stdout: LIST }, { stdout: SWITCH_OK, listAfter: LIST_AFTER });
  const target = JSON.stringify({ number: 1, email: 'a@fake.test', organizationName: 'Fake a@fake.test', alias: 'personal' });
  for (const method of ['POST', 'GET', 'PUT']) {
    const refused = await call('/api/inbox/accounts/switch', method, method === 'GET' ? undefined : target);
    expect(refused.status).toBe(404);
    expect((JSON.parse(refused.text) as { code: string }).code).toBe('not_found');
  }
  // The read is still there, and the account in use is still the one it was.
  const read = await call('/api/inbox/accounts?fresh=1');
  expect(read.status).toBe(200);
  expect((JSON.parse(read.text) as { accounts: { number: number; active: boolean }[] }).accounts.find((account) => account.active)?.number).toBe(2);
  expect(switchRuns()).toEqual([]);
});

/** `count` logins with long, unbroken names: no organization, so a row's only note can be "on <machine>". */
function worstLogins(count: number, start: number, inUse: number) {
  return Array.from({ length: count }, (_, i) => {
    const n = start + i;
    const base = { email: `${'averyveryverylongaddressthatneverbreaks'.repeat(2)}${n}@fake.test`, organizationName: '', active: i === inUse };
    if (n % 9 === 4) return { ...base, alias: `build-key-with-a-name-far-too-long-for-any-row-${n}`, email: `api-key-${n}@token.local`, usageStatus: 'api_key', usage: null };
    return { ...base, alias: n % 3 === 0 ? null : `${'login-with-a-name-far-too-long-for-any-row-'.repeat(3)}${n}`, usage: { fiveHour: limit((n * 7) % 100), sevenDay: limit((n * 13) % 100), scoped: [{ ...limit((n * 11) % 100), name: 'Fable' }] } };
  });
}

test.skipIf(!hasDom)('the worst case: long unbroken names, 30 logins a machine, three machines: every row is its name, one figure and at most "on <machine>"; the rest is on hover', async () => {
  // This machine and Mac mini share logins 0-14; Build VM has its own. Mac mini's in use is this machine's login 3.
  answer({ stdout: listOf(...worstLogins(30, 0, 1)) });
  linked = [
    { id: 'ibx_mini', name: 'Mac mini', answer: () => farList(...worstLogins(15, 0, 3).map((row) => ({ ...row, organizationName: null })), ...worstLogins(15, 100, -1)) },
    { id: 'ibx_vm', name: 'Build VM', answer: () => farList(...worstLogins(30, 200, 0)) },
  ];
  const el = await open('accounts');
  await until(() => order(el, 'ibx_mini').length === 30 && order(el, 'ibx_vm').length === 30, 'every machine');
  expect(blocks(el)).toEqual([machineName(el)!, 'Mac mini', 'Build VM']);
  for (const key of ['self', 'ibx_mini', 'ibx_vm']) {
    const rows = [...machineOf(el, key)!.querySelectorAll('[data-account]')];
    expect(rows).toHaveLength(30);
    expect(rows[0]!.hasAttribute('data-in-use')).toBe(true);
    for (const rowEl of rows) {
      const figure = rowEl.querySelector('b[data-usage]')?.textContent ?? '';
      const notes = notesOf(rowEl);
      // Only this machine's rows not in use carry the hover's "Switch", and only while switching is on.
      const hover = INBOX_ACCOUNT_SWITCHING && key === 'self' && !rowEl.hasAttribute('data-in-use') ? 'Switch' : '';
      // The face is the name, its note and its figure: nothing else.
      expect(faceOf(rowEl)).toBe(`${nameOf(rowEl)}${notes ?? ''}${figure}${hover}`);
      expect(notes === null || notes.startsWith('on ')).toBe(true);
      expect(bars(rowEl).length).toBeLessThanOrEqual(1);
      // The name is whole in the page (the browser shortens it): no letters dropped.
      expect(nameOf(rowEl)!.length).toBeGreaterThan(20);
      if (figure) expect(detailOf(rowEl)[0]).toMatch(/^5h \d+% · Fable \d+% · week \d+%$/);
      else expect(detailOf(rowEl)).toEqual(['API key, billed per token']);
    }
  }
  // Shared logins say where else they are in use; Build VM's own logins never do.
  expect(notesOf(row(el, 4))).toBe('on Mac mini');
  expect(notesOf(row(el, 2, 'ibx_mini'))).toBe(`on ${machineName(el)}`);
  expect([...machineOf(el, 'ibx_vm')!.querySelectorAll('[data-account-notes]')].map((note) => note.textContent)).toEqual([]);
  expect(el.querySelector('.ib-accts')?.textContent).not.toContain('@');
});

/** Switch: every non-current row, its confirm under it, and what the page says after. */
const SWITCH_OK = hasDom ? readFileSync(join(FIXTURES, 'switch-ok.json'), 'utf8') : '';
const SWITCH_ERROR = hasDom ? readFileSync(join(FIXTURES, 'switch-error.json'), 'utf8') : '';
/** The sample list after `cswap switch 1`: account 1 in use. */
const LIST_AFTER = hasDom
  ? (() => {
      const list = JSON.parse(LIST) as { accounts: { number: number; active: boolean }[] };
      return JSON.stringify({ ...list, activeAccountNumber: 1, accounts: list.accounts.map((account) => ({ ...account, active: account.number === 1 })) });
    })()
  : '';
const switchNote = (el: ParentNode) => el.querySelector('[data-accounts-switch-failed]');
/** The switch line's words, or null (see `shown`). */
const lineText = (el: ParentNode) => switchNote(el)?.textContent ?? null;
const switchRuns = () => fakeCswapCalls(bin).filter((call) => call.startsWith('switch'));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
/** The account this machine's list shows in use. */
const inUseName = (el: ParentNode) => {
  const rowEl = machineOf(el)?.querySelector('[data-in-use]');
  return rowEl ? nameOf(rowEl) : null;
};

/** Presses this machine's row `number`, then Switch in the confirm under it. */
async function switchTo(el: ParentNode, number: number) {
  await until(() => row(el, number)?.tagName === 'BUTTON' && !(row(el, number) as HTMLButtonElement).disabled, `row ${number} to press`);
  act(() => row(el, number).click());
  await act(async () => (confirmOf(el)!.querySelector('[data-accounts-switch-go]') as HTMLButtonElement).click());
}

test.skipIf(withSwitching)('Switch says Switching… on its row and holds every row until the read after it, which puts the new login first', async () => {
  writeFakeCswap(bin, { stdout: LIST }, { stdout: SWITCH_OK, listAfter: LIST_AFTER, delay: 0.4 });
  const el = await open('accounts');
  expect(inUseName(el)).toBe('b');
  await switchTo(el, 1);
  expect(confirmOf(el)).toBeNull();
  await until(() => row(el, 1).querySelector('[data-going]') !== null, 'Switching…');
  expect(row(el, 1).querySelector('[data-going]')?.textContent).toBe('Switching…');
  expect((row(el, 3) as HTMLButtonElement).disabled).toBe(true);
  expect((row(el, 1) as HTMLButtonElement).disabled).toBe(true);
  await until(() => inUseName(el) === 'personal', 'the account now in use');
  expect(order(el)[0]).toBe('personal');
  expect(switches).toHaveLength(1);
  expect(switches[0]).toMatchObject({ number: 1, email: 'a@fake.test', organizationName: 'Fake a@fake.test', alias: 'personal' });
  expect(switchRuns()).toEqual(['switch 1 --json']);
  expect(lineText(el)).toBeNull();
  // Said once, after the switch, under the login now in use: not in the confirm.
  expect(row(el, 1).nextElementSibling?.getAttribute('data-accounts-restart')).toBe('');
  expect(el.querySelectorAll('[data-accounts-restart]')).toHaveLength(1);
  // The old login is now a switch like any other.
  expect(row(el, 2).tagName).toBe('BUTTON');
  expect((row(el, 2) as HTMLButtonElement).disabled).toBe(false);
});

test.skipIf(withSwitching)("a failed switch says so under the row it was for, in the page's words, never cswap's; Try again asks again", async () => {
  writeFakeCswap(bin, { stdout: LIST }, { stdout: SWITCH_ERROR, stderr: 'stderr-words-of-cswap', exit: 1 });
  const el = await open('accounts');
  await switchTo(el, 1);
  await until(() => switchNote(el) !== null, 'the failure line');
  expect(switchNote(el)!.getAttribute('data-accounts-switch-failed')).toBe('run_failed');
  // Pinned on purpose: PR #2555's wording, kept by the approval.
  expect(lineText(el)).toBe("Couldn't switch to personal. claude-swap failed.Try again");
  expect(row(el, 1).nextElementSibling).toBe(switchNote(el));
  expect(row(el, 1).querySelector('.ib-acct-dot')?.hasAttribute('data-failed')).toBe(true);
  expect(el.textContent).not.toContain('Account-9');
  expect(el.textContent).not.toContain('words-of-cswap');
  expect(inUseName(el)).toBe('b');
  // No switch, no word about restarting.
  expect(el.querySelector('[data-accounts-restart]')).toBeNull();
  act(() => (switchNote(el)!.querySelector('[data-accounts-retry]') as HTMLButtonElement).click());
  expect(row(el, 1).nextElementSibling).toBe(confirmOf(el));
  expect(switchRuns()).toEqual(['switch 1 --json']);
  // The next switch starts clean.
  writeFakeCswap(bin, { stdout: LIST }, { stdout: SWITCH_OK, listAfter: LIST_AFTER });
  await act(async () => (confirmOf(el)!.querySelector('[data-accounts-switch-go]') as HTMLButtonElement).click());
  await until(() => inUseName(el) === 'personal', 'the account now in use');
  expect(lineText(el)).toBeNull();
});

test.skipIf(withSwitching)('a switch that outlasts the wait: the read after it has the last word', async () => {
  answer({ stdout: LIST });
  const el = await open('accounts');

  // It ended in the account picked while the window waited: done, nothing to say.
  switchRoute = async () => {
    answer({ stdout: LIST_AFTER });
    return json({ state: 'failed', reason: 'timed_out' });
  };
  await switchTo(el, 1);
  await until(() => inUseName(el) === 'personal', 'the account now in use');
  expect(lineText(el)).toBeNull();

  // It ended, and not there: it did not switch.
  switchRoute = async () => json({ state: 'failed', reason: 'timed_out' });
  await switchTo(el, 2);
  await until(() => switchNote(el) !== null, 'the failure line');
  expect(switchNote(el)!.querySelector('span')?.textContent).toBe("Couldn't switch to b. claude-swap failed.");
  expect(inUseName(el)).toBe('personal');

  // The read after it could not tell either: still switching, no failure, and the list stays as it was.
  accountsRoute = async () => json({ state: 'failed', reason: 'timed_out' });
  await switchTo(el, 2);
  await until(() => switchNote(el)?.getAttribute('data-accounts-switch-failed') === 'still_switching', 'still switching');
  expect(lineText(el)).toBe('Still switching to b. Refresh in a moment.');
  expect(row(el, 2).querySelector('.ib-acct-dot')?.hasAttribute('data-failed')).toBe(false);
  expect(inUseName(el)).toBe('personal');
});

test.skipIf(withSwitching)('a switch that worked, with a read after it that failed, says it switched: never a failure, never a guess in the list', async () => {
  answer({ stdout: LIST });
  const el = await open('accounts');
  switchRoute = async () => {
    accountsRoute = async () => {
      throw new TypeError('Failed to fetch');
    };
    return json({ state: 'switched', number: 1 });
  };
  await switchTo(el, 1);
  await until(() => switchNote(el) !== null, 'the line');
  expect(switchNote(el)!.getAttribute('data-accounts-switch-failed')).toBe('unconfirmed');
  expect(lineText(el)).toBe('Switched to personal. Refresh to see it.');
  expect(inUseName(el)).toBe('b');
});

test.skipIf(withSwitching)('a list renumbered since the page read it switches nothing and says to pick again, above the list', async () => {
  answer({ stdout: LIST });
  const el = await open('accounts');
  // In a terminal, meanwhile: `cswap swap 1 3`.
  const swapped = JSON.parse(LIST) as { accounts: { number: number }[] };
  answer({ stdout: JSON.stringify({ ...swapped, accounts: swapped.accounts.map((account) => ({ ...account, number: account.number === 1 ? 3 : account.number === 3 ? 1 : account.number })) }) });
  await switchTo(el, 1);
  await until(() => switchNote(el) !== null, 'the failure line');
  expect(switchNote(el)!.querySelector('span')?.textContent).toBe("Couldn't switch to personal. The accounts changed. Pick again.");
  // The login it named is no longer under that number: the line goes above the list, with no Try again.
  expect(switchNote(el)!.nextElementSibling?.classList.contains('ib-acct-rows')).toBe(true);
  expect(switchNote(el)!.querySelector('[data-accounts-retry]')).toBeNull();
  expect(switchRuns()).toEqual([]);
});

test.skipIf(withSwitching)('a switch the server refuses says Owner only; another login under the same number says so', async () => {
  answer({ stdout: LIST });
  const el = await open('accounts');
  switchRoute = async () => json({ error: 'refused', code: 'owner_only' }, 403);
  await switchTo(el, 1);
  await until(() => switchNote(el) !== null, 'the failure line');
  expect(switchNote(el)!.querySelector('span')?.textContent).toBe("Couldn't switch to personal. Owner only.");

  switchRoute = async () => json({ state: 'failed', reason: 'renumbered' });
  await switchTo(el, 3);
  await until(() => switchNote(el)?.getAttribute('data-accounts-switch-failed') === 'renumbered', 'the line');
  expect(switchNote(el)!.querySelector('span')?.textContent).toBe("Couldn't switch to API key. The accounts changed during the switch. The list shows the one in use.");
});

test.skipIf(withSwitching)('the peek stays read-only: no switch in it, before or after a switch', async () => {
  writeFakeCswap(bin, { stdout: LIST }, { stdout: SWITCH_OK, listAfter: LIST_AFTER });
  const el = await open('accounts');
  await switchTo(el, 1);
  await until(() => inUseName(el) === 'personal', 'the account now in use');
  act(() => root?.unmount());
  host?.remove();
  window.location.hash = '';
  const inbox = await openInbox();
  await openPeek(inbox);
  expect(shown(peek()!.querySelector('[data-account], [data-accounts-confirm], [role="menu"]'))).toBeNull();
  expect(peek()!.textContent).not.toContain('Switch');
  expect(peek()!.textContent).toContain('personal');
});

test.skipIf(withSwitching)("a later read answers the switch's line: Refresh clears \"Still switching\" once it shows the account in use, and a \"Couldn't switch\" too", async () => {
  answer({ stdout: LIST });
  const el = await open('accounts');
  switchRoute = async () => json({ state: 'failed', reason: 'timed_out' });
  accountsRoute = async () => json({ state: 'failed', reason: 'timed_out' });
  await switchTo(el, 1);
  await until(() => switchNote(el)?.getAttribute('data-accounts-switch-failed') === 'still_switching', 'still switching');
  // The switch ended meanwhile, in the account picked.
  accountsRoute = null;
  answer({ stdout: LIST_AFTER });
  act(() => refresh(el).click());
  await until(() => inUseName(el) === 'personal', 'the account now in use');
  expect(lineText(el)).toBeNull();

  switchRoute = async () => json({ state: 'failed', reason: 'run_failed' });
  await switchTo(el, 2);
  await until(() => switchNote(el) !== null, 'the failure line');
  act(() => refresh(el).click());
  await until(() => switchNote(el) === null, 'the line answered');
  expect(inUseName(el)).toBe('personal');
});

test.skipIf(withSwitching)('an open confirm holds its login: a read after `cswap swap` in a terminal keeps it on that login under its new number, and a login gone closes it', async () => {
  answer({ stdout: listOf({ alias: 'work', active: true }, { alias: 'personal' }, { alias: 'side' }) });
  const el = await open('accounts');
  act(() => row(el, 2).click());
  expect(confirmOf(el)!.getAttribute('aria-label')).toContain('to personal?');
  // Meanwhile, in a terminal: `cswap swap 2 3`. Same logins, new numbers.
  answer({ stdout: listOf({ alias: 'work', active: true }, { alias: 'side', email: 'user3@fake.test' }, { alias: 'personal', email: 'user2@fake.test' }) });
  act(() => refresh(el).click());
  await until(() => row(el, 3) !== null && nameOf(row(el, 3)) === 'personal', 'the renumbered list');
  expect(row(el, 3).nextElementSibling).toBe(confirmOf(el));
  expect(confirmOf(el)!.getAttribute('aria-label')).toContain('to personal?');
  expect(row(el, 2).getAttribute('aria-expanded')).toBe('false');
  // `cswap remove` of that login: its confirm closes, and no other login's opens in its place.
  answer({ stdout: listOf({ alias: 'work', active: true }, { alias: 'side', email: 'user3@fake.test' }) });
  act(() => refresh(el).click());
  await until(() => order(el).length === 2, 'the list without it');
  await until(() => confirmOf(el) === null, 'the confirm closed');
  expect(switches).toEqual([]);
});

test.skipIf(withSwitching)('with no account in use and nothing shared, the confirm is its question alone: no empty line', async () => {
  answer({ stdout: listOf({ alias: 'work' }, { alias: 'personal' }) });
  const el = await open('accounts');
  act(() => row(el, 1).click());
  expect(confirmOf(el)!.querySelector('b')?.textContent).toContain('to work?');
  expect(shown(confirmOf(el)!.querySelector('p'))).toBeNull();
});
