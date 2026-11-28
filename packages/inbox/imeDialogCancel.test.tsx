import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';

const hasDom = typeof document !== 'undefined';
const { Modal } = (hasDom ? await import('./components/Updates') : {}) as typeof import('./components/Updates');
const { DecisionMode } = (hasDom ? await import('./decisions/DecisionMode') : {}) as typeof import('./decisions/DecisionMode');
const { createInboxQueryClient } = (hasDom ? await import('./data/client') : {}) as typeof import('./data/client');

let root: Root | null = null;
let host: HTMLElement | null = null;
let closes = 0;

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  closes = 0;
});

const DIALOGS: Array<[string, () => React.ReactElement]> = [
  ['the shared Inbox dialog', () => (
    <Modal label="Feedback" testId="ime" onClose={() => { closes++; }}>
      <textarea aria-label="Feedback" />
    </Modal>
  )],
  ['Decide', () => (
    <QueryClientProvider client={createInboxQueryClient()}>
      <DecisionMode open decisions={[]} rows={new Map()} phone={false} refresh={() => {}} subscribeQuestions={() => () => {}} onTuck={() => {}} onClose={() => { closes++; }} />
    </QueryClientProvider>
  )],
];

const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function escapeThenCancel(dialog: HTMLDialogElement, init: KeyboardEventInit & { keyCode?: number }) {
  await act(async () => {
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...init }));
    dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
  });
}

for (const [name, draw] of DIALOGS) {
  test.skipIf(!hasDom)(`${name}: the close that follows an input method's Escape is not a close; a plain one is`, async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    await act(async () => {
      root = createRoot(host!);
      root.render(draw());
    });
    const dialog = host.querySelector('dialog')!;
    await escapeThenCancel(dialog, { isComposing: true });
    await escapeThenCancel(dialog, { keyCode: 229 });
    expect(closes).toBe(0);
    await later(120);
    await act(async () => {
      dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
    });
    expect(closes).toBe(1);
  });
}
