/**
 * Settings → Capabilities: a linked computer's switch shows the line under its name that this computer's row has,
 * said of that computer (capabilityLines.tsx is the one source); this computer's rows read as they did on main; a
 * switch with no line shows its name alone.
 *
 * What regresses: a linked row back to its name only, a linked row's words drifting from this computer's, a linked row
 * saying "this computer" or telling a reload done on that computer, a linked Board or Float reply drafts line claiming
 * what only this computer's switch does, a held turn's words read as more explanation, a local row's words changed by
 * the move, or a switch with no line drawing an empty line (or no row).
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt. No server: SettingsPage on its own,
 * with fetch answered in the test.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const { SettingsPage } = (hasDom ? await import('./Settings') : {}) as typeof import('./Settings');
const { SidebarProvider } = (hasDom ? await import('../shell/sidebar') : {}) as typeof import('../shell/sidebar');
const { LinkedSwitchRow, linkedSwitchRows } = (hasDom ? await import('./LinkedCapabilities') : {}) as typeof import('./LinkedCapabilities');

const STUDIO = 'ibx_01HZZZZZZZZZZZZZZZZZZZZZZZ';
const realFetch = globalThis.fetch;
let root: Root | null = null;
afterEach(() => {
  globalThis.fetch = realFetch;
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
async function settle() {
  for (let i = 0; i < 10; i++) await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
}
function mount() {
  const host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  root = createRoot(host);
  return host;
}

const SWITCHES = { board: { on: true }, steps: { on: false }, scheduled_threads: { on: true }, code_review: { on: true }, chapter_diagrams: { on: true }, bro: { on: false }, float_drafts: { on: true } };
/** This computer's row for each switch, by its data attribute. */
const LOCAL_ROW = { board: 'data-settings-board', steps: 'data-settings-steps', scheduled_threads: 'data-settings-scheduled', code_review: 'data-settings-code-review', chapter_diagrams: 'data-settings-chapter-diagrams', bro: 'data-settings-bro', float_drafts: 'data-settings-float-drafts' } as const;

/** Each local row's line as main had it written in Settings.tsx and scheduled/SettingsRow.tsx before the one source. */
const MAIN_LINES: Record<keyof typeof LOCAL_ROW, string> = {
  board: 'A page of the work in flight, one card per piece, that your agents keep current. Off, there is no Board page and agents are not offered cards; every card is kept. Agents pick this up in their next session.',
  steps: "Your agents' plan for the work in a thread as a checklist, one step per line, under a button at the thread's foot. Off, agents are not offered a checklist and none shows; every checklist is kept. Agents pick this up in their next session.",
  scheduled_threads: 'Runs saved prompts on a schedule, on this computer, while the Inbox is running.',
  code_review:
    "Review your agents' code changes and your pull requests from GitHub and GitLab: type / in a reply to ask for a review, then approve it, send feedback to the agent, or post it on the pull request. Off, agents are not offered reviews and the review skills leave the / list; guided reviews and plannotator review work as before either way. Agents pick this up in their next session.",
  chapter_diagrams: "Agents may add a diagram above a chapter's code.",
  bro: 'Agents write to your Inbox in plain words. Applies to new agent sessions. In open Claude Code sessions, run /reload-plugins plannotator.',
  float_drafts: 'Keep an unsent reply in a small window in the corner when you leave its thread.',
};
/** Main's `<code>` in a line. */
const MAIN_CODE: Partial<Record<keyof typeof LOCAL_ROW, string[]>> = { code_review: ['plannotator review'], bro: ['/reload-plugins plannotator'] };

test.skipIf(!hasDom)('this computer\'s rows read exactly as on main', async () => {
  const { host } = await settingsWithStudio();
  for (const [key, attr] of Object.entries(LOCAL_ROW) as [keyof typeof LOCAL_ROW, string][]) {
    const local = host.querySelector(`[${attr}] .ib-desc`)!;
    expect([key, local.textContent]).toEqual([key, MAIN_LINES[key]]);
    expect([key, [...local.querySelectorAll('code')].map((c) => c.textContent)]).toEqual([key, MAIN_CODE[key] ?? []]);
  }
});

test.skipIf(!hasDom)("a linked computer's switches show this computer's lines, said of that computer", async () => {
  const { host, group } = await settingsWithStudio();
  const linkedLine = (key: string) => group.querySelector(`[data-settings-linked-switch="${key}"] .ib-desc`);
  for (const [key, attr] of Object.entries(LOCAL_ROW)) {
    const linked = linkedLine(key);
    expect([key, linked?.textContent?.includes('this computer')]).toEqual([key, false]);
    if (key !== 'chapter_diagrams') continue;
    expect([key, linked?.innerHTML]).toEqual([key, host.querySelector(`[${attr}] .ib-desc`)!.innerHTML]);
  }
  // The Board is one page across computers: Studio's switch offers its agents cards, and never takes the page away.
  expect(linkedLine('board')!.textContent).toBe('Agents on Studio keep cards on the Board for their work. Off, they are not offered cards; every card is kept. Agents pick this up in their next session.');
  // Checklist and Code review in this window follow this computer's switch: Studio's changes its agents and its own window.
  expect(linkedLine('steps')!.textContent).toBe('Agents on Studio keep their plan for the work in a thread as a checklist, one step per line. Off, they are not offered a checklist; every checklist is kept. Agents pick this up in their next session.');
  expect(linkedLine('code_review')!.textContent).toBe("Agents on Studio are offered code reviews, and Studio's own window offers them in the / list. Off, Studio's agents are not offered reviews; guided reviews and plannotator review work as before either way. Agents pick this up in their next session.");
  expect([...linkedLine('code_review')!.querySelectorAll('code')].map((c) => c.textContent)).toEqual(['plannotator review']);
  // Float reply drafts changes only Studio's own window.
  expect(linkedLine('float_drafts')!.textContent).toBe("In Studio's own window, an unsent reply stays in a small window in the corner when you leave its thread.");
  // Routines runs on Studio, not here.
  expect(linkedLine('scheduled_threads')!.textContent).toBe('Runs saved prompts on a schedule, on Studio, while its Inbox is running.');
  // Bro mode's reload is typed in a session on that computer: only this computer's row says it.
  expect(linkedLine('bro')!.textContent).toBe('Agents write to your Inbox in plain words. Applies to new agent sessions.');
  expect(linkedLine('bro')!.querySelector('code')).toBeNull();
});

/** SettingsPage on Capabilities, with this computer's switches and a linked Studio that reports the same ones. */
async function settingsWithStudio() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input) === `/api/inbox/m/${STUDIO}/capabilities`) return json({ capabilities: SWITCHES, away: false, held: [] });
    return json({});
  }) as typeof fetch;
  const noop = () => {};
  const settings = { serverSession: 's', version: '0.29.0', port: 1, url: 'http://localhost:1/', home: '/home/u', data_dir: '/home/u/.plannotator', phones: false, ...SWITCHES };
  const host = mount();
  await act(async () =>
    root!.render(
      <SidebarProvider>
        <SettingsPage
          settings={settings as never}
          context={null}
          error={null}
          onToggleTool={noop}
          onToggleBoard={noop}
          onToggleSteps={noop}
          onToggleScheduled={noop}
          onToggleCodeReview={noop}
          onToggleChapterDiagrams={noop}
          onToggleBro={noop}
          onToggleFloatDrafts={noop}
          onToggleTailscale={noop}
          tailscaleBusy={false}
          permission="granted"
          onToggleNotifications={noop}
          onDeleteThread={async () => {}}
          onDeleteProject={async () => {}}
          section="capabilities"
          machines={[{ id: STUDIO, name: 'Studio', self: false, state: 'online', marks: ['capabilities'] } as never]}
        />
      </SidebarProvider>,
    ),
  );
  await settle();
  const group = host.querySelector(`[data-settings-linked-capabilities="${STUDIO}"]`)!;
  expect(group).not.toBeNull();
  return { host, group };
}

test.skipIf(!hasDom)('a switch with no line shows its name alone, with its switch', async () => {
  const rows = linkedSwitchRows({ board: { on: true }, bro: { on: false } }, 'Studio', (key) => (key === 'board' ? 'A line.' : null));
  expect(rows.map((r) => [r.key, r.line])).toEqual([['board', 'A line.'], ['bro', null]]);
  const host = mount();
  await act(async () => root!.render(<div className="ib-card">{rows.map((row) => <LinkedSwitchRow key={row.key} row={row} heading="h" held={false} waiting={null} onTurn={() => {}} />)}</div>));
  const bro = host.querySelector('[data-settings-linked-switch="bro"]')!;
  expect(bro.querySelector('.ib-l')!.textContent).toBe('Bro mode');
  expect(bro.querySelector('.ib-desc')).toBeNull();
  expect(bro.querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('false');
  expect(host.querySelector('[data-settings-linked-switch="board"] .ib-desc')!.textContent).toBe('A line.');
});

test.skipIf(!hasDom)("a held turn's words sit right under the switch's name, in the held words' look, before its line", async () => {
  const [row] = linkedSwitchRows({ scheduled_threads: { on: true } }, 'Studio');
  const host = mount();
  await act(async () => root!.render(<LinkedSwitchRow row={row!} heading="h" held waiting="Waiting for Studio: this applies when Studio is back." onTurn={() => {}} />));
  const parts = [...host.querySelectorAll('[data-settings-linked-switch="scheduled_threads"] .ib-txt > *')];
  expect(parts.map((el) => [el.className, el.textContent])).toEqual([
    ['ib-l', 'Routines'],
    ['ib-desc ib-held-words', 'Waiting for Studio: this applies when Studio is back.'],
    ['ib-desc', 'Runs saved prompts on a schedule, on Studio, while its Inbox is running.'],
  ]);
});
