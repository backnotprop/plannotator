/**
 * Show me's parts over the code review (approval "code-review-launch-build",
 * item 1). What regresses if these fail:
 * - the corner card loses which part a click landed on, or the way back to the board;
 * - the box sends with no lines named, or keeps offering Show me while the
 *   agent draws (a second request on top of the first), or loses Stop;
 * - the Overview's picture cannot be hidden, or its changed parts lose their
 *   tag in round 2;
 * - the floating parts lose the marks that keep the Inbox's keys (Escape,
 *   Mod+Enter) from acting through them.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { bridgeSanitizerDom } from '../../../tests/helpers/chat-sanitizer-dom';
import type { ShowMeState } from './useShowMe';

const hasDom = typeof document !== 'undefined';
const layer = (hasDom ? await import('./ShowMeLayer') : {}) as typeof import('./ShowMeLayer');
const figure = (hasDom ? await import('./OverviewFigure') : {}) as typeof import('./OverviewFigure');

let root: Root | null = null;
let unbridge: (() => void) | null = null;
beforeAll(() => {
  if (hasDom) unbridge = bridgeSanitizerDom();
});
afterAll(() => unbridge?.());
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  if (hasDom) document.body.innerHTML = '';
});

function mount(node: React.ReactNode): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  act(() => root!.render(node));
  return el;
}

const PICTURE = { html: '<div data-mark="pick"><b>Pick the next job</b> from the queue</div><div data-mark="wait">Wait</div>' };

function state(over: Partial<ShowMeState>): ShowMeState {
  return { canAsk: true, box: null, drawing: false, queued: 0, answerOnly: null, problem: null, posting: false, ...over };
}

const board = (el: HTMLElement) => el.querySelector('.shp-drawn-host')!.shadowRoot!.querySelector('.board') as HTMLElement;

describe.skipIf(!hasDom)('Show me over the code review', () => {
  test('a Show me from a board waits on the board, names the part, says how many more wait, and the review\'s words stay', () => {
    const props = { agent: 'Claude Code', onWords: () => {}, onSend: () => {}, onStop: () => {}, onClose: () => {} };
    const part = { board: 'shp_a', name: 'The next attempt' };
    const el = mount(<layer.ShowMeBox state={state({ drawing: true, queued: 2, box: { place: { file: null, lines: null, part }, words: 'why', turn: 'ask_1' } })} {...props} />);
    expect(el.querySelector('[data-show-me-box]')!.hasAttribute('data-over-board')).toBe(true);
    expect(el.querySelector('[data-show-me-place]')!.textContent).toBe('The next attempt · then 2 more');
    expect(el.querySelector('[role="status"]')!.textContent).toContain('It opens here when it’s ready.');
    act(() => root!.render(<layer.ShowMeBox state={state({ drawing: true, box: { place: { file: null, lines: null }, words: '', turn: 'ask_1' } })} {...props} />));
    expect(el.querySelector('[data-show-me-box]')!.hasAttribute('data-over-board')).toBe(false);
    expect(el.querySelector('[role="status"]')!.textContent).toContain('It opens over the review when it’s ready.');
  });

  test('the box names the lines and sends; while drawn it offers Stop and no second Show me', () => {
    let sent = 0;
    let stopped = 0;
    const props = { agent: 'Claude Code', onWords: () => {}, onSend: () => void sent++, onStop: () => void stopped++, onClose: () => {} };
    const el = mount(<layer.ShowMeBox state={state({ box: { place: { file: 'src/retry-worker.ts', lines: [16, 18] }, words: '', turn: null } })} {...props} />);
    expect(el.querySelector('[data-show-me-place]')!.textContent).toBe('retry-worker.ts · lines 16–18');
    act(() => el.querySelector<HTMLButtonElement>('[data-show-me-send]')!.click());
    expect(sent).toBe(1);

    act(() => root!.render(<layer.ShowMeBox state={state({ drawing: true, box: { place: { file: 'src/retry-worker.ts', lines: [16, 18] }, words: 'the retry path', turn: 'ask_1' } })} {...props} />));
    expect(el.querySelector('[data-show-me-send]')).toBeNull();
    expect(el.querySelector('[role="status"]')!.textContent).toContain('Claude Code is drawing it.');
    act(() => el.querySelector<HTMLButtonElement>('[data-show-me-stop]')!.click());
    expect(stopped).toBe(1);
    // The Inbox's keys never act from inside it (shortcuts/guards.ts inOverlay, App.tsx's Escape ladder).
    expect(el.querySelector('[data-show-me-box]')!.matches('[data-popover-layer][data-chat-window]')).toBe(true);
  });

  test("a Show me the agent did not take is not drawing: busy offers the Ask window's choice, a refused one its problem", () => {
    const policies: string[] = [];
    const props = { agent: 'Claude Code', onWords: () => {}, onSend: () => {}, onBusy: (p: string) => void policies.push(p), onStop: () => {}, onClose: () => {} };
    const box = { place: { file: 'src/retry-worker.ts', lines: [16, 18] as [number, number] }, words: '', turn: 'ask_1' };
    const busy = { questionId: 'q', createdAt: 0, text: '', isStreaming: false, error: 'busy', errorCode: 'agent_busy' };
    const el = mount(<layer.ShowMeBox state={state({ box, busy })} {...props} />);
    expect(el.querySelector('[data-show-me-box]')!.getAttribute('data-show-me-box')).toBe('busy');
    expect(el.querySelector('[role="status"]')).toBeNull();
    expect(el.querySelector('[data-show-me-stop]')).toBeNull();
    expect(el.querySelector('[data-ask-note="busy"]')!.textContent).toContain('Claude Code is working on something else.');
    const choices = [...el.querySelectorAll<HTMLButtonElement>('[data-session-ask-actions="busy"] button')];
    expect(choices.map((b) => b.textContent)).toEqual(['Ask when it finishes', 'Interrupt and ask now']);
    act(() => choices[0]!.click());
    act(() => choices[1]!.click());
    expect(policies).toEqual(['wait', 'interrupt']);

    // Waiting on the busy agent: running, in the Ask window's words.
    act(() => root!.render(<layer.ShowMeBox state={state({ box, drawing: true, waiting: 'waiting' })} {...props} />));
    expect(el.querySelector('[role="status"]')!.textContent).toBe('Waiting for Claude Code to finish…');

    // Nobody took it: the box is ready to send again, with the problem.
    act(() => root!.render(<layer.ShowMeBox state={state({ box: { ...box, turn: null }, problem: 'No answer arrived.' })} {...props} />));
    expect(el.querySelector('[data-show-me-box]')!.getAttribute('data-show-me-box')).toBe('compose');
    expect(el.querySelector('[role="alert"]')!.textContent).toBe('No answer arrived.');
    expect(el.querySelector('[data-show-me-send]')).not.toBeNull();
  });

  test('the corner card names the part a click landed on, and grows the board back', () => {
    let grown = 0;
    let closed = 0;
    const el = mount(
      <layer.ShowMeCorner resolveSrc={(src: string) => src}
        shape="shp_1"
        title="How a failed job comes back"
        picture={PICTURE}
        part={{ name: 'Pick the next job', mark: 'pick', file: 'src/retry-worker.ts', lines: [16, 18] }}
        onGrow={() => void grown++}
        onClose={() => void closed++}
      />,
    );
    expect(el.querySelector('.ib-sm-pip-f')!.textContent).toBe('Pick the next job · retry-worker.ts lines 16–18');
    act(() => el.querySelector<HTMLElement>('[data-show-me-grow]')!.click());
    act(() => el.querySelector<HTMLButtonElement>('[aria-label="Grow the board"]')!.click());
    expect(grown).toBe(2);
    act(() => el.querySelector<HTMLButtonElement>('[aria-label="Close the board"]')!.click());
    expect(closed).toBe(1);
    expect(el.querySelector('[data-show-me-corner]')!.matches('[data-popover-layer][data-chat-window]')).toBe(true);
  });

  test("the Overview's picture hides, and in a later review its changed parts carry the tag", () => {
    const el = mount(
      <figure.OverviewFigure drawn={PICTURE} meta="redrawn by Claude Code · 1 part changed" changed={new Set(['wait'])} onCode={() => {}} />,
    );
    expect(board(el).querySelector('[data-mark="wait"]')!.getAttribute('data-shp-tag')).toBe('changed');
    expect(board(el).querySelector('[data-mark="pick"]')!.hasAttribute('data-shp-tag')).toBe(false);
    act(() => el.querySelector<HTMLButtonElement>('.ib-ov-fig-h button')!.click());
    expect(el.querySelector('.shp-drawn-host')).toBeNull();
    expect(el.querySelector('[data-overview-figure]')!.getAttribute('data-overview-figure')).toBe('hidden');
  });
});
