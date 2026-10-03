import { afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AIChatEntry } from '../../hooks/useAIChat';
import type { AIResponse } from '../../types';

const hasDom = typeof document !== 'undefined';
const panelModule = hasDom ? await import('./DocumentAIChatPanel') : null;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function entry(response: Partial<AIResponse>): AIChatEntry {
  return {
    question: { id: 'q1', prompt: 'why?', createdAt: 0 },
    response: { questionId: 'q1', text: '', isStreaming: false, createdAt: 0, ...response },
  };
}

function render(props: Record<string, unknown>) {
  const { DocumentAIChatPanel } = panelModule!;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <DocumentAIChatPanel isCreatingSession={false} isStreaming={false} {...(props as { messages: AIChatEntry[] })} />,
    );
  });
  return host;
}

function buttonsIn(container: Element, selector: string): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll(`${selector} button`));
}

describe.if(hasDom)('Ask this session notices in the document chat panel', () => {
  test('busy: the two choices report wait and interrupt for that question', () => {
    const onSessionAskAction = mock((_questionId: string, _action: string) => {});
    const el = render({
      messages: [entry({ error: 'The session is busy with another turn.', errorCode: 'agent_busy' })],
      onSessionAskAction,
    });
    const buttons = buttonsIn(el, '[data-session-ask-actions="busy"]');
    // Action labels are deliberate (owner decision 4), so they are pinned here.
    expect(buttons.map((b) => b.textContent)).toEqual(['Ask when it finishes', 'Interrupt and ask now']);
    act(() => buttons[0].click());
    act(() => buttons[1].click());
    expect(onSessionAskAction.mock.calls).toEqual([['q1', 'wait'], ['q1', 'interrupt']]);
  });

  test('gone: offers the separate-AI fallback only when there is one', () => {
    const onSessionAskAction = mock((_questionId: string, _action: string) => {});
    const withFallback = render({
      messages: [entry({ error: 'gone', errorCode: 'session_gone' })],
      onSessionAskAction,
      sessionAskFallbackLabel: 'Pi',
    });
    const [fallback] = buttonsIn(withFallback, '[data-session-ask-actions="fallback"]');
    act(() => fallback.click());
    expect(onSessionAskAction.mock.calls).toEqual([['q1', 'fallback']]);
    act(() => root?.unmount());
    host?.remove();

    const without = render({
      messages: [entry({ error: 'gone', errorCode: 'session_gone' })],
      onSessionAskAction,
      sessionAskFallbackLabel: null,
    });
    expect(without.querySelector('[data-session-ask-actions]')).toBeNull();
  });

  test('a host that passes no handler renders no actions, even for a bridge error code', () => {
    const el = render({ messages: [entry({ error: 'busy', errorCode: 'agent_busy' })] });
    expect(el.querySelector('[data-session-ask-actions]')).toBeNull();
  });

  test('a waiting question shows the waiting status instead of "Thinking"', () => {
    const el = render({ messages: [entry({ isStreaming: true, status: 'waiting' })] });
    expect(el.querySelector('[data-session-ask-status="waiting"]')).not.toBeNull();
  });
});
