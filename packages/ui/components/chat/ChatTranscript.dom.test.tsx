/**
 * The transcript: draws what it is given, holds the answer's place while the
 * reply has nothing to show, and never lets model text into the DOM unwashed.
 * Requires DOM (DOM_TESTS=1).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ChatMessage, ChatTranscriptProps } from './ChatTranscript';

const hasDom = typeof document !== 'undefined';
const transcriptModule = hasDom ? await import('./ChatTranscript') : null;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const realMatchMedia = hasDom ? window.matchMedia : undefined;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  if (hasDom) window.matchMedia = realMatchMedia!;
});

const say = (id: string, role: ChatMessage['role'], text: string, state?: 'streaming' | 'done'): ChatMessage => ({
  id,
  role,
  parts: [{ type: 'text', text, state } as ChatMessage['parts'][number]],
});

function render(props: Partial<ChatTranscriptProps>) {
  const { ChatTranscript } = transcriptModule!;
  host ??= document.createElement('div');
  document.body.appendChild(host);
  root ??= createRoot(host);
  act(() => root!.render(<ChatTranscript messages={[]} status="ready" agentName="Claude" {...props} />));
  return host;
}

const pendingRow = () => document.querySelector('[data-chat-pending]');
const roles = () =>
  [...document.querySelectorAll(':scope [data-message-role]')]
    .filter((el) => !el.hasAttribute('data-text-part'))
    .map((el) => el.getAttribute('data-message-role'));

describe.if(hasDom)('messages and status are props', () => {
  test('draws both sides with the names and marks it is given', () => {
    const view = render({
      messages: [say('1', 'user', 'Why?'), say('2', 'assistant', 'Because.')],
      agentName: 'Codex',
      agentMark: <svg data-agent-mark />,
      userName: 'Ana',
      userMark: <span data-user-mark />,
    });
    expect(view.textContent).toContain('Ana');
    expect(view.textContent).toContain('Codex');
    expect(view.textContent).toContain('Why?');
    expect(view.textContent).toContain('Because.');
    const [user, agent] = [...view.querySelectorAll('[data-message-role]')].filter(
      (el) => !el.hasAttribute('data-text-part'),
    );
    expect(user!.querySelector('[data-user-mark]')).not.toBeNull();
    expect(agent!.querySelector('[data-agent-mark]')).not.toBeNull();
    expect(agent!.querySelector('[data-user-mark]')).toBeNull();
  });

  test('no messages shows the empty slot and no pending row while idle', () => {
    const view = render({ empty: <p data-empty>Ask anything</p> });
    expect(view.querySelector('[data-empty]')).not.toBeNull();
    expect(pendingRow()).toBeNull();
  });

  test('messages replace the empty slot', () => {
    const view = render({ empty: <p data-empty />, messages: [say('1', 'user', 'Hi')] });
    expect(view.querySelector('[data-empty]')).toBeNull();
  });

  test('new props redraw: the transcript holds no copy of its own', () => {
    render({ messages: [say('1', 'assistant', 'One')] });
    const view = render({ messages: [say('1', 'assistant', 'Two')] });
    expect(view.textContent).toContain('Two');
    expect(view.textContent).not.toContain('One');
  });

  test('a system message is not drawn as anyone\'s turn', () => {
    render({ messages: [say('0', 'system', 'hidden'), say('1', 'user', 'Hi')] });
    expect(roles()).toEqual(['user']);
  });
});

describe.if(hasDom)('holding the answer\'s place', () => {
  test('from the send until the first part, whichever status it is in', () => {
    const asked = [say('1', 'user', 'Why?')];
    render({ messages: asked, status: 'submitted' });
    expect(pendingRow()).not.toBeNull();
    expect(pendingRow()!.textContent).toContain('Claude');

    // The stream has started and pushed an empty assistant message.
    render({ messages: [...asked, { id: '2', role: 'assistant', parts: [] }], status: 'submitted' });
    expect(pendingRow()).not.toBeNull();
    expect(roles()).toEqual(['user', 'assistant']);

    // Parts that paint nothing keep it up.
    render({
      messages: [...asked, { id: '2', role: 'assistant', parts: [{ type: 'step-start' }, say('', 'assistant', '').parts[0]!] }],
      status: 'streaming',
    });
    expect(pendingRow()).not.toBeNull();
  });

  test('the first text retires it, and so does a part that is not text', () => {
    const asked = [say('1', 'user', 'Why?')];
    render({ messages: [...asked, say('2', 'assistant', 'B', 'streaming')], status: 'streaming' });
    expect(pendingRow()).toBeNull();

    render({ messages: [...asked, { id: '2', role: 'assistant', parts: [{ type: 'tool-read' }] }], status: 'streaming' });
    expect(pendingRow()).toBeNull();
  });

  test('a finished or failed run shows no pending row', () => {
    const asked = [say('1', 'user', 'Why?')];
    render({ messages: asked, status: 'ready' });
    expect(pendingRow()).toBeNull();
    render({ messages: asked, status: 'error' });
    expect(pendingRow()).toBeNull();
  });

  test('a host can hide it or word it', () => {
    const asked = [say('1', 'user', 'Why?')];
    render({ messages: asked, status: 'submitted', pending: false });
    expect(pendingRow()).toBeNull();
    render({ messages: asked, status: 'submitted', pending: 'Working' });
    expect(pendingRow()!.textContent).toContain('Working');
  });
});

describe.if(hasDom)('a person\'s words', () => {
  test('HTML they typed reaches the page as the text they typed', () => {
    const view = render({ messages: [say('1', 'user', 'See <b>this</b>')] });
    expect(view.querySelector('b')).toBeNull();
    expect(view.textContent).toContain('<b>this</b>');
  });
});

describe.if(hasDom)('reduced motion', () => {
  const reduced = () => {
    window.matchMedia = ((query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener() {},
      removeEventListener() {},
    })) as unknown as typeof window.matchMedia;
  };

  test('a streaming turn paints whole sentences; a finished one paints in full', () => {
    reduced();
    const part = 'First sentence. Second sent';
    const view = render({ messages: [say('1', 'assistant', part, 'streaming')], status: 'streaming' });
    expect(view.textContent).toContain('First sentence.');
    expect(view.textContent).not.toContain('Second sent');

    render({ messages: [say('1', 'assistant', part, 'done')] });
    expect(view.textContent).toContain('Second sent');
  });
});

describe.if(hasDom)('following the output', () => {
  function metrics(pane: HTMLElement, scrollHeight: number, clientHeight: number) {
    Object.defineProperty(pane, 'scrollHeight', { configurable: true, value: scrollHeight });
    Object.defineProperty(pane, 'clientHeight', { configurable: true, value: clientHeight });
  }

  test('sticks to the live edge, and lets go once the person scrolls away', () => {
    render({ messages: [say('1', 'assistant', 'One')], label: 'Chat' });
    const pane = document.querySelector<HTMLElement>('[aria-label="Chat"]')!;
    metrics(pane, 1000, 200);
    render({ messages: [say('1', 'assistant', 'One two')], label: 'Chat' });
    expect(pane.scrollTop).toBe(1000);

    pane.scrollTop = 100;
    act(() => {
      pane.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    render({ messages: [say('1', 'assistant', 'One two three')], label: 'Chat' });
    expect(pane.scrollTop).toBe(100);

    pane.scrollTop = 800;
    act(() => {
      pane.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    render({ messages: [say('1', 'assistant', 'One two three four')], label: 'Chat' });
    expect(pane.scrollTop).toBe(1000);
  });

  test('is no live region, so a stream is not read out token by token', () => {
    render({ messages: [say('1', 'assistant', 'One')], label: 'Chat' });
    const pane = document.querySelector<HTMLElement>('[aria-label="Chat"]')!;
    expect(pane.hasAttribute('aria-live')).toBe(false);
    expect(pane.getAttribute('role')).toBe('region');
    expect(pane.tabIndex).toBe(0);
  });

  test('with tabs in the header it is the matching tabpanel', () => {
    render({ panel: { id: 'p1', labelledBy: 't1' } });
    const pane = document.getElementById('p1')!;
    expect(pane.getAttribute('role')).toBe('tabpanel');
    expect(pane.getAttribute('aria-labelledby')).toBe('t1');
  });
});

describe.if(hasDom)('what a host can add', () => {
  test('renderPart draws parts; undefined falls through to text; unknown parts draw nothing', () => {
    const view = render({
      messages: [
        {
          id: '1',
          role: 'assistant',
          parts: [
            { type: 'tool-read' },
            { type: 'tool-mystery' },
            say('', 'assistant', 'Words').parts[0]!,
          ],
        },
      ],
      renderPart: (part) => (part.type === 'tool-read' ? <em data-tool>Read a file</em> : undefined),
    });
    expect(view.querySelector('[data-tool]')).not.toBeNull();
    expect(view.textContent).toContain('Words');
    expect(view.textContent).not.toContain('mystery');
  });

  test('renderMessage draws a whole row between messages; null draws nothing', () => {
    const view = render({
      messages: [say('1', 'user', 'Hi'), say('fold', 'system', ''), say('3', 'assistant', 'skip me')],
      renderMessage: (message) => {
        if (message.role === 'system') return <hr data-fold />;
        return message.id === '3' ? null : undefined;
      },
    });
    expect(view.querySelector('[data-fold]')).not.toBeNull();
    expect(view.textContent).not.toContain('skip me');
    expect(view.textContent).toContain('Hi');
  });

  test('a stopped turn says so, and a footer sits under its parts', () => {
    const view = render({
      messages: [say('1', 'assistant', 'Half an')],
      stopped: new Set(['1']),
      messageFooter: (message) => <p data-foot>{message.id}</p>,
    });
    expect(view.textContent).toContain('Stopped');
    expect(view.querySelector('[data-foot]')?.textContent).toBe('1');
  });

  test('statusLine is announced once as a status', () => {
    const view = render({ messages: [say('1', 'user', 'Hi')], statusLine: 'Reading a file' });
    expect(view.querySelector('[role="status"]')?.textContent).toBe('Reading a file');
  });

  test('a text part tells a host which message and part it is', () => {
    const view = render({ messages: [say('m1', 'assistant', 'Words')] });
    const part = view.querySelector<HTMLElement>('[data-text-part]')!;
    expect(part.dataset.messageId).toBe('m1');
    expect(part.dataset.partIndex).toBe('0');
    expect(part.dataset.messageRole).toBe('assistant');
  });

  test('the host\'s scrollRef is the pane, and its overlay rides inside it', () => {
    const ref = React.createRef<HTMLDivElement>();
    render({ scrollRef: ref, overlay: <div data-overlay /> });
    expect(ref.current?.querySelector('[data-overlay]')).not.toBeNull();
  });
});

describe('sentence clipping', () => {
  test('stops at the last finished sentence or line', () => {
    const clip = async () => (await import('./ChatTranscript')).clipAtSentenceBoundary;
    return clip().then((clipAtSentenceBoundary) => {
      expect(clipAtSentenceBoundary('No boundary yet')).toBe('');
      expect(clipAtSentenceBoundary('One. Two')).toBe('One.');
      expect(clipAtSentenceBoundary('One? Two! Three')).toBe('One? Two!');
      expect(clipAtSentenceBoundary('Line\nnext')).toBe('Line\n');
      expect(clipAtSentenceBoundary('v1.2 is out')).toBe('');
    });
  });
});
