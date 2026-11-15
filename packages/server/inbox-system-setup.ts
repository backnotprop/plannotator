/**
 * System's project setup (approval "system-inbox", item 2): the projects the setup dialog offers and the save
 * of the person's choices to `<data dir>/system/<project key>/setup.json`. The routes (inbox.ts,
 * `/api/inbox/system/setup`) guard and call these; nothing here reads the network.
 */

import { statSync } from "node:fs";
import type { InboxProject, InboxProjectRepo } from "@plannotator/core/inbox-types";
import { systemSetupFromInput, type SystemSetup, type SystemSetupProject } from "@plannotator/core/inbox-system-setup";
import { readSystemSetup, systemDrawingPath, writeSystemSetup } from "@plannotator/shared/inbox/system-setup";
import { InboxError } from "@plannotator/shared/inbox/schema";
import { isSameOriginOrNoOrigin } from "@plannotator/shared/request-origin";
import { checkServerSession, INBOX_SERVER_SESSION_MISMATCH_ERROR, serverSessionMismatchBody } from "@plannotator/core/server-session";

export interface SystemSetupDeps {
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

/** `host/owner/name` for a parsed remote; null without a host. */
export function systemRepoOf(repo: InboxProjectRepo | null): string | null {
  return repo?.host ? `${repo.host.toLowerCase()}/${repo.display}` : null;
}

/** Every project whose folder is on this Mac and has a git remote, with what was chosen for it before. */
export async function systemSetupProjects(projects: readonly InboxProject[], deps: SystemSetupDeps): Promise<SystemSetupProject[]> {
  const isFolder = deps.isFolder ?? folderExists;
  const found = await Promise.all(
    projects.map(async (project): Promise<SystemSetupProject | null> => {
      if (!isFolder(project.root)) return null;
      const repo = systemRepoOf(await deps.repoOf(project.root));
      if (!repo) return null;
      return { id: project.id, key: project.key, name: project.display_name ?? project.name, root: project.root, repo, drawing: systemDrawingPath(deps.dataDir, project.key), setup: readSystemSetup(deps.dataDir, project.key) };
    }),
  );
  return found.filter((project): project is SystemSetupProject => project !== null);
}

/** Save the person's choices for one project; the drawing's thread, once started, is kept. */
export async function saveSystemSetup(project: InboxProject, body: Record<string, unknown>, deps: SystemSetupDeps): Promise<SystemSetup> {
  if (!(deps.isFolder ?? folderExists)(project.root)) throw new InboxError("folder_missing", "This project's folder is not on this Mac.");
  const repo = systemRepoOf(await deps.repoOf(project.root));
  if (!repo) throw new InboxError("validation_error", "project_id: a project whose folder has a git remote.", { field: "project_id" });
  const checked = systemSetupFromInput(body, repo);
  if (!checked.ok) throw new InboxError("validation_error", checked.error, { field: checked.field });
  const before = readSystemSetup(deps.dataDir, project.key);
  return writeSystemSetup(deps.dataDir, project.key, { v: 1, ...checked.value, thread_message: before?.thread_message ?? null });
}

/** What `/api/inbox/system/setup` needs from the running Inbox (inbox.ts passes its own). */
export interface SystemSetupRouteDeps extends SystemSetupDeps {
  store: { listProjects(): InboxProject[]; project(id: string): InboxProject | null; canonicalProjectId(id: string): string };
  serverSession: string;
  /** System and Code review both on. */
  systemOn: () => boolean;
  readBody: (req: Request) => Promise<Record<string, unknown>>;
  json: (body: unknown, status?: number) => Response;
}

/**
 * `GET /api/inbox/system/setup` (the projects the dialog offers) and `POST` (one project's save). Guards in order:
 * method, same origin, System on, then the window's `serverSession`. An `InboxError` is thrown for the
 * caller's error answer.
 */
export async function systemSetupRoute(req: Request, deps: SystemSetupRouteDeps): Promise<Response> {
  const { json } = deps;
  if (req.method !== "GET" && req.method !== "POST") return json({ error: "Use GET or POST." }, 405);
  if (!isSameOriginOrNoOrigin(req.headers.get("origin"), req.headers.get("host") ?? "", req.headers.get("sec-fetch-site"))) {
    return json({ error: "Cross-origin requests are not accepted.", code: "cross_origin" }, 403);
  }
  if (!deps.systemOn()) return json({ error: "System is off.", code: "system_off" }, 409);
  const { store, serverSession } = deps;
  if (req.method === "GET") return json({ serverSession, projects: await systemSetupProjects(store.listProjects(), deps) });
  const body = await deps.readBody(req);
  if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
  const projectId = typeof body.project_id === "string" && store.project(body.project_id) ? store.canonicalProjectId(body.project_id) : null;
  const project = projectId ? store.project(projectId) : null;
  if (!project) throw new InboxError("validation_error", "project_id: a project in the Inbox.", { field: "project_id" });
  return json({ serverSession, setup: await saveSystemSetup(project, body, deps) });
}
