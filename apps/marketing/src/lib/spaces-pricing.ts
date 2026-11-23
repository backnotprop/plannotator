// The words and numbers on the Spaces pricing page (src/pages/workspaces/pricing.astro).
// Ported from the Spaces app's pricing page: its plan facts (plan-words.ts, plans.ts)
// and its words (pricing/content.ts). Change them there first, then here.

export type BillingInterval = 'month' | 'year';
export type PricedPlan = 'free' | 'team' | 'team_unlimited';

export const PRICED_PLAN_ORDER: readonly PricedPlan[] = ['free', 'team', 'team_unlimited'];

const GIB = 1_073_741_824;

interface PricedPlanFacts {
  readonly name: string;
  readonly cents: Readonly<Record<BillingInterval, number>> | null;
  readonly memberLimit: number | null;
  readonly uploadBytes: number;
}

export const PRICED_PLANS: Readonly<Record<PricedPlan, PricedPlanFacts>> = {
  free: { name: 'Free', cents: null, memberLimit: null, uploadBytes: 10 * GIB },
  team: { name: 'Team', cents: { month: 2900, year: 31900 }, memberLimit: 10, uploadBytes: 100 * GIB },
  team_unlimited: {
    name: 'Team Unlimited',
    cents: { month: 9900, year: 108900 },
    memberLimit: null,
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

const NAMES = {
  free: PRICED_PLANS.free.name,
  team: PRICED_PLANS.team.name,
  team_unlimited: PRICED_PLANS.team_unlimited.name,
} as const;
const TEAM_MEMBERS = PRICED_PLANS.team.memberLimit ?? 0;

function room(plan: PricedPlan): string {
  return `${readableBytes(PRICED_PLANS[plan].uploadBytes)} of uploaded files`;
}

function bothPrices(plan: PricedPlan): string {
  return `${planPriceWords(plan, 'month')} or ${planPriceWords(plan, 'year')}`;
}

const WHO: Readonly<Record<PricedPlan, string>> = {
  free: 'For getting started.',
  team: `For teams of up to ${TEAM_MEMBERS}.`,
  team_unlimited: 'For teams of any size.',
};

const INCLUDES: Readonly<Record<PricedPlan, readonly string[]>> = {
  free: ['Everything in Spaces', room('free')],
  team: [`Up to ${TEAM_MEMBERS} members`, room('team')],
  team_unlimited: ['Any number of members', room('team_unlimited')],
};

export interface PlanPrice {
  readonly amount: string;
  readonly per: string | null;
}

export interface PlanCard {
  readonly id: PricedPlan;
  readonly name: string;
  readonly price: (interval: BillingInterval) => PlanPrice;
  readonly line: string;
  readonly includes: readonly string[];
}

export const PLAN_CARDS: readonly PlanCard[] = PRICED_PLAN_ORDER.map((id) => ({
  id,
  name: NAMES[id],
  price: (interval) => ({
    amount: planAmountWords(id, interval),
    per: PRICED_PLANS[id].cents === null ? null : INTERVAL_WORDS[interval],
  }),
  line: WHO[id],
  includes: INCLUDES[id],
}));

export interface PricingQuestion {
  readonly question: string;
  readonly answer: string;
  readonly small?: string;
}

export const QUESTIONS: readonly PricingQuestion[] = [
  {
    question: 'What does it cost?',
    answer: `${NAMES.team} is ${bothPrices('team')}. ${NAMES.team_unlimited} is ${bothPrices('team_unlimited')}. Paying yearly: ${YEARLY_SAVING}.`,
  },
  {
    question: 'Is there a fee per person?',
    answer: `No. The price is per team, not per person. ${AGENTS_UNLIMITED_WORDS}`,
  },
  {
    question: 'What about clients and partners?',
    answer: 'People you invite from outside the team are free and do not count as members.',
  },
  {
    question: `What happens at ${TEAM_MEMBERS + 1} members?`,
    answer: `${NAMES.team} holds up to ${TEAM_MEMBERS} members. The invite asks an admin to move to ${NAMES.team_unlimited}.`,
  },
  {
    question: 'What is free?',
    answer: `Everything in Spaces, with ${room('free')}. ${NAMES.free} is a plan, not a trial.`,
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
