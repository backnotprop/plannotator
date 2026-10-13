/**
 * The agent tool offer's own keyboard and save contract (DOM_TESTS=1). The
 * App-level flows (when it shows, what it posts, the cookie) live in
 * packages/editor/App.agentTool.test.tsx and its review twin.
 *
 * Guards: Escape and the backdrop closing it like "Not now"; a close while a
 * save is in flight, which would hide whether the setting saved; "Not now"
 * not holding focus, so a stray Enter could turn the tool on.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AgentToolAnnouncementDialog } from './AgentToolAnnouncementDialog';

const hasDom = typeof document !== 'undefined';
const DIALOG = '[data-agent-tool-announcement-dialog]';
let root: Root | null = null;
let host: HTMLElement | null = null;

async function mount(onTurnOn: () => Promise<void>, onDismiss: () => void) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<AgentToolAnnouncementDialog isOpen host="pi" onTurnOn={onTurnOn} onDismiss={onDismiss} />);
  });
}

function press(key: string) {
  document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll<HTMLButtonElement>(`${DIALOG} button`))
    .find((candidate) => candidate.textContent?.trim() === label);
  if (!found) throw new Error(`"${label}" did not render`);
  return found;
}

describe('AgentToolAnnouncementDialog', () => {
  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = null;
    host?.remove();
    host = null;
    if (hasDom) document.body.replaceChildren();
  });

  test.skipIf(!hasDom)('"Not now" holds focus; Escape and the backdrop dismiss', async () => {
    let dismissed = 0;
    await mount(async () => {}, () => { dismissed += 1; });
    expect(document.activeElement).toBe(button('No, I’ll just use slash commands'));

    await act(async () => press('Escape'));
    expect(dismissed).toBe(1);

    const backdrop = document.querySelector<HTMLElement>(DIALOG)?.parentElement;
    await act(async () => {
      backdrop?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(dismissed).toBe(2);
  });

  test.skipIf(!hasDom)('cannot be closed while the save is in flight', async () => {
    let dismissed = 0;
    let finish: () => void = () => {};
    await mount(() => new Promise<void>((resolve) => { finish = resolve; }), () => { dismissed += 1; });

    await act(async () => button('Yes, turn it on').click());
    expect(button('Turning on…').disabled).toBe(true);
    await act(async () => press('Escape'));
    expect(dismissed).toBe(0);

    await act(async () => finish());
    expect(document.querySelector(`${DIALOG} [data-agent-tool-status="saved"]`)).not.toBeNull();
    expect(document.activeElement).toBe(button('Done'));
  });
});
