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
 * Which projects: only a project that is its own head (not combined anywhere; the store refuses to move one
 * that is), whose root is a folder outside
 * any git work tree that has (or is a plain subfolder of a folder that has) a `worktrees` or `.worktrees`
 * folder, that rule 4 maps to another root (`resolveCheckoutsFolder`), where a project already exists. It
 * skips, and never touches again:
 * - a pair the person split, either way (the folder's `separated_from` names the repository's project, or the
 *   repository's names the folder's): an Undo is not redone, as Tidy does not suggest the pair again;
 * - a project the person renamed (`display_name`): they named it apart, so it stays apart (they can Combine it);
 * - a project made after the first pass ran (`since`): rule 4 files new sessions right, so only old ones need it.
 * Both records are read again right before the combine, so a change made while git answered counts.
 * No other project is touched.
 *
 * Once: a state file (`INBOX_CHECKOUT_FOLDS_FILE`) records the first pass (`since`) and how many starts looked.
 * A candidate whose repository project does not exist yet, or one git did not answer for, is pending: it is
 * left as it is and the next start looks again (no project is made here; the first session in a checkout
 * makes the repository's project, and the next start folds the folder into it). A pass that leaves nothing
 * pending, or the `INBOX_CHECKOUT_FOLDS_MAX_STARTS`th start, marks it `done`, and a start that finds that does
 * nothing: a folder whose repository never shows up is left for the person to Combine. Without the file the
 * pass is still safe to repeat: a project already combined is skipped.
 */

import { lstat, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { inboxProjectDisplayName, type InboxProject } from "@plannotator/core/inbox-types";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { checkoutsHolderOf, inboxProjectRootHome, resolveCheckoutsFolder, type InboxGitRunner } from "./inbox-project-root";

/** The state file, in the store's folder: `{ v: 1, since, starts, done, folded: [{ project, into }] }`. */
export const INBOX_CHECKOUT_FOLDS_FILE = "checkout-folders-folded.json";

/** The starts that look for pending folds before the pass gives up on them (marks itself done). */
export const INBOX_CHECKOUT_FOLDS_MAX_STARTS = 5;

export interface CheckoutFolds {
  /** Each folder project moved, and the repository project it went into. */
  folded: { project: string; into: string }[];
  /** True when the state file says done now (written by this pass or found). */
  done: boolean;
}

type FoldState = { v: 1; since: string; starts: number; done: boolean; folded: CheckoutFolds["folded"] };

async function stateOf(inboxDir: string): Promise<FoldState | null> {
  try {
    const value = JSON.parse(await readFile(join(inboxDir, INBOX_CHECKOUT_FOLDS_FILE), "utf8")) as Partial<FoldState> | null;
    if (value === null || typeof value !== "object" || value.v !== 1) return null;
    return {
      v: 1,
      since: typeof value.since === "string" && !Number.isNaN(Date.parse(value.since)) ? value.since : new Date().toISOString(),
      starts: typeof value.starts === "number" && Number.isFinite(value.starts) ? value.starts : 0,
      done: value.done === true,
      folded: Array.isArray(value.folded) ? value.folded : [],
    };
  } catch {
    return null;
  }
}

async function writeState(inboxDir: string, state: FoldState): Promise<boolean> {
  try {
    const file = join(inboxDir, INBOX_CHECKOUT_FOLDS_FILE);
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    await rename(temp, file);
    return true;
  } catch {
    return false;
  }
}

async function hasGitEntry(folder: string): Promise<boolean> {
  try {
    await lstat(join(folder, ".git"));
    return true;
  } catch {
    return false;
  }
}

/** The pass. Never throws: a project it cannot fold is left as it is. */
export async function foldCheckoutFolderProjects(input: {
  store: InboxStore;
  git?: InboxGitRunner;
  /** This user's home folder (a realpath; null: none), never folded; tests inject one. Default: the real one. */
  home?: string | null;
  /** One line per fold (the debug log, when it is on). */
  log?: (fold: { project: string; into: string; root: string; into_root: string }) => void;
  /** The clock, for tests. */
  now?: () => Date;
}): Promise<CheckoutFolds> {
  const { store } = input;
  const now = input.now ?? (() => new Date());
  const home = input.home === undefined ? inboxProjectRootHome() : input.home;
  const earlier = await stateOf(store.dir);
  if (earlier?.done) return { folded: [], done: true };
  const state: FoldState = earlier ?? { v: 1, since: now().toISOString(), starts: 0, done: false, folded: [] };
  state.starts += 1;
  const since = Date.parse(state.since);
  const separated = (a: InboxProject, b: InboxProject) => a.separated_from !== undefined && store.sameProject(a.separated_from, b.id);
  // Tidy's check (inbox-combine-suggestions.ts): either one was split from the other.
  const apart = (a: InboxProject, b: InboxProject) => inboxProjectDisplayName(a) !== null || separated(a, b) || separated(b, a);
  const folded: CheckoutFolds["folded"] = [];
  let pending = false;
  for (const project of store.allProjects()) {
    if (Date.parse(project.created_at) > since) continue;
    // Cheap first, no git: a plain folder (no `.git` of its own) that has, or is near, a checkouts folder.
    if ((await hasGitEntry(project.root)) || (await checkoutsHolderOf(project.root, home)) === null) continue;
    let resolved: { root: string | null; settled: boolean };
    try {
      resolved = await resolveCheckoutsFolder(project.root, { ...(input.git ? { git: input.git } : {}), home });
    } catch {
      continue;
    }
    if (!resolved.settled) {
      pending = true;
      continue;
    }
    if (resolved.root === null) continue;
    const found = store.projectByRoot(resolved.root);
    if (!found) {
      pending = true;
      continue;
    }
    // Read both again: the person may have combined, split or renamed while git answered.
    const folder = store.project(project.id);
    const repo = store.project(found.id);
    if (!folder || !repo || store.sameProject(repo.id, folder.id) || apart(folder, repo)) continue;
    try {
      // The store refuses a folder project already combined into another (`already_combined`): it stays there.
      store.combineProject(folder.id, repo.id);
    } catch {
      continue;
    }
    const head = store.canonicalProjectId(repo.id);
    folded.push({ project: folder.id, into: head });
    input.log?.({ project: folder.id, into: head, root: folder.root, into_root: resolved.root });
  }
  state.folded.push(...folded);
  state.done = !pending || state.starts >= INBOX_CHECKOUT_FOLDS_MAX_STARTS;
  const written = await writeState(store.dir, state);
  return { folded, done: state.done && written };
}
