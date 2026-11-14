// A top-level constant made by handing a function to a factory (`dual(2, (self, n) => ...)`,
// `makeView((model) => ...)`) is a function, so code pulled out of it is an extract; a top-level
// `items.map((x) => ...)` holds a value and is not.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LANGUAGES, getParser } from '../src/parse.ts';
import { functionsIn } from '../src/syntax.ts';
import { semanticDiffFile } from '../src/index.ts';

const names = async (src: string) => {
  const p = await getParser('typescript');
  return functionsIn(p.parse(src)!.rootNode, LANGUAGES.typescript).map((f) => f.name);
};

test('factory-built top-level constants are functions; collection results are not', async () => {
  const src = [
    'export const withRetry: { (n: number): (s: S) => S; (s: S, n: number): S } = dual(2, (self: S, n: number) => { return self.retry(n); });',
    'export const view = makeView((model, h) => h.div([model.title]));',
    'export const subs = Subscription.make<Model>()((entry) => ({ a: entry(1) }));',
    'export const rows = items.map((x) => x.id);',
    'function outer() { const inner = makeView((m) => m); return inner; }',
  ].join('\n');
  const got = await names(src);
  assert.ok(got.includes('withRetry') && got.includes('view') && got.includes('subs'), got.join(','));
  assert.ok(!got.includes('rows') && !got.includes('inner'), got.join(','));
});

test('code pulled out of a dual(...) function is an extract', async () => {
  const a = 'export const total = dual(2, (self: Cart, rate: number) => {\n  let sum = 0;\n  for (const it of self.items) sum += it.price * it.qty;\n  const tax = sum * rate;\n  return sum + tax;\n});\n';
  const b = 'const subtotal = (self: Cart) => {\n  let sum = 0;\n  for (const it of self.items) sum += it.price * it.qty;\n  return sum;\n};\n\nexport const total = dual(2, (self: Cart, rate: number) => {\n  const sum = subtotal(self);\n  const tax = sum * rate;\n  return sum + tax;\n});\n';
  const r = await semanticDiffFile('typescript', a, b, 'cart.ts');
  assert.ok(r.semanticOperations.some((o) => o.type === 'extractedFunction'), r.semanticOperations.map((o) => o.type).join(','));
});
