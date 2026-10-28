/**
 * Decision mode moved the list's "waits on the person" rule into core
 * (`inboxQuestionWaitsForList`, approval "inbox-decision-mode"). The list must
 * count exactly what it counted before: `summarizeInboxQuestions` is checked
 * against a copy of the function as it was before decision mode, over random
 * questions of every state, every known kind, kinds a newer Inbox may write,
 * and orphaned records. And the answering rule (`inboxQuestionWaitsOnPerson`)
 * is the list's rule minus the kinds this build does not know.
 */
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { inboxQuestionWaitsForList, inboxQuestionWaitsOnPerson, summarizeInboxQuestions } from "@plannotator/core/inbox-questions";
import type { InboxQuestion, InboxQuestionSummary } from "@plannotator/core/inbox-types";

/** `summarizeInboxQuestions` as it was on main before decision mode (0a0ac58a3), byte for byte. */
function summarizeBefore(questions: readonly InboxQuestion[]): InboxQuestionSummary {
  let open = 0;
  let picked = 0;
  let actions = 0;
  let stopped = false;
  const holdsUp: string[] = [];
  let prompt: string | null = null;
  for (const q of questions) {
    if (q.orphaned) continue;
    if (q.state === "picked" && q.kind !== "action") picked += 1;
    if (q.state !== "open") continue;
    open += 1;
    if (q.kind === "action") actions += 1;
    if (q.stopped !== null) stopped = true;
    for (const name of q.holds_up) if (!holdsUp.includes(name)) holdsUp.push(name);
    if (prompt === null) prompt = q.prompt;
  }
  return { open, picked, stopped, holds_up: holdsUp, prompt, actions };
}

const KNOWN = ["single", "multi", "text", "action"] as const;
const UNKNOWN = ["picture", "rank", "x-future"] as const;

const questionArb = (kinds: readonly string[]) =>
  fc.record({
    kind: fc.constantFrom(...kinds),
    state: fc.constantFrom("open", "picked", "sent", "closed", "superseded"),
    orphaned: fc.boolean(),
    stopped: fc.option(fc.constantFrom("", "cannot ship"), { nil: null }),
    holds_up: fc.subarray(["deploy", "tests", "the release"]),
    prompt: fc.constantFrom("Which one?", "Ship it?", "Name it"),
  }) as fc.Arbitrary<InboxQuestion>;

describe("the list counts what it counted before decision mode", () => {
  test("known kinds", () => {
    fc.assert(
      fc.property(fc.array(questionArb(KNOWN), { maxLength: 12 }), (questions) => {
        expect(summarizeInboxQuestions(questions)).toEqual(summarizeBefore(questions));
      }),
      { numRuns: 500 },
    );
  });

  test("kinds a newer Inbox writes still count as waiting for the list", () => {
    fc.assert(
      fc.property(fc.array(questionArb([...KNOWN, ...UNKNOWN]), { maxLength: 12 }), (questions) => {
        expect(summarizeInboxQuestions(questions)).toEqual(summarizeBefore(questions));
      }),
      { numRuns: 500 },
    );
    const future = { kind: "picture", state: "open", orphaned: false, stopped: null, holds_up: [], prompt: "Which picture?" } as unknown as InboxQuestion;
    expect(summarizeInboxQuestions([future]).open).toBe(1);
    expect(inboxQuestionWaitsForList(future)).toBe(true);
  });
});

describe("decision mode answers only what it can read", () => {
  test("waits on the person = the list's rule, minus kinds this build does not know", () => {
    fc.assert(
      fc.property(questionArb([...KNOWN, ...UNKNOWN]), (q) => {
        const known = (KNOWN as readonly string[]).includes(q.kind);
        expect(inboxQuestionWaitsOnPerson(q)).toBe(known && inboxQuestionWaitsForList(q));
      }),
      { numRuns: 500 },
    );
  });
});
