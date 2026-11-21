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
    readonly options: { rootMargin?: string; root?: Element | null } = {},
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
  leave() {
    this.callback([{ isIntersecting: false, target: this.target! }]);
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

function farFromScreen() {
  act(() => {
    for (const observer of FakeObserver.made) if (!observer.disconnected) observer.leave();
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

  test('the grey line is the fact with its mark; without a fact it is the date; the full time is a tooltip on the link, where the pointer reaches it', () => {
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
    const [factLink, dateLink, bareLink] = [...frame.querySelectorAll('a')];
    expect(factLink!.getAttribute('title')).toBeTruthy();
    expect(dateLink!.getAttribute('title')).toBe(factLink!.getAttribute('title'));
    expect(bareLink!.hasAttribute('title')).toBe(false);
    const dateLine = withDate!.querySelector('[data-frame-card-line]')!;
    expect(dateLine.textContent).toBe(words);
    expect(dateLine.querySelector('time')!.getAttribute('dateTime')).toBe(new Date(at).toISOString());
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
    expect(data!.querySelector('[data-frame-card-panel="data"] [data-frame-card-stage]')!.textContent).toBe('rows');
    expect(emptyPage!.querySelector('[data-frame-card-window][data-frame-card-blank]')).not.toBeNull();
  });

  test('the face mounts only near the screen and is let go far from it; the well keeps its place; a picture face is a lazy image', () => {
    const { Card } = cardModule!;
    const frame = mount(
      <>
        <Card kind="document" size="large" title="Plan" href="/p" face={<p data-testid="face">Body</p>} />
        <Card kind="image" size="regular" title="Shot" href="/s" face={{ src: '/shot.png' }} />
      </>,
    );
    expect(frame.querySelector('[data-testid="face"]')).toBeNull();
    expect(frame.querySelector('img')).toBeNull();
    expect(FakeObserver.made.map((observer) => observer.options.rootMargin)).toEqual(['240px', '1200px', '240px', '1200px']);
    expect(FakeObserver.made.every((observer) => observer.target!.hasAttribute('data-frame-card-well'))).toBe(true);
    nearScreen();
    expect(frame.querySelector('[data-testid="face"]')!.textContent).toBe('Body');
    const image = frame.querySelector('img')!;
    expect(image.getAttribute('loading')).toBe('lazy');
    expect(image.getAttribute('src')).toBe('/shot.png');
    expect(image.getAttribute('alt')).toBe('');
    const well = frame.querySelector('[data-frame-card-well]')!;
    farFromScreen();
    expect(frame.querySelector('[data-testid="face"]')).toBeNull();
    expect(frame.querySelector('img')).toBeNull();
    expect(frame.querySelector('[data-frame-card-well]')).toBe(well);
    expect(well.getAttribute('data-frame-card-face')).toBe('loading');
    expect(well.querySelectorAll('[data-frame-card-back]').length).toBe(1);
    nearScreen();
    expect(frame.querySelector('[data-testid="face"]')).not.toBeNull();
  });

  test('inside a scrolling list the look-ahead is measured in that list, not the window', () => {
    const { Card } = cardModule!;
    const frame = mount(
      <div data-testid="scroller" style={{ overflowY: 'auto', height: '200px' }}>
        <Card kind="document" size="regular" title="Plan" href="/p" face={DOC} />
      </div>,
    );
    const scroller = frame.querySelector('[data-testid="scroller"]');
    expect(FakeObserver.made.length).toBe(2);
    expect(FakeObserver.made.every((observer) => observer.options.root === scroller)).toBe(true);
  });

  test('every kind lays its face out at the same width, which a caller can read', () => {
    const { Card, CARD_FACE_WIDTH } = cardModule!;
    const frame = mount(
      <>
        {(['document', 'page', 'image', 'data'] as const).map((kind) => (
          <Card key={kind} kind={kind} size="regular" title={kind} href={`/${kind}`} face={<b>{kind}</b>} />
        ))}
      </>,
    );
    nearScreen();
    const widths = [...frame.querySelectorAll<HTMLElement>('[data-frame-card-stage]')].map((stage) => stage.style.width);
    expect(CARD_FACE_WIDTH).toBe(420);
    expect(widths).toEqual(['420px', '420px', '420px', '420px']);
  });

  test('titles take their direction from their own text', () => {
    const { Card, CardRow } = cardModule!;
    const frame = mount(
      <>
        <Card kind="document" size="regular" title="خطة الجلسات" href="/a" />
        <CardRow kind="document" title="خطة الجلسات" href="/b" />
      </>,
    );
    const titles = [...frame.querySelectorAll('[data-frame-card-title]')];
    expect(titles.length).toBe(2);
    for (const title of titles) expect(title.getAttribute('dir')).toBe('auto');
  });

  test('a picture face is fitted inside its panel by default, and fills it with fit cover', () => {
    const { Card } = cardModule!;
    const frame = mount(
      <>
        <Card kind="image" size="regular" title="Fitted" href="/a" face={{ src: '/a.png' }} />
        <Card kind="image" size="regular" title="Filled" href="/b" face={{ src: '/b.png', fit: 'cover' }} />
      </>,
    );
    nearScreen();
    const [fitted, filled] = [...frame.querySelectorAll('img')];
    expect(fitted!.getAttribute('data-frame-card-fit')).toBe('contain');
    expect(filled!.getAttribute('data-frame-card-fit')).toBe('cover');
  });

  test('the mark breathes only while the agent works', () => {
    const { Card } = cardModule!;
    const frame = mount(
      <>
        <Card kind="data" size="regular" title="Rate limits" href="/r" fact="Pi is working" factMark={<svg />} working />
        <Card kind="data" size="regular" title="Rate limits" href="/r" fact="Your move" factMark={<svg />} />
      </>,
    );
    const [working, still] = [...frame.querySelectorAll<HTMLElement>('[data-frame-card-mark]')];
    expect(working!.style.animationDelay).toMatch(/^-\d+ms$/);
    expect(still!.style.animationDelay).toBe('');
    act(() =>
      root!.render(
        <>
          <Card kind="data" size="regular" title="Rate limits" href="/r" fact="Pi is working" factMark={<svg />} />
          <Card kind="data" size="regular" title="Rate limits" href="/r" fact="Your move" factMark={<svg />} />
        </>,
      ),
    );
    expect(frame.querySelector<HTMLElement>('[data-frame-card-mark]')!.style.animationDelay).toBe('');
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
    expect(fresh!.hasAttribute('data-frame-card-settle')).toBe(true);
    const well = fresh!.querySelector<HTMLElement>('[data-frame-card-well]')!;
    expect(well.hasAttribute('data-frame-card-transition')).toBe(true);
    expect(well.style.getPropertyValue('view-transition-name') || (well.style as unknown as { viewTransitionName?: string }).viewTransitionName).toBe('plan-n');
    expect(old!.hasAttribute('data-frame-card-settle')).toBe(false);
    expect(old!.querySelector('[data-frame-card-well]')!.hasAttribute('data-frame-card-transition')).toBe(false);
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

describe.skipIf(!hasDom)('CardGrid and CardGroups', () => {
  test('a grid takes its size and holds each card as a list item; the card fills its column, with no fixed width', () => {
    const { Card, CardGrid } = cardModule!;
    const frame = mount(
      <CardGrid size="large" label="Now">
        <Card kind="document" size="large" title="One" href="/1" />
        {null}
        <Card kind="page" size="large" title="Two" href="/2" />
      </CardGrid>,
    );
    const list = frame.querySelector('ul')!;
    expect(list.getAttribute('aria-label')).toBe('Now');
    expect(list.getAttribute('data-frame-card-grid')).toBe('large');
    expect([...list.children].map((child) => child.tagName)).toEqual(['LI', 'LI']);
    for (const card of frame.querySelectorAll<HTMLElement>('[data-frame-card]')) expect(card.style.width).toBe('');
  });

  test('in CardGroups a group spans as many shared columns as it has cards, at most a row', () => {
    const { Card, CardGroup, CardGroups } = cardModule!;
    const cards = (n: number) => Array.from({ length: n }, (_, i) => <Card key={i} kind="document" size="regular" title={`P${i}`} href={`/${i}`} />);
    const frame = mount(
      <CardGroups>
        <CardGroup label="two">{cards(2)}</CardGroup>
        <CardGroup label="six">{cards(6)}</CardGroup>
      </CardGroups>,
    );
    const [two, six] = [...frame.querySelectorAll<HTMLElement>('section')];
    expect(two!.getAttribute('aria-label')).toBe('two');
    expect(two!.style.gridColumn).toBe('span 2');
    expect(six!.style.gridColumn).toBe('span 4');
    expect(six!.querySelectorAll('li').length).toBe(6);
  });

  test('groups of 2, 4 and 1 cards in 4 columns span 2, 4 and 1 and stay in reading order, so a later group never fills a gap above and what you see matches the Tab order', () => {
    const { Card, CardGroup, CardGroups } = cardModule!;
    const cards = (n: number, at: string) => Array.from({ length: n }, (_, i) => <Card key={i} kind="document" size="regular" title={`${at}${i}`} href={`/${at}${i}`} />);
    const frame = mount(
      <CardGroups>
        <CardGroup label="a">{cards(2, 'a')}</CardGroup>
        <CardGroup label="b">{cards(4, 'b')}</CardGroup>
        <CardGroup label="c">{cards(1, 'c')}</CardGroup>
      </CardGroups>,
    );
    const groups = [...frame.querySelectorAll<HTMLElement>('section')];
    expect(groups.map((group) => group.style.gridColumn)).toEqual(['span 2', 'span 4', 'span 1']);
    expect([...frame.querySelectorAll('a')].map((link) => link.getAttribute('href'))).toEqual(['/a0', '/a1', '/b0', '/b1', '/b2', '/b3', '/c0']);
  });

  test('a grid puts 28 px between rows of large cards and 44 px between rows of regular ones', () => {
    const { Card, CardGrid } = cardModule!;
    const frame = mount(
      <>
        <CardGrid size="large">
          <Card kind="document" size="large" title="One" href="/1" />
        </CardGrid>
        <CardGrid size="regular">
          <Card kind="document" size="regular" title="Two" href="/2" />
        </CardGrid>
      </>,
    );
    const [large, regular] = [...frame.querySelectorAll<HTMLElement>('ul')];
    expect(large!.style.rowGap).toBe('28px');
    expect(regular!.style.rowGap).toBe('44px');
  });

  test('a gap the caller passes wins over the default, for either size', () => {
    const { Card, CardGrid } = cardModule!;
    const frame = mount(
      <>
        <CardGrid size="large" gap={44}>
          <Card kind="document" size="large" title="One" href="/1" />
        </CardGrid>
        <CardGrid size="regular" gap={12}>
          <Card kind="document" size="regular" title="Two" href="/2" />
        </CardGrid>
      </>,
    );
    const [large, regular] = [...frame.querySelectorAll<HTMLElement>('ul')];
    expect(large!.style.rowGap).toBe('44px');
    expect(regular!.style.rowGap).toBe('12px');
  });

  test('a group on its own lays out its cards in its own grid, 24 px between rows', () => {
    const { Card, CardGroup } = cardModule!;
    const frame = mount(
      <CardGroup label="payments">
        <Card kind="document" size="regular" title="One" href="/1" />
      </CardGroup>,
    );
    expect(frame.querySelector('section')!.style.gridColumn).toBe('');
    expect(frame.querySelector('ul')!.getAttribute('data-frame-card-grid')).toBe('regular');
    expect(frame.querySelector('ul')!.style.rowGap).toBe('24px');
  });

  test('a gap passed to a group wins, on its own and on the shared grid', () => {
    const { Card, CardGroup, CardGroups } = cardModule!;
    const frame = mount(
      <>
        <CardGroup label="alone" gap={36}>
          <Card kind="document" size="regular" title="One" href="/1" />
        </CardGroup>
        <CardGroups>
          <CardGroup label="shared" gap={16}>
            <Card kind="document" size="regular" title="Two" href="/2" />
          </CardGroup>
        </CardGroups>
      </>,
    );
    const [alone, shared] = [...frame.querySelectorAll<HTMLElement>('ul')];
    expect(alone!.style.rowGap).toBe('36px');
    expect(shared!.getAttribute('data-frame-card-grid')).toBe('group');
    expect(shared!.style.rowGap).toBe('16px');
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
        <CardRow kind="document" title="Plan" href="/p" fact="Your move" pinned secondary="payments" />
        <CardRow kind="document" title="Other" href="/o" fact="Your move" />
      </>,
    );
    const [card, row, other] = [...frame.querySelectorAll('a')];
    expect(card!.getAttribute('aria-label')).toBe('Plan, Your move, new, pinned');
    expect(row!.getAttribute('aria-label')).toBe('Plan, payments, Your move, pinned');
    expect(other!.getAttribute('aria-label')).toBe('Other, Your move');
    expect(frame.querySelectorAll('[data-frame-card-pinned]').length).toBe(2);
  });
});

describe.skipIf(!hasDom)('CardRow', () => {
  test('one link named by the title, the secondary text and the grey line; the date is a tooltip on the link', () => {
    const { CardRow, cardDateWords } = cardModule!;
    const at = '2026-11-15T10:00:00Z';
    const frame = mount(<CardRow kind="page" title="Rebuild checkout as one page" href="/c" secondary="web-app" time={at} unread />);
    const row = frame.querySelector<HTMLElement>('[data-frame-card-row]')!;
    const links = row.querySelectorAll('a');
    expect(links.length).toBe(1);
    expect(links[0]!.getAttribute('aria-label')).toBe(`Rebuild checkout as one page, web-app, ${cardDateWords(new Date(at))}, new`);
    expect(links[0]!.getAttribute('title')).toBeTruthy();
    expect(row.querySelector('[data-frame-card-secondary]')!.textContent).toBe('web-app');
    expect(row.getAttribute('data-frame-card-columns')).toBe('secondary');
    expect(row.querySelector('time')!.getAttribute('dateTime')).toBe(new Date(at).toISOString());
  });

  test('the thumbnail draws the kind\'s chrome around the host\'s thumb, or else the kind\'s glyph, never a scaled face', () => {
    const { CardRow } = cardModule!;
    const frame = mount(
      <>
        <CardRow kind="document" title="Own thumb" href="/a" thumb={<b data-testid="thumb">t</b>} />
        <CardRow kind="page" title="Glyph" href="/b" />
        <CardRow kind="image" title="Picture" href="/c" thumb={{ src: '/c.png' }} />
      </>,
    );
    const [own, glyph, picture] = [...frame.querySelectorAll<HTMLElement>('[data-frame-card-thumb]')];
    expect(own!.getAttribute('data-frame-card-thumb')).toBe('picture');
    expect(own!.querySelector('[data-testid="thumb"]')).toBeNull();
    nearScreen();
    expect(own!.querySelector('[data-frame-card-sheet] [data-testid="thumb"]')).not.toBeNull();
    expect(glyph!.getAttribute('data-frame-card-thumb')).toBe('glyph');
    expect(glyph!.querySelector('[data-frame-card-window]')).not.toBeNull();
    expect(picture!.querySelector('[data-frame-card-panel="image"] img')!.getAttribute('src')).toBe('/c.png');
    for (const thumb of [own, glyph, picture]) {
      expect(thumb!.hasAttribute('inert')).toBe(true);
      expect(thumb!.querySelector('[data-frame-card-stage]')).toBeNull();
      expect(thumb!.querySelector('[data-frame-card-back]')).toBeNull();
    }
  });

  test('a page row shows a small window, a bar over lines, while a page card keeps its full window with three dots', () => {
    const { Card, CardRow } = cardModule!;
    const frame = mount(
      <>
        <CardRow kind="page" title="Row" href="/r" />
        <Card kind="page" size="regular" title="Card" href="/c" face={<b>face</b>} />
      </>,
    );
    const row = frame.querySelector('[data-frame-card-row] [data-frame-card-window]')!;
    expect(row.querySelector('[data-frame-card-window-bar]')).not.toBeNull();
    expect(row.querySelectorAll('.frame-card-window-body > i').length).toBe(3);
    expect(row.textContent).toBe('');
    nearScreen();
    const card = frame.querySelector('[data-frame-card] [data-frame-card-window]')!;
    expect(card.querySelectorAll('[data-frame-card-window-bar] > i').length).toBe(3);
    expect(card.closest('[data-frame-card-thumb]')).toBeNull();
  });

  test('an empty row shows the empty face in small on the neutral ground, like a card with no face, whatever its kind', () => {
    const { Card, CardRow } = cardModule!;
    const frame = mount(
      <>
        <CardRow kind="document" title="New plan" href="/n" empty thumb={<b data-testid="thumb">t</b>} />
        <CardRow kind="document" title="Plan" href="/p" />
        <Card kind="document" size="regular" title="New plan" href="/n" />
      </>,
    );
    nearScreen();
    const [empty, glyph] = [...frame.querySelectorAll<HTMLElement>('[data-frame-card-thumb]')];
    expect(empty!.getAttribute('data-frame-card-thumb')).toBe('empty');
    expect(empty!.getAttribute('data-frame-card-face')).toBe('empty');
    expect(empty!.querySelector('[data-frame-card-sheet]')!.hasAttribute('data-frame-card-blank')).toBe(true);
    expect(empty!.querySelector('[data-testid="thumb"]')).toBeNull();
    expect(glyph!.getAttribute('data-frame-card-face')).toBe('ready');
    expect(glyph!.querySelector('[data-frame-card-blank]')).toBeNull();
    const well = frame.querySelector('[data-frame-card] [data-frame-card-well]')!;
    expect(well.getAttribute('data-frame-card-face')).toBe('empty');
  });

  test('CardRows holds each row as a list item under its name, and marks the list so a pin anywhere keeps every date in line', () => {
    const { CardRow, CardRows } = cardModule!;
    const frame = mount(
      <CardRows label="All plans">
        <CardRow kind="document" title="One" href="/1" action={<button type="button">Pin</button>} />
        {null}
        <CardRow kind="page" title="Two" href="/2" pinned action={<button type="button">Unpin</button>} />
      </CardRows>,
    );
    const list = frame.querySelector('ul')!;
    expect(list.getAttribute('aria-label')).toBe('All plans');
    expect(list.hasAttribute('data-frame-card-rows')).toBe(true);
    expect([...list.children].map((item) => item.tagName)).toEqual(['LI', 'LI']);
    const rows = [...list.querySelectorAll<HTMLElement>('[data-frame-card-row]')];
    expect(rows.map((row) => row.getAttribute('data-frame-card-columns'))).toEqual(['action', 'action']);
    for (const row of rows) {
      const end = [...row.children].at(-1)!;
      expect(end.hasAttribute('data-frame-card-end')).toBe(true);
      const trail = end.querySelector('[data-frame-card-trail]')!;
      expect(trail.lastElementChild!.hasAttribute('data-frame-card-action')).toBe(true);
      expect(row.querySelector('a')!.contains(trail)).toBe(false);
    }
  });

  test('CardRows tells its rows what to show at rest without hover: the action by default, or nothing with never', () => {
    const { CardRow, CardRows } = cardModule!;
    const frame = mount(
      <>
        <CardRows label="Default">
          <CardRow kind="document" title="One" href="/1" />
        </CardRows>
        <CardRows label="Menu" actionAtRest="never">
          <CardRow kind="document" title="Two" href="/2" />
        </CardRows>
      </>,
    );
    const [plain, never] = [...frame.querySelectorAll('ul')];
    expect(plain!.getAttribute('data-frame-card-action-rest')).toBe('touch');
    expect(never!.getAttribute('data-frame-card-action-rest')).toBe('never');
  });

  test('CardRows passes the host its class name, data attributes and other list props', () => {
    const { CardRow, CardRows } = cardModule!;
    const frame = mount(
      <CardRows label="Plans" className="host-list" data-testid="plans" id="plans-list" style={{ marginTop: 4 }}>
        <CardRow kind="document" title="One" href="/1" />
      </CardRows>,
    );
    const list = frame.querySelector('ul')!;
    expect(list.className).toBe('host-list');
    expect(list.getAttribute('data-testid')).toBe('plans');
    expect(list.id).toBe('plans-list');
    expect(list.style.marginTop).toBe('4px');
    expect(list.getAttribute('aria-label')).toBe('Plans');
    expect(list.hasAttribute('data-frame-card-rows')).toBe(true);
  });

  test('a pinned row rests with a plain pin after its title, drawn by the card; the host action stays its own, after the trailing text in the DOM', () => {
    const { CardRow } = cardModule!;
    const frame = mount(
      <>
        <CardRow kind="document" title="Pinned" href="/p" fact="Your move" pinned action={<button type="button">Unpin</button>} />
        <CardRow kind="document" title="Loose" href="/l" fact="Your move" action={<button type="button">Pin</button>} />
      </>,
    );
    const [pinned, loose] = [...frame.querySelectorAll<HTMLElement>('[data-frame-card-row]')];
    const mark = pinned!.querySelector('a [data-frame-card-pinned-mark]')!;
    expect(mark.getAttribute('aria-hidden')).toBe('true');
    expect(mark.previousElementSibling!.hasAttribute('data-frame-card-title')).toBe(true);
    expect(loose!.querySelector('[data-frame-card-pinned-mark]')).toBeNull();
    for (const row of [pinned!, loose!]) {
      expect(row.getAttribute('data-frame-card-columns')).toBe('action');
      expect(row.querySelector('[data-frame-card-trail] > [data-frame-card-line]')!.nextElementSibling!.hasAttribute('data-frame-card-action')).toBe(true);
    }
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

  test('arrive opens a line inside a scaled face to its own full height, not its scaled height', () => {
    reduce(false);
    const keyframes: Keyframe[][] = [];
    Element.prototype.animate = function (this: Element, frames: Keyframe[] | PropertyIndexedKeyframes | null) {
      animated.push(this);
      keyframes.push(frames as Keyframe[]);
      return { cancel() {}, finished: Promise.resolve() } as unknown as Animation;
    } as typeof Element.prototype.animate;
    const { arrive } = motionModule!;
    const line = document.createElement('div');
    document.body.appendChild(line);
    Object.defineProperty(line, 'offsetHeight', { value: 18 });
    line.getBoundingClientRect = () => ({ height: 18 * 0.66, width: 100, top: 0, left: 0 }) as DOMRect;
    arrive(line);
    const opening = keyframes.find((frames) => frames.some((frame) => 'height' in frame))!;
    expect(opening.at(-1)!.height).toBe('18px');
    line.remove();
  });

  test('the motion helpers take null or undefined: arrive does nothing, settleBatch only runs the change', () => {
    reduce(false);
    const { arrive, settleBatch } = motionModule!;
    expect(() => arrive(null)).not.toThrow();
    expect(() => arrive(undefined)).not.toThrow();
    let calls = 0;
    settleBatch(null, () => (calls += 1));
    settleBatch(undefined, () => (calls += 1));
    expect(calls).toBe(2);
    expect(animated).toEqual([]);
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
    expect(button.textContent).toBe('1 update · Show');
    const live = frame.querySelector('[aria-live="polite"]')!;
    expect(live.textContent).toBe('1 update');
    act(() => button.click());
    expect(shown).toBe(1);
    act(() => root!.render(<CardUpdatesPill count={3} onShow={() => {}} />));
    expect(frame.querySelector('button')!.textContent).toBe('3 updates · Show');
    expect(frame.querySelector('[aria-live="polite"]')!.textContent).toBe('3 updates');
    act(() => root!.render(<CardUpdatesPill count={0} onShow={() => {}} />));
    expect(frame.querySelector('button')).toBeNull();
  });
});

describe.skipIf(!hasDom)('fact tone and where a document face starts', () => {
  test('factTone action draws the fact in the accent colour; the default and a date stay grey', () => {
    const { Card, CardRow } = cardModule!;
    const frame = mount(
      <>
        <Card kind="document" size="regular" title="A" href="/a" fact="Your move" factTone="action" />
        <CardRow kind="document" title="B" href="/b" fact="Your move" factTone="action" />
        <Card kind="document" size="regular" title="C" href="/c" fact="Maya Chen is working" />
        <Card kind="document" size="regular" title="D" href="/d" factTone="action" time="2026-11-15T10:00:00Z" />
      </>,
    );
    const lines = [...frame.querySelectorAll<HTMLElement>('[data-frame-card-line]')];
    expect(lines.map((line) => line.dataset.frameCardFactTone ?? null)).toEqual(['action', 'action', null, null]);
  });

  test('the first heading is skipped only when it is the title, ignoring case and spacing, with any heading right after it', () => {
    const { CardFaceDocument, cardHeadingIsTitle } = cardModule!;
    expect(cardHeadingIsTitle('  per-tenant   Feature flags ', 'Per-tenant feature flags')).toBe(true);
    expect(cardHeadingIsTitle('Context', 'Context window cleanup')).toBe(false);
    expect(cardHeadingIsTitle('Per-tenant feature flags', 'Per-tenant feature flags, so a beta can ship')).toBe(false);
    const frame = mount(
      <>
        <div data-case="same">
          <CardFaceDocument title="Per-tenant feature flags">
            <h1>Per-tenant feature flags</h1>
            <h2>Context</h2>
            <p>A beta should reach one customer.</p>
            <h2>Steps</h2>
            <ol>
              <li>Read flags per tenant</li>
            </ol>
          </CardFaceDocument>
        </div>
        <div data-case="prefix">
          <CardFaceDocument title="Context window cleanup">
            <h1>Context</h1>
            <p>Why it fills up.</p>
          </CardFaceDocument>
        </div>
      </>,
    );
    const shown = (name: string) =>
      [...frame.querySelectorAll<HTMLElement>(`[data-case="${name}"] [data-frame-card-document] > *`)].filter((element) => !element.hidden).map((element) => element.tagName);
    expect(shown('same')).toEqual(['P', 'H2', 'OL']);
    expect(shown('prefix')).toEqual(['H1', 'P']);
  });

  test('never opens on a bare list: a title heading that a list follows directly stays', () => {
    const { CardFaceDocument } = cardModule!;
    const frame = mount(
      <CardFaceDocument title="Retry policy">
        <h1>Retry policy</h1>
        <ul>
          <li>1 minute</li>
        </ul>
      </CardFaceDocument>,
    );
    const shown = [...frame.querySelectorAll<HTMLElement>('[data-frame-card-document] > *')].filter((element) => !element.hidden);
    expect(shown.map((element) => element.tagName)).toEqual(['H1', 'UL']);
  });
});
