/**
 * Bridge-protocol contract for HTML pinpoint mode (DOM-gated).
 *
 * The bridge script runs inside a sandboxed iframe rendering arbitrary HTML,
 * so everything it posts must be validated and size-capped before it reaches
 * React state or the annotation model. These tests cover the pinpoint
 * additions: the element-anchor DTO, the pinpoint click-to-pin flow (straight
 * to the comment composer, skipping the toolbar), and anchor propagation onto
 * created annotations.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Annotation } from '../../types';

const hasDom = typeof document !== 'undefined';
const hookModule = hasDom ? await import('./useHtmlAnnotation') : null;
const htmlViewerModule = hasDom ? await import('./HtmlViewer') : null;

// Unmount every root before clearing the DOM: leaving HtmlViewer instances
// mounted would keep their window message listeners alive and leak into other
// test files sharing this process.
const mountedRoots: Array<{ unmount: () => void }> = [];

afterEach(async () => {
  if (!hasDom) return;
  await act(async () => {
    for (const root of mountedRoots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
});

describe.if(hasDom)('parseHtmlElementAnchor (validated DTO)', () => {
  test('accepts a well-formed anchor', () => {
    expect(hookModule!.parseHtmlElementAnchor({
      selector: '#hero > p:nth-of-type(2)',
      tagName: 'p',
      text: 'Some text',
    })).toEqual({ selector: '#hero > p:nth-of-type(2)', tagName: 'p', text: 'Some text' });
  });

  test('accepts an anchor without a text snapshot', () => {
    expect(hookModule!.parseHtmlElementAnchor({ selector: 'main', tagName: 'main' }))
      .toEqual({ selector: 'main', tagName: 'main' });
  });

  test('accepts an empty text snapshot (stable-identity text-less anchors)', () => {
    // Text-less elements anchor only through a stable-identity selector
    // (#id / data-* identity attrs) and carry an empty snapshot; the bridge
    // treats an empty snapshot on a WEAK selector as a rejection at restore
    // time, so passing it through the DTO is safe.
    expect(hookModule!.parseHtmlElementAnchor({
      selector: 'span[data-testid="close-btn"]',
      tagName: 'span',
      text: '',
    })).toEqual({ selector: 'span[data-testid="close-btn"]', tagName: 'span', text: '' });
  });

  test('rejects non-records and missing/empty fields', () => {
    expect(hookModule!.parseHtmlElementAnchor(null)).toBeNull();
    expect(hookModule!.parseHtmlElementAnchor('main')).toBeNull();
    expect(hookModule!.parseHtmlElementAnchor({})).toBeNull();
    expect(hookModule!.parseHtmlElementAnchor({ selector: '', tagName: 'p' })).toBeNull();
    expect(hookModule!.parseHtmlElementAnchor({ selector: 'p' })).toBeNull();
    expect(hookModule!.parseHtmlElementAnchor({ selector: 'p', tagName: 42 })).toBeNull();
  });

  test('rejects oversized fields (size caps)', () => {
    expect(hookModule!.parseHtmlElementAnchor({
      selector: 'x'.repeat(1025),
      tagName: 'p',
    })).toBeNull();
    expect(hookModule!.parseHtmlElementAnchor({
      selector: 'p',
      tagName: 'x'.repeat(65),
    })).toBeNull();
    expect(hookModule!.parseHtmlElementAnchor({
      selector: 'p',
      tagName: 'p',
      text: 'x'.repeat(401),
    })).toBeNull();
  });

  test('carries a valid normalized marker point through validation', () => {
    expect(hookModule!.parseHtmlElementAnchor({
      selector: '#geo',
      tagName: 'div',
      point: { x: 0.25, y: 0.5 },
    })).toEqual({ selector: '#geo', tagName: 'div', point: { x: 0.25, y: 0.5 } });
  });

  test('clamps out-of-range point values into 0..1', () => {
    expect(hookModule!.parseHtmlElementAnchor({
      selector: '#geo',
      tagName: 'div',
      point: { x: 7, y: -3 },
    })).toEqual({ selector: '#geo', tagName: 'div', point: { x: 1, y: 0 } });
  });

  test('drops a malformed point without rejecting the anchor it rides on', () => {
    for (const point of [
      { x: 'left', y: 0.5 },
      { x: Infinity, y: 0.5 },
      { x: NaN, y: 0.5 },
      { x: 0.5 },
      'center',
      42,
      null,
    ]) {
      const parsed = hookModule!.parseHtmlElementAnchor({
        selector: '#geo',
        tagName: 'div',
        point,
      });
      expect(parsed).toEqual({ selector: '#geo', tagName: 'div' });
      expect((parsed as { point?: unknown }).point).toBeUndefined();
    }
  });
});

describe.if(hasDom)('parseBridgeMessage selection additions', () => {
  const rect = { top: 10, left: 10, width: 100, height: 20 };

  test('carries a validated anchor and the pinpoint flag', () => {
    const parsed = hookModule!.parseBridgeMessage({
      type: 'plannotator-bridge-selection',
      text: 'Hello',
      rect,
      anchor: { selector: 'p.intro', tagName: 'p', text: 'Hello' },
      pinpoint: true,
    });
    expect(parsed).toMatchObject({
      text: 'Hello',
      pinpoint: true,
      anchor: { selector: 'p.intro', tagName: 'p', text: 'Hello' },
    });
  });

  test('a malformed anchor is dropped without rejecting the selection', () => {
    const parsed = hookModule!.parseBridgeMessage({
      type: 'plannotator-bridge-selection',
      text: 'Hello',
      rect,
      anchor: { selector: 42 },
      pinpoint: 'yes',
    });
    expect(parsed).toMatchObject({ text: 'Hello', pinpoint: false });
    expect((parsed as { anchor?: unknown }).anchor).toBeUndefined();
  });

  test('truncation never splits a surrogate pair at the cap boundary', () => {
    // An astral character straddling the cut would leave a lone high
    // surrogate that turns into U+FFFD once UTF-8-encoded (drafts, feedback,
    // share URLs) — the cut must back off one unit instead.
    const cap = hookModule!.MAX_SELECTION_TEXT_LENGTH;
    const straddling = 'x'.repeat(cap - 1) + '\u{1F600}' + 'tail';
    const parsed = hookModule!.parseBridgeMessage({
      type: 'plannotator-bridge-selection',
      text: straddling,
      rect,
    }) as { text: string };
    expect(parsed.text.length).toBe(cap - 1);
    expect(parsed.text.endsWith('x')).toBe(true);
    expect(/[\uD800-\uDBFF]$/.test(parsed.text)).toBe(false);
    // A pair that fits entirely under the cap is untouched.
    const fitting = 'y'.repeat(cap - 2) + '\u{1F600}';
    const kept = hookModule!.parseBridgeMessage({
      type: 'plannotator-bridge-selection',
      text: fitting,
      rect,
    }) as { text: string };
    expect(kept.text).toBe(fitting);
  });

  test('selection text is truncated at the parse boundary, not rejected', () => {
    // The page controls element text entirely, so one pinpoint click on a huge
    // <pre> could otherwise ship an unbounded string into React state, drafts,
    // exported feedback, and share URLs.
    const cap = hookModule!.MAX_SELECTION_TEXT_LENGTH;
    const parsed = hookModule!.parseBridgeMessage({
      type: 'plannotator-bridge-selection',
      text: 'x'.repeat(cap + 590_000),
      rect,
    });
    expect(parsed).not.toBeNull();
    expect((parsed as { text: string }).text.length).toBe(cap);
    // At or under the cap passes through untouched.
    const exact = hookModule!.parseBridgeMessage({
      type: 'plannotator-bridge-selection',
      text: 'y'.repeat(cap),
      rect,
    });
    expect((exact as { text: string }).text).toBe('y'.repeat(cap));
  });
});

describe.if(hasDom)('pinpoint click-to-pin flow', () => {
  async function mountViewer(options: {
    mode: 'selection' | 'redline';
    onAdd: (ann: Annotation) => void;
  }) {
    if (!htmlViewerModule) throw new Error('DOM test environment is not registered');
    const HtmlViewer = htmlViewerModule.HtmlViewer;
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    mountedRoots.push(root);
    await act(async () => {
      root.render(
        <HtmlViewer
          rawHtml="<html><body><p>Pinpoint target</p></body></html>"
          annotations={[]}
          onAddAnnotation={options.onAdd}
          onSelectAnnotation={() => {}}
          selectedAnnotationId={null}
          mode={options.mode}
          inputMethod="pinpoint"
        />,
      );
    });
    const iframe = host.querySelector<HTMLIFrameElement>('iframe');
    if (!iframe?.contentWindow) throw new Error('HTML iframe missing');
    const postSelection = async (data: Record<string, unknown>) => {
      await act(async () => {
        window.dispatchEvent(new MessageEvent('message', {
          source: iframe.contentWindow,
          data,
        }));
      });
    };
    return { postSelection };
  }

  const selectionMessage = {
    type: 'plannotator-bridge-selection',
    text: 'Pinpoint target',
    rect: { top: 10, left: 10, width: 120, height: 24 },
    anchor: { selector: 'p:nth-of-type(1)', tagName: 'p', text: 'Pinpoint target' },
  };

  test('a pinpoint selection opens the comment composer, not the toolbar', async () => {
    const { postSelection } = await mountViewer({ mode: 'selection', onAdd: () => {} });
    await postSelection({ ...selectionMessage, pinpoint: true });
    expect(document.querySelector('[data-comment-popover]')).not.toBeNull();
    expect(document.querySelector('.annotation-toolbar')).toBeNull();
  });

  test('a plain drag selection still opens the markup toolbar', async () => {
    const { postSelection } = await mountViewer({ mode: 'selection', onAdd: () => {} });
    await postSelection({ ...selectionMessage, anchor: undefined });
    expect(document.querySelector('.annotation-toolbar')).not.toBeNull();
    expect(document.querySelector('[data-comment-popover]')).toBeNull();
  });

  test('redline pinpoint commits an annotation carrying the element anchor', async () => {
    const added: Annotation[] = [];
    const { postSelection } = await mountViewer({
      mode: 'redline',
      onAdd: (ann) => added.push(ann),
    });
    await postSelection({ ...selectionMessage, pinpoint: true });
    expect(added.length).toBe(1);
    expect(added[0]!.originalText).toBe('Pinpoint target');
    expect(added[0]!.htmlAnchor).toEqual({
      selector: 'p:nth-of-type(1)',
      tagName: 'p',
      text: 'Pinpoint target',
    });
  });

  test('a selection with a malformed anchor commits without one', async () => {
    const added: Annotation[] = [];
    const { postSelection } = await mountViewer({
      mode: 'redline',
      onAdd: (ann) => added.push(ann),
    });
    await postSelection({
      ...selectionMessage,
      anchor: { selector: 'x'.repeat(2000), tagName: 'p' },
      pinpoint: true,
    });
    expect(added.length).toBe(1);
    expect(added[0]!.htmlAnchor).toBeUndefined();
  });

  test('the anchor point (selected relative point) rides onto the committed annotation', async () => {
    const added: Annotation[] = [];
    const { postSelection } = await mountViewer({
      mode: 'redline',
      onAdd: (ann) => added.push(ann),
    });
    await postSelection({
      ...selectionMessage,
      anchor: { ...selectionMessage.anchor, point: { x: 0.75, y: 0.1 } },
      pinpoint: true,
    });
    expect(added.length).toBe(1);
    expect(added[0]!.htmlAnchor?.point).toEqual({ x: 0.75, y: 0.1 });
  });

  test('a hostile anchor point is dropped while the anchor itself commits', async () => {
    const added: Annotation[] = [];
    const { postSelection } = await mountViewer({
      mode: 'redline',
      onAdd: (ann) => added.push(ann),
    });
    await postSelection({
      ...selectionMessage,
      anchor: { ...selectionMessage.anchor, point: { x: 'evil', y: [1] } },
      pinpoint: true,
    });
    expect(added.length).toBe(1);
    expect(added[0]!.htmlAnchor).toEqual({
      selector: 'p:nth-of-type(1)',
      tagName: 'p',
      text: 'Pinpoint target',
    });
    expect(added[0]!.htmlAnchor?.point).toBeUndefined();
  });
});

describe.if(hasDom)('ordered saved-annotation sync (placed-marker numbering)', () => {
  async function mountWithAnnotations(annotations: Annotation[]) {
    if (!htmlViewerModule) throw new Error('DOM test environment is not registered');
    const HtmlViewer = htmlViewerModule.HtmlViewer;
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    mountedRoots.push(root);
    await act(async () => {
      root.render(
        <HtmlViewer
          rawHtml="<html><body><p>Sync target</p></body></html>"
          annotations={annotations}
          onAddAnnotation={() => {}}
          onSelectAnnotation={() => {}}
          selectedAnnotationId={null}
          mode="selection"
          inputMethod="pinpoint"
        />,
      );
    });
    const iframe = host.querySelector<HTMLIFrameElement>('iframe');
    if (!iframe?.contentWindow) throw new Error('HTML iframe missing');
    const postedToIframe: Array<Record<string, unknown>> = [];
    const realPost = iframe.contentWindow.postMessage.bind(iframe.contentWindow);
    (iframe.contentWindow as unknown as { postMessage: (data: unknown) => void }).postMessage =
      ((data: unknown, ...rest: unknown[]) => {
        if (data && typeof data === 'object') postedToIframe.push(data as Record<string, unknown>);
        return (realPost as (...args: unknown[]) => unknown)(data, ...rest);
      }) as typeof iframe.contentWindow.postMessage;
    const postReady = async () => {
      await act(async () => {
        window.dispatchEvent(new MessageEvent('message', {
          source: iframe.contentWindow,
          data: { type: 'plannotator-bridge-ready' },
        }));
      });
    };
    return { postReady, postedToIframe };
  }

  function ann(id: string, createdA: number, type = 'COMMENT' as Annotation['type']): Annotation {
    return {
      id,
      blockId: '',
      startOffset: 0,
      endOffset: 0,
      type,
      originalText: 'x',
      createdA,
    } as Annotation;
  }

  test('on bridge ready, the ordered collection syncs export-matching numbers (globals occupy slots)', async () => {
    const { AnnotationType } = await import('../../types');
    const annotations = [
      ann('global-1', 5, AnnotationType.GLOBAL_COMMENT),
      ann('ann-late', 20),
      ann('ann-early', 10),
    ];
    const { postReady, postedToIframe } = await mountWithAnnotations(annotations);
    await postReady();
    const syncs = postedToIframe.filter(
      (m) => m.type === 'plannotator-bridge-sync-annotations',
    );
    expect(syncs.length).toBeGreaterThanOrEqual(1);
    // Numbered by ARRAY position of the full list INCLUDING globals — the
    // effective ordering exportAnnotations numbers the feedback with (its
    // sort keys tie for every raw-HTML annotation, so its stable sort keeps
    // array order; createdA is deliberately ignored because external
    // annotations interleave server-stamped timestamps). The global (array
    // position 1) has no page location and ships no entry: the on-page
    // numbers start at 2, leaving the gap where the global sits.
    expect(syncs.at(-1)!.annotations).toEqual([
      { id: 'ann-late', number: 2 },
      { id: 'ann-early', number: 3 },
    ]);
  });

  test('no sync is posted before the bridge is ready', async () => {
    const { postedToIframe } = await mountWithAnnotations([ann('a', 1)]);
    expect(
      postedToIframe.some((m) => m.type === 'plannotator-bridge-sync-annotations'),
    ).toBe(false);
  });

  test('the sync feed truncates to 512 entries in export (array) order (m2)', async () => {
    // The bridge caps its numbering map at 512 entries; the sender ships the
    // FIRST 512 non-global entries in array order — the same order
    // exportAnnotations numbers — so both sides keep the same set. createdA
    // descends here and must NOT reorder anything (external annotations
    // interleave server-stamped timestamps).
    const annotations = Array.from({ length: 520 }, (_, i) => ann(`bulk-${i}`, 1000 - i));
    const { postReady, postedToIframe } = await mountWithAnnotations(annotations);
    await postReady();
    const syncs = postedToIframe.filter(
      (m) => m.type === 'plannotator-bridge-sync-annotations',
    );
    const list = syncs.at(-1)!.annotations as Array<{ id: string; number: number }>;
    expect(list.length).toBe(512);
    expect(list[0]).toEqual({ id: 'bulk-0', number: 1 });
    expect(list[511]).toEqual({ id: 'bulk-511', number: 512 });
  });
});

describe.if(hasDom)('mark-click validation (trust boundary)', () => {
  test('mark-click ids are capped at 256 chars like the bridge sync cap (m1)', () => {
    expect(hookModule!.parseBridgeMessage({
      type: 'plannotator-bridge-mark-click',
      id: 'x'.repeat(256),
    })).toEqual({ type: 'plannotator-bridge-mark-click', id: 'x'.repeat(256) });
    expect(hookModule!.parseBridgeMessage({
      type: 'plannotator-bridge-mark-click',
      id: 'x'.repeat(257),
    })).toBeNull();
    expect(hookModule!.parseBridgeMessage({
      type: 'plannotator-bridge-mark-click',
      id: 42,
    })).toBeNull();
  });
});

describe.if(hasDom)('multi-target bridge message validation (trust boundary)', () => {
  test('multi-target-added: well-formed DTO passes with validated anchor', () => {
    expect(hookModule!.parseBridgeMessage({
      type: 'plannotator-bridge-multi-target-added',
      key: 'ht-2',
      label: 'Button',
      text: 'Create',
      anchor: { selector: 'span.btn', tagName: 'span', text: 'Create' },
    })).toEqual({
      type: 'plannotator-bridge-multi-target-added',
      key: 'ht-2',
      label: 'Button',
      text: 'Create',
      anchor: { selector: 'span.btn', tagName: 'span', text: 'Create' },
    });
  });

  test('multi-target-added: missing/oversized key or text rejects the message', () => {
    expect(hookModule!.parseBridgeMessage({
      type: 'plannotator-bridge-multi-target-added',
      text: 'Create',
    })).toBeNull();
    expect(hookModule!.parseBridgeMessage({
      type: 'plannotator-bridge-multi-target-added',
      key: 'x'.repeat(65),
      text: 'Create',
    })).toBeNull();
    expect(hookModule!.parseBridgeMessage({
      type: 'plannotator-bridge-multi-target-added',
      key: 'ht-2',
      text: 42,
    })).toBeNull();
  });

  test('multi-target-added: anchor point validates like the primary anchor point', () => {
    const good = hookModule!.parseBridgeMessage({
      type: 'plannotator-bridge-multi-target-added',
      key: 'ht-6',
      text: 'Create',
      anchor: { selector: 'span.btn', tagName: 'span', text: 'Create', point: { x: 0.9, y: 0.2 } },
    }) as { anchor?: { point?: { x: number; y: number } } };
    expect(good.anchor?.point).toEqual({ x: 0.9, y: 0.2 });
    const bad = hookModule!.parseBridgeMessage({
      type: 'plannotator-bridge-multi-target-added',
      key: 'ht-7',
      text: 'Create',
      anchor: { selector: 'span.btn', tagName: 'span', text: 'Create', point: { x: 'evil', y: 0.2 } },
    }) as { anchor?: { selector: string; tagName: string; text?: string; point?: unknown } };
    expect(bad.anchor).toEqual({ selector: 'span.btn', tagName: 'span', text: 'Create' });
    expect(bad.anchor?.point).toBeUndefined();
  });

  test('multi-target-added: hostile label is truncated, hostile anchor dropped, text capped', () => {
    const parsed = hookModule!.parseBridgeMessage({
      type: 'plannotator-bridge-multi-target-added',
      key: 'ht-3',
      label: 'L'.repeat(500),
      text: 'x'.repeat(hookModule!.MAX_SELECTION_TEXT_LENGTH + 5000),
      anchor: { selector: 'x'.repeat(2000), tagName: 'p' },
    }) as { label?: string; text: string; anchor?: unknown };
    expect(parsed).not.toBeNull();
    expect(parsed.label!.length).toBe(64);
    expect(parsed.text.length).toBe(hookModule!.MAX_SELECTION_TEXT_LENGTH);
    expect(parsed.anchor).toBeUndefined();
  });

  test('multi-target-removed and pointer messages validate their fields', () => {
    expect(hookModule!.parseBridgeMessage({
      type: 'plannotator-bridge-multi-target-removed',
      key: 'ht-2',
    })).toEqual({ type: 'plannotator-bridge-multi-target-removed', key: 'ht-2' });
    expect(hookModule!.parseBridgeMessage({
      type: 'plannotator-bridge-multi-target-removed',
      key: 7,
    })).toBeNull();
    expect(hookModule!.parseBridgeMessage({
      type: 'plannotator-bridge-pointer',
      x: 12,
      y: 34,
      shift: true,
    })).toEqual({ type: 'plannotator-bridge-pointer', x: 12, y: 34, shift: true });
    // shift is a strict boolean: absent or truthy-but-not-true reads false.
    expect(hookModule!.parseBridgeMessage({
      type: 'plannotator-bridge-pointer',
      x: 12,
      y: 34,
    })).toEqual({ type: 'plannotator-bridge-pointer', x: 12, y: 34, shift: false });
    expect(hookModule!.parseBridgeMessage({
      type: 'plannotator-bridge-pointer',
      x: 12,
      y: 34,
      shift: 1,
    })).toEqual({ type: 'plannotator-bridge-pointer', x: 12, y: 34, shift: false });
    expect(hookModule!.parseBridgeMessage({
      type: 'plannotator-bridge-pointer',
      x: Infinity,
      y: 1,
    })).toBeNull();
  });

  test('hostile labels with newlines are collapsed at the trust boundary (D2)', () => {
    const parsed = hookModule!.parseBridgeMessage({
      type: 'plannotator-bridge-multi-target-added',
      key: 'ht-4',
      label: 'Save\n## INJECTED HEADING',
      text: 'Save',
    }) as { label?: string };
    expect(parsed.label).toBe('Save ## INJECTED HEADING');
    const selection = hookModule!.parseBridgeMessage({
      type: 'plannotator-bridge-selection',
      text: 'Save',
      rect: { top: 1, left: 1, width: 10, height: 10 },
      pinpoint: true,
      targetKey: 'ht-1',
      targetLabel: '  a\r\n\tb  ',
    }) as { targetLabel?: string };
    expect(selection.targetLabel).toBe('a b');
    // Whitespace-only labels vanish instead of becoming empty brackets.
    const blank = hookModule!.parseBridgeMessage({
      type: 'plannotator-bridge-multi-target-added',
      key: 'ht-5',
      label: ' \n\t ',
      text: 'x',
    }) as { label?: string };
    expect(blank.label).toBeUndefined();
  });

  test('selection: targetKey validated, targetLabel truncated', () => {
    const rect = { top: 10, left: 10, width: 100, height: 20 };
    const parsed = hookModule!.parseBridgeMessage({
      type: 'plannotator-bridge-selection',
      text: 'Hello',
      rect,
      pinpoint: true,
      targetKey: 'ht-1',
      targetLabel: 'Z'.repeat(200),
    }) as { targetKey?: string; targetLabel?: string };
    expect(parsed.targetKey).toBe('ht-1');
    expect(parsed.targetLabel!.length).toBe(64);
    const badKey = hookModule!.parseBridgeMessage({
      type: 'plannotator-bridge-selection',
      text: 'Hello',
      rect,
      pinpoint: true,
      targetKey: 'x'.repeat(65),
    }) as { targetKey?: string };
    expect(badKey.targetKey).toBeUndefined();
  });
});

describe.if(hasDom)('multi-target composer flow (chips, promotion, submit)', () => {
  async function mountViewer(
    onAdd: (ann: Annotation) => void,
    mode: 'selection' | 'quickLabel' = 'selection',
  ) {
    if (!htmlViewerModule) throw new Error('DOM test environment is not registered');
    const HtmlViewer = htmlViewerModule.HtmlViewer;
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    mountedRoots.push(root);
    await act(async () => {
      root.render(
        <HtmlViewer
          rawHtml="<html><body><p>Pinpoint target</p></body></html>"
          annotations={[]}
          onAddAnnotation={onAdd}
          onSelectAnnotation={() => {}}
          selectedAnnotationId={null}
          mode={mode}
          inputMethod="pinpoint"
        />,
      );
    });
    const iframe = host.querySelector<HTMLIFrameElement>('iframe');
    if (!iframe?.contentWindow) throw new Error('HTML iframe missing');
    // Record everything the parent posts INTO the iframe (arm-multi-select,
    // remove-target echoes, ...) by wrapping contentWindow.postMessage.
    const postedToIframe: Array<Record<string, unknown>> = [];
    const realPost = iframe.contentWindow.postMessage.bind(iframe.contentWindow);
    (iframe.contentWindow as unknown as { postMessage: (data: unknown) => void }).postMessage =
      ((data: unknown, ...rest: unknown[]) => {
        if (data && typeof data === 'object') postedToIframe.push(data as Record<string, unknown>);
        return (realPost as (...args: unknown[]) => unknown)(data, ...rest);
      }) as typeof iframe.contentWindow.postMessage;
    const post = async (data: Record<string, unknown>) => {
      await act(async () => {
        window.dispatchEvent(new MessageEvent('message', {
          source: iframe.contentWindow,
          data,
        }));
      });
    };
    return { post, postedToIframe };
  }

  const rect = { top: 10, left: 10, width: 120, height: 24 };

  function primarySelection(overrides: Record<string, unknown> = {}) {
    return {
      type: 'plannotator-bridge-selection',
      text: 'Primary text',
      rect,
      pinpoint: true,
      targetKey: 'ht-1',
      targetLabel: 'Paragraph',
      anchor: { selector: 'p.primary', tagName: 'p', text: 'Primary text' },
      ...overrides,
    };
  }

  function addedTarget(key: string, text: string) {
    return {
      type: 'plannotator-bridge-multi-target-added',
      key,
      label: 'Button',
      text,
      anchor: { selector: `span[data-testid="${key}"]`, tagName: 'span', text },
    };
  }

  function chips(): HTMLElement[] {
    return Array.from(document.querySelectorAll<HTMLElement>('[data-target-chip]'));
  }

  async function typeComment(value: string) {
    const el = document.querySelector<HTMLTextAreaElement>('[data-comment-popover] textarea');
    if (!el) throw new Error('composer textarea missing');
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
    await act(async () => {
      if (setter) setter.call(el, value);
      else el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  async function save() {
    const button = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[data-comment-popover] button'),
    ).find((b) => b.textContent === 'Save');
    if (!button) throw new Error('Save button missing');
    await act(async () => {
      button.click();
    });
  }

  test('pinpoint draft renders a primary chip; shift-adds append chips and submit as ONE comment', async () => {
    const added: Annotation[] = [];
    const { post } = await mountViewer((ann) => added.push(ann));
    await post(primarySelection());
    expect(document.querySelector('[data-comment-popover]')).not.toBeNull();
    expect(chips().length).toBe(1);
    expect(chips()[0]!.getAttribute('data-target-chip-primary')).toBe('true');

    await post(addedTarget('ht-2', 'Create'));
    await post(addedTarget('ht-3', 'Cancel'));
    expect(chips().length).toBe(3);

    await typeComment('Unify these buttons');
    await save();

    expect(added.length).toBe(1);
    const ann = added[0]!;
    expect(ann.text).toBe('Unify these buttons');
    expect(ann.originalText).toBe('Primary text');
    expect(ann.htmlAnchor).toEqual({ selector: 'p.primary', tagName: 'p', text: 'Primary text' });
    expect(ann.htmlAdditionalTargets).toEqual([
      {
        label: 'Button',
        text: 'Create',
        anchor: { selector: 'span[data-testid="ht-2"]', tagName: 'span', text: 'Create' },
      },
      {
        label: 'Button',
        text: 'Cancel',
        anchor: { selector: 'span[data-testid="ht-3"]', tagName: 'span', text: 'Cancel' },
      },
    ]);
    // Draft state cleared with the submit.
    expect(document.querySelector('[data-comment-popover]')).toBeNull();
  });

  test('single-target pinpoint submit carries NO additional-targets array', async () => {
    const added: Annotation[] = [];
    const { post } = await mountViewer((ann) => added.push(ann));
    await post(primarySelection());
    await typeComment('Just this one');
    await save();
    expect(added.length).toBe(1);
    expect(added[0]!.htmlAdditionalTargets).toBeUndefined();
  });

  test('removing the primary promotes the next target onto the comment', async () => {
    const added: Annotation[] = [];
    const { post } = await mountViewer((ann) => added.push(ann));
    await post(primarySelection());
    await post(addedTarget('ht-2', 'Create'));
    expect(chips().length).toBe(2);

    // Bridge-echoed removal of the primary (shift-click toggle-off).
    await post({ type: 'plannotator-bridge-multi-target-removed', key: 'ht-1' });
    expect(chips().length).toBe(1);
    expect(chips()[0]!.getAttribute('data-target-chip')).toBe('ht-2');
    expect(chips()[0]!.getAttribute('data-target-chip-primary')).toBe('true');

    await typeComment('Promoted');
    await save();
    expect(added.length).toBe(1);
    expect(added[0]!.originalText).toBe('Create'); // the promoted target's text
    expect(added[0]!.htmlAnchor).toEqual({
      selector: 'span[data-testid="ht-2"]',
      tagName: 'span',
      text: 'Create',
    });
    expect(added[0]!.htmlAdditionalTargets).toBeUndefined();
  });

  test('removing the final target cancels the draft (composer closes)', async () => {
    const { post } = await mountViewer(() => {});
    await post(primarySelection());
    expect(document.querySelector('[data-comment-popover]')).not.toBeNull();
    await post({ type: 'plannotator-bridge-multi-target-removed', key: 'ht-1' });
    expect(document.querySelector('[data-comment-popover]')).toBeNull();
    expect(chips().length).toBe(0);
  });

  test('chip remove button removes that target from the draft', async () => {
    const added: Annotation[] = [];
    const { post } = await mountViewer((ann) => added.push(ann));
    await post(primarySelection());
    await post(addedTarget('ht-2', 'Create'));
    expect(chips().length).toBe(2);

    const removeButton = document.querySelector<HTMLButtonElement>(
      '[data-target-chip-remove="ht-2"]',
    );
    if (!removeButton) throw new Error('chip remove button missing');
    await act(async () => {
      removeButton.click();
    });
    expect(chips().length).toBe(1);

    await typeComment('Back to one');
    await save();
    expect(added[0]!.htmlAdditionalTargets).toBeUndefined();
  });

  test('the additional-target array is capped at 16 at the trust boundary', async () => {
    const added: Annotation[] = [];
    const { post } = await mountViewer((ann) => added.push(ann));
    await post(primarySelection());
    for (let i = 0; i < 25; i++) {
      await post(addedTarget(`flood-${i}`, `Target ${i}`));
    }
    expect(chips().length).toBe(17); // primary + 16

    await typeComment('Capped');
    await save();
    expect(added[0]!.htmlAdditionalTargets!.length).toBe(16);
  });

  test('adds are ignored when no pinpoint draft is open (drag selections stay single-target)', async () => {
    const { post, postedToIframe } = await mountViewer(() => {});
    // Drag selection (no pinpoint flag): opens the toolbar, arms nothing.
    await post({
      type: 'plannotator-bridge-selection',
      text: 'Dragged text',
      rect,
    });
    await post(addedTarget('ht-9', 'Stray'));
    expect(chips().length).toBe(0);
    expect(postedToIframe.some((m) => m.type === 'plannotator-bridge-arm-multi-select')).toBe(false);
  });

  test('the composer flow arms the bridge with the primary key (D1)', async () => {
    const armed = await mountViewer(() => {});
    await armed.post(primarySelection());
    expect(armed.postedToIframe).toContainEqual({
      type: 'plannotator-bridge-arm-multi-select',
      key: 'ht-1',
    });
  });

  test('quickLabel-mode drafts never arm the bridge and never build chips (D1)', async () => {
    // quickLabel mode: the pinpoint draft opens the label picker, which the
    // parent does NOT mirror as targets — so it must never arm the bridge,
    // and stray adds must not build chips.
    const quick = await mountViewer(() => {}, 'quickLabel');
    await quick.post(primarySelection());
    expect(document.querySelector('[data-comment-popover]')).toBe(null);
    expect(
      quick.postedToIframe.some((m) => m.type === 'plannotator-bridge-arm-multi-select'),
    ).toBe(false);
    await quick.post(addedTarget('ht-2', 'Create'));
    expect(chips().length).toBe(0);
  });

  test('a forged multi-target-removed still echoes remove-target to resync the bridge (D4)', async () => {
    const added: Annotation[] = [];
    const { post, postedToIframe } = await mountViewer((ann) => added.push(ann));
    await post(primarySelection());
    await post(addedTarget('ht-2', 'Create'));
    expect(chips().length).toBe(2);

    // Hostile page forges the removal of the primary — the bridge never
    // performed it. The parent promotes AND echoes remove-target so the
    // bridge converges on the same promotion (idempotent if it already had).
    await post({ type: 'plannotator-bridge-multi-target-removed', key: 'ht-1' });
    expect(chips().length).toBe(1);
    expect(chips()[0]!.getAttribute('data-target-chip')).toBe('ht-2');
    expect(postedToIframe).toContainEqual({
      type: 'plannotator-bridge-remove-target',
      key: 'ht-1',
    });
  });

  test('bridge pointer messages with shift drive the composer yield (D3)', async () => {
    const { post } = await mountViewer(() => {});
    await post(primarySelection());
    const popover = document.querySelector<HTMLElement>('[data-comment-popover]');
    if (!popover) throw new Error('composer missing');
    expect(popover.className).toContain('pn-composer-yieldable');
    expect(popover.className).not.toContain('pn-composer-yield-over');

    // Pointer over the composer (happy-dom rects are 0x0 at the origin) with
    // shift held — relayed FROM THE BRIDGE, no parent keydown involved.
    await post({ type: 'plannotator-bridge-pointer', x: 0, y: 0, shift: true });
    expect(popover.className).toContain('pn-composer-yield-over');

    // Shift released (still reported by the bridge): the composer restores.
    await post({ type: 'plannotator-bridge-pointer', x: 0, y: 0, shift: false });
    expect(popover.className).not.toContain('pn-composer-yield-over');
    expect(popover.className).not.toContain('pn-composer-yield-near');
  });
});

describe.if(hasDom)('readOnly view-only contract', () => {
  // The promise made to hosts (HANDOFF.md 0.29.0): readOnly disables every
  // authoring entry point but is NOT blank — committed annotations restore,
  // markers paint with export-matching numbers, and marker clicks still
  // navigate. View-only review contexts depend on all three.
  async function mountReadOnly(
    annotations: Annotation[],
    onSelect: (id: string | null) => void = () => {},
  ) {
    if (!htmlViewerModule) throw new Error('DOM test environment is not registered');
    const HtmlViewer = htmlViewerModule.HtmlViewer;
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    mountedRoots.push(root);
    await act(async () => {
      root.render(
        <HtmlViewer
          rawHtml="<html><body><p>Read-only target</p></body></html>"
          annotations={annotations}
          onAddAnnotation={() => {}}
          onSelectAnnotation={onSelect}
          selectedAnnotationId={null}
          mode="selection"
          inputMethod="pinpoint"
          readOnly
        />,
      );
    });
    const iframe = host.querySelector<HTMLIFrameElement>('iframe');
    if (!iframe?.contentWindow) throw new Error('HTML iframe missing');
    const postedToIframe: Array<Record<string, unknown>> = [];
    const realPost = iframe.contentWindow.postMessage.bind(iframe.contentWindow);
    (iframe.contentWindow as unknown as { postMessage: (data: unknown) => void }).postMessage =
      ((data: unknown, ...rest: unknown[]) => {
        if (data && typeof data === 'object') postedToIframe.push(data as Record<string, unknown>);
        return (realPost as (...args: unknown[]) => unknown)(data, ...rest);
      }) as typeof iframe.contentWindow.postMessage;
    const post = async (data: Record<string, unknown>) => {
      await act(async () => {
        window.dispatchEvent(new MessageEvent('message', {
          source: iframe.contentWindow,
          data,
        }));
      });
    };
    return { post, postedToIframe };
  }

  function committed(id: string): Annotation {
    return {
      id,
      blockId: '',
      startOffset: 0,
      endOffset: 0,
      type: 'COMMENT',
      text: 'noted',
      originalText: 'Read-only target',
      createdA: 1,
      htmlAnchor: { selector: 'p', tagName: 'p', text: 'Read-only target' },
    } as Annotation;
  }

  test('readOnly still restores markers and syncs export-matching numbers on ready', async () => {
    const { post, postedToIframe } = await mountReadOnly([committed('ro-1'), committed('ro-2')]);
    await post({ type: 'plannotator-bridge-ready' });

    const restores = postedToIframe.filter((m) => m.type === 'plannotator-bridge-find-and-mark');
    expect(restores.map((m) => m.id)).toEqual(['ro-1', 'ro-2']);
    // Anchor-first restore must survive readOnly: the anchor is forwarded so
    // the bridge can pin the marker at the element, not just text-search.
    expect((restores[0]!.anchor as { selector: string }).selector).toBe('p');

    const syncs = postedToIframe.filter((m) => m.type === 'plannotator-bridge-sync-annotations');
    expect(syncs.at(-1)!.annotations).toEqual([
      { id: 'ro-1', number: 1 },
      { id: 'ro-2', number: 2 },
    ]);
  });

  test('readOnly marker clicks still navigate via onSelectAnnotation', async () => {
    const selected: Array<string | null> = [];
    const { post } = await mountReadOnly([committed('ro-1')], (id) => selected.push(id));
    await post({ type: 'plannotator-bridge-ready' });
    await post({ type: 'plannotator-bridge-mark-click', id: 'ro-1' });
    expect(selected).toEqual(['ro-1']);
  });

  test('readOnly ignores selection messages: no toolbar, no composer', async () => {
    const { post } = await mountReadOnly([committed('ro-1')]);
    await post({ type: 'plannotator-bridge-ready' });
    await post({
      type: 'plannotator-bridge-selection',
      text: 'Read-only target',
      rect: { top: 10, left: 10, width: 120, height: 24 },
      pinpoint: true,
      targetKey: 'ht-ro',
      targetLabel: 'Paragraph',
      anchor: { selector: 'p', tagName: 'p', text: 'Read-only target' },
    });
    expect(document.querySelector('[data-comment-popover]')).toBeNull();
    expect(document.querySelector('[data-annotation-toolbar]')).toBeNull();
  });
});

describe.if(hasDom)('unanchored report (trust boundary + delivery)', () => {
  const MSG = 'plannotator-bridge-unanchored';

  test('accepts a bounded report, including the empty recovery set', () => {
    expect(hookModule!.parseBridgeMessage({ type: MSG, ids: ['a-1', 'b-2'] }))
      .toEqual({ type: MSG, ids: ['a-1', 'b-2'] });
    expect(hookModule!.parseBridgeMessage({ type: MSG, ids: [] }))
      .toEqual({ type: MSG, ids: [] });
  });

  test('out-of-contract reports are rejected whole (forged-message posture)', () => {
    // The real bridge caps at 512 ids of <=256 chars; anything past that is a
    // hostile page forging the message, so nothing salvageable is delivered.
    expect(hookModule!.parseBridgeMessage({ type: MSG, ids: 'a' })).toBeNull();
    expect(hookModule!.parseBridgeMessage({ type: MSG })).toBeNull();
    expect(hookModule!.parseBridgeMessage({ type: MSG, ids: [42] })).toBeNull();
    expect(hookModule!.parseBridgeMessage({ type: MSG, ids: ['ok', 'x'.repeat(257)] })).toBeNull();
    expect(
      hookModule!.parseBridgeMessage({ type: MSG, ids: Array.from({ length: 513 }, () => 'a') }),
    ).toBeNull();
  });

  test('delivery reaches onUnanchoredChange even in readOnly mode', async () => {
    // View-only surfaces are exactly where silently missing markers would go
    // unnoticed, so the report must bypass the enabled gate like mark-click.
    if (!htmlViewerModule) throw new Error('DOM test environment is not registered');
    const HtmlViewer = htmlViewerModule.HtmlViewer;
    const received: string[][] = [];
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    mountedRoots.push(root);
    await act(async () => {
      root.render(
        <HtmlViewer
          rawHtml="<html><body><p>Page</p></body></html>"
          annotations={[]}
          onAddAnnotation={() => {}}
          onSelectAnnotation={() => {}}
          selectedAnnotationId={null}
          mode="selection"
          inputMethod="pinpoint"
          readOnly
          onUnanchoredChange={(ids) => received.push(ids)}
        />,
      );
    });
    const iframe = host.querySelector<HTMLIFrameElement>('iframe');
    if (!iframe?.contentWindow) throw new Error('HTML iframe missing');
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        source: iframe.contentWindow,
        data: { type: MSG, ids: ['lost-1'] },
      }));
    });
    expect(received).toEqual([['lost-1']]);
  });
});
