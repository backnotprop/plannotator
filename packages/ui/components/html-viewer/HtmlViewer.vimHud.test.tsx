import { afterEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const htmlViewerModule = hasDom ? await import('./HtmlViewer') : null;

afterEach(() => {
  if (hasDom) document.body.replaceChildren();
});

describe.if(hasDom)('HtmlViewer Vim HUD bridge', () => {
  test('copies only validated Vim text from the focused sandbox', async () => {
    if (!htmlViewerModule) {
      throw new Error('DOM test environment is not registered');
    }
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(
      navigator,
      'clipboard',
    );
    const writes: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          writes.push(text);
        },
      },
    });

    const host = document.createElement('div');
    const outsideButton = document.createElement('button');
    document.body.append(host, outsideButton);
    const root = createRoot(host);

    try {
      await act(async () => {
        root.render(
          <htmlViewerModule.HtmlViewer
            rawHtml="<html><body><p>Raw copy target</p></body></html>"
            annotations={[]}
            onAddAnnotation={() => {}}
            onSelectAnnotation={() => {}}
            selectedAnnotationId={null}
            mode="selection"
            inputMethod="drag"
            vimModeEnabled
            vimHudEnabled={false}
          />,
        );
      });

      const iframe = host.querySelector<HTMLIFrameElement>('iframe');
      if (!iframe?.contentWindow) throw new Error('HTML iframe missing');
      const postCopy = (text: unknown) => {
        window.dispatchEvent(new MessageEvent('message', {
          source: iframe.contentWindow,
          data: {
            type: 'plannotator-bridge-vim-copy',
            text,
          },
        }));
      };

      act(() => outsideButton.focus());
      act(() => postCopy('not focused'));
      expect(writes).toEqual([]);

      act(() => iframe.focus());
      act(() => postCopy('Raw copy target'));
      expect(writes).toEqual(['Raw copy target']);
      expect(document.activeElement).toBe(iframe);

      act(() => postCopy(''));
      act(() => postCopy({ unsafe: true }));
      act(() => postCopy('x'.repeat(2 * 1024 * 1024 + 1)));
      act(() => {
        window.dispatchEvent(new MessageEvent('message', {
          source: window,
          data: {
            type: 'plannotator-bridge-vim-copy',
            text: 'wrong source',
          },
        }));
      });
      expect(writes).toEqual(['Raw copy target']);

      await act(async () => {
        root.render(
          <htmlViewerModule.HtmlViewer
            rawHtml="<html><body><p>Raw copy target</p></body></html>"
            annotations={[]}
            onAddAnnotation={() => {}}
            onSelectAnnotation={() => {}}
            selectedAnnotationId={null}
            mode="selection"
            inputMethod="drag"
            vimModeEnabled={false}
            vimHudEnabled={false}
          />,
        );
      });
      act(() => iframe.focus());
      act(() => postCopy('disabled'));
      expect(writes).toEqual(['Raw copy target']);
    } finally {
      act(() => root.unmount());
      if (clipboardDescriptor) {
        Object.defineProperty(
          navigator,
          'clipboard',
          clipboardDescriptor,
        );
      } else {
        delete (navigator as Navigator & { clipboard?: Clipboard }).clipboard;
      }
    }
  });

  test('renders validated iframe command messages through the shared parent HUD', async () => {
    if (!htmlViewerModule) {
      throw new Error('DOM test environment is not registered');
    }
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <htmlViewerModule.HtmlViewer
          rawHtml="<html><body><p>First</p><p>Second</p></body></html>"
          annotations={[]}
          onAddAnnotation={() => {}}
          onSelectAnnotation={() => {}}
          selectedAnnotationId={null}
          mode="selection"
          inputMethod="pinpoint"
          vimModeEnabled
          vimHudEnabled
        />,
      );
    });

    const iframe = host.querySelector<HTMLIFrameElement>('iframe');
    if (!iframe?.contentWindow) throw new Error('HTML iframe missing');
    act(() => iframe.focus());
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        source: iframe.contentWindow,
        data: {
          type: 'plannotator-bridge-vim-state',
          phase: 'block',
        },
      }));
      window.dispatchEvent(new MessageEvent('message', {
        source: iframe.contentWindow,
        data: {
          type: 'plannotator-bridge-vim-command',
          actionId: 'moveDown',
          key: 'j',
          context: 'block',
        },
      }));
    });

    expect(document.querySelector('[data-vim-key-hud]')).not.toBeNull();
    expect(document.querySelector('[data-vim-hud-active-key="j"]')).not.toBeNull();
    expect(document.querySelector('[data-vim-hud-phase]')?.textContent)
      .toBe('BLOCK / PINPOINT');
    expect(document.querySelector('[data-vim-hud-command]')?.textContent)
      .toBe('Next block');

    const mapToggle = document.querySelector<HTMLButtonElement>(
      '[data-vim-key-map-toggle]',
    );
    act(() => mapToggle?.focus());
    expect(document.activeElement).toBe(mapToggle);
    expect(document.querySelector('[data-vim-key-hud]')).not.toBeNull();

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        source: iframe.contentWindow,
        data: {
          type: 'plannotator-bridge-vim-help',
          open: true,
        },
      }));
    });
    expect(document.querySelector('[data-vim-key-map]')).not.toBeNull();
    expect(document.querySelector('[data-vim-key-hud]')?.getAttribute('data-expanded'))
      .toBe('true');

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        source: iframe.contentWindow,
        data: {
          type: 'plannotator-bridge-vim-help',
          open: false,
        },
      }));
    });
    expect(document.querySelector('[data-vim-key-map]')).toBeNull();

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        source: iframe.contentWindow,
        data: {
          type: 'plannotator-bridge-vim-command',
          actionId: 'not-a-real-action',
          key: 'x',
          context: 'block',
        },
      }));
    });
    expect(document.querySelector('[data-vim-hud-active-key="j"]')).not.toBeNull();

    await act(async () => {
      root.render(
        <htmlViewerModule.HtmlViewer
          rawHtml="<html><body><p>First</p><p>Second</p></body></html>"
          annotations={[]}
          onAddAnnotation={() => {}}
          onSelectAnnotation={() => {}}
          selectedAnnotationId={null}
          mode="selection"
          inputMethod="pinpoint"
          vimModeEnabled
          vimHudEnabled
          vimHudKeyPanelEnabled={false}
        />,
      );
    });
    act(() => iframe.focus());
    expect(document.querySelector('[data-vim-key-hud]')).toBeNull();

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        source: iframe.contentWindow,
        data: {
          type: 'plannotator-bridge-vim-help',
          open: true,
        },
      }));
    });
    expect(document.querySelector('[data-vim-key-hud]')).not.toBeNull();
    expect(document.querySelector('[data-vim-key-map]')).not.toBeNull();

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        source: iframe.contentWindow,
        data: {
          type: 'plannotator-bridge-vim-help',
          open: false,
        },
      }));
    });
    expect(document.querySelector('[data-vim-key-hud]')).toBeNull();

    await act(async () => {
      root.render(
        <htmlViewerModule.HtmlViewer
          rawHtml="<html><body><p>First</p><p>Second</p></body></html>"
          annotations={[]}
          onAddAnnotation={() => {}}
          onSelectAnnotation={() => {}}
          selectedAnnotationId={null}
          mode="selection"
          inputMethod="pinpoint"
          vimModeEnabled
          vimHudEnabled={false}
        />,
      );
    });
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        source: iframe.contentWindow,
        data: {
          type: 'plannotator-bridge-vim-command',
          actionId: 'moveUp',
          key: 'k',
          context: 'block',
        },
      }));
    });
    expect(document.querySelector('[data-vim-key-hud]')).toBeNull();

    act(() => root.unmount());
  });
});
