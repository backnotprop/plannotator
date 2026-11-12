import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  AgentTerminalDisplayPopover,
  DEFAULT_DISPLAY_SETTINGS,
  type AgentTerminalDisplaySettings,
} from './AnnotateAgentTerminalPanel';
import type { AnnotateAgentTerminalSide } from '@plannotator/ui/utils/annotateAgentTerminal';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  if (hasDom) document.body.replaceChildren();
});

const NON_DEFAULT_SETTINGS: AgentTerminalDisplaySettings = {
  fontFamily: 'geist',
  fontSize: 18,
  fontWeight: 'light',
  lineHeight: 1.35,
};

async function mountPopover(options: {
  side: AnnotateAgentTerminalSide;
  onChange: (updates: Partial<AgentTerminalDisplaySettings>) => void;
  onSideChange: (side: AnnotateAgentTerminalSide) => void;
}): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <AgentTerminalDisplayPopover
        settings={NON_DEFAULT_SETTINGS}
        side={options.side}
        onChange={options.onChange}
        onSideChange={options.onSideChange}
        defaultOpen
      />,
    );
  });
}

function resetButton(): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(
    'button[aria-label="Reset terminal display settings"]',
  );
  if (!button) throw new Error('reset button missing (popover did not open)');
  return button;
}

describe.if(hasDom)('agent terminal Display popover reset', () => {
  test('reset restores the display defaults and leaves the side/placement untouched', async () => {
    const changes: Array<Partial<AgentTerminalDisplaySettings>> = [];
    const sideChanges: AnnotateAgentTerminalSide[] = [];
    await mountPopover({
      side: 'right',
      onChange: (updates) => changes.push(updates),
      onSideChange: (side) => sideChanges.push(side),
    });

    await act(async () => resetButton().click());

    expect(changes).toEqual([DEFAULT_DISPLAY_SETTINGS]);
    expect(sideChanges).toEqual([]);
  });

  test('the Position control stays the explicit way to change placement', async () => {
    const sideChanges: AnnotateAgentTerminalSide[] = [];
    await mountPopover({
      side: 'left',
      onChange: () => {},
      onSideChange: (side) => sideChanges.push(side),
    });

    const rightOption = Array.from(document.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === 'Right');
    if (!rightOption) throw new Error('Position "Right" option missing');
    await act(async () => rightOption.click());

    expect(sideChanges).toEqual(['right']);
  });
});
