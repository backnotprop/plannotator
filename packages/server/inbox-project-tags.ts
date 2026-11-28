/**
 * Plannotator Inbox: tags on projects (shared/inbox/project-tags.ts). The window's route, guarded as every window write
 * (same origin, the page's `serverSession`):
 *
 *   POST /api/inbox/projects/:id/tags   `{ tag: "ini_…", on: boolean }`: the project's ⋯ → Add tag, tick or untick;
 *                                       `{ name, on }` in place of `tag`: the live tag of that name, made when none is
 *                                       (a linked machine's window names a tag so). Answers `{ tags }`, the project's.
 *
 * The list model's projects carry their live tags (`tags`, only when there are any); a change tells every window
 * (`event: tags`) and every linked machine reads the list again. A linked machine's window reaches this route through
 * the device door (mark `project-tags`): a project's tags live on the machine whose project it is, as a thread's do.
 * Phones do not take it. Bun only: the Inbox has no Pi server.
 */

import { checkServerSession, INBOX_SERVER_SESSION_MISMATCH_ERROR, serverSessionMismatchBody } from "@plannotator/core/server-session";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxProjectTags } from "@plannotator/shared/inbox/project-tags";

export const INBOX_PROJECT_TAGS_PATH = /^\/api\/inbox\/projects\/([A-Za-z0-9_]+)\/tags$/;

export function createInboxProjectTagsRoute(options: {
  tags: InboxProjectTags;
  serverSession: string;
  readBody: (req: Request) => Promise<Record<string, unknown>>;
  json: (body: unknown, status?: number) => Response;
}) {
  const { tags, serverSession, json } = options;
  return async (req: Request, url: URL): Promise<Response | null> => {
    const match = INBOX_PROJECT_TAGS_PATH.exec(url.pathname);
    if (!match) return null;
    if (req.method !== "POST") return json({ error: "Use POST." }, 405);
    const body = await options.readBody(req);
    if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
    if (typeof body.on !== "boolean") throw new InboxError("validation_error", "on: a boolean.", { field: "on" });
    if (body.tag === undefined && body.name !== undefined) return json({ tags: tags.setNamed(match[1]!, body.name, body.on) });
    return json({ tags: tags.set(match[1]!, body.tag, body.on) });
  };
}

/**
 * A linked machine's project as the merged list gives it: its tags read as the merged tags of their names
 * (`idOn`), none from a machine that takes no tags from here (an older one's stay its own).
 */
export function farProjectTags<T extends Record<string, unknown>>(project: T, taken: ReadonlySet<string>, idOn: (machine: string, id: string) => string | null): T {
  const { tags, ...rest } = project as T & { tags?: unknown };
  const machine = typeof project.machine === "string" ? project.machine : null;
  if (!Array.isArray(tags) || !machine || !taken.has(machine)) return rest as T;
  const ids = [...new Set(tags.flatMap((id) => (typeof id === "string" ? (idOn(machine, id) ?? []) : [])))];
  return (ids.length > 0 ? { ...rest, tags: ids } : rest) as T;
}
