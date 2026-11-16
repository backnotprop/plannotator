/**
 * The card a host relies on: one link named by its title and grey line, the
 * unread dot, the fact or the date, a face that is inert and mounted only
 * near the screen, one sheet behind a document and none behind anything
 * else, the document face that skips a repeated title, and breathe only
 * while working. Requires DOM (DOM_TESTS=1).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const cardModule = hasDom ? await import('./Card') : null;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

class FakeObserver {
  static made: FakeObserver[] = [];
  target: Element | null = null;
  disconnected = false;
  constructor(
    readonly callback: (entries: { isIntersecting: boolean; target: Element }[]) => void,
    readonly options: { rootMargin?: string } = {},
  ) {
    FakeObserver.made.push(this);
  }
  observe(target: Element) {
    this.target = target;
  }
  unobserve() {}
  disconnect() {
    this.disconnected = true;
  }
  takeRecords() {
    return [];
  }
  enter() {
    this.callback([{ isIntersecting: true, target: this.target! }]);
  }
}

const realObserver = hasDom ? globalThis.IntersectionObserver : undefined;

beforeEach(() => {
  FakeObserver.made = [];
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = FakeObserver;
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = realObserver;
});

function mount(node: ReactNode) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
}

function nearScreen() {
  act(() => {
    for (const observer of FakeObserver.made) if (!observer.disconnected) observer.enter();
  });
}

const DOC = <p>Sessions live in signed cookies today.</p>;

describe.skipIf(!hasDom)('Card', () => {
  test('one link, named by the title and the fact, and "new" when unread', () => {
    const { Card } = cardModule!;
    const frame = mount(
      <Card kind="document" size="large" title="Move sessions to Redis" href="/plans/redis" fact="Your move" unread face={DOC} />,
    );
    const links = frame.querySelectorAll('a');
    nearScreen();
    expect(frame.querySelectorAll('a').length).toBe(1);
    expect(links[0]!.getAttribute('href')).toBe('/plans/redis');
    expect(links[0]!.getAttribute('aria-label')).toBe('Move sessions to Redis, Your move, new');
    const focusable = [...frame.querySelectorAll<HTMLElement>('a, button, input, [tabindex]')].filter(
      (element) => element.closest('[inert]') === null,
    );
    expect(focusable).toEqual([links[0]!]);
  });

  test('a link inside the face stays out of reach: the face is inert and hidden from assistive tech', () => {
    const { Card } = cardModule!;
    const frame = mount(
      <Card kind="page" size="regular" title="Checkout" href="/c" face={<a href="/inside">inside</a>} />,
    );
    nearScreen();
    const well = frame.querySelector('[data-frame-card-well]')!;
    expect(well.hasAttribute('inert')).toBe(true);
    expect(well.getAttribute('aria-hidden')).toBe('true');
    expect(well.querySelector('a[href="/inside"]')).not.toBeNull();
    expect(frame.querySelector('a[href="/inside"]')!.closest('[inert]')).toBe(well);
  });

  test('unread shows a small dot before the title, with no number; read shows none', () => {
    const { Card } = cardModule!;
    const frame = mount(
      <>
        <Card kind="document" size="regular" title="Unread plan" href="/a" unread />
        <Card kind="document" size="regular" title="Read plan" href="/b" />
      </>,
    );
    const [unread, read] = [...frame.querySelectorAll('[data-frame-card]')];
    const dot = unread!.querySelector('[data-frame-card-title] [data-frame-card-dot]')!;
    expect(dot.getAttribute('aria-hidden')).toBe('true');
    expect(dot.textContent).toBe('');
    expect(unread!.querySelector('[data-frame-card-title]')!.firstElementChild).toBe(dot);
    expect(read!.querySelector('[data-frame-card-dot]')).toBeNull();
  });

  test('the grey line is the fact with its mark; without a fact it is the date; the time is always in the title attribute', () => {
    const { Card, cardDateWords } = cardModule!;
    const at = '2026-11-15T10:00:00Z';
    const words = cardDateWords(new Date(at));
    const frame = mount(
      <>
        <Card kind="document" size="regular" title="With a fact" href="/a" fact="Codex is working" factMark={<svg />} time={at} />
        <Card kind="document" size="regular" title="With a date" href="/b" time={new Date(at)} />
        <Card kind="document" size="regular" title="With nothing" href="/c" />
      </>,
    );
    const [withFact, withDate, bare] = [...frame.querySelectorAll('[data-frame-card]')];
    const factLine = withFact!.querySelector('[data-frame-card-line]')!;
    expect(factLine.textContent).toBe('Codex is working');
    expect(factLine.querySelector('[data-frame-card-mark] svg')).not.toBeNull();
    expect(factLine.querySelector('time')).toBeNull();
    expect(factLine.getAttribute('title')).toBeTruthy();
    const dateLine = withDate!.querySelector('[data-frame-card-line]')!;
    expect(dateLine.textContent).toBe(words);
    expect(dateLine.querySelector('time')!.getAttribute('dateTime')).toBe(new Date(at).toISOString());
    expect(dateLine.getAttribute('title')).toBe(factLine.getAttribute('title'));
    expect(withDate!.querySelector('a')!.getAttribute('aria-label')).toBe(`With a date, ${words}`);
    expect(bare!.querySelector('[data-frame-card-line]')).toBeNull();
    expect(bare!.querySelector('a')!.getAttribute('aria-label')).toBe('With nothing');
  });

  test('stack rule: a document always has exactly one sheet behind (loading, empty, ready); page, image and data never do', () => {
    const { Card } = cardModule!;
    const frame = mount(
      <>
        <Card kind="document" size="regular" title="Loading" href="/1" face={DOC} />
        <Card kind="document" size="regular" title="Empty" href="/2" />
        <Card kind="page" size="regular" title="Page" href="/3" face={<b>page</b>} />
        <Card kind="image" size="regular" title="Image" href="/4" face={<b>image</b>} />
        <Card kind="data" size="regular" title="Data" href="/5" face={<b>rows</b>} />
        <Card kind="page" size="regular" title="Empty page" href="/6" />
      </>,
    );
    const cards = () => [...frame.querySelectorAll('[data-frame-card]')];
    expect(cards()[0]!.querySelector('[data-frame-card-face]')!.getAttribute('data-frame-card-face')).toBe('loading');
    expect(cards()[0]!.querySelectorAll('[data-frame-card-back]').length).toBe(1);
    nearScreen();
    const [loading, empty, page, image, data, emptyPage] = cards();
    for (const card of [loading, empty]) expect(card!.querySelectorAll('[data-frame-card-back]').length).toBe(1);
    expect(empty!.querySelector('[data-frame-card-face]')!.getAttribute('data-frame-card-face')).toBe('empty');
    expect(empty!.querySelector('[data-frame-card-sheet][data-frame-card-blank]')).not.toBeNull();
    for (const card of [page, image, data, emptyPage]) expect(card!.querySelectorAll('[data-frame-card-back]').length).toBe(0);
    expect(page!.querySelectorAll('[data-frame-card-window-bar] > i').length).toBe(3);
    expect(image!.querySelector('[data-frame-card-panel="image"]')).not.toBeNull();
    expect(data!.querySelector('[data-frame-card-panel="data"]')!.className).toContain('frame-card-panel-rows');
    expect(emptyPage!.querySelector('[data-frame-card-window][data-frame-card-blank]')).not.toBeNull();
  });

  test('the face mounts only near the screen, through an observer with a margin; a picture face is a lazy image', () => {
    const { Card } = cardModule!;
    const frame = mount(
      <>
        <Card kind="document" size="large" title="Plan" href="/p" face={<p data-testid="face">Body</p>} />
        <Card kind="image" size="regular" title="Shot" href="/s" face={{ src: '/shot.png' }} />
      </>,
    );
    expect(frame.querySelector('[data-testid="face"]')).toBeNull();
    expect(frame.querySelector('img')).toBeNull();
    expect(FakeObserver.made.length).toBe(2);
    expect(FakeObserver.made[0]!.options.rootMargin).toMatch(/px$/);
    expect(FakeObserver.made[0]!.target!.hasAttribute('data-frame-card-well')).toBe(true);
    nearScreen();
    expect(frame.querySelector('[data-testid="face"]')!.textContent).toBe('Body');
    const image = frame.querySelector('img')!;
    expect(image.getAttribute('loading')).toBe('lazy');
    expect(image.getAttribute('src')).toBe('/shot.png');
    expect(image.getAttribute('alt')).toBe('');
    expect(FakeObserver.made.every((observer) => observer.disconnected)).toBe(true);
  });

  test('the mark breathes only while the agent works', () => {
    const { Card } = cardModule!;
    const frame = mount(
      <>
        <Card kind="data" size="regular" title="Rate limits" href="/r" fact="Pi is working" factMark={<svg />} working />
        <Card kind="data" size="regular" title="Rate limits" href="/r" fact="Your move" factMark={<svg />} />
      </>,
    );
    const [working, still] = [...frame.querySelectorAll('[data-frame-card-mark]')];
    expect(working!.className).toContain('frame-card-breathe');
    expect(still!.className).not.toContain('frame-card-breathe');
    expect(frame.querySelectorAll('.frame-card-breathe').length).toBe(1);
  });

  test('settle and the view transition name are opt-in', () => {
    const { Card } = cardModule!;
    const frame = mount(
      <>
        <Card kind="document" size="regular" title="New" href="/n" unread settle transitionName="plan-n" />
        <Card kind="document" size="regular" title="Old" href="/o" />
      </>,
    );
    const [fresh, old] = [...frame.querySelectorAll<HTMLElement>('[data-frame-card]')];
    expect(fresh!.className).toContain('frame-card-settle');
    const well = fresh!.querySelector<HTMLElement>('[data-frame-card-well]')!;
    expect(well.className).toContain('frame-card-open');
    expect(well.style.getPropertyValue('view-transition-name') || (well.style as unknown as { viewTransitionName?: string }).viewTransitionName).toBe('plan-n');
    expect(old!.className).not.toContain('frame-card-settle');
    expect(old!.querySelector('[data-frame-card-well]')!.className).not.toContain('frame-card-open');
  });
});

describe.skipIf(!hasDom)('CardFaceDocument', () => {
  test('hides the first heading when it repeats the title, and only then', () => {
    const { CardFaceDocument } = cardModule!;
    const frame = mount(
      <>
        <div data-case="same">
          <CardFaceDocument title="Move sessions to Redis">
            <h1>Move sessions  to Redis</h1>
            <p>Body</p>
            <h2>Move sessions to Redis</h2>
          </CardFaceDocument>
        </div>
        <div data-case="other">
          <CardFaceDocument title="Move sessions to Redis">
            <h1>Session layout</h1>
          </CardFaceDocument>
        </div>
      </>,
    );
    const same = frame.querySelector('[data-case="same"]')!;
    expect(same.querySelector('h1')!.hidden).toBe(true);
    expect(same.querySelector('h2')!.hidden).toBe(false);
    expect(same.querySelector('[data-frame-card-document]')!.className).toBe('frame-card-document');
    expect(frame.querySelector<HTMLElement>('[data-case="other"] h1')!.hidden).toBe(false);
  });

  test('a heading that arrives later is checked too', async () => {
    const { CardFaceDocument } = cardModule!;
    const frame = mount(
      <CardFaceDocument title="Retry policy">
        <p>Loading</p>
      </CardFaceDocument>,
    );
    act(() =>
      root!.render(
        <CardFaceDocument title="Retry policy">
          <h1>Retry policy</h1>
          <p>Body</p>
        </CardFaceDocument>,
      ),
    );
    await act(async () => {});
    expect(frame.querySelector('h1')!.hidden).toBe(true);
  });
});

describe.skipIf(!hasDom)('CardGrid', () => {
  test('cards are list items with their size class; a phone column fills the width', () => {
    const { Card, CardGrid, CardGroup } = cardModule!;
    const frame = mount(
      <CardGroup label="tidepool-api">
        <Card kind="document" size="regular" title="One" href="/1" />
        <Card kind="document" size="large" title="Two" href="/2" />
      </CardGroup>,
    );
    const list = frame.querySelector('ul')!;
    expect(list.children.length).toBe(2);
    expect([...list.children].every((child) => child.tagName === 'LI')).toBe(true);
    const [regular, large] = [...frame.querySelectorAll('[data-frame-card]')];
    expect(regular!.className.split(' ')).toContain('w-64');
    expect(large!.className.split(' ')).toContain('w-88');
    expect(regular!.className.split(' ')).toContain('max-sm:w-full');
    expect(frame.querySelector('section')!.getAttribute('aria-label')).toBe('tidepool-api');
    void CardGrid;
  });
});
