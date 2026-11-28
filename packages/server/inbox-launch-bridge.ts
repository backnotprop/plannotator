/**
 * A launch bridge: an app on this computer that hosts the agents the Inbox starts (its own chats, not a Terminal
 * session). Off unless the Inbox starts with `PLANNOTATOR_LAUNCH_BRIDGE` naming the app's config file; any fault in
 * it leaves the bridge off and the Inbox's own hosts in place. See "An app that hosts the agents (launch bridge)" in
 * docs/agent-guides/inbox-launch.md.
 *
 * The config (a private file): `{ v: 1, host, name, dataDir, address, key, agents? }`. `agents`: the launch agents
 * the app hosts (all four when absent); every other agent keeps the Inbox's own host. `address` names a private file
 * `{ v: 1, port }`, `key` one of exactly 32 raw bytes; both are read again for every request (the app may restart on
 * another port). The key never leaves this computer's files: every request to `http://127.0.0.1:<port>/api/lifecycle/…`
 * is signed with it (HMAC-SHA256, `Authorization: Plannotator-Bridge v1,<ts>,<nonce>,<sig>`), and an answer counts
 * only with its proof (`Plannotator-Bridge-Proof`), checked before its body is read. No redirect is followed, and an
 * answer is 1 MiB at most. Server-only: nothing here reaches a window.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { InboxLaunchAgent, InboxLaunchRecord } from "@plannotator/core/inbox-types";
import type { LaunchHost, LaunchHostContext, LaunchHostResult } from "./inbox-launch-host";

/** The agents of the Inbox's launch list, each by the short name the bridge's hosts take ("Claude in <app>"). */
const SHORT_NAMES: Record<InboxLaunchAgent, string> = {
  "claude-code": "Claude",
  codex: "Codex",
  opencode: "OpenCode",
  pi: "Pi",
};

const HOST_ID = /^[a-z0-9-]{1,40}$/;
/** A launch id or session the bridge is asked about: one plain token. */
const ID = /^[A-Za-z0-9_-]{1,160}$/;
const ANSWER_MAX = 1024 * 1024;
const GET_TIMEOUT_MS = 5_000;
const POST_TIMEOUT_MS = 45_000;
/** How long one catalog read stands for every host (they all ask at once). */
const CATALOG_FRESH_MS = 2_000;

/** The header an app's answer proves itself with. */
export const LAUNCH_BRIDGE_PROOF = "Plannotator-Bridge-Proof";

const sha256Hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Lowercase-hex HMAC-SHA256 under the 32 raw key bytes. */
export const launchBridgeMac = (key: Uint8Array, text: string) => createHmac("sha256", key).update(text, "utf8").digest("hex");

/**
 * What a request's signature covers: the method, the address with its port (a captured request can't be replayed to
 * the app on another port), the path and query exactly as sent, the time (unix ms), the nonce and the body's hash.
 */
export const launchBridgeRequestText = (method: string, port: number, path: string, ts: string, nonce: string, body: Uint8Array) =>
  `request\n${method}\n127.0.0.1:${port}\n${path}\n${ts}\n${nonce}\n${sha256Hex(body)}`;

/** What an answer's proof covers: the request's nonce, the status and the body's hash. */
export const launchBridgeAnswerText = (nonce: string, status: number, body: Uint8Array) => `answer\n${nonce}\n${status}\n${sha256Hex(body)}`;

export interface LaunchBridgeConfig {
  /** The host its sessions connect as (`to.host`). */
  host: string;
  /** The app's name, in every word the person reads ("Open in <name>"). */
  name: string;
  /** The private file holding `{ v: 1, port }`. */
  address: string;
  /** The private file holding the 32-byte key. */
  key: string;
  /** The launch agents the app hosts, in the launch list's order. */
  agents: InboxLaunchAgent[];
}

/**
 * A private file, bounded: a regular file of this user with no group or other bits, never through a symbolic link.
 * Windows has no uid or POSIX modes, so there the file must only be a regular file within its bound.
 */
export function launchBridgePrivateRead(path: string, max = 65_536): Buffer {
  if (!isAbsolute(path)) throw new Error("a launch bridge file is named by an absolute path");
  if (lstatSync(path).isSymbolicLink()) throw new Error(`${path} is a symbolic link`);
  const windows = process.platform === "win32";
  const fd = openSync(path, windows ? constants.O_RDONLY : constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > max) throw new Error(`${path} is not a file of at most ${max} bytes`);
    if (!windows && (info.uid !== process.getuid?.() || info.mode & 0o077)) throw new Error(`${path} is not private to this user`);
    const raw = readFileSync(fd);
    if (raw.byteLength > max) throw new Error(`${path} is over ${max} bytes`);
    return raw;
  } finally {
    closeSync(fd);
  }
}

const absolute = (value: unknown): value is string => typeof value === "string" && value.length > 0 && !value.includes("\0") && isAbsolute(value);

/** The config `PLANNOTATOR_LAUNCH_BRIDGE` names, checked; null when unset. Throws, with why, when it does not hold. */
export function launchBridgeConfig(dataDir: string, env: Readonly<Record<string, string | undefined>> = process.env): LaunchBridgeConfig | null {
  const path = env.PLANNOTATOR_LAUNCH_BRIDGE;
  if (!path) return null;
  const c = JSON.parse(launchBridgePrivateRead(path).toString("utf8"));
  if (!c || typeof c !== "object" || c.v !== 1) throw new Error("its version is not 1");
  if (typeof c.host !== "string" || !HOST_ID.test(c.host)) throw new Error("host: 1 to 40 of a-z, 0-9 and -");
  // An agent's own id would hand the app's sessions to that agent's own ways in (Codex's wake).
  if (Object.hasOwn(SHORT_NAMES, c.host)) throw new Error("host: the app's own id, not an agent's");
  const name = typeof c.name === "string" ? c.name : "";
  if ([...name].length < 1 || [...name].length > 40 || !name.trim() || /\p{Cc}/u.test(name)) throw new Error("name: 1 to 40 characters, no control characters");
  if (!absolute(c.dataDir) || resolve(c.dataDir) !== resolve(dataDir)) throw new Error("dataDir is not this Inbox's data folder");
  if (!absolute(c.address) || !absolute(c.key)) throw new Error("address and key: absolute paths");
  const all = Object.keys(SHORT_NAMES) as InboxLaunchAgent[];
  // Absent: the app hosts every launch agent. Listed: only those; the rest keep the Inbox's own hosts.
  if (c.agents !== undefined) {
    const listed: unknown[] = Array.isArray(c.agents) ? c.agents : [];
    if (listed.length < 1 || listed.length > all.length || new Set(listed).size !== listed.length || !listed.every((a) => all.includes(a as InboxLaunchAgent))) {
      throw new Error(`agents: 1 to ${all.length} of ${all.join(", ")}, each once`);
    }
  }
  const agents = c.agents === undefined ? all : all.filter((a) => c.agents.includes(a));
  return { host: c.host, name, address: c.address, key: c.key, agents };
}

interface SessionRow {
  busy: boolean | null;
  state: string;
  stopped?: boolean;
}
interface Catalog {
  ok: boolean;
  workspaces: { folder: string }[];
  providers: { id: string }[];
  sessions: Record<string, SessionRow>;
}

/**
 * The hosts of the app `PLANNOTATOR_LAUNCH_BRIDGE` names: one per agent the config lists (every launch agent when it
 * lists none), each offered only while the app's catalog lists it. None when the variable is unset or its config does not hold (said once in the log).
 * The engine holds hosts by agent, so each takes the place of the Inbox's own host for its agent.
 */
export function createLaunchBridgeHosts(context: LaunchHostContext): LaunchHost[] {
  let config: LaunchBridgeConfig | null;
  try {
    config = launchBridgeConfig(context.dataDir);
  } catch (error) {
    context.log(`Inbox launch bridge: off, PLANNOTATOR_LAUNCH_BRIDGE does not hold: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
  if (!config) return [];
  const { host: routeHost, name: app } = config;

  /** The port and key, read again for each request. */
  const bridge = () => {
    const address = JSON.parse(launchBridgePrivateRead(config.address).toString("utf8"));
    const key = launchBridgePrivateRead(config.key, 32);
    if (!address || address.v !== 1 || !Number.isInteger(address.port) || address.port < 1 || address.port > 65_535 || key.length !== 32) {
      throw new Error(`${app} is not reachable.`);
    }
    return { port: address.port as number, key };
  };
  const request = async (action: string, body?: unknown): Promise<any> => {
    const { port, key } = bridge();
    const method = body === undefined ? "GET" : "POST";
    const path = `/api/lifecycle/${action}`;
    const sent = body === undefined ? "" : JSON.stringify(body);
    const ts = String(Date.now());
    const nonce = randomBytes(16).toString("hex");
    const sig = launchBridgeMac(key, launchBridgeRequestText(method, port, path, ts, nonce, Buffer.from(sent, "utf8")));
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      redirect: "error",
      headers: { Authorization: `Plannotator-Bridge v1,${ts},${nonce},${sig}`, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: sent }),
      signal: AbortSignal.timeout(body === undefined ? GET_TIMEOUT_MS : POST_TIMEOUT_MS),
    });
    const reader = response.body?.getReader();
    if (!reader) throw new Error(`${app} did not answer.`);
    let size = 0;
    const chunks: Uint8Array[] = [];
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > ANSWER_MAX) {
        await reader.cancel();
        throw new Error(`${app}'s answer was too long.`);
      }
      chunks.push(part.value);
    }
    const bytes = Buffer.concat(chunks);
    // Whatever answers on the port must prove it holds the key before anything it said is read: else it is
    // another process on the app's old port, and counts as the app not answering at all.
    const expected = Buffer.from(launchBridgeMac(key, launchBridgeAnswerText(nonce, response.status, bytes)), "hex");
    const said = response.headers.get(LAUNCH_BRIDGE_PROOF) ?? "";
    const proof = /^[0-9a-f]{64}$/.test(said) ? Buffer.from(said, "hex") : Buffer.alloc(0);
    if (proof.length !== expected.length || !timingSafeEqual(proof, expected)) throw new Error(`${app} did not answer as itself.`);
    const result = JSON.parse(bytes.toString("utf8"));
    if (!response.ok || !result || typeof result !== "object") throw new Error(`${app} refused the action.`);
    return result;
  };

  // One catalog read serves every host for a moment.
  let last: Catalog | null = null;
  let reading: Promise<Catalog> | null = null;
  let readAt = 0;
  const catalog = async (): Promise<Catalog> => {
    if (last && Date.now() - readAt < CATALOG_FRESH_MS) return last;
    return (reading ??= request("catalog")
      .then((wire: Catalog) => {
        if (!wire.ok || !Array.isArray(wire.workspaces) || !Array.isArray(wire.providers) || !wire.sessions || typeof wire.sessions !== "object") {
          throw new Error(`${app}'s catalog is not one this Plannotator reads.`);
        }
        last = wire;
        readAt = Date.now();
        return wire;
      })
      .finally(() => {
        reading = null;
      }));
  };
  /** Sessions the app said were stopped, until it says they work again. */
  const stopped = new Set<string>();

  /** Stop, Open, Resume and Remove act only on a session exactly one launch of the app owns (and, given, this one). */
  const owned = async (session: string, expectedLaunch?: string) => {
    if (typeof session !== "string" || !ID.test(session)) throw new Error(`${app} needs an exact session.`);
    const status = await request("status?session=" + encodeURIComponent(session));
    const entries = status.ok === true && status.version === 1 && status.session === session && status.complete === true && Array.isArray(status.launches) ? status.launches : [];
    if (
      entries.length !== 1 ||
      entries[0]?.session !== session ||
      entries[0]?.state !== "created" ||
      typeof entries[0]?.launchId !== "string" ||
      !ID.test(entries[0].launchId) ||
      (expectedLaunch !== undefined && entries[0].launchId !== expectedLaunch)
    ) {
      throw new Error(`No single launch in ${app} owns this chat.`);
    }
    return { launchId: entries[0].launchId as string, session, ownerAction: true, actionId: randomUUID() };
  };
  const ownedLaunch = async (launch: InboxLaunchRecord) => {
    if (typeof launch.id !== "string" || !ID.test(launch.id)) throw new Error(`${app} needs an exact launch.`);
    return owned(launch.session_ref!, launch.id);
  };
  const resultOf = (result: any): LaunchHostResult => ({
    exitCode: result.ok === true ? 0 : 1,
    text: result.ok === true ? `${app} accepted the action for this chat.` : String(result.text || `${app} did not confirm the action.`),
  });
  /** A refusal before anything was posted (no owner, no answer) as a failed result, in its own words. */
  const refused = (error: unknown): LaunchHostResult => ({ exitCode: 1, text: error instanceof Error ? error.message : String(error) });
  const folderIn = (data: Catalog, folder: string) => data.workspaces.some((w) => typeof w?.folder === "string" && resolve(w.folder) === resolve(folder));

  return config.agents.map((agent): LaunchHost => {
    let snapshot: Catalog["sessions"] | null = null;
    return {
      agent,
      name: `${SHORT_NAMES[agent]} in ${app}`,
      routeHost,
      openIn: app,
      connector: `${app} plugin`,
      shellNames: [],
      async available(folders) {
        try {
          const data = await catalog();
          if (!data.providers.some((p) => p?.id === agent)) return { ok: false, missing: false, reason: `${app} does not offer it.` };
          return !folders || folders.some((f) => folderIn(data, f))
            ? { ok: true, version: "launch bridge v1" }
            : { ok: false, missing: false, reason: `Choose a project ${app} already has open.` };
        } catch {
          return { ok: false, missing: false, reason: `${app} is not running.` };
        }
      },
      // The app keeps the person's own permissions: the Inbox writes no trust or bypass settings for it.
      startOf: () => ({ full: false, ownMode: true, bypass: false }),
      trusts: (folder) => !!last && folderIn(last, folder),
      // Model and effort pass through to the app as picked; it lists none here.
      choices: async () => null,
      async start(launch, input) {
        const source = input.source;
        if (!source) return { ok: false, code: "failed", text: `${app} starts a chat only from the message that asked for it.` };
        const result = await request("start", {
          launchId: launch.id,
          ...source,
          provider: agent,
          folder: launch.folder,
          model: launch.model,
          effort: launch.effort,
          ownerAction: true,
          reconcile: input.reconcile === true,
        });
        if (result.ok !== true || typeof result.session !== "string" || result.ref !== result.session) {
          return { ok: false, code: "failed", text: String(result.text || `${app} did not confirm the chat; no other chat was started.`) };
        }
        return { ok: true, session: result.session, ref: result.ref };
      },
      async sessions() {
        try {
          const data = await catalog();
          snapshot = data.sessions;
          for (const [id, row] of Object.entries(data.sessions)) {
            if (row?.stopped) stopped.add(id);
            else if (row?.busy) stopped.delete(id);
          }
          return (ref) => {
            const row = data.sessions[ref];
            return row ? { status: row.busy === true ? "running" : row.busy === false ? "idle" : null, state: row.state, waitingFor: null } : "absent";
          };
        } catch {
          snapshot = null;
          return null;
        }
      },
      live(session) {
        if (stopped.has(session)) return null;
        const live = context.bridge.runStateOf(session);
        // The app does not know whether the chat works (busy null): its polls say it is there, not whether it is busy.
        return live && snapshot?.[session]?.busy === null ? { ...live, busy: null, busySince: null } : live;
      },
      async resume(launch) {
        let result: any;
        try {
          result = await request("resume", await ownedLaunch(launch));
        } catch (error) {
          return { ...refused(error), failure: { code: "failed", text: refused(error).text } };
        }
        if (result.ok === true) {
          stopped.delete(launch.session_ref!);
          last = null;
          snapshot = null;
        }
        return { ...resultOf(result), failure: result.ok === true ? null : { code: "failed", text: String(result.text || `${app} kept the chat; the reply waits in the Inbox.`) } };
      },
      async stop(ref) {
        let result: any;
        try {
          result = await request("stop", await owned(ref));
        } catch (error) {
          return refused(error);
        }
        if (result.ok === true) {
          stopped.add(ref);
          last = null;
        }
        return resultOf(result);
      },
      async open(launch) {
        try {
          return resultOf(await request("open", await ownedLaunch(launch)));
        } catch (error) {
          return refused(error);
        }
      },
      async remove(ref) {
        try {
          return resultOf(await request("resume", { ...(await owned(ref)), removeAssociation: true }));
        } catch (error) {
          return refused(error);
        }
      },
      purge: async () => ({ exitCode: 0, text: `${app} keeps the chat's history.` }),
      attach: () => null,
      // Never reached: the engine calls `open` for a host that has it.
      terminal: () => {
        throw new Error(`Open this chat in ${app}.`);
      },
      permissions: () => ({ sweep() {}, withdrawAll() {} }),
      stoppedNote: () => `${app} keeps this chat. A new reply continues it.`,
    };
  });
}
