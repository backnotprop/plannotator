/**
 * Tag row colours in the store (approval "inbox-thread-tags", step 3; tags.json `looks`, `show`, `recent`). What this
 * catches: a new tag left without a colour (its rows would not tint at once, as the owner asked); tags made before
 * colours coloured differently on each load, or not written; a colour lost with a delete's Undo; a person's pick
 * replaced by an automatic one; the marks dropped by a colour write; a bad colour stored; the own colours growing past
 * three or repeating, or holding a quick swatch; a held write landing late over a newer pick; a clock far ahead pinning its pick.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxAuthor } from "@plannotator/core/inbox-types";
import { InboxStore } from "./store";
import { INBOX_TAGS_FILE } from "./thread-tags";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const AGENT = { kind: "agent", host: "claude-code", session: "ses_a", name: "Claude Code" } as const;
const PERSON: InboxAuthor = { kind: "person" };

function world() {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-tag-colours-"));
  roots.push(dir);
  let clock = Date.parse("2026-11-13T12:00:00.000Z");
  const now = () => new Date((clock += 1000));
  const store = InboxStore.open(dir, { now });
  const project = store.ensureProject({ name: "app", root: "/work/app" });
  const thread = () => store.sendMessage({ project_id: project.id, author: AGENT, body: "Ready.", thread: `t-${Math.random()}` }).message;
  const reopen = () => InboxStore.open(dir, { now });
  const file = join(dir, "inbox", INBOX_TAGS_FILE);
  const onDisk = () => JSON.parse(readFileSync(file, "utf8")) as { v: number; marks: unknown[]; looks?: Record<string, { colour: string | null; by: string }>; show?: unknown; recent?: { colour: string }[] };
  return { dir, store, thread, reopen, file, onDisk };
}

const GREEN = "#14cc61";
const INDIGO = "#b1b7fd";
const AMBER = "#d6a20a";

test("a new tag gets the next unused of the twelve colours at once, vivid and calm in turn, kept across a restart", () => {
  const { store, reopen, onDisk } = world();
  const release = store.createInitiative({ name: "Release", by: PERSON });
  const docs = store.createInitiative({ name: "Docs move", by: PERSON });
  const windows = store.createInitiative({ name: "Windows", by: PERSON });
  expect([release, docs, windows].map((t) => store.tagLook(t.id)?.colour)).toEqual([GREEN, INDIGO, AMBER]);
  expect(store.tagLook(release.id)?.by).toBe("auto");
  expect(onDisk().looks?.[docs.id]?.colour).toBe(INDIGO);
  expect(reopen().tagLook(windows.id)?.colour).toBe(AMBER);
  // A colour given by itself is not one of the person's own.
  expect(store.tagColours().recent).toEqual([]);
  // A tag deleted frees its colour for the next one; its own is kept for the Undo.
  store.deleteInitiative(docs.id);
  const billing = store.createInitiative({ name: "Billing", by: PERSON });
  expect(store.tagLook(billing.id)?.colour).toBe(INDIGO);
  store.restoreInitiative(docs.id);
  expect(store.tagLook(docs.id)?.colour).toBe(INDIGO);
});

test("tags made before colours get theirs at the first load, oldest first, the same every time, written once", () => {
  const { store, reopen, file, onDisk } = world();
  const a = store.createInitiative({ name: "Release", by: PERSON });
  const b = store.createInitiative({ name: "Windows", by: PERSON });
  const c = store.createInitiative({ name: "Docs", by: PERSON });
  // What an Inbox before colours leaves: the marks only.
  writeFileSync(file, `${JSON.stringify({ v: 1, marks: [] })}\n`);
  const first = reopen();
  expect([a, b, c].map((t) => first.tagLook(t.id)?.colour)).toEqual([GREEN, INDIGO, AMBER]);
  const written = readFileSync(file, "utf8");
  expect(onDisk().looks?.[c.id]?.by).toBe("auto");
  const second = reopen();
  expect([a, b, c].map((t) => second.tagLook(t.id)?.colour)).toEqual([GREEN, INDIGO, AMBER]);
  expect(readFileSync(file, "utf8")).toBe(written);
});

test("the person's pick, own colour or None, wins and is kept; marks stay through it; a bad colour is refused", () => {
  const { store, thread, reopen, onDisk } = world();
  const release = store.createInitiative({ name: "Release", by: PERSON });
  const t = thread();
  store.setThreadTag(t.thread_id, release.id, true);
  expect(store.setTagColour(release.id, "#ff6a00", "2026-11-13T10:00:00.000Z")).toEqual({ colour: "#ff6a00", by: "person", at: "2026-11-13T10:00:00.000Z" });
  expect(onDisk().marks).toHaveLength(1);
  expect(reopen().threadTags(t.thread_id)).toEqual([release.id]);
  store.setTagColour(release.id, null, "2026-11-13T10:01:00.000Z");
  expect(reopen().tagLook(release.id)).toEqual({ colour: null, by: "person", at: "2026-11-13T10:01:00.000Z" });
  // A load never gives a tag the person set to None a colour again.
  expect(reopen().tagLook(release.id)?.colour).toBeNull();
  expect(() => store.setTagColour(release.id, "purple", null)).toThrow();
  expect(() => store.setTagColour(release.id, "#FFF", null)).toThrow();
  expect(() => store.setTagColour("ini_01NOPE", "green", null)).toThrow();
});

test("Highlight rows off keeps the colour: written off (null, what an older Inbox reads as None) with the colour kept, back on with it; an earlier None has none", () => {
  const { store, reopen, onDisk } = world();
  const release = store.createInitiative({ name: "Release", by: PERSON });
  store.setTagColour(release.id, "#ff6a00", "2026-11-13T10:00:00.000Z");
  store.setTagColour(release.id, null, "2026-11-13T10:01:00.000Z", "#ff6a00");
  // On disk and on the wire: `colour: null` (an older reader's None), the colour beside it.
  expect(onDisk().looks![release.id]).toEqual({ colour: null, by: "person", at: "2026-11-13T10:01:00.000Z", kept_colour: "#ff6a00" });
  expect(reopen().tagLook(release.id)).toEqual({ colour: null, by: "person", at: "2026-11-13T10:01:00.000Z", kept_colour: "#ff6a00" });
  store.setTagColour(release.id, "#ff6a00", "2026-11-13T10:02:00.000Z");
  expect(onDisk().looks![release.id]).toEqual({ colour: "#ff6a00", by: "person", at: "2026-11-13T10:02:00.000Z" });
  // An older Inbox's None sends no kept colour: off with none.
  store.setTagColour(release.id, null, "2026-11-13T10:03:00.000Z");
  expect(reopen().tagLook(release.id)).toEqual({ colour: null, by: "person", at: "2026-11-13T10:03:00.000Z" });
  expect(() => store.setTagColour(release.id, null, "2026-11-13T10:04:00.000Z", "purple")).toThrow();
});

test("own colours: the last three, newest first, each once, on any tag", () => {
  const { store, reopen } = world();
  const a = store.createInitiative({ name: "Release", by: PERSON });
  const b = store.createInitiative({ name: "Windows", by: PERSON });
  store.setTagColour(a.id, "#ff6a00", null);
  store.setTagColour(b.id, "#0b1e4a", null);
  store.setTagColour(a.id, "green", null);
  store.setTagColour(a.id, "#c2185b", null);
  store.setTagColour(b.id, "#ff6a00", null);
  store.setTagColour(b.id, "#112233", null);
  expect(reopen().tagColours().recent.map((r) => r.colour)).toEqual(["#112233", "#ff6a00", "#c2185b"]);
  // A quick swatch is a pick, not an own colour: the recent ones stay as they were.
  store.setTagColour(a.id, "#0b9488", null);
  expect(store.tagLook(a.id)?.colour).toBe("#0b9488");
  expect(store.tagColours().recent.map((r) => r.colour)).toEqual(["#112233", "#ff6a00", "#c2185b"]);
});

test("Show tag colors: on until set, then as set, kept across a restart", () => {
  const { store, reopen } = world();
  expect(store.tagColours()).toMatchObject({ show: true, show_at: null });
  store.setTagColoursShown(false, "2026-11-13T10:00:00.000Z");
  expect(reopen().tagColours()).toMatchObject({ show: false, show_at: "2026-11-13T10:00:00.000Z" });
  expect(() => store.setTagColoursShown("off", null)).toThrow();
});

test("a held write that lands late never undoes a newer pick: the later time stays, a colour and the switch alike", () => {
  const { store, reopen } = world();
  const release = store.createInitiative({ name: "Release", by: PERSON });
  // Picked here at t2; another machine's pick from t1, held while this one slept, arrives after.
  store.setTagColour(release.id, "amber", "2026-11-13T10:02:00.000Z");
  expect(store.setTagColour(release.id, "#0b7285", "2026-11-13T10:01:00.000Z")).toEqual({ colour: "amber", by: "person", at: "2026-11-13T10:02:00.000Z" });
  expect(reopen().tagLook(release.id)?.colour).toBe("amber");
  expect(reopen().tagColours().recent).toEqual([]);
  store.setTagColoursShown(false, "2026-11-13T10:02:00.000Z");
  store.setTagColoursShown(true, "2026-11-13T10:01:00.000Z");
  expect(reopen().tagColours().show).toBe(false);
  // Any time form reads as a time, stored as ISO: "~" (after every digit) does not win by sorting last.
  store.setTagColour(release.id, "red", "Fri, 13 Nov 2026 10:03:00 GMT");
  expect(reopen().tagLook(release.id)?.at).toBe("2026-11-13T10:03:00.000Z");
  expect(() => store.setTagColour(release.id, "green", "~")).toThrow();
  expect(() => store.setTagColoursShown(true, "~")).toThrow();
  expect(reopen().tagLook(release.id)?.colour).toBe("red");
});

test("a clock far ahead cannot pin a pick: its time is held to now plus a few minutes, and the next real pick wins", () => {
  const { store, reopen, file, onDisk } = world();
  const release = store.createInitiative({ name: "Release", by: PERSON });
  const far = store.setTagColour(release.id, "red", "2099-01-01T00:00:00.000Z");
  expect(Date.parse(far.at)).toBeLessThan(Date.parse("2026-11-13T12:10:00.000Z"));
  store.setTagColoursShown(false, "+275760-09-13T00:00:00.000Z");
  expect(Date.parse(store.tagColours().show_at!)).toBeLessThan(Date.parse("2026-11-13T12:10:00.000Z"));
  expect(store.setTagColour(release.id, null, null).colour).toBeNull();
  expect(store.setTagColoursShown(true, null).show).toBe(true);
  // A future time already on disk (written before the cap) counts as now: the next real pick still wins.
  const disk = JSON.parse(readFileSync(file, "utf8"));
  disk.looks[release.id] = { colour: "red", by: "person", at: "2099-01-01T00:00:00.000Z" };
  disk.show = { on: false, at: "2099-01-01T00:00:00.000Z" };
  writeFileSync(file, `${JSON.stringify(disk)}\n`);
  const later = reopen();
  expect(later.setTagColour(release.id, "green", null).colour).toBe("green");
  expect(later.setTagColoursShown(true, null).show).toBe(true);
  expect(onDisk().looks?.[release.id]?.colour).toBe("green");
});

test("a colour change tells the windows, as a mark does", () => {
  const { store } = world();
  const release = store.createInitiative({ name: "Release", by: PERSON });
  let told = 0;
  store.onThreadTagsChange(() => told++);
  store.setTagColour(release.id, "red", null);
  store.setTagColoursShown(false, null);
  expect(told).toBe(2);
});
