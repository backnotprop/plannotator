/**
 * `Stopped:` and `Holds up:` values that say "nothing". An agent filling in a
 * template wrote `Stopped: no`, and the thread jumped to "Stopped on you"
 * (found by eval, 2026-10-12). A bare negative is no stop; a real reason,
 * even one that starts with "no " or "none of", still is.
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
  "",
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
  "  none  ",
  "nothing; still working",
  "none; I keep going meanwhile",
];

const REASONS = [
  "no API key yet",
  "No staging database to test against",
  "none of the fixtures load",
  "nothing builds without the schema",
  "not sure which layout",
  "no, the key is missing",
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

  test("the first Stopped: line decides, so a later one never turns a negative into a stop", () => {
    expect(only(["Stopped: no", "Stopped: waiting on the key"]).stopped).toBeNull();
    expect(only(["Stopped: waiting on the key", "Stopped: no"]).stopped).toBe("waiting on the key");
  });
});

describe("Holds up:", () => {
  test("a bare negative holds nothing up", () => {
    for (const value of ["", "none", "N/A", "nothing", "-", "none; still working"]) {
      expect(only([`Holds up: ${value}`]).holds_up).toEqual([]);
    }
  });

  test("negative entries are dropped from a list of names; real names are kept", () => {
    expect(only(["Holds up: billing export; none"]).holds_up).toEqual(["billing export"]);
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
