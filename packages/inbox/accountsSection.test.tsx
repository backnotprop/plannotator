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

const hasDom = typeof document !== 'undefined';
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
/** Every accounts read the window asked for, by URL. */
let accountReads: string[] = [];
let readsAnswered = 0;
/** Set by a test: the machines linked here, and what each one's read answers. The link itself is packages/server/inbox-accounts.test.ts's. */
let linked: { id: string; name: string; answer: () => unknown }[] = [];
/** Every read of a linked machine, by URL. */
let machineReads: string[] = [];

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
  settingsRoute = null;
  accountReads = [];
  linked = [];
  machineReads = [];
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
    if (String(input).startsWith('/api/inbox/accounts')) {
      accountReads.push(String(input));
      if (accountsRoute) return accountsRoute();
    }
    if (settingsRoute && String(input) === '/api/inbox/settings') await settingsRoute();
    const answer = await call(String(input), init?.method ?? 'GET', init?.body ? String(init.body) : undefined);
    if (String(input).startsWith('/api/inbox/accounts')) readsAnswered += 1;
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

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 120; i++) {
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
const row = (el: ParentNode, number: number) => el.querySelector(`[data-account="${number}"]`) as HTMLElement;
const nameOf = (rowEl: Element) => rowEl.querySelector('.ib-acct-name')?.textContent;
/** A row's bars, in reading order, as `label pct`. */
const bars = (rowEl: Element) => [...rowEl.querySelectorAll('[data-usage]')].map((bar) => bar.textContent?.replace(/(\d+%)$/, ' $1'));

const machineGroup = (el: ParentNode) => el.querySelector('[data-accounts-machine]');
const toggle = (rowEl: Element) => rowEl.querySelector('button.ib-acct-row') as HTMLButtonElement | null;

test.skipIf(!hasDom)('the sample: alias, else the start of the address, else "API key"; no placeholder address anywhere', async () => {
  answer({ stdout: LIST });
  const el = await open('accounts');
  expect(nameOf(row(el, 1))).toBe('personal');
  expect(nameOf(row(el, 2))).toBe('b');
  expect(nameOf(row(el, 3))).toBe('API key');
  expect(el.textContent).not.toContain('token.local');
});

test.skipIf(!hasDom)('Machines comes first and says which account this machine is using, with no control on it', async () => {
  answer({ stdout: LIST });
  const el = await open('accounts');
  const group = machineGroup(el)!;
  expect(group.querySelector('.ib-acct-ro')?.textContent).toBe('b');
  // In document order, before the accounts.
  expect(group.compareDocumentPosition(el.querySelector('[data-settings-accounts]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(group.querySelector('button, select, [role="menu"]')).toBeNull();
});

test.skipIf(!hasDom)('Machines shows only with an account in use: not when none is active, not when the first read failed', async () => {
  answer({ stdout: listOf({ alias: 'one' }) });
  const el = await open('accounts');
  expect(machineGroup(el)).toBeNull();
  answer({ stdout: LIST });
  act(() => refresh(el).click());
  await until(() => machineGroup(el) !== null, 'the machine');
  act(() => root?.unmount());
  host?.remove();
  answer({ stdout: 'Traceback' });
  const failed = await open('failed');
  expect(machineGroup(failed)).toBeNull();
  expect(failed.querySelector('[data-account]')).toBeNull();
});

test.skipIf(!hasDom)('a failed Refresh keeps the good list and says so above it; the next good read clears the line', async () => {
  answer({ stdout: LIST });
  const el = await open('accounts');
  const line = () => el.querySelector('[data-accounts-failed]');
  answer({ stdout: 'Traceback' });
  act(() => refresh(el).click());
  await until(() => line() !== null, 'the failure line');
  expect(line()?.getAttribute('data-accounts-failed')).toBe('bad_output');
  expect(stateOf(el)).toBe('accounts');
  expect(nameOf(row(el, 1))).toBe('personal');
  expect(machineGroup(el)).not.toBeNull();
  expect(line()!.compareDocumentPosition(el.querySelector('.ib-acct-list')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

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
  expect(nameOf(row(el, 1))).toBe('personal');
});

const fullName = (rowEl: Element) => rowEl.querySelector('.ib-acct-l')?.textContent;
const openLines = (rowEl: Element) => [...rowEl.querySelectorAll('.ib-acct-more > div')].map((line) => line.textContent);

test.skipIf(!hasDom)('an organization named after the address is no organization: not on a closed row, the machine or an open row', async () => {
  answer({
    stdout: listOf(
      { email: 'mira@a.test', organizationName: "mira@a.test's Organization", active: true },
      { email: 'mira@b.test', organizationName: 'Fake MIRA@B.TEST' },
      { email: 'solo@c.test', organizationName: 'Fake solo@c.test' },
    ),
  });
  const el = await open('accounts');
  // The rows then read alike, so those two, and only those, carry cswap's number.
  expect(fullName(row(el, 1))).toBe('mira #1');
  expect(fullName(row(el, 2))).toBe('mira #2');
  expect(fullName(row(el, 3))).toBe('solo');
  expect(el.querySelector('.ib-acct-org')).toBeNull();
  expect(machineGroup(el)?.querySelector('.ib-acct-ro')?.textContent).toBe('mira #1');
  expect(el.querySelector('.ib-spg')?.textContent).not.toContain('@');
  act(() => toggle(row(el, 1))!.click());
  // The address once, and no organization line.
  expect(openLines(row(el, 1))).toEqual(['mira@a.test']);
});

test.skipIf(!hasDom)('the number shows only while rows read alike: a real organization tells them apart, the same one does not', async () => {
  answer({
    stdout: listOf(
      { email: 'a@fake.test', organizationName: 'Fake a@fake.test' },
      { email: 'a@fake.test', organizationName: 'North' },
      { alias: 'team', email: 'b@fake.test', organizationName: 'South' },
      { alias: 'team', email: 'c@fake.test', organizationName: 'South' },
    ),
  });
  const el = await open('accounts');
  expect(fullName(row(el, 1))).toBe('a');
  expect(row(el, 1).querySelector('.ib-acct-org')).toBeNull();
  expect(fullName(row(el, 2))).toBe('a');
  expect(row(el, 2).querySelector('.ib-acct-org')?.textContent).toBe('North');
  expect(fullName(row(el, 3))).toBe('team #3');
  expect(fullName(row(el, 4))).toBe('team #4');
  expect(row(el, 4).querySelector('.ib-acct-org')?.textContent).toBe('South');
});

test.skipIf(!hasDom)('an old reading: muted, never amber, "Last read" only in the open row; a reading under 10 minutes is left alone', async () => {
  answer({ stdout: readFileSync(join(FIXTURES, 'stale.json'), 'utf8') });
  const el = await open('accounts');
  const stale = row(el, 1).querySelector('[data-account-use]')!;
  expect(stale.hasAttribute('data-stale')).toBe(true);
  // 92% and old is not amber. Its 5h has passed its reset, so it reads as not reported.
  expect(bars(row(el, 1))).toEqual(['week 92%']);
  expect(row(el, 1).querySelector('[data-high]')).toBeNull();
  expect(row(el, 1).textContent).not.toContain('Last read');
  act(() => toggle(row(el, 1))!.click());
  expect(openLines(row(el, 1)).at(-1)).toBe('Last read 2h ago');

  const fresh = row(el, 2).querySelector('[data-account-use]')!;
  expect(fresh.hasAttribute('data-stale')).toBe(false);
  expect(row(el, 2).querySelector('[data-usage="5h"]')?.hasAttribute('data-high')).toBe(true);
  act(() => toggle(row(el, 2))!.click());
  expect(openLines(row(el, 2)).join()).not.toContain('Last read');
});

test.skipIf(!hasDom)('how old an old reading says it is, the 10 minute line, and no age with nothing to date', async () => {
  const usage = { sevenDay: { pct: 40 } };
  answer({
    stdout: listOf(
      { usage, usageAgeSeconds: 600 },
      { usage, usageAgeSeconds: 601 },
      { usage, usageAgeSeconds: 7_200 },
      { usage, usageAgeSeconds: 300_000 },
      { usage: null, usageAgeSeconds: 7_200 },
    ),
  });
  const el = await open('accounts');
  const said = (number: number) => {
    act(() => toggle(row(el, number))!.click());
    return openLines(row(el, number)).find((line) => line?.startsWith('Last read'));
  };
  expect(said(1)).toBeUndefined();
  expect(said(2)).toBe('Last read 10m ago');
  expect(said(3)).toBe('Last read 2h ago');
  expect(said(4)).toBe('Last read 3d ago');
  expect(said(5)).toBeUndefined();
});

test.skipIf(!hasDom)('two rows with one name: the machine says which one it is using', async () => {
  answer({ stdout: listOf({ email: 'a@fake.test', organizationName: 'North' }, { email: 'a@fake.test', organizationName: 'South', active: true }) });
  const el = await open('accounts');
  expect(machineGroup(el)?.querySelector('.ib-acct-ro')?.textContent).toBe('a · South');
});

test.skipIf(!hasDom)('the address, organization and reset times stay out until a row is opened, and go again when it closes', async () => {
  const later = { pct: 41, resetsAt: '2099-11-05T12:00:00+00:00', countdown: '3d 23h', clock: 'Nov 5 12:00' };
  answer({ stdout: listOf({ alias: 'work', email: 'hidden@fake.test', organizationName: 'North', usage: { fiveHour: later, sevenDay: { ...later, clock: null } } }) });
  const el = await open('accounts');
  const shut = row(el, 1).textContent;
  for (const secret of ['hidden@fake.test', 'North', 'Nov 5', '3d 23h']) expect(shut).not.toContain(secret);
  expect(row(el, 1).querySelector('[title]')).toBeNull();
  const button = toggle(row(el, 1))!;
  expect(button.getAttribute('aria-expanded')).toBe('false');
  act(() => button.click());
  expect(button.getAttribute('aria-expanded')).toBe('true');
  const lines = [...row(el, 1).querySelectorAll('.ib-acct-more > div')].map((line) => line.textContent);
  expect(lines).toEqual(['hidden@fake.test', 'North', 'Resets 5h Nov 5 12:00 · week in 3d 23h']);
  act(() => button.click());
  expect(row(el, 1).querySelector('.ib-acct-more')).toBeNull();
});

test.skipIf(!hasDom)('an open row stays open through a Refresh; a row with nothing to open is no button', async () => {
  answer({ stdout: LIST });
  const el = await open('accounts');
  act(() => toggle(row(el, 1))!.click());
  act(() => refresh(el).click());
  await until(() => !refresh(el).disabled, 'the refresh');
  expect(row(el, 1).querySelector('.ib-acct-more')).not.toBeNull();
  expect(nameOf(row(el, 3))).toBe('API key');
  expect(toggle(row(el, 3))).toBeNull();
});

test.skipIf(!hasDom)('the windows: only those reported; week last, whatever else there is; scoped by its name; missing is never 0%', async () => {
  answer({
    stdout: listOf(
      { usage: WINDOWS.pro_max },
      { usage: { sevenDay: { pct: 58 }, scoped: [{ name: 'Fable', pct: 33 }] } },
      { usage: WINDOWS.ultra_five_hour_absent },
      { usage: { fiveHour: { pct: 92 }, sevenDay: { pct: 67 }, scoped: [{ name: 'Fable', pct: 12 }] } },
      { usage: { fiveHour: { pct: 41 } } },
    ),
  });
  const el = await open('accounts');
  expect(bars(row(el, 1))).toEqual(['5h 41%', 'week 58%']);
  expect(bars(row(el, 2))).toEqual(['Fable 33%', 'week 58%']);
  expect(bars(row(el, 3))).toEqual(['week 30%']);
  // Three windows: all of them (the spec measures the line).
  expect(bars(row(el, 4))).toEqual(['5h 92%', 'Fable 12%', 'week 67%']);
  expect(bars(row(el, 5))).toEqual(['5h 41%']);
  expect(row(el, 3).textContent).not.toContain('5h');
});

test.skipIf(!hasDom)('a window of 0% with no reset time shows as reported (the decided difference from the mock)', async () => {
  answer({ stdout: listOf({ usage: WINDOWS.hollow_five_hour }) });
  const el = await open('accounts');
  expect(bars(row(el, 1))).toEqual(['5h 0%', 'week 30%']);
});

test.skipIf(!hasDom)('amber at 90% and over, not under', async () => {
  answer({ stdout: listOf({ usage: { fiveHour: { pct: 89 }, sevenDay: { pct: 90 } } }, { usage: { sevenDay: { pct: 104 } } }) });
  const el = await open('accounts');
  expect(row(el, 1).querySelector('[data-usage="5h"]')?.hasAttribute('data-high')).toBe(false);
  expect(row(el, 1).querySelector('[data-usage="week"]')?.hasAttribute('data-high')).toBe(true);
  // Over 100 reads as reported; the bar stops at full.
  expect(bars(row(el, 2))).toEqual(['week 104%']);
  expect(row(el, 2).querySelector('i')?.getAttribute('style')).toContain('100%');
});

test.skipIf(!hasDom)('no reading says so with the reason in plain words, and an API key says what it is; neither draws a bar', async () => {
  const later = new Date(Date.now() + 3_600_000).toISOString();
  answer({
    stdout: listOf(
      { usageStatus: 'unavailable', usageError: 'network' },
      { usageStatus: 'relogin_required' },
      { usageStatus: 'unavailable', usageError: 'http-429', usageRetryAt: later },
      { usageStatus: 'unavailable', usageError: 'http-429', usageRetryAt: '2020-01-01T00:00:00Z' },
      { usageStatus: 'constructor' },
      { usageStatus: 'api_key', email: 'api-key-6@token.local', alias: 'build key' },
      { usageStatus: 'api_key', email: 'api-key-7@token.local' },
    ),
  });
  const el = await open('accounts');
  for (const number of [1, 2, 3, 4, 5]) {
    expect(row(el, number).textContent).toContain('No reading yet');
    expect(row(el, number).querySelector('[data-usage]')).toBeNull();
    // Never the code itself.
    expect(row(el, number).textContent).not.toMatch(/relogin_required|http-429|unavailable|constructor/);
  }
  expect(row(el, 1).querySelector('.ib-acct-why')?.textContent).toContain('Anthropic');
  expect(row(el, 2).querySelector('.ib-acct-why')?.textContent).toContain('Sign in');
  expect(row(el, 3).querySelector('.ib-acct-why')?.textContent).toContain('Try again after');
  expect(row(el, 4).querySelector('.ib-acct-why')?.textContent).not.toContain('Try again');
  expect(row(el, 6).querySelector('[data-account-use]')?.textContent).toBe('API key');
  expect(row(el, 6).textContent).not.toContain('No reading yet');
  expect(row(el, 6).querySelector('[data-usage]')).toBeNull();
  // An API key with no alias is already called that: not twice on one row.
  expect(row(el, 7).textContent).toBe('API key');
});

test.skipIf(!hasDom)('the same address under two organizations says which is which; other rows stay one line', async () => {
  answer({ stdout: listOf({ email: 'a@fake.test', organizationName: 'North' }, { email: 'a@fake.test', organizationName: 'South' }, { email: 'c@fake.test', organizationName: 'West' }) });
  const el = await open('accounts');
  expect(row(el, 1).querySelector('.ib-acct-org')?.textContent).toBe('North');
  expect(row(el, 2).querySelector('.ib-acct-org')?.textContent).toBe('South');
  expect(row(el, 3).querySelector('.ib-acct-org')).toBeNull();
});

test.skipIf(!hasDom)('no saved accounts: the command that saves one, to copy', async () => {
  answer({ stdout: listOf() });
  const el = await open('accounts');
  // Pinned on purpose: the command a person runs, from claude-swap's README.
  expect(el.querySelector('[data-accounts-none] .ib-cbox pre')?.textContent).toBe('cswap add');
  expect(el.querySelector('[data-account]')).toBeNull();
});

test.skipIf(!hasDom)('not installed: one line and the install command to copy; once installed, Refresh finds it', async () => {
  const el = await open('not_installed');
  // Pinned on purpose: the command a person runs, from claude-swap's README.
  expect(el.querySelector('.ib-cbox pre')?.textContent).toBe(INSTALL_COMMAND);
  expect(el.querySelector('.ib-cbox button')?.textContent).toBe('Copy');
  expect(el.querySelector('[data-account]')).toBeNull();
  // The Inbox looks only on the PATH it started with, so Refresh can't fix this one.
  expect(el.textContent).toContain('Restart the Inbox');
  answer({ stdout: LIST });
  act(() => refresh(el).click());
  await until(() => stateOf(el) === 'accounts', 'the accounts');
  removeFakeCswap(bin);
  await until(() => !refresh(el).disabled, 'the read done');
  act(() => refresh(el).click());
  await until(() => stateOf(el) === 'not_installed', 'not installed again');
});

test.skipIf(!hasDom)('failed: a plain line and Refresh for each reason, never cswap\'s own words; Refresh recovers', async () => {
  answer({ stdout: JSON.stringify({ schemaVersion: 1, error: { message: 'words-of-cswap' } }), stderr: 'words-of-cswap', exit: 1 });
  const el = await open('failed');
  const line = () => el.querySelector('[data-accounts-failed]');
  expect(line()?.getAttribute('data-accounts-failed')).toBe('run_failed');
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
  answer({ stdout: LIST });
  act(() => refresh(el).click());
  await until(() => stateOf(el) === 'accounts', 'the accounts after a failure');
  expect(line()).toBeNull();
});

test.skipIf(!hasDom)('the read that takes seconds: a clear wait first; Refresh keeps the list up, can\'t be pressed twice, and reads once', async () => {
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
  expect(el.querySelector('[data-account="1"]')).not.toBeNull();
  await until(() => !refresh(el).disabled, 'the refresh done');
  expect(fakeCswapCalls(bin).length).toBe(before + 1);
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

test.skipIf(!hasDom)('a tailnet guest is told so and offered no Refresh; an Inbox that does not answer says that, and Refresh recovers', async () => {
  accountsRoute = async () => new Response(JSON.stringify({ error: 'refused', code: 'owner_only' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
  const el = await open('owner_only');
  expect(el.querySelector('[data-accounts-owner-only]')).not.toBeNull();
  expect(refresh(el)).toBeNull();
  act(() => root?.unmount());
  host?.remove();

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

test.skipIf(!hasDom)('on a phone it is a row in Settings\' list of sections, and opens with ‹ Settings', async () => {
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
const machineRows = (el: ParentNode) => [...el.querySelectorAll('[data-accounts-machine]')].map((rowEl) => [rowEl.querySelector('.ib-acct-name')?.textContent, rowEl.querySelector('.ib-acct-ro')?.textContent]);
const nearBlock = () => document.querySelector('[data-usage-machine]') as HTMLButtonElement | null;
const listNames = (el: ParentNode) => [...el.querySelectorAll('.ib-acct .ib-acct-name')].map((name) => name.textContent);

test.skipIf(!hasDom)('Machines lists this machine first, then each linked one and the account it is using, with no control on any', async () => {
  answer({ stdout: listOf({ alias: 'work', active: true }) });
  linked = [{ id: 'ibx_mini', name: 'Mini', answer: () => farList({ alias: 'personal', active: true }, { alias: 'build' }) }];
  const el = await open('accounts');
  await until(() => machineRows(el)[1]?.[1] === 'personal', "the other machine's account");
  expect(machineRows(el).map(([, account]) => account)).toEqual(['work', 'personal']);
  expect(machineRows(el)[1]![0]).toBe('Mini');
  expect(el.querySelector('[data-accounts-machines]')!.querySelector('button, a, input')).toBeNull();
  expect(el.querySelector('[data-accounts-machines]')!.compareDocumentPosition(el.querySelector('[data-settings-accounts]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test.skipIf(!hasDom)('every machine joins one list; a login saved on two is one row with the newer reading, naming both when opened; an API key stays its own', async () => {
  answer({ stdout: listOf({ alias: 'work', email: 'same@fake.test', active: true, usage: { fiveHour: limit(40) }, usageAgeSeconds: 500 }, { email: 'key@token.local', usageStatus: 'api_key' }) });
  linked = [
    {
      id: 'ibx_mini',
      name: 'Mini',
      answer: () =>
        farList(
          { email: 'same@fake.test', active: true, usage: { fiveHour: limit(77) }, usageAgeSeconds: 20 },
          { alias: 'side', email: 'side@fake.test', usage: { sevenDay: limit(12) } },
          { email: null, usageStatus: 'api_key' },
        ),
    },
  ];
  const el = await open('accounts');
  await until(() => listNames(el).includes('side'), "the other machine's accounts");
  expect(listNames(el).filter((name) => name === 'work')).toHaveLength(1);
  expect(listNames(el).filter((name) => name === 'API key')).toHaveLength(2);
  const work = [...el.querySelectorAll('.ib-acct')].find((item) => item.textContent?.includes('work'))!;
  expect(bars(work)).toEqual(['5h 77%']);
  await act(async () => toggle(work)!.click());
  expect(work.textContent).toContain(`${machineRows(el)[0]![0]}, Mini`);
});

test.skipIf(!hasDom)('rows one machine keeps apart stay apart, whatever they share, linked or not', async () => {
  const same = { email: 'same@fake.test', organizationName: 'Same' };
  answer({ stdout: listOf({ alias: 'one', ...same }, { alias: 'two', ...same }) });
  linked = [{ id: 'ibx_mini', name: 'Mini', answer: () => farList({ alias: 'far', ...same }) }];
  const el = await open('accounts');
  await until(() => machineRows(el).length === 2 && !refresh(el).disabled, 'the read');
  await until(() => machineRows(el)[1]?.[1] === 'No account in use', "the other machine's answer");
  expect(listNames(el)).toEqual(['one', 'two']);
});

test.skipIf(!hasDom)('with no machine linked the open row names none, and no machine is read', async () => {
  answer({ stdout: listOf({ alias: 'work', active: true, usage: { fiveHour: limit(40) } }) });
  const el = await open('accounts');
  await act(async () => toggle(el.querySelector('.ib-acct')!)!.click());
  expect(el.querySelector('.ib-acct-more')!.textContent).not.toContain(machineRows(el)[0]![0]!);
  expect(machineReads).toEqual([]);
});

test.skipIf(!hasDom)('one slow machine holds up nothing: this machine and the next machine show, and it says so itself when it answers', async () => {
  answer({ stdout: listOf({ alias: 'work', active: true, usage: { fiveHour: limit(40) } }) });
  let letGo = (_read: unknown) => {};
  linked = [
    { id: 'ibx_slow', name: 'Slow', answer: () => new Promise((done) => (letGo = done)) },
    { id: 'ibx_mini', name: 'Mini', answer: () => farList({ alias: 'personal', active: true }) },
  ];
  const el = await open('accounts');
  await until(() => machineRows(el)[2]?.[1] === 'personal' && listNames(el).includes('work'), 'the rest');
  expect(machineRows(el)[1]).toEqual(['Slow', 'Reading accounts…']);
  expect(refresh(el).disabled).toBe(false);
  await act(async () => letGo({ state: 'offline' }));
  await until(() => machineRows(el)[1]?.[1] === 'Asleep', 'its answer');
  expect(el.querySelector('[role="alert"]')).toBeNull();
});

test.skipIf(!hasDom)('offline, an older Plannotator and no cswap are quiet rows: no alert, and nothing of theirs in the list', async () => {
  answer({ stdout: listOf({ alias: 'work', active: true }) });
  linked = [
    { id: 'ibx_away', name: 'Away', answer: () => ({ state: 'offline' }) },
    { id: 'ibx_old', name: 'Old', answer: () => ({ state: 'needs_update' }) },
    { id: 'ibx_none', name: 'None', answer: () => ({ state: 'not_installed' }) },
  ];
  const el = await open('accounts');
  await until(() => machineRows(el)[1]?.[1] === 'Asleep' && machineRows(el)[2]?.[1] === 'Update Plannotator', 'the machines');
  await until(() => el.querySelector('[data-accounts-machine="None"] [data-machine-use="not_installed"]') !== null, 'the machine without cswap');
  expect(machineRows(el)[3]).toEqual(['None', '']);
  expect(el.querySelector('[role="alert"]')).toBeNull();
  expect(listNames(el)).toEqual(['work']);
  expect(el.textContent).not.toContain(INSTALL_COMMAND);
});

test.skipIf(!hasDom)('a read that goes wrong on another machine stays on its row', async () => {
  answer({ stdout: listOf({ alias: 'work', active: true }) });
  linked = [
    { id: 'ibx_broken', name: 'Broken', answer: () => ({ state: 'failed', reason: 'run_failed' }) },
    { id: 'ibx_empty', name: 'Empty', answer: () => farList() },
    { id: 'ibx_idle', name: 'Idle', answer: () => farList({ alias: 'spare' }) },
  ];
  const el = await open('accounts');
  await until(() => machineRows(el)[3]?.[1] === 'No account in use', 'the machines');
  expect(machineRows(el).slice(1)).toEqual([
    ['Broken', 'claude-swap failed.'],
    ['Empty', 'No accounts yet'],
    ['Idle', 'No account in use'],
  ]);
  expect(el.querySelector('[role="alert"]')).toBeNull();
});

test.skipIf(!hasDom)('this machine without cswap still says how to install it, under the machines that have it, and gets no Usage row', async () => {
  linked = [{ id: 'ibx_mini', name: 'Mini', answer: () => farList({ alias: 'personal', active: true, usage: { fiveHour: limit(95) } }) }];
  const el = await open('not_installed');
  await until(() => machineRows(el)[1]?.[1] === 'personal', 'the other machine');
  expect(machineRows(el)[0]![1]).toBe('');
  expect(listNames(el)).toEqual(['personal']);
  expect(el.textContent).toContain(INSTALL_COMMAND);
  expect(usageRow(el)).toBeNull();
});

test.skipIf(!hasDom)('Refresh reads every machine again and skips what each one keeps; a read asked for during another joins it', async () => {
  answer({ stdout: listOf({ alias: 'work', active: true }) });
  let name = 'first';
  linked = [{ id: 'ibx_mini', name: 'Mini', answer: () => farList({ alias: name, active: true }) }];
  const el = await open('accounts');
  await until(() => machineRows(el)[1]?.[1] === 'first', 'the first read');
  await until(() => !refresh(el).disabled, 'the read to end');
  name = 'second';
  machineReads = [];
  act(() => refresh(el).click());
  await until(() => machineRows(el)[1]?.[1] === 'second', 'Refresh');
  expect(machineReads).toEqual(['/api/inbox/accounts/ibx_mini?fresh=1']);
});

test.skipIf(!hasDom)('a tailnet guest sees no machine on the page, whatever a read of one would say', async () => {
  answer({ stdout: LIST });
  accountsRoute = async () => new Response(JSON.stringify({ error: 'refused', code: 'owner_only' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
  linked = [{ id: 'ibx_mini', name: 'Mini', answer: () => farList({ alias: 'personal', active: true }) }];
  const el = await open('owner_only');
  await until(() => machineReads.length > 0, 'the far read');
  await act(async () => new Promise((r) => setTimeout(r, 30)));
  expect(el.querySelector('[data-accounts-machines]')).toBeNull();
  expect(listNames(el)).toEqual([]);
});

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
