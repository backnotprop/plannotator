/**
 * Plannotator Inbox: the pictures a person uploads for their agents' icons ("Your own…" in the face picker; core
 * `inbox-types.ts`, "Agent faces"). Bun only: the Inbox runs on the Bun server; the Pi server serves no Inbox route.
 *
 *   inbox/agent-icons/<sha256>.<ext>          the picture as uploaded (PNG, JPEG, GIF, WebP or SVG, at most 512 KB)
 *   inbox/agent-icons/<sha256>.still.<ext>    its first frame, for one that moves (inbox-agent-icon-still.ts)
 *
 * Kept by content hash, so one picture is kept once however many agents show it, and an agent's face names it as
 * `own:<sha256>` in agent-faces.json. The same rules as a project's Set picture… (inbox-project-pictures.ts): the
 * type is sniffed from the bytes, the cap is the server's, and a picture is served from the Inbox's own origin with
 * nosniff, a sandbox policy, `attachment` for SVG and same-origin CORP. The window only ever draws one as an `<img>`
 * (never inlined), where an SVG runs no script and loads nothing.
 *
 *   GET  /api/inbox/agent-icons/<sha256>[?still=1]   the picture (`still=1`: its first frame, or itself when it does not move)
 *   POST /api/inbox/agent-icons  `{ picture: "data:image/…;base64,…" }`  keep it; `{ icon, faces, rev, icons }`
 *   POST /api/inbox/agent-icons  `{ remove: <sha256> }`  take it away (agents showing it go back to their own mark)
 *
 * This computer's windows and the owner's over the tailnet, as Set picture…: a tailnet guest's window draws each
 * agent's own mark. A change tells every window through `event: agent-faces` (the wire carries the pictures).
 */

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { INBOX_AGENT_ICONS_KEPT, type InboxAgentFacesWire, type InboxAgentIcon } from "@plannotator/core/inbox-types";
import { checkServerSession, INBOX_SERVER_SESSION_MISMATCH_ERROR, serverSessionMismatchBody } from "@plannotator/core/server-session";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxAgentFacesFile } from "@plannotator/shared/inbox/agent-faces";
import { sniffImageContentType } from "@plannotator/shared/review-image";
import { agentIconStill } from "./inbox-agent-icon-still";
import { isCrossSiteRequest, INBOX_CROSS_SITE_BODY } from "./inbox-cross-site";
import { PROJECT_PICTURE_MAX_BYTES } from "./inbox-project-pictures";

export const INBOX_AGENT_ICONS_PATH = "/api/inbox/agent-icons";
export const INBOX_AGENT_ICONS_DIR = "agent-icons";
/** The same cap as Set picture…, and its words. */
export const AGENT_ICON_MAX_BYTES = PROJECT_PICTURE_MAX_BYTES;
const TOO_BIG = "Picture: at most 512 KB.";
const NOT_IMAGE = "Picture: a PNG, JPEG, GIF, WebP or SVG image.";

/** The five Set picture… takes, and each one's file ending. */
const EXT: Readonly<Record<string, string>> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg" };
const TYPE_OF_EXT = Object.fromEntries(Object.entries(EXT).map(([type, ext]) => [ext, type])) as Readonly<Record<string, string>>;
const HASH = /^[0-9a-f]{64}$/;
const FILE = /^([0-9a-f]{64})\.(png|jpg|gif|webp|svg)$/;

export interface AgentIcons {
  /** The pictures, newest first. */
  list(): InboxAgentIcon[];
  /** Keep a picture (sniffed; at most 512 KB). The same bytes again are the same picture, made newest. */
  add(bytes: Uint8Array): { ok: true; icon: InboxAgentIcon } | { ok: false; reason: "not_image" | "too_big" | "not_saved" };
  /** Take one away (its still too); true when there was one. */
  remove(id: string): boolean;
  /** A picture's bytes and type, its still with `still` (itself when it does not move), or null. */
  read(id: string, still: boolean): { type: string; body: Uint8Array<ArrayBuffer> } | null;
  /** Past the cap, the oldest pictures no agent shows go (`shown`: the faces in use). */
  prune(shown: ReadonlySet<string>): void;
}

export function createAgentIcons(options: { dir: string; now?: () => number }): AgentIcons {
  const { dir } = options;
  const now = options.now ?? Date.now;
  let cache: InboxAgentIcon[] | null = null;
  const files = (): InboxAgentIcon[] => {
    if (cache) return cache;
    const out: InboxAgentIcon[] = [];
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      // No folder yet: no pictures.
    }
    for (const name of names) {
      const match = FILE.exec(name);
      if (!match) continue;
      try {
        out.push({ id: match[1]!, type: TYPE_OF_EXT[match[2]!]!, at: Math.round(statSync(join(dir, name)).mtimeMs) });
      } catch {
        // Gone while listed.
      }
    }
    return (cache = out.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id)));
  };
  const pathOf = (icon: InboxAgentIcon, still = false) => join(dir, `${icon.id}${still ? ".still" : ""}.${EXT[icon.type]}`);
  const bytesOf = (file: string): Uint8Array<ArrayBuffer> | null => {
    try {
      const bytes = readFileSync(file);
      return new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)) as Uint8Array<ArrayBuffer>;
    } catch {
      return null;
    }
  };

  return {
    list: () => files().slice(),
    add(bytes) {
      if (bytes.byteLength === 0) return { ok: false, reason: "not_image" };
      if (bytes.byteLength > AGENT_ICON_MAX_BYTES) return { ok: false, reason: "too_big" };
      const type = sniffImageContentType(bytes);
      if (!type || !EXT[type]) return { ok: false, reason: "not_image" };
      const id = createHash("sha256").update(bytes).digest("hex");
      const icon: InboxAgentIcon = { id, type, at: Math.max(now(), (files()[0]?.at ?? 0) + 1) };
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const file = pathOf(icon);
        if (files().some((kept) => kept.id === id)) {
          // Already kept: only made the newest.
          utimesSync(file, new Date(icon.at), new Date(icon.at));
        } else {
          writeFileSync(file, bytes, { mode: 0o600 });
          utimesSync(file, new Date(icon.at), new Date(icon.at));
          const still = agentIconStill(type, bytes);
          if (still) writeFileSync(pathOf(icon, true), still, { mode: 0o600 });
        }
      } catch {
        cache = null;
        return { ok: false, reason: "not_saved" };
      }
      cache = [icon, ...files().filter((kept) => kept.id !== id)];
      return { ok: true, icon };
    },
    remove(id) {
      if (!HASH.test(id)) return false;
      const icon = files().find((kept) => kept.id === id);
      if (!icon) return false;
      for (const file of [pathOf(icon), pathOf(icon, true)]) rmSync(file, { force: true });
      cache = files().filter((kept) => kept.id !== id);
      return true;
    },
    read(id, still) {
      if (!HASH.test(id)) return null;
      const icon = files().find((kept) => kept.id === id);
      if (!icon) return null;
      const body = (still ? bytesOf(pathOf(icon, true)) : null) ?? bytesOf(pathOf(icon));
      if (!body) {
        cache = null;
        return null;
      }
      return { type: icon.type, body };
    },
    prune(shown) {
      const all = files();
      if (all.length <= INBOX_AGENT_ICONS_KEPT) return;
      let over = all.length - INBOX_AGENT_ICONS_KEPT;
      for (const icon of [...all].reverse()) {
        if (over <= 0) break;
        if (shown.has(`own:${icon.id}`)) continue;
        this.remove(icon.id);
        over--;
      }
    },
  };
}

/** The headers a kept picture is served with (Set picture…'s): an SVG opened as a page runs nothing and downloads. */
export function agentIconHeaders(type: string): Record<string, string> {
  return {
    "content-type": type,
    // The address names the bytes (their hash): a picture never changes under it.
    "cache-control": "private, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'",
    ...(type === "image/svg+xml" ? { "content-disposition": "attachment" } : {}),
    "cross-origin-resource-policy": "same-origin",
  };
}

export function createInboxAgentIcons(options: {
  icons: AgentIcons;
  faces: InboxAgentFacesFile;
  serverSession: string;
  localOnly: () => Response;
  readBody: (req: Request) => Promise<Record<string, unknown>>;
  json: (body: unknown, status?: number) => Response;
}) {
  const { icons, faces, serverSession, json } = options;
  const withIcons = (wire: InboxAgentFacesWire): InboxAgentFacesWire => ({ ...wire, icons: icons.list() });
  /** `owner`: this computer's window, or the owner's over the tailnet (`ownerOrLocal`). */
  const route = async (req: Request, url: URL, owner: boolean): Promise<Response | null> => {
    const path = url.pathname;
    if (path !== INBOX_AGENT_ICONS_PATH && !path.startsWith(`${INBOX_AGENT_ICONS_PATH}/`)) return null;
    if (path !== INBOX_AGENT_ICONS_PATH) {
      if (req.method !== "GET" && req.method !== "HEAD") return json({ error: "Use GET." }, 405);
      if (isCrossSiteRequest(req)) return json(INBOX_CROSS_SITE_BODY, 403);
      if (!owner) return options.localOnly();
      const picture = icons.read(path.slice(INBOX_AGENT_ICONS_PATH.length + 1), url.searchParams.get("still") === "1");
      if (!picture) return json({ error: "No such picture.", code: "no_picture" }, 404);
      return new Response(req.method === "HEAD" ? null : picture.body, { headers: agentIconHeaders(picture.type) });
    }
    if (req.method !== "POST") return json({ error: "Use POST." }, 405);
    if (!owner) return options.localOnly();
    const body = await options.readBody(req);
    if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
    if (body.remove !== undefined) {
      if (typeof body.remove !== "string" || !HASH.test(body.remove)) throw new InboxError("validation_error", "remove: a picture's id.", { field: "remove" });
      const had = icons.remove(body.remove);
      const shownBefore = faces.wire().rev;
      const wire = faces.dropFace(`own:${body.remove}`);
      // No agent showed it: still one save, so every window's "Your own…" loses it.
      return json(withIcons(had && wire.rev === shownBefore ? faces.touch() : wire));
    }
    // Only the approved words reach the toast: too big (however long the data URL), or not one of the five.
    const given = typeof body.picture === "string" ? body.picture : "";
    if (given.length > 800_000) throw new InboxError("validation_error", TOO_BIG, { field: "picture" });
    const dataUrl = /^data:[a-z0-9.+/-]*;base64,([A-Za-z0-9+/=\s]+)$/i.exec(given);
    const saved = dataUrl ? icons.add(new Uint8Array(Buffer.from(dataUrl[1]!, "base64"))) : ({ ok: false, reason: "not_image" } as const);
    if (!saved.ok) {
      if (saved.reason === "not_saved") throw new InboxError("config_not_saved", "The picture did not change.");
      throw new InboxError("validation_error", saved.reason === "too_big" ? TOO_BIG : NOT_IMAGE, { field: "picture" });
    }
    icons.prune(faces.shown());
    return json({ icon: saved.icon, ...withIcons(faces.touch()) });
  };
  return { route, withIcons };
}
