import { checkServerSession, INBOX_SERVER_SESSION_MISMATCH_ERROR, serverSessionMismatchBody } from "@plannotator/core/server-session";
import type { InboxForgejoCheckVerdict, InboxForgejoHostsState } from "@plannotator/core/inbox-types";
import { loadConfig, normalizeForgejoOrigin, resolveForgejoToken, saveConfig } from "@plannotator/shared/config";
import { InboxError } from "@plannotator/shared/inbox/schema";

export interface ForgejoHosts {
  state(): InboxForgejoHostsState;
  route(req: Request, path: string, via: string): Promise<Response | null>;
}

const ROUTE = "/api/inbox/forgejo/hosts";
const TOKEN = /^[\x21-\x7e]{8,512}$/;

/** `https://git.example.com` as the person typed it (a bare `git.example.com` is https), or null. */
function originOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return normalizeForgejoOrigin(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
}

const hostOf = (origin: string) => new URL(origin).host;

/**
 * Settings → Accounts → Forgejo and Gitea. The hosts and tokens live where `plannotator review`, the pages and the Pi
 * extension already read them: `forgejoHosts` and `forgejoTokens` in config.json. Nothing here answers with a token.
 */
export function createForgejoHosts(options: {
  serverSession: string;
  json: (body: unknown, status?: number) => Response;
  readBody: (req: Request) => Promise<Record<string, unknown>>;
  env?: Record<string, string | undefined>;
  changed?: () => void;
  fetch?: typeof fetch;
}): ForgejoHosts {
  const { json } = options;
  const env = options.env ?? process.env;
  const doFetch = options.fetch ?? fetch;
  const envOrigin = () => normalizeForgejoOrigin(env.PLANNOTATOR_FORGEJO_URL ?? "");

  const state = (): InboxForgejoHostsState => {
    const config = loadConfig({ quiet: true });
    const saved = new Map<string, string | null>();
    const tokens = config.forgejoTokens && typeof config.forgejoTokens === "object" && !Array.isArray(config.forgejoTokens) ? config.forgejoTokens : {};
    for (const [key, value] of Object.entries(tokens)) {
      const origin = normalizeForgejoOrigin(key);
      if (origin) saved.set(origin, typeof value === "string" && value.trim() ? value.trim() : null);
    }
    for (const name of Array.isArray(config.forgejoHosts) ? config.forgejoHosts : []) {
      const origin = originOf(name);
      if (origin && ![...saved.keys()].some((have) => hostOf(have) === hostOf(origin))) saved.set(origin, null);
    }
    const fromEnv = envOrigin();
    const hosts: InboxForgejoHostsState["hosts"] = [];
    for (const [origin, token] of saved) {
      const viaEnv = origin === fromEnv && !!env.PLANNOTATOR_FORGEJO_TOKEN?.trim();
      hosts.push({ origin, hostSource: "saved", token: token ? { source: "saved", last4: token.slice(-4) } : { source: viaEnv ? "env" : null, last4: null } });
    }
    if (fromEnv && !saved.has(fromEnv)) hosts.push({ origin: fromEnv, hostSource: "env", token: { source: env.PLANNOTATOR_FORGEJO_TOKEN?.trim() ? "env" : null, last4: null } });
    return { hosts };
  };

  const write = (origin: string, token: string | null | undefined, remove: boolean) => {
    const config = loadConfig({ quiet: true });
    const tokens: Record<string, string> = {};
    for (const [key, value] of Object.entries(config.forgejoTokens ?? {})) if (typeof value === "string" && normalizeForgejoOrigin(key) !== origin) tokens[key] = value;
    const names = (Array.isArray(config.forgejoHosts) ? config.forgejoHosts : []).filter((name) => typeof name === "string" && originOf(name) && hostOf(originOf(name)!) !== hostOf(origin));
    if (!remove) {
      names.push(hostOf(origin));
      const kept = token ?? Object.entries(config.forgejoTokens ?? {}).find(([key]) => normalizeForgejoOrigin(key) === origin)?.[1];
      if (kept) tokens[origin] = kept;
    }
    if (!saveConfig({ forgejoHosts: names, forgejoTokens: tokens })) throw new InboxError("validation_error", "config.json could not be saved. Fix or remove it and try again.", {});
  };

  const check = async (origin: string): Promise<InboxForgejoCheckVerdict> => {
    const token = resolveForgejoToken(loadConfig({ quiet: true }), origin, env);
    try {
      const response = await doFetch(`${origin}/api/v1/user`, { redirect: "manual", signal: AbortSignal.timeout(8000), headers: token ? { authorization: `token ${token}` } : {} });
      if (response.ok) return "accepted";
      return response.status === 401 || response.status === 403 ? "refused" : "unreachable";
    } catch {
      return "unreachable";
    }
  };

  return {
    state,
    async route(req, path, via) {
      if (path !== ROUTE) return null;
      if (req.method !== "POST") return json({ error: "Use POST." }, 405);
      const body = await options.readBody(req);
      if (checkServerSession(body, options.serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
      const origin = originOf(body.origin);
      if (!origin) throw new InboxError("validation_error", "origin: that doesn't look like an address, such as https://git.example.com.", { field: "origin" });
      const token = typeof body.token === "string" ? body.token.trim() : null;
      if (token !== null && via !== "local" && req.headers.get("x-forwarded-proto") !== "https") {
        return json({ error: "A token is accepted only over HTTPS.", code: "https_required" }, 403);
      }
      if (body.op === "check") {
        // Only a host the person has added: this never makes a request to an address a page names on its own.
        if (!state().hosts.some((host) => host.origin === origin)) throw new InboxError("validation_error", "origin: add the host first.", { field: "origin" });
        return json({ verdict: await check(origin) });
      }
      if (body.op === "remove") write(origin, null, true);
      else if (body.op === "save") {
        if (token !== null && !TOKEN.test(token)) throw new InboxError("validation_error", "token: that doesn't look like a Forgejo token.", { field: "token" });
        write(origin, token, false);
      } else throw new InboxError("validation_error", "op: use save, remove or check.", { field: "op" });
      options.changed?.();
      return json(state());
    },
  };
}
