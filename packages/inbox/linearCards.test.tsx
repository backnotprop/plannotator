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
import { loadRefCard, refCardTarget, setRefCardTransport } from '@plannotator/ui/utils/refCard';
import { providedRefCardLabel, registerPlainTextLinker, registerRefCardProvider } from '@plannotator/ui/utils/refCardProviders';
import type { ForgeRefCardResult } from '@plannotator/core/forge-ref-card';
import { installLinearCards, linearIdentifierLinker, linearRefCardProvider, refreshLinearCards } from './linearCards';

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

test("a hover's load reaches the transport for a Linear ref (no forge spec for its platform), and answers its card", async () => {
  const asked: string[] = [];
  setRefCardTransport(async (href) => {
    asked.push(href);
    return { ok: false, error: 'signed_out', fetchedAt: 0 };
  });
  undo.push(registerRefCardProvider(linearRefCardProvider));
  const href = 'https://linear.app/acme/issue/ENG-9';
  expect(await loadRefCard(href, refCardTarget(href)!)).toMatchObject({ ok: false, error: 'signed_out' });
  expect(asked).toEqual([href]);
});

test('a saved key Linear refused: its card says the key was refused and where to replace it, not to add one', async () => {
  let key = 'refused';
  setRefCardTransport(async () => null);
  undo.push(installLinearCards(async () => Response.json({ workspace: null, teams: [], key })));
  const href = 'https://linear.app/acme/issue/ENG-9';
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const target = refCardTarget(href)!; // the first Linear link asks for the teams, and with them the verdict
  await settle();
  const card = () => renderToStaticMarkup(createElement(RefCardView, { target, href, result: { ok: false, error: 'signed_out', fetchedAt: 0 } }));
  expect(card()).toContain('Linear refused the API key');
  expect(card()).toContain('Settings → Accounts → Linear');
  expect(card()).not.toContain('Add your Linear API key');
  // No key at all: the card asks for one.
  key = 'none';
  await refreshLinearCards();
  expect(card()).toContain('Add your Linear API key');
  expect(card()).not.toContain('refused');
});

test('nothing is fetched on page load: the teams are asked once, when prose first shows a candidate identifier', async () => {
  const asked: string[] = [];
  const fetchTeams = async (url: string) => {
    asked.push(url);
    return Response.json({ workspace: 'acme', teams: ['ENG'] });
  };
  undo.push(installLinearCards(fetchTeams));
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  await settle();
  expect(asked).toEqual([]);
  html('No identifiers here, just a sentence.');
  await settle();
  expect(asked).toEqual([]);
  html('See ENG-123.');
  await settle();
  expect(asked).toHaveLength(1);
  expect(asked[0]).toContain('/linear-refs');
  expect(links('See ENG-123.')).toEqual([['https://linear.app/acme/issue/ENG-123', 'ENG-123']]);
  html('And OPS-4, ENG-5.');
  await settle();
  expect(asked).toHaveLength(1);
  // Once the key's workspace is known, another workspace's link is a plain link: no card target.
  setRefCardTransport(async () => null);
  expect(refCardTarget('https://linear.app/acme/issue/ENG-1')).toMatchObject({ owner: 'acme' });
  expect(refCardTarget('https://linear.app/othercorp/issue/ENG-1')).toBeNull();
});
