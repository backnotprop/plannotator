/**
 * Search answers do not move: the fixed Inbox and searches of
 * search-parity-world.ts (words, prefixes, phrases, every filter, a tie
 * broken by the open project, a "Show all" page, the recent view, other
 * scripts) give exactly the rows, in exactly the order, recorded from main at
 * dcec5c7bc, before `author.host` was added (approval
 * "inbox-search-contrast": a visual change that must not change what search
 * returns or how it sorts). The host itself is checked in search.test.ts.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { searchParityAnswers } from "./search-parity-world";

test("the seeded searches answer the recorded rows, in the recorded order", async () => {
  const recorded = JSON.parse(readFileSync(join(import.meta.dir, "search-parity.recorded.json"), "utf8")) as Record<string, unknown>;
  const answers = await searchParityAnswers();
  expect(Object.keys(answers)).toEqual(Object.keys(recorded));
  for (const name of Object.keys(recorded)) expect({ name, answer: answers[name] }).toEqual({ name, answer: recorded[name] });
});
