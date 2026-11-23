import { describe, expect, test } from 'bun:test';
import {
  PLAN_CARDS,
  PRICED_PLAN_ORDER,
  PRICED_PLANS,
  QUESTIONS,
  UNLIMITED_FACTS,
  YEARLY_SAVING,
  planPriceWords,
} from './src/lib/spaces-pricing';

// The Spaces pricing page states prices in three places (the cards, the Yearly
// line, the first answer). These guard that they never disagree.
describe('Spaces pricing facts', () => {
  test('the cards show $0, $29 and $99 a month, and $0, $319 and $1,089 a year', () => {
    expect(PLAN_CARDS.map((card) => card.price('month'))).toEqual([
      { amount: '$0', per: null },
      { amount: '$29', per: 'a month' },
      { amount: '$99', per: 'a month' },
    ]);
    expect(PLAN_CARDS.map((card) => card.price('year'))).toEqual([
      { amount: '$0', per: null },
      { amount: '$319', per: 'a year' },
      { amount: '$1,089', per: 'a year' },
    ]);
  });

  test('every paid plan saves what the Yearly line promises', () => {
    for (const plan of PRICED_PLAN_ORDER) {
      const cents = PRICED_PLANS[plan].cents;
      if (cents === null) continue;
      const monthsPaid = cents.year / cents.month;
      const percentOff = Math.floor((1 - monthsPaid / 12) * 100);
      expect(YEARLY_SAVING, plan).toBe(`${12 - monthsPaid === 1 ? 'one month' : `${12 - monthsPaid} months`} free, ${percentOff} percent off`);
    }
  });

  test('the first answer names the prices the cards show', () => {
    const answer = QUESTIONS[0]?.answer ?? '';
    for (const plan of ['team', 'team_unlimited'] as const) {
      expect(answer).toContain(`${planPriceWords(plan, 'month')} or ${planPriceWords(plan, 'year')}`);
    }
  });

  test('every card has three rows, so the cards line up', () => {
    expect(PLAN_CARDS.map((card) => card.includes.length)).toEqual([3, 3, 3]);
  });

  test("the Free card's member and guest limits are the ones the answers use", () => {
    const free = PLAN_CARDS.find((card) => card.id === 'free')?.includes ?? [];
    const members = free.map((row) => /^Up to (\d+) members$/.exec(row)?.[1]).find(Boolean);
    const guests = free.map((row) => /^Up to (\d+) guests$/.exec(row)?.[1]).find(Boolean);
    expect(members).toBeDefined();
    expect(guests).toBeDefined();
    const answers = QUESTIONS.map((item) => item.answer).join(' ');
    expect(answers).toContain(`Free holds up to ${guests} guests.`);
    expect(answers).toContain(`for up to ${members} members and ${guests} guests`);
  });

  test('the line under the cards says unlimited guests only where the paid cards do, and Free states its limit', () => {
    expect(UNLIMITED_FACTS).toEqual(['Unlimited agents', 'Unlimited guests']);
    const rows = (id: string) => PLAN_CARDS.find((card) => card.id === id)?.includes ?? [];
    expect(rows('team')).toContain('Unlimited guests');
    expect(rows('team_unlimited')).toContain('Unlimited guests');
    expect(rows('free').some((row) => /^Up to \d+ guests$/.test(row))).toBe(true);
    expect(rows('free')).not.toContain('Unlimited guests');
  });

  test("the Team card's member limit is the one the questions use", () => {
    const limit = PRICED_PLANS.team.memberLimit;
    const team = PLAN_CARDS.find((card) => card.id === 'team');
    expect(team?.line).toBe(`For teams of up to ${limit}.`);
    expect(QUESTIONS.some((item) => item.question === `What happens at ${(limit ?? 0) + 1} members?`)).toBe(true);
  });
});
