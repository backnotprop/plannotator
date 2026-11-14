/**
 * Who gets the one-time "Choose how your list looks" dialog (config.json `inboxListIntro`). Pure, so a test needs no
 * Inbox.
 *
 * Version 2 is the rows dialog with three looks (approval "inbox-rows-dialog", round 7b). It is due once for everyone
 * on a release build: someone who saw the version 1 dialog (the switches, shipped in 0.28.42), someone who never got
 * it, and a fresh install. The page still waits for a list of five threads or more (packages/inbox/listIntro.ts
 * `LIST_INTRO_MIN_ROWS`; the line's `minThreads`, shared/inbox/reveals.ts), so a new user sees it once the list has
 * grown, with no day count. Version 1's record is kept under `before`, not cleared.
 *
 * Never for someone who already picked a look (the owner, 2026-11-09, q-a85c7bc9: "Yes, skip it for them";
 * `listIntroLookPicked`), as the tab icon dialog drops once a favicon is chosen.
 */
import { inboxRowsRead } from "@plannotator/core/inbox-types";
import type { PlannotatorConfig } from "@plannotator/shared/config";

export type ListIntroSaved = NonNullable<PlannotatorConfig["inboxListIntro"]>;

/** The dialog's version. Raise it to show a new dialog once to everyone again. */
export const LIST_INTRO_VERSION = 2;

/**
 * At a release start: the record to write so this version is due, or null when this version (or a newer one) was
 * decided already. `at`: now, as an ISO string.
 */
export function listIntroAtStart(saved: ListIntroSaved | undefined, at: string): ListIntroSaved | null {
  if ((saved?.version ?? 1) >= LIST_INTRO_VERSION) return null;
  const before = saved && (saved.dueAt || saved.shownAt) ? { ...(saved.dueAt ? { dueAt: saved.dueAt } : {}), ...(saved.shownAt ? { shownAt: saved.shownAt } : {}) } : null;
  return { dueAt: at, version: LIST_INTRO_VERSION, ...(before ? { before } : {}) };
}

/**
 * Due: decided and not claimed yet. A release start moves every older record to this version first; a dev build
 * decides nothing, so a record it finds keeps the meaning it had.
 */
export function listIntroDue(saved: ListIntroSaved | undefined): boolean {
  return typeof saved?.dueAt === "string" && saved.dueAt !== "" && !saved.shownAt;
}

/**
 * The person already picked how their rows look (config.json `inboxRows`): the dialog has nothing to ask them. A window
 * saves the look only when the person changes it (a row option in the ⋮ menu, a choice or preset in Settings → Rows,
 * a look in this dialog) or, once, when it adopts a look this browser kept from before the Inbox saved it, which was
 * the person's too. Not a pick: never saved (`inboxRows` unset, or not a list this build reads), a record with no
 * save count (`inboxRowsRev`, written by every save), and a look saved before the defaults changed with every option
 * off (`inboxRowsDefaults` unset: core `inboxRowsSaved` reads that one as "never a choice" too).
 */
export function listIntroLookPicked(config: Pick<PlannotatorConfig, "inboxRows" | "inboxRowsRev" | "inboxRowsDefaults">): boolean {
  const rows = inboxRowsRead(config.inboxRows);
  if (rows === null) return false;
  if (typeof config.inboxRowsRev !== "number" || !(config.inboxRowsRev > 0)) return false;
  return rows.length > 0 || typeof config.inboxRowsDefaults === "number";
}
