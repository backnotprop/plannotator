/**
 * Which agent message carries which canvas version's preview card (parts.tsx `canvasCardsByMessage`): an agent
 * writes the canvas, then says so. What regresses: a card under the wrong message (before the write), one version
 * shown under two messages, or a card for the person's own saves.
 */
import { expect, test } from 'bun:test';
import type { CanvasVersionSummary } from './client';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CanvasCard, canvasCardsByMessage } from './parts';

const agent = { kind: 'agent' } as const;
const person = { kind: 'person' } as const;
const msg = (id: string, at: string, author: { kind: string } = agent) => ({ id, created_at: `2026-11-17T10:${at}:00.000Z`, author }) as never;
const v = (n: number, at: string, by: 'agent' | 'person' = 'agent'): CanvasVersionSummary => ({ n, by, at: `2026-11-17T10:${at}:00.000Z`, picture: true });

test('each agent message carries the latest agent version written at or before it that no earlier message carries', () => {
  const messages = [msg('m1', '00'), msg('m2', '05'), msg('p1', '06', person), msg('m3', '10'), msg('m4', '20')];
  const versions = [v(1, '04'), v(2, '05'), v(3, '07', 'person'), v(4, '09')];
  const cards = canvasCardsByMessage(messages, versions);
  expect([...cards].map(([id, c]) => [id, c.n])).toEqual([
    ['m2', 2],
    ['m3', 4],
  ]);
});

test('the person\'s saves never get a card, and a person\'s message never carries one', () => {
  const cards = canvasCardsByMessage([msg('p1', '10', person), msg('m1', '11')], [v(1, '09', 'person')]);
  expect(cards.size).toBe(0);
  const mixed = canvasCardsByMessage([msg('p1', '10', person), msg('m1', '11')], [v(1, '09')]);
  expect([...mixed.keys()]).toEqual(['m1']);
});

/** The card as a screen reader names it: its own words (no aria-label over them), tags dropped. */
const cardWords = (version: CanvasVersionSummary, state: { latest: boolean; showing: boolean }) => {
  const html = renderToStaticMarkup(createElement(CanvasCard, { threadId: 't1', version, ...state, onOpen: () => {} }));
  expect(html).not.toContain('aria-label');
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
};

test('a first version (nothing changed) shows no count; a later one names it; the state is read out with it', () => {
  expect(cardWords({ ...v(1, '04'), changed: 0 }, { latest: true, showing: false })).toBe('Canvas version 1 Open');
  expect(cardWords(v(1, '04'), { latest: true, showing: true })).toBe('Canvas version 1 Showing');
  expect(cardWords({ ...v(2, '05'), changed: 3 }, { latest: false, showing: false })).toBe('Canvas version 2 · 3 parts changed Older');
});
