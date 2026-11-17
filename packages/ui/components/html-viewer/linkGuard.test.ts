/**
 * The link guard (linkGuard.ts), the shipped string run in a happy-dom window
 * whose `parent` is a fake host. It runs first in a frame's document, so every
 * listener these tests add comes after it, as any page script's would (one in
 * `<head>` included).
 *
 * Guards: it offers the host one port, with the load's key, and the page never
 * sees that offer; a link goes out only while a person's click is being
 * dispatched, and only for the link that click is on; a page's own call, a
 * script's `a.click()`, another href or a `javascript:` link sends nothing; a
 * form's address goes out only for a press on a submit control, as a query
 * with no fragment; a page listener that stops the click first does not hide
 * it from the guard; the page cannot replace the guard. `withLinkKey` puts a
 * served frame's key last in the query and keeps the page's own query.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { LINK_GUARD_FUNCTION, linkGuardScriptTag, newLinkKey, withLinkKey } from './linkGuard';

const hasDom = typeof document !== 'undefined';
const KEY = 'a'.repeat(32);

type Guard = { follow: (kind: string, msg: unknown) => boolean };
type Offer = { data: Record<string, unknown>; origin: string; transfer: Transferable[] | undefined };

describe('withLinkKey', () => {
  const base = 'http://localhost:4000/#thread=t1';
  test('the key goes last in the query; the page query and fragment stay as they were', () => {
    expect(withLinkKey('http://localhost:4000/api/inbox/pages/abc', KEY, base)).toBe(`http://localhost:4000/api/inbox/pages/abc?__pnk=${KEY}`);
    expect(withLinkKey('/api/inbox/pages/abc?variant=2&n=3#top', KEY, base)).toBe(`/api/inbox/pages/abc?variant=2&n=3&__pnk=${KEY}#top`);
  });

  test('a path on the host server stays a path, whatever the host document is at', () => {
    expect(withLinkKey('/api/inbox/pages/abc?variant=2#top', KEY, 'about:blank')).toBe(`/api/inbox/pages/abc?variant=2&__pnk=${KEY}#top`);
    expect(withLinkKey('//elsewhere.example/p', KEY, 'about:blank')).toBe('//elsewhere.example/p');
  });

  test("a key the page's own query carried is dropped, so the guard reads only the host's", () => {
    const other = 'b'.repeat(32);
    expect(withLinkKey(`/p?__pnk=${other}&v=1`, KEY, base)).toBe(`/p?v=1&__pnk=${KEY}`);
  });

  test('a new key every time, 32 hex characters; the inline tag refuses anything else', () => {
    const a = newLinkKey();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(newLinkKey()).not.toBe(a);
    expect(() => linkGuardScriptTag("x');alert(1);('")).toThrow();
  });
});

describe.if(hasDom)('the link guard in a frame', () => {
  const offers: Offer[] = [];
  const pageMessages: unknown[] = [];
  const sent: Array<Record<string, unknown>> = [];
  let guard: Guard;
  let hostPort: MessagePort | null = null;
  let realParent: PropertyDescriptor | undefined;
  const pageListener = (event: MessageEvent) => pageMessages.push(event.data);
  /** What the bridge does from its click handler: hand the click to the guard. */
  let bridgeCall: ((event: MouseEvent) => void) | null = null;
  const bridge = (event: Event) => bridgeCall?.(event as MouseEvent);

  beforeAll(async () => {
    realParent = Object.getOwnPropertyDescriptor(window, 'parent');
    const fakeHost = {
      postMessage(data: Record<string, unknown>, origin: string, transfer?: Transferable[]) {
        offers.push({ data, origin, transfer });
      },
    };
    Object.defineProperty(window, 'parent', { value: fakeHost, configurable: true });
    new Function(`${LINK_GUARD_FUNCTION}('${KEY}');`)();
    // A page script, after the guard: it listens for messages on its window.
    window.addEventListener('message', pageListener, true);
    document.addEventListener('click', bridge, true);
    guard = (window as unknown as { __plannotatorLinkGuard: Guard }).__plannotatorLinkGuard;
    hostPort = (offers[0]?.transfer?.[0] as MessagePort | undefined) ?? null;
    if (hostPort) hostPort.onmessage = (event) => sent.push(event.data as Record<string, unknown>);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  afterAll(() => {
    window.removeEventListener('message', pageListener, true);
    document.removeEventListener('click', bridge, true);
    if (realParent) Object.defineProperty(window, 'parent', realParent);
    hostPort?.close();
  });

  afterEach(async () => {
    bridgeCall = null;
    sent.length = 0;
    document.body.replaceChildren();
  });

  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  /** A person's click (`isTrusted`, which only the browser sets) or a script's. */
  function click(el: Element, trusted = true): MouseEvent {
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    if (trusted) Object.defineProperty(event, 'isTrusted', { value: true });
    el.dispatchEvent(event);
    return event;
  }

  function page(html: string): HTMLElement {
    document.body.innerHTML = html;
    return document.body;
  }

  test('it offers the host one port, with the load key, and the page never sees the offer', async () => {
    expect(offers).toHaveLength(1);
    expect(offers[0]!.data).toEqual({ type: 'plannotator-bridge-link-offer', key: KEY });
    expect(offers[0]!.transfer).toHaveLength(1);
    await settle();
    expect(pageMessages).toEqual([]);
  });

  test("a person's click on a link goes out on the port, for that link", async () => {
    page('<a id="go" href="next.html?v=2#top"><span id="inner">Next</span></a>');
    bridgeCall = () => guard.follow('link', { type: 'plannotator-bridge-link-click', href: 'next.html?v=2#top' });
    click(document.querySelector('#inner')!);
    await settle();
    expect(sent).toEqual([{ type: 'plannotator-bridge-link-click', href: 'next.html?v=2#top' }]);
  });

  test("the page's own call with no click, and a script's a.click(), send nothing", async () => {
    page('<a id="go" href="/#thread=T2">Go</a>');
    expect(guard.follow('link', { href: '/#thread=T2' })).toBe(false);
    bridgeCall = () => guard.follow('link', { href: '/#thread=T2' });
    click(document.querySelector('#go')!, false);
    (document.querySelector('#go') as HTMLAnchorElement).click();
    await settle();
    expect(sent).toEqual([]);
  });

  test('during a real click, another href or a javascript: link sends nothing', async () => {
    page('<a id="go" href="ok.html">Ok</a><a id="js" href="javascript:void 0">Js</a>');
    bridgeCall = () => guard.follow('link', { href: '/#thread=T2' });
    click(document.querySelector('#go')!);
    bridgeCall = () => guard.follow('link', { href: 'javascript:void 0' });
    click(document.querySelector('#js')!);
    await settle();
    expect(sent).toEqual([]);
  });

  test('once the click is over, the page cannot reuse it', async () => {
    page('<a id="go" href="ok.html">Ok</a>');
    click(document.querySelector('#go')!);
    expect(guard.follow('link', { href: 'ok.html' })).toBe(false);
    await settle();
    expect(sent).toEqual([]);
  });

  test("a form's address goes out only for a press on a submit control, as a query with no fragment", async () => {
    page('<form><input name="q" value="x"><button id="go">Go</button></form><a id="link" href="a.html">A</a>');
    bridgeCall = () => guard.follow('form', { href: 'results.html?q=x' });
    click(document.querySelector('#go')!);
    bridgeCall = () => guard.follow('form', { href: '/#thread=T2' });
    click(document.querySelector('#go')!);
    bridgeCall = () => guard.follow('form', { href: '?q=x' });
    click(document.querySelector('#link')!);
    await settle();
    expect(sent).toEqual([{ type: 'plannotator-bridge-link-click', href: 'results.html?q=x' }]);
  });

  test('a page listener that stops the click first does not hide it from the guard', async () => {
    page('<a id="go" href="ok.html">Ok</a>');
    // The page's own listener runs after the guard's: it stops the click, then calls the guard itself.
    const stop = (event: Event) => {
      event.stopImmediatePropagation();
      guard.follow('link', { href: 'ok.html' });
    };
    window.addEventListener('click', stop, true);
    try {
      click(document.querySelector('#go')!);
    } finally {
      window.removeEventListener('click', stop, true);
    }
    await settle();
    // The guard saw the click first: a real click on that link follows, as the person meant.
    expect(sent).toEqual([{ type: 'plannotator-bridge-link-click', href: 'ok.html' }]);
  });

  test('the page cannot replace the guard, and a second run makes no second offer', () => {
    const w = window as unknown as Record<string, unknown>;
    expect(() => Object.defineProperty(window, '__plannotatorLinkGuard', { value: { follow: () => true } })).toThrow();
    try { w.__plannotatorLinkGuard = { follow: () => true }; } catch { /* strict-mode assignment to a read-only property */ }
    expect(w.__plannotatorLinkGuard).toBe(guard);
    new Function(`${LINK_GUARD_FUNCTION}('${'c'.repeat(32)}');`)();
    expect(offers).toHaveLength(1);
  });
});
