/**
 * "No user ever stuck on a version" (QA item 30), as the Inbox draws it:
 * Settings → General's update row (the owner, 2026-10-26: the update button
 * in General too) in every state; checking that has failed for hours shown
 * plainly (General, About, the sidebar's quiet row, the toggle's dot) with
 * the install command; and none of it on a page opened over the tailnet.
 */
import { afterEach, expect, setSystemTime, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxUpdate } from '@plannotator/core/inbox-types';
import type { UpdateCheckFailing, UpdateDetails } from './api';
import { pageOffersUpdates, sidebarUpdateNotice, updateForPage } from './updateNotice';

const hasDom = typeof document !== 'undefined';
// Updates.tsx draws What's new with ui's Viewer, which reads `window` at module-eval time.
const { AboutBlock, CheckFailingRow, GeneralUpdateRow } = (hasDom ? await import('./components/Updates') : {}) as typeof import('./components/Updates');
let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function render(node: React.ReactNode) {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(node);
  });
  return host;
}

const COMMAND = 'curl -fsSL https://plannotator.ai/install.sh | bash';
const update = (state: InboxUpdate['state']): InboxUpdate => ({
  available: true,
  state,
  version: '0.28.32',
  current: '0.28.31',
  action: 'script',
  releaseUrl: 'https://github.com/backnotprop/plannotator/releases/tag/v0.28.32',
});
const failing: UpdateCheckFailing = { since: new Date(Date.now() - 4 * 3600_000).toISOString(), error: "release page didn't answer as expected; GitHub API rate-limited" };
const details = (over: Partial<UpdateDetails['check']> = {}, latest: UpdateDetails['latest'] = { version: '0.28.31', fetched_at: new Date().toISOString(), published_at: null }): UpdateDetails => ({
  update: null,
  current: '0.28.31',
  updated: null,
  latest,
  check: { on: true, env: null, last_attempt_at: new Date().toISOString(), error: null, failing: null, last_failed_at: null, ...over },
  auto_update: { on: false, env: null, supported: true },
  summary: '',
  flags: [],
  command: COMMAND,
  plugin_command: null,
  sessions: [],
  failure: null,
  log: '/home/u/.plannotator/update.log',
  snoozed_until: null,
});

function row(props: Partial<Parameters<typeof GeneralUpdateRow>[0]> & { calls?: string[] } = {}) {
  const calls = props.calls ?? [];
  return render(
    <GeneralUpdateRow
      version="0.28.31"
      details={details()}
      update={null}
      restarting={false}
      checking={false}
      failing={null}
      onCheckNow={() => calls.push('check')}
      onUpdate={() => calls.push('update')}
      onWhatsNew={(v) => calls.push(`whats-new ${v}`)}
      {...props}
    />,
  );
}
const button = (el: HTMLElement, sel: string) => el.querySelector<HTMLButtonElement>(sel);

test.skipIf(!hasDom)('General: up to date reads quietly, with when it last checked and Check now', () => {
  const calls: string[] = [];
  const el = row({ calls });
  expect(el.querySelector('[data-settings-update]')?.getAttribute('data-update-state')).toBe('none');
  expect(el.textContent).toContain('Plannotator 0.28.31');
  expect(el.querySelector('[data-general-update-status]')?.textContent).toMatch(/^Up to date · checked today/);
  expect(button(el, '[data-general-update]')).toBeNull();
  act(() => button(el, '[data-general-check]')!.click());
  expect(calls).toEqual(['check']);
});

test.skipIf(!hasDom)('General: available offers what the sidebar offers, Update to X.Y.Z and What\'s new', () => {
  const calls: string[] = [];
  const el = row({ calls, update: update('available') });
  const action = button(el, '[data-general-update]')!;
  expect(action.textContent).toBe('Update to 0.28.32');
  expect(action.disabled).toBe(false);
  act(() => action.click());
  const link = [...el.querySelectorAll('button')].find((b) => b.textContent === "What's new")!;
  act(() => link.click());
  expect(calls).toEqual(['update', 'whats-new 0.28.32']);
});

test.skipIf(!hasDom)('General: ready restarts onto it; failed opens the failure (log, Try again); updating spins, disabled, with no Check now', () => {
  const calls: string[] = [];
  let el = row({ calls, update: update('ready') });
  expect(el.querySelector('[data-general-update-status]')?.textContent).toContain('0.28.32 is installed · restart to use it');
  act(() => button(el, '[data-general-update]')!.click());
  act(() => root!.unmount());
  host!.remove();

  el = row({ calls, update: update('failed') });
  expect(button(el, '[data-general-update]')!.textContent).toBe('Update failed…');
  expect(el.querySelector('[data-general-update-status]')?.textContent).toContain("didn't install");
  act(() => button(el, '[data-general-update]')!.click());
  expect(calls).toEqual(['update', 'update']);
  act(() => root!.unmount());
  host!.remove();

  el = row({ update: update('updating') });
  const spinning = button(el, '[data-general-update]')!;
  expect(spinning.disabled).toBe(true);
  expect(spinning.querySelector('.ib-spin')).not.toBeNull();
  expect(button(el, '[data-general-check]')).toBeNull();
});

test.skipIf(!hasDom)('General: checking failing for hours says since when and why, with the install command', () => {
  const el = row({ failing, details: details({ failing }) });
  expect(el.querySelector('[data-settings-update]')?.getAttribute('data-update-state')).toBe('check-failing');
  // The same line as About: since when, why in plain words, when it last tried.
  expect(el.querySelector('[data-general-update-status]')?.textContent).toMatch(
    /^Can't check for updates since .* \(release page didn't answer as expected; GitHub API rate-limited\) · last tried today/,
  );
  expect(el.querySelector('[data-update-check-failing] code')?.textContent).toBe(COMMAND);
  // An available update wins: the failing line is for when nothing else can be offered.
  act(() => root!.render(<GeneralUpdateRow version="0.28.31" details={details({ failing })} update={update('available')} restarting={false} checking={false} failing={failing} onCheckNow={() => {}} onUpdate={() => {}} onWhatsNew={() => {}} />));
  expect(el.querySelector('[data-update-check-failing]')).toBeNull();
});

test.skipIf(!hasDom)('About: the failing check replaces "the last check failed" and gives the command', () => {
  const el = render(
    <AboutBlock
      version="0.28.31"
      details={details({ error: "release page didn't answer as expected", failing })}
      switches={{ update_check: { on: true, env: null }, auto_update: { on: false, env: null } }}
      checking={false}
      error={null}
      onCheckNow={() => {}}
      onToggle={() => {}}
    />,
  );
  // Never "Checked … · can't check …": it says when it last tried.
  expect(el.querySelector('[data-update-status]')?.textContent).toMatch(/^Can't check for updates since .*rate-limited\) · last tried today/);
  expect(el.querySelector('[data-update-check-failing] code')?.textContent).toBe(COMMAND);
});

test.skipIf(!hasDom)('the sidebar row: a real button named by its words, saying why, opening About', () => {
  let opened = 0;
  const el = render(<CheckFailingRow failing={failing} onOpen={() => opened++} />);
  const b = el.querySelector<HTMLButtonElement>('[data-update-check-failing-row]')!;
  expect(b.textContent).toContain("Can't check for updates");
  expect(b.textContent).toContain('GitHub API rate-limited');
  act(() => b.click());
  expect(opened).toBe(1);
});

test('the toggle\'s dot: neutral for a failing check, and an update always wins', () => {
  expect(sidebarUpdateNotice(null, false, true)).toEqual({ tone: 'neutral', label: "can't check for updates" });
  expect(sidebarUpdateNotice(null, false, false)).toBeNull();
  expect(sidebarUpdateNotice('available', false, true)).toEqual({ tone: 'primary', label: 'update available' });
  expect(sidebarUpdateNotice(null, true, true)).toBeNull();
});

test('a page opened over the tailnet offers nothing about updating; the computer\'s own page does', () => {
  expect(pageOffersUpdates({ via: 'tailnet' })).toBe(false);
  expect(pageOffersUpdates(null)).toBe(false);
  expect(pageOffersUpdates({ via: 'local' })).toBe(true);
  expect(updateForPage(update('available'), { via: 'tailnet' })).toBeNull();
  expect(updateForPage(update('available'), { via: 'local' })?.state).toBe('available');
});

test.skipIf(!hasDom)('General says "Up to date" only after a recent successful check with checks on', () => {
  const status = (d: UpdateDetails) => {
    const el = row({ details: d });
    const text = el.querySelector('[data-general-update-status]')?.textContent ?? '';
    act(() => root!.unmount());
    host!.remove();
    root = null;
    return text;
  };
  // "today" is the local calendar day, so a check an hour ago reads "yesterday"
  // between 00:00 and 01:00. Pin the clock to a fixed local mid-day.
  setSystemTime(new Date(2026, 9, 27, 13, 0, 0));
  try {
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
    expect(status(details({}, { version: '0.28.31', fetched_at: hoursAgo(1), published_at: null }))).toMatch(/^Up to date · checked /);
    // Checks off: never "Up to date", whatever the last check said.
    expect(status(details({ on: false }, { version: '0.28.31', fetched_at: hoursAgo(1), published_at: null }))).toBe('Update checks are off');
    // The latest attempt failed (not yet for hours): says so, with when.
    expect(status(details({ error: 'offline', last_failed_at: hoursAgo(0.5) }))).toMatch(/^Last check failed today .* \(offline\)$/);
    // Nothing ever checked.
    expect(status(details({ last_attempt_at: null }, null))).toBe('Not checked yet');
    // The last success is old (weeks): when, not "Up to date".
    expect(status(details({}, { version: '0.28.31', fetched_at: hoursAgo(24 * 21), published_at: null }))).toMatch(/^Last checked /);
    // A newer release known but not offered (Remind me tomorrow, checks off): never "Up to date".
    expect(status(details({}, { version: '0.28.32', fetched_at: hoursAgo(1), published_at: null }))).toMatch(/^Checked today .* · 0\.28\.32 is available$/);
  } finally {
    setSystemTime();
  }
});
