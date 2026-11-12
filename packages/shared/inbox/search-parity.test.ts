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
