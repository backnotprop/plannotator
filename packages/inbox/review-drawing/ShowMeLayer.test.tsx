/**
 * Show me's parts over the code review (approval "shape-in-code-review", mock
 * ac2). What regresses if these fail:
 * - a part of the picture no longer opens its code (the click-to-code that is
 *   the point of the picture), or the corner card loses which part was opened;
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
import type { InboxReviewDrawing } from '@plannotator/core/inbox-review';
import type { ShapeCodeTarget } from '@plannotator/core/shape';
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

const DRAWING: InboxReviewDrawing = {
  id: 'drw_1',
  turn: 'ask_1',
  file: 'src/retry-worker.ts',
  lines: [16, 18],
  round: 1,
  title: 'How a failed job comes back',
  view: { html: '<div data-mark="pick" data-code="src/retry-worker.ts#L16-L18"><b>Pick the next job</b> from the queue</div><div data-mark="wait">Wait</div>' },
  at: '2026-11-04T00:00:00.000Z',
};

function state(over: Partial<ShowMeState>): ShowMeState {
  return { canAsk: true, box: null, shown: null, drawing: false, answerOnly: null, problem: null, posting: false, ...over };
}

const board = (el: HTMLElement) => el.querySelector('.shp-drawn-host')!.shadowRoot!.querySelector('.board') as HTMLElement;

describe.skipIf(!hasDom)('Show me over the code review', () => {
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

  test("this round's picture has Show me again in its footer; an earlier round's has it in its banner only", () => {
    let again = 0;
    const sheet = (asked: boolean) => (
      <layer.ShowMeSheet
        drawing={DRAWING}
        answer="The retry waits, then puts the job back."
        agent="Claude Code"
        host="claude-code"
        asked={asked ? { stale: new Set<string>(), onAgain: () => void again++ } : null}
        onAgain={() => void (again += 10)}
        onCode={() => {}}
        onShrink={() => {}}
        onClose={() => {}}
      />
    );
    const el = mount(sheet(false));
    expect(el.querySelectorAll('[data-show-me-again]').length).toBe(1);
    expect(el.querySelector('[data-show-me-asked]')).toBeNull();
    act(() => el.querySelector<HTMLButtonElement>('.ib-sm-sheet-f [data-show-me-again]')!.click());
    expect(again).toBe(10);
    act(() => root!.render(sheet(true)));
    expect(el.querySelectorAll('[data-show-me-again]').length).toBe(1);
    act(() => el.querySelector<HTMLButtonElement>('[data-show-me-asked] [data-show-me-again]')!.click());
    expect(again).toBe(11);
  });

  test("a part of the picture opens its code, and the corner card names the part it opened", () => {
    const opened: { target: ShapeCodeTarget; mark: string | null }[] = [];
    const el = mount(
      <layer.ShowMeSheet
        drawing={DRAWING}
        answer="The retry waits, then puts the job back."
        agent="Claude Code"
        host="claude-code"
        onCode={(target, part) => opened.push({ target, mark: part.closest('[data-mark]')?.getAttribute('data-mark') ?? null })}
        onShrink={() => {}}
        onClose={() => {}}
      />,
    );
    expect(el.textContent).toContain('Claude Code · Show me on retry-worker.ts lines 16–18 · round 1');
    act(() => board(el).querySelector<HTMLElement>('[data-code]')!.click());
    expect(opened).toEqual([{ target: { path: 'src/retry-worker.ts', line: 16, lineEnd: 18 }, mark: 'pick' }]);

    act(() =>
      root!.render(
        <layer.ShowMeCorner drawing={DRAWING} part={{ name: 'Pick the next job', mark: 'pick', file: 'src/retry-worker.ts', lines: [16, 18] }} onGrow={() => {}} onClose={() => {}} />,
      ),
    );
    expect(el.querySelector('.ib-sm-pip-f')!.textContent).toBe('Pick the next job · retry-worker.ts lines 16–18');
    // The opened part stays ringed in the small picture.
    expect(board(el).querySelector('[data-mark="pick"]')!.classList.contains('noted')).toBe(true);
  });

  test("the Overview's picture hides, and in round 2 its changed parts carry the tag", () => {
    const el = mount(
      <figure.OverviewFigure drawn={DRAWING.view} meta="redrawn by Claude Code for round 2 · 1 part changed" changed={new Set(['wait'])} onCode={() => {}} />,
    );
    expect(board(el).querySelector('[data-mark="wait"]')!.getAttribute('data-shp-tag')).toBe('changed');
    expect(board(el).querySelector('[data-mark="pick"]')!.hasAttribute('data-shp-tag')).toBe(false);
    act(() => el.querySelector<HTMLButtonElement>('.ib-ov-fig-h button')!.click());
    expect(el.querySelector('.shp-drawn-host')).toBeNull();
    expect(el.querySelector('[data-overview-figure]')!.getAttribute('data-overview-figure')).toBe('hidden');
  });
});
