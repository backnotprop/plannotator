/**
 * `Stopped:` values and `Holds up:` entries that are only a negative word. An
 * agent filling in a template wrote `Stopped: no`, and the thread jumped to
 * "Stopped on you" (found by eval, 2026-10-12). A bare negative word is no
 * stop; everything else errs toward a stop: a real reason (even one that
 * starts with "no " or "none of"), a negative word followed by a remark, and
 * an empty `Stopped:` (a claim with no why, as Workspaces reads it).
 */
import { describe, expect, test } from "bun:test";
import { isNegativeWaitValue, parseInboxQuestionBlocks } from "./inbox-questions";

function block(lines: string[]): string {
  return [":::question", "Which layout should the invoice list use?", "", ...lines, "", "- [ ] Cards", "- [ ] A table", ":::"].join("\n");
}

function only(lines: string[]) {
  const parsed = parseInboxQuestionBlocks(block(lines));
  expect(parsed).toHaveLength(1);
  return parsed[0]!;
}

const NEGATIVES = [
  "no",
  "No",
  "NO.",
  "none",
  "None.",
  "N/A",
  "n/a",
  "na",
  "nothing",
  "Nothing!",
  "false",
  "nil",
  "null",
  "-",
  "—",
  "–",
  "no -",
  "no;",
  "  none  ",
];

const REASONS = [
  "no API key yet",
  "No staging database to test against",
  "none of the fixtures load",
  "nothing builds without the schema",
  "not sure which layout",
  "no, the key is missing",
  "No; I need the DB password first",
  "None; blocked on the region choice",
  "nothing; still working",
  "nobody has access",
  "nan values break the chart",
  "the list cannot be built without this",
];

describe("Stopped:", () => {
  for (const value of NEGATIVES) {
    test(`"Stopped: ${value}" is no stop`, () => {
      expect(isNegativeWaitValue(value)).toBe(true);
      expect(only([`Stopped: ${value}`]).stopped).toBeNull();
    });
  }

  for (const value of REASONS) {
    test(`"Stopped: ${value}" is a stop`, () => {
      expect(isNegativeWaitValue(value)).toBe(false);
      expect(only([`Stopped: ${value}`]).stopped).toBe(value);
    });
  }

  test("an empty Stopped: is still a stop, a claim with no why", () => {
    expect(isNegativeWaitValue("")).toBe(false);
    expect(only(["Stopped:"]).stopped).toBe("");
  });

  test("the first Stopped: line decides, so a later one never turns a negative into a stop", () => {
    expect(only(["Stopped: no", "Stopped: waiting on the key"]).stopped).toBeNull();
    expect(only(["Stopped: waiting on the key", "Stopped: no"]).stopped).toBe("waiting on the key");
  });
});

describe("Holds up:", () => {
  test("a bare negative holds nothing up", () => {
    for (const value of ["", "none", "N/A", "nothing", "-", "none; no"]) {
      expect(only([`Holds up: ${value}`]).holds_up).toEqual([]);
    }
  });

  test("bare-negative entries are dropped wherever they sit; real names are kept in order", () => {
    expect(only(["Holds up: none; the migration"]).holds_up).toEqual(["the migration"]);
    expect(only(["Holds up: the migration; none"]).holds_up).toEqual(["the migration"]);
    expect(only(["Holds up: no; deploy; tests"]).holds_up).toEqual(["deploy", "tests"]);
    expect(only(["Holds up: deploy; N/A; tests"]).holds_up).toEqual(["deploy", "tests"]);
    expect(only(["Holds up: none of the reports; the export"]).holds_up).toEqual(["none of the reports", "the export"]);
  });
});

describe("what the guard does not change", () => {
  test("the key, the prompt and the context are the same whatever the Stopped: line says", () => {
    const without = only([]);
    const negative = only(["Stopped: no"]);
    const reason = only(["Stopped: no API key yet"]);
    expect(negative.key).toBe(without.key);
    expect(reason.key).toBe(without.key);
    expect(negative.prompt).toBe(without.prompt);
    expect(negative.parsed.context).toBe("Stopped: no");
    expect(reason.parsed.context).toBe("Stopped: no API key yet");
  });
});
