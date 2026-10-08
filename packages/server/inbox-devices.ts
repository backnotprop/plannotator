/**
 * Plannotator Inbox: phones (adr/implementation/inbox-mobile.md, sections 1,
 * 2 and 6). Mounted by packages/server/inbox.ts: the door at the top of its
 * `fetch`, the window routes at the end of its route table.
 *
 * Pairing. `POST /api/inbox/pairing` (a window route behind the window's
 * guards) opens one offer: a 256-bit secret for the QR link and six digits
 * for typing. One offer is open at a time, kept in memory only. It closes
 * when redeemed, when the window makes another, after 10 minutes, or after 5
 * wrong codes: the two limits pairing cannot work without.
 *
 * The door. Every phone request is `/api/inbox/device/<route>`: no Origin, a
 * bearer token whose SHA-256 names a device that is not revoked, a route on
 * the allowlist below, and, for a POST, an `idempotency_key`. The request is
 * then handed to the window's own handler under the window's path, through
 * the server's own `fetch` on loopback; the door adds and strips nothing. A
 * POST's answer is kept per device and key (inbox/device-commands.jsonl), so
 * a retry over another path answers the same without writing again.
 *
 * The tailnet. "Reach from my tailnet" publishes the loopback port at
 * `https://<MagicDNS name>:8443` through `tailscale serve` (never funnel),
 * kept in inbox.json as `tailnet: { https_port }` and re-pointed at the
 * current port at each start. A request under that name reaches the door and
 * nothing else.
 */

import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { spawnSync } from "node:child_process";
import { hostname } from "node:os";
import { join } from "node:path";
import { checkInboxThreadName, inboxId } from "@plannotator/core/inbox-types";
import { checkServerSession, INBOX_SERVER_SESSION_MISMATCH_ERROR, serverSessionMismatchBody } from "@plannotator/core/server-session";
import {
  INBOX_DEVICE_COMMANDS_FILE,
  InboxDevices,
  JsonLines,
  publicDevice,
  type InboxDevice,
} from "@plannotator/shared/inbox/devices";
import { readInboxRegistry, writeInboxRegistry, type InboxRegistryEntry } from "@plannotator/shared/inbox/registry";
import { InboxError, inboxDir } from "@plannotator/shared/inbox/schema";
import { runTailscale, serveStatusProxy, TAILSCALE_SERVE_TIMEOUT_MS, type TailscaleRunner } from "@plannotator/shared/tailscale";
import { isServedHostHeader } from "./request-host-guard";
import { enableTailscaleServe, removeTailscaleServe, TailscaleServeError } from "./tailscale-serve";

/** The pairing offer's lifetime (limit, contract section 1): long enough to fetch a phone. */
export const PAIRING_OFFER_MS = 10 * 60_000;
/** Wrong six-digit codes before the offer closes (limit, contract section 1). */
export const PAIRING_CODE_TRIES = 5;
/** The tailnet HTTPS port (contract section 1, ruling 8). */
export const INBOX_TAILNET_HTTPS_PORT = 8443;

export const DOOR_PREFIX = "/api/inbox/device/";

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...extra } });
}

function refuse(status: number, code: string, error: string, details: Record<string, unknown> = {}): Response {
  return json({ error, code, ...details }, status);
}

/**
 * The allowlist (contract section 2): door route to the window's route. A
 * door path outside it is `404 device_route_not_found`; the window, `/mcp`,
 * the bridge, control, settings, restart, raw attachment bytes, project
 * deletion, decision retire and replace, pairing and the device list are
 * never on it.
 */
const ALLOWLIST: readonly { method: "GET" | "POST"; route: RegExp; window: (m: RegExpExecArray) => string }[] = [
  { method: "GET", route: /^health$/, window: () => "/api/inbox/health" },
  { method: "GET", route: /^threads$/, window: () => "/api/inbox/threads" },
  { method: "GET", route: /^projects$/, window: () => "/api/inbox/projects" },
  { method: "GET", route: /^threads\/([^/]+)$/, window: (m) => `/api/inbox/threads/${m[1]}` },
  { method: "POST", route: /^threads\/([^/]+)\/seen$/, window: (m) => `/api/inbox/threads/${m[1]}/seen` },
  { method: "GET", route: /^events$/, window: () => "/api/inbox/events" },
  { method: "POST", route: /^messages\/([^/]+)\/(picks|reply|resolve)$/, window: (m) => `/api/inbox/messages/${m[1]}/${m[2]}` },
  { method: "POST", route: /^threads\/([^/]+)\/delete$/, window: (m) => `/api/inbox/threads/${m[1]}/delete` },
  { method: "GET", route: /^threads\/([^/]+)\/attachments$/, window: (m) => `/api/inbox/threads/${m[1]}/attachments` },
  { method: "GET", route: /^attachments\/([^/]+)\/view$/, window: (m) => `/api/inbox/attachments/${m[1]}/view` },
  { method: "GET", route: /^html-assets\/([^/]+)\/(.+)$/, window: (m) => `/api/html-assets/${m[1]}/${m[2]}` },
  { method: "POST", route: /^annotations$/, window: () => "/api/inbox/annotations" },
  { method: "POST", route: /^annotations\/([^/]+)\/remove$/, window: (m) => `/api/inbox/annotations/${m[1]}/remove` },
  { method: "GET", route: /^messages\/([^/]+)\/guide$/, window: (m) => `/api/inbox/messages/${m[1]}/guide` },
  { method: "POST", route: /^messages\/([^/]+)\/guide\/reviewed$/, window: (m) => `/api/inbox/messages/${m[1]}/guide/reviewed` },
  { method: "POST", route: /^messages\/([^/]+)\/decision$/, window: (m) => `/api/inbox/messages/${m[1]}/decision` },
  { method: "GET", route: /^decisions$/, window: () => "/api/inbox/decisions" },
  { method: "GET", route: /^threads\/([^/]+)\/sessions$/, window: (m) => `/api/inbox/threads/${m[1]}/sessions` },
  { method: "POST", route: /^threads\/([^/]+)\/message$/, window: (m) => `/api/inbox/threads/${m[1]}/message` },
];

interface Offer {
  secret: string;
  code: string;
  expiresAt: number;
  wrong: number;
}

interface CommandLine {
  v: 1;
  at: string;
  device_id: string;
  key: string;
  method: string;
  path: string;
  status: number;
  body: unknown;
}

export interface TailnetState {
  /** The person's switch, as inbox.json keeps it. */
  on: boolean;
  /** `host:port` the phone reaches, while the publication works. */
  address: string | null;
  /** Why the publication is not working, in the window's words. */
  error: string | null;
}

export interface InboxDevicesContext {
  dataDir: string;
  serverSession: string;
  /** This run's loopback port. */
  port: () => number;
  /** The port the last run had, whose serve mapping is this Inbox's own. */
  previousPort: number | null;
  registry: () => InboxRegistryEntry;
  readBody: (req: Request) => Promise<Record<string, unknown>>;
  /** The server's own `fetch`: the door hands each allowed request to it on loopback. */
  dispatch: (req: Request) => Promise<Response>;
  now?: () => Date;
  tailscale?: TailscaleRunner;
}

/** The computer's name as the phone shows it: macOS's ComputerName, else the host name's first label. */
function computerName(): string {
  if (process.platform === "darwin") {
    try {
      const out = spawnSync("scutil", ["--get", "ComputerName"], { encoding: "utf8", timeout: 2000 });
      const name = out.status === 0 ? out.stdout.trim() : "";
      if (name) return name;
    } catch {
      // Fall through.
    }
  }
  return hostname().split(".")[0] || "Computer";
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function bearer(req: Request): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec((req.headers.get("authorization") ?? "").trim());
  return match ? match[1]! : null;
}

export function createInboxDevices(context: InboxDevicesContext) {
  const now = () => (context.now ? context.now() : new Date());
  const tailscale = context.tailscale ?? runTailscale;
  const devices = InboxDevices.open(context.dataDir);
  const commandLog = new JsonLines<CommandLine>(join(inboxDir(context.dataDir), INBOX_DEVICE_COMMANDS_FILE));
  const commands = new Map<string, CommandLine>();
  for (const line of commandLog.read()) {
    if (line.v === 1 && typeof line.device_id === "string" && typeof line.key === "string") commands.set(`${line.device_id}\n${line.key}`, line);
  }
  const inFlight = new Map<string, Promise<unknown>>();
  /** Each device's open event streams, closed when it is removed. */
  const streams = new Map<string, Set<AbortController>>();
  let offer: Offer | null = null;
  let name: string | null = null;
  const tailnet: TailnetState = { on: false, address: null, error: null };

  const computer = () => ({ name: (name ??= computerName()) });
  const addresses = () => ({ tailnet: tailnet.address, lan: null, fingerprint: null });

  const openOffer = (): Offer | null => {
    if (offer && offer.expiresAt <= now().getTime()) offer = null;
    return offer;
  };

  const revoke = (device: InboxDevice): InboxDevice => {
    const revoked = devices.revoke(device.id, now().toISOString()) ?? device;
    for (const stream of streams.get(device.id) ?? []) stream.abort();
    streams.delete(device.id);
    return revoked;
  };

  // ── Pairing (contract section 1) ──

  const makeOffer = () => {
    const secret = randomBytes(32).toString("base64url");
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const expiresAt = now().getTime() + PAIRING_OFFER_MS;
    offer = { secret, code, expiresAt, wrong: 0 };
    const params = [`v=1`, `name=${encodeURIComponent(computer().name)}`];
    if (tailnet.address) params.push(`tailnet=${encodeURIComponent(tailnet.address)}`);
    params.push(`secret=${secret}`, `code=${code}`);
    return {
      offer: { code, expires_at: new Date(expiresAt).toISOString() },
      link: `plannotator://pair?${params.join("&")}`,
      computer: computer(),
      addresses: addresses(),
    };
  };

  const redeem = async (req: Request): Promise<Response> => {
    const body = await context.readBody(req);
    const byName = checkInboxThreadName(body.name);
    if (!byName.ok) throw new InboxError("validation_error", `name: ${byName.message}`, { field: "name" });
    const platform = checkInboxThreadName(body.platform);
    if (!platform.ok) throw new InboxError("validation_error", `platform: ${platform.message}`, { field: "platform" });
    const secret = typeof body.secret === "string" && body.secret ? body.secret : null;
    const code = typeof body.code === "string" && body.code ? body.code : null;
    if (!secret && !code) throw new InboxError("validation_error", "secret or code: one is required.", { field: "secret" });
    const open = openOffer();
    const expired = () => refuse(410, "offer_expired", "This pairing code is no longer open. Make a new one on your computer.");
    if (!open) return expired();
    if (secret ? !sameSecret(secret, open.secret) : code !== open.code) {
      if (secret) return expired();
      open.wrong += 1;
      const triesLeft = Math.max(PAIRING_CODE_TRIES - open.wrong, 0);
      if (triesLeft === 0) offer = null;
      return refuse(401, "pairing_code_wrong", "That code is not the one on your computer.", { tries_left: triesLeft });
    }
    offer = null;
    const token = `tok_${randomBytes(32).toString("base64url")}`;
    const device = devices.add({ id: inboxId("dev"), name: byName.name, platform: platform.name, token, secret: open.secret, at: now().toISOString() });
    // The relay (section 4) arrives with R1; until then a phone reaches the Inbox directly.
    return json({ device: publicDevice(device), token, secret: open.secret, computer: computer(), addresses: addresses(), relay: null }, 201);
  };

  // ── The door (contract section 2) ──

  /** Hand one allowed request to the window's handler, on loopback, as the window would send it. */
  const toWindow = (req: Request, windowPath: string, search: string, body: string | null, signal: AbortSignal): Promise<Response> => {
    const headers = new Headers({ Accept: "application/json" });
    if (body !== null) headers.set("Content-Type", "application/json");
    const lastEventId = req.headers.get("last-event-id");
    if (lastEventId) headers.set("Last-Event-ID", lastEventId);
    return context.dispatch(new Request(`http://127.0.0.1:${context.port()}${windowPath}${search}`, { method: req.method, headers, body, signal }));
  };

  /** A POST through the door: answered once per device and key, then replayed. */
  const command = async (req: Request, device: InboxDevice, doorPath: string, windowPath: string): Promise<Response> => {
    let text: string;
    let body: unknown;
    try {
      text = await req.text();
      body = JSON.parse(text);
    } catch {
      throw new InboxError("validation_error", "body: expected a JSON object.");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new InboxError("validation_error", "body: expected a JSON object.");
    const key = (body as Record<string, unknown>).idempotency_key;
    if (typeof key !== "string" || !key.trim()) {
      throw new InboxError("validation_error", "idempotency_key: required on a phone's command.", { field: "idempotency_key" });
    }
    const slot = `${device.id}\n${key}`;
    await inFlight.get(slot);
    const seen = commands.get(slot);
    if (seen) {
      if (seen.method !== req.method || seen.path !== doorPath) {
        return refuse(409, "idempotency_key_reused", "This idempotency_key was already used on another route.", { field: "idempotency_key" });
      }
      return json(seen.body, seen.status, { "Idempotent-Replayed": "true" });
    }
    const run = (async () => {
      const response = await toWindow(req, windowPath, "", text, req.signal);
      const answer = await response.text();
      if (response.status < 500) {
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(answer);
        } catch {
          parsed = answer;
        }
        const line: CommandLine = { v: 1, at: now().toISOString(), device_id: device.id, key, method: req.method, path: doorPath, status: response.status, body: parsed };
        commandLog.append(line);
        commands.set(slot, line);
      }
      return new Response(answer, { status: response.status, headers: response.headers });
    })();
    inFlight.set(slot, run.catch(() => {}));
    try {
      return await run;
    } finally {
      inFlight.delete(slot);
    }
  };

  const door = async (req: Request, url: URL): Promise<Response> => {
    try {
      if (req.headers.get("origin") !== null) return refuse(403, "origin_not_allowed", "Browser requests are not accepted here.");
      const route = url.pathname.startsWith(DOOR_PREFIX) ? url.pathname.slice(DOOR_PREFIX.length) : "";
      if (route === "pair" && req.method === "POST") return await redeem(req);
      const token = bearer(req);
      if (!token) return refuse(401, "device_token_missing", "This request needs the phone's token.");
      const device = devices.byToken(token);
      if (!device) return refuse(401, "device_token_invalid", "This token does not belong to a paired phone.");
      if (device.revoked_at !== null) return refuse(401, "device_revoked", "This phone was removed from the Inbox. Pair it again.");
      devices.touch(device.id, now().toISOString());
      if (route === "revoke" && req.method === "POST") return json({ device: publicDevice(revoke(device)) });
      for (const entry of ALLOWLIST) {
        if (entry.method !== req.method) continue;
        const match = entry.route.exec(route);
        if (!match) continue;
        const windowPath = entry.window(match);
        if (req.method === "POST") return await command(req, device, url.pathname, windowPath);
        if (route !== "events") return await toWindow(req, windowPath, url.search, null, req.signal);
        // The event stream lives until the phone leaves or is removed.
        const stream = new AbortController();
        req.signal.addEventListener("abort", () => stream.abort());
        const open = streams.get(device.id) ?? new Set();
        open.add(stream);
        streams.set(device.id, open);
        stream.signal.addEventListener("abort", () => open.delete(stream));
        return await toWindow(req, windowPath, url.search, null, stream.signal);
      }
      return refuse(404, "device_route_not_found", "Not a phone route.");
    } catch (error) {
      if (error instanceof InboxError) return json({ error: error.message, code: error.code, ...error.details }, error.code === "validation_error" ? 422 : 400);
      return refuse(500, "internal_error", "Internal error.");
    }
  };

  // ── The tailnet (contract section 1) ──

  const ownTargets = () => [context.port(), context.previousPort].filter((p): p is number => !!p).map((p) => `http://127.0.0.1:${p}`);

  const saveSwitch = (on: boolean) => {
    const entry = { ...(readInboxRegistry(context.dataDir) ?? context.registry()) };
    if (on) entry.tailnet = { https_port: INBOX_TAILNET_HTTPS_PORT };
    else delete entry.tailnet;
    writeInboxRegistry(context.dataDir, entry);
    const live = context.registry();
    if (on) live.tailnet = entry.tailnet;
    else delete live.tailnet;
  };

  const tailnetWords = (error: unknown): { code: string; message: string } => {
    if (error instanceof TailscaleServeError && error.code === "conflict") {
      return {
        code: "tailnet_port_taken",
        message: `Another tailscale serve mapping already uses port ${INBOX_TAILNET_HTTPS_PORT}. The Inbox never replaces it: remove it with "tailscale serve --https=${INBOX_TAILNET_HTTPS_PORT} off" if nothing needs it.`,
      };
    }
    const detail = error instanceof Error ? error.message.replace(/^--tailscale:\s*/, "") : String(error);
    return { code: "tailnet_unavailable", message: `Tailscale could not publish the Inbox. ${detail}` };
  };

  /** Publish (or re-point) the tailnet address; the error stays on the state for the window. */
  const publish = (): { ok: true } | { ok: false; code: string; message: string } => {
    try {
      const { url } = enableTailscaleServe(context.port(), tailscale, { httpsPort: INBOX_TAILNET_HTTPS_PORT, ownTargets: ownTargets(), persist: true });
      const served = new URL(url);
      tailnet.address = `${served.hostname}:${served.port || "443"}`;
      tailnet.error = null;
      return { ok: true };
    } catch (error) {
      const words = tailnetWords(error);
      tailnet.address = null;
      tailnet.error = words.message;
      return { ok: false, ...words };
    }
  };

  /** At start: the switch was on, so point the mapping at this run's port. */
  const startTailnet = () => {
    if (!context.registry().tailnet) return;
    tailnet.on = true;
    publish();
  };

  const setTailnet = (on: boolean): Response => {
    if (on) {
      const result = publish();
      if (!result.ok) return refuse(409, result.code, result.message);
      tailnet.on = true;
      saveSwitch(true);
      return json({ tailnet });
    }
    // Off: take down only a mapping that is this Inbox's own.
    const status = tailscale(["serve", "status", "--json"], TAILSCALE_SERVE_TIMEOUT_MS);
    const existing = !status.error && status.status === 0 ? serveStatusProxy(status.stdout, INBOX_TAILNET_HTTPS_PORT) : null;
    if (existing?.state === "mapped" && ownTargets().includes(existing.proxy)) removeTailscaleServe(INBOX_TAILNET_HTTPS_PORT, tailscale);
    tailnet.on = false;
    tailnet.address = null;
    tailnet.error = null;
    saveSwitch(false);
    return json({ tailnet });
  };

  // ── The window's routes ──

  const staleTab = (body: Record<string, unknown>) =>
    checkServerSession(body, context.serverSession) === "mismatch" ? json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409) : null;

  const windowRoute = async (req: Request, url: URL): Promise<Response | null> => {
    const path = url.pathname;
    if (path === "/api/inbox/pairing") {
      if (req.method !== "POST") return json({ error: "Use POST." }, 405);
      const stale = staleTab(await context.readBody(req));
      return stale ?? json(makeOffer(), 201);
    }
    if (path === "/api/inbox/devices") {
      if (req.method !== "GET") return json({ error: "Use GET." }, 405);
      return json({ devices: devices.list().map(publicDevice) });
    }
    const revokeMatch = /^\/api\/inbox\/devices\/([A-Za-z0-9_]+)\/revoke$/.exec(path);
    if (revokeMatch) {
      if (req.method !== "POST") return json({ error: "Use POST." }, 405);
      const stale = staleTab(await context.readBody(req));
      if (stale) return stale;
      const device = devices.get(revokeMatch[1]!);
      if (!device) return refuse(404, "device_not_found", "No such phone.");
      return json({ device: publicDevice(revoke(device)) });
    }
    if (path === "/api/inbox/tailnet") {
      if (req.method === "GET") return json({ tailnet });
      if (req.method !== "POST") return json({ error: "Use GET or POST." }, 405);
      const body = await context.readBody(req);
      const stale = staleTab(body);
      if (stale) return stale;
      if (typeof body.on !== "boolean") throw new InboxError("validation_error", "on: must be a boolean.", { field: "on" });
      return setTailnet(body.on);
    }
    return null;
  };

  /**
   * A request under the tailnet name reaches the door and nothing else
   * (contract section 2, "Where the door answers").
   */
  const servedHostRefusal = (req: Request, path: string): Response | null => {
    if (!isServedHostHeader(req.headers.get("host"))) return null;
    if (path === "/api/inbox/device" || path.startsWith(DOOR_PREFIX)) return null;
    return refuse(403, "forbidden_host", "Only the phone routes answer on this address.");
  };

  return { door, windowRoute, servedHostRefusal, startTailnet, devices };
}
