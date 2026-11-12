import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CodeNavHoverResponse, CodeNavRequest } from '@plannotator/shared/code-nav';
import { isMac, modEventKey } from '@plannotator/ui/utils/platform';
import {
  useTokenHover,
  type UseTokenHoverOptions,
  type UseTokenHoverResult,
} from './useTokenHover';

const hasDom = typeof document !== 'undefined';

const REQUEST: CodeNavRequest = {
  symbol: 'charge',
  filePath: 'src/pay.js',
  line: 2,
  charStart: 16,
  side: 'new',
  language: 'javascript',
};

function hoverResponse(overrides: Partial<CodeNavHoverResponse> = {}): CodeNavHoverResponse {
  return {
    backend: 'search',
    source: 'search',
    symbol: 'charge',
    definition: {
      filePath: 'src/pay.js',
      line: 2,
      column: 16,
      confidence: 'likely',
      symbolKind: 'function',
      signature: 'function charge(amount) {',
      signatureApproximate: true,
      doc: null,
      preview: null,
      otherCandidateCount: 0,
    },
    alternateDefinition: null,
    references: [],
    referenceCount: 0,
    capped: false,
    stats: { elapsedMs: 12 },
    ...overrides,
  };
}

interface PendingFetch {
  request: CodeNavRequest;
  signal: AbortSignal | undefined;
  settle: (data: CodeNavHoverResponse) => void;
}

let pending: PendingFetch[] = [];
let originalFetch: typeof globalThis.fetch;
let host: HTMLDivElement | null = null;
let root: Root | null = null;
let latest: UseTokenHoverResult | null = null;

function Harness({
  snapshotId = 'snapshot-1',
  options,
}: { snapshotId?: string; options?: UseTokenHoverOptions }) {
  latest = useTokenHover(snapshotId, options);
  return null;
}

async function mount(snapshotId?: string, options?: UseTokenHoverOptions): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<Harness snapshotId={snapshotId} options={options} />);
  });
}

const held = { metaKey: isMac, ctrlKey: !isMac };
const released = { metaKey: false, ctrlKey: false };

async function modDown(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: modEventKey, ...held }));
  });
}

async function modUp(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keyup', { key: modEventKey, ...released }));
  });
}

async function modChord(key: string, target: EventTarget = window): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, ...held, bubbles: true }));
  });
}

async function modDownFrom(target: EventTarget): Promise<void> {
  await act(async () => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key: modEventKey, ...held, bubbles: true, composed: true }),
    );
  });
}

async function modDownFromShadowEditor(): Promise<void> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const editable = document.createElement('div');
  editable.setAttribute('contenteditable', 'true');
  host.attachShadow({ mode: 'open' }).appendChild(editable);

  const event = new KeyboardEvent('keydown', { key: modEventKey, ...held });
  Object.defineProperty(event, 'target', { value: host });
  Object.defineProperty(event, 'composedPath', {
    value: () => [editable, host, document.body, document.documentElement, document, window],
  });

  await act(async () => { window.dispatchEvent(event); });
  host.remove();
}

function token(): HTMLElement {
  const el = document.createElement('span');
  document.body.appendChild(el);
  return el;
}

async function settle(index: number, data: CodeNavHoverResponse): Promise<void> {
  await act(async () => {
    pending[index].settle(data);
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  if (!hasDom) return;
  pending = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = ((_url: string, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as CodeNavRequest;
    return new Promise((resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('aborted', 'AbortError'));
      });
      pending.push({
        request,
        signal: init?.signal ?? undefined,
        settle: (data) => resolve(new Response(JSON.stringify(data))),
      });
    });
  }) as typeof globalThis.fetch;
  jest.useFakeTimers();
});

afterEach(async () => {
  if (!hasDom) return;
  jest.useRealTimers();
  globalThis.fetch = originalFetch;
  if (root) {
    const current = root;
    await act(async () => current.unmount());
    root = null;
  }
  host?.remove();
  host = null;
  latest = null;
});

describe.skipIf(!hasDom)('useTokenHover', () => {
  test('no request exists before the dwell elapses', async () => {
    await mount();
    await act(async () => latest!.onTokenHoverEnter(REQUEST, token()));

    await act(async () => { jest.advanceTimersByTime(299); });
    expect(pending).toHaveLength(0);

    await act(async () => { jest.advanceTimersByTime(2); });
    expect(pending).toHaveLength(1);
    expect(pending[0].request.symbol).toBe('charge');
  });

  test('leaving before the dwell elapses spawns nothing at all', async () => {
    await mount();
    await act(async () => latest!.onTokenHoverEnter(REQUEST, token()));
    await act(async () => { jest.advanceTimersByTime(200); });
    await act(async () => latest!.onTokenHoverLeave());
    await act(async () => { jest.advanceTimersByTime(1000); });

    expect(pending).toHaveLength(0);
  });

  test('a new symbol supersedes and aborts the in-flight request', async () => {
    await mount();
    await act(async () => latest!.onTokenHoverEnter(REQUEST, token()));
    await act(async () => { jest.advanceTimersByTime(300); });
    expect(pending).toHaveLength(1);

    await act(async () => {
      latest!.onTokenHoverEnter({ ...REQUEST, symbol: 'withRetry' }, token());
    });
    expect(pending[0].signal?.aborted).toBe(true);

    await act(async () => { jest.advanceTimersByTime(300); });
    expect(pending).toHaveLength(2);
    expect(pending[1].request.symbol).toBe('withRetry');
  });

  test('the card survives the leave grace and entering it cancels the close', async () => {
    await mount();
    await act(async () => latest!.onTokenHoverEnter(REQUEST, token()));
    await act(async () => { jest.advanceTimersByTime(300); });
    await settle(0, hoverResponse());
    expect(latest!.hover).not.toBeNull();

    await act(async () => latest!.onTokenHoverLeave());
    await act(async () => { jest.advanceTimersByTime(200); });
    expect(latest!.hover).not.toBeNull();

    await act(async () => latest!.onCardEnter());
    await act(async () => { jest.advanceTimersByTime(5000); });
    expect(latest!.hover).not.toBeNull();

    await act(async () => latest!.onCardLeave());
    await act(async () => { jest.advanceTimersByTime(250); });
    expect(latest!.hover).toBeNull();
  });

  test('a re-hover inside the cache spawns no second request', async () => {
    await mount();
    await act(async () => latest!.onTokenHoverEnter(REQUEST, token()));
    await act(async () => { jest.advanceTimersByTime(300); });
    await settle(0, hoverResponse());

    await act(async () => latest!.onTokenHoverLeave());
    await act(async () => { jest.advanceTimersByTime(250); });
    await act(async () => latest!.onTokenHoverEnter(REQUEST, token()));
    await act(async () => { jest.advanceTimersByTime(300); });

    expect(pending).toHaveLength(1);
    expect(latest!.hover).not.toBeNull();
  });

  test('an unavailable backend renders nothing', async () => {
    await mount();
    await act(async () => latest!.onTokenHoverEnter(REQUEST, token()));
    await act(async () => { jest.advanceTimersByTime(300); });
    await settle(0, hoverResponse({
      backend: 'unavailable',
      definition: null,
      references: [],
      referenceCount: 0,
    }));

    expect(latest!.hover).toBeNull();
  });

  test('an answer with no definition and one reference renders nothing', async () => {
    await mount();
    await act(async () => latest!.onTokenHoverEnter(REQUEST, token()));
    await act(async () => { jest.advanceTimersByTime(300); });
    await settle(0, hoverResponse({
      definition: null,
      references: [{ filePath: 'src/other.js', line: 4, column: 2, snippet: 'charge(1)' }],
      referenceCount: 1,
    }));

    expect(latest!.hover).toBeNull();
  });

  test('a neighbour answer never lands in an open card for another token', async () => {
    await mount();
    const tokenX = token();
    await act(async () => latest!.onTokenHoverEnter(REQUEST, tokenX));
    await act(async () => { jest.advanceTimersByTime(300); });
    await settle(0, hoverResponse());
    expect(latest!.hover!.data.symbol).toBe('charge');

    const neighbour = { ...REQUEST, symbol: 'withRetry' };
    await act(async () => latest!.onTokenHoverLeave());
    await act(async () => latest!.onTokenHoverEnter(neighbour, token()));
    await act(async () => { jest.advanceTimersByTime(300); });
    expect(pending).toHaveLength(2);

    await act(async () => latest!.onTokenHoverLeave());
    await act(async () => latest!.onTokenHoverEnter(REQUEST, tokenX));
    expect(pending[1].signal?.aborted).toBe(true);
    await settle(1, hoverResponse({ symbol: 'withRetry' }));

    expect(latest!.hover).not.toBeNull();
    expect(latest!.hover!.data.symbol).toBe('charge');
  });

  test('re-entering the same token joins the in-flight request', async () => {
    await mount();
    const tokenX = token();
    await act(async () => latest!.onTokenHoverEnter(REQUEST, tokenX));
    await act(async () => { jest.advanceTimersByTime(300); });
    expect(pending).toHaveLength(1);

    await act(async () => latest!.onTokenHoverLeave());
    await act(async () => { jest.advanceTimersByTime(100); });
    await act(async () => latest!.onTokenHoverEnter(REQUEST, tokenX));
    await act(async () => { jest.advanceTimersByTime(300); });

    expect(pending).toHaveLength(1);
    expect(pending[0].signal?.aborted).toBe(false);

    await settle(0, hoverResponse());
    expect(latest!.hover).not.toBeNull();
  });

  test('a below-threshold answer for another token closes the stale card', async () => {
    await mount();
    await act(async () => latest!.onTokenHoverEnter(REQUEST, token()));
    await act(async () => { jest.advanceTimersByTime(300); });
    await settle(0, hoverResponse());
    expect(latest!.hover).not.toBeNull();

    await act(async () => latest!.onTokenHoverLeave());
    await act(async () => {
      latest!.onTokenHoverEnter({ ...REQUEST, symbol: 'gateway' }, token());
    });
    await act(async () => { jest.advanceTimersByTime(300); });
    await settle(1, hoverResponse({
      symbol: 'gateway',
      definition: null,
      references: [],
      referenceCount: 0,
    }));

    expect(latest!.hover).toBeNull();
  });

  test('an answer for a token no longer in the DOM opens no card', async () => {
    await mount();
    const recycled = token();
    await act(async () => latest!.onTokenHoverEnter(REQUEST, recycled));
    await act(async () => { jest.advanceTimersByTime(300); });
    recycled.remove();
    await settle(0, hoverResponse());

    expect(latest!.hover).toBeNull();
  });

  test('scrolling inside the card leaves it open; scrolling the pane closes it', async () => {
    await mount();
    await act(async () => latest!.onTokenHoverEnter(REQUEST, token()));
    await act(async () => { jest.advanceTimersByTime(300); });
    await settle(0, hoverResponse());

    const card = document.createElement('div');
    card.setAttribute('data-token-hover-card', '');
    const insideCard = document.createElement('pre');
    card.appendChild(insideCard);
    document.body.appendChild(card);
    await act(async () => {
      insideCard.dispatchEvent(new Event('wheel', { bubbles: true }));
    });
    expect(latest!.hover).not.toBeNull();

    const pane = token();
    await act(async () => {
      pane.dispatchEvent(new Event('wheel', { bubbles: true }));
    });
    expect(latest!.hover).toBeNull();
    card.remove();
  });

  test('a new diff snapshot flushes the cache', async () => {
    await mount('snapshot-1');
    await act(async () => latest!.onTokenHoverEnter(REQUEST, token()));
    await act(async () => { jest.advanceTimersByTime(300); });
    await settle(0, hoverResponse());
    expect(pending).toHaveLength(1);

    await act(async () => {
      root!.render(<Harness snapshotId="snapshot-2" />);
    });
    expect(latest!.hover).toBeNull();

    await act(async () => latest!.onTokenHoverEnter(REQUEST, token()));
    await act(async () => { jest.advanceTimersByTime(300); });
    expect(pending).toHaveLength(2);
  });

  test('unmounting abandons the pending request', async () => {
    await mount();
    await act(async () => latest!.onTokenHoverEnter(REQUEST, token()));
    await act(async () => { jest.advanceTimersByTime(300); });
    expect(pending).toHaveLength(1);

    const current = root!;
    root = null;
    await act(async () => current.unmount());

    expect(pending[0].signal?.aborted).toBe(true);
  });

  test('scrolling closes the card and abandons the pending request', async () => {
    await mount();
    await act(async () => latest!.onTokenHoverEnter(REQUEST, token()));
    await act(async () => { jest.advanceTimersByTime(300); });
    expect(pending).toHaveLength(1);

    await act(async () => {
      document.dispatchEvent(new Event('scroll'));
    });
    expect(pending[0].signal?.aborted).toBe(true);
    expect(latest!.hover).toBeNull();
  });
});

describe.skipIf(!hasDom)('useTokenHover trigger mode', () => {
  test('with the key up, no dwell is ever armed', async () => {
    await mount('snapshot-1', { mode: 'modifier' });
    await act(async () => latest!.onTokenHoverEnter(REQUEST, token()));

    await act(async () => { jest.advanceTimersByTime(10_000); });
    expect(pending).toHaveLength(0);
    expect(latest!.hover).toBeNull();
  });

  test('holding the key first, then hovering, opens the card', async () => {
    await mount('snapshot-1', { mode: 'modifier' });
    await modDown();
    await act(async () => latest!.onTokenHoverEnter(REQUEST, token()));

    await act(async () => { jest.advanceTimersByTime(300); });
    expect(pending).toHaveLength(1);
    await settle(0, hoverResponse());
    expect(latest!.hover?.request.symbol).toBe('charge');
  });

  test('pressing the key while already parked on a token opens the card', async () => {
    await mount('snapshot-1', { mode: 'modifier' });
    await act(async () => latest!.onTokenHoverEnter(REQUEST, token()));
    expect(pending).toHaveLength(0);

    await modDown();
    await act(async () => { jest.advanceTimersByTime(300); });

    expect(pending).toHaveLength(1);
  });

  test('a token left before the key goes down is not resurrected by it', async () => {
    await mount('snapshot-1', { mode: 'modifier' });
    await act(async () => latest!.onTokenHoverEnter(REQUEST, token()));
    await act(async () => latest!.onTokenHoverLeave());

    await modDown();
    await act(async () => { jest.advanceTimersByTime(300); });

    expect(pending).toHaveLength(0);
  });

  test('releasing the key closes the card the way leaving does', async () => {
    await mount('snapshot-1', { mode: 'modifier' });
    await modDown();
    await act(async () => latest!.onTokenHoverEnter(REQUEST, token()));
    await act(async () => { jest.advanceTimersByTime(300); });
    await settle(0, hoverResponse());
    expect(latest!.hover).not.toBeNull();

    await modUp();
    expect(latest!.hover).not.toBeNull();
    await act(async () => { jest.advanceTimersByTime(250); });
    expect(latest!.hover).toBeNull();
  });

  test('releasing the key while reading the card does not yank it away', async () => {
    await mount('snapshot-1', { mode: 'modifier' });
    await modDown();
    await act(async () => latest!.onTokenHoverEnter(REQUEST, token()));
    await act(async () => { jest.advanceTimersByTime(300); });
    await settle(0, hoverResponse());
    await act(async () => latest!.onCardEnter());

    await modUp();
    await act(async () => { jest.advanceTimersByTime(1000); });

    expect(latest!.hover).not.toBeNull();
  });

  test('the modifier pressed while typing in a comment box arms nothing', async () => {
    await mount('snapshot-1', { mode: 'modifier' });
    await act(async () => latest!.onTokenHoverEnter(REQUEST, token()));

    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    await modDownFrom(textarea);
    await act(async () => { jest.advanceTimersByTime(1000); });
    textarea.remove();

    expect(pending).toHaveLength(0);
    expect(latest!.hover).toBeNull();
  });

  test('the modifier pressed inside a shadow-root editor arms nothing either', async () => {
    await mount('snapshot-1', { mode: 'modifier' });
    await act(async () => latest!.onTokenHoverEnter(REQUEST, token()));

    await modDownFromShadowEditor();
    await act(async () => { jest.advanceTimersByTime(1000); });

    expect(pending).toHaveLength(0);
    expect(latest!.hover).toBeNull();
  });

  test('a chord while typing still disarms an open card', async () => {
    await mount('snapshot-1', { mode: 'modifier' });
    await modDown();
    await act(async () => latest!.onTokenHoverEnter(REQUEST, token()));
    await act(async () => { jest.advanceTimersByTime(300); });
    await settle(0, hoverResponse());
    expect(latest!.hover).not.toBeNull();

    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    await modChord('v', textarea);
    await act(async () => { jest.advanceTimersByTime(250); });
    textarea.remove();

    expect(latest!.hover).toBeNull();
  });

  test('a copy chord with the pointer parked on a token opens nothing', async () => {
    await mount('snapshot-1', { mode: 'modifier' });
    await act(async () => latest!.onTokenHoverEnter(REQUEST, token()));

    await modDown();
    await modChord('c');
    await act(async () => { jest.advanceTimersByTime(5000); });

    expect(pending).toHaveLength(0);
    expect(latest!.hover).toBeNull();
  });

  test('a chord while a card is open takes the card with it', async () => {
    await mount('snapshot-1', { mode: 'modifier' });
    await modDown();
    await act(async () => latest!.onTokenHoverEnter(REQUEST, token()));
    await act(async () => { jest.advanceTimersByTime(300); });
    await settle(0, hoverResponse());
    expect(latest!.hover).not.toBeNull();

    await modChord('c');
    await act(async () => { jest.advanceTimersByTime(250); });

    expect(latest!.hover).toBeNull();
  });

  test('a card closed while the pointer was inside it does not deafen the next release', async () => {
    await mount('snapshot-1', { mode: 'modifier' });
    await modDown();
    await act(async () => latest!.onTokenHoverEnter(REQUEST, token()));
    await act(async () => { jest.advanceTimersByTime(300); });
    await settle(0, hoverResponse());
    await act(async () => latest!.onCardEnter());

    await act(async () => { document.dispatchEvent(new Event('scroll')); });
    expect(latest!.hover).toBeNull();

    const second = { ...REQUEST, symbol: 'refund' };
    await act(async () => latest!.onTokenHoverEnter(second, token()));
    await act(async () => { jest.advanceTimersByTime(300); });
    await settle(1, hoverResponse({ symbol: 'refund' }));
    expect(latest!.hover).not.toBeNull();

    await modUp();
    await act(async () => { jest.advanceTimersByTime(250); });

    expect(latest!.hover).toBeNull();
  });

  test('window blur clears the held state', async () => {
    await mount('snapshot-1', { mode: 'modifier' });
    await modDown();
    await act(async () => latest!.onTokenHoverEnter(REQUEST, token()));
    await act(async () => { jest.advanceTimersByTime(300); });
    await settle(0, hoverResponse());
    expect(latest!.hover).not.toBeNull();

    await act(async () => { window.dispatchEvent(new Event('blur')); });
    expect(latest!.hover).toBeNull();

    await act(async () => latest!.onTokenHoverEnter(REQUEST, token()));
    await act(async () => { jest.advanceTimersByTime(10_000); });
    expect(pending).toHaveLength(1);
  });

  test('the gate paints the navigable-target affordance on the parked token', async () => {
    const paint = (armed: boolean, el: HTMLElement | null) => {
      if (el) el.classList.toggle('pn-token-nav', armed);
    };
    await mount('snapshot-1', { mode: 'modifier', onModifierGate: paint });

    const parked = token();
    await act(async () => latest!.onTokenHoverEnter(REQUEST, parked));
    expect(parked.classList.contains('pn-token-nav')).toBe(false);

    await modDown();
    expect(parked.classList.contains('pn-token-nav')).toBe(true);

    await modUp();
    expect(parked.classList.contains('pn-token-nav')).toBe(false);
  });

  test('a chord and a blur take the affordance with them too', async () => {
    const paint = (armed: boolean, el: HTMLElement | null) => {
      if (el) el.classList.toggle('pn-token-nav', armed);
    };
    await mount('snapshot-1', { mode: 'modifier', onModifierGate: paint });

    const parked = token();
    await act(async () => latest!.onTokenHoverEnter(REQUEST, parked));

    await modDown();
    await modChord('c');
    expect(parked.classList.contains('pn-token-nav')).toBe(false);

    await modDown();
    expect(parked.classList.contains('pn-token-nav')).toBe(true);
    await act(async () => { window.dispatchEvent(new Event('blur')); });
    expect(parked.classList.contains('pn-token-nav')).toBe(false);
  });

  test('hover mode ignores the key entirely', async () => {
    await mount('snapshot-1', { mode: 'hover' });
    await act(async () => latest!.onTokenHoverEnter(REQUEST, token()));
    await act(async () => { jest.advanceTimersByTime(300); });
    await settle(0, hoverResponse());
    expect(latest!.hover).not.toBeNull();

    await modUp();
    await act(async () => { jest.advanceTimersByTime(1000); });

    expect(latest!.hover).not.toBeNull();
  });
});

describe.skipIf(!hasDom)('useTokenHover References handoff', () => {
  test('an open card is gone the moment References is invoked', async () => {
    await mount('snapshot-1', { mode: 'modifier' });
    await modDown();
    await act(async () => latest!.onTokenHoverEnter(REQUEST, token()));
    await act(async () => { jest.advanceTimersByTime(300); });
    await settle(0, hoverResponse());
    expect(latest!.hover).not.toBeNull();

    await act(async () => latest!.close());

    expect(latest!.hover).toBeNull();
  });

  test('a click during the dwell cancels the card instead of letting it land later', async () => {
    await mount('snapshot-1', { mode: 'modifier' });
    await modDown();
    await act(async () => latest!.onTokenHoverEnter(REQUEST, token()));
    await act(async () => { jest.advanceTimersByTime(200); });

    await act(async () => latest!.close());

    await act(async () => { jest.advanceTimersByTime(10_000); });
    expect(pending).toHaveLength(0);
    expect(latest!.hover).toBeNull();
  });

  test('a click after the request launched abandons the in-flight answer', async () => {
    await mount('snapshot-1', { mode: 'modifier' });
    await modDown();
    await act(async () => latest!.onTokenHoverEnter(REQUEST, token()));
    await act(async () => { jest.advanceTimersByTime(300); });
    expect(pending).toHaveLength(1);

    await act(async () => latest!.close());
    expect(pending[0].signal?.aborted).toBe(true);

    await act(async () => { jest.advanceTimersByTime(10_000); });
    expect(latest!.hover).toBeNull();
  });
});

describe.skipIf(!hasDom)('useTokenHover delay', () => {
  test('the configured delay is the dwell, not the shipped constant', async () => {
    await mount('snapshot-1', { delayMs: 700 });
    await act(async () => latest!.onTokenHoverEnter(REQUEST, token()));

    await act(async () => { jest.advanceTimersByTime(350); });
    expect(pending).toHaveLength(0);

    await act(async () => { jest.advanceTimersByTime(350); });
    expect(pending).toHaveLength(1);
  });
});
