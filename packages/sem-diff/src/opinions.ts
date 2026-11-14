// Bring-your-own-model second opinions for `semanticDiffFile(..., { secondOpinion })`.
// Each asks a decision model, once per candidate, whether a helper the rules rejected really was
// extracted (or inlined), with the question and cut-off measured in harness/compare/ (see
// docs/decision-models-2026-11-08.md). Keys are the user's own; call these from a server or the
// user's machine, never from a page that other people load.
import type { Candidate } from './candidate.ts';

type Fetch = typeof fetch;

/** The text a model sees: the caller before and after, then the helper (layouts tested: this one is best). */
export function candidateState(c: Candidate): string {
  const file = c.file ?? 'the file';
  const cut = (s: string) => (s.length <= 12000 ? s : s.slice(0, 12000) + '\n... (cut)');
  // Extract is detected as inline run backwards: for an extract, `caller` is the new caller.
  const [before, after] = c.kind === 'extract' ? [c.code.callerNew, c.code.caller] : [c.code.caller, c.code.callerNew];
  const where = c.kind === 'extract' ? 'added in this change' : 'removed in this change';
  return `A code change in ${file}.\n\n=== CALLER BEFORE ===\n${cut(before)}\n\n=== CALLER AFTER ===\n${cut(after)}\n\n=== HELPER \`${c.helper}\` (${where}) ===\n${cut(c.code.helper)}\n`;
}

const YES_NO = {
  extract:
    "Was code that used to be written out inside the caller moved into the helper function, so the caller now calls the helper instead (an extracted function)? Answer no if the helper's code is new, or the caller's old code was deleted or rewritten rather than moved.",
  inline:
    "Was the helper function's code folded back into the caller, so the caller now does the work itself instead of calling the helper (an inlined function)? Answer no if the caller's new code is a different implementation, or the helper's code was simply deleted.",
};

const CHOICE = {
  extract: {
    instructions: "What best describes the helper and the caller's old code?",
    criteria: {
      moved: "The helper's statements were written out in the caller before, and now live in the helper (renamed variables, new parameters or small edits allowed).",
      new: "The helper is new code: the caller's old code did not contain these statements.",
      rewritten: "The caller's old code did something similar, but the helper is a different implementation, not the same statements.",
      elsewhere: "The helper's statements came from some other place, not from this caller.",
    },
  },
  inline: {
    instructions: "What best describes the helper and the caller's new code?",
    criteria: {
      moved: "The helper's statements now appear written out in the caller, in place of the call (renamed variables or small edits allowed).",
      deleted: "The helper's code was dropped: the caller's new code does not contain these statements.",
      rewritten: "The caller now does something similar, but with a different implementation, not the same statements.",
      elsewhere: "The helper's statements went to some other place, not into this caller.",
    },
  },
};

/** The key was refused or the account has no credit: no other question would succeed either. */
export class OpinionKeyError extends Error {
  readonly provider: 'jev' | 'clef';
  readonly status: number;
  constructor(provider: 'jev' | 'clef', status: number, detail: string) {
    super(
      `${provider === 'jev' ? 'TypeSafe' : 'Cloudflare'} ${
        status === 402 ? 'account has no credit left' : 'refused the key'
      } (${status})${detail ? `: ${detail.slice(0, 200)}` : ''}`
    );
    this.name = 'OpinionKeyError';
    this.provider = provider;
    this.status = status;
  }
}

const FATAL = new Set([401, 402, 403]);

/**
 * Ask at most `limit` at a time. A question that fails for a passing reason (network, a 5xx)
 * counts as "no"; a refused key or an empty account stops the batch and throws, so the diff
 * reports it (`diagnostics`, pass "second-opinion") instead of quietly answering "no" to all.
 */
async function each<T, R>(items: T[], limit: number, f: (x: T) => Promise<R>, fallback: (x: T) => R): Promise<R[]> {
  const out = items.map(fallback);
  let next = 0;
  let fatal: unknown = null;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length && !fatal) {
        const i = next++;
        try {
          out[i] = await f(items[i]!);
        } catch (e) {
          if (e instanceof OpinionKeyError) fatal = e;
          else out[i] = fallback(items[i]!);
        }
      }
    })
  );
  if (fatal) throw fatal;
  return out;
}

async function post(doFetch: Fetch, provider: 'jev' | 'clef', url: string, token: string, body: unknown): Promise<any> {
  const r = await doFetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (FATAL.has(r.status)) throw new OpinionKeyError(provider, r.status, await r.text().catch(() => ''));
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  const out = await r.json();
  return out.result ?? out;
}

/**
 * The same candidate asked twice (the diff opened again, or a file shown in two views) is
 * answered from memory: one entry per candidate's code, the oldest dropped past `size`.
 */
function remembered<R>(size: number, ask: (c: Candidate) => Promise<R>): (c: Candidate) => Promise<R> {
  const memo = new Map<string, Promise<R>>();
  return (c) => {
    const key = [c.kind, c.file ?? '', c.helper, c.caller, c.code.helper, c.code.caller, c.code.callerNew].join('\0');
    const hit = memo.get(key);
    if (hit) return hit;
    const p = ask(c);
    memo.set(key, p);
    // A failed question is not remembered: the next diff may ask it again.
    p.catch(() => memo.delete(key));
    if (memo.size > size) memo.delete(memo.keys().next().value!);
    return p;
  };
}

export type OpinionBand = 'very-likely' | 'likely';

/** One model answer about one candidate, kept so a reader can be told what was asked and why. */
export interface OpinionAnswer {
  accept: boolean;
  score: number;
  band?: OpinionBand;
  model: string;
  question: string;
  options: string[];
  answer: string;
}

/** "Very likely" from 0.90, "Likely" from the accept threshold, nothing below it. */
export function bandFor(score: number, threshold: number): OpinionBand | undefined {
  if (score >= 0.9) return 'very-likely';
  return score >= threshold ? 'likely' : undefined;
}

const unanswered = (model: string, question: string, options: string[]) => (): OpinionAnswer => ({ accept: false, score: 0, model, question, options, answer: 'unanswered' });

export interface JevOptions {
  /** A TypeSafe API key. */
  apiKey: string;
  model?: string;
  /** Accept when P(moved) is at least this (multiple-choice question; 0.74 measured). */
  threshold?: number;
  concurrency?: number;
  /** Answers kept in memory, per candidate (default 2,000; 0 turns it off). */
  remember?: number;
  /**
   * A second model for the cases Jev is unsure of: when P(moved) is at least `from` (0.6) but under
   * `threshold`, accept if `ask` says at least `threshold` (0.8). Measured with Clef yes/no as the
   * tie-breaker: on practice +25 real, +1 wrong, +10 borderline over Jev alone, and only a few
   * percent of candidates are asked twice. `clefScore({ accountId, apiToken })` makes one.
   */
  tieBreaker?: { ask: (c: Candidate) => Promise<number>; from?: number; threshold?: number };
  fetch?: Fetch;
}

/** TypeSafe's Jev, asked a multiple-choice question (moved / new / rewritten / elsewhere), with its answer kept. */
export function jevAnswers(o: JevOptions): (candidates: Candidate[]) => Promise<OpinionAnswer[]> {
  const doFetch = o.fetch ?? fetch;
  const t = o.threshold ?? 0.74;
  const model = o.model ?? 'jev-1.14.0';
  const ask = async (c: Candidate): Promise<OpinionAnswer> => {
    const q = CHOICE[c.kind];
    const options = Object.keys(q.criteria);
    const out = await post(doFetch, 'jev', JEV_URL, o.apiKey, {
      model,
      state: candidateState(c),
      questions: { q: { type: 'choice', instructions: q.instructions, criteria: q.criteria } },
    });
    const probabilities: Record<string, number> = out.answers.q.probabilities ?? {};
    const answer = Object.entries(probabilities).sort((x, y) => y[1] - x[1])[0]?.[0] ?? 'unanswered';
    const p = probabilities.moved ?? 0;
    const base = { model, question: q.instructions, options, answer };
    if (p >= t) return { ...base, accept: true, score: p, band: bandFor(p, t) };
    const tb = o.tieBreaker;
    if (!tb || p < (tb.from ?? 0.6)) return { ...base, accept: false, score: p };
    try {
      const second = await tb.ask(c);
      const threshold = tb.threshold ?? 0.8;
      const accept = second >= threshold;
      return { ...base, model: `${model} + clef`, accept, score: accept ? second : p, band: accept ? bandFor(second, threshold) : undefined };
    } catch (e) {
      if (e instanceof OpinionKeyError) throw e;
      return { ...base, accept: false, score: p };
    }
  };
  const answer = o.remember === 0 ? ask : remembered(o.remember ?? 2000, ask);
  return (cs) => each(cs, o.concurrency ?? 8, answer, (c) => unanswered(model, CHOICE[c.kind].instructions, Object.keys(CHOICE[c.kind].criteria))());
}

/** TypeSafe's Jev as a yes/no second opinion (see `jevAnswers` for the answers themselves). */
export function jevOpinion(o: JevOptions): (candidates: Candidate[]) => Promise<boolean[]> {
  const answers = jevAnswers(o);
  return async (cs) => (await answers(cs)).map((a) => a.accept);
}

const JEV_URL = 'https://api.typesafe.ai/v1/systemone';

export interface ClefOptions {
  /** Cloudflare account ID and an API token with Workers AI permission. */
  accountId: string;
  apiToken: string;
  model?: 'clef' | 'clef-flash';
  /** Accept when the yes/no probability is at least this (0.9 measured for clef). */
  threshold?: number;
  concurrency?: number;
  /** Answers kept in memory, per candidate (default 2,000; 0 turns it off). */
  remember?: number;
  fetch?: Fetch;
}

/** Cloudflare's Clef on Workers AI: the yes/no probability for one candidate (for `tieBreaker`). */
export function clefScore(o: Omit<ClefOptions, 'threshold' | 'concurrency' | 'remember'>): (c: Candidate) => Promise<number> {
  const doFetch = o.fetch ?? fetch;
  return async (c) => {
    const out = await post(doFetch, 'clef', clefUrl(o.accountId), o.apiToken, {
      model: o.model ?? 'clef',
      state: candidateState(c),
      questions: { q: { type: 'noul', instructions: YES_NO[c.kind] } },
    });
    return out.answers.q.noul ?? 0;
  };
}

/** Cloudflare's Clef on Workers AI, asked a yes/no question, with its answer kept. */
export function clefAnswers(o: ClefOptions): (candidates: Candidate[]) => Promise<OpinionAnswer[]> {
  const t = o.threshold ?? 0.9;
  const model = o.model ?? 'clef';
  const score = clefScore(o);
  const ask = async (c: Candidate): Promise<OpinionAnswer> => {
    const p = await score(c);
    const accept = p >= t;
    return { accept, score: p, band: accept ? bandFor(p, t) : undefined, model, question: YES_NO[c.kind], options: ['yes', 'no'], answer: p >= 0.5 ? 'yes' : 'no' };
  };
  const answer = o.remember === 0 ? ask : remembered(o.remember ?? 2000, ask);
  return (cs) => each(cs, o.concurrency ?? 8, answer, (c) => unanswered(model, YES_NO[c.kind], ['yes', 'no'])());
}

/** Cloudflare's Clef on Workers AI, asked a yes/no question. */
export function clefOpinion(o: ClefOptions): (candidates: Candidate[]) => Promise<boolean[]> {
  const answers = clefAnswers(o);
  return async (cs) => (await answers(cs)).map((a) => a.accept);
}

const clefUrl = (accountId: string) => `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/cloudflare/clef`;

export type KeyCheck = { ok: true; ms: number } | { ok: false; reason: string };

/**
 * For a "power up with your key" setting: asks one tiny question (a fraction of a cent) and says
 * whether the key works, or why not, in words a settings screen can show.
 */
export async function checkKey(
  o: ({ provider: 'jev' } & Pick<JevOptions, 'apiKey' | 'model'>) | ({ provider: 'clef' } & Pick<ClefOptions, 'accountId' | 'apiToken' | 'model'>),
  doFetch: Fetch = fetch
): Promise<KeyCheck> {
  const start = Date.now();
  const question = { q: { type: 'noul', instructions: 'Does this text contain a number?' } };
  try {
    const out =
      o.provider === 'jev'
        ? await post(doFetch, 'jev', JEV_URL, o.apiKey, { model: o.model ?? 'jev-1.14.0', state: 'There are 3 apples.', questions: question })
        : await post(doFetch, 'clef', clefUrl(o.accountId), o.apiToken, { model: o.model ?? 'clef', state: 'There are 3 apples.', questions: question });
    if (typeof out?.answers?.q?.noul !== 'number') return { ok: false, reason: 'the service answered in an unexpected shape' };
    return { ok: true, ms: Date.now() - start };
  } catch (e) {
    return { ok: false, reason: e instanceof OpinionKeyError ? e.message : `could not reach the service (${(e as Error).message.slice(0, 120)})` };
  }
}
