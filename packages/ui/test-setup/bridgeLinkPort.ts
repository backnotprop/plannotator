/**
 * Plays the HTML viewer's bridge following a link in a DOM test. The host takes
 * a link-click only on the private port it hands the bridge after a ready
 * (bridge-script.ts, "Private link channel"), never from a window message. The
 * bridge does not run in happy-dom's frame, and happy-dom's window.postMessage
 * drops transferred ports, so this posts the ready as the frame, reads the
 * port the host hands over from the frame's postMessage, and sends on it.
 */
import { act } from 'react';
import { BRIDGE_PROTOCOL_VERSION } from '../components/html-viewer/bridge-script';

const LINK_PORT = 'plannotator-bridge-link-port';
const handed = new WeakMap<Window, MessagePort[]>();

function portsOf(win: Window): MessagePort[] {
  let ports = handed.get(win);
  if (ports) return ports;
  ports = [];
  handed.set(win, ports);
  const list = ports;
  const deliver = win.postMessage.bind(win) as (data: unknown, origin: string) => void;
  win.postMessage = ((data: unknown, origin: string, transfer?: Transferable[]) => {
    if ((data as { type?: unknown } | null)?.type === LINK_PORT && transfer?.[0]) list.push(transfer[0] as MessagePort);
    deliver(data, origin);
  }) as typeof win.postMessage;
  return ports;
}

/** The port the host handed this frame's bridge: after a ready posted as the frame, the first time. */
export async function bridgeLinkPort(frame: HTMLIFrameElement): Promise<MessagePort> {
  const win = frame.contentWindow;
  if (!win) throw new Error('the frame has no window');
  const ports = portsOf(win);
  if (ports.length === 0) {
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', { source: win, data: { type: 'plannotator-bridge-ready', protocolVersion: BRIDGE_PROTOCOL_VERSION } }));
    });
  }
  const port = ports[ports.length - 1];
  if (!port) throw new Error('the host handed the frame no link port on ready');
  return port;
}

/** A person's click on a link in the frame, as the bridge reports it: on the host's port. */
export async function followLinkInFrame(frame: HTMLIFrameElement, href: string): Promise<void> {
  const port = await bridgeLinkPort(frame);
  await act(async () => {
    port.postMessage({ type: 'plannotator-bridge-link-click', href });
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}
