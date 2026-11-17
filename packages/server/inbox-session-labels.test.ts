/**
 * The session labels file (inbox-session-labels.ts, issue #3462).
 *
 * What this catches: a label lost on a restart; a poll with no label erasing the last known one; a write on every
 * unchanged poll; the file growing past its cap; an unreadable file taking the Inbox down or being overwritten
 * without a trace; a file from a newer Plannotator written over; a session id like "__proto__" polluting the map.
 */
import { beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInboxSessionLabels, INBOX_SESSION_LABELS_FILE, INBOX_SESSION_LABELS_KEPT } from "./inbox-session-labels";

let dir = "";
let clock = 0;
const store = () => createInboxSessionLabels(dir, () => ++clock);
const onDisk = () => JSON.parse(readFileSync(join(dir, INBOX_SESSION_LABELS_FILE), "utf8"));

beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), "pn-session-labels-")), "inbox");
  clock = 0;
});

test("a label and a title survive a restart", () => {
  store().note("ses_a", "Fix login redirect", "Login fix");
  const again = store();
  expect(again.labels()).toEqual({ ses_a: "Fix login redirect" });
  expect(again.titles()).toEqual({ ses_a: "Login fix" });
});

test("a poll with no label keeps the last known one, and a new label replaces it", () => {
  const labels = store();
  labels.note("ses_a", "First name", null);
  labels.note("ses_a", null, null);
  expect(labels.labels()).toEqual({ ses_a: "First name" });
  labels.note("ses_a", "Second name", null);
  expect(store().labels()).toEqual({ ses_a: "Second name" });
});

test("an unchanged poll writes nothing", () => {
  const labels = store();
  labels.note("ses_a", "Same", null);
  const first = onDisk().sessions.ses_a.at;
  labels.note("ses_a", "Same", null);
  labels.note("ses_a", "Same", null);
  expect(onDisk().sessions.ses_a.at).toBe(first);
});

test("the file keeps the newest sessions only", () => {
  const labels = store();
  for (let i = 0; i < INBOX_SESSION_LABELS_KEPT + 5; i++) labels.note(`ses_${i}`, `Name ${i}`, null);
  const kept = Object.keys(store().labels());
  expect(kept.length).toBe(INBOX_SESSION_LABELS_KEPT);
  expect(kept).not.toContain("ses_4");
  expect(kept).toContain("ses_5");
});

test("an unreadable file reads as none and is moved aside on the next write", () => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, INBOX_SESSION_LABELS_FILE), "{ not json");
  const labels = store();
  expect(labels.labels()).toEqual({});
  labels.note("ses_a", "Kept", null);
  expect(readdirSync(dir).some((name) => name.includes(".unreadable-"))).toBe(true);
  expect(store().labels()).toEqual({ ses_a: "Kept" });
});

test("a file from a newer Plannotator is never written over", () => {
  mkdirSync(dir, { recursive: true });
  const newer = JSON.stringify({ v: 2, sessions: { ses_a: { label: "From the future", at: 1 } } });
  writeFileSync(join(dir, INBOX_SESSION_LABELS_FILE), newer);
  const labels = store();
  labels.note("ses_b", "Mine", null);
  expect(readFileSync(join(dir, INBOX_SESSION_LABELS_FILE), "utf8")).toBe(newer);
});

test("a session id like __proto__ is a plain key", () => {
  const labels = store();
  labels.note("__proto__", "Odd", null);
  expect(Object.getPrototypeOf(labels.labels())).toBe(null);
  expect(store().labels().__proto__).toBe("Odd");
  expect(({} as Record<string, unknown>).label).toBeUndefined();
});

test("an entry that does not parse is dropped, the rest kept", () => {
  mkdirSync(dir, { recursive: true });
  const bad = { v: 1, sessions: { ses_ok: { label: "Fine", at: 1 }, ses_empty: { at: 2 }, ses_num: { label: 5, at: 3 } } };
  writeFileSync(join(dir, INBOX_SESSION_LABELS_FILE), JSON.stringify(bad));
  expect(store().labels()).toEqual({ ses_ok: "Fine" });
});