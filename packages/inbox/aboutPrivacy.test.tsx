/**
 * Settings → About's Privacy part (the daily ping, packages/shared/daily-ping.ts):
 * on a page with and without the update controls, below the version; the
 * one off switch (NO_ANON_PING) as code; the privacy policy in a new tab; and
 * no switch, since the environment is the only way to turn it off.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
// Updates.tsx draws What's new with ui's Viewer, which reads `window` at module-eval time.
const { AboutBlock } = (hasDom ? await import('./components/Updates') : {}) as typeof import('./components/Updates');
let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function render(updates: boolean) {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <AboutBlock
        version="0.28.46"
        updates={updates}
        details={null}
        switches={{ update_check: { on: true, env: null }, auto_update: { on: false, env: null } }}
        checking={false}
        error={null}
        onCheckNow={() => {}}
        onToggle={() => {}}
        where={{ data: '/tmp/x', mcpUrl: 'http://127.0.0.1:1/mcp', mcpCommand: 'x' }}
      />,
    );
  });
  return host;
}

for (const [page, updates] of [
  ["the computer's own page", true],
  ["a page that offers no updates", false],
] as const) {
  test.skipIf(!hasDom)(`${page}: Privacy below the version, NO_ANON_PING as code, the policy in a new tab, no switch`, () => {
    const el = render(updates);
    const groups = [...el.querySelectorAll('section.ib-sgroup')];
    const privacy = el.querySelector<HTMLElement>('[data-settings-privacy]')!;
    expect(privacy).not.toBeNull();
    // After the version (and updates), before "Where things are".
    expect(groups.indexOf(privacy)).toBe(1);
    expect(privacy.querySelector('h2')?.textContent).toBe('Privacy');
    expect([...privacy.querySelectorAll('code')].map((c) => c.textContent)).toEqual(['NO_ANON_PING=1']);
    const link = privacy.querySelector<HTMLAnchorElement>('a')!;
    expect(link.getAttribute('href')).toBe('https://plannotator.ai/privacy');
    expect(link.target).toBe('_blank');
    expect(link.rel).toContain('noreferrer');
    // No card, no switch, no note box: plain text only.
    expect(privacy.querySelector('.ib-card, [role="switch"], .ib-note, .ib-chip')).toBeNull();
  });
}
