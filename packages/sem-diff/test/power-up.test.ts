import assert from 'node:assert/strict';
import { test } from 'node:test';
import { candidateId, semanticDiffFile } from '../src/index.ts';
import { OpinionKeyError, jevAnswers, type OpinionAnswer } from '../src/opinions.ts';
import type { Candidate } from '../src/runtime.ts';

const before = `export function checkout(cart: Cart, user: User) {
  let total = 0;
  for (const line of cart.lines) {
    if (line.qty <= 0) continue;
    const price = line.unitPrice;
    total += price * line.qty;
  }
  if (user.coupon) total = total * 0.9;
  log('checkout', user.id, total);
  return db.save({ user: user.id, total });
}
`;
const after = `export function checkout(cart: Cart, user: User) {
  let total = subtotal(cart.lines);
  if (user.coupon) total = total * 0.9;
  log('checkout', user.id, total);
  return db.save({ user: user.id, total });
}

function subtotal(lines: Line[]): number {
  let result = 0;
  for (const { qty, unitPrice } of lines) {
    if (qty <= 0) continue;
    result += unitPrice * qty;
  }
  return result;
}
`;

const yes = (score: number): OpinionAnswer => ({ accept: true, score, band: score >= 0.9 ? 'very-likely' : 'likely', model: 'stub', question: 'q?', options: ['moved', 'new'], answer: 'moved' });

test('the rules alone reject the reworded extract; a yes from the model adds it, attributed', async () => {
  const alone = await semanticDiffFile('typescript', before, after, 'checkout.ts');
  assert.ok(!alone.semanticOperations.some((op) => op.type === 'extractedFunction'));
  assert.equal(alone.secondOpinion, undefined);
  const asked: Candidate[] = [];
  const r = await semanticDiffFile('typescript', before, after, 'checkout.ts', {
    secondOpinion: async (cs) => (asked.push(...cs), cs.map(() => yes(0.95))),
  });
  const extract = r.semanticOperations.findIndex((op) => op.type === 'extractedFunction');
  assert.ok(extract >= 0);
  assert.equal(r.secondOpinion?.state, 'ok');
  assert.equal(r.secondOpinion?.asked, asked.length);
  assert.equal(r.secondOpinion?.accepted, 1);
  assert.equal(r.secondOpinion?.links.length, 1);
  const link = r.secondOpinion!.links[0]!;
  assert.equal(link.operationIndex, extract);
  assert.equal(link.kind, 'extract');
  assert.equal(link.helper, 'subtotal');
  assert.equal(link.band, 'very-likely');
  assert.equal(link.model, 'stub');
  assert.equal(link.candidateId, candidateId(asked.find((c) => c.helper === 'subtotal')!));
  assert.match(link.candidateId, /^[0-9a-f]{16}$/);
});

test('a candidate the reader turned down is never asked and never linked', async () => {
  let first = '';
  await semanticDiffFile('typescript', before, after, 'checkout.ts', { secondOpinion: async (cs) => ((first = candidateId(cs[0]!)), cs.map(() => yes(0.8))) });
  let calls = 0;
  const r = await semanticDiffFile('typescript', before, after, 'checkout.ts', {
    rejectedCandidates: [first],
    secondOpinion: async (cs) => ((calls += cs.length), cs.map(() => yes(0.8))),
  });
  assert.equal(calls, 0);
  assert.equal(r.secondOpinion?.links.length, 0);
  assert.ok(!r.semanticOperations.some((op) => op.type === 'extractedFunction'));
});

test('a refused key and an empty account read as states, and the diff still comes back', async () => {
  for (const [status, state] of [[401, 'refusedKey'], [403, 'refusedKey'], [402, 'noCredit']] as const) {
    const r = await semanticDiffFile('typescript', before, after, 'checkout.ts', {
      secondOpinion: async () => {
        throw new OpinionKeyError('jev', status, '');
      },
    });
    assert.equal(r.secondOpinion?.state, state);
    assert.ok(r.semanticOperations.length > 0);
  }
  const failed = await semanticDiffFile('typescript', before, after, 'checkout.ts', { secondOpinion: async () => { throw new Error('network'); } });
  assert.equal(failed.secondOpinion?.state, 'failed');
});

test('Jev answers keep the question, the options, the chosen answer and a band', async () => {
  const fakeFetch = (async () => new Response(JSON.stringify({ result: { answers: { q: { probabilities: { moved: 0.83, new: 0.1, rewritten: 0.05, elsewhere: 0.02 } } } } }), { status: 200 })) as unknown as typeof fetch;
  const ask = jevAnswers({ apiKey: 'test', fetch: fakeFetch, remember: 0 });
  const c: Candidate = { kind: 'extract', helper: 'subtotal', caller: 'checkout', code: { helper: 'h', caller: 'a', callerNew: 'b' } };
  const [a] = await ask([c]);
  assert.equal(a!.accept, true);
  assert.equal(a!.band, 'likely');
  assert.equal(a!.answer, 'moved');
  assert.deepEqual(a!.options, ['moved', 'new', 'rewritten', 'elsewhere']);
  assert.match(a!.question, /helper/);
});
