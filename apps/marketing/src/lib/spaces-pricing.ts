// The words and numbers on the Spaces pricing page (src/pages/workspaces/pricing.astro).
// Ported from the Spaces app's pricing page: its plan facts (plan-words.ts) and its
// words (pricing/content.ts). Change them there first, then here.

export type BillingInterval = 'month' | 'year';
export type PricedPlan = 'free' | 'team_5' | 'team_10' | 'team_unlimited';

export const PRICED_PLAN_ORDER: readonly PricedPlan[] = ['free', 'team_5', 'team_10', 'team_unlimited'];

const GIB = 1_073_741_824;

interface PricedPlanFacts {
  readonly name: string;
  readonly cents: Readonly<Record<BillingInterval, number>> | null;
  readonly memberLimit: number | null;
  readonly guestLimit: number | null;
  readonly uploadBytes: number;
}

export const PRICED_PLANS: Readonly<Record<PricedPlan, PricedPlanFacts>> = {
  free: { name: 'Free', cents: null, memberLimit: 3, guestLimit: 3, uploadBytes: 10 * GIB },
  team_5: { name: 'Team 5', cents: { month: 2900, year: 31900 }, memberLimit: 5, guestLimit: null, uploadBytes: 100 * GIB },
  team_10: { name: 'Team 10', cents: { month: 5900, year: 64900 }, memberLimit: 10, guestLimit: null, uploadBytes: 200 * GIB },
  team_unlimited: {
    name: 'Team Unlimited',
    cents: { month: 11900, year: 130900 },
    memberLimit: null,
    guestLimit: null,
    uploadBytes: 1024 * GIB,
  },
};

export const YEARLY_SAVING = 'one month free, 8 percent off';
export const REFUND_WINDOW_DAYS = 14;
export const UNLIMITED_FACTS = ['Unlimited agents', 'Unlimited guests'] as const;
const AGENTS_UNLIMITED_WORDS = 'Agents are unlimited and free on every plan, and do not count as members.';

export const INTERVAL_WORDS: Readonly<Record<BillingInterval, string>> = {
  month: 'a month',
  year: 'a year',
};

const SIZE_UNITS = ['bytes', 'KB', 'MB', 'GB', 'TB'] as const;

export function readableBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const shown = Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/u, '');
  return unit === 0 && value === 1 ? '1 byte' : `${shown} ${SIZE_UNITS[unit]}`;
}

function moneyWords(cents: number): string {
  const whole = cents % 100 === 0;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  }).format(cents / 100);
}

export function planAmountWords(plan: PricedPlan, interval: BillingInterval): string {
  return moneyWords(PRICED_PLANS[plan].cents?.[interval] ?? 0);
}

export function planPriceWords(plan: PricedPlan, interval: BillingInterval): string {
  const amount = planAmountWords(plan, interval);
  return PRICED_PLANS[plan].cents === null ? amount : `${amount} ${INTERVAL_WORDS[interval]}`;
}

function planMemberWords(plan: PricedPlan): string {
  const limit = PRICED_PLANS[plan].memberLimit;
  return limit === null ? 'Any number of members' : `Up to ${limit} members`;
}

function planGuestWords(plan: PricedPlan): string {
  const limit = PRICED_PLANS[plan].guestLimit;
  return limit === null ? 'Unlimited guests' : `Up to ${limit} guests`;
}

export const PRICING_TITLE = 'Pricing · Plannotator Spaces';
export const HEADLINE = { plain: 'Priced', marked: 'per team.' } as const;
export const LEDE = 'No fee per person. Agents and guests are free.';
export const CLOSING_LINE = 'Bring your team.';
export const QUESTIONS_HEADING = 'Questions.';

export const BILLING_INTERVALS: ReadonlyArray<{ readonly interval: BillingInterval; readonly label: string }> = [
  { interval: 'month', label: 'Monthly' },
  { interval: 'year', label: 'Yearly' },
];

export const SAVING_LINE = `Yearly: ${YEARLY_SAVING}`;

const FREE = PRICED_PLANS.free;
const PAID = PRICED_PLAN_ORDER.filter((plan) => PRICED_PLANS[plan].cents !== null);
const CAPPED = PAID.filter((plan) => PRICED_PLANS[plan].memberLimit !== null);
const FREE_MEMBERS = FREE.memberLimit ?? 0;
const FREE_GUESTS = FREE.guestLimit ?? 0;

function room(plan: PricedPlan): string {
  return `${readableBytes(PRICED_PLANS[plan].uploadBytes)} of uploaded files`;
}

function bothPrices(plan: PricedPlan): string {
  return `${PRICED_PLANS[plan].name} is ${planPriceWords(plan, 'month')} or ${planPriceWords(plan, 'year')}.`;
}

function holds(plan: PricedPlan, at: number): string {
  const limit = PRICED_PLANS[plan].memberLimit ?? 0;
  return at === 0 ? `${PRICED_PLANS[plan].name} holds up to ${limit} members` : `${PRICED_PLANS[plan].name} up to ${limit}`;
}

export interface PlanPrice {
  readonly amount: string;
  readonly per: string | null;
}

export interface PlanCard {
  readonly id: PricedPlan;
  readonly name: string;
  readonly price: (interval: BillingInterval) => PlanPrice;
  readonly includes: readonly string[];
}

export const PLAN_CARDS: readonly PlanCard[] = PRICED_PLAN_ORDER.map((id) => ({
  id,
  name: PRICED_PLANS[id].name,
  price: (interval) => ({
    amount: planAmountWords(id, interval),
    per: PRICED_PLANS[id].cents === null ? null : INTERVAL_WORDS[interval],
  }),
  includes: [planMemberWords(id), planGuestWords(id), room(id)],
}));

export interface PricingQuestion {
  readonly question: string;
  readonly answer: string;
  readonly small?: string;
}

export const QUESTIONS: readonly PricingQuestion[] = [
  {
    question: 'What does it cost?',
    answer: `${PAID.map(bothPrices).join(' ')} Paying yearly: ${YEARLY_SAVING}.`,
  },
  {
    question: 'Is there a fee per person?',
    answer: `No. The price is per team, not per person. ${AGENTS_UNLIMITED_WORDS}`,
  },
  {
    question: 'What about clients and partners?',
    answer: `People you invite from outside the team are free and do not count as members. ${FREE.name} holds up to ${FREE_GUESTS} guests. Paid plans have no guest limit.`,
  },
  {
    question: 'What happens when a plan is full?',
    answer: `${CAPPED.map(holds).join(' and ')}. The invite asks an admin to move to the next plan.`,
  },
  {
    question: 'What is free?',
    answer: `Everything in Spaces, for up to ${FREE_MEMBERS} members and ${FREE_GUESTS} guests, with ${room('free')}. ${FREE.name} is a plan, not a trial.`,
  },
  {
    question: 'What counts as storage?',
    answer: 'Only uploaded files. Pages and their history are never counted. At the limit uploads stop and nothing is deleted.',
  },
  {
    question: 'What if we stop paying?',
    answer: 'Nothing is locked or deleted. New uploads are refused while the team is over the free amount.',
  },
  {
    question: 'Can we get a refund?',
    answer: `Write to us within ${REFUND_WINDOW_DAYS} days of a charge.`,
    small: 'Refunds are not automatic.',
  },
];
