import { lstat, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { inboxProjectDisplayName, type InboxProject } from "@plannotator/core/inbox-types";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { checkoutsHolderOf, inboxProjectRootHome, resolveCheckoutsFolder, type InboxGitRunner } from "./inbox-project-root";

export const INBOX_CHECKOUT_FOLDS_FILE = "checkout-folders-folded.json";

export const INBOX_CHECKOUT_FOLDS_MAX_STARTS = 5;

export interface CheckoutFolds {
  folded: { project: string; into: string }[];
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

export async function foldCheckoutFolderProjects(input: {
  store: InboxStore;
  git?: InboxGitRunner;
  home?: string | null;
  log?: (fold: { project: string; into: string; root: string; into_root: string }) => void;
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
  const apart = (a: InboxProject, b: InboxProject) => inboxProjectDisplayName(a) !== null || separated(a, b) || separated(b, a);
  const folded: CheckoutFolds["folded"] = [];
  let pending = false;
  for (const project of store.allProjects()) {
    if (Date.parse(project.created_at) > since) continue;
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
    const folder = store.project(project.id);
    const repo = store.project(found.id);
    if (!folder || !repo || store.sameProject(repo.id, folder.id) || apart(folder, repo)) continue;
    try {
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
