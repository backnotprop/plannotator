/**
 * Runs the real sanitizer over `tests/helpers/chat-sanitizer-dom.ts`, because without it every
 * text draws as plain text.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { bridgeSanitizerDom } from '../../../../tests/helpers/chat-sanitizer-dom';
import type * as Transcript from './ChatTranscript';
import type { ChatMessage, ChatTranscriptProps } from './ChatTranscript';

const hasDom = typeof document !== 'undefined';
let ChatTranscript: typeof Transcript.ChatTranscript;
let unbridge: (() => void) | undefined;
let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeAll(async () => {
  if (!hasDom) return;
  unbridge = bridgeSanitizerDom();
  ({ ChatTranscript } = await import('./ChatTranscript'));
});

afterAll(() => unbridge?.());

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function render(props: Partial<ChatTranscriptProps>) {
  host ??= document.createElement('div');
  document.body.appendChild(host);
  root ??= createRoot(host);
  act(() => root!.render(<ChatTranscript messages={[]} status="ready" agentName="Claude" {...props} />));
}

const say = (id: string, role: ChatMessage['role'], text: string): ChatMessage => ({
  id,
  role,
  parts: [{ type: 'text', text } as ChatMessage['parts'][number]],
});

/** Each element in a text part, in order, so a gap drawn as `<br>` shows where it sits. */
const shape = (id: string) =>
  [...document.querySelectorAll(`[data-text-part][data-message-id="${id}"] *`)].map((el) => el.tagName.toLowerCase());

describe.if(hasDom)('keepUserBlankLines', () => {
  test('keeps the person\'s blank lines and line breaks; absent, they fold as before', () => {
    const typed = 'Hello\n\n\n\nSecond\nline';
    const messages = [say('u', 'user', typed), say('a', 'assistant', typed)];
    const folded = ['p', 'p'];

    render({ messages });
    expect(shape('u')).toEqual(folded);
    expect(shape('a')).toEqual(folded);

    render({ messages, keepUserBlankLines: true });
    expect(shape('u')).toEqual(['p', 'br', 'br', 'p', 'br']);
    expect(document.querySelector('[data-message-id="u"]')!.textContent!.replace(/\s/g, '')).toBe('HelloSecondline');
    expect(shape('a')).toEqual(folded);
  });
});
