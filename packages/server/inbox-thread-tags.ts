/**
 * Plannotator Inbox: tags on threads (approval "inbox-thread-tags", step 1). A tag is an initiative
 * (`POST /api/inbox/initiatives` makes one; `POST /api/inbox/initiatives/:id` renames, deletes and restores it,
 * with the Board on or off). The window's route (same origin for every POST, as every window write; the page's
 * `serverSession`; the owner over the tailnet like every window route):
 *
 *   POST /api/inbox/threads/:id/tags   `{ tag: "ini_…", on: boolean }`: Add tag, untick, Remove from; `{ tags }`, the thread's tags
 *                                      `{ name, on }` in place of `tag`: the live tag of that name, made when none is
 *   POST /api/inbox/tag-colours        `{ tag: "ini_…", colour, at, kept_colour? }`: a tag's row colour (a preset,
 *                                      `#rrggbb`, or null: Highlight rows off, `kept_colour` the colour it keeps for when
 *                                      it is on again); `{ show, at }`: "Show tag colors". `at` is when the person chose, the
 *                                      same on every machine the window sends it to (inbox-tag-colours.ts).
 *
 * The person's marks live in `inbox/tags.json`, outside the event log (shared/inbox/thread-tags.ts): agents,
 * the MCP, search and the phone's event stream never see them. The list model carries the live tags (`tags`) and
 * each row's (`row.tags`), and a change tells every window (`event: tags`, as `event: pins`) and a linked machine
 * that asks (`tags=1`). The device door takes this route and the initiative's from a linked machine only: one tag
 * across machines is the tags of one name, each kept on the machine whose thread it marks.
 */

import { checkServerSession, INBOX_SERVER_SESSION_MISMATCH_ERROR, serverSessionMismatchBody } from "@plannotator/core/server-session";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxStore } from "@plannotator/shared/inbox/store";

export const INBOX_THREAD_TAGS_PATH = /^\/api\/inbox\/threads\/([A-Za-z0-9_]+)\/tags$/;
export const INBOX_TAG_COLOURS_PATH = "/api/inbox/tag-colours";

export function createInboxThreadTags(options: {
  store: InboxStore;
  serverSession: string;
  readBody: (req: Request) => Promise<Record<string, unknown>>;
  json: (body: unknown, status?: number) => Response;
}) {
  const { store, serverSession, json } = options;

  const route = async (req: Request, url: URL): Promise<Response | null> => {
    if (url.pathname === INBOX_TAG_COLOURS_PATH) {
      if (req.method !== "POST") return json({ error: "Use POST." }, 405);
      const body = await options.readBody(req);
      if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
      if (body.show !== undefined) return json({ tag_colours: store.setTagColoursShown(body.show, body.at) });
      if (body.colour === undefined) throw new InboxError("validation_error", "colour: a preset, a #rrggbb, or null.", { field: "colour" });
      return json({ look: store.setTagColour(body.tag, body.colour, body.at, body.kept_colour), tag_colours: store.tagColours() });
    }
    const match = INBOX_THREAD_TAGS_PATH.exec(url.pathname);
    if (!match) return null;
    if (req.method !== "POST") return json({ error: "Use POST." }, 405);
    const body = await options.readBody(req);
    if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
    if (typeof body.on !== "boolean") throw new InboxError("validation_error", "on: a boolean.", { field: "on" });
    if (body.tag === undefined && body.name !== undefined) return json({ tags: store.setThreadTagNamed(match[1]!, body.name, body.on) });
    return json({ tags: store.setThreadTag(match[1]!, body.tag, body.on) });
  };

  return { route };
}
