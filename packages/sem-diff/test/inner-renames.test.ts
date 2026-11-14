// A rename inside a function that was also edited is still a rename, when the thing named is plainly the same.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { semanticDiffFile } from '../src/index.ts';

const kinds = async (a: string, b: string, lang: 'typescript' | 'java' = 'typescript') =>
  (await semanticDiffFile(lang, a, b, lang === 'java' ? 'X.java' : 'x.ts')).semanticOperations.map((o) => o.type).sort();

const checkout = `export function checkout(cart: Cart, user: User) {
  let total = sum(cart);
  if (user.coupon) {
    total = total * 0.9;
  }
  const tax = total * 0.08;
  log('checkout', user.id, tax);
  return db.save({ user: user.id, total: total + tax });
}
`;

test('a local renamed next to an unrelated edit: one rename, one edit', async () => {
  const after = checkout.replaceAll('tax', 'salesTax').replace('0.9', '0.85');
  assert.deepEqual(await kinds(checkout, after), ['edited', 'renamed']);
});

test('a name whose declaration now holds something else is a replacement, not a rename', async () => {
  const after = checkout.replaceAll('tax', 'salesTax').replace('total * 0.08', 'rates.lookup(user) * total').replace('0.9', '0.85');
  assert.ok(!(await kinds(checkout, after)).includes('renamed'));
});

test('another service under a new name is not a rename', async () => {
  const before = `export function run(ctx: Ctx, node: Node) {
  const typeChecker = ctx.get(TypeCheckerApi);
  const a = typeChecker.getTypeAtLocation(node);
  const b = typeChecker.getTypeAtLocation(node.parent);
  return compare(a, b, 1);
}
`;
  const after = before.replaceAll('typeChecker', 'typeCheckerUtils').replace('ctx.get(TypeCheckerApi)', 'ctx.get(TypeCheckerUtils)').replace('compare(a, b, 1)', 'compare(a, b, 2)');
  assert.ok(!(await kinds(before, after)).includes('renamed'));
});

test('a variable renamed together with a same-named method of another object is not a rename (Java)', async () => {
  const before = `class C {
  void apply(Config newConfig) {
    List<String> logDirs = newConfig.logDirs();
    validate(logDirs);
    store(logDirs, 1);
  }
}
`;
  const after = before.replaceAll('logDirs', 'absoluteLogDirs').replace('store(absoluteLogDirs, 1)', 'store(absoluteLogDirs, 2)');
  assert.ok(!(await kinds(before, after, 'java')).includes('renamed'));
});

test('a function renamed while its body changed is not found this way', async () => {
  const before = `function installHooks(a: number) {
  const x = a + 1;
  return x * 2;
}
export function main() {
  installHooks(1);
  installHooks(2);
  return 1;
}
`;
  const after = before.replaceAll('installHooks', 'installLoadHooks').replace('x * 2', 'x * 3').replace('return 1;', 'return 2;');
  assert.ok(!(await kinds(before, after)).includes('renamed'));
});
