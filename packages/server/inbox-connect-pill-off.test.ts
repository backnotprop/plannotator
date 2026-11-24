/**
 * The Connect agent pill's one switch-off (inbox-connect-pill-off.ts), against a scratch data dir
 * (PLANNOTATOR_DATA_DIR), with the Customize panel's own save. What regresses if these fail: the pill leaves before
 * any agent connected, or on the day one did; it never leaves; it is hidden some other way than its sidebar switch (the
 * rest of the layout moves, or no layout is saved for the other windows); a person who turned it back on loses it
 * again (after a restart too); a preset picked later is undone; or the switch-off's own save hides the Sidebar tip.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_SIDEBAR_DEFAULT, INBOX_SIDEBAR_PRESETS, inboxSidebarSetShown, type InboxSidebarLayout } from "@plannotator/core/inbox-sidebar";
import { loadConfig } from "@plannotator/shared/config";
import { savedConfig } from "../../tests/helpers/saved-config";
import { CONNECT_PILL_OFF_AFTER_MS, connectPillOffDue, createConnectPillOff, firstAgentMessageAt, sidebarCustomizedByPerson } from "./inbox-connect-pill-off";
import { inboxSidebarState, saveInboxSidebar } from "./inbox-sidebar-save";

let dataDir = "";
let savedEnv: string | undefined;
beforeEach(() => {
  savedEnv = process.env.PLANNOTATOR_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), "inbox-connect-pill-off-"));
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = savedEnv;
  rmSync(dataDir, { recursive: true, force: true });
});

const NOW = Date.parse("2026-11-23T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
/** The Customize panel's save, as inbox.ts passes it (no capability off). */
const panelSave = (layout: InboxSidebarLayout) => saveInboxSidebar(layout, { off: [] });

/** An Inbox whose first agent wrote at `first` (null: none yet), checked at `now`. */
function inbox(first: string | null, now = NOW) {
  let clock = now;
  const saves: InboxSidebarLayout[] = [];
  const off = createConnectPillOff({
    firstAgentAt: () => first,
    saveSidebar: (layout) => {
      saves.push(layout);
      return panelSave(layout);
    },
    now: () => clock,
  });
  return { off, saves, at: (t: number) => void (clock = t) };
}

const shown = () => !(inboxSidebarState().sidebar ?? INBOX_SIDEBAR_DEFAULT).hidden.includes("copy-prompt");

test("not before an agent connected: nothing is saved or stamped, however long the Inbox runs", () => {
  const w = inbox(null);
  expect(w.off.check()).toBe(false);
  w.at(NOW + 30 * CONNECT_PILL_OFF_AFTER_MS);
  expect(w.off.check()).toBe(false);
  expect(w.saves).toEqual([]);
  expect(savedConfig(dataDir).inboxSidebarConnectOff).toBeUndefined();
  expect(inboxSidebarState()).toEqual({ sidebar: null, rev: 0 });
});

test("not within the day the first agent connected", () => {
  const w = inbox(ago(CONNECT_PILL_OFF_AFTER_MS - 60_000));
  expect(w.off.check()).toBe(false);
  expect(shown()).toBe(true);
  expect(savedConfig(dataDir).inboxSidebarConnectOff).toBeUndefined();
});

test("a day after the first agent: its sidebar switch goes off, nothing else in the layout moves, once", () => {
  // The person's own layout: Feedback hidden, Usage moved up.
  const theirs: InboxSidebarLayout = { top: [...INBOX_SIDEBAR_DEFAULT.top, "usage"], bottom: INBOX_SIDEBAR_DEFAULT.bottom.filter((id) => id !== "usage"), hidden: ["feedback"] };
  panelSave(theirs);
  const w = inbox(ago(CONNECT_PILL_OFF_AFTER_MS));
  expect(w.off.check()).toBe(true);
  // Exactly the switch: the same layout with the item hidden, saved as a Customize save (the count goes up, so every window takes it).
  expect(w.saves).toEqual([inboxSidebarSetShown(theirs, "copy-prompt", false)]);
  expect(inboxSidebarState()).toEqual({ sidebar: { ...theirs, hidden: ["copy-prompt", "feedback"] }, rev: 2 });
  // Stamped in state.json (machine state), with the save it made; not the first layout ever saved.
  expect(savedConfig(dataDir).inboxSidebarConnectOff).toEqual({ at: new Date(NOW).toISOString(), rev: 2 });
  expect(w.off.check()).toBe(false);
  expect(w.saves).toHaveLength(1);
});

test("turned back on, it stays on: later checks and a restarted Inbox leave it", () => {
  const w = inbox(ago(2 * CONNECT_PILL_OFF_AFTER_MS));
  expect(w.off.check()).toBe(true);
  expect(shown()).toBe(false);
  // The person turns it back on in Customize sidebar.
  panelSave(inboxSidebarSetShown(inboxSidebarState().sidebar!, "copy-prompt", true));
  w.at(NOW + 10 * CONNECT_PILL_OFF_AFTER_MS);
  w.off.heard(ago(3 * CONNECT_PILL_OFF_AFTER_MS));
  expect(w.off.check()).toBe(false);
  const restarted = inbox(ago(5 * CONNECT_PILL_OFF_AFTER_MS), NOW + 20 * CONNECT_PILL_OFF_AFTER_MS);
  expect(restarted.off.check()).toBe(false);
  expect(restarted.saves).toEqual([]);
  expect(shown()).toBe(true);
});

test("a stamp of any form means it ran: never again", () => {
  expect(connectPillOffDue({}, ago(CONNECT_PILL_OFF_AFTER_MS * 3), NOW)).toBe(false);
  expect(connectPillOffDue("garbled", ago(CONNECT_PILL_OFF_AFTER_MS * 3), NOW)).toBe(false);
  expect(connectPillOffDue(undefined, ago(CONNECT_PILL_OFF_AFTER_MS * 3), NOW)).toBe(true);
  expect(connectPillOffDue(undefined, "not a time", NOW)).toBe(false);
});

test("Minimal already hides it: only stamped, no save; a preset picked later is never undone", () => {
  panelSave(INBOX_SIDEBAR_PRESETS.minimal.layout);
  const w = inbox(ago(2 * CONNECT_PILL_OFF_AFTER_MS));
  expect(w.off.check()).toBe(false);
  expect(w.saves).toEqual([]);
  expect(inboxSidebarState().rev).toBe(1);
  expect(savedConfig(dataDir).inboxSidebarConnectOff).toEqual({ at: new Date(NOW).toISOString() });
  // Later the person starts from Default (the pill shows again): it stays.
  panelSave(INBOX_SIDEBAR_PRESETS.default.layout);
  w.at(NOW + 5 * CONNECT_PILL_OFF_AFTER_MS);
  expect(w.off.check()).toBe(false);
  expect(inbox(ago(9 * CONNECT_PILL_OFF_AFTER_MS)).off.check()).toBe(false);
  expect(shown()).toBe(true);
});

test("the first agent heard while the Inbox runs starts the day: the check a day later turns it off", () => {
  const w = inbox(null);
  w.off.heard(new Date(NOW).toISOString());
  expect(w.off.check()).toBe(false);
  w.at(NOW + CONNECT_PILL_OFF_AFTER_MS - 1);
  expect(w.off.check()).toBe(false);
  w.at(NOW + CONNECT_PILL_OFF_AFTER_MS);
  expect(w.off.check()).toBe(true);
  expect(shown()).toBe(false);
});

test("a layout that cannot be saved changes nothing and is tried again", () => {
  const first = ago(2 * CONNECT_PILL_OFF_AFTER_MS);
  let fail = true;
  const off = createConnectPillOff({
    firstAgentAt: () => first,
    saveSidebar: (layout) => {
      if (fail) throw new Error("config.json could not be saved");
      return panelSave(layout);
    },
    now: () => NOW,
  });
  expect(off.check()).toBe(false);
  expect(savedConfig(dataDir).inboxSidebarConnectOff).toBeUndefined();
  fail = false;
  expect(off.check()).toBe(true);
  expect(shown()).toBe(false);
});

test("the Sidebar tip: the switch-off's own first save is not the person customizing; their save after it is", () => {
  const w = inbox(ago(2 * CONNECT_PILL_OFF_AFTER_MS));
  w.off.check();
  expect(savedConfig(dataDir).inboxSidebarConnectOff).toEqual({ at: new Date(NOW).toISOString(), rev: 1, first: true });
  expect(sidebarCustomizedByPerson(loadConfig(), inboxSidebarState().rev)).toBe(false);
  panelSave(inboxSidebarSetShown(inboxSidebarState().sidebar!, "feedback", false));
  expect(sidebarCustomizedByPerson(loadConfig(), inboxSidebarState().rev)).toBe(true);
  // A layout the person saved before it: customized, whatever the switch-off did.
  expect(sidebarCustomizedByPerson({ inboxSidebar: INBOX_SIDEBAR_DEFAULT, inboxSidebarConnectOff: { rev: 2 } }, 2)).toBe(true);
  expect(sidebarCustomizedByPerson({}, 0)).toBe(false);
});

test("an older Inbox's stamp left in config.json still counts", () => {
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxSidebarConnectOff: { at: ago(CONNECT_PILL_OFF_AFTER_MS) } }));
  expect(inbox(ago(3 * CONNECT_PILL_OFF_AFTER_MS)).off.check()).toBe(false);
  expect(shown()).toBe(true);
});

test("the first agent is the store's oldest agent message, across threads; the person's own messages never count", () => {
  const messages: Record<string, { author: { kind: string }; created_at: string }> = {
    a1: { author: { kind: "person" }, created_at: "2026-11-01T00:00:00.000Z" },
    a2: { author: { kind: "agent" }, created_at: "2026-11-05T00:00:00.000Z" },
    b1: { author: { kind: "agent" }, created_at: "2026-11-03T00:00:00.000Z" },
    b2: { author: { kind: "agent" }, created_at: "2026-11-04T00:00:00.000Z" },
    c1: { author: { kind: "person" }, created_at: "2026-10-01T00:00:00.000Z" },
  };
  const threads: Record<string, string[]> = { a1: ["a1", "a2"], b1: ["b1", "b2"], c1: ["c1"] };
  const store = (ids: string[]) => ({ threadIds: () => ids, threadMessageIds: (id: string) => threads[id] ?? [], message: (id: string) => messages[id] ?? null });
  expect(firstAgentMessageAt(store(["a1", "b1", "c1"]))).toBe("2026-11-03T00:00:00.000Z");
  expect(firstAgentMessageAt(store(["c1"]))).toBeNull();
  expect(firstAgentMessageAt(store([]))).toBeNull();
});
