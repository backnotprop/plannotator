/**
 * Linear hover cards in the window (linearCards.tsx, through @plannotator/ui's ref card providers seam). What
 * can regress: a bare identifier of the workspace's teams not linking (or linking inside a URL, a path, a longer
 * token, or for another team), a Linear link not naming a
 * card target, and the card not being Linear's (its state name, fields, Open in Linear and its accessible name). Static rendering, no DOM.
 */
import { afterEach, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { InlineMarkdown } from '@plannotator/ui/components/InlineMarkdown';
import { RefCardView } from '@plannotator/ui/components/RefHoverCard';
import { refCardTarget, setRefCardTransport } from '@plannotator/ui/utils/refCard';
import { providedRefCardLabel, registerPlainTextLinker, registerRefCardProvider } from '@plannotator/ui/utils/refCardProviders';
import type { ForgeRefCardResult } from '@plannotator/core/forge-ref-card';
import { linearIdentifierLinker, linearRefCardProvider } from './linearCards';

const undo: (() => void)[] = [];
afterEach(() => {
  for (const u of undo.splice(0).reverse()) u();
  setRefCardTransport(null);
});

const html = (text: string) => renderToStaticMarkup(createElement(InlineMarkdown, { text }));
const links = (text: string) => [...html(text).matchAll(/<a [^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/g)].map((m) => [m[1], m[2]]);

test('bare identifiers of the teams link to Linear; nothing else does; nothing without a linker', () => {
  expect(links('See ENG-123.')).toEqual([]);
  undo.push(registerPlainTextLinker(linearIdentifierLinker({ workspace: 'acme', teams: ['ENG'] })));
  expect(links('See ENG-123 and (ENG-7).')).toEqual([
    ['https://linear.app/acme/issue/ENG-123', 'ENG-123'],
    ['https://linear.app/acme/issue/ENG-7', 'ENG-7'],
  ]);
  // Another team's key, a lowercase one, a longer token, a path, a version: text.
  expect(links('OPS-1 eng-2 XENG-3 ENG-4x src/ENG-5 ENG-0')).toEqual([]);
  // Inside a bare URL: the URL's own link, no second one.
  expect(links('https://example.com/ENG-9 then ENG-10')).toEqual([
    ['https://example.com/ENG-9', 'https://example.com/ENG-9'],
    ['https://linear.app/acme/issue/ENG-10', 'ENG-10'],
  ]);
  // Inside code: untouched.
  expect(links('`ENG-11`')).toEqual([]);
});

test('a Linear link is a card target once a provider is registered, and its card is Linear\'s', () => {
  setRefCardTransport(async () => null);
  const href = 'https://linear.app/acme/issue/ENG-123/retry';
  expect(refCardTarget(href)).toBeNull();
  undo.push(registerRefCardProvider(linearRefCardProvider));
  const target = refCardTarget(href)!;
  expect(target).toMatchObject({ platform: 'linear', owner: 'acme', repo: 'ENG', number: 123 });
  // The card's accessible name gives the Linear identifier, not a forge's "Issue #123".
  expect(providedRefCardLabel(target)).toBe('Linear issue ENG-123');
  // A forge link is still the forge's.
  expect(refCardTarget('https://github.com/acme/api/pull/7')).toMatchObject({ platform: 'github' });

  const result = {
    ok: true,
    fetchedAt: 0,
    data: {
      platform: 'linear', kind: 'issue', repo: 'ENG', number: 123, url: href, title: 'Retry webhook deliveries', state: 'open',
      author: { login: 'ada', avatarUrl: null }, createdAt: '2026-11-01T10:00:00.000Z', updatedAt: '2026-11-09T10:00:00.000Z', closedAt: null,
      labels: [], assignees: [], comments: 2, body: 'Deliveries that time out are dropped.', bodyCut: false, lastComment: null,
      linked: [{ number: 7, title: 'Retry deliveries', url: 'https://github.com/acme/api/pull/7', state: 'merged' }],
      linear: { identifier: 'ENG-123', team: 'Engineering', stateName: 'In Review', stateType: 'started', stateColor: '0f783c', priority: 'High', project: 'Webhooks', estimate: 3 },
    },
  } as unknown as ForgeRefCardResult;
  const card = renderToStaticMarkup(createElement(RefCardView, { target, href, result }));
  expect(card).toContain('data-ref-card-linear');
  expect(card).toContain('In Review');
  expect(card).toContain('Engineering');
  expect(card).toContain('High priority');
  expect(card).toContain('Webhooks');
  expect(card).toContain('Pull requests');
  expect(card).toContain('Open in Linear');
  expect(card).not.toContain('GitHub');
  const failed = renderToStaticMarkup(createElement(RefCardView, { target, href, result: { ok: false, error: 'signed_out', fetchedAt: 0 } }));
  expect(failed).toContain('Settings → Accounts');
});
