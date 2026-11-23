/**
 * The sidebar's saved layout, against a scratch config.json (PLANNOTATOR_DATA_DIR). What regresses if these fail: a
 * layout saved while Plans is off writes `plans` into config.json (the lenient read puts back every item a layout does
 * not name), or such a save is reported as "not saved" because the read-back puts `plans` back.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_SIDEBAR_DEFAULT } from "@plannotator/core/inbox-sidebar";
import { inboxSidebarState, saveInboxSidebar } from "./inbox-sidebar-save";

let dataDir = "";
let savedEnv: string | undefined;
beforeEach(() => {
  savedEnv = process.env.PLANNOTATOR_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), "inbox-sidebar-save-"));
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = savedEnv;
  rmSync(dataDir, { recursive: true, force: true });
});

const stored = () => JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")).inboxSidebar as { top: string[]; bottom: string[]; hidden: string[] };
const names = (layout: { top: readonly string[]; bottom: readonly string[]; hidden: readonly string[] }) => [...layout.top, ...layout.bottom, ...layout.hidden];

test("off, Plans is never written: a layout the window sends without it is stored without it, and the save is not reported as failed", () => {
  // The window hides Feedback while Plans has never been on; it sends no `plans`.
  const layout = { top: INBOX_SIDEBAR_DEFAULT.top.filter((id) => id !== "plans"), bottom: [...INBOX_SIDEBAR_DEFAULT.bottom], hidden: ["feedback"] };
  const answer = saveInboxSidebar(layout, { off: ["plans"] });
  expect(names(stored())).not.toContain("plans");
  expect(stored().hidden).toEqual(["feedback"]);
  expect(answer.rev).toBe(1);
  // Read back as every window reads it: the item takes its default place, as for any item a layout does not name.
  expect(inboxSidebarState().sidebar).toEqual(answer.sidebar);

  // Even a layout that names it (an older window) is stored without it while off.
  saveInboxSidebar({ top: [...INBOX_SIDEBAR_DEFAULT.top], bottom: [...INBOX_SIDEBAR_DEFAULT.bottom], hidden: ["plans"] }, { off: ["plans"] });
  expect(names(stored())).not.toContain("plans");
  expect(inboxSidebarState().rev).toBe(2);
});

test("on, the layout is stored as sent, Plans included", () => {
  const top = [...INBOX_SIDEBAR_DEFAULT.top].reverse();
  const answer = saveInboxSidebar({ top, bottom: [...INBOX_SIDEBAR_DEFAULT.bottom], hidden: ["plans"] }, { off: [] });
  expect(stored().top).toEqual(top);
  expect(stored().hidden).toEqual(["plans"]);
  expect(answer.sidebar.top).toEqual(top);
});
