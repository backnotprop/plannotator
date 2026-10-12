/**
 * The list places a thread by its questions' `Stopped:` and `Holds up:`
 * lines. A line that says "nothing" (`Stopped: no`, written by an agent
 * filling in a template) must leave the thread in Waiting on you, not jump it
 * to Stopped on you. Proved on a real store in a temp dir.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxAuthor } from "@plannotator/core/inbox-types";
import { InboxStore } from "./store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const AGENT: Extract<InboxAuthor, { kind: "agent" }> = { kind: "agent", host: "claude-code", session: "ses_a", name: null };

function sectionFor(waitLine: string | null) {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-waits-"));
  roots.push(dir);
  const store = InboxStore.open(dir, { now: () => new Date("2026-10-12T10:00:00.000Z") });
  const project = store.ensureProject({ name: "billing", root: "/work/billing" });
  const body = [
    ":::question",
    "Which layout should the invoice list use?",
    "",
    ...(waitLine === null ? [] : [waitLine, ""]),
    "- [ ] Cards",
    "- [ ] A dense table",
    ":::",
  ].join("\n");
  const sent = store.sendMessage({ project_id: project.id, author: AGENT, body }).message;
  const row = store.listRows().find((r) => r.thread_id === sent.id)!;
  return { section: row.section, questions: store.questionsOf(sent.id) };
}

test("a `Stopped: no` question sits in Waiting on you, not Stopped on you", () => {
  const plain = sectionFor(null);
  const negative = sectionFor("Stopped: no");
  expect(plain.section).toBe("waiting");
  expect(negative.section).toBe("waiting");
  expect(negative.questions[0]!.stopped).toBeNull();
  // The guard never changes which question it is.
  expect(negative.questions[0]!.key).toBe(plain.questions[0]!.key);
});

test("other bare negatives and `Holds up: none` leave the thread in Waiting on you", () => {
  for (const line of ["Stopped: N/A", "Stopped:", "Stopped: nothing; still working", "Holds up: none"]) {
    expect(sectionFor(line).section).toBe("waiting");
  }
});

test("a real reason that starts with \"no\" still stops", () => {
  const stopped = sectionFor("Stopped: no API key yet");
  expect(stopped.section).toBe("stopped");
  expect(stopped.questions[0]!.stopped).toBe("no API key yet");
  expect(sectionFor("Holds up: the billing export").section).toBe("holding");
});
