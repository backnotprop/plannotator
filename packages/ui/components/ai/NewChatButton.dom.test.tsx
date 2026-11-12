import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AIChatEntry } from '../../hooks/useAIChat';
import type { AIProviderOption } from '../../utils/aiProvider';

const hasDom = typeof document !== 'undefined';
const panelModule = hasDom ? await import('./DocumentAIChatPanel') : null;
const buttonModule = hasDom ? await import('./NewChatButton') : null;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function entry(text: string, isStreaming = false): AIChatEntry {
  return {
    question: { id: `q-${text}`, prompt: text, createdAt: 1 },
    response: { questionId: `q-${text}`, text, isStreaming, createdAt: 1 },
  };
}

function busyAnswer(text: string): AIChatEntry {
  return {
    question: { id: `q-${text}`, prompt: text, createdAt: 1 },
    response: { questionId: `q-${text}`, text: '', isStreaming: false, createdAt: 1, error: 'The session is busy.', errorCode: 'agent_busy' },
  };
}

function expectBlocked(button: HTMLButtonElement, reason: RegExp) {
  expect(button.disabled).toBe(false);
  expect(button.getAttribute('aria-disabled')).toBe('true');
  const description = document.getElementById(button.getAttribute('aria-describedby') ?? '');
  expect(description?.textContent ?? '').toMatch(reason);
}

const SDK: AIProviderOption = { id: 'claude-agent-sdk', name: 'claude-agent-sdk', models: [] };
const BRIDGE: AIProviderOption = { id: 'session-bridge', name: 'session-bridge', label: 'Ask this session · Pi', models: [] };

function render(props: Partial<React.ComponentProps<NonNullable<typeof panelModule>['DocumentAIChatPanel']>>) {
  const { DocumentAIChatPanel } = panelModule!;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <DocumentAIChatPanel
        messages={[]}
        isCreatingSession={false}
        isStreaming={false}
        onAskGeneral={() => {}}
        aiProviders={[SDK]}
        {...props}
      />,
    );
  });
  return host.querySelector<HTMLButtonElement>('[data-ai-new-chat]');
}

describe.if(hasDom)('Ask AI "New chat"', () => {
  test('absent without onNewChat (hosts keep the old panel) and on an empty chat', () => {
    expect(render({ messages: [entry('a')] })).toBeNull();
    act(() => root?.unmount());
    expect(render({ messages: [], onNewChat: () => {} })).toBeNull();
  });

  test('clears the chat when idle and is disabled while an answer is in flight', () => {
    let calls = 0;
    const idle = render({ messages: [entry('a')], onNewChat: () => { calls += 1; } });
    expect(idle).not.toBeNull();
    expect(idle!.getAttribute('aria-disabled')).toBeNull();
    act(() => idle!.click());
    expect(calls).toBe(1);
    act(() => root?.unmount());

    const busy = render({ messages: [entry('a', true)], isStreaming: true, onNewChat: () => { calls += 1; } });
    expectBlocked(busy!, /stop it/);
    act(() => busy!.click());
    expect(calls).toBe(1);
  });

  test('unavailable while a busy "Ask this session" answer still offers its choice', () => {
    let calls = 0;
    const button = render({
      messages: [entry('a'), busyAnswer('b')],
      aiProviders: [BRIDGE],
      onSessionAskAction: () => {},
      onNewChat: () => { calls += 1; },
    });
    expect(document.querySelector('[data-session-ask-actions="busy"]')).not.toBeNull();
    expectBlocked(button!, /Ask when it finishes/);
    act(() => button!.click());
    expect(calls).toBe(0);
  });

  // Pinned on purpose: with "Ask this session" the agent still remembers earlier questions, so the
  // button must not promise a fresh context.
  test('"Ask this session" says it only clears the panel', () => {
    const button = render({ messages: [entry('a')], aiProviders: [BRIDGE], onNewChat: () => {} });
    const bridge = buttonModule!.newChatLabels(true);
    expect(button!.textContent).toContain(bridge.label);
    expect(button!.title).toBe(bridge.title);
    expect(bridge.title).toContain('still remembers');
    expect(bridge.label).not.toBe(buttonModule!.newChatLabels(false).label);
  });
});
