/**
 * The sidebar's saved layout (config.json `inboxSidebar`, `inboxSidebarRev`): read and save, for `inbox.ts`.
 *
 * `off` names the items of a switch that is off (Plans, while config.json `inboxPlans` is off). Such an item is never
 * written: the layout is read leniently (`inboxSidebarRead`, which puts back every item it does not name), so a save is
 * stored without them, and the read-back check compares the read form of what was stored. Turned on later, the item
 * takes its default place.
 */
import { inboxSidebarCheck, inboxSidebarRead, type InboxSidebarLayout } from "@plannotator/core/inbox-sidebar";
import { loadConfig, saveConfig } from "@plannotator/shared/config";
import { InboxError } from "@plannotator/shared/inbox/schema";

export interface InboxSidebarState {
  sidebar: InboxSidebarLayout | null;
  rev: number;
}

export function inboxSidebarState(): InboxSidebarState {
  const config = loadConfig();
  const rev = config.inboxSidebarRev;
  return { sidebar: inboxSidebarRead(config.inboxSidebar), rev: typeof rev === "number" && Number.isSafeInteger(rev) && rev > 0 ? rev : 0 };
}

/** The layout as stored: without the items named in `off`. */
export function inboxSidebarStored(sidebar: InboxSidebarLayout, off: readonly string[]): InboxSidebarLayout {
  if (off.length === 0) return sidebar;
  const keep = <T extends string>(list: readonly T[]) => list.filter((id) => !off.includes(id));
  return { top: keep(sidebar.top), bottom: keep(sidebar.bottom), hidden: keep(sidebar.hidden) };
}

/** Validates and saves a layout; answers it as every window reads it back (`inboxSidebarRead` of what was stored). */
export function saveInboxSidebar(input: unknown, options: { off: readonly string[]; validateOnly?: boolean }): { sidebar: InboxSidebarLayout; rev: number } {
  const checked = inboxSidebarCheck(input);
  if (!checked) throw new InboxError("validation_error", "sidebar: { top, bottom, hidden }, each a list of sidebar item names.", { field: "sidebar" });
  const stored = inboxSidebarStored(checked, options.off);
  const sidebar = inboxSidebarRead(stored)!;
  const rev = inboxSidebarState().rev + 1;
  if (options.validateOnly) return { sidebar, rev };
  saveConfig({ inboxSidebar: stored, inboxSidebarRev: rev });
  const saved = inboxSidebarState();
  if (saved.rev !== rev || JSON.stringify(saved.sidebar) !== JSON.stringify(sidebar)) throw new InboxError("config_not_saved", "config.json could not be saved; nothing changed. A config.json that is not valid JSON is never written over: fix or remove it.");
  return { sidebar, rev };
}
