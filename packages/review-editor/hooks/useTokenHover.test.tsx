/**
 * useTokenHover contracts.
 *
 * Two behaviors here are the ones most likely to be "simplified" away, and
 * both are load-bearing:
 *  - the dwell gate, which is the only thing standing between a pointer
 *    sweeping across a diff and one ripgrep process per token;
 *  - the leave grace, without which the card's own reference links are
 *    unreachable (the pointer has to cross the gap to get to them).
 * Plus the silent-failure rule: an unavailable backend or a thin answer must
 * render nothing at all, never an empty card and never a toast.
 */
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

/**
 * The gate's modifier going down/up on the window, the way the browser reports
 * it. Platform-derived so the suite exercises the same key the product does on
 * whatever machine it runs: Cmd on macOS, Ctrl on the Linux CI runner.
 */
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

/** A chord (copy) while the modifier is held: a command, not a hover intent. */
async function modChord(key: string, target: EventTarget = window): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, ...held, bubbles: true }));
  });
}

function token(): HTMLElement {
  const el = document.createElement('span');
  document.body.appendChild(el);
  return el;
}

/** Resolve a pending fetch and let the hook's await chain run. */
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

    await act(async () => { jest.advanceTimersByTime(349); });
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
    await act(async () => { jest.advanceTimersByTime(350); });
    expect(pending).toHaveLength(1);

    await act(async () => {
      latest!.onTokenHoverEnter({ ...REQUEST, symbol: 'withRetry' }, token());
    });
    expect(pending[0].signal?.aborted).toBe(true);

    await act(async () => { jest.advanceTimersByTime(350); });
    expect(pending).toHaveLength(2);
    expect(pending[1].request.symbol).toBe('withRetry');
  });

  test('the card survives the leave grace and entering it cancels the close', async () => {
    await mount();
    await act(async () => latest!.onTokenHoverEnter(REQUEST, token()));
    await act(async () => { jest.advanceTimersByTime(350); });
    await settle(0, hoverResponse());
    expect(latest!.hover).not.toBeNull();

    await act(async () => latest!.onTokenHoverLeave());
    // Still open partway through the grace, which is what makes the card's own
    // links reachable across the gap.
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
    await act(async () => { jest.advanceTimersByTime(350); });
    await settle(0, hoverResponse());

    await act(async () => latest!.onTokenHoverLeave());
    await act(async () => { jest.advanceTimersByTime(250); });
    await act(async () => latest!.onTokenHoverEnter(REQUEST, token()));
    await act(async () => { jest.advanceTimersByTime(350); });

    expect(pending).toHaveLength(1);
    expect(latest!.hover).not.toBeNull();
  });

  test('an unavailable backend renders nothing', async () => {
    await mount();
    await act(async () => latest!.onTokenHoverEnter(REQUEST, token()));
    await act(async () => { jest.advanceTimersByTime(350); });
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
    await act(async () => { jest.advanceTimersByTime(350); });
    await settle(0, hoverResponse({
      definition: null,
      references: [{ filePath: 'src/other.js', line: 4, column: 2, snippet: 'charge(1)' }],
      referenceCount: 1,
    }));

    expect(latest!.hover).toBeNull();
  });

  test('a neighbour answer never lands in an open card for another token', async () => {
    // Drift onto a neighbour long enough to launch its request, then come
    // back. Without the guard on the already-open branch, the neighbour's
    // answer still passes the landing check and silently rewrites the open
    // card to a symbol the pointer is not on.
    await mount();
    const tokenX = token();
    await act(async () => latest!.onTokenHoverEnter(REQUEST, tokenX));
    await act(async () => { jest.advanceTimersByTime(350); });
    await settle(0, hoverResponse());
    expect(latest!.hover!.data.symbol).toBe('charge');

    const neighbour = { ...REQUEST, symbol: 'withRetry' };
    await act(async () => latest!.onTokenHoverLeave());
    await act(async () => latest!.onTokenHoverEnter(neighbour, token()));
    await act(async () => { jest.advanceTimersByTime(350); });
    expect(pending).toHaveLength(2);

    // Back onto the still-open card's token, then the neighbour answers.
    await act(async () => latest!.onTokenHoverLeave());
    await act(async () => latest!.onTokenHoverEnter(REQUEST, tokenX));
    expect(pending[1].signal?.aborted).toBe(true);
    await settle(1, hoverResponse({ symbol: 'withRetry' }));

    expect(latest!.hover).not.toBeNull();
    expect(latest!.hover!.data.symbol).toBe('charge');
  });

  test('re-entering the same token joins the in-flight request', async () => {
    // Leave and return inside the grace: the dwell re-arms while this key's
    // own request is still running. A second launch would be one more
    // ripgrep process for an answer already on its way.
    await mount();
    const tokenX = token();
    await act(async () => latest!.onTokenHoverEnter(REQUEST, tokenX));
    await act(async () => { jest.advanceTimersByTime(350); });
    expect(pending).toHaveLength(1);

    await act(async () => latest!.onTokenHoverLeave());
    await act(async () => { jest.advanceTimersByTime(100); });
    await act(async () => latest!.onTokenHoverEnter(REQUEST, tokenX));
    await act(async () => { jest.advanceTimersByTime(350); });

    expect(pending).toHaveLength(1);
    expect(pending[0].signal?.aborted).toBe(false);

    // And the joined request still opens the card.
    await settle(0, hoverResponse());
    expect(latest!.hover).not.toBeNull();
  });

  test('a below-threshold answer for another token closes the stale card', async () => {
    await mount();
    await act(async () => latest!.onTokenHoverEnter(REQUEST, token()));
    await act(async () => { jest.advanceTimersByTime(350); });
    await settle(0, hoverResponse());
    expect(latest!.hover).not.toBeNull();

    await act(async () => latest!.onTokenHoverLeave());
    await act(async () => {
      latest!.onTokenHoverEnter({ ...REQUEST, symbol: 'gateway' }, token());
    });
    await act(async () => { jest.advanceTimersByTime(350); });
    await settle(1, hoverResponse({
      symbol: 'gateway',
      definition: null,
      references: [],
      referenceCount: 0,
    }));

    // The card described a token the pointer has left, and the token it is on
    // has nothing to say. Neither is a reason to keep showing the old one.
    expect(latest!.hover).toBeNull();
  });

  test('an answer for a token no longer in the DOM opens no card', async () => {
    // Virtualized scroll recycles diff rows. A rect measured on a detached
    // element is 0,0, which would pin the card to the viewport corner.
    await mount();
    const recycled = token();
    await act(async () => latest!.onTokenHoverEnter(REQUEST, recycled));
    await act(async () => { jest.advanceTimersByTime(350); });
    recycled.remove();
    await settle(0, hoverResponse());

    expect(latest!.hover).toBeNull();
  });

  test('scrolling inside the card leaves it open; scrolling the pane closes it', async () => {
    await mount();
    await act(async () => latest!.onTokenHoverEnter(REQUEST, token()));
    await act(async () => { jest.advanceTimersByTime(350); });
    await settle(0, hoverResponse());

    // The signature block is a horizontal scroller: reading a long signature
    // must not dismiss the thing being read.
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
    // Line numbers from the previous diff are wrong for the new one, so a
    // cached answer must never be served across a refresh.
    await mount('snapshot-1');
    await act(async () => latest!.onTokenHoverEnter(REQUEST, token()));
    await act(async () => { jest.advanceTimersByTime(350); });
    await settle(0, hoverResponse());
    expect(pending).toHaveLength(1);

    await act(async () => {
      root!.render(<Harness snapshotId="snapshot-2" />);
    });
    expect(latest!.hover).toBeNull();

    await act(async () => latest!.onTokenHoverEnter(REQUEST, token()));
    await act(async () => { jest.advanceTimersByTime(350); });
    expect(pending).toHaveLength(2);
  });

  test('unmounting abandons the pending request', async () => {
    await mount();
    await act(async () => latest!.onTokenHoverEnter(REQUEST, token()));
    await act(async () => { jest.advanceTimersByTime(350); });
    expect(pending).toHaveLength(1);

    const current = root!;
    root = null;
    await act(async () => current.unmount());

    expect(pending[0].signal?.aborted).toBe(true);
  });

  test('scrolling closes the card and abandons the pending request', async () => {
    await mount();
    await act(async () => latest!.onTokenHoverEnter(REQUEST, token()));
    await act(async () => { jest.advanceTimersByTime(350); });
    expect(pending).toHaveLength(1);

    await act(async () => {
      document.dispatchEvent(new Event('scroll'));
    });
    expect(pending[0].signal?.aborted).toBe(true);
    expect(latest!.hover).toBeNull();
  });
});

/**
 * The trigger mode's whole promise is "with the key up this costs nothing".
 * The failure to catch is a gate that lands AFTER the dwell timer arms, which
 * would silently restore one ripgrep per token on an idle sweep and make the
 * mode a cosmetic filter over the same traffic.
 */
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

    await act(async () => { jest.advanceTimersByTime(350); });
    expect(pending).toHaveLength(1);
    await settle(0, hoverResponse());
    expect(latest!.hover?.request.symbol).toBe('charge');
  });

  test('pressing the key while already parked on a token opens the card', async () => {
    // The commonest gesture in this mode. A key press fires no pointer event,
    // so a gate that only reads the enter event would make it do nothing.
    await mount('snapshot-1', { mode: 'modifier' });
    await act(async () => latest!.onTokenHoverEnter(REQUEST, token()));
    expect(pending).toHaveLength(0);

    await modDown();
    await act(async () => { jest.advanceTimersByTime(350); });

    expect(pending).toHaveLength(1);
  });

  test('a token left before the key goes down is not resurrected by it', async () => {
    await mount('snapshot-1', { mode: 'modifier' });
    await act(async () => latest!.onTokenHoverEnter(REQUEST, token()));
    await act(async () => latest!.onTokenHoverLeave());

    await modDown();
    await act(async () => { jest.advanceTimersByTime(350); });

    expect(pending).toHaveLength(0);
  });

  test('releasing the key closes the card the way leaving does', async () => {
    await mount('snapshot-1', { mode: 'modifier' });
    await modDown();
    await act(async () => latest!.onTokenHoverEnter(REQUEST, token()));
    await act(async () => { jest.advanceTimersByTime(350); });
    await settle(0, hoverResponse());
    expect(latest!.hover).not.toBeNull();

    await modUp();
    // The same leave grace, so the card's own reference links stay reachable.
    expect(latest!.hover).not.toBeNull();
    await act(async () => { jest.advanceTimersByTime(250); });
    expect(latest!.hover).toBeNull();
  });

  test('releasing the key while reading the card does not yank it away', async () => {
    await mount('snapshot-1', { mode: 'modifier' });
    await modDown();
    await act(async () => latest!.onTokenHoverEnter(REQUEST, token()));
    await act(async () => { jest.advanceTimersByTime(350); });
    await settle(0, hoverResponse());
    await act(async () => latest!.onCardEnter());

    await modUp();
    await act(async () => { jest.advanceTimersByTime(1000); });

    expect(latest!.hover).not.toBeNull();
  });

  test('modifier chords in a comment box do not pop a card over the diff', async () => {
    // Cmd+C, Cmd+V, Cmd+A. The pointer is often parked over the diff while
    // writing a comment, so arming on those would open cards mid-sentence.
    await mount('snapshot-1', { mode: 'modifier' });
    await act(async () => latest!.onTokenHoverEnter(REQUEST, token()));

    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    await modChord('c', textarea);
    await act(async () => { jest.advanceTimersByTime(1000); });
    textarea.remove();

    expect(pending).toHaveLength(0);
  });

  test('a copy chord with the pointer parked on a token opens nothing', async () => {
    // The modifier that gates this feature is also the editing modifier, and
    // the pointer is wherever it was left. Only the key ALONE is a request to
    // be told about a symbol; Cmd+C is a command, and must not pop a card
    // over the diff mid-copy.
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
    await act(async () => { jest.advanceTimersByTime(350); });
    await settle(0, hoverResponse());
    expect(latest!.hover).not.toBeNull();

    await modChord('c');
    await act(async () => { jest.advanceTimersByTime(250); });

    expect(latest!.hover).toBeNull();
  });

  test('a card closed while the pointer was inside it does not deafen the next release', async () => {
    // The reviewer's exact sequence. onCardEnter sets "pointer is in the card"
    // and only onCardLeave used to clear it — but a scroll-close unmounts the
    // card UNDER the pointer, so no leave ever arrives. The flag stayed true
    // for the rest of the session and every later Alt release was ignored as
    // "they are reading the card", leaving cards stuck open.
    await mount('snapshot-1', { mode: 'modifier' });
    await modDown();
    await act(async () => latest!.onTokenHoverEnter(REQUEST, token()));
    await act(async () => { jest.advanceTimersByTime(350); });
    await settle(0, hoverResponse());
    await act(async () => latest!.onCardEnter());

    // Closed by a pane scroll, with the pointer still inside it.
    await act(async () => { document.dispatchEvent(new Event('scroll')); });
    expect(latest!.hover).toBeNull();

    // A fresh card on another token, then a release.
    const second = { ...REQUEST, symbol: 'refund' };
    await act(async () => latest!.onTokenHoverEnter(second, token()));
    await act(async () => { jest.advanceTimersByTime(350); });
    await settle(1, hoverResponse({ symbol: 'refund' }));
    expect(latest!.hover).not.toBeNull();

    await modUp();
    await act(async () => { jest.advanceTimersByTime(250); });

    expect(latest!.hover).toBeNull();
  });

  test('window blur clears the held state', async () => {
    // Alt+Tab: the browser reports no keyup, so without the blur reset the key
    // reads as held forever and the mode silently becomes plain hover.
    await mount('snapshot-1', { mode: 'modifier' });
    await modDown();
    await act(async () => latest!.onTokenHoverEnter(REQUEST, token()));
    await act(async () => { jest.advanceTimersByTime(350); });
    await settle(0, hoverResponse());
    expect(latest!.hover).not.toBeNull();

    await act(async () => { window.dispatchEvent(new Event('blur')); });
    expect(latest!.hover).toBeNull();

    // Held is clear, so hovering again arms nothing until Alt goes down again.
    await act(async () => latest!.onTokenHoverEnter(REQUEST, token()));
    await act(async () => { jest.advanceTimersByTime(10_000); });
    expect(pending).toHaveLength(1);
  });

  test('hover mode ignores the key entirely', async () => {
    await mount('snapshot-1', { mode: 'hover' });
    await act(async () => latest!.onTokenHoverEnter(REQUEST, token()));
    await act(async () => { jest.advanceTimersByTime(350); });
    await settle(0, hoverResponse());
    expect(latest!.hover).not.toBeNull();

    await modUp();
    await act(async () => { jest.advanceTimersByTime(1000); });

    // No key listeners exist in this mode, so a stray keyup cannot close it.
    expect(latest!.hover).not.toBeNull();
  });
});

/**
 * Opening the References panel must never leave a hover card on screen. The
 * App funnels EVERY route in (Cmd+click, Ctrl+click, the Alt+click alias, the
 * card's own location links) through handleCodeNavRequest, which calls close()
 * first. These two tests own the mechanism that handoff depends on; the
 * "References handoff wiring" suite below pins that the App still calls it.
 *
 * Both cases are real: Alt+click on a token the pointer has been resting on is
 * the overlap #1461 shipped with, and in modifier mode it is the NORMAL way to
 * click, since the alias and the trigger share the key.
 */
describe.skipIf(!hasDom)('useTokenHover References handoff', () => {
  test('an open card is gone the moment References is invoked', async () => {
    await mount('snapshot-1', { mode: 'modifier' });
    await modDown();
    await act(async () => latest!.onTokenHoverEnter(REQUEST, token()));
    await act(async () => { jest.advanceTimersByTime(350); });
    await settle(0, hoverResponse());
    expect(latest!.hover).not.toBeNull();

    // What the Alt+click handler does before resolving the symbol.
    await act(async () => latest!.close());

    expect(latest!.hover).toBeNull();
  });

  test('a click during the dwell cancels the card instead of letting it land later', async () => {
    // Without this the request completes behind the panel and opens a card
    // over it, seconds after a click that meant "navigate, not explain".
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
    await act(async () => { jest.advanceTimersByTime(350); });
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
