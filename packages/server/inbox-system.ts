/**
 * System's reads for the window (approval "system-inbox", items 1, 4 and 5): the projects with their drawing's
 * state (Settings → Capabilities' System rows and the Reviews System button), one project's drawing (the Reviews
 * pane and its full window), and the open PRs whose changed files touch it ("Open PRs that change this").
 *
 * The drawing is `<data dir>/system/<project key>/drawing/` (owner ruling q-122e6577), loaded and judged by
 * `@plannotator/system`; the PRs are the pulls list's own (same cache), their files read from each PR's patch, and
 * the package's `gate()` says which drawn parts they touch. Nothing here writes. Bun only (Inbox routes): no Pi twin.
 */

import { statSync } from "node:fs";
import { drawingStatus, gate, type ChangedFile, type GateResult, type LoadResult, type SystemModel } from "@plannotator/system";
import { load, systemPaths } from "@plannotator/system/node";
import { parseDiffToFiles, type DiffFile } from "@plannotator/core/diff-files";
import type { InboxProject, InboxProjectRepo, InboxPull } from "@plannotator/core/inbox-types";
import type { SystemDrawingAnswer, SystemProjectRow, SystemPullsAnswer, SystemPullTouch } from "@plannotator/core/inbox-system";
import { isSameOriginOrNoOrigin } from "@plannotator/shared/request-origin";
import { InboxError } from "@plannotator/shared/inbox/schema";
import { systemRepoOf } from "./inbox-system-setup";

/** What System's switch needs from the running Inbox (inbox.ts passes its own config reads and writes). */
export interface SystemSwitchDeps {
  codeReviewOn: () => boolean;
  /** config.json `inboxSystem` as read now. */
  saved: () => boolean;
  /** A value the server was started with, over config (tests). */
  fixed?: boolean;
  save: (on: boolean) => void;
  /** Every window hears it (`event: capabilities`). */
  changed: () => void;
}

/**
 * Settings → Capabilities → System (config.json `inboxSystem`). System shows, and its routes answer, only while it
 * AND Code review are on (`on`); the window hears the switch only while Code review is on (`wire`), since the row shows
 * only then. The settings POST's part: `check` before anything is saved (a tailnet guest is refused, like every
 * capability switch; a malformed value throws), `answer` after the other fields saved.
 */
export function systemSwitch(deps: SystemSwitchDeps) {
  const switchOn = () => deps.fixed ?? deps.saved();
  const on = () => deps.codeReviewOn() && switchOn();
  const wire = (): { system?: { on: boolean } } => (deps.codeReviewOn() ? { system: { on: switchOn() } } : {});
  const parse = (input: unknown): boolean => {
    if (!input || typeof input !== "object" || Array.isArray(input) || typeof (input as { on?: unknown }).on !== "boolean" || Object.keys(input).some((key) => key !== "on")) {
      throw new InboxError("validation_error", "system: { on: boolean }.", { field: "system" });
    }
    return (input as { on: boolean }).on;
  };
  return {
    switchOn,
    on,
    wire,
    check(body: { system?: unknown }, owner: boolean): "local_only" | null {
      if (body.system === undefined) return null;
      // The drawings, and from B9 the jobs that keep them current: the owner's to change.
      if (!owner) return "local_only";
      parse(body.system);
      return null;
    },
    /** The answer's `system`: the saved switch, to the save that set it even while Code review is off; else `wire`. */
    answer(body: { system?: unknown }): { system?: { on: boolean } } {
      if (body.system === undefined) return wire();
      const next = parse(body.system);
      const was = switchOn();
      deps.save(next);
      if (deps.saved() !== next) throw new InboxError("config_not_saved", "config.json could not be saved; nothing changed. A config.json that is not valid JSON is never written over: fix or remove it.");
      if (was !== switchOn()) deps.changed();
      return { system: { on: switchOn() } };
    },
  };
}

export interface SystemReadDeps {
  dataDir: string;
  /** The project's `origin` (the Inbox's repo cache), null when it has none. */
  repoOf: (root: string) => Promise<InboxProjectRepo | null>;
  isFolder?: (root: string) => boolean;
}

const folderExists = (root: string): boolean => {
  try {
    return statSync(root).isDirectory();
  } catch {
    return false;
  }
};

/** The project's drawing as the loader reads it; a key the package refuses reads as no drawing. */
async function loadDrawing(dataDir: string, key: string): Promise<LoadResult | null> {
  let dir: string;
  try {
    dir = systemPaths(dataDir, key).drawing;
  } catch {
    return null;
  }
  return load(dir);
}

async function rowOf(project: InboxProject, deps: SystemReadDeps, result: LoadResult | null): Promise<SystemProjectRow> {
  const onMac = (deps.isFolder ?? folderExists)(project.root);
  const repo = onMac ? systemRepoOf(await deps.repoOf(project.root)) : null;
  const status = drawingStatus(result);
  return { id: project.id, key: project.key, name: project.display_name ?? project.name, repo, state: status.state, sheets: status.sheets, wanted: status.wanted };
}

/** Every project that can be set up here (its folder on this Mac, with a git remote) or already has a drawing. */
export async function systemProjects(projects: readonly InboxProject[], deps: SystemReadDeps): Promise<SystemProjectRow[]> {
  const rows = await Promise.all(projects.map(async (project) => rowOf(project, deps, await loadDrawing(deps.dataDir, project.key))));
  return rows.filter((row) => row.repo !== null || row.state !== "none");
}

/** One project's drawing: the model when it loads (with or without warnings), else null. */
export async function systemDrawing(project: InboxProject, deps: SystemReadDeps): Promise<SystemDrawingAnswer<SystemModel>> {
  const result = await loadDrawing(deps.dataDir, project.key);
  return { project: await rowOf(project, deps, result), model: result?.model ?? null };
}

/** A patch's files as the gate takes them. */
export function changedFilesOf(files: readonly DiffFile[]): ChangedFile[] {
  return files.map((file) =>
    file.status === "renamed" && file.oldPath
      ? { path: file.path, status: "R" as const, from: file.oldPath }
      : { path: file.path, status: file.status === "added" ? ("A" as const) : file.status === "deleted" ? ("D" as const) : ("M" as const) },
  );
}

/** The drawn parts a gate result touches, in the drawing's order. */
export function touchedParts(model: SystemModel, change: GateResult): { id: string; name: string }[] {
  const touched = new Set(change.touched.parts);
  return Object.keys(model.parts)
    .filter((id) => touched.has(id))
    .map((id) => ({ id, name: model.parts[id]!.name }));
}

/**
 * Each PR's changed files, kept by its head commit: a PR's files at one head don't change, so a PR is read again only
 * when it moved (the pane reads every time the pulls list does). Bounded: the oldest kept go first.
 */
export interface SystemFilesCache {
  get(key: string): ChangedFile[] | undefined;
  set(key: string, files: ChangedFile[]): void;
}

export function systemFilesCache(max = 400): SystemFilesCache {
  const kept = new Map<string, ChangedFile[]>();
  return {
    get: (key) => kept.get(key),
    set(key, files) {
      kept.delete(key);
      kept.set(key, files);
      while (kept.size > max) kept.delete(kept.keys().next().value!);
    },
  };
}

/** A PR's place in the cache: its head commit, or (when the list did not say it) its last update. */
const filesKeyOf = (pull: InboxPull) => `${pull.key}@${pull.head_sha ?? `updated ${pull.updated_at}`}`;

/** The open PRs of a repo in the list, newest first. A PR is read at most once per list here, so a repo with many open PRs reads the newest. */
export const SYSTEM_PULLS_READ_MAX = 40;
const READ_AT_ONCE = 4;

/**
 * The open PRs of `repo` (`host/owner/name`) whose changed files touch the drawing. Each PR's files come from its own
 * patch (`patchOf`, the pulls reader's cached diff), kept by head commit in `cache`; a PR whose patch can't be read
 * is counted in `unread`.
 */
export async function systemPullTouches(
  model: SystemModel,
  repo: string,
  pulls: readonly InboxPull[],
  patchOf: (key: string) => Promise<string>,
  cache: SystemFilesCache = systemFilesCache(),
): Promise<SystemPullsAnswer<GateResult>> {
  const wanted = repo.toLowerCase();
  const open = pulls
    .filter((pull) => (pull.state === "open" || pull.state === "draft") && `${pull.host}/${pull.repo}`.toLowerCase() === wanted)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, SYSTEM_PULLS_READ_MAX);
  const found: (SystemPullTouch<GateResult> | null)[] = new Array(open.length).fill(null);
  let unread = 0;
  let next = 0;
  const worker = async () => {
    while (next < open.length) {
      const i = next++;
      const pull = open[i]!;
      try {
        const at = filesKeyOf(pull);
        let files = cache.get(at);
        if (!files) {
          files = changedFilesOf(parseDiffToFiles(await patchOf(pull.key)));
          cache.set(at, files);
        }
        const change = gate({ files: [...files], model });
        const parts = touchedParts(model, change);
        if (parts.length > 0) found[i] = { key: pull.key, parts, change };
      } catch {
        unread += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(READ_AT_ONCE, open.length) }, worker));
  return { pulls: found.filter((touch): touch is SystemPullTouch<GateResult> => touch !== null), unread };
}

/** What the System read routes need from the running Inbox (inbox.ts passes its own). */
export interface SystemRouteDeps extends SystemReadDeps {
  store: { listProjects(): InboxProject[]; project(id: string): InboxProject | null; canonicalProjectId(id: string): string };
  serverSession: string;
  /** The request comes from the person on this computer, or the machine's owner over the tailnet. */
  ownerOrLocal: (req: Request) => boolean;
  /** System and Code review both on. */
  systemOn: () => boolean;
  /** The PRs the pulls list holds now (its own cached read). */
  listPulls: () => Promise<readonly InboxPull[]>;
  /** One PR's patch (the pulls reader's cached diff of that layer). */
  patchOf: (key: string) => Promise<string>;
  /** The PRs' files kept by head commit across reads (inbox.ts keeps one for its life). */
  filesCache?: SystemFilesCache;
  json: (body: unknown, status?: number) => Response;
}

export const SYSTEM_READ_PATHS = ["/api/inbox/system/projects", "/api/inbox/system/drawing", "/api/inbox/system/pulls"] as const;

/**
 * `GET /api/inbox/system/projects`, `/drawing?project=<id>` and `/pulls?project=<id>`. Guards in order: method, owner,
 * same origin, System on. An `InboxError` is thrown for the caller's error answer.
 */
export async function systemReadRoute(req: Request, path: string, deps: SystemRouteDeps): Promise<Response> {
  const { json } = deps;
  if (req.method !== "GET") return json({ error: "Use GET." }, 405);
  if (!deps.ownerOrLocal(req)) return json({ error: "This answers only on this computer, not over the tailnet.", code: "local_only" }, 403);
  if (!isSameOriginOrNoOrigin(req.headers.get("origin"), req.headers.get("host") ?? "", req.headers.get("sec-fetch-site"))) {
    return json({ error: "Cross-origin requests are not accepted.", code: "cross_origin" }, 403);
  }
  if (!deps.systemOn()) return json({ error: "System is off.", code: "system_off" }, 409);
  const { store, serverSession } = deps;
  if (path === "/api/inbox/system/projects") return json({ serverSession, projects: await systemProjects(store.listProjects(), deps) });
  const asked = new URL(req.url).searchParams.get("project") ?? "";
  const project = asked && store.project(asked) ? store.project(store.canonicalProjectId(asked)) : null;
  if (!project) throw new InboxError("validation_error", "project: a project in the Inbox.", { field: "project" });
  const drawing = await systemDrawing(project, deps);
  if (path === "/api/inbox/system/drawing") return json({ serverSession, ...drawing });
  // The open PRs that change it: none without a drawing or a repo to read them from.
  if (!drawing.model || !drawing.project.repo) return json({ serverSession, pulls: [], unread: 0 } satisfies SystemPullsAnswer & { serverSession: string });
  return json({ serverSession, ...(await systemPullTouches(drawing.model, drawing.project.repo, await deps.listPulls(), deps.patchOf, deps.filesCache)) });
}
