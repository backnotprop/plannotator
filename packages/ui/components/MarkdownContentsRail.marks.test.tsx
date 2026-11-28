/**
 * The contents rail's annotation marks (owner-approved 2026-11, "dots beside
 * each heading's tick"), on a page: without `annotations` and
 * `onSelectAnnotation` the rail's DOM is today's; with them each tick's row
 * has its section's dots, by kind; a click or Enter selects through the host;
 * the roving order is tick, its dots, the next tick; each dot is named by its
 * kind, quote and comment; hovering or focusing one shows its card; Escape
 * closes as for a tick. The arithmetic is utils/contentsRailMarks.test.ts.
 *
 * DOM-gated (DOM_TESTS=1).
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { AnnotationType, type Annotation } from '../types';

const hasDom = typeof document !== 'undefined';
const { MarkdownContentsRail, buildMarkdownContentsModel } = (hasDom
  ? await import('./MarkdownContentsRail')
  : {}) as typeof import('./MarkdownContentsRail');

const MARKDOWN = `# Overview

Opening context.

## Planning

Planning details.

### Risks

Risk details.

## Review

Review details.

#### Evidence

Evidence details.
`;

/** Today's closed rail for MARKDOWN at the top (origin/main before the marks), attributes in order. */
const TODAYS_CLOSED_RAIL =
  '<nav class="pn-contents-rail" aria-label="Document contents" style="left: 620px; top: 300px; --pn-contents-dock-width: 36px; --pn-contents-panel-gap: 6px; --pn-contents-panel-width: 256px;"><div class="pn-contents-rail-dock" aria-hidden="true"></div><div class="pn-contents-rail-surface" aria-hidden="true"></div><div class="pn-contents-rail-title" aria-hidden="true">Contents</div><div class="pn-contents-rail-list" role="list"><button type="button" class="pn-contents-rail-marker" data-contents-index="0" data-current="" data-level="1" data-depth="0" aria-label="Open document contents at Overview" aria-expanded="false" aria-current="location" tabindex="0"><span class="pn-contents-rail-tick" aria-hidden="true"><span class="pn-contents-rail-line"></span></span><span class="pn-contents-rail-label" aria-hidden="true">Overview</span></button><button type="button" class="pn-contents-rail-marker" data-contents-index="1" data-level="2" data-depth="1" aria-label="Open document contents at Overview / Planning" aria-expanded="false" tabindex="-1"><span class="pn-contents-rail-tick" aria-hidden="true"><span class="pn-contents-rail-line"></span></span><span class="pn-contents-rail-label" aria-hidden="true">Planning</span></button><button type="button" class="pn-contents-rail-marker" data-contents-index="2" data-level="3" data-depth="2" aria-label="Open document contents at Overview / Planning / Risks" aria-expanded="false" tabindex="-1"><span class="pn-contents-rail-tick" aria-hidden="true"><span class="pn-contents-rail-line"></span></span><span class="pn-contents-rail-label" aria-hidden="true">Risks</span></button><button type="button" class="pn-contents-rail-marker" data-contents-index="3" data-level="2" data-depth="1" aria-label="Open document contents at Overview / Review" aria-expanded="false" tabindex="-1"><span class="pn-contents-rail-tick" aria-hidden="true"><span class="pn-contents-rail-line"></span></span><span class="pn-contents-rail-label" aria-hidden="true">Review</span></button><button type="button" class="pn-contents-rail-marker" data-contents-index="4" data-level="4" data-depth="3" aria-label="Open document contents at Overview / Review / Evidence" aria-expanded="false" tabindex="-1"><span class="pn-contents-rail-tick" aria-hidden="true"><span class="pn-contents-rail-line"></span></span><span class="pn-contents-rail-label" aria-hidden="true">Evidence</span></button></div></nav>';

/** The same, opened by a click on its first tick. */
const TODAYS_OPEN_RAIL =
  '<nav class="pn-contents-rail" aria-label="Document contents" style="left: 620px; top: 300px; --pn-contents-dock-width: 36px; --pn-contents-panel-gap: 6px; --pn-contents-panel-width: 256px;" data-revealed=""><div class="pn-contents-rail-dock" aria-hidden="true"></div><div class="pn-contents-rail-surface" aria-hidden="true"></div><div class="pn-contents-rail-title" aria-hidden="true">Contents</div><div class="pn-contents-rail-list" role="list"><button type="button" class="pn-contents-rail-marker" data-contents-index="0" data-current="" data-level="1" data-depth="0" aria-label="Go to Overview" aria-expanded="true" aria-current="location" tabindex="0" data-highlighted=""><span class="pn-contents-rail-tick" aria-hidden="true"><span class="pn-contents-rail-line"></span></span><span class="pn-contents-rail-label" aria-hidden="true">Overview</span></button><button type="button" class="pn-contents-rail-marker" data-contents-index="1" data-level="2" data-depth="1" aria-label="Go to Overview / Planning" aria-expanded="true" tabindex="-1"><span class="pn-contents-rail-tick" aria-hidden="true"><span class="pn-contents-rail-line"></span></span><span class="pn-contents-rail-label" aria-hidden="true">Planning</span></button><button type="button" class="pn-contents-rail-marker" data-contents-index="2" data-level="3" data-depth="2" aria-label="Go to Overview / Planning / Risks" aria-expanded="true" tabindex="-1"><span class="pn-contents-rail-tick" aria-hidden="true"><span class="pn-contents-rail-line"></span></span><span class="pn-contents-rail-label" aria-hidden="true">Risks</span></button><button type="button" class="pn-contents-rail-marker" data-contents-index="3" data-level="2" data-depth="1" aria-label="Go to Overview / Review" aria-expanded="true" tabindex="-1"><span class="pn-contents-rail-tick" aria-hidden="true"><span class="pn-contents-rail-line"></span></span><span class="pn-contents-rail-label" aria-hidden="true">Review</span></button><button type="button" class="pn-contents-rail-marker" data-contents-index="4" data-level="4" data-depth="3" aria-label="Go to Overview / Review / Evidence" aria-expanded="true" tabindex="-1"><span class="pn-contents-rail-tick" aria-hidden="true"><span class="pn-contents-rail-line"></span></span><span class="pn-contents-rail-label" aria-hidden="true">Evidence</span></button></div></nav>';

const note = (id: string, type: AnnotationType, originalText: string, text: string, extra: Partial<Annotation> = {}): Annotation => ({
  id,
  blockId: '',
  startOffset: 0,
  endOffset: 0,
  type,
  text,
  originalText,
  createdA: Date.now() - 120_000,
  ...extra,
});

/** The page's highlights: which section (heading index) each annotation's mark is drawn in. */
const ANNOTATIONS: Annotation[] = [
  note('c1', AnnotationType.COMMENT, 'Four workers to start', 'Four is a guess. Size it from the peak retry rate.', { author: 'Ada' }),
  note('d1', AnnotationType.DELETION, 'the old cron job', ''),
  note('g1', AnnotationType.GLOBAL_COMMENT, '', 'Looks right overall.'),
  note('c2', AnnotationType.COMMENT, 'risk one', 'First risk.'),
  note('c3', AnnotationType.COMMENT, 'risk two', 'Second risk.'),
  note('c4', AnnotationType.COMMENT, 'risk three', 'Third risk.'),
  note('c5', AnnotationType.COMMENT, 'risk four', 'Fourth risk.'),
];
const SECTION_OF: Record<string, number> = { c1: 1, d1: 1, c2: 2, c3: 2, c4: 2, c5: 2 };

interface Fixture {
  readonly root: Root;
  readonly viewport: HTMLElement;
  readonly render: (props?: Partial<import('./MarkdownContentsRail').MarkdownContentsRailProps>) => void;
}

function mountRail(): Fixture {
  window.matchMedia = ((query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
  const frame = document.createElement('div');
  const viewport = document.createElement('div');
  const content = document.createElement('div');
  const mount = document.createElement('div');
  content.dataset.documentReadContent = '';
  frame.append(viewport, mount);
  viewport.append(content);
  document.body.append(frame);
  viewport.getBoundingClientRect = () => new DOMRect(320, 0, 800, 600);
  content.getBoundingClientRect = () => new DOMRect(320, 0, 538, 1200);
  Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 600 });
  Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 1200 });
  Object.defineProperty(viewport, 'scrollTo', { configurable: true, value: mock(() => {}) });
  buildMarkdownContentsModel(MARKDOWN).forEach((item, index) => {
    const heading = document.createElement(`h${item.level}`);
    heading.dataset.blockType = 'heading';
    heading.dataset.blockId = item.blockId;
    heading.textContent = item.label;
    heading.getBoundingClientRect = () => new DOMRect(80, 40 + index * 220 - viewport.scrollTop, 500, 32);
    content.append(heading);
    const paragraph = document.createElement('p');
    for (const annotation of ANNOTATIONS) {
      if (SECTION_OF[annotation.id] !== index) continue;
      const mark = document.createElement('mark');
      mark.className = 'annotation-highlight';
      // The highlighter's marks carry data-highlight-id; manual ones data-bind-id.
      if (annotation.id === 'd1') mark.dataset.bindId = annotation.id;
      else mark.dataset.highlightId = annotation.id;
      mark.textContent = annotation.originalText;
      paragraph.append(mark, ' ');
    }
    content.append(paragraph);
  });
  const root = createRoot(mount);
  const render = (props: Partial<import('./MarkdownContentsRail').MarkdownContentsRailProps> = {}) =>
    act(() => root.render(<MarkdownContentsRail markdown={MARKDOWN} scrollViewport={viewport} {...props} />));
  return { root, viewport, render };
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
}

const nav = () => document.querySelector<HTMLElement>('nav[aria-label="Document contents"]');
const ticks = () => [...document.querySelectorAll<HTMLButtonElement>('[data-contents-index]')];
const marks = (row?: number) =>
  [...document.querySelectorAll<HTMLButtonElement>(`.pn-contents-rail-mark${row === undefined ? '' : `[data-row="${row}"]`}`)];
const more = (row: number) => document.querySelector<HTMLButtonElement>(`.pn-contents-rail-more[data-row="${row}"]`);
const card = () => document.querySelector<HTMLElement>('.pn-contents-rail-card');
const key = (target: EventTarget, init: KeyboardEventInit) =>
  act(() => void target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })));

const realRaf = hasDom ? globalThis.requestAnimationFrame : undefined;
const realCaf = hasDom ? globalThis.cancelAnimationFrame : undefined;
const realMatchMedia = hasDom ? window.matchMedia : undefined;

beforeAll(() => {
  if (!hasDom) return;
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(performance.now()), 0)) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((handle: number) => window.clearTimeout(handle)) as typeof cancelAnimationFrame;
});

afterAll(() => {
  if (!hasDom) return;
  globalThis.requestAnimationFrame = realRaf!;
  globalThis.cancelAnimationFrame = realCaf!;
  window.matchMedia = realMatchMedia!;
});

beforeEach(() => {
  if (hasDom) document.body.innerHTML = '';
});

afterEach(() => {
  if (hasDom) document.body.innerHTML = '';
});

describe.if(hasDom)('contents rail annotation marks', () => {
  test('without annotations and a select handler the rail is today’s, closed and open', async () => {
    const fixture = mountRail();
    fixture.render();
    await settle();
    expect(nav()!.outerHTML).toBe(TODAYS_CLOSED_RAIL);
    act(() => ticks()[0]!.click());
    expect(nav()!.outerHTML).toBe(TODAYS_OPEN_RAIL);
    act(() => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));

    // Annotations without a handler, a handler without annotations, a handler with none placed: no marks.
    const unplaced = ANNOTATIONS.filter((annotation) => annotation.type !== AnnotationType.GLOBAL_COMMENT).map((annotation) => ({
      ...annotation,
      id: `elsewhere-${annotation.id}`,
    }));
    for (const props of [
      { annotations: ANNOTATIONS },
      { annotations: [], onSelectAnnotation: () => {} },
      { annotations: unplaced, onSelectAnnotation: () => {}, selectedAnnotationId: 'elsewhere-c1' },
    ]) {
      fixture.render(props);
      await settle();
      expect(nav()!.outerHTML).toBe(TODAYS_CLOSED_RAIL);
      act(() => ticks()[0]!.click());
      expect(nav()!.outerHTML).toBe(TODAYS_OPEN_RAIL);
      act(() => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    }
    act(() => fixture.root.unmount());
  });

  test('each row has its section’s dots by kind; the closed rail shows three, then two and a “more”', async () => {
    const fixture = mountRail();
    fixture.render({ annotations: ANNOTATIONS, onSelectAnnotation: () => {} });
    await settle();
    // Ticks stay adjacent siblings in the list; the dots are in their own layer.
    expect(document.querySelectorAll('.pn-contents-rail-list > .pn-contents-rail-mark')).toHaveLength(0);
    expect(document.querySelector('.pn-contents-rail-marks')).not.toBeNull();
    expect(marks(0).map((mark) => [mark.dataset.markId, mark.dataset.kind])).toEqual([['g1', 'global']]);
    expect(marks(1).map((mark) => [mark.dataset.markId, mark.dataset.kind])).toEqual([
      ['c1', 'comment'],
      ['d1', 'deletion'],
    ]);
    expect(marks(2).map((mark) => mark.dataset.markId)).toEqual(['c2', 'c3']);
    expect(more(2)!.getAttribute('aria-label')).toBe('2 more annotations in Risks');
    expect(marks(3)).toHaveLength(0);
    // Beside the tick's line, on its row: 5 px slots each (the rest of the row is the tick's).
    // (Their inline placement is logical, which this DOM does not keep; the built page's pictures show it.)
    expect(marks(1).map((mark) => [mark.style.top, mark.style.width])).toEqual([
      ['16px', '5px'],
      ['16px', '5px'],
    ]);
    // A row with marks says so to its tick (its grown line stops before them); one without does not.
    expect(ticks().map((tick) => tick.dataset.marks)).toEqual(['', '', '', undefined, undefined]);

    // Open: the row's dots at its end, seven at most; the label makes room for them.
    act(() => ticks()[0]!.click());
    expect(document.querySelectorAll('.pn-contents-rail-list > .pn-contents-rail-mark')).toHaveLength(7);
    expect(marks(2).map((mark) => mark.dataset.markId)).toEqual(['c2', 'c3', 'c4', 'c5']);
    expect(more(2)).toBeNull();
    const riskLabel = ticks()[2]!.querySelector<HTMLElement>('.pn-contents-rail-label')!;
    expect(riskLabel.style.paddingInlineEnd).toBe(`${4 + 4 * 8 + 6}px`);
    act(() => fixture.root.unmount());
  });

  test('a click or Enter on a dot selects its annotation through the host; the selected dot is marked', async () => {
    const fixture = mountRail();
    const select = mock((_id: string) => {});
    fixture.render({ annotations: ANNOTATIONS, onSelectAnnotation: select, selectedAnnotationId: 'c1' });
    await settle();
    expect(marks(1).map((mark) => mark.dataset.selected)).toEqual(['', undefined]);
    expect(marks(1).map((mark) => mark.getAttribute('aria-current'))).toEqual(['true', null]);
    act(() => marks(1)[1]!.click());
    expect(select).toHaveBeenLastCalledWith('d1');
    // A dot never opens the panel.
    expect(nav()!.dataset.revealed).toBeUndefined();
    // Enter is the button's own click.
    act(() => marks(0)[0]!.focus());
    act(() => marks(0)[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 })));
    expect(select).toHaveBeenLastCalledWith('g1');
    // The closed row's "more" opens the panel at its row.
    act(() => more(2)!.click());
    expect(nav()!.dataset.revealed).toBe('');
    expect(ticks()[2]!.dataset.highlighted).toBe('');
    act(() => fixture.root.unmount());
  });

  test('the roving order is a tick, its dots, then the next tick; each dot is named by kind, quote and comment', async () => {
    const fixture = mountRail();
    fixture.render({ annotations: ANNOTATIONS, onSelectAnnotation: () => {} });
    await settle();
    act(() => ticks()[0]!.focus());
    const order: string[] = [];
    for (let step = 0; step < 9; step++) {
      const focused = document.activeElement as HTMLElement;
      order.push(focused.getAttribute('aria-label') ?? '');
      key(focused, { key: 'ArrowDown' });
    }
    expect(order).toEqual([
      'Open document contents at Overview',
      'Global: Looks right overall.',
      'Open document contents at Overview / Planning',
      'Comment, "Four workers to start": Four is a guess…',
      'Deletion, "the old cron job"',
      'Open document contents at Overview / Planning / Risks',
      'Comment, "risk one": First risk.',
      'Comment, "risk two": Second risk.',
      '2 more annotations in Risks',
    ]);
    key(document.activeElement!, { key: 'Home' });
    expect(document.activeElement).toBe(ticks()[0]!);
    key(document.activeElement!, { key: 'End' });
    expect(document.activeElement).toBe(ticks()[4]!);
    key(document.activeElement!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(ticks()[3]!);
    key(document.activeElement!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(more(2));
    // Only the current tick is a tab stop, as before.
    expect([...nav()!.querySelectorAll('[tabindex="0"]')]).toEqual([ticks()[0]!]);
    act(() => fixture.root.unmount());
  });

  test('hovering or focusing a dot shows its card; leaving hides it; Escape on a dot closes the panel', async () => {
    const fixture = mountRail();
    fixture.render({ annotations: ANNOTATIONS, onSelectAnnotation: () => {} });
    await settle();
    expect(card()).toBeNull();
    const c1 = marks(1)[0]!;
    act(() => void c1.dispatchEvent(new Event('pointerover', { bubbles: true })));
    expect(c1.dataset.highlighted).toBe('');
    const shown = card()!;
    expect(shown.getAttribute('role')).toBe('tooltip');
    // The dot's name already says what the card does: it is not read twice.
    expect(c1.hasAttribute('aria-describedby')).toBe(false);
    expect(shown.textContent).toContain('Comment');
    expect(shown.querySelector('[data-annotation-author]')!.textContent).toBe('Ada');
    expect(shown.querySelector('[data-annotation-time]')!.textContent).toBe('2m');
    expect(shown.querySelector('.font-mono')!.textContent).toBe('"Four workers to start"');
    expect(shown.querySelector('.pn-contents-rail-card-text')!.textContent).toBe('Four is a guess. Size it from the peak retry rate.');
    act(() => void c1.dispatchEvent(new Event('pointerout', { bubbles: true })));
    expect(card()).toBeNull();
    expect(c1.dataset.highlighted).toBeUndefined();

    // A deletion's card has its quote and no comment; a global's has its comment and no quote.
    act(() => marks(1)[1]!.focus());
    expect(card()!.textContent).toContain('Deletion');
    expect(card()!.querySelector('.font-mono')!.textContent).toBe('"the old cron job"');
    expect(card()!.querySelector('.pn-contents-rail-card-text')).toBeNull();
    act(() => marks(0)[0]!.focus());
    expect(card()!.textContent).toContain('Global');
    expect(card()!.querySelector('.font-mono')).toBeNull();

    // Open, a dot is in the panel's roving order; Escape on it closes the panel and leaves the rail.
    act(() => ticks()[0]!.click());
    act(() => marks(2)[3]!.focus());
    expect(ticks()[2]!.dataset.highlighted).toBe('');
    expect(card()!.textContent).toContain('Fourth risk.');
    key(document.activeElement!, { key: 'Escape' });
    expect(nav()!.dataset.revealed).toBeUndefined();
    expect(nav()!.contains(document.activeElement)).toBe(false);
    expect(card()).toBeNull();
    act(() => fixture.root.unmount());
  });

  test('a comment covered by a later one keeps its place and its dot', async () => {
    const fixture = mountRail();
    // B over words containing A: the highlighter labels the span B and moves A into data-highlight-id-extra.
    const covered = [
      note('a-inner', AnnotationType.COMMENT, 'retry', 'Inner.'),
      note('b-outer', AnnotationType.COMMENT, 'the retry rate', 'Outer.'),
      note('c-third', AnnotationType.COMMENT, 'retry', 'Third.'),
    ];
    const mark = document.createElement('mark');
    mark.dataset.highlightId = 'b-outer';
    mark.dataset.highlightIdExtra = 'a-inner;c-third';
    mark.textContent = 'the retry rate';
    fixture.viewport.querySelectorAll('p')[3]!.append(mark);
    fixture.render({ annotations: covered, onSelectAnnotation: () => {} });
    await settle();
    expect(marks(3).map((entry) => entry.dataset.markId)).toEqual(['b-outer', 'a-inner', 'c-third']);
    act(() => fixture.root.unmount());
  });

  test('a comment and its replies are one dot, the comment’s; a reply to a global comment adds none', async () => {
    const fixture = mountRail();
    const replies = Array.from({ length: 6 }, (_, index) =>
      note(`c1-r${index}`, AnnotationType.COMMENT, 'Four workers to start', `Reply ${index}.`, { inReplyTo: 'c1' }),
    );
    const threaded = [...ANNOTATIONS, ...replies, note('g1-r', AnnotationType.COMMENT, '', 'Agreed.', { inReplyTo: 'g1' })];
    const select = mock((_id: string) => {});
    fixture.render({ annotations: threaded, onSelectAnnotation: select, selectedAnnotationId: 'c1-r4' });
    await settle();
    expect(marks(0).map((mark) => mark.dataset.markId)).toEqual(['g1']);
    expect(marks(1).map((mark) => mark.dataset.markId)).toEqual(['c1', 'd1']);
    // A selected reply marks its thread's dot; the card is the root's.
    expect(marks(1)[0]!.getAttribute('aria-current')).toBe('true');
    act(() => void marks(1)[0]!.dispatchEvent(new Event('pointerover', { bubbles: true })));
    expect(card()!.querySelector('.pn-contents-rail-card-text')!.textContent).toBe('Four is a guess. Size it from the peak retry rate.');
    act(() => marks(1)[0]!.click());
    expect(select).toHaveBeenLastCalledWith('c1');
    act(() => ticks()[0]!.click());
    expect(marks(1).map((mark) => mark.dataset.markId)).toEqual(['c1', 'd1']);
    expect(marks(0).map((mark) => mark.dataset.markId)).toEqual(['g1']);
    act(() => fixture.root.unmount());
  });

  test('a dot focused in the closed rail leaves no card when a tick opens the panel', async () => {
    const fixture = mountRail();
    fixture.render({ annotations: ANNOTATIONS, onSelectAnnotation: () => {} });
    await settle();
    act(() => marks(1)[0]!.focus());
    expect(card()).not.toBeNull();
    // The tick's press keeps focus where it is; the panel opens and the dots move under the list.
    act(() => void ticks()[0]!.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true })));
    act(() => ticks()[0]!.click());
    await settle();
    expect(nav()!.dataset.revealed).toBe('');
    expect(card()).toBeNull();
    expect(marks().filter((mark) => mark.dataset.highlighted !== undefined)).toHaveLength(0);
    act(() => fixture.root.unmount());
  });

  test('Escape dismisses the closed rail’s hover card, and is left to the host when no card is up', async () => {
    const fixture = mountRail();
    fixture.render({ annotations: ANNOTATIONS, onSelectAnnotation: () => {} });
    await settle();
    const escape = () => {
      const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      act(() => void document.body.dispatchEvent(event));
      return event.defaultPrevented;
    };
    expect(escape()).toBe(false);
    act(() => void marks(1)[0]!.dispatchEvent(new Event('pointerover', { bubbles: true })));
    expect(card()).not.toBeNull();
    expect(escape()).toBe(true);
    expect(card()).toBeNull();
    expect(escape()).toBe(false);
    act(() => fixture.root.unmount());
  });

  test('open, a row’s “+N” is named as its tick, with the count; it goes to the heading', async () => {
    const fixture = mountRail();
    const many = Array.from({ length: 9 }, (_, index) => note(`m${index}`, AnnotationType.COMMENT, `risk ${index}`, `Risk ${index}.`));
    for (const annotation of many) {
      const mark = document.createElement('mark');
      mark.dataset.highlightId = annotation.id;
      fixture.viewport.querySelectorAll('p')[2]!.append(mark);
    }
    fixture.render({ annotations: many, onSelectAnnotation: () => {} });
    await settle();
    act(() => ticks()[0]!.click());
    const plus = more(2)!;
    expect(plus.textContent).toBe('+2');
    expect(plus.getAttribute('aria-label')).toBe('Go to Overview / Planning / Risks, 2 more annotations');
    act(() => plus.click());
    expect(ticks()[2]!.getAttribute('aria-current')).toBe('location');
    act(() => fixture.root.unmount());
  });

  test('a new highlight is placed again on the rail’s own triggers', async () => {
    const fixture = mountRail();
    fixture.render({ annotations: [...ANNOTATIONS, note('late', AnnotationType.COMMENT, 'late words', 'Late.')], onSelectAnnotation: () => {} });
    await settle();
    expect(marks().some((mark) => mark.dataset.markId === 'late')).toBe(false);
    const mark = document.createElement('mark');
    mark.dataset.highlightId = 'late';
    act(() => void fixture.viewport.querySelectorAll('p')[4]!.append(mark));
    await settle();
    expect(marks(4).map((entry) => entry.dataset.markId)).toEqual(['late']);
    act(() => fixture.root.unmount());
  });
});
