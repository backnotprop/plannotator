/**
 * Plannotator Inbox: icon sets for agents' icons ("Sets" in the face picker; core `inbox-types.ts`, "Agent faces").
 * Bun only: the Inbox runs on the Bun server; the Pi server serves no Inbox route.
 *
 *   GET  /api/inbox/icon-sets[?remote=1]        { sets }: the built-in sets, then the fetchable ones (`remote=1`: the
 *                                                pointer is read too, the only time it is; the picker's Sets asks it)
 *   GET  /api/inbox/icon-sets/<set>             the set and its icons (InboxIconSetListing)
 *   GET  /api/inbox/icon-sets/<set>?credits=1   its credits file, as sandboxed plain text (game-icons.net's)
 *   GET  /api/inbox/icon-sets/<set>/<icon>      one icon, with the uploads' sandboxed image headers
 *   POST /api/inbox/icon-sets  `{ get: <set> }`  download a fetchable set into the data folder (resumes a stopped one)
 *
 * A face names an icon as `set:<set>/<icon>` in agent-faces.json; the window draws it from the icon's address, as an
 * `<img>` (pixel art, nearest-neighbour at whole multiples) or as a CSS mask in the text colour (one-colour sets), and
 * never as markup. Built-in sets are embedded in the binary (inbox-icon-sets-content.ts) and served to any window of
 * this Inbox; a fetched set, the pointer and a download are this computer's windows' and the owner's over the tailnet.
 */

import { checkServerSession, INBOX_SERVER_SESSION_MISMATCH_ERROR, serverSessionMismatchBody } from "@plannotator/core/server-session";
import type { InboxIconSet, InboxIconSetIcon, InboxIconSetListing } from "@plannotator/core/inbox-types";
import { InboxError } from "@plannotator/shared/inbox/schema";
import { agentIconHeaders } from "./inbox-agent-icons";
import { BUILT_IN_ICON_SET_FILES, type BuiltInIconSetFiles } from "./inbox-icon-sets-content";
import type { IconSetFetcher } from "./inbox-icon-set-fetch";
import { INBOX_CROSS_SITE_BODY, isCrossSiteRequest } from "./inbox-cross-site";

export const INBOX_ICON_SETS_PATH = "/api/inbox/icon-sets";

interface BuiltInManifest {
  v: 1;
  id: string;
  name: string;
  credit?: string;
  licence?: { spdx?: string };
  pixelated?: boolean;
  size?: number;
  mono?: boolean;
  type: string;
  count: number;
  icons: (InboxIconSetIcon & { at: number; len: number; by?: string })[];
}

export interface BuiltInIconSets {
  ids: ReadonlySet<string>;
  list(): Promise<InboxIconSet[]>;
  listing(id: string): Promise<InboxIconSetListing | null>;
  read(id: string, icon: string): Promise<{ type: string; body: ArrayBuffer } | null>;
  credits(id: string): Promise<string | null>;
}

/** The embedded sets (or, for tests, any files of the same shape). Each manifest is read once, when first asked. */
export function createBuiltInIconSets(files: Readonly<Record<string, BuiltInIconSetFiles>> = BUILT_IN_ICON_SET_FILES): BuiltInIconSets {
  const manifests = new Map<string, Promise<{ manifest: BuiltInManifest; byId: Map<string, BuiltInManifest["icons"][number]> } | null>>();
  const load = (id: string) => {
    if (!Object.hasOwn(files, id)) return Promise.resolve(null);
    let known = manifests.get(id);
    if (!known) {
      known = (async () => {
        try {
          const manifest = (await Bun.file(files[id]!.manifest).json()) as BuiltInManifest;
          return { manifest, byId: new Map(manifest.icons.map((icon) => [icon.id, icon])) };
        } catch {
          return null;
        }
      })();
      manifests.set(id, known);
    }
    return known;
  };
  const summary = (m: BuiltInManifest, id: string): InboxIconSet => ({
    id,
    name: m.name,
    count: m.count,
    kind: "built-in",
    ...(m.pixelated ? { pixelated: true } : {}),
    ...(m.size ? { size: m.size } : {}),
    ...(m.mono ? { mono: true } : {}),
    ...(m.credit ? { credit: m.credit } : {}),
    ...(files[id]?.credits ? { credits: true } : {}),
    ...(m.licence?.spdx ? { licence: m.licence.spdx } : {}),
  });
  return {
    ids: new Set(Object.keys(files)),
    async list() {
      const out: InboxIconSet[] = [];
      for (const id of Object.keys(files)) {
        const loaded = await load(id);
        if (loaded) out.push(summary(loaded.manifest, id));
      }
      return out;
    },
    async listing(id) {
      const loaded = await load(id);
      if (!loaded) return null;
      return { ...summary(loaded.manifest, id), icons: loaded.manifest.icons.map(({ id: icon, n, name, words }) => ({ id: icon, n, name, ...(words ? { words } : {}) })) };
    },
    async read(id, icon) {
      const loaded = await load(id);
      const entry = loaded?.byId.get(icon);
      if (!loaded || !entry) return null;
      try {
        const body = await Bun.file(files[id]!.icons).slice(entry.at, entry.at + entry.len).arrayBuffer();
        return body.byteLength === entry.len ? { type: loaded.manifest.type, body } : null;
      } catch {
        return null;
      }
    },
    async credits(id) {
      const file = Object.hasOwn(files, id) ? files[id]!.credits : undefined;
      if (!file) return null;
      try {
        return await Bun.file(file).text();
      } catch {
        return null;
      }
    },
  };
}

export function createInboxIconSets(options: {
  builtIn: BuiltInIconSets;
  fetcher: IconSetFetcher;
  serverSession: string;
  readBody: (req: Request) => Promise<Record<string, unknown>>;
  json: (body: unknown, status?: number) => Response;
}) {
  const { builtIn, fetcher, serverSession, json } = options;
  const notFound = () => json({ error: "No such icon.", code: "no_icon" }, 404);
  const route = async (req: Request, url: URL): Promise<Response | null> => {
    const path = url.pathname;
    if (path !== INBOX_ICON_SETS_PATH && !path.startsWith(`${INBOX_ICON_SETS_PATH}/`)) return null;
    if (req.method === "POST" && path === INBOX_ICON_SETS_PATH) {
      const body = await options.readBody(req);
      if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
      if (typeof body.get !== "string") throw new InboxError("validation_error", "get: a set's id.", { field: "get" });
      const set = await fetcher.get(body.get);
      if (!set) return json({ error: "No such set.", code: "no_set" }, 404);
      return json({ set });
    }
    if (req.method !== "GET" && req.method !== "HEAD") return json({ error: "Use GET or POST." }, 405);
    if (isCrossSiteRequest(req)) return json(INBOX_CROSS_SITE_BODY, 403);
    const rest = path.slice(INBOX_ICON_SETS_PATH.length + 1);
    if (path === INBOX_ICON_SETS_PATH) {
      const fetched = await fetcher.list(url.searchParams.get("remote") === "1");
      return json({ sets: [...(await builtIn.list()), ...fetched] });
    }
    const [set = "", icon, extra] = rest.split("/");
    if (extra !== undefined) return notFound();
    const isBuiltIn = builtIn.ids.has(set);
    if (icon === undefined) {
      if (url.searchParams.get("credits") === "1") {
        const credits = isBuiltIn ? await builtIn.credits(set) : null;
        if (credits === null) return json({ error: "No credits for this set.", code: "no_credits" }, 404);
        return new Response(req.method === "HEAD" ? null : credits, {
          headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff", "content-security-policy": "sandbox; default-src 'none'", "cross-origin-resource-policy": "same-origin", "cache-control": "private, no-cache" },
        });
      }
      const listing = isBuiltIn ? await builtIn.listing(set) : fetcher.listing(set);
      return listing ? json(listing) : json({ error: "No such set.", code: "no_set" }, 404);
    }
    const picture = isBuiltIn ? await builtIn.read(set, icon) : fetcher.read(set, icon);
    if (!picture) return notFound();
    // A built-in set can change with a release under the same address: a day, not forever.
    const headers = { ...agentIconHeaders(picture.type), "cache-control": "private, max-age=86400" };
    return new Response(req.method === "HEAD" ? null : picture.body, { headers });
  };
  return { route };
}
