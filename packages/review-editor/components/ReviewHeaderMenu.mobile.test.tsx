import { afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ThemeProvider } from '@plannotator/ui/components/ThemeProvider';
import { ReviewHeaderMenu } from './ReviewHeaderMenu';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

describe('ReviewHeaderMenu compact review actions', () => {
  test.skipIf(!hasDom)('moves destination and terminal actions into the phone menu', async () => {
    const onDestinationChange = mock(() => {});
    const onFeedback = mock(() => {});
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => root?.render(
      <ThemeProvider defaultTheme="dark">
        <ReviewHeaderMenu
          onOpenSettings={() => {}}
          onOpenExport={() => {}}
          onCopyAgentInstructions={() => {}}
          onToggleFileTree={() => {}}
          onToggleSidebar={() => {}}
          isFileTreeOpen={false}
          isSidebarOpen={false}
          compactTouchLayout
          compactDestination={{
            value: 'platform',
            platform: 'github',
            platformLabel: 'GitHub',
            onChange: onDestinationChange,
          }}
          compactActions={[
            { id: 'exit', label: 'Exit review', onSelect: () => {} },
            { id: 'feedback', label: 'Post comments', subtitle: '2 annotations', onSelect: onFeedback },
            { id: 'approve', label: 'Approve', onSelect: () => {}, disabled: true },
          ]}
          agentInstructionsEnabled={false}
          appVersion="test"
        />
      </ThemeProvider>,
    ));

    await act(async () => host?.querySelector<HTMLButtonElement>('button[aria-label="Options"]')?.click());
    expect(host?.textContent).toContain('Review');
    expect(host?.textContent).toContain('GitHub');
    expect(host?.textContent).toContain('Post comments');
    expect(host?.textContent).toContain('2 annotations');
    expect(Array.from(host?.querySelectorAll('button') ?? []).find((button) => button.textContent?.includes('Approve'))?.disabled).toBe(true);

    const agentButton = Array.from(host?.querySelectorAll('button') ?? [])
      .find((button) => button.textContent?.trim() === 'Agent');
    await act(async () => agentButton?.click());
    expect(onDestinationChange).toHaveBeenCalledWith('agent');

    const feedbackButton = Array.from(host?.querySelectorAll('button') ?? [])
      .find((button) => button.textContent?.includes('Post comments'));
    await act(async () => feedbackButton?.click());
    expect(onFeedback).toHaveBeenCalledTimes(1);
    expect(host?.textContent).not.toContain('Post comments');
  });

  // Standing toolbar-integrity rule: the additive 'note' row must not remove,
  // reorder, or disable any incumbent compact action. The closed-union id edit
  // is where that actually risks breaking.
  test.skipIf(!hasDom)('the additive note row joins the incumbent rows without displacing them', async () => {
    const onNote = mock(() => {});
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => root?.render(
      <ThemeProvider defaultTheme="dark">
        <ReviewHeaderMenu
          onOpenSettings={() => {}}
          onOpenExport={() => {}}
          onCopyAgentInstructions={() => {}}
          onToggleFileTree={() => {}}
          onToggleSidebar={() => {}}
          isFileTreeOpen={false}
          isSidebarOpen={false}
          compactTouchLayout
          compactActions={[
            { id: 'exit', label: 'Exit review', onSelect: () => {} },
            { id: 'note', label: 'Add a note', subtitle: 'Sent with your annotations', onSelect: onNote },
            { id: 'feedback', label: 'Send feedback', subtitle: '2 annotations', onSelect: () => {} },
            { id: 'approve', label: 'Approve', onSelect: () => {} },
          ]}
          agentInstructionsEnabled={false}
          appVersion="test"
        />
      </ThemeProvider>,
    ));

    await act(async () => host?.querySelector<HTMLButtonElement>('button[aria-label="Options"]')?.click());

    const labels = ['Exit review', 'Add a note', 'Send feedback', 'Approve'];
    const rows = Array.from(host?.querySelectorAll('button') ?? [])
      .filter((button) => labels.some((label) => button.textContent?.includes(label)));
    expect(rows.length).toBe(4);
    expect(rows.map((button) => labels.find((label) => button.textContent?.includes(label)))).toEqual(labels);
    expect(rows.every((button) => !button.disabled)).toBe(true);

    const noteRow = rows[1];
    await act(async () => noteRow.click());
    expect(onNote).toHaveBeenCalledTimes(1);
  });
});
