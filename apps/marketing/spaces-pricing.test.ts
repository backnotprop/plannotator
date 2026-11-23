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
  test('four cards: $0, $29, $59 and $119 a month, and $0, $319, $649 and $1,309 a year', () => {
    expect(PLAN_CARDS.map((card) => card.name)).toEqual(['Free', 'Team 5', 'Team 10', 'Team Unlimited']);
    expect(PLAN_CARDS.map((card) => card.price('month'))).toEqual([
      { amount: '$0', per: null },
      { amount: '$29', per: 'a month' },
      { amount: '$59', per: 'a month' },
      { amount: '$119', per: 'a month' },
    ]);
    expect(PLAN_CARDS.map((card) => card.price('year'))).toEqual([
      { amount: '$0', per: null },
      { amount: '$319', per: 'a year' },
      { amount: '$649', per: 'a year' },
      { amount: '$1,309', per: 'a year' },
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

  test('the first answer names every paid plan with the prices its card shows', () => {
    const answer = QUESTIONS[0]?.answer ?? '';
    for (const plan of PRICED_PLAN_ORDER) {
      if (PRICED_PLANS[plan].cents === null) continue;
      expect(answer).toContain(`${PRICED_PLANS[plan].name} is ${planPriceWords(plan, 'month')} or ${planPriceWords(plan, 'year')}.`);
    }
  });

  test('every card has three rows, so the cards line up', () => {
    expect(PLAN_CARDS.map((card) => card.includes.length)).toEqual([3, 3, 3, 3]);
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
    for (const card of PLAN_CARDS) {
      if (card.id === 'free') {
        expect(card.includes.some((row) => /^Up to \d+ guests$/.test(row))).toBe(true);
        expect(card.includes).not.toContain('Unlimited guests');
      } else {
        expect(card.includes, card.id).toContain('Unlimited guests');
      }
    }
  });

  test('the answer for a full plan names each capped paid plan with the member limit its card shows', () => {
    const full = QUESTIONS.find((item) => item.question === 'What happens when a plan is full?');
    expect(full).toBeDefined();
    for (const card of PLAN_CARDS) {
      const limit = card.includes.map((row) => /^Up to (\d+) members$/.exec(row)?.[1]).find(Boolean);
      if (card.id === 'free' || limit === undefined) continue;
      expect(full?.answer, card.id).toMatch(new RegExp(`${card.name} (holds )?up to ${limit}\\b`));
    }
  });

  test('no plan is called plain "Team" and no retired price is stated', () => {
    const words = [
      ...PLAN_CARDS.flatMap((card) => [card.name, ...card.includes, ...(['month', 'year'] as const).map((at) => card.price(at).amount)]),
      ...QUESTIONS.flatMap((item) => [item.question, item.answer, item.small ?? '']),
    ].join('\n');
    expect(words).not.toMatch(/\bTeam\b(?! (?:5|10|Unlimited)\b)(?=[ .,])/);
    expect(words).not.toContain('$99');
    expect(words).not.toContain('$1,089');
  });
});
