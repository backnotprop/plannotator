/**
 * The sidebar's "Copy connect prompt" row: a click puts the prompt naming
 * this computer's plannotator on the clipboard, the row reads "Copied" and
 * goes back after 2 s, focus stays on it, and a polite live region says so.
 * A failed copy is never silent: the row reads "Couldn't copy" and the live
 * region says that too. What regresses: copying before the settings arrive
 * and never picking up the path, a "Copied" that sticks, a failure that looks
 * like nothing happened, or an announcement a screen reader never hears.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from the test.yml DOM list.
 */
import { afterEach, expect, jest, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const { Sidebar, CONNECT_COPIED_MS, CONNECT_COPY_FAILED_MS } = (hasDom ? await import('./components/Sidebar') : {}) as typeof import('./components/Sidebar');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');

const BIN = '/Users/ada/.local/bin/plannotator';

let root: Root | null = null;
const restorers: Array<() => void> = [];

function override(target: object, key: string, value: unknown): void {
  const original = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { value, configurable: true, writable: true });
  restorers.push(() => {
    if (original) Object.defineProperty(target, key, original);
    else delete (target as Record<string, unknown>)[key];
  });
}

afterEach(() => {
  jest.useRealTimers();
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  while (restorers.length > 0) restorers.pop()!();
});

function render(mcpCommand: readonly string[] | null) {
  const host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  root = createRoot(host);
  const noop = () => {};
  const draw = (command: readonly string[] | null) =>
    act(() =>
      root!.render(
        <SidebarProvider>
          <Sidebar
            page="inbox"
            projectId={null}
            inboxCount={0}
            decisionsCount={0}
            projects={[]}
            projectCounts={new Map()}
            update={null}
            restarting={false}
            updated={null}
            onInbox={noop}
            onProject={noop}
            onSettings={noop}
            onDecisions={noop}
            onUpdate={noop}
            onWhatsNew={noop}
            mcpCommand={command}
          />
        </SidebarProvider>,
      ),
    );
  draw(mcpCommand);
  const row = () => host.querySelector<HTMLButtonElement>('button[data-connect-prompt]')!;
  const live = () => host.querySelector<HTMLElement>('[data-connect-prompt-live]')!;
  return { host, row, live, redraw: draw };
}

async function click(button: HTMLButtonElement) {
  button.focus();
  await act(async () => {
    button.click();
  });
}

test.skipIf(!hasDom)('a click copies the prompt naming this binary, says Copied, keeps focus, and goes back after 2 s', async () => {
  const written: string[] = [];
  override(navigator, 'clipboard', { writeText: async (text: string) => void written.push(text) });
  jest.useFakeTimers();
  const { host, row, live } = render([BIN, 'inbox', 'mcp']);

  // The row sits just above Settings, in the foot.
  const foot = host.querySelector('.ib-side-foot')!;
  const navs = [...foot.querySelectorAll('.ib-nav')];
  expect(navs.map((b) => b.textContent)).toEqual(['Copy connect prompt', 'Settings']);
  expect(live().getAttribute('aria-live')).toBe('polite');
  expect(live().textContent).toBe('');

  await click(row());
  expect(written).toHaveLength(1);
  expect(written[0]).toContain(`\`${BIN} inbox --help\``);
  expect(row().textContent).toBe('Copied');
  expect(row().dataset.connectPrompt).toBe('copied');
  expect(document.activeElement).toBe(row());
  expect(live().textContent).toBe('Connect prompt copied.');

  act(() => jest.advanceTimersByTime(CONNECT_COPIED_MS - 1));
  expect(row().textContent).toBe('Copied');
  act(() => jest.advanceTimersByTime(1));
  expect(row().textContent).toBe('Copy connect prompt');
  expect(document.activeElement).toBe(row());

  // A second copy is announced again: the live region's text changes.
  await click(row());
  expect(written).toHaveLength(2);
  expect(live().textContent?.trim()).toBe('Connect prompt copied.');
  expect(live().textContent).not.toBe('Connect prompt copied.');
});

test.skipIf(!hasDom)('before the settings load it copies bare plannotator, and the path once they arrive', async () => {
  const written: string[] = [];
  override(navigator, 'clipboard', { writeText: async (text: string) => void written.push(text) });
  const { row, redraw } = render(null);
  await click(row());
  expect(written[0]).toContain('`plannotator inbox --help`');
  redraw([BIN, 'inbox', 'mcp']);
  await click(row());
  expect(written[1]).toContain(`\`${BIN} inbox --help\``);
});

test.skipIf(!hasDom)("a failed copy says Couldn't copy in the row and announces it", async () => {
  override(navigator, 'clipboard', { writeText: () => Promise.reject(new Error('denied')) });
  override(document, 'execCommand', () => false);
  jest.useFakeTimers();
  const { row, live } = render([BIN, 'inbox', 'mcp']);

  await click(row());
  expect(row().textContent).toBe("Couldn't copy");
  expect(row().dataset.connectPrompt).toBe('failed');
  expect(live().textContent).toBe("Couldn't copy the connect prompt.");
  expect(document.activeElement).toBe(row());

  act(() => jest.advanceTimersByTime(CONNECT_COPY_FAILED_MS));
  expect(row().textContent).toBe('Copy connect prompt');
});
