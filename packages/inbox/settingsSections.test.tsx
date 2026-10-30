/**
 * Settings in sections, and Pair a phone step by step (design of record
 * `.product/approved/inbox-settings-tabs/`, approved 2026-10-12). The whole
 * window (InboxApp) over REAL Inbox servers in temp data dirs
 * (tests/helpers/inbox-dom-server.ts): one that serves phones, with Tailscale
 * and step 1's checks scripted from its `machine.json` (no test runs the real
 * `tailscale`, `openssl` or system tools), and one with phones off, the
 * released default.
 *
 * Proved: the addresses (`#settings` is General, `#settings/<section>`,
 * `#settings/devices/pair`, an unknown section), the nav (links with
 * aria-current, focus to the new section's heading), "← Inbox" back to where
 * the person was, the Inbox sidebar closed while Settings is open without
 * writing its cookie, every control in the section the design puts it in,
 * the pairing flow from step 1 through the code (what reached the door) to
 * Paired, the owner's no-loop rule (every check failing and a way on: the
 * code still shows), step 1 always first, phones off, and the phone's list
 * of sections.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const hasDom = typeof document !== 'undefined';
const { InboxApp } = (hasDom ? await import('./App') : {}) as typeof import('./App');
const { storage } = (hasDom ? await import('@plannotator/ui/utils/storage') : {}) as typeof import('@plannotator/ui/utils/storage');
const { PHONE_QUERY } = (hasDom ? await import('./phone') : {}) as typeof import('./phone');

const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');
const SIDEBAR_COOKIE = 'plannotator-inbox-sidebar-open';

interface Server {
  child: ReturnType<typeof Bun.spawn>;
  port: number;
  dataDir: string;
  thread: string;
}

let dir: string | null = null;
let phonesServer: Server | null = null;
let plainServer: Server | null = null;
/** The server the window under test talks to. */
let current: Server | null = null;
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedEventSource: unknown;
let savedMatchMedia: typeof window.matchMedia;
let phone = false;
/** Every request the window made in this test, as `METHOD path`. */
const requests: string[] = [];

function call(port: number, path: string, method = 'GET', body?: string): Promise<{ status: number; text: string }> {
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

async function spawnServer(name: string, extra: string[]): Promise<Server> {
  const dataDir = join(dir!, name, 'data');
  mkdirSync(join(dir!, name, 'projects'), { recursive: true });
  const child = Bun.spawn(['bun', SERVER_SCRIPT, dataDir, join(dir!, name, 'projects'), '1', ...extra], {
    env: { ...process.env, DOM_TESTS: '0', PLANNOTATOR_DATA_DIR: dataDir, HOME: join(dir!, name) },
    stdout: 'pipe',
    // A paired phone makes the server try the relay, which tests point at a closed port; its refusals are noise here.
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
  const started = JSON.parse(line.trim()) as { port: number; worlds: { waiting: string }[] };
  return { child, port: started.port, dataDir, thread: started.worlds[0]!.waiting };
}

/** What this computer looks like to step 1, as the phones server reads it on every call. */
function machine(state: Record<string, unknown>) {
  writeFileSync(join(phonesServer!.dataDir, 'machine.json'), JSON.stringify(state));
}

beforeAll(async () => {
  if (!hasDom) return;
  (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL('http://localhost:4000/');
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-settings-dom-')));
  [phonesServer, plainServer] = await Promise.all([spawnServer('phones', ['phones']), spawnServer('plain', [])]);
}, 60_000);

afterAll(async () => {
  if (!hasDom) return;
  for (const server of [phonesServer, plainServer]) {
    server?.child.kill();
    await server?.child.exited;
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

beforeEach(() => {
  if (!hasDom) return;
  phone = false;
  current = phonesServer;
  machine({});
  storage.removeItem(SIDEBAR_COOKIE);
  savedFetch = globalThis.fetch;
  requests.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(`${init?.method ?? 'GET'} ${String(input)}`);
    const answer = await call(current!.port, String(input), init?.method ?? 'GET', init?.body ? String(init.body) : undefined);
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

afterEach(async () => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = savedFetch;
  (globalThis as Record<string, unknown>).EventSource = savedEventSource;
  window.matchMedia = savedMatchMedia;
  // Leave the phones server as each test found it: the tailnet off, no phone paired.
  if (phonesServer) {
    await call(phonesServer.port, '/api/inbox/tailnet', 'POST', JSON.stringify({ on: false }));
    const { devices } = JSON.parse((await call(phonesServer.port, '/api/inbox/devices')).text) as { devices: { id: string }[] };
    for (const device of devices) await call(phonesServer.port, `/api/inbox/devices/${device.id}/revoke`, 'POST', '{}');
  }
});

async function until(check: () => boolean | Promise<boolean>, what: string) {
  for (let i = 0; i < 120; i++) {
    if (await check()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function renderApp(hash: string) {
  window.location.hash = hash;
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<InboxApp />);
  });
  await until(() => host!.querySelector('.ib-sframe, .ib-listcol') !== null, 'the window');
  return host;
}

const heading = (el: ParentNode) => el.querySelector('.ib-spg > h1')?.textContent ?? null;
const navLink = (el: ParentNode, section: string) => el.querySelector(`.ib-snav a[data-settings-link="${section}"]`) as HTMLAnchorElement;
const sidebarState = (el: ParentNode) => el.querySelector('[data-collapsible]')?.getAttribute('data-state') ?? null;
const switchNamed = (el: ParentNode, name: string) =>
  [...el.querySelectorAll<HTMLButtonElement>('[role="switch"]')].find((sw) => {
    const label = sw.getAttribute('aria-label') ?? (sw.getAttribute('aria-labelledby') ? document.getElementById(sw.getAttribute('aria-labelledby')!)?.textContent : null);
    return label?.trim() === name;
  }) ?? null;
const buttonText = (el: ParentNode, text: string) => [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text) ?? null;

test.skipIf(!hasDom)('#settings opens General; the nav moves between sections by address, marks the one shown and moves focus to its heading; an unknown section is General', async () => {
  const el = await renderApp('#settings');
  await until(() => heading(el) === 'General', 'General');
  expect(navLink(el, 'general').getAttribute('aria-current')).toBe('page');
  // Capabilities' row comes with the settings read (it shows only while the Inbox has a capability to switch).
  await until(() => navLink(el, 'capabilities') !== null, 'the Capabilities row');
  const links = [...el.querySelectorAll<HTMLAnchorElement>('.ib-snav a')];
  // Capabilities right after Devices (the owner, 2026-10-27); Experimental is a group inside it, not a row of its own.
  expect(links.map((a) => a.textContent?.trim())).toEqual(['General', 'Agents', 'Prompts', 'Devices', 'Capabilities', 'Archived', 'Storage', 'About']);
  expect(links.map((a) => a.getAttribute('href'))).toEqual([
    '#settings/general',
    '#settings/agents',
    '#settings/prompts',
    '#settings/devices',
    '#settings/capabilities',
    '#settings/archived',
    '#settings/storage',
    '#settings/about',
  ]);
  // No line in the nav any more: nothing sits apart.
  expect(el.querySelectorAll('.ib-snav li[class]').length).toBe(0);
  for (const section of ['agents', 'prompts', 'devices', 'capabilities', 'archived', 'storage', 'about', 'general'] as const) {
    act(() => navLink(el, section).click());
    await until(() => window.location.hash === `#settings/${section}`, `#settings/${section}`);
    await until(() => navLink(el, section).getAttribute('aria-current') === 'page', `${section} marked current`);
    expect(el.querySelectorAll('.ib-snav a[aria-current]').length).toBe(1);
    expect(document.activeElement).toBe(el.querySelector('.ib-spg > h1'));
  }
  act(() => root?.unmount());
  host?.remove();
  const again = await renderApp('#settings/nonsense');
  await until(() => heading(again) === 'General', 'General for an unknown section');
});

test.skipIf(!hasDom)('the Inbox sidebar closes while Settings is open and comes back on leaving, without its cookie being written; ← Inbox returns to where the person was', async () => {
  const el = await renderApp(`#thread=${current!.thread}`);
  await until(() => sidebarState(el) === 'expanded', 'the sidebar open');
  act(() => (el.querySelector('.ib-setrow .ib-nav') as HTMLButtonElement).click());
  await until(() => heading(el) === 'General', 'Settings');
  expect(sidebarState(el)).toBe('collapsed');
  expect(storage.getItem(SIDEBAR_COOKIE)).toBeNull();
  // Moving between sections keeps it closed and keeps where Back goes.
  act(() => navLink(el, 'storage').click());
  await until(() => heading(el) === 'Storage', 'Storage');
  act(() => (el.querySelector('[data-settings-back]') as HTMLButtonElement).click());
  await until(() => window.location.hash === `#thread=${current!.thread}`, 'back to the thread');
  await until(() => sidebarState(el) === 'expanded', 'the sidebar back');
  expect(storage.getItem(SIDEBAR_COOKIE)).toBeNull();

  // A person who keeps it closed: closed in Settings, closed after, and the cookie still says so.
  storage.setItem(SIDEBAR_COOKIE, 'false');
  act(() => root?.unmount());
  host?.remove();
  const closed = await renderApp('#settings/about');
  await until(() => heading(closed) === 'About', 'About');
  expect(sidebarState(closed)).toBe('collapsed');
  act(() => (closed.querySelector('[data-settings-back]') as HTMLButtonElement).click());
  await until(() => !window.location.hash.startsWith('#settings'), 'the list');
  expect(sidebarState(closed)).toBe('collapsed');
  expect(storage.getItem(SIDEBAR_COOKIE)).toBe('false');
});

test.skipIf(!hasDom)('every control lands in the section the design puts it in', async () => {
  const el = await renderApp('#settings/general');
  await until(() => el.querySelector('[data-settings-notifications]') !== null, 'General');
  expect([...el.querySelectorAll<HTMLInputElement>('[data-settings-theme] input[name="ib-theme"]')].map((r) => r.value)).toEqual(['light', 'dark', 'system']);
  expect([...el.querySelectorAll<HTMLInputElement>('[data-settings-text-size] input[type="radio"]')].map((r) => r.value)).toEqual(['12', '13', '14', '15']);
  expect(switchNamed(el, 'Desktop notifications')).not.toBeNull();
  expect(switchNamed(el, 'Play a sound')).not.toBeNull();
  expect(el.querySelector('[data-settings-sound] input[type="range"]')).not.toBeNull();
  expect(el.querySelector('[data-settings-tailscale]')).toBeNull();
  // General no longer holds Experimental or the Board.
  expect(el.querySelector('[data-settings-experimental]')).toBeNull();
  expect(switchNamed(el, 'Decision mode')).toBeNull();
  expect(el.querySelector('[data-settings-board]')).toBeNull();
  expect(switchNamed(el, 'Board')).toBeNull();

  act(() => navLink(el, 'agents').click());
  // Settings → Agents (components/AgentsSettings.tsx; agentsSettings.test.tsx covers its rows).
  await until(() => el.querySelector('[data-settings-agents]') !== null, 'Agents');
  expect(el.textContent).toContain("A change applies to that agent's next session");
  expect([...el.querySelectorAll('button')].some((b) => b.textContent?.startsWith('Not found on this computer'))).toBe(true);

  act(() => navLink(el, 'devices').click());
  await until(() => el.querySelector('[data-settings-phones]') !== null, 'Devices');
  expect(buttonText(el, 'Pair a phone')).not.toBeNull();
  await until(() => switchNamed(el, 'This Wi-Fi') !== null && !switchNamed(el, 'This Wi-Fi')!.disabled, 'the ways read');
  expect(switchNamed(el, 'Tailscale')).not.toBeNull();
  expect(switchNamed(el, 'Reach the Inbox over Tailscale')).not.toBeNull();
  // The difference between the two Tailscale switches is written out.
  expect(el.querySelector('[data-settings-tailscale]')?.textContent).toContain("Your phone's app does not need this.");

  act(() => navLink(el, 'archived').click());
  await until(() => el.querySelector('[data-settings-archived]') !== null, 'Archived');
  act(() => navLink(el, 'storage').click());
  await until(() => el.querySelector('[data-store-bytes]') !== null, 'Storage');
  expect(el.querySelector('[data-store-project]')).not.toBeNull();
  act(() => navLink(el, 'about').click());
  await until(() => buttonText(el, 'Check now') !== null, 'About');
  expect(switchNamed(el, 'Tell me when a new version is out')).not.toBeNull();
  expect(switchNamed(el, 'Keep Plannotator up to date')).not.toBeNull();
  expect(el.textContent).toContain('Where things are');
  expect(el.textContent).toContain(`http://127.0.0.1:${current!.port}/mcp`);
  act(() => navLink(el, 'capabilities').click());
  await until(() => el.querySelector('[data-settings-board]') !== null && el.querySelector('[data-settings-experimental]') !== null, 'Capabilities');
  expect(switchNamed(el, 'Board')).not.toBeNull();
  // The main capabilities first, then the Experimental group under them, with its heading and the same warning.
  const board = el.querySelector('[data-settings-board]')!;
  const experimental = el.querySelector('[data-settings-experimental]')!;
  expect(board.compareDocumentPosition(experimental) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(experimental.querySelector('h2')?.textContent).toBe('Experimental');
  expect(experimental.textContent).toContain('Features still being tried. Each stays off until you turn it on.');
  expect(experimental.contains(switchNamed(el, 'Decision mode'))).toBe(true);
  expect(board.contains(switchNamed(el, 'Decision mode'))).toBe(false);
});

test.skipIf(!hasDom)('#settings/capabilities opens Capabilities; the Board switch saves inboxBoard to config.json, both ways', async () => {
  const config = () => {
    try {
      return (JSON.parse(readFileSync(join(current!.dataDir, 'config.json'), 'utf8')) as { inboxBoard?: boolean }).inboxBoard;
    } catch {
      return undefined;
    }
  };
  const el = await renderApp('#settings/capabilities');
  await until(() => heading(el) === 'Capabilities', 'Capabilities');
  await until(() => navLink(el, 'capabilities') !== null, 'the Capabilities row');
  expect(navLink(el, 'capabilities').getAttribute('aria-current')).toBe('page');
  await until(() => switchNamed(el, 'Board') !== null, 'the switch');
  expect(el.querySelector('[data-settings-board]')?.textContent).toContain('Agents pick this up in their next session.');
  expect(switchNamed(el, 'Board')!.getAttribute('aria-checked')).toBe('false');
  try {
    act(() => switchNamed(el, 'Board')!.click());
    await until(() => config() === true, 'config.json inboxBoard true');
    await until(() => switchNamed(el, 'Board')!.getAttribute('aria-checked') === 'true', 'the switch on');
    act(() => switchNamed(el, 'Board')!.click());
    await until(() => config() === false, 'config.json inboxBoard false');
    await until(() => switchNamed(el, 'Board')!.getAttribute('aria-checked') === 'false', 'the switch off');
  } finally {
    await call(current!.port, '/api/inbox/settings', 'POST', JSON.stringify({ board: { on: false } }));
  }
});

test.skipIf(!hasDom)('#settings/experimental (an old link) becomes Capabilities, focused on its Experimental group; decision mode saves to config.json, both ways', async () => {
  const config = () => {
    try {
      return (JSON.parse(readFileSync(join(current!.dataDir, 'config.json'), 'utf8')) as { experimental?: { decisionMode?: boolean } }).experimental;
    } catch {
      return undefined;
    }
  };
  const el = await renderApp('#settings/experimental');
  await until(() => heading(el) === 'Capabilities', 'Capabilities');
  // The address is Capabilities' now, in place: Back does not return to the old one.
  expect(window.location.hash).toBe('#settings/capabilities');
  await until(() => navLink(el, 'capabilities') !== null, 'the Capabilities row');
  expect(navLink(el, 'capabilities').getAttribute('aria-current')).toBe('page');
  await until(() => document.activeElement === el.querySelector('[data-settings-experimental] h2'), 'focus on the Experimental group');
  await until(() => switchNamed(el, 'Decision mode') !== null, 'the switch');
  expect(switchNamed(el, 'Decision mode')!.getAttribute('aria-checked')).toBe('false');
  try {
    act(() => switchNamed(el, 'Decision mode')!.click());
    await until(() => config()?.decisionMode === true, 'config.json experimental.decisionMode true');
    await until(() => switchNamed(el, 'Decision mode')!.getAttribute('aria-checked') === 'true', 'the switch on');
    act(() => switchNamed(el, 'Decision mode')!.click());
    await until(() => config()?.decisionMode === false, 'config.json experimental.decisionMode false');
    await until(() => switchNamed(el, 'Decision mode')!.getAttribute('aria-checked') === 'false', 'the switch off');
  } finally {
    await call(current!.port, '/api/inbox/settings', 'POST', JSON.stringify({ experimental: { decision_mode: false } }));
  }
});

test.skipIf(!hasDom)('Capabilities: no row for an Inbox with nothing to switch (its address says so), and the phone row names what is on', async () => {
  const { SettingsPage } = await import('./components/Settings');
  const { SidebarProvider } = await import('./shell/sidebar');
  // An older Inbox's settings: no `experimental`, phones off. Rendered on its own, no server.
  const model = {
    serverSession: 's',
    version: '0.28.0',
    port: 1,
    url: 'http://localhost:1/',
    mcp_url: 'http://127.0.0.1:1/mcp',
    mcp_command: ['plannotator', 'inbox', 'mcp'],
    home: '/home/u',
    data_dir: '/home/u/.plannotator',
    inbox_tool: { hosts: { 'claude-code': true, pi: false, opencode: false }, env: null },
    notifications: { enabled: true, dismissed: false, allowed_origin: null },
    phones: false,
    store: { dir: '/home/u/.plannotator/inbox', bytes: 0, projects: [] },
  };
  const noop = () => {};
  const page = (section: 'general' | 'capabilities' | null, phoneList = false, settings: object = model) => (
    <SidebarProvider>
      <SettingsPage
        settings={settings as never}
        context={null}
        error={null}
        onToggleTool={noop}
        onToggleExperimental={noop}
        onToggleBoard={noop}
        onToggleTailscale={noop}
        tailscaleBusy={false}
        permission="granted"
        onToggleNotifications={noop}
        onDeleteThread={async () => {}}
        onDeleteProject={async () => {}}
        section={section}
        phone={phoneList}
      />
    </SidebarProvider>
  );
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(page('general'));
  });
  expect(navLink(host, 'about')).not.toBeNull();
  expect(navLink(host, 'capabilities')).toBeNull();
  act(() => root!.render(page(null, true)));
  expect(host.querySelector('[data-settings-list] [data-settings-link="about"]')).not.toBeNull();
  expect(host.querySelector('[data-settings-list] [data-settings-link="capabilities"]')).toBeNull();
  act(() => root!.render(page('capabilities')));
  expect(heading(host)).toBe('Capabilities');
  expect(host.querySelector('[data-settings-capabilities-none]')?.textContent).toContain('older than Settings → Capabilities');
  expect(host.querySelector('[role="switch"]')).toBeNull();
  // The phone row's value: what is on, by name.
  const value = (settings: object) => {
    act(() => root!.render(page(null, true, settings)));
    return host!.querySelector('[data-settings-list] [data-settings-link="capabilities"] .ib-v')?.textContent;
  };
  const off = { ...model, board: { on: false }, experimental: { decision_mode: { on: false, env: null } } };
  expect(value(off)).toBe('Off');
  expect(value({ ...off, board: { on: true } })).toBe('Board');
  expect(value({ ...off, experimental: { decision_mode: { on: true, env: null } } })).toBe('Decision mode');
  expect(value({ ...off, board: { on: true }, experimental: { decision_mode: { on: true, env: null } } })).toBe('2 on');
});

test.skipIf(!hasDom)('Pair a phone: step 1 first; no code until a way is on; the code with its address; what reached the door; Paired; Done back to Devices with the phone', async () => {
  const el = await renderApp('#settings/devices');
  await until(() => buttonText(el, 'Pair a phone') !== null, 'Devices');
  act(() => buttonText(el, 'Pair a phone')!.click());
  await until(() => window.location.hash === '#settings/devices/pair', 'the pairing address');
  await until(() => el.querySelectorAll('[data-pair-way] [data-check]').length > 0, 'the checks');
  expect(el.querySelector('[data-pair-step]')?.getAttribute('data-pair-step')).toBe('reach');
  expect([...el.querySelectorAll('[data-pair-way]')].map((w) => w.getAttribute('data-pair-way'))).toEqual(['wifi', 'tailscale']);
  expect(el.querySelector('[data-pair-way="wifi"]')?.textContent).toContain('On Wi-Fi “Ramos Home” at 192.168.1.42');
  expect(el.textContent).toContain('is not available yet');

  // The gate: with no way on, Show the code makes no code and says why.
  const show = () => el.querySelector('[data-show-code]') as HTMLButtonElement;
  // Deliberate pin: the button's two action labels are the design's decision (shots 11 and 12), not incidental copy.
  expect(show().textContent).toBe('Show the code');
  expect(show().getAttribute('aria-disabled')).toBe('true');
  act(() => show().click());
  await until(() => el.querySelector('[data-pair-hint]')?.getAttribute('data-pair-hint') === 'need-way', 'the hint to turn a way on');
  expect(el.querySelector('[data-pair-offer]')).toBeNull();
  expect(JSON.parse((await call(current!.port, '/api/inbox/pairing')).text).offer).toBeNull();

  act(() => (el.querySelector('[data-turn-on="tailscale"]') as HTMLButtonElement).click());
  await until(() => el.querySelector('[data-pair-way="tailscale"]')?.getAttribute('data-way-on') === 'true', 'Tailscale on');
  // Deliberate pin, as above.
  await until(() => show().textContent === 'Continue to the code', 'Continue to the code');
  expect(show().getAttribute('aria-disabled')).toBe('false');
  // A double click makes one code: the second press waits for the first answer.
  act(() => {
    show().click();
    show().click();
  });
  await until(() => el.querySelector('[data-pair-offer]') !== null, 'the code');
  await act(async () => {
    await new Promise((r) => setTimeout(r, 300));
  });
  expect(requests.filter((r) => r === 'POST /api/inbox/pairing')).toHaveLength(1);
  const code = el.querySelector('[data-pair-code]')!.getAttribute('data-pair-code')!;
  expect(code).toMatch(/^\d{6}$/);
  expect(el.querySelector('[data-pair-address="tailscale"]')?.textContent).toContain('macbook.tail0000.ts.net:8443');
  expect(el.querySelector('[data-pair-qr]')).not.toBeNull();

  // A phone over the tailnet types the wrong digits: the code's screen says so.
  const doorPort = (JSON.parse(readFileSync(join(current!.dataDir, 'inbox', 'inbox.json'), 'utf8')) as { tailnet: { door_port: number } }).tailnet.door_port;
  const wrong = code === '000000' ? '000001' : '000000';
  expect((await call(doorPort, '/api/inbox/device/pair', 'POST', JSON.stringify({ code: wrong, name: 'x', platform: 'ios' }))).status).toBe(401);
  await until(() => el.querySelector('[data-pair-note="wrong_code"]') !== null, 'the wrong-digits note');
  expect(el.querySelector('[data-pair-note="wrong_code"]')?.getAttribute('data-via')).toBe('tailnet');
  expect(el.querySelector('[data-pair-note="wrong_code"]')?.getAttribute('data-tries-left')).toBe('4');

  expect((await call(doorPort, '/api/inbox/device/pair', 'POST', JSON.stringify({ code, name: 'Test iPhone', platform: 'ios' }))).status).toBe(201);
  await until(() => el.querySelector('[data-pair-done]') !== null, 'Paired');
  expect(el.querySelector('[data-pair-done] h4')?.textContent).toBe('Paired with Test iPhone');
  expect(el.querySelector('[data-pair-done]')?.textContent).toContain('over Tailscale');
  act(() => (el.querySelector('[data-pair-finish]') as HTMLButtonElement).click());
  await until(() => window.location.hash === '#settings/devices', 'back to Devices');
  await until(() => el.querySelector('[data-device]')?.textContent?.includes('Test iPhone') === true, 'the phone listed');
  expect(el.querySelector('[data-paired]')?.textContent).toContain('Paired with Test iPhone.');
});

test.skipIf(!hasDom)('the no-loop rule: with a way on and every check failing, Continue still shows the code', async () => {
  machine({ backend: 'NeedsLogin', noAddress: true, noOpenssl: true, noBonjour: true, firewall: 'block_all' });
  // Tailscale's switch is on (the scripted serve answers), though its check says signed out.
  expect((await call(current!.port, '/api/inbox/tailnet', 'POST', JSON.stringify({ on: true }))).status).toBe(200);
  const el = await renderApp('#settings/devices/pair');
  await until(() => el.querySelectorAll('[data-pair-way] [data-check]').length > 0, 'the checks');
  // Nothing on the Wi-Fi passes; on Tailscale only the line before "signed out" (the command answered).
  expect(el.querySelectorAll('[data-pair-way="wifi"] [data-check="ok"]').length).toBe(0);
  expect(el.querySelectorAll('[data-pair-way="tailscale"] [data-check="ok"]').length).toBe(1);
  expect(el.querySelectorAll('[data-pair-way] [data-check="fail"]').length).toBe(3);
  expect(el.querySelector('[data-pair-way="tailscale"]')?.getAttribute('data-way-on')).toBe('true');
  // No "neither works" stop: a way is on.
  expect(el.querySelector('[data-neither-works]')).toBeNull();
  const show = el.querySelector('[data-show-code]') as HTMLButtonElement;
  // Deliberate pin: the design's action label once a way is on.
  expect(show.textContent).toBe('Continue to the code');
  expect(show.getAttribute('aria-disabled')).toBe('false');
  expect(show.disabled).toBe(false);
  act(() => show.click());
  await until(() => el.querySelector('[data-pair-code]') !== null, 'the code, checks notwithstanding');
  expect(el.querySelector('[data-pair-qr]')).not.toBeNull();
});

test.skipIf(!hasDom)('step 1 is always first, even with a way already on; neither way able to work says so and offers no code; Turn on stays offered beside Check again', async () => {
  expect((await call(current!.port, '/api/inbox/tailnet', 'POST', JSON.stringify({ on: true }))).status).toBe(200);
  const el = await renderApp('#settings/devices');
  await until(() => buttonText(el, 'Pair a phone') !== null, 'Devices');
  act(() => buttonText(el, 'Pair a phone')!.click());
  await until(() => el.querySelector('[data-pair-step="reach"]') !== null, 'step 1');
  await until(() => el.querySelector('[data-pair-way="tailscale"] [data-way-state="on"]') !== null, 'Tailscale says it is on');
  // Deliberate pin: the design's action label once a way is on.
  expect((el.querySelector('[data-show-code]') as HTMLButtonElement).textContent).toBe('Continue to the code');

  await call(current!.port, '/api/inbox/tailnet', 'POST', JSON.stringify({ on: false }));
  machine({ tsMissing: true, noAddress: true, noOpenssl: true });
  act(() => root?.unmount());
  host?.remove();
  const none = await renderApp('#settings/devices/pair');
  await until(() => none.querySelector('[data-neither-works]') !== null, 'neither works');
  for (const way of ['wifi', 'tailscale']) {
    expect(none.querySelector(`[data-pair-way="${way}"] [data-check-again]`)).not.toBeNull();
    expect(none.querySelector(`[data-pair-way="${way}"] [data-turn-on]`)).not.toBeNull();
  }
  act(() => (none.querySelector('[data-show-code]') as HTMLButtonElement).click());
  await act(async () => {
    await new Promise((r) => setTimeout(r, 200));
  });
  expect(none.querySelector('[data-pair-offer]')).toBeNull();
});

test.skipIf(!hasDom)('a code another window replaced reads as replaced, not as this tab\'s own state', async () => {
  expect((await call(current!.port, '/api/inbox/tailnet', 'POST', JSON.stringify({ on: true }))).status).toBe(200);
  const el = await renderApp('#settings/devices/pair');
  await until(() => (el.querySelector('[data-show-code]') as HTMLButtonElement | null)?.getAttribute('aria-disabled') === 'false', 'a way on');
  act(() => (el.querySelector('[data-show-code]') as HTMLButtonElement).click());
  await until(() => el.querySelector('[data-pair-offer]')?.getAttribute('data-expired') === 'false', 'the code');
  // Another window's New code: the Inbox keeps one offer, so this tab's code no longer pairs.
  expect((await call(current!.port, '/api/inbox/pairing', 'POST', '{}')).status).toBe(201);
  await until(() => el.querySelector('[data-pair-closed]')?.getAttribute('data-pair-closed') === 'replaced', 'the code shown as replaced');
  expect(el.querySelector('[data-pair-offer]')?.getAttribute('data-expired')).toBe('true');
  // Not this tab's expiry: no troubleshooting list for a code nobody could reach.
  expect(el.querySelector('[data-pair-trouble]')).toBeNull();
});

test.skipIf(!hasDom)('phones off (the released default): Devices is Over your tailnet only, and #settings/devices/pair opens no flow', async () => {
  current = plainServer;
  const el = await renderApp('#settings/devices/pair');
  await until(() => el.querySelector('[data-settings-tailscale]') !== null, 'Over your tailnet');
  expect(el.querySelector('[data-settings-phones]')).toBeNull();
  expect(el.querySelector('[data-pair-flow]')).toBeNull();
  expect(buttonText(el, 'Pair a phone')).toBeNull();
  // Over your tailnet is the section's only group.
  expect([...el.querySelectorAll('.ib-spg .ib-sgroup')].map((g) => g.hasAttribute('data-settings-tailscale'))).toEqual([true]);
});

test.skipIf(!hasDom)('on a phone: #settings is the list of sections; a section opens with ‹ Settings, which goes back to the list', async () => {
  phone = true;
  const el = await renderApp('#settings');
  await until(() => el.querySelector('[data-settings-list]') !== null, 'the list of sections');
  expect(el.querySelector('.ib-snav')).toBeNull();
  await until(() => el.querySelector('[data-settings-list] [data-settings-link="capabilities"]') !== null, 'the Capabilities row');
  const links = [...el.querySelectorAll<HTMLAnchorElement>('[data-settings-list] a')];
  expect(links.map((a) => a.getAttribute('data-settings-link'))).toEqual(['general', 'agents', 'prompts', 'devices', 'capabilities', 'archived', 'storage', 'about']);
  // Capabilities is the last row of the first group, above Archived, Storage and About; no Experimental row or group.
  const groups = [...el.querySelectorAll<HTMLUListElement>('[data-settings-list] ul')];
  expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual(['Settings', 'Your data and Plannotator']);
  expect([...groups[0]!.querySelectorAll('a')].map((a) => a.getAttribute('data-settings-link'))).toEqual(['general', 'agents', 'prompts', 'devices', 'capabilities']);
  expect([...groups[1]!.querySelectorAll('a')].map((a) => a.getAttribute('data-settings-link'))).toEqual(['archived', 'storage', 'about']);
  const capabilitiesRow = groups[0]!.querySelector<HTMLAnchorElement>('[data-settings-link="capabilities"]')!;
  expect(capabilitiesRow.querySelector('.ib-v')?.textContent).toBe('Off');
  act(() => capabilitiesRow.click());
  await until(() => heading(el) === 'Capabilities', 'Capabilities on a phone');
  expect(window.location.hash).toBe('#settings/capabilities');
  expect(switchNamed(el, 'Board')).not.toBeNull();
  // The Experimental group is on the same page, under the Board.
  expect(el.querySelector('[data-settings-experimental]')?.contains(switchNamed(el, 'Decision mode'))).toBe(true);
  act(() => (el.querySelector('.ib-sphead .ib-pback') as HTMLAnchorElement).click());
  await until(() => document.activeElement === el.querySelector('[data-settings-list] [data-settings-link="capabilities"]'), 'focus on the Capabilities row');
  act(() => el.querySelector<HTMLAnchorElement>('[data-settings-list] [data-settings-link="devices"]')!.click());
  await until(() => heading(el) === 'Devices', 'Devices');
  expect(window.location.hash).toBe('#settings/devices');
  const back = el.querySelector('.ib-sphead .ib-pback') as HTMLAnchorElement;
  expect(back.textContent).toContain('Settings');
  act(() => back.click());
  await until(() => el.querySelector('[data-settings-list]') !== null, 'the list again');
  // Focus returns to the row of the section just left.
  await until(() => document.activeElement === el.querySelector('[data-settings-list] [data-settings-link="devices"]'), 'focus on the Devices row');
});
