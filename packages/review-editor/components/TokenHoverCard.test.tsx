/**
 * TokenHoverCard rendering.
 *
 * Guards what the card is allowed to say. The first mock leaked engineering
 * vocabulary (a source chip, "likely definition", a candidate count, an
 * "rg · 38ms" readout) and the ruling removed all of it: uncertainty is shown
 * by naming the alternative location, never by describing the algorithm. Those
 * are the assertions that catch a drift back, along with the two structural
 * facts the reader depends on: the reference list is capped and says how many
 * it left out, and a location click routes into the References flow.
 */
import { afterEach, describe, expect, jest, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CodeNavHoverResponse, CodeNavRequest } from '@plannotator/shared/code-nav';
import { TokenHoverCard } from './TokenHoverCard';
import { useTokenHover, type TokenHoverState } from '../hooks/useTokenHover';

const hasDom = typeof document !== 'undefined';

const REQUEST: CodeNavRequest = {
  symbol: 'charge',
  filePath: 'src/pay.js',
  line: 2,
  charStart: 16,
  side: 'new',
  language: 'javascript',
};

function response(overrides: Partial<CodeNavHoverResponse> = {}): CodeNavHoverResponse {
  return {
    backend: 'search',
    source: 'search',
    symbol: 'charge',
    definition: {
      filePath: 'src/pay.js',
      line: 4,
      column: 16,
      confidence: 'likely',
      symbolKind: 'function',
      signature: 'export function charge(amount, key) {',
      signatureApproximate: true,
      doc: 'Charges the card.',
      preview: null,
      otherCandidateCount: 0,
    },
    alternateDefinition: null,
    references: [],
    referenceCount: 0,
    capped: false,
    stats: { elapsedMs: 38 },
    ...overrides,
  };
}

function state(data: CodeNavHoverResponse): TokenHoverState {
  return { request: REQUEST, data, rect: new DOMRect(20, 40, 50, 16) };
}

let host: HTMLDivElement | null = null;
let root: Root | null = null;

async function render(node: React.ReactElement): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(node);
  });
  const card = document.querySelector('[data-token-hover-card]');
  if (!(card instanceof HTMLElement)) throw new Error('card did not render');
  return card;
}

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => current.unmount());
    root = null;
  }
  host?.remove();
  host = null;
});

describe.skipIf(!hasDom)('TokenHoverCard', () => {
  test('shows the symbol, its kind, the signature cue and the definition location', async () => {
    const card = await render(
      <TokenHoverCard
        hover={state(response())}
        onPointerEnter={() => {}}
        onPointerLeave={() => {}}
        onSelectLocation={() => {}}
      />,
    );

    const text = card.textContent ?? '';
    expect(text).toContain('charge');
    expect(text).toContain('function');
    expect(text).toContain('export function charge(amount, key) {');
    // The approximate cue is what stops an eyeballed line reading as a parsed
    // signature.
    expect(text).toContain('// matched line');
    expect(text).toContain('Charges the card.');
    expect(text).toContain('src/pay.js:4');
  });

  test('omits the kind badge, the signature block and the doc when the search found none', async () => {
    const card = await render(
      <TokenHoverCard
        hover={state(response({
          definition: {
            filePath: 'src/pay.js',
            line: 4,
            column: 16,
            confidence: 'possible',
            symbolKind: null,
            signature: null,
            signatureApproximate: false,
            doc: null,
            preview: null,
            otherCandidateCount: 0,
          },
        }))}
        onPointerEnter={() => {}}
        onPointerLeave={() => {}}
        onSelectLocation={() => {}}
      />,
    );

    const text = card.textContent ?? '';
    expect(text).not.toContain('// matched line');
    expect(text).not.toContain('function');
    expect(text).toContain('src/pay.js:4');
  });

  test('names the runner-up location instead of describing the ranking', async () => {
    const card = await render(
      <TokenHoverCard
        hover={state(response({
          alternateDefinition: { filePath: 'src/legacy/retry.js', line: 31, column: 9 },
        }))}
        onPointerEnter={() => {}}
        onPointerLeave={() => {}}
        onSelectLocation={() => {}}
      />,
    );

    const text = card.textContent ?? '';
    expect(text).toContain('or possibly');
    expect(text).toContain('src/legacy/retry.js:31');
  });

  test('caps the reference list and says how many it left out', async () => {
    const references = Array.from({ length: 5 }, (_, i) => ({
      filePath: `src/f${i}.js`,
      line: i + 1,
      column: 2,
      snippet: 'charge(1)',
    }));
    const card = await render(
      <TokenHoverCard
        hover={state(response({ references, referenceCount: 9 }))}
        onPointerEnter={() => {}}
        onPointerLeave={() => {}}
        onSelectLocation={() => {}}
      />,
    );

    const text = card.textContent ?? '';
    expect(text).toContain('9 references');
    expect(text).toContain('… 4 more in the References panel');
    expect(card.querySelectorAll('button').length).toBe(6); // definition + 5 refs
  });

  test('renders no rank vocabulary, no source chip and no latency readout', async () => {
    const card = await render(
      <TokenHoverCard
        // Every optional row is present, so the sweep covers the overflow line
        // and the alternate-location line too, not just the always-on chrome.
        hover={state(response({
          references: Array.from({ length: 5 }, (_, i) => ({
            filePath: `src/f${i}.js`,
            line: i + 1,
            column: 2,
            snippet: 'charge(1)',
          })),
          referenceCount: 12,
          capped: true,
          alternateDefinition: { filePath: 'src/legacy.js', line: 31, column: 9 },
        }))}
        onPointerEnter={() => {}}
        onPointerLeave={() => {}}
        onSelectLocation={() => {}}
      />,
    );

    const text = card.textContent ?? '';
    // Every optional row really is on screen for this sweep.
    expect(text).toContain('or possibly');
    expect(text).toContain('more in the References panel');
    for (const banned of ['ranked', 'likely', 'candidate', 'confidence', '38ms', 'rg ·']) {
      expect(text.toLowerCase()).not.toContain(banned.toLowerCase());
    }
    // Em dashes are barred from every string this feature renders.
    expect(text).not.toContain('—');
  });

  test('a location click routes into the References flow', async () => {
    const selected: Array<{ filePath: string; line: number }> = [];
    const card = await render(
      <TokenHoverCard
        hover={state(response())}
        onPointerEnter={() => {}}
        onPointerLeave={() => {}}
        onSelectLocation={(location) => selected.push(location)}
      />,
    );

    const link = card.querySelector('button');
    await act(async () => {
      link!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(selected).toHaveLength(1);
    expect(selected[0].filePath).toBe('src/pay.js');
    expect(selected[0].line).toBe(4);
  });

  test('opens end to end from a hover answer, with no card before one arrives', async () => {
    const originalFetch = globalThis.fetch;
    let settle: ((data: CodeNavHoverResponse) => void) | null = null;
    globalThis.fetch = (() =>
      new Promise((resolve) => {
        settle = (data) => resolve(new Response(JSON.stringify(data)));
      })) as typeof globalThis.fetch;
    jest.useFakeTimers();

    let hover: ReturnType<typeof useTokenHover> | null = null;
    function Harness() {
      hover = useTokenHover('snapshot-1');
      return hover.hover ? (
        <TokenHoverCard
          hover={hover.hover}
          onPointerEnter={hover.onCardEnter}
          onPointerLeave={hover.onCardLeave}
          onSelectLocation={() => {}}
        />
      ) : null;
    }

    try {
      host = document.createElement('div');
      document.body.appendChild(host);
      root = createRoot(host);
      await act(async () => { root!.render(<Harness />); });

      const token = document.createElement('span');
      document.body.appendChild(token);
      await act(async () => hover!.onTokenHoverEnter(REQUEST, token));
      await act(async () => { jest.advanceTimersByTime(350); });
      // Dwell passed, answer not back: still nothing on screen. No skeleton,
      // no spinner.
      expect(document.querySelector('[data-token-hover-card]')).toBeNull();

      await act(async () => {
        settle!(response());
        await Promise.resolve();
        await Promise.resolve();
      });

      const card = document.querySelector('[data-token-hover-card]');
      expect(card).not.toBeNull();
      // Portaled out of the React host so it escapes the panel overflow.
      expect(card!.parentElement).toBe(document.body);
      expect(card!.textContent).toContain('src/pay.js:4');
      token.remove();
    } finally {
      jest.useRealTimers();
      globalThis.fetch = originalFetch;
    }
  });
});
