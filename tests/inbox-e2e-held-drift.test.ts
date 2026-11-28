import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const e2e = join(import.meta.dir, 'e2e');

test("every Inbox browser spec runs the held-copy drift check (its test comes from tests/e2e/inbox-test.ts)", () => {
  const specs = readdirSync(e2e).filter((name) => /^inbox.*\.spec\.ts$/.test(name));
  expect(specs.length).toBeGreaterThan(0);
  const skipping = specs.filter((name) => {
    const text = readFileSync(join(e2e, name), 'utf8');
    return /^import \{[^}]*\btest\b[^}]*\} from '@playwright\/test';/m.test(text) || !text.includes("from './inbox-test'");
  });
  expect(skipping).toEqual([]);
});
