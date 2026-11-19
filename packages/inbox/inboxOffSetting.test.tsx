/**
 * Settings → General's Turn the Inbox off (components/InboxOffSetting.tsx,
 * DOM_TESTS=1). Regressions guarded: a confirmation step creeping in (one
 * click turns it off); the screen after it not saying how to turn it back on;
 * a failed Turn off shown as off.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { InboxOffSetting } from './components/InboxOffSetting';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;

async function mount(post: (path: string, body: Record<string, unknown>) => Promise<unknown>) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<InboxOffSetting post={post as never} />);
  });
}
const button = () => document.querySelector<HTMLButtonElement>('[data-settings-turn-off]');

describe('Turn the Inbox off', () => {
  afterEach(async () => {
    const mounted = root;
    if (mounted) await act(async () => mounted.unmount());
    root = null;
    host?.remove();
    host = null;
    if (hasDom) document.body.replaceChildren();
  });

  test.skipIf(!hasDom)('one click turns it off, and what is left says it is off and how to turn it back on', async () => {
    const asked: string[] = [];
    await mount(async (path) => {
      asked.push(path);
      return {
        ok: true,
        lines: [
          'The Plannotator Inbox is off on this computer: agents lose it from their next session, and nothing starts it.',
          "Removed Plannotator's note for Claude Code from ~/.claude/rules/plannotator-inbox.md.",
          'Turn it back on any time with plannotator inbox.',
        ],
      };
    });
    await act(async () => button()?.click());
    expect(asked).toEqual(['/api/inbox/off']);
    const screen = document.querySelector('[data-inbox-off-screen]');
    expect(screen?.textContent).toContain('The Inbox is off');
    expect(screen?.textContent).toContain('Turn it back on any time with plannotator inbox.');
    expect(screen?.querySelector('code')?.textContent).toBe('plannotator inbox');
  });

  test.skipIf(!hasDom)('a failed Turn off says why and leaves the switch to try again', async () => {
    await mount(async () => {
      throw new Error("Could not turn the Plannotator Inbox off: state.json in Plannotator's data folder could not be written.");
    });
    await act(async () => button()?.click());
    expect(document.querySelector('[data-inbox-off-screen]')).toBeNull();
    expect(document.querySelector('[data-inbox-off-failed]')?.textContent).toContain('could not be written');
    expect(button()?.disabled).toBe(false);
  });
});
