/**
 * Settings → Capabilities: a linked computer's switch shows the same line under its name as this computer's row for
 * the same switch (capabilityLines.tsx is the one source), and a switch with no line shows its name alone.
 *
 * What regresses: a linked row back to its name only, a linked row's words drifting from this computer's, or a switch
 * with no line drawing an empty line (or no row).
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

test.skipIf(!hasDom)("a linked computer's switches show the same line under their names as this computer's rows", async () => {
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
  for (const [key, attr] of Object.entries(LOCAL_ROW)) {
    const local = host.querySelector(`[${attr}] .ib-desc`);
    const linked = group.querySelector(`[data-settings-linked-switch="${key}"] .ib-desc`);
    expect([key, linked?.innerHTML]).toEqual([key, local!.innerHTML]);
    expect(linked!.textContent!.length).toBeGreaterThan(20);
  }
});

test.skipIf(!hasDom)('a switch with no line shows its name alone, with its switch', async () => {
  const rows = linkedSwitchRows({ board: { on: true }, bro: { on: false } }, { board: 'A line.' });
  expect(rows.map((r) => [r.key, r.line])).toEqual([['board', 'A line.'], ['bro', null]]);
  const host = mount();
  await act(async () => root!.render(<div className="ib-card">{rows.map((row) => <LinkedSwitchRow key={row.key} row={row} heading="h" held={false} waiting={null} onTurn={() => {}} />)}</div>));
  const bro = host.querySelector('[data-settings-linked-switch="bro"]')!;
  expect(bro.querySelector('.ib-l')!.textContent).toBe('Bro mode');
  expect(bro.querySelector('.ib-desc')).toBeNull();
  expect(bro.querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('false');
  expect(host.querySelector('[data-settings-linked-switch="board"] .ib-desc')!.textContent).toBe('A line.');
});
