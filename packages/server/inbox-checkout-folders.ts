/**
 * Plannotator Inbox: fold the folder projects an earlier Inbox made for a checkouts folder into their
 * repository's project, once (the owner, 2026-11-02, on #2526: "fold the old duplicate project in
 * automatically on update").
 *
 * Before rule 4 of inbox-project-root.ts, a session started in a plain folder whose `worktrees/` holds one
 * repository's checkouts (`~/workspaces/projects/appnotes` beside `appnotes/worktrees/main`) made a folder
 * project of its own, beside the repository's project its checkouts file into. Now that folder resolves to
 * the repository; this moves the old folder project in with Combine projects' own write
 * (`InboxStore.combineProject`), so the result is what the person would get from the project menu: the
 * repository project keeps its name, and every thread, rename, read state and snooze stays as it was (a
 * combine moves nothing; it adds one project line). The person can undo it as any combine.
 *
 * Which projects: only a project that is its own head (not combined anywhere), was never split from a combine
 * (`separated_from`: the person undid one, so this does not redo it), whose root is a folder outside any git
 * work tree that has (or is a plain subfolder of a folder that has) a `worktrees` or `.worktrees` folder,
 * that rule 4 maps to another root
 * (`resolveCheckoutsFolder`), where a project already exists. No other project is touched.
 *
 * Once: a marker file (`INBOX_CHECKOUT_FOLDS_FILE`) is written when a pass leaves nothing pending, and a start
 * that finds it does nothing. A candidate whose repository project does not exist yet, or one git did not
 * answer for, is pending: it is left as it is and the next start looks again (no project is made here; the
 * first session in a checkout makes the repository's project, and the next start folds the folder into it).
 * Without the marker the pass is still safe to repeat: a project already combined is skipped.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { checkoutsHolderOf, resolveCheckoutsFolder, type InboxGitRunner } from "./inbox-project-root";

/** The marker, in the store's folder: `{ v: 1, at, folded: [{ project, into }] }`. */
export const INBOX_CHECKOUT_FOLDS_FILE = "checkout-folders-folded.json";

export interface CheckoutFolds {
  /** Each folder project moved, and the repository project it went into. */
  folded: { project: string; into: string }[];
  /** True when the marker is on disk now (written by this pass or found). */
  done: boolean;
}

function markerOf(inboxDir: string): boolean {
  try {
    const value = JSON.parse(readFileSync(join(inboxDir, INBOX_CHECKOUT_FOLDS_FILE), "utf8")) as { v?: unknown } | null;
    return value !== null && typeof value === "object" && value.v === 1;
  } catch {
    return false;
  }
}

/** The pass. Never throws: a project it cannot fold is left as it is. */
export async function foldCheckoutFolderProjects(input: {
  store: InboxStore;
  git?: InboxGitRunner;
  /** One line per fold (the debug log, when it is on). */
  log?: (fold: { project: string; into: string; root: string; into_root: string }) => void;
}): Promise<CheckoutFolds> {
  const { store } = input;
  if (markerOf(store.dir)) return { folded: [], done: true };
  const folded: CheckoutFolds["folded"] = [];
  let pending = false;
  for (const project of store.allProjects()) {
    if (store.canonicalProjectId(project.id) !== project.id || typeof project.separated_from === "string") continue;
    // Cheap first, no git: a plain folder (no `.git` of its own) that has, or is near, a checkouts folder.
    if (existsSync(join(project.root, ".git")) || (await checkoutsHolderOf(project.root)) === null) continue;
    let resolved: { root: string | null; settled: boolean };
    try {
      resolved = await resolveCheckoutsFolder(project.root, input.git ? { git: input.git } : {});
    } catch {
      continue;
    }
    if (!resolved.settled) {
      pending = true;
      continue;
    }
    if (resolved.root === null) continue;
    const into = store.projectByRoot(resolved.root);
    if (!into) {
      pending = true;
      continue;
    }
    if (store.sameProject(into.id, project.id)) continue;
    try {
      store.combineProject(project.id, into.id);
    } catch {
      continue;
    }
    const head = store.canonicalProjectId(into.id);
    folded.push({ project: project.id, into: head });
    input.log?.({ project: project.id, into: head, root: project.root, into_root: resolved.root });
  }
  if (pending) return { folded, done: false };
  try {
    const file = join(store.dir, INBOX_CHECKOUT_FOLDS_FILE);
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ v: 1, at: new Date().toISOString(), folded })}\n`, { mode: 0o600 });
    renameSync(temp, file);
    return { folded, done: true };
  } catch {
    return { folded, done: false };
  }
}
