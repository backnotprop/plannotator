/**
 * A host that loads the bridge as an external script (`bridge-script.asset.js`,
 * the same code as BRIDGE_SCRIPT) and builds the frame's document itself puts
 * this load's key on the script tag: `data-plannotator-link-key`. The bridge
 * reads it from its own tag (`document.currentScript`) and installs the link
 * guard with it.
 *
 * Guards: with the key on its tag, the bridge installs the guard, which offers
 * the host one port with that key, and a person's click on a link goes out on
 * that port, never on the window.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 * Its own file: the guard it installs cannot be removed from the window.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { BRIDGE_SCRIPT } from './bridge-script';

const hasDom = typeof document !== 'undefined';
const KEY = '0123456789abcdef0123456789abcdef';

describe.if(hasDom)('the bridge loaded by URL, with the key on its tag', () => {
  const offers: Array<{ data: Record<string, unknown>; transfer: Transferable[] | undefined }> = [];
  const onPort: Array<Record<string, unknown>> = [];
  const onWindow: unknown[] = [];
  let realParent: PropertyDescriptor | undefined;
  let realCurrentScript: PropertyDescriptor | undefined;
  const windowListener = (event: MessageEvent) => onWindow.push(event.data);

  beforeAll(async () => {
    realParent = Object.getOwnPropertyDescriptor(window, 'parent');
    realCurrentScript = Object.getOwnPropertyDescriptor(document, 'currentScript');
    const host = {
      postMessage(data: Record<string, unknown>, _origin: string, transfer?: Transferable[]) {
        if (data && data.type === 'plannotator-bridge-link-offer') offers.push({ data, transfer });
        else onWindow.push(data);
      },
    };
    Object.defineProperty(window, 'parent', { value: host, configurable: true });
    // The tag the host wrote: <script src=".../bridge-script.asset.js" data-plannotator-link-key="<key>">.
    const tag = document.createElement('script');
    tag.setAttribute('src', 'https://host.example/assets/bridge-script.asset.js');
    tag.setAttribute('data-plannotator-link-key', KEY);
    Object.defineProperty(document, 'currentScript', { value: tag, configurable: true });
    try {
      new Function(BRIDGE_SCRIPT)();
    } finally {
      if (realCurrentScript) Object.defineProperty(document, 'currentScript', realCurrentScript);
      else delete (document as unknown as { currentScript?: unknown }).currentScript;
    }
    window.addEventListener('message', windowListener);
    const port = offers[0]?.transfer?.[0] as MessagePort | undefined;
    if (port) port.onmessage = (event) => onPort.push(event.data as Record<string, unknown>);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  afterAll(() => {
    window.removeEventListener('message', windowListener);
    if (realParent) Object.defineProperty(window, 'parent', realParent);
  });

  test('the bridge installs the guard, which offers the host one port with that key', () => {
    expect(offers).toHaveLength(1);
    expect(offers[0]!.data).toEqual({ type: 'plannotator-bridge-link-offer', key: KEY });
    expect(offers[0]!.transfer).toHaveLength(1);
    expect(typeof (window as unknown as { __plannotatorLinkGuard?: { follow?: unknown } }).__plannotatorLinkGuard?.follow).toBe('function');
  });

  test("a person's click on a link goes out on that port, never on the window", async () => {
    document.body.innerHTML = '<a id="next" href="next.html">Next</a>';
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    Object.defineProperty(click, 'isTrusted', { value: true });
    document.querySelector('#next')!.dispatchEvent(click);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onPort).toEqual([{ type: 'plannotator-bridge-link-click', href: 'next.html' }]);
    expect(onWindow.filter((data) => (data as { type?: string } | null)?.type === 'plannotator-bridge-link-click')).toEqual([]);
  });
});
