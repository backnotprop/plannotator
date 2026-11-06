/**
 * The Inbox's moment for the "Star the repo" ask (approval "star-ask"; reveal.ts `useStarReveal`): the line decides who
 * and when it is next (packages/shared/inbox/reveals.ts), the page decides the calm moment. What regresses: the ask
 * opening on a glance at a thread (under 5 s), before the page has been open 60 s, on the first-run screen, before the
 * list loaded, or on a load the tour, an update or another one-time dialog took; the page arming it only when it is
 * `next` (it stands aside from the line: settings `reveal.aside`).
 */
import { describe, expect, test } from 'bun:test';
import { REVEAL_TIMES, revealArmed, starRevealLeaveCounts, starRevealMayClaim } from './reveal';

describe('the star ask’s moment in the Inbox', () => {
  test('leaving a thread read for 5 s or more (back to the list or on to another)', () => {
    expect(starRevealLeaveCounts({ threadId: 't', at: 1_000 }, 1_000 + REVEAL_TIMES.readMs)).toBe(true);
    expect(starRevealLeaveCounts({ threadId: 't', at: 1_000 }, 1_000 + REVEAL_TIMES.readMs - 1)).toBe(false);
  });

  test('the page open 60 s, the list loaded, not the first run, nothing else on this load', () => {
    const gate = { due: true, blocked: false, listLoaded: true, firstRun: false };
    expect(starRevealMayClaim(gate, REVEAL_TIMES.pageAgeMs)).toBe(true);
    expect(starRevealMayClaim(gate, REVEAL_TIMES.pageAgeMs - 1)).toBe(false);
    expect(starRevealMayClaim({ ...gate, due: false }, REVEAL_TIMES.pageAgeMs)).toBe(false);
    expect(starRevealMayClaim({ ...gate, blocked: true }, REVEAL_TIMES.pageAgeMs)).toBe(false);
    expect(starRevealMayClaim({ ...gate, listLoaded: false }, REVEAL_TIMES.pageAgeMs)).toBe(false);
    expect(starRevealMayClaim({ ...gate, firstRun: true }, REVEAL_TIMES.pageAgeMs)).toBe(false);
  });

  test('armed from settings `reveal.aside`, beside whatever is next (never as next)', () => {
    expect(revealArmed({ reveal: { next: 'snooze', aside: ['star'] }, snooze_intro: { due: true } })).toMatchObject({ next: 'snooze', snoozeDue: true, aside: ['star'] });
    expect(revealArmed({ reveal: { next: null } }).aside).toEqual([]);
  });
});
