/**
 * Settings → Reviews in the Inbox (reviewSettings/): code review's own page, hosted through its seams. A change made
 * on the Inbox's page writes the value code review keeps (its cookie at once, config.json through the Inbox's settings
 * route), and code review's own Settings → Reviews reads it back. The rows the Inbox cannot honour are left out there
 * and stay on code review's page; a Power Up key write carries the page's session.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt. No server: fetch is stubbed.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { configStore } from '@plannotator/ui/config';
import { ReviewSettingsPage } from '@plannotator/ui/components/settings/ReviewSettingsPage';
import { CLASSIC_REVIEW_SETTINGS_CONTROLS } from '@plannotator/ui/components/settings/reviewSettingsControls';
import { CALL_FLOW_WORDS, DISPLAY_WORDS, FILES_WORDS, FONT_WORDS, HOVER_WORDS, POWER_UP_WORDS, SEMANTIC_WORDS } from '@plannotator/ui/components/settings/reviewSettingsWords';
import ReviewsSettings from './ReviewsSettings';
import { inboxServerSync } from '../theme';
import { resetPageSessionForTests, setPageSession } from '../api';

const hasDom = typeof document !== 'undefined';
const realFetch = globalThis.fetch;
const roots: Root[] = [];
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

interface Sent {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

/** The Inbox's routes: the settings route takes any change, the opinion route has no key yet and takes one. */
function fakeInbox(): Sent[] {
  const sent: Sent[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    sent.push({ url, method, body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null });
    if (url.includes('/api/sem-diff/opinion/settings')) return method === 'GET' ? json({ configured: false, provider: null }) : json({ ok: true, ms: 12 });
    if (url.includes('/api/inbox/settings')) return json({});
    return new Response('not here', { status: 404 });
  }) as unknown as typeof fetch;
  return sent;
}

async function render(node: React.ReactNode): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(node));
  return host;
}

/** A switch by its name: the Inbox names it by `aria-labelledby`, code review's carries its label as its first line. */
function switchNamed(host: HTMLElement, name: string): HTMLButtonElement | undefined {
  return [...host.querySelectorAll<HTMLButtonElement>('[role="switch"]')].find((el) => {
    const by = el.getAttribute('aria-labelledby');
    const label = by ? document.getElementById(by)?.textContent : el.querySelector('span span')?.textContent;
    return label?.trim() === name;
  });
}

/** The chosen option of a segmented control: a radio input in the Inbox, a radio button in code review. */
function chosen(host: HTMLElement, group: string): string | undefined {
  const box = host.querySelector(`[role="radiogroup"][aria-label="${group}"]`);
  const input = box?.querySelector<HTMLInputElement>('input[type="radio"]:checked');
  if (input) return input.value;
  return box?.querySelector('[role="radio"][aria-checked="true"]')?.textContent?.trim();
}

function setRange(input: HTMLInputElement, value: number) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, String(value));
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function setText(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/** The config store's write-back waits 300 ms before it posts. */
const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 400)));

const settingsPosts = (sent: Sent[]) => sent.filter((s) => s.url.includes('/api/inbox/settings') && s.method === 'POST').map((s) => s.body!);

beforeEach(() => {
  configStore.setServerSync(inboxServerSync);
  configStore.seed('diffOverflow', 'scroll');
  configStore.seed('diffFontSize', '');
  configStore.seed('diffPowerUpMotion', 'still');
  configStore.seed('semanticDiffEnabled', true);
  configStore.seed('diffSemantic', true);
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.innerHTML = '';
  globalThis.fetch = realFetch;
  configStore.resetServerSync();
  resetPageSessionForTests();
});

test.skipIf(!hasDom)("a change on the Inbox's Reviews page writes code review's stored value, and code review's page reads it", async () => {
  const sent = fakeInbox();
  const inbox = await render(<ReviewsSettings />);

  await act(async () => switchNamed(inbox, DISPLAY_WORDS.wrap)!.click());
  await act(async () => setRange(inbox.querySelector<HTMLInputElement>(`input[type="range"][aria-label="${FONT_WORDS.sizeLabel}"]`)!, 15));
  await act(async () => inbox.querySelector<HTMLInputElement>(`[role="radiogroup"][aria-label="${POWER_UP_WORDS.motion}"] input[value="stream"]`)!.click());
  await act(async () => switchNamed(inbox, SEMANTIC_WORDS.master)!.click());
  await flush();

  // The store (and its cookie) at once; config.json through the Inbox's settings route, in its wire names.
  expect(configStore.get('diffOverflow')).toBe('wrap');
  const posts = settingsPosts(sent);
  const diffOptions = Object.assign({}, ...posts.map((body) => body.diff_options ?? {}));
  expect(diffOptions).toMatchObject({ overflow: 'wrap', font_size: '15px', power_up_motion: 'stream' });
  expect(posts.map((body) => body.review_analysis).filter(Boolean)).toEqual([{ semantic_diff: false }]);

  // Code review's own Settings → Reviews shows each of them.
  const classic = await render(<ReviewSettingsPage controls={CLASSIC_REVIEW_SETTINGS_CONTROLS} opinionRoute="/api/sem-diff/opinion/settings" />);
  expect(switchNamed(classic, DISPLAY_WORDS.wrap)!.getAttribute('aria-checked')).toBe('true');
  expect(classic.querySelector<HTMLInputElement>(`input[type="range"][aria-label="${FONT_WORDS.sizeLabel}"]`)!.value).toBe('15');
  expect(chosen(classic, POWER_UP_WORDS.motion)).toBe('Stream');
  expect(classic.querySelector(`#review-settings-semantic`)?.closest('[role="switch"]')?.getAttribute('aria-checked')).toBe('false');
});

test.skipIf(!hasDom)("Code Font is picked from the Inbox's own menu, and code review's select shows the font picked", async () => {
  const sent = fakeInbox();
  configStore.seed('diffFontFamily', '');
  const inbox = await render(<ReviewsSettings />);
  // The Inbox's choice list, not a browser select.
  expect(inbox.querySelector('select')).toBeNull();
  const trigger = inbox.querySelector<HTMLButtonElement>(`button[aria-label^="${FONT_WORDS.label}:"]`)!;
  expect(trigger.textContent).toContain('Theme Default');
  await act(async () => trigger.click());
  const hack = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((el) => el.textContent?.trim() === 'Hack');
  await act(async () => hack!.click());
  await flush();

  expect(configStore.get('diffFontFamily')).toBe('Hack');
  expect(Object.assign({}, ...settingsPosts(sent).map((body) => body.diff_options ?? {}))).toMatchObject({ font_family: 'Hack' });
  expect(inbox.querySelector(`button[aria-label^="${FONT_WORDS.label}:"]`)!.textContent).toContain('Hack');
  const classic = await render(<ReviewSettingsPage controls={CLASSIC_REVIEW_SETTINGS_CONTROLS} opinionRoute="/api/sem-diff/opinion/settings" />);
  expect(classic.querySelector<HTMLSelectElement>(`select[aria-label="${FONT_WORDS.label}"]`)!.value).toBe('Hack');
});

test.skipIf(!hasDom)("a change on code review's page shows on the Inbox's", async () => {
  fakeInbox();
  const classic = await render(<ReviewSettingsPage controls={CLASSIC_REVIEW_SETTINGS_CONTROLS} opinionRoute="/api/sem-diff/opinion/settings" />);
  await act(async () => switchNamed(classic, DISPLAY_WORDS.wrap)!.click());
  const inbox = await render(<ReviewsSettings />);
  expect(switchNamed(inbox, DISPLAY_WORDS.wrap)!.getAttribute('aria-checked')).toBe('true');
});

test.skipIf(!hasDom)("the rows the Inbox cannot honour are left out there and stay on code review's page", async () => {
  fakeInbox();
  const inbox = await render(<ReviewsSettings />);
  const classic = await render(<ReviewSettingsPage controls={CLASSIC_REVIEW_SETTINGS_CONTROLS} opinionRoute="/api/sem-diff/opinion/settings" />);
  const names = [DISPLAY_WORDS.minimap, DISPLAY_WORDS.hideWhitespace, HOVER_WORDS.label, FILES_WORDS.autoViewed, CALL_FLOW_WORDS.label, FILES_WORDS.git];
  const shown = (host: HTMLElement) => names.filter((name) => (host.textContent ?? '').includes(name));
  expect(shown(inbox)).toEqual([]);
  expect(shown(classic)).toEqual(names);
  // Everything else on the page is the same: its sections, in order.
  const sections = (host: HTMLElement) => [...host.querySelectorAll('[data-review-settings-section]')].map((el) => el.getAttribute('data-review-settings-section'));
  expect(sections(inbox)).toEqual(['display', 'semantic', 'powerUp']);
  expect(sections(classic).slice(0, 3)).toEqual(['display', 'semantic', 'powerUp']);
});

test.skipIf(!hasDom)('a phone offers no Split or Unified, as its diffs are all Unified', async () => {
  fakeInbox();
  const wide = await render(<ReviewsSettings />);
  const phone = await render(<ReviewsSettings phone />);
  expect(chosen(wide, DISPLAY_WORDS.layout)).toBeDefined();
  expect(phone.querySelector(`[role="radiogroup"][aria-label="${DISPLAY_WORDS.layout}"]`)).toBeNull();
});

test.skipIf(!hasDom)("a Power Up key saved on the Inbox's page goes to the opinion route with the page's session", async () => {
  const sent = fakeInbox();
  setPageSession('session-for-this-page');
  // No IntersectionObserver: the Power Up section reads its route at once.
  const observer = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
  delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
  try {
    const inbox = await render(<ReviewsSettings />);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    const key = inbox.querySelector<HTMLInputElement>('[data-power-up-settings] input[type="password"]')!;
    await act(async () => setText(key, 'not-a-real-key'));
    await act(async () => inbox.querySelector<HTMLButtonElement>('[data-power-up-key-save]')!.click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  } finally {
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = observer;
  }
  const writes = sent.filter((s) => s.url.includes('/api/sem-diff/opinion/settings') && s.method === 'POST');
  expect(writes.map((s) => s.body)).toEqual([{ provider: 'jev', apiKey: 'not-a-real-key', serverSession: 'session-for-this-page' }]);
  // The key worked, so Power Up turns on, and that reaches config.json too.
  await flush();
  expect(settingsPosts(sent).some((body) => (body.diff_options as Record<string, unknown> | undefined)?.power_up === true)).toBe(true);
});
