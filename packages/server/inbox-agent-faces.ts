/** The face each agent's icon shows, for every window. Bun only: the Inbox runs on the Bun server. */

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
