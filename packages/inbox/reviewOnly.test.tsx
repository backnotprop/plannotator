/**
 * The Inbox for code review only in the window (reviewOnly.ts, components/ReviewWelcome.tsx, components/FullInboxRow.tsx,
 * sidebarItems.ts, Settings → Capabilities and Agents).
 *
 * What regresses: the sidebar keeping the full Inbox's items while code review only, hiding more than mock S4 lists
 * (Starred, Tags, Grid), or hiding the Inbox row while something there waits on the person; a load on a page only the
 * full Inbox has not going to Reviews; the welcome opening without the line's claim, opening when the claim is refused,
 * opening in two tabs, or closing as an offer's Not now; its words, order or switch not the approved ones; its switch
 * not saving at once, or failing without a word; Settings → Capabilities showing a Code review row the person could
 * turn off while code review only, showing the Full Inbox row to a full-Inbox person, or pulling it out from under the
 * click; a failed Full Inbox save saying nothing; Settings → Agents showing a Reminder switch that reads off-and-snaps-back
 * while no reminder is sent.
 *
 * The sidebar part runs anywhere; the rest is DOM-gated: DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAgentRow, InboxAgentsModel } from '@plannotator/core/inbox-types';
import type { SettingsModel } from './api';
import { drawnSidebarItems } from './sidebarItems';

const hasDom = typeof document !== 'undefined';
const { reviewOnlyHome, reviewOnlyOf, useReviewWelcome } = (hasDom ? await import('./reviewOnly') : {}) as typeof import('./reviewOnly');
const reveal = (hasDom ? await import('./reveal') : {}) as typeof import('./reveal');
const { ReviewWelcome } = (hasDom ? await import('./components/ReviewWelcome') : {}) as typeof import('./components/ReviewWelcome');
const { SettingsPage } = (hasDom ? await import('./components/Settings') : {}) as typeof import('./components/Settings');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');
const { AgentsSettings } = (hasDom ? await import('./components/AgentsSettings') : {}) as typeof import('./components/AgentsSettings');
const { useSettingsSaves } = (hasDom ? await import('./data/actions/settings') : {}) as typeof import('./data/actions/settings');
const { saveFullInbox } = (hasDom ? await import('./data/actions/fullInbox') : {}) as typeof import('./data/actions/fullInbox');

const BASE = { board: true, plans: true, grid: true, scheduled: true, reviews: true, usage: true, artifacts: true, agents: true, tags: true, phone: false } as const;

describe('the sidebar', () => {
  test("code review only: no Inbox, Artifacts, Agents, Projects, Board, Plans, Routines, New message or Copy prompt; Starred, Tags, Grid and the rest stay", () => {
    const full = drawnSidebarItems(BASE);
    const only = drawnSidebarItems({ ...BASE, reviewOnly: true });
    for (const item of ['inbox', 'artifacts', 'agents', 'projects', 'board', 'plans', 'scheduled', 'new-message', 'copy-prompt'] as const) {
      expect([item, full.has(item)]).toEqual([item, true]);
      expect([item, only.has(item)]).toEqual([item, false]);
    }
    for (const item of ['starred', 'tags', 'grid', 'search', 'reviews', 'drafts', 'usage', 'feedback', 'settings'] as const) expect([item, only.has(item)]).toEqual([item, full.has(item)]);
  });

  test('the Inbox row comes back while something there waits on the person', () => {
    expect(drawnSidebarItems({ ...BASE, reviewOnly: true, inboxWaits: true }).has('inbox')).toBe(true);
    expect(drawnSidebarItems({ ...BASE, reviewOnly: true, inboxWaits: false }).has('inbox')).toBe(false);
  });
});

describe.skipIf(!hasDom)('Reviews is home', () => {
  test('a load on the Inbox, or on a page only the full Inbox has, goes to Reviews; a thread and Settings stay', () => {
    const reviews = { page: 'reviews', project: null, thread: null };
    for (const page of ['inbox', 'board', 'artifacts', 'scheduled', 'plans', 'grid', 'tour'] as const) expect(reviewOnlyHome({ page, project: null, thread: null } as never)).toEqual(reviews as never);
    expect(reviewOnlyHome({ page: 'inbox', project: null, thread: 'thr_1' } as never)).toBeNull();
    expect(reviewOnlyHome({ page: 'settings', project: null, thread: null } as never)).toBeNull();
    expect(reviewOnlyHome({ page: 'reviews', project: null, thread: null } as never)).toBeNull();
  });

  test('only `full_inbox: { on: false }` is code review only; an older Inbox (no field) is the full Inbox', () => {
    expect(reviewOnlyOf({ full_inbox: { on: false } })).toBe(true);
    expect(reviewOnlyOf({ full_inbox: { on: true } })).toBe(false);
    expect(reviewOnlyOf({})).toBe(false);
    expect(reviewOnlyOf(null)).toBe(false);
  });
});

const TIMES = { pageAgeMs: 60_000, readMs: 5_000, settledMs: 40, momentMs: 1500, recheckMs: 20, claimRetryMs: 30 };
const SAVE_FAILED = 'config.json could not be saved; nothing changed.';

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedTimes: typeof import('./reveal').REVEAL_TIMES;
let posts: { path: string; body: Record<string, unknown> }[] = [];
/** The Inbox's compare-and-set over the line: the first claim ever shows it. */
let stamped = false;
/** The Inbox grants the claim at all (false: it is no longer next, or another device won). */
let grants = true;
/** `POST /api/inbox/settings { full_inbox }` fails (config.json not saved). */
let saveFails = false;

beforeEach(() => {
  if (!hasDom) return;
  savedTimes = { ...reveal.REVEAL_TIMES };
  Object.assign(reveal.REVEAL_TIMES, TIMES);
  savedFetch = globalThis.fetch;
  posts = [];
  stamped = false;
  grants = true;
  saveFails = false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, '');
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    if ((init?.method ?? 'GET') === 'POST') posts.push({ path, body });
    const answer = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    if (path.endsWith('/api/inbox/reveal')) {
      const show = grants && !stamped && body.answer === undefined;
      if (body.answer === undefined) stamped = true;
      return answer({ show, reveal: { next: null }, board: { on: false } });
    }
    if (path.endsWith('/api/inbox/settings') && init?.method === 'POST') {
      const full = (body.full_inbox as { on?: boolean } | undefined)?.on;
      if (saveFails) return answer({ error: SAVE_FAILED, code: 'config_not_saved' }, 500);
      return answer({ full_inbox: { on: full }, code_review: { on: true } });
    }
    return answer({ error: 'not in this test' }, 404);
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
  Object.assign(reveal.REVEAL_TIMES, savedTimes);
});

const wait = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));
async function until(done: () => boolean, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!done() && Date.now() < end) await wait(10);
}
const dialogs = () => [...document.querySelectorAll<HTMLDialogElement>('dialog[data-dialog="review-welcome"]')];
const dialog = () => dialogs()[0] ?? null;
const claims = () => posts.filter((p) => p.path.endsWith('/api/inbox/reveal') && p.body.answer === undefined);
const notNows = () => posts.filter((p) => p.path.endsWith('/api/inbox/reveal') && p.body.answer !== undefined);
const fullSaves = () => posts.filter((p) => p.path.endsWith('/api/inbox/settings')).map((p) => p.body.full_inbox);

function render(node: React.ReactNode) {
  if (!host) {
    host = document.createElement('div');
    host.className = 'pn-inbox';
    document.body.appendChild(host);
    act(() => void (root = createRoot(host!)));
  }
  act(() => root!.render(<>{node}</>));
}

/** As App wires it: the line's moment (`useReviewWelcome`), then the dialog once the claim answered first ever. */
function Welcome({ due = true, on = true }: { due?: boolean; on?: boolean }) {
  const [full, setFull] = useState(false);
  const welcome = useReviewWelcome({ due, blocked: false, tourScreen: false, thread: null, rows: [], clear: true, place: '', heldBack: () => false, toast: false, on });
  return welcome.stage === 'open' ? (
    <ReviewWelcome
      fullInbox={full}
      phone={false}
      onClose={welcome.close}
      save={async (next) => {
        const saved = await saveFullInbox(next);
        if (saved.full_inbox) setFull(saved.full_inbox.on);
        return saved;
      }}
    />
  ) : null;
}

describe.skipIf(!hasDom)('the welcome, a dialog of the line', () => {
  test('opens only once the claim (`review_welcome`) answers first ever; the approved words in order, labelled by its title', async () => {
    render(
      <>
        <main className="ib-main">
          <h1>Reviews</h1>
        </main>
        <Welcome />
      </>,
    );
    await until(() => dialog() !== null);
    expect(claims().map((p) => p.body.id)).toEqual(['review_welcome']);
    const d = dialog()!;
    expect(document.getElementById(d.getAttribute('aria-labelledby')!)!.textContent).toBe('Welcome to the code review Inbox');
    expect([...d.querySelectorAll('#ib-rwel-feats li')].map((li) => li.textContent)).toEqual([
      'Filter PRs by your own risk rules',
      'A review curator works with you on everything you ship',
      'A guided review walks you through each change',
      'Big pictures of what changed and why',
    ]);
    const sw = d.querySelector<HTMLButtonElement>('[data-review-welcome-full]')!;
    expect(sw.getAttribute('role')).toBe('switch');
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(document.getElementById(sw.getAttribute('aria-labelledby')!)!.textContent!.trim()).toBe('The full Plannotator Inbox');
    expect(document.getElementById(sw.getAttribute('aria-describedby')!)!.textContent!.trim()).toBe(
      "Your agents send you questions, decisions and finished work. It's off for now: turn it on here, or any time in Settings.",
    );
    expect([...d.querySelectorAll('button:not([role="switch"])')].map((b) => b.textContent)).toEqual(['Start reviewing']);
  });

  test('a claim the Inbox refuses (no longer next, or shown elsewhere): it never opens', async () => {
    grants = false;
    render(<Welcome />);
    await until(() => claims().length === 1);
    await wait(200);
    expect(dialog()).toBeNull();
  });

  test('two tabs at once: only the one whose claim was first shows it', async () => {
    render(
      <>
        <Welcome />
        <Welcome />
      </>,
    );
    await until(() => claims().length === 2 && dialog() !== null);
    await wait(150);
    expect(dialogs()).toHaveLength(1);
  });

  test('not due, or no longer code review only: nothing opens and nothing is claimed', async () => {
    render(<Welcome due={false} />);
    await wait(200);
    render(<Welcome on={false} />);
    await wait(200);
    expect(dialog()).toBeNull();
    expect(claims()).toEqual([]);
  });

  for (const [how, close] of [
    ['Start reviewing', (d: HTMLDialogElement) => d.querySelector<HTMLButtonElement>('[data-review-welcome-start]')!.click()],
    ['Escape', (d: HTMLDialogElement) => d.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))],
  ] as const) {
    test(`${how} closes it, turns nothing on and is no Not now`, async () => {
      render(<Welcome />);
      await until(() => dialog() !== null);
      act(() => close(dialog()!));
      await wait(100);
      expect(dialog()).toBeNull();
      expect(notNows()).toEqual([]);
      expect(fullSaves()).toEqual([]);
    });
  }

  test('its switch turns the full Inbox on at once; the dialog stays open', async () => {
    render(<Welcome />);
    await until(() => dialog() !== null);
    const sw = () => dialog()!.querySelector<HTMLButtonElement>('[data-review-welcome-full]')!;
    act(() => sw().click());
    expect(sw().getAttribute('aria-checked')).toBe('true');
    await until(() => fullSaves().length === 1);
    await wait(30);
    expect(fullSaves()).toEqual([{ on: true }]);
    expect(sw().getAttribute('aria-checked')).toBe('true');
    expect(dialog()!.querySelector('[data-review-welcome-failed]')).toBeNull();
  });

  test('a save that fails: the switch goes back off and the dialog says the setting was not saved', async () => {
    saveFails = true;
    render(<Welcome />);
    await until(() => dialog() !== null);
    const sw = () => dialog()!.querySelector<HTMLButtonElement>('[data-review-welcome-full]')!;
    act(() => sw().click());
    await until(() => dialog()!.querySelector('[data-review-welcome-failed]') !== null);
    expect(sw().getAttribute('aria-checked')).toBe('false');
    expect(dialog()!.querySelector('[data-review-welcome-failed]')!.textContent).toBe('The setting was not saved.');
  });
});

const baseModel = {
  serverSession: 's',
  version: '0.29.0',
  port: 1,
  url: 'http://localhost:1/',
  mcp_url: 'http://127.0.0.1:1/mcp',
  mcp_command: ['plannotator', 'inbox', 'mcp'],
  home: '/home/u',
  data_dir: '/home/u/.plannotator',
  inbox_tool: { hosts: { 'claude-code': true, pi: false, opencode: false }, env: null },
  notifications: { enabled: true, dismissed: false, allowed_origin: null },
  phones: false,
  store_dir: '/home/u/.plannotator/inbox',
  board: { on: true },
  steps: { on: false },
  code_review: { on: true },
} as unknown as SettingsModel;

function capabilities(fullInbox: boolean, toggles: boolean[], chosen = !fullInbox) {
  const noop = () => {};
  render(
    <SidebarProvider>
      <SettingsPage
        settings={{ ...baseModel, full_inbox: { on: fullInbox, ...(chosen ? { chosen: true as const } : {}) } }}
        context={null}
        error={null}
        onToggleTool={noop}
        onToggleBoard={noop}
        onToggleSteps={noop}
        onToggleCodeReview={noop}
        onToggleFullInbox={(next) => toggles.push(next)}
        onToggleTailscale={noop}
        tailscaleBusy={false}
        permission="granted"
        onToggleNotifications={noop}
        onDeleteThread={async () => {}}
        onDeleteProject={async () => {}}
        section="capabilities"
      />
    </SidebarProvider>,
  );
}
const rowsOf = () => [...host!.querySelectorAll('[data-settings-capabilities] .ib-prow')].map((row) => row.querySelector('.ib-l')?.textContent?.trim());

describe.skipIf(!hasDom)('Settings → Capabilities', () => {
  test('code review only: the Full Inbox row on top, off, and no Code review, Board or Checklist row', () => {
    const toggles: boolean[] = [];
    capabilities(false, toggles);
    expect(rowsOf()).toEqual(['Full Inbox']);
    const sw = host!.querySelector<HTMLButtonElement>('[data-settings-full-inbox] [role="switch"]')!;
    expect(sw.getAttribute('aria-checked')).toBe('false');
    act(() => sw.click());
    expect(toggles).toEqual([true]);
  });

  test('switched to the full Inbox while Capabilities is open: the row stays under the click, the others come back', () => {
    capabilities(false, []);
    // A frame that does not say `chosen` (an older Inbox) still leaves it under the click.
    capabilities(true, [], false);
    expect(rowsOf()).toEqual(['Full Inbox', 'Board', 'Checklist', 'Code review']);
    expect(host!.querySelector('[data-settings-full-inbox] [role="switch"]')!.getAttribute('aria-checked')).toBe('true');
  });

  test('someone who was in the mode and switched back (`chosen`): the row, on, so they can switch back again', () => {
    const toggles: boolean[] = [];
    capabilities(true, toggles, true);
    expect(rowsOf()).toEqual(['Full Inbox', 'Board', 'Checklist', 'Code review']);
    act(() => host!.querySelector<HTMLButtonElement>('[data-settings-full-inbox] [role="switch"]')!.click());
    expect(toggles).toEqual([false]);
  });

  test('a person who only ever used the full Inbox: no Full Inbox row', () => {
    capabilities(true, [], false);
    expect(rowsOf()).not.toContain('Full Inbox');
    expect(rowsOf()).toContain('Code review');
  });

  test("a Full Inbox save that fails: the switch goes back and Settings says what the Inbox said, as for every switch", async () => {
    saveFails = true;
    const errors: (string | null)[] = [];
    let latest: SettingsModel | null = null;
    let toggle: ((next: boolean) => Promise<void>) | null = null;
    let refreshed = 0;
    function Saves() {
      const [settings, setSettings] = useState<SettingsModel | null>({ ...baseModel, full_inbox: { on: false } });
      latest = settings;
      toggle = useSettingsSaves({
        setSettings,
        setError: (error) => errors.push(error),
        refresh: async () => {
          refreshed += 1;
          setSettings((current) => (current ? { ...current, full_inbox: { on: false } } : current));
        },
        adoptStore: () => {},
        readStore: () => {},
        refreshList: async () => {},
      }).toggleFullInbox;
      return null;
    }
    render(<Saves />);
    await act(async () => toggle!(true));
    await wait(20);
    expect(fullSaves()).toEqual([{ on: true }]);
    expect(errors.at(-1)).toBe(SAVE_FAILED);
    expect(refreshed).toBe(1);
    expect(latest!.full_inbox).toEqual({ on: false });
  });
});

const agentRow = (id: InboxAgentRow['id'], label: string): InboxAgentRow => ({
  id,
  label,
  detected: true,
  reach: { kind: 'tool', on: true, state: 'connected', path: null, locked: false, reason: null },
  reminder: { on: false, locked: false, needs_tool: false },
  note: null,
});
const agentsModel: InboxAgentsModel = {
  agents: [agentRow('claude-code', 'Claude Code'), agentRow('pi', 'Pi')],
  last_report: null,
  connecting: false,
  connect_env_off: false,
  tool_env: null,
  notes_offered: true,
  note_text: '',
};

describe.skipIf(!hasDom)('Settings → Agents', () => {
  for (const reviewOnly of [true, false]) {
    test(reviewOnly ? 'code review only: no Reminder at session start row (no reminder is sent)' : 'the full Inbox: the Reminder at session start row, as before', () => {
      render(<AgentsSettings model={agentsModel} onModel={() => {}} context={null} reviewOnly={reviewOnly} />);
      const names = [...host!.querySelectorAll('[data-agent="claude-code"] .ib-agrow .ib-agk')].map((k) => k.textContent);
      expect(names.includes('Reminder at session start')).toBe(!reviewOnly);
      expect(names).toContain('Reaches the Inbox');
    });
  }
});
