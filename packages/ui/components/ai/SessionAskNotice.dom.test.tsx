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
  const t3Providers = [{ id: 'session-bridge', name: 'session-bridge', sessionBridge: { host: 't3', status: 'ready', modes: { turn: true, transient: false } } }];

  test('T3 offers waiting and stops listening without claiming to stop its turn', () => {
    const onSessionAskAction = mock((_questionId: string, _action: string) => {});
    const onStop = mock(() => {});
    const el = render({ messages: [entry({ error: 'busy', errorCode: 'agent_busy' })], onSessionAskAction,
      aiProviders: t3Providers, onAskGeneral: mock(() => {}), isStreaming: true, onStop });
    const choices = buttonsIn(el, '[data-session-ask-actions="busy"]');
    expect(choices.map(button => button.textContent)).toEqual(['Ask when it finishes']);
    act(() => choices[0].click());
    expect(onSessionAskAction.mock.calls).toEqual([['q1', 'wait']]);
    const stop = el.querySelector<HTMLButtonElement>('button[aria-label="Stop listening"]')!;
    expect(stop.title).toContain('the question can continue in T3');
    act(() => stop.click());
    expect(onStop).toHaveBeenCalledTimes(1);
  });

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

  // While a session is attached Ask AI has no other provider, so a gone or
  // blocked session must not offer a switch: only a note, and no buttons.
  test('gone and blocked: a note that the session cannot be reached, no fallback button', () => {
    const onSessionAskAction = mock((_questionId: string, _action: string) => {});
    for (const [errorCode, kind] of [['session_gone', 'gone'], ['session_blocked', 'blocked']] as const) {
      const el = render({ messages: [entry({ error: 'unreachable', errorCode })], onSessionAskAction });
      expect(el.querySelector(`[data-session-ask-unreachable="${kind}"]`)).not.toBeNull();
      expect(el.querySelector('[data-session-ask-actions]')).toBeNull();
      expect(el.querySelectorAll('[data-ai-message] button').length).toBe(0);
      act(() => root?.unmount());
      host?.remove();
      root = null;
      host = null;
    }
    expect(onSessionAskAction).not.toHaveBeenCalled();
  });

  test('a host that passes no handler renders no actions, even for a bridge error code', () => {
    const el = render({ messages: [entry({ error: 'busy', errorCode: 'agent_busy' })] });
    expect(el.querySelector('[data-session-ask-actions]')).toBeNull();
  });

  // The failure this guards: a taken-over answer rendered as an error, which
  // replaces the partial answer the reviewer already read.
  test('taken over: the partial answer stays, with the note under it', () => {
    const el = render({ messages: [entry({ text: 'Because of X', notice: 'NOTE-SENTINEL' })] });
    expect(el.textContent).toContain('Because of X');
    expect(el.querySelector('[data-session-ask-note="taken-over"]')?.textContent).toBe('NOTE-SENTINEL');
  });

  test('a waiting question shows the waiting status instead of "Thinking"', () => {
    const el = render({ messages: [entry({ isStreaming: true, status: 'waiting' })] });
    expect(el.querySelector('[data-session-ask-status="waiting"]')).not.toBeNull();
  });
});
