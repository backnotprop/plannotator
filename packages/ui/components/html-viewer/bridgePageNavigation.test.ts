/**
 * The bridge's `pageNavigation` opt-in (the Inbox's attached pages and
 * prototypes): a page's own forms and in-page links work as in a tab.
 *
 * The frame's sandbox has no `allow-forms`, so a press on a submit button
 * neither fires `submit` nor submits: a prototype's search box or filter form
 * did nothing. With the opt-in the bridge fires `submit` (the page's handlers
 * run and may cancel it) and hands a GET form to the host as a link with the
 * fields as its query. An in-page `#` link also sets the page's own hash and
 * fires `hashchange`, so a page that routes on its hash (tabs, steps)
 * follows it.
 *
 * These evaluate the SHIPPED functions out of the bridge's string against a
 * happy-dom document. Guards: nothing before the host opts in, in Annotate or
 * for a script's click; a cancelled click or submit wins; GET only; the
 * submitter's name and value and `formaction` count; an invalid form posts
 * nothing; a fragment fires `hashchange` once and only when it changed.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { BRIDGE_SCRIPT } from './bridge-script';

const hasDom = typeof document !== 'undefined';

function extractFunction(name: string): string {
  const start = BRIDGE_SCRIPT.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`bridge no longer defines ${name}`);
  let depth = 0;
  for (let i = BRIDGE_SCRIPT.indexOf('{', start); i < BRIDGE_SCRIPT.length; i += 1) {
    if (BRIDGE_SCRIPT[i] === '{') depth += 1;
    else if (BRIDGE_SCRIPT[i] === '}') {
      depth -= 1;
      if (depth === 0) return BRIDGE_SCRIPT.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces around ${name}`);
}

interface Bridge {
  submit: (e: FakeClick) => void;
  fragment: (hash: string) => void;
  posted: Array<Record<string, unknown>>;
}

interface FakeClick {
  target: EventTarget | null;
  button: number;
  isTrusted: boolean;
  defaultPrevented: boolean;
  preventDefault: () => void;
}

function bridge(options: { optedIn?: boolean; armed?: boolean } = {}): Bridge {
  const posted: Array<Record<string, unknown>> = [];
  const api = new Function(
    'PREFIX',
    'postToParent',
    'pageNavigation',
    'annotateModeActive',
    `${extractFunction('submitterOf')}
     ${extractFunction('submitPageForm')}
     ${extractFunction('setOwnFragment')}
     return { submit: submitPageForm, fragment: setOwnFragment };`,
  )('plannotator-bridge-', (m: Record<string, unknown>) => posted.push(m), options.optedIn ?? true, options.armed ?? false);
  return { ...api, posted };
}

/** A person's left click on `target` (`isTrusted` as the browser sets it for a real press). */
function press(target: Element, overrides: Partial<FakeClick> = {}): FakeClick {
  const click: FakeClick = {
    target,
    button: 0,
    isTrusted: true,
    defaultPrevented: false,
    preventDefault: () => {
      click.defaultPrevented = true;
    },
    ...overrides,
  };
  return click;
}

function page(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
}

const links = (b: Bridge) => b.posted.map((m) => (m.type === 'plannotator-bridge-link-click' ? m.href : m));

afterEach(() => {
  if (hasDom) document.body.replaceChildren();
});

describe.if(hasDom)('a form submit, with the host opted in', () => {
  test('a GET form with no action: its fields become a query for the page itself; the press stops the browser', () => {
    const p = page('<form><input name="who" value="ada"><input name="n" value="3"><button id="go">Go</button></form>');
    const b = bridge();
    const click = press(p.querySelector('#go')!);
    b.submit(click);
    expect(links(b)).toEqual(['?who=ada&n=3']);
    expect(click.defaultPrevented).toBe(true);
  });

  test("the page's own submit handler runs, and one that cancels wins", () => {
    const p = page('<form id="f"><input name="q" value="shoes"><button id="go" type="submit">Search</button></form>');
    const seen: string[] = [];
    p.querySelector('#f')!.addEventListener('submit', (e) => {
      seen.push('submit');
      e.preventDefault();
    });
    const b = bridge();
    b.submit(press(p.querySelector('#go')!));
    expect(seen).toEqual(['submit']);
    expect(b.posted).toEqual([]);
  });

  test("an action names the page to go to; the submitter's formaction and its own name and value count", () => {
    const p = page(
      '<form action="results.html?old=1#x"><input name="q" value="a b"><button id="go">Go</button>' +
        '<button id="alt" name="view" value="grid" formaction="grid.html">Grid</button></form>',
    );
    const b = bridge();
    b.submit(press(p.querySelector('#go')!));
    b.submit(press(p.querySelector('#alt')!));
    expect(links(b)).toEqual(['results.html?q=a+b', 'grid.html?q=a+b&view=grid']);
  });

  test('a POST form, a plain button, an invalid form or a disabled button posts no link', () => {
    const p = page(
      '<form method="post"><input name="a" value="1"><button id="post">Post</button></form>' +
        '<form><button id="plain" type="button">Plain</button></form>' +
        '<form><input name="need" required><button id="invalid">Go</button></form>' +
        '<form><button id="off" disabled>Off</button></form>',
    );
    const b = bridge();
    for (const id of ['post', 'plain', 'invalid', 'off']) b.submit(press(p.querySelector(`#${id}`)!));
    expect(b.posted).toEqual([]);
  });

  test("not before the host opts in, not in Annotate (a press pins), not for a script's click, not for a click the page cancelled", () => {
    const html = '<form><input name="a" value="1"><button id="go">Go</button></form>';
    for (const [b, overrides] of [
      [bridge({ optedIn: false }), {}],
      [bridge({ armed: true }), {}],
      [bridge(), { isTrusted: false }],
      [bridge(), { defaultPrevented: true }],
      [bridge(), { button: 1 }],
    ] as const) {
      const p = page(html);
      const click = press(p.querySelector('#go')!, overrides);
      b.submit(click);
      expect(b.posted).toEqual([]);
      p.remove();
    }
  });
});

describe.if(hasDom)('an in-page link sets the hash', () => {
  test('the hash changes and hashchange fires once, with the old and new address', () => {
    const b = bridge();
    const start = location.href.split('#')[0];
    history.replaceState(null, '', start);
    const fired: Array<{ oldURL: string; newURL: string }> = [];
    const onChange = (e: Event) => fired.push({ oldURL: (e as HashChangeEvent).oldURL, newURL: (e as HashChangeEvent).newURL });
    window.addEventListener('hashchange', onChange);
    try {
      b.fragment('#step-2');
      expect(location.hash).toBe('#step-2');
      // The same fragment again changes nothing and fires nothing.
      b.fragment('#step-2');
      expect(fired).toEqual([{ oldURL: start, newURL: `${start}#step-2` }]);
    } finally {
      window.removeEventListener('hashchange', onChange);
      history.replaceState(null, '', start);
    }
  });
});
