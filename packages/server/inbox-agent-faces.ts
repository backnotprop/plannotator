/**
 * Plannotator Inbox: the face each agent's icon shows, for every window (core `inbox-types.ts` ("Agent faces"), the file in
 * packages/shared/inbox/agent-faces.ts). The window's routes (same origin for every POST, the page's
 * `serverSession`, as the pins' routes). Bun only: the Inbox runs on the Bun server; the Pi server serves no Inbox route.
 *
 *   GET  /api/inbox/agent-faces   `{ faces, rev }`
 *   POST /api/inbox/agent-faces   `{ agent, sessions?, face }`: one agent's face (`agent`: its own mark again); `{ faces, rev }`
 *   POST /api/inbox/agent-faces   `{ agent, sessions?, name }`: its given name (null or blank: none), in the same
 *                                 entry as its face; `{ faces, rev }`
 *   POST /api/inbox/agent-faces   `{ adopt: { [agent id]: face } }`: this browser's faces from before, once; `{ faces, rev }`
 *
 * Every answer and event also carries `icons`, the pictures uploaded for "Your own…" (inbox-agent-icons.ts).
 *
 * A save tells every window (`event: agent-faces` with `{ faces, rev }`). Agents, the MCP, search, the phone's door and
 * a linked machine's forward never see faces or given names: they stay on the computer whose Inbox the window shows.
 */

import { checkServerSession, INBOX_SERVER_SESSION_MISMATCH_ERROR, serverSessionMismatchBody } from "@plannotator/core/server-session";
import { checkInboxAgentFaceChange, type InboxAgentFacesFile } from "@plannotator/shared/inbox/agent-faces";
import type { InboxAgentFacesWire, InboxAgentIcon } from "@plannotator/core/inbox-types";
import { INBOX_CROSS_SITE_BODY, isCrossSiteRequest } from "./inbox-cross-site";

export const INBOX_AGENT_FACES_PATH = "/api/inbox/agent-faces";

export function createInboxAgentFaces(options: {
  file: InboxAgentFacesFile;
  serverSession: string;
  readBody: (req: Request) => Promise<Record<string, unknown>>;
  json: (body: unknown, status?: number) => Response;
  /** The uploaded pictures ("Your own…", inbox-agent-icons.ts), carried with the faces. */
  icons?: () => InboxAgentIcon[];
}) {
  const { file, serverSession, json } = options;
  const answer = (wire: InboxAgentFacesWire) => json(options.icons ? { ...wire, icons: options.icons() } : wire);
  const route = async (req: Request, url: URL): Promise<Response | null> => {
    if (url.pathname !== INBOX_AGENT_FACES_PATH) return null;
    if (req.method === "GET") {
      if (isCrossSiteRequest(req)) return json(INBOX_CROSS_SITE_BODY, 403);
      return answer(file.wire());
    }
    if (req.method !== "POST") return json({ error: "Use GET or POST." }, 405);
    const body = await options.readBody(req);
    if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
    return answer(file.change(checkInboxAgentFaceChange(body)));
  };
  return { route };
}
