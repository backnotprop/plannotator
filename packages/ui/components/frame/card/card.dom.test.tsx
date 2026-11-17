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
const motionModule = hasDom ? await import('./motions') : null;
const pillModule = hasDom ? await import('./CardUpdatesPill') : null;

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

describe.skipIf(!hasDom)('action and pinned', () => {
  test('the action is a sibling of the link in the card and the row, never inside it, and comes after it in tab order', () => {
    const { Card, CardRow } = cardModule!;
    const frame = mount(
      <>
        <Card kind="document" size="regular" title="Plan" href="/p" action={<button type="button">Pin</button>} />
        <CardRow kind="document" title="Plan" href="/p" action={<button type="button">Pin</button>} />
      </>,
    );
    for (const box of frame.querySelectorAll('[data-frame-card], [data-frame-card-row]')) {
      const link = box.querySelector('a')!;
      const button = box.querySelector('button')!;
      expect(link.contains(button)).toBe(false);
      expect(button.closest('a')).toBeNull();
      expect(button.closest('[data-frame-card-action]')).not.toBeNull();
      expect(link.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(button.closest('[inert]')).toBeNull();
    }
  });

  test('pinned adds "pinned" to the spoken name and marks the box, on the card and the row', () => {
    const { Card, CardRow } = cardModule!;
    const frame = mount(
      <>
        <Card kind="document" size="regular" title="Plan" href="/p" fact="Your move" unread pinned />
        <CardRow kind="document" title="Plan" href="/p" fact="Your move" pinned />
        <CardRow kind="document" title="Other" href="/o" fact="Your move" />
      </>,
    );
    const [card, row, other] = [...frame.querySelectorAll('a')];
    expect(card!.getAttribute('aria-label')).toBe('Plan, Your move, new, pinned');
    expect(row!.getAttribute('aria-label')).toBe('Plan, Your move, pinned');
    expect(other!.getAttribute('aria-label')).toBe('Other, Your move');
    expect(frame.querySelectorAll('[data-frame-card-pinned]').length).toBe(2);
  });
});

describe.skipIf(!hasDom)('CardRow', () => {
  test('44 px tall, 52 on a phone; one link; the title on one line, the card title up to two', () => {
    const { Card, CardRow } = cardModule!;
    const frame = mount(
      <>
        <CardRow kind="page" title="Rebuild checkout as one page" href="/c" secondary="kestrel-web" time="2026-11-15T10:00:00Z" />
        <Card kind="page" size="regular" title="Rebuild checkout as one page" href="/c" />
      </>,
    );
    const row = frame.querySelector<HTMLElement>('[data-frame-card-row]')!;
    const classes = row.className.split(' ');
    expect(classes).toContain('h-11');
    expect(classes).toContain('max-sm:h-13');
    expect(row.querySelectorAll('a').length).toBe(1);
    expect(row.querySelector('[data-frame-card-title]')!.className.split(' ')).toContain('truncate');
    expect(row.querySelector('[data-frame-card-secondary]')!.textContent).toBe('kestrel-web');
    expect(row.querySelector('time')).not.toBeNull();
    const cardTitle = frame.querySelector('[data-frame-card] [data-frame-card-title]')!;
    expect(cardTitle.className.split(' ')).toContain('line-clamp-2');
  });

  test('the thumbnail is 36x27 on the kind ground: the given thumb as is, else the face drawn small with no sheet behind', () => {
    const { CardRow } = cardModule!;
    const frame = mount(
      <>
        <CardRow kind="document" title="Own thumb" href="/a" thumb={<b data-testid="thumb">t</b>} face={<p>face</p>} />
        <CardRow kind="document" title="Small face" href="/b" face={<p data-testid="small">face</p>} />
      </>,
    );
    nearScreen();
    const [own, small] = [...frame.querySelectorAll('[data-frame-card-thumb]')];
    for (const thumb of [own, small]) {
      expect(thumb!.className).toContain('h-[27px]');
      expect(thumb!.className).toContain('w-9');
      expect(thumb!.hasAttribute('inert')).toBe(true);
    }
    expect(own!.querySelector('[data-testid="thumb"]')).not.toBeNull();
    expect(own!.querySelector('[data-frame-card-stage]')).toBeNull();
    expect(small!.querySelector('[data-testid="small"]')).not.toBeNull();
    expect(small!.querySelector('[data-frame-card-back]')).toBeNull();
    expect((small as HTMLElement).style.getPropertyValue('--frame-card-scale')).toBe(String(36 / 420));
  });
});

describe.skipIf(!hasDom)('motion API', () => {
  const realAnimate = hasDom ? Element.prototype.animate : undefined;
  const realMatch = hasDom ? window.matchMedia : undefined;
  let animated: Element[] = [];

  function reduce(on: boolean) {
    window.matchMedia = ((query: string) => ({
      matches: on && query.includes('reduce'),
      media: query,
      addEventListener() {},
      removeEventListener() {},
    })) as unknown as typeof window.matchMedia;
  }

  beforeEach(() => {
    animated = [];
    Element.prototype.animate = function (this: Element) {
      animated.push(this);
      return { cancel() {}, finished: Promise.resolve() } as unknown as Animation;
    } as typeof Element.prototype.animate;
  });

  afterEach(() => {
    Element.prototype.animate = realAnimate!;
    window.matchMedia = realMatch!;
  });

  function list(order: string[]) {
    const ul = document.createElement('ul');
    for (const name of order) {
      const li = document.createElement('li');
      li.dataset.name = name;
      ul.appendChild(li);
    }
    document.body.appendChild(ul);
    return ul;
  }

  test('settleBatch measures, runs mutate once, and slides what moved', () => {
    reduce(false);
    const { settleBatch } = motionModule!;
    const ul = list(['a', 'b', 'c']);
    let tops: Record<string, number> = { a: 0, b: 50, c: 100 };
    for (const li of ul.children) (li as HTMLElement).getBoundingClientRect = () => ({ left: 0, top: tops[(li as HTMLElement).dataset.name!]! }) as DOMRect;
    let calls = 0;
    settleBatch(ul, () => {
      calls += 1;
      ul.prepend(ul.lastElementChild!);
      tops = { c: 0, a: 50, b: 100 };
    });
    expect(calls).toBe(1);
    expect(animated.length).toBe(3);
    ul.remove();
  });

  test('under reduced motion settleBatch only runs mutate, and arrive does nothing', () => {
    reduce(true);
    const { settleBatch, arrive } = motionModule!;
    const ul = list(['a', 'b']);
    let calls = 0;
    settleBatch(ul, () => {
      calls += 1;
      ul.prepend(ul.lastElementChild!);
    });
    arrive(ul.firstElementChild as HTMLElement);
    expect(calls).toBe(1);
    expect([...ul.children].map((li) => (li as HTMLElement).dataset.name)).toEqual(['b', 'a']);
    expect(animated).toEqual([]);
    ul.remove();
  });

  test('arrive animates only the element that landed, never the card around it', () => {
    reduce(false);
    const { Card } = cardModule!;
    const { arrive } = motionModule!;
    const frame = mount(<Card kind="page" size="regular" title="Checkout" href="/c" face={<div><span data-testid="row">Socks</span></div>} />);
    nearScreen();
    const row = frame.querySelector<HTMLElement>('[data-testid="row"]')!;
    arrive(row);
    expect(animated.length).toBeGreaterThan(0);
    expect(animated.every((element) => element === row)).toBe(true);
  });
});

describe.skipIf(!hasDom)('CardUpdatesPill', () => {
  test('a real button reading "1 update · Show" or "N updates · Show", announced politely; nothing with no updates', () => {
    const { CardUpdatesPill } = pillModule!;
    let shown = 0;
    const frame = mount(<CardUpdatesPill count={1} onShow={() => (shown += 1)} />);
    const button = frame.querySelector('button')!;
    expect(button.getAttribute('type')).toBe('button');
    expect(button.textContent).toBe('1 update·Show');
    const live = frame.querySelector('[aria-live="polite"]')!;
    expect(live.textContent).toBe('1 update');
    act(() => button.click());
    expect(shown).toBe(1);
    act(() => root!.render(<CardUpdatesPill count={3} onShow={() => {}} />));
    expect(frame.querySelector('button')!.textContent).toBe('3 updates·Show');
    expect(frame.querySelector('[aria-live="polite"]')!.textContent).toBe('3 updates');
    act(() => root!.render(<CardUpdatesPill count={0} onShow={() => {}} />));
    expect(frame.querySelector('button')).toBeNull();
  });
});
