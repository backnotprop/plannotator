// The second opinion (a decision model's answer, looked up) can turn the rules' "no" into "yes",
// but never for a copy: the helper's code must have left the caller.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configure, semanticDiffFile, type Candidate } from '../src/index.ts';

const before = `function checkout(cart, user) {
  const sum = cart.items.reduce((s, i) => s + i.price * i.qty, 0);
  const net = user.member ? sum * 0.9 : sum;
  cart.total = Math.round(net * 100) / 100;
  return submit(cart);
}
`;
// Reworded on the way out: the rules see too little of the helper in the lost code.
const reworded = `function checkout(cart, user) {
  cart.total = totalFor(cart, user);
  return submit(cart);
}

function totalFor(cart, user) {
  let total = 0;
  for (const item of cart.items) total += item.price * item.qty;
  if (user.member) total *= 0.9;
  return Math.round(total * 100) / 100;
}
`;
// A copy: the same statements are still written out in the caller, which also calls the helper.
const copied = `function checkout(cart, user) {
  const sum = cart.items.reduce((s, i) => s + i.price * i.qty, 0);
  const net = user.member ? sum * 0.9 : sum;
  cart.total = Math.round(net * 100) / 100;
  audit(totalFor(cart, user));
  return submit(cart);
}

function totalFor(cart, user) {
  const sum = cart.items.reduce((s, i) => s + i.price * i.qty, 0);
  const net = user.member ? sum * 0.9 : sum;
  return Math.round(net * 100) / 100;
}
`;

const extracted = async (after: string) =>
  (await semanticDiffFile('typescript', before, after, 'x.ts')).semanticOperations.some((o) => o.type === 'extractedFunction');

test('a yes from the second opinion turns a rejected candidate into an extract', async (t) => {
  t.after(() => configure({}));
  assert.equal(await extracted(reworded), false, 'the rules alone reject it');
  const asked: Candidate[] = [];
  configure({ secondOpinion: (c) => (asked.push(c), true) });
  assert.equal(await extracted(reworded), true);
  assert.ok(asked.some((c) => c.kind === 'extract' && c.helper === 'totalFor'));
});

test('a copy is never sent to the second opinion', async (t) => {
  t.after(() => configure({}));
  const asked: Candidate[] = [];
  configure({ secondOpinion: (c) => (asked.push(c), true) });
  assert.equal(await extracted(copied), false);
  assert.ok(!asked.some((c) => c.helper === 'totalFor'));
});

test('per diff: candidates are asked in one batch, with the file name', async () => {
  const seen: Candidate[][] = [];
  const r = await semanticDiffFile('typescript', before, reworded, 'src/cart.ts', {
    secondOpinion: async (cs) => (seen.push(cs), cs.map(() => true)),
  });
  assert.equal(seen.length, 1);
  assert.ok(seen[0]!.every((c) => c.file === 'src/cart.ts'));
  assert.ok(r.semanticOperations.some((o) => o.type === 'extractedFunction'));
  assert.ok(r.diagnostics.some((d) => d.pass === 'second-opinion' && d.status === 'ok'));
});

test('per diff: a failing second opinion leaves the plain result and says so', async () => {
  const r = await semanticDiffFile('typescript', before, reworded, 'x.ts', {
    secondOpinion: async () => {
      throw new Error('no network');
    },
  });
  assert.ok(!r.semanticOperations.some((o) => o.type === 'extractedFunction'));
  assert.ok(r.diagnostics.some((d) => d.pass === 'second-opinion' && d.status === 'failed'));
});

test('jevOpinion sends the tested question and applies the cut-off', async () => {
  const { jevOpinion } = await import('../src/opinions.ts');
  const bodies: any[] = [];
  const fake = (async (_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ answers: { q: { type: 'choice', choice: 'moved', probabilities: { moved: bodies.length === 1 ? 0.8 : 0.5 } } } }));
  }) as unknown as typeof fetch;
  const ask = jevOpinion({ apiKey: 'k', fetch: fake, concurrency: 1, remember: 0 });
  const c: Candidate = { kind: 'extract', file: 'a.ts', helper: 'h', caller: 'f', code: { helper: 'function h() {}', caller: 'function f() { h(); }', callerNew: 'function f() { x(); }' } };
  assert.deepEqual(await ask([c, c]), [true, false]);
  assert.equal(bodies[0].questions.q.type, 'choice');
  assert.match(bodies[0].state, /=== CALLER BEFORE ===\nfunction f\(\) \{ x\(\); \}/);
});

const sample: Candidate = { kind: 'extract', file: 'a.ts', helper: 'h', caller: 'f', code: { helper: 'function h() {}', caller: 'function f() { h(); }', callerNew: 'function f() { x(); }' } };
const answering = (p: number, calls: { n: number }) =>
  (async () => {
    calls.n++;
    return new Response(JSON.stringify({ answers: { q: { type: 'choice', probabilities: { moved: p } } } }));
  }) as unknown as typeof fetch;

test('the same candidate is asked once, then answered from memory', async () => {
  const { jevOpinion } = await import('../src/opinions.ts');
  const calls = { n: 0 };
  const ask = jevOpinion({ apiKey: 'k', fetch: answering(0.9, calls) });
  assert.deepEqual(await ask([sample]), [true]);
  assert.deepEqual(await ask([sample, sample]), [true, true]);
  assert.equal(calls.n, 1);
});

test('a refused key stops the batch with a clear error; a passing failure is a no', async () => {
  const { jevOpinion, OpinionKeyError } = await import('../src/opinions.ts');
  let n = 0;
  const refused = (async () => {
    n++;
    return new Response('bad key', { status: 401 });
  }) as unknown as typeof fetch;
  const many = Array.from({ length: 20 }, (_, i) => ({ ...sample, helper: `h${i}` }));
  await assert.rejects(jevOpinion({ apiKey: 'k', fetch: refused, concurrency: 2 })(many), (e: unknown) => e instanceof OpinionKeyError && /refused the key \(401\)/.test(e.message));
  assert.ok(n <= 2, `stopped early (${n} asked)`);
  const flaky = (async () => new Response('busy', { status: 503 })) as unknown as typeof fetch;
  assert.deepEqual(await jevOpinion({ apiKey: 'k', fetch: flaky })([sample]), [false]);
});

test('checkKey says whether a key works, in plain words', async () => {
  const { checkKey } = await import('../src/opinions.ts');
  const ok = (async () => new Response(JSON.stringify({ result: { answers: { q: { type: 'noul', noul: 0.97 } } } }))) as unknown as typeof fetch;
  assert.equal((await checkKey({ provider: 'clef', accountId: 'a', apiToken: 't' }, ok)).ok, true);
  const broke = (async () => new Response('{"error":"insufficient credit"}', { status: 402 })) as unknown as typeof fetch;
  const r = await checkKey({ provider: 'jev', apiKey: 'k' }, broke);
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /TypeSafe account has no credit left/);
});

test('a refused key shows up in the diff diagnostics, and the diff still comes back', async () => {
  const { jevOpinion } = await import('../src/opinions.ts');
  const refused = (async () => new Response('nope', { status: 403 })) as unknown as typeof fetch;
  const a = 'function f(xs) {\n  const total = xs.reduce((s, x) => s + x.price * x.qty, 0);\n  const tax = total * 0.2;\n  return total + tax;\n}\n';
  const b = 'function f(xs) {\n  return withTax(xs);\n}\n\nfunction withTax(items) {\n  let sum = 0;\n  for (const it of items) sum += it.price * it.qty;\n  return sum * 1.2;\n}\n';
  const r = await semanticDiffFile('typescript', a, b, 'x.ts', { secondOpinion: jevOpinion({ apiKey: 'k', fetch: refused }) });
  const d = r.diagnostics.find((x) => x.pass === 'second-opinion');
  assert.ok(r.semanticOperations.length > 0);
  assert.ok(d, 'the second opinion was asked');
  assert.match(`${d.status} ${d.reason ?? ''}`, /fail.*refused the key/);
});

test('a tie-breaker is asked only when Jev is unsure', async () => {
  const { jevOpinion } = await import('../src/opinions.ts');
  const asked: string[] = [];
  const tieBreaker = { ask: async (c: Candidate) => (asked.push(c.helper), c.helper === 'b' ? 0.85 : 0.5) };
  const probs: Record<string, number> = { a: 0.9, b: 0.65, c: 0.65, d: 0.3 };
  const fake = (async (_u: string, init: { body: string }) => {
    const h = /HELPER `(\w)`/.exec(JSON.parse(init.body).state)![1]!;
    return new Response(JSON.stringify({ answers: { q: { probabilities: { moved: probs[h] } } } }));
  }) as unknown as typeof fetch;
  const ask = jevOpinion({ apiKey: 'k', fetch: fake, tieBreaker });
  const got = await ask(['a', 'b', 'c', 'd'].map((helper) => ({ ...sample, helper })));
  assert.deepEqual(got, [true, true, false, false]);
  assert.deepEqual(asked.sort(), ['b', 'c']);
});
