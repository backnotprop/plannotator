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
 * a retry over another path answers the same without writing again. A
 * command up through the relay enters at `asDevice`, in-process, past the
 * bearer check: the up key that opened it names the device.
 *
 * The tailnet. "Reach from my tailnet" opens a second loopback listener that
 * serves the door and nothing else, and publishes THAT port at
 * `https://<MagicDNS name>:8443` through `tailscale serve` (never funnel).
 * `tailscale serve` passes the client's Host header through, so the socket,
 * not a header, keeps tailnet requests on the door. Kept in inbox.json as
 * `tailnet: { https_port, door_port }`; published at each start, taken down
 * (listener and mapping) when the switch goes off and at each clean stop.
 *
 * The Wi-Fi. "Reach from this Wi-Fi" opens a TLS listener on every interface
 * that serves the same door-only handler, with a pinned self-signed
 * certificate and a Bonjour record (inbox-lan.ts, contract section 3).
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
import { createInboxLan, LanUnavailableError } from "./inbox-lan";
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
  registry: () => InboxRegistryEntry;
  readBody: (req: Request) => Promise<Record<string, unknown>>;
  /** The server's own `fetch`: the door hands each allowed request to it on loopback. */
  dispatch: (req: Request) => Promise<Response>;
  now?: () => Date;
  tailscale?: TailscaleRunner;
  /** The relay (packages/server/inbox-relay.ts): told of each pairing, whose answer carries the mailbox, and of each removal. */
  relay?: {
    paired: (device: InboxDevice) => Promise<{ url: string; mailbox_id: string } | null>;
    revoked: (device: InboxDevice) => void;
  };
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

/**
 * Take down the mapping on 8443 when it points at one of `targets` (this
 * Inbox's door listeners). "none" when there is no such mapping, "failed"
 * when Tailscale could not say or could not remove it.
 */
function takeDownOwnMapping(run: TailscaleRunner, targets: readonly string[]): "removed" | "none" | "failed" {
  const status = run(["serve", "status", "--json"], TAILSCALE_SERVE_TIMEOUT_MS);
  if (status.error || status.status !== 0) return "failed";
  const existing = serveStatusProxy(status.stdout, INBOX_TAILNET_HTTPS_PORT);
  if (existing.state === "malformed") return "failed";
  if (existing.state !== "mapped" || !targets.includes(existing.proxy)) return "none";
  return removeTailscaleServe(INBOX_TAILNET_HTTPS_PORT, run) ? "removed" : "failed";
}

/**
 * `uninstall --purge` with the Inbox stopped: take down the tailnet mapping
 * the last run left, by the door_port inbox.json kept. Nothing is spawned when
 * the switch was never on.
 */
export function takeDownInboxTailnet(dataDir: string, run: TailscaleRunner = runTailscale): "removed" | "none" | "failed" {
  const door = readInboxRegistry(dataDir)?.tailnet?.door_port;
  return door ? takeDownOwnMapping(run, [`http://127.0.0.1:${door}`]) : "none";
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
  const addresses = () => {
    const wifi = lan.state();
    return { tailnet: tailnet.address, lan: wifi.address, fingerprint: wifi.address ? wifi.fingerprint : null };
  };

  const openOffer = (): Offer | null => {
    if (offer && offer.expiresAt <= now().getTime()) offer = null;
    return offer;
  };

  const revoke = (device: InboxDevice): InboxDevice => {
    const revoked = devices.revoke(device.id, now().toISOString()) ?? device;
    for (const stream of streams.get(device.id) ?? []) stream.abort();
    streams.delete(device.id);
    context.relay?.revoked(revoked);
    return revoked;
  };

  // ── Pairing (contract section 1) ──

  const makeOffer = () => {
    const secret = randomBytes(32).toString("base64url");
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const expiresAt = now().getTime() + PAIRING_OFFER_MS;
    offer = { secret, code, expiresAt, wrong: 0 };
    const reach = addresses();
    const params = [`v=1`, `name=${encodeURIComponent(computer().name)}`];
    if (reach.tailnet) params.push(`tailnet=${encodeURIComponent(reach.tailnet)}`);
    if (reach.lan && reach.fingerprint) params.push(`lan=${encodeURIComponent(reach.lan)}`, `fp=${reach.fingerprint}`);
    params.push(`secret=${secret}`, `code=${code}`);
    return {
      offer: { code, expires_at: new Date(expiresAt).toISOString() },
      link: `plannotator://pair?${params.join("&")}`,
      computer: computer(),
      addresses: reach,
    };
  };

  /**
   * `secretOnly`: the LAN listener. Over the Wi-Fi the phone pins the
   * certificate whose fingerprint the QR carried from this computer's screen;
   * a fingerprint learned from the network (a Bonjour record anyone on the
   * Wi-Fi can publish) would let a listener in the middle relay the person's
   * own six digits. So the LAN takes the QR secret only (contract section 3).
   */
  const redeem = async (req: Request, secretOnly: boolean): Promise<Response> => {
    const body = await context.readBody(req);
    const byName = checkInboxThreadName(body.name);
    if (!byName.ok) throw new InboxError("validation_error", `name: ${byName.message}`, { field: "name" });
    const platform = checkInboxThreadName(body.platform);
    if (!platform.ok) throw new InboxError("validation_error", `platform: ${platform.message}`, { field: "platform" });
    const secret = typeof body.secret === "string" && body.secret ? body.secret : null;
    const code = typeof body.code === "string" && body.code ? body.code : null;
    if (secretOnly && !secret && code) {
      return refuse(400, "code_not_accepted_here", "Over the Wi-Fi, pair by scanning the QR code on your computer's screen.");
    }
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
    // The relay (section 4): the mailbox, made at the first pairing, and this phone registered there; null when it cannot be reached.
    const relay = (await context.relay?.paired(device)) ?? null;
    return json({ device: publicDevice(device), token, secret: open.secret, computer: computer(), addresses: addresses(), relay }, 201);
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
    // Wait while the same command runs; no await when none does, so the check and the claim below happen in one turn.
    while (inFlight.has(slot)) await inFlight.get(slot);
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

  const caught = (error: unknown): Response => {
    if (error instanceof InboxError) return json({ error: error.message, code: error.code, ...error.details }, error.code === "validation_error" ? 422 : 400);
    return refuse(500, "internal_error", "Internal error.");
  };

  /** One request from a known, live device: its own revoke, or an allowlisted route handed to the window. */
  const serve = async (req: Request, url: URL, route: string, device: InboxDevice): Promise<Response> => {
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
  };

  const door = async (req: Request, url: URL, secretOnly = false): Promise<Response> => {
    try {
      if (req.headers.get("origin") !== null) return refuse(403, "origin_not_allowed", "Browser requests are not accepted here.");
      const route = url.pathname.startsWith(DOOR_PREFIX) ? url.pathname.slice(DOOR_PREFIX.length) : "";
      if (route === "pair" && req.method === "POST") return await redeem(req, secretOnly);
      const token = bearer(req);
      if (!token) return refuse(401, "device_token_missing", "This request needs the phone's token.");
      const device = devices.byToken(token);
      if (!device) return refuse(401, "device_token_invalid", "This token does not belong to a paired phone.");
      if (device.revoked_at !== null) return refuse(401, "device_revoked", "This phone was removed from the Inbox. Pair it again.");
      return await serve(req, url, route, device);
    } catch (error) {
      return caught(error);
    }
  };

  /**
   * A command that came up through the relay (contract section 4), applied
   * in-process as the device whose key opened it: the same revocation check,
   * allowlist and idempotency log as a request at the door, so a command the
   * relay replays writes nothing again. Two door routes are not carried:
   * `pair` (pairing through the relay is not in v1) and `events` (the down
   * items are the relay's stream; an endless answer cannot be one result).
   */
  const asDevice = async (deviceId: string, input: { method: string; path: string; body?: unknown }): Promise<Response> => {
    try {
      const device = devices.get(deviceId);
      if (!device) return refuse(401, "device_token_invalid", "This token does not belong to a paired phone.");
      if (device.revoked_at !== null) return refuse(401, "device_revoked", "This phone was removed from the Inbox. Pair it again.");
      if (input.method !== "GET" && input.method !== "POST") return refuse(404, "device_route_not_found", "Not a phone route.");
      let url: URL;
      try {
        url = new URL(input.path, `http://127.0.0.1:${context.port()}`);
      } catch {
        return refuse(404, "device_route_not_found", "Not a phone route.");
      }
      const route = url.pathname.startsWith(DOOR_PREFIX) ? url.pathname.slice(DOOR_PREFIX.length) : "";
      if (!route || route === "pair" || route === "events" || url.origin !== `http://127.0.0.1:${context.port()}`) {
        return refuse(404, "device_route_not_found", "Not a phone route.");
      }
      const req = new Request(url, {
        method: input.method,
        headers: input.method === "POST" ? { "Content-Type": "application/json" } : {},
        body: input.method === "POST" ? JSON.stringify(input.body ?? {}) : undefined,
      });
      return await serve(req, url, route, device);
    } catch (error) {
      return caught(error);
    }
  };

  // ── The tailnet (contract sections 1 and 2) ──
  //
  // `tailscale serve` passes the client's own Host header through, so a Host
  // check cannot tell a tailnet peer from this machine. While the switch is
  // on, the Inbox runs a second loopback listener that serves the door and
  // nothing else, and the tailnet mapping points at it, never at the window's
  // port: the socket keeps tailnet requests on the door.

  let doorServer: ReturnType<typeof Bun.serve> | null = null;

  /** A listener that serves the door and nothing else: the tailnet's, and (`secretOnly`, QR pairing only) the Wi-Fi's. */
  const doorOnly =
    (secretOnly: boolean) =>
    (req: Request): Promise<Response> | Response => {
      let url: URL;
      try {
        url = new URL(req.url, "http://127.0.0.1");
      } catch {
        return refuse(404, "device_route_not_found", "Not a phone route.");
      }
      if (url.pathname !== "/api/inbox/device" && !url.pathname.startsWith(DOOR_PREFIX)) return refuse(404, "device_route_not_found", "Not a phone route.");
      return door(req, url, secretOnly);
    };

  // ── The Wi-Fi (contract section 3): the same door-only handler, over TLS on every interface. ──

  /** Keep "Reach from this Wi-Fi" in inbox.json (and this run's entry): `lan: { port, on }`, the port kept while off. */
  const saveLan = (value: { port: number; on: boolean }) => {
    const entry = { ...(readInboxRegistry(context.dataDir) ?? context.registry()) };
    for (const target of [entry, context.registry()]) target.lan = { ...value };
    writeInboxRegistry(context.dataDir, entry);
  };
  const lan = createInboxLan({
    dataDir: context.dataDir,
    saved: () => {
      const kept = context.registry().lan;
      return kept ? { port: kept.port, on: kept.on !== false } : null;
    },
    save: saveLan,
    name: () => computer().name,
    fetch: doorOnly(true),
  });

  /** The door listener, on the port it had last time when it is free. */
  const openDoorListener = (): number => {
    if (doorServer) return doorServer.port as number;
    const serve = (port: number) => Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: 0, fetch: doorOnly(false) } as Parameters<typeof Bun.serve>[0]);
    const last = context.registry().tailnet?.door_port;
    try {
      doorServer = last ? serve(last) : serve(0);
    } catch {
      doorServer = serve(0);
    }
    return doorServer.port as number;
  };

  const closeDoorListener = () => {
    doorServer?.stop(true);
    doorServer = null;
  };

  /** Targets a mapping of this Inbox's own points at: this run's door listener, or the last run's. */
  const ownTargets = () =>
    [doorServer?.port, context.registry().tailnet?.door_port].filter((p): p is number => !!p).map((p) => `http://127.0.0.1:${p}`);

  const saveSwitch = (on: boolean) => {
    const entry = { ...(readInboxRegistry(context.dataDir) ?? context.registry()) };
    const value = on && doorServer ? { https_port: INBOX_TAILNET_HTTPS_PORT, door_port: doorServer.port as number } : undefined;
    if (value) entry.tailnet = value;
    else delete entry.tailnet;
    writeInboxRegistry(context.dataDir, entry);
    const live = context.registry();
    if (value) live.tailnet = value;
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

  /** Open the door listener and point the tailnet mapping at it; on failure both are closed and the error kept for the window. */
  const publish = (): { ok: true } | { ok: false; code: string; message: string } => {
    try {
      const doorPort = openDoorListener();
      const { url } = enableTailscaleServe(doorPort, tailscale, { httpsPort: INBOX_TAILNET_HTTPS_PORT, ownTargets: ownTargets(), persist: true });
      const served = new URL(url);
      tailnet.address = `${served.hostname}:${served.port || "443"}`;
      tailnet.error = null;
      hangup(true);
      return { ok: true };
    } catch (error) {
      closeDoorListener();
      const words = tailnetWords(error);
      tailnet.address = null;
      tailnet.error = words.message;
      return { ok: false, ...words };
    }
  };

  /** Take this Inbox's own mapping down (never someone else's) and close the door listener. */
  /**
   * A terminal closing a foreground Inbox (SIGHUP) would end it without its
   * clean stop and leave the mapping pointing at a dead port. Routed through
   * the clean stop only while a mapping exists, as `--tailscale` sessions do,
   * so the signal's default (and `nohup`) is untouched otherwise.
   */
  const onHangup = () => {
    stopTailnet();
    process.exit(129);
  };
  const hangup = (on: boolean) => {
    process.removeListener("SIGHUP", onHangup);
    if (on) process.once("SIGHUP", onHangup);
  };

  /** Take this Inbox's own mapping down (never someone else's); the listener closes unless the take-down failed. */
  const unpublish = (): "removed" | "none" | "failed" => {
    const result = takeDownOwnMapping(tailscale, ownTargets());
    if (result === "failed") return result;
    closeDoorListener();
    hangup(false);
    tailnet.address = null;
    return result;
  };

  /**
   * At start: the switch was on, so point the mapping at a fresh door
   * listener before anything else uses it. If that fails, a mapping the last
   * run left (a crash, kill -9) is taken down, so it never points at a dead
   * port for longer than this start.
   */
  const startTailnet = () => {
    if (!context.registry().tailnet) return;
    tailnet.on = true;
    if (publish().ok) saveSwitch(true);
    else takeDownOwnMapping(tailscale, ownTargets());
  };

  /**
   * A clean stop (quit, the stop route, a restart to update, which runs this
   * before it starts the new binary) takes the mapping and the door listener
   * down, so nothing is published while the Inbox is stopped. The switch stays
   * on in inbox.json (with door_port, so a take-down that failed here is done
   * by the next start or `uninstall --purge`), and the next start publishes
   * again.
   */
  const stopTailnet = () => {
    if (tailnet.address === null && !doorServer) return;
    unpublish();
    closeDoorListener();
    hangup(false);
  };

  const setTailnet = (on: boolean): Response => {
    if (on) {
      const result = publish();
      if (!result.ok) return refuse(409, result.code, result.message);
      tailnet.on = true;
      saveSwitch(true);
      return json({ tailnet });
    }
    // A take-down that failed changes nothing: the switch stays on, door_port is kept, and the window says why.
    if (unpublish() === "failed") {
      return refuse(409, "tailnet_unavailable", `Tailscale could not take the Inbox's address down. Try again, or run "tailscale serve --https=${INBOX_TAILNET_HTTPS_PORT} off".`);
    }
    tailnet.on = false;
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
    if (path === "/api/inbox/lan") {
      if (req.method === "GET") return json({ lan: lan.state() });
      if (req.method !== "POST") return json({ error: "Use GET or POST." }, 405);
      const body = await context.readBody(req);
      const stale = staleTab(body);
      if (stale) return stale;
      if (typeof body.on !== "boolean") throw new InboxError("validation_error", "on: must be a boolean.", { field: "on" });
      try {
        return json({ lan: lan.set(body.on) });
      } catch (error) {
        if (error instanceof LanUnavailableError) return refuse(409, "lan_unavailable", error.message);
        throw error;
      }
    }
    return null;
  };

  return { door, asDevice, windowRoute, startTailnet, stopTailnet, startLan: lan.start, stopLan: lan.stop, devices };
}
