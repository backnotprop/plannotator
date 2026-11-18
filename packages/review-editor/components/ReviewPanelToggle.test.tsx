import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ReviewPanelToggle } from './ReviewPanelToggle';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

async function render(props: { commentCount: number; agentRunning: boolean; aiUnread: boolean }): Promise<HTMLButtonElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<ReviewPanelToggle isOpen={false} onToggle={() => {}} {...props} />));
  return host.querySelector<HTMLButtonElement>('[data-review-panel-toggle]')!;
}

describe.if(hasDom)('the review panel button', () => {
  test('with comments and a running agent it shows the count and the dot, and says both', async () => {
    const button = await render({ commentCount: 3, agentRunning: true, aiUnread: false });
    expect(button.querySelector('[data-review-panel-count]')?.textContent).toBe('3');
    expect(button.querySelector('[data-review-panel-activity]')).not.toBeNull();
    expect(button.getAttribute('aria-label')).toContain('3 comments, an agent is running');
  });

  test('with comments and an unread AI reply it shows the count and the dot, and says both', async () => {
    const button = await render({ commentCount: 1, agentRunning: false, aiUnread: true });
    expect(button.querySelector('[data-review-panel-count]')?.textContent).toBe('1');
    expect(button.querySelector('[data-review-panel-activity]')).not.toBeNull();
    expect(button.getAttribute('aria-label')).toContain('1 comment, an AI reply is unread');
  });
});
