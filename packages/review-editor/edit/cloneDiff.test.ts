import { describe, expect, test } from 'bun:test';
import { getSingularPatch } from '@pierre/diffs';
import { cloneFileDiff } from './cloneDiff';

const PATCH = `diff --git a/calc.ts b/calc.ts
index 111..222 100644
--- a/calc.ts
+++ b/calc.ts
@@ -1,3 +1,4 @@
 export function add(a: number, b: number): number {
-  return a + b;
+  const sum = a + b;
+  return sum;
 }
`;

describe('cloneFileDiff', () => {
  test('clone is byte-identical to the source and fully detached', () => {
    const original = getSingularPatch(PATCH);
    const reference = JSON.stringify(original);
    const clone = cloneFileDiff(original);

    // Byte-identical snapshot.
    expect(JSON.stringify(clone)).toBe(reference);

    // Simulate what Pierre's edit session does to the live object: replace
    // additionLines, clobber hunks, stamp the session flag.
    const live = original as unknown as Record<string, unknown>;
    (live.additionLines as string[]).push('// injected by editor\n');
    live.hunks = [];
    live.editSessionDirty = true;
    live.cacheKey = 'mutated';

    // The pristine clone must be unaffected (the restore invariant).
    expect(JSON.stringify(clone)).toBe(reference);
    expect((clone as unknown as Record<string, unknown>).editSessionDirty).toBeUndefined();
  });

  test('nested arrays are deep-cloned, not shared', () => {
    const original = getSingularPatch(PATCH);
    const clone = cloneFileDiff(original);
    expect(clone.additionLines).not.toBe(original.additionLines);
    expect(clone.hunks).not.toBe(original.hunks);
    expect(clone.additionLines).toEqual(original.additionLines);
  });
});
