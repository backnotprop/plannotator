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
import { drawingStatus, gate, type ChangedFile, type LoadResult, type SystemModel } from "@plannotator/system";
import { load, systemPaths } from "@plannotator/system/node";
import { parseDiffToFiles, type DiffFile } from "@plannotator/core/diff-files";
import type { InboxProject, InboxProjectRepo, InboxPull } from "@plannotator/core/inbox-types";
import type { SystemDrawingAnswer, SystemProjectRow, SystemPullsAnswer, SystemPullTouch } from "@plannotator/core/inbox-system";
import { isSameOriginOrNoOrigin } from "@plannotator/shared/request-origin";
import { InboxError } from "@plannotator/shared/inbox/schema";
import { systemRepoOf } from "./inbox-system-setup";

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

/** The drawn parts a PR's files touch, in the drawing's order (the gate's touched parts). */
export function touchedParts(model: SystemModel, files: readonly ChangedFile[]): { id: string; name: string }[] {
  const touched = new Set(gate({ files: [...files], model }).touched.parts);
  return Object.keys(model.parts)
    .filter((id) => touched.has(id))
    .map((id) => ({ id, name: model.parts[id]!.name }));
}

/** The open PRs of a repo in the list, newest first. A PR is read at most once per list here, so a repo with many open PRs reads the newest. */
export const SYSTEM_PULLS_READ_MAX = 40;
const READ_AT_ONCE = 4;

/**
 * The open PRs of `repo` (`host/owner/name`) whose changed files touch the drawing. Each PR's files come from its own
 * patch (`patchOf`, the pulls reader's cached diff); a PR whose patch can't be read is counted in `unread`.
 */
export async function systemPullTouches(
  model: SystemModel,
  repo: string,
  pulls: readonly InboxPull[],
  patchOf: (key: string) => Promise<string>,
): Promise<SystemPullsAnswer> {
  const wanted = repo.toLowerCase();
  const open = pulls
    .filter((pull) => (pull.state === "open" || pull.state === "draft") && `${pull.host}/${pull.repo}`.toLowerCase() === wanted)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, SYSTEM_PULLS_READ_MAX);
  const found: (SystemPullTouch | null)[] = new Array(open.length).fill(null);
  let unread = 0;
  let next = 0;
  const worker = async () => {
    while (next < open.length) {
      const i = next++;
      const pull = open[i]!;
      try {
        const parts = touchedParts(model, changedFilesOf(parseDiffToFiles(await patchOf(pull.key))));
        if (parts.length > 0) found[i] = { key: pull.key, parts };
      } catch {
        unread += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(READ_AT_ONCE, open.length) }, worker));
  return { pulls: found.filter((touch): touch is SystemPullTouch => touch !== null), unread };
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
  return json({ serverSession, ...(await systemPullTouches(drawing.model, drawing.project.repo, await deps.listPulls(), deps.patchOf)) });
}
