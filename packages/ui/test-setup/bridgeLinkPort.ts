/**
 * Plays the HTML viewer's link guard following a link in a DOM test. The host
 * takes a link-click only on the port the guard offers once per load, with
 * that load's key (linkGuard.ts), never from a window message. The guard does
 * not run in happy-dom's frame, so this reads the load's key where the viewer
 * put it (a served frame's `__pnk`, else the srcdoc's guard), offers a port
 * as the frame once per key, and sends on it.
 */
import { act } from 'react';

const LINK_OFFER = 'plannotator-bridge-link-offer';
const offered = new WeakMap<HTMLIFrameElement, { key: string; port: MessagePort }>();

/** The key of the load in this frame: the served address's, else the srcdoc guard's. */
export function frameLinkKey(frame: HTMLIFrameElement): string | null {
  const src = frame.getAttribute('src');
  if (src) {
    try {
      // happy-dom's window is at about:blank: a served path is read as a path.
      let address: URL;
      try {
        address = new URL(src, window.location.href);
      } catch {
        address = new URL(src, 'http://root-path.invalid/');
      }
      const keys = address.searchParams.getAll('__pnk');
      const fromUrl = keys[keys.length - 1];
      if (fromUrl) return fromUrl;
    } catch {
      // Not an address: fall through to the document's own key.
    }
  }
  return /\)\('([0-9a-f]{32})'\);<\/script>/.exec(frame.getAttribute('srcdoc') ?? '')?.[1] ?? null;
}

/** Offer a port as the frame's guard would, with `key`; returns the end the guard keeps. */
export async function offerLinkPort(frame: HTMLIFrameElement, key: string | null): Promise<MessagePort> {
  const win = frame.contentWindow;
  if (!win) throw new Error('the frame has no window');
  const channel = new MessageChannel();
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', { source: win, data: { type: LINK_OFFER, key }, ports: [channel.port2] }));
  });
  return channel.port1;
}

/** The guard's port for this frame's current load: offered the first time a load is seen. */
export async function bridgeLinkPort(frame: HTMLIFrameElement): Promise<MessagePort> {
  // A served frame (`frameUrl`) gets its address, and so its key, once the host has kept the page.
  let key = frameLinkKey(frame);
  for (let i = 0; !key && i < 40; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    key = frameLinkKey(frame);
  }
  if (!key) {
    const srcdoc = frame.getAttribute('srcdoc');
    throw new Error(`the frame carries no link key (src: ${JSON.stringify(frame.getAttribute('src'))}, srcdoc: ${srcdoc === null ? 'none' : `${srcdoc.length} chars`}, at ${window.location.href})`);
  }
  const had = offered.get(frame);
  if (had && had.key === key) return had.port;
  const port = await offerLinkPort(frame, key);
  offered.set(frame, { key, port });
  return port;
}

/** A person's click on a link in the frame, as the guard reports it: on its port. */
export async function followLinkInFrame(frame: HTMLIFrameElement, href: string): Promise<void> {
  const port = await bridgeLinkPort(frame);
  await act(async () => {
    port.postMessage({ type: 'plannotator-bridge-link-click', href });
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}
