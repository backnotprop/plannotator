/**
 * HtmlViewer `inline` (DOM-gated): the page drawn in the host's own text,
 * with none of the viewer's chrome (the Plannotator Inbox's live html blocks,
 * commented in place).
 *
 * Guards: without the prop the viewer is drawn exactly as before (its card,
 * the bar with the global Comment button, the armed ring, a frame as tall as
 * the bridge reports); with it the card, the bar and the ring are gone, the
 * frame is as tall as the host says whatever the bridge reports, and it
 * carries the host's color-scheme on a transparent background (a page with a
 * transparent background would otherwise sit on an opaque backdrop).
 *
 * Also: Escape with Annotate on is used only in the host's text (an attached
 * page's Escape is as before), and a viewer that did not ask for structural
 * anchors drops one a page posts and asks for none on restore.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { HtmlViewerInline } from './HtmlViewer';

const hasDom = typeof document !== 'undefined';
const htmlViewerModule = hasDom ? await import('./HtmlViewer') : null;
const bridgeModule = hasDom ? await import('./bridge-script') : null;

const mountedRoots: Array<{ unmount: () => void }> = [];

afterEach(async () => {
  if (!hasDom) return;
  await act(async () => {
    for (const root of mountedRoots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
});

const PAGE = '<html><head><title>t</title></head><body><p id="target">Target</p></body></html>';

async function mount(inline?: HtmlViewerInline, fullViewport = false, more: Partial<React.ComponentProps<NonNullable<typeof htmlViewerModule>['HtmlViewer']>> = {}): Promise<HTMLElement> {
  const HtmlViewer = htmlViewerModule!.HtmlViewer;
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedRoots.push(root);
  await act(async () => {
    root.render(
      <HtmlViewer
        rawHtml={PAGE}
        annotations={[]}
        onAddAnnotation={() => {}}
        onSelectAnnotation={() => {}}
        selectedAnnotationId={null}
        mode="selection"
        inputMethod="pinpoint"
        annotateModeActive
        onAnnotateModeExit={() => {}}
        inline={inline}
        fullViewport={fullViewport}
        {...more}
      />,
    );
  });
  return host;
}

const resize = (frame: HTMLIFrameElement, height: number) =>
  act(async () => {
    window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { type: 'plannotator-bridge-resize', height } }));
  });
const globalComment = (host: HTMLElement) => host.querySelector('button[title="Add global comment"]');

describe.if(hasDom)('HtmlViewer inline', () => {
  test('absent: the card, the bar, the armed ring and the bridge-sized frame, as before', async () => {
    const host = await mount();
    const article = host.querySelector('article')!;
    expect(article.className).toBe('relative bg-card rounded-xl shadow-xl overflow-hidden w-full');
    expect(globalComment(host)).not.toBeNull();
    expect(host.querySelector('[data-annotate-armed-ring]')).not.toBeNull();
    const frame = host.querySelector('iframe')!;
    expect(frame.style.height).toBe('600px');
    expect(frame.style.colorScheme).toBe('auto');
    expect(frame.style.background).toBe('');
    await resize(frame, 321);
    expect(frame.style.height).toBe('321px');
  });

  test("present: no chrome of the viewer's own, and the frame is as tall as the host says", async () => {
    const host = await mount({ height: 240, colorScheme: 'dark' });
    const article = host.querySelector('article')!;
    expect(article.className).toBe('relative overflow-hidden w-full');
    expect(globalComment(host)).toBeNull();
    expect(host.querySelector('[data-annotate-armed-ring]')).toBeNull();
    const frame = host.querySelector('iframe')!;
    expect(frame.style.height).toBe('240px');
    expect(frame.style.colorScheme).toBe('dark');
    expect(frame.style.background).toBe('transparent');
    // The host measures the page itself: the bridge's own measure does not move the frame.
    await resize(frame, 999);
    expect(frame.style.height).toBe('240px');
    // Still the viewer's frame: sandboxed, with the document and its bridge.
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-modals');
    expect(frame.getAttribute('srcdoc')).toContain('<p id="target">Target</p>');
  });

  test('with no color-scheme named the frame keeps auto, and full-viewport ignores the prop', async () => {
    const plain = await mount({ height: 100 });
    expect(plain.querySelector('iframe')!.style.colorScheme).toBe('auto');
    const full = await mount({ height: 100, colorScheme: 'dark' }, true);
    const frame = full.querySelector('iframe')!;
    expect(frame.style.height).toBe('100%');
    expect(frame.style.colorScheme).toBe('auto');
    expect(full.querySelector('article')!.className).toBe('relative overflow-hidden w-full flex-1');
  });

  test('Escape with Annotate on: used (and first) in the host\'s text; in an attached page it exits Annotate and is left as it was', async () => {
    const press = async () => {
      const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      await act(async () => {
        document.body.dispatchEvent(event);
      });
      return event;
    };
    let exits = 0;
    await mount({ height: 240 }, false, { onAnnotateModeExit: () => (exits += 1) });
    expect((await press()).defaultPrevented).toBe(true);
    expect(exits).toBe(1);
    await act(async () => {
      for (const root of mountedRoots.splice(0)) root.unmount();
    });
    await mount(undefined, false, { onAnnotateModeExit: () => (exits += 1) });
    expect((await press()).defaultPrevented).toBe(false);
    expect(exits).toBe(2);
  });

  test("Escape in the host's text steps aside while the host has something open anywhere (focus on the page's body): the host's own Escape gets it", async () => {
    let exits = 0;
    let hostSaw = 0;
    const hostListener = () => void (hostSaw += 1);
    window.addEventListener('keydown', hostListener);
    try {
      await mount({ height: 240 }, false, { onAnnotateModeExit: () => (exits += 1) });
      const press = async () => {
        const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
        await act(async () => {
          document.body.dispatchEvent(event);
        });
        return event;
      };
      const overlays = [
        '<div role="dialog">Sheet</div>',
        '<div role="menu"></div>',
        '<div role="listbox"></div>',
        '<div aria-modal="true"></div>',
        '<dialog open>Open</dialog>',
        '<button aria-haspopup="menu" aria-expanded="true">More</button>',
      ];
      for (const markup of overlays) {
        const holder = document.createElement('div');
        holder.innerHTML = markup;
        document.body.appendChild(holder);
        const event = await press();
        expect(event.defaultPrevented).toBe(false);
        holder.remove();
      }
      expect(exits).toBe(0);
      expect(hostSaw).toBe(overlays.length);
      // Nothing open: the pen goes off and the host's Escape does not also run.
      expect((await press()).defaultPrevented).toBe(true);
      expect(exits).toBe(1);
      expect(hostSaw).toBe(overlays.length);
    } finally {
      window.removeEventListener('keydown', hostListener);
    }
  });

  test("an Ask AI window or a floating draft open beside the text, focus not in it: Escape still turns the pen off and is used; with focus in it, it is the window's", async () => {
    let exits = 0;
    await mount({ height: 240 }, false, { onAnnotateModeExit: () => (exits += 1) });
    const press = async (from: Element = document.body) => {
      const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      await act(async () => {
        from.dispatchEvent(event);
      });
      return event;
    };
    const sides = [
      '<aside aria-label="Ask AI: the chart" data-chat-window data-popover-layer data-ask-window="t1"><button>Send</button></aside>',
      '<div role="dialog" aria-modal="true" aria-label="Draft reply" data-popover-layer data-chat-window><textarea></textarea><button>Minimize</button></div>',
    ];
    for (const markup of sides) {
      const holder = document.createElement('div');
      holder.innerHTML = markup;
      document.body.appendChild(holder);
      const before = exits;
      // Open, unfocused: the pen goes off.
      (document.activeElement as HTMLElement | null)?.blur?.();
      expect((await press()).defaultPrevented).toBe(true);
      expect(exits).toBe(before + 1);
      // Focus in it: its Escape.
      const button = holder.querySelector('button')!;
      button.focus();
      expect((await press(button)).defaultPrevented).toBe(false);
      expect(exits).toBe(before + 1);
      button.blur();
      holder.remove();
    }
  });

  test('structural anchors are opt-in: without the prop a posted one is dropped and restore is not flagged', async () => {
    const structure = { path: [1, 0], ns: 'http://www.w3.org/1999/xhtml', attrs: [['class', 'bar']] };
    const saved = { id: 'a1', blockId: '', startOffset: 0, endOffset: 0, type: 'COMMENT', text: 'w', originalText: '[element: bar]', createdA: 1, htmlAnchor: { selector: 'div', tagName: 'div', structure } };
    for (const asked of [false, true]) {
      const added: Array<{ htmlAnchor?: unknown }> = [];
      const host = await mount({ height: 240 }, false, { structuralAnchors: asked, annotations: [saved as never], onAddAnnotation: (annotation) => void added.push(annotation) });
      const frame = host.querySelector('iframe')!;
      const posted: Record<string, unknown>[] = [];
      frame.contentWindow!.postMessage = ((message: Record<string, unknown>) => void posted.push(message)) as never;
      const say = (data: unknown) => act(async () => {
        window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data }));
      });
      await say({ type: 'plannotator-bridge-ready', protocolVersion: bridgeModule!.BRIDGE_PROTOCOL_VERSION });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)); });
      const mark = posted.find((message) => message.type === 'plannotator-bridge-find-and-mark')!;
      expect(mark.structural).toBe(asked ? true : undefined);
      expect(posted.some((message) => message.type === 'plannotator-bridge-set-structural-anchors')).toBe(asked);
      await say({ type: 'plannotator-bridge-selection', text: '[element: bar]', rect: { top: 10, left: 10, width: 20, height: 20 }, pinpoint: true, anchor: { selector: 'div', tagName: 'div', structure } });
      const box = document.querySelector<HTMLTextAreaElement>('[data-comment-popover] textarea')!;
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(box), 'value')?.set;
      await act(async () => {
        setter!.call(box, 'Words.');
        box.dispatchEvent(new Event('input', { bubbles: true }));
      });
      const button = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-comment-popover] button')).find((b) => b.textContent === 'Save' || b.textContent === 'Comment')!;
      await act(async () => button.click());
      expect(added.length).toBe(1);
      expect(added[0]!.htmlAnchor).toEqual(asked ? { selector: 'div', tagName: 'div', structure } : undefined);
      await act(async () => {
        for (const root of mountedRoots.splice(0)) root.unmount();
      });
      document.body.replaceChildren();
    }
  });
  test('only a viewer in the host\'s text asks for markers above their element and rings its pin: an attached page keeps both as they were', async () => {
    for (const inline of [undefined, { height: 240 }]) {
      const host = await mount(inline);
      const frame = host.querySelector('iframe')!;
      const posted: Record<string, unknown>[] = [];
      frame.contentWindow!.postMessage = ((message: Record<string, unknown>) => void posted.push(message)) as never;
      await act(async () => {
        window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { type: 'plannotator-bridge-ready', protocolVersion: bridgeModule!.BRIDGE_PROTOCOL_VERSION } }));
      });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)); });
      const asked = posted.filter((message) => message.type === 'plannotator-bridge-set-markers-above');
      expect(asked).toEqual(inline ? [{ type: 'plannotator-bridge-set-markers-above', active: true }] : []);
      expect((frame.getAttribute('srcdoc') ?? '').includes('outline-offset:2px')).toBe(!!inline);
      await act(async () => {
        for (const root of mountedRoots.splice(0)) root.unmount();
      });
      document.body.replaceChildren();
    }
  });
});
