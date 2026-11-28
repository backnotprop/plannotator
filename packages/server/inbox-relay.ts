/**
 * Plannotator Inbox: the relay, the Inbox's side (adr/implementation/inbox-mobile.md,
 * section 4; mobile plan step R1).
 *
 * The relay (`apps/relay`, a Cloudflare Worker with one Durable Object per
 * mailbox) holds only what it cannot read. This module:
 *
 *  - makes the Inbox's mailbox at the first pairing and keeps it in
 *    `inbox/relay.json` (0600): `{ v: 1, url, mailbox_id, secret }`, the
 *    secret being the Inbox's bearer there, of which the relay keeps only the
 *    SHA-256;
 *  - registers each paired phone by the SHA-256 of its relay secret (derived
 *    from the pairing secret, never sent), and removes it on revoke;
 *  - holds one outbound WebSocket to the mailbox while a phone is paired:
 *    `hello` on connect (each phone's relay switch written into its record,
 *    a revoked phone removed, a phone the relay does not list registered) and
 *    `carriage` when a phone flips its switch;
 *  - carries (R2): down, every store line after each phone's cursor as an
 *    `item` sealed under that phone's key, to phones whose switch is on;
 *    up, each `command` opened with the phone's up key and applied through
 *    the device door in-process (`apply`), answered with a `result` item and
 *    then `applied`, so the relay deletes it. Frames are handled one at a
 *    time in the order they arrive: `hello`, then the held commands;
 *  - posts one push per paired phone whose switch is on when an agent's
 *    message lands with a question, a guided review, a permission prompt,
 *    a failed turn or a new thread (where the window's browser notification
 *    fires, packages/inbox/notify.ts), the summary (push version 2,
 *    inbox-relay-push.ts) encrypted under that phone's key; never for a
 *    snoozed thread;
 *  - hands a command's sealed `not_after` to the door, which refuses a first
 *    arrival past it (`410 command_expired`, reported applied) after looking
 *    up its key, so a "now" write held at the relay is never applied late and
 *    one already applied replays its answer;
 *  - reads the relay's version from `hello` (relay 1.1 says `"1.1"`; 1.0 says
 *    none) and uses a 1.1 route (the `live` push) only on a relay that has it.
 *
 * The phone registers its own APNs token at the relay with its relay secret
 * (exchange 7.29); the Inbox never sees it.
 *
 * The relay is `https://relay.plannotator.ai` unless `PLANNOTATOR_RELAY_URL`
 * names another (a `wrangler dev` relay in a proof). A mailbox, once made,
 * stays at the URL relay.json names.
 */

import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decryptWithKey, deriveRelayKeys, deriveRelaySignalToken, encryptWithKey } from "@plannotator/core/crypto";
import type { InboxListRow } from "@plannotator/core/inbox-types";
import { sha256Hex, type InboxDevice, type InboxDevices } from "@plannotator/shared/inbox/devices";
import { inboxDir } from "@plannotator/shared/inbox/schema";
import type { InboxLine } from "@plannotator/core/inbox-types";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { createInboxAgentRelayApplied } from "./inbox-agent-relay-applied";
import { AGENT_PLATFORM } from "./inbox-devices";
import { INBOX_PUSH_KINDS_FOR_NEW_APPS, inboxPushCollapseId, type InboxPushKind } from "@plannotator/core/inbox-push";
import { inboxPushSummary, sizedPushEnvelope } from "./inbox-relay-push";

export { apnsBody } from "./inbox-relay-push";

export const DEFAULT_RELAY_URL = "https://relay.plannotator.ai";
export const INBOX_RELAY_FILE = "relay.json";

/** How long one call to the relay may take: a pairing waits on it before answering. */
const RELAY_REQUEST_MS = 10_000;
/** What `hello` from a relay that names no version means: the first relay, 1.0. */
export const RELAY_VERSION_BEFORE_HELLO = "1.0";
/**
 * Cloudflare's WebSocket message limit (32 MiB), the platform's, not ours: a
 * result whose item frame would pass it is answered with a small 413 result
 * instead, so one oversized answer never stops the relay for every command
 * queued behind it (contract section 4).
 */
const WEBSOCKET_MESSAGE_LIMIT = 32 * 1024 * 1024;
/** The largest answer body the relay reads: base64 makes it 4/3 larger, so a larger one cannot fit one frame. */
export const RELAY_BODY_LIMIT = Math.floor((WEBSOCKET_MESSAGE_LIMIT * 3) / 4);

/**
 * One command's result item as it goes up the socket: the answer's bytes as
 * base64 inside the JSON result, sealed under the phone's key (AES-GCM, then
 * base64url). Two base64 layers, so a body of n bytes makes a frame of about
 * 16n/9: a message image at the 10 MB cap (MAX_REVIEW_IMAGE_PREVIEW_BYTES)
 * is a frame of about 17.8 MiB, inside WEBSOCKET_MESSAGE_LIMIT.
 */
export async function sealRelayResult(deviceId: string, id: string, status: number, contentType: string, bytes: Buffer, key: string, now: number = Date.now()): Promise<string> {
  // `now`: the computer's clock when it answered, so a phone keeps its offset from it for `not_after` (section 4).
  const result = { v: 1, type: "result", id, status, content_type: contentType, body_b64: bytes.toString("base64"), now: new Date(now).toISOString() };
  return JSON.stringify({ type: "item", device_id: deviceId, cursor: null, ciphertext: await encryptWithKey(JSON.stringify(result), key) });
}

/** Cloudflare's WebSocket message limit, exported for the bounds test. */
export const RELAY_WEBSOCKET_MESSAGE_LIMIT = WEBSOCKET_MESSAGE_LIMIT;

/**
 * An answer's body, or null when it is larger than `cap`: refused from its
 * Content-Length before anything is read, and otherwise read through a reader
 * that cancels the stream as soon as the count passes the cap, so a body with
 * no length (a streamed download) is never held whole.
 */
export async function readRelayBody(answer: Response, cap: number): Promise<Buffer | null> {
  const length = Number(answer.headers.get("content-length"));
  if (Number.isFinite(length) && length > cap) {
    await answer.body?.cancel().catch(() => {});
    return null;
  }
  if (!answer.body) return Buffer.alloc(0);
  const reader = answer.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

/** Reconnect delays for the socket, doubling from the first to the last. */
const RECONNECT_FIRST_MS = 1_000;
const RECONNECT_LAST_MS = 60_000;

/**
 * The socket's liveness check: a ping after `intervalMs`, then a look every
 * `timeoutMs` until its pong comes back (`heartbeatLook`). A ping leaves after
 * every byte already sent, and a result frame can be about 17.8 MiB, so a slow
 * upload must not count as a dead socket: it would be cut off mid-frame and
 * its command sent again. The pong is due `timeoutMs` after the frames sent
 * before the ping could have left at `uplinkBytesPerMs` (about 256 kbit/s, a
 * slow uplink). Bun (from 1.4) reports its send queue, which empties in steps
 * of hundreds of KB as the kernel takes them: bytes waiting there that have
 * not moved for as long as `queueStepBytes` takes at that rate mean the path
 * is dead, sooner than the allowance; a queue still moving keeps the socket
 * past it.
 */
const RELAY_HEARTBEAT = { intervalMs: 30_000, timeoutMs: 10_000, uplinkBytesPerMs: 32, queueStepBytes: 2 * 1024 * 1024 };

export type RelayHeartbeat = typeof RELAY_HEARTBEAT;

/**
 * One look for a pong: `left` is Bun's send queue now, `queued` what it held
 * at the last look plus what frames sent since added, `movedAt` when it last
 * shrank (or the ping), `due` when the pong is late once the queue is empty.
 */
export function heartbeatLook(
  look: { now: number; left: number; queued: number; movedAt: number; due: number },
  heartbeat: RelayHeartbeat,
): { drop: true } | { drop: false; ms: number; movedAt: number } {
  const moved = look.left < look.queued;
  const movedAt = moved ? look.now : look.movedAt;
  if (look.left > 0) {
    const stuckMs = Math.max(heartbeat.timeoutMs, heartbeat.queueStepBytes / heartbeat.uplinkBytesPerMs);
    return look.now - movedAt >= stuckMs ? { drop: true } : { drop: false, ms: heartbeat.timeoutMs, movedAt };
  }
  // The queue is empty (or this Bun does not report it): one more look for bytes that just left it, else the allowance.
  if (moved) return { drop: false, ms: heartbeat.timeoutMs, movedAt };
  if (look.now >= look.due) return { drop: true };
  return { drop: false, ms: Math.min(heartbeat.timeoutMs, look.due - look.now), movedAt };
}

type RelaySocket = WebSocket & Pick<Bun.WebSocket, "ping" | "terminate">;

export interface InboxRelayFile {
  v: 1;
  url: string;
  mailbox_id: string;
  secret: string;
}

export function relayUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.PLANNOTATOR_RELAY_URL?.trim() || DEFAULT_RELAY_URL).replace(/\/+$/, "");
}

export function readRelayFile(dataDir: string): InboxRelayFile | null {
  try {
    const value = JSON.parse(readFileSync(join(inboxDir(dataDir), INBOX_RELAY_FILE), "utf8")) as InboxRelayFile;
    return value?.v === 1 && typeof value.url === "string" && typeof value.mailbox_id === "string" && typeof value.secret === "string" ? value : null;
  } catch {
    return null;
  }
}

function writeRelayFile(dataDir: string, value: InboxRelayFile): void {
  const dir = inboxDir(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, INBOX_RELAY_FILE);
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(temp, 0o600);
  } catch {
    // Best effort where the filesystem has no modes.
  }
  renameSync(temp, path);
}

interface HelloFrame {
  type: "hello";
  /** Relay 1.1 and later; absent from 1.0. */
  version?: unknown;
  /** `topic` (relay 1.1): the phone registered its app's topic through the 1.1 route. */
  devices: { device_id: string; cursor: number; carriage: boolean; apns: boolean; topic?: boolean }[];
}

/** Relay 1.1: a phone started or stopped naming its app's topic. */
interface TopicFrame {
  type: "topic";
  device_id: string;
  topic: boolean;
}

interface CarriageFrame {
  type: "carriage";
  device_id: string;
  on: boolean;
  cursor: number | null;
}

interface CommandFrame {
  type: "command";
  device_id: string;
  id: string;
  ciphertext: string;
}

/** A command's plaintext (section 4, "What goes down and up"). */
interface CommandPlaintext {
  v: 1;
  id: string;
  method: string;
  path: string;
  body?: unknown;
  /** The app's `X-Plannotator-App` words (inbox-door-version.ts); absent from an older app. */
  app?: unknown;
  /** An ISO time: the door refuses a first arrival past it (`410 command_expired`), never applied late. */
  not_after?: unknown;
}

export { commandTimeRefusal, NOT_AFTER_GRACE_MS } from "./inbox-not-after";

/** A Live Activity update (relay 1.1): counts only, never a name or a word. */
export interface InboxLiveCounts {
  working: number;
  stopped_on_you: number;
  ended: boolean;
}

export interface InboxAgentCommandPlaintext {
  v: 1;
  type: "agent_call";
  id: string;
  tool: string;
  arguments: unknown;
}

export interface InboxRelayAgents {
  apply: (deviceId: string, request: { tool: string; arguments: unknown }, commandId: string) => Promise<Response>;
  signalsFor: (line: InboxLine) => string[];
}

export interface InboxRelayContext {
  dataDir: string;
  store: InboxStore;
  devices: InboxDevices;
  /** A store line as the event stream's `record` event writes it (`eventPayload` in inbox.ts). */
  payload: (line: InboxLine) => unknown;
  /** Apply a command as a device, in-process through the device door (inbox-devices.ts `asDevice`). */
  apply: (deviceId: string, command: { method: string; path: string; body?: unknown; app?: unknown; not_after?: unknown }) => Promise<Response>;
  /** Where a new mailbox is made. Default: `relayUrl()`. */
  url?: string;
  /** One line per event, ids and status codes only (the Inbox's log). */
  log?: (line: string) => void;
  phones?: boolean;
  agents?: InboxRelayAgents;
  /** Timing override for the loopback relay test. */
  heartbeat?: Partial<typeof RELAY_HEARTBEAT>;
  /** The list's rows as the window places them (launched sessions decorated): the push's badge and `time_sensitive`. Default: the store's rows. */
  rows?: () => readonly InboxListRow[];
  /** The clock `not_after` is read against (tests). */
  now?: () => number;
}

export function createInboxRelay(context: InboxRelayContext) {
  const log = context.log ?? ((line: string) => process.stderr.write(`relay: ${line}\n`));
  const { store, devices } = context;
  const phonesOn = context.phones !== false;
  const isAgent = (deviceId: string) => devices.get(deviceId)?.platform === AGENT_PLATFORM;
  const applied = context.agents ? createInboxAgentRelayApplied(context.dataDir) : null;
  const served = () => devices.list().filter((device) => (device.platform === AGENT_PLATFORM ? context.agents !== undefined : phonesOn));
  let mailbox = readRelayFile(context.dataDir);
  let making: Promise<InboxRelayFile | null> | null = null;
  let socket: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  const heartbeat = { ...RELAY_HEARTBEAT, ...context.heartbeat };
  /** When every frame sent on this socket could have left at the heartbeat's slowest uplink. */
  let drainedAt = 0;
  /** Bun's send queue at the heartbeat's last look, plus what frames sent since added to it. */
  let queued = 0;
  let delay = RECONNECT_FIRST_MS;
  let stopped = false;
  let reachable: boolean | null = null;
  /** The relay's version, from the last `hello`; null before the first. */
  let relayVersion: string | null = null;
  /** Relay 1.1: the phones whose app registered its topic (from `hello` and `topic` frames); none before the first `hello`. */
  const topics = new Set<string>();
  let unsubscribe: (() => void) | null = null;
  /** Per phone with carriage on, on this socket: the store seq its items have reached. Cleared on each new socket. */
  const sent = new Map<string, number>();
  /** Phones whose items are being sent now, and those that need another pass when it ends. */
  const pumping = new Set<string>();
  const again = new Set<string>();
  /** Frames are handled one at a time, in arrival order, across reconnects too: a command handed over again waits for the first to finish. */
  let frames: Promise<void> = Promise.resolve();

  const call = (method: string, path: string, bearer: string | null, body?: unknown, url = mailbox?.url): Promise<Response> =>
    fetch(`${url}${path}`, {
      method,
      headers: { ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(RELAY_REQUEST_MS),
    });

  /** The mailbox, made on the first call that needs one. Null when the relay cannot be reached. */
  const ensureMailbox = (): Promise<InboxRelayFile | null> => {
    if (mailbox) return Promise.resolve(mailbox);
    making ??= (async () => {
      const url = context.url ?? relayUrl();
      const secret = randomBytes(32).toString("base64url");
      try {
        const answer = await call("POST", "/v1/mailboxes", null, { secret_sha256: sha256Hex(secret) }, url);
        if (answer.status !== 201) {
          log(`mailbox not made: ${answer.status}`);
          reachable = false;
          return null;
        }
        const { mailbox_id } = (await answer.json()) as { mailbox_id: string };
        mailbox = { v: 1, url, mailbox_id, secret };
        writeRelayFile(context.dataDir, mailbox);
        log(`mailbox ${mailbox_id}`);
        return mailbox;
      } catch (error) {
        log(`mailbox not made: ${error instanceof Error ? error.message : String(error)}`);
        reachable = false;
        return null;
      } finally {
        making = null;
      }
    })();
    return making;
  };

  const mailboxPath = (rest: string) => `/v1/mailboxes/${mailbox!.mailbox_id}${rest}`;

  /** Register one phone by the SHA-256 of its relay secret, with the store cursor now. */
  const register = async (device: InboxDevice): Promise<void> => {
    const secret = devices.secret(device.id);
    if (!mailbox || !secret) return;
    const { relaySecret } = await deriveRelayKeys(secret, device.id);
    const cursor = store.cursor();
    const agent = device.platform === AGENT_PLATFORM;
    const body = agent
      ? { secret_sha256: sha256Hex(relaySecret), cursor, kind: "agent", signal_sha256: sha256Hex(await deriveRelaySignalToken(secret, device.id)) }
      : { secret_sha256: sha256Hex(relaySecret), cursor };
    const answer = await call("PUT", mailboxPath(`/devices/${device.id}`), mailbox.secret, body);
    log(`register ${device.id} ${answer.status}`);
    if (agent) return;
    // On an open socket the phone is carried from here; otherwise the next hello lists it with this cursor.
    if (answer.ok && socket?.readyState === WebSocket.OPEN && !sent.has(device.id)) sent.set(device.id, cursor);
  };

  const remove = async (deviceId: string): Promise<void> => {
    if (!mailbox) return;
    const answer = await call("DELETE", mailboxPath(`/devices/${deviceId}`), mailbox.secret);
    log(`remove ${deviceId} ${answer.status}`);
  };

  const onHello = async (frame: HelloFrame): Promise<void> => {
    const version = typeof frame.version === "string" ? frame.version : RELAY_VERSION_BEFORE_HELLO;
    if (version !== relayVersion) log(`relay version ${version}`);
    relayVersion = version;
    log(`hello ${frame.devices.length}`);
    sent.clear();
    topics.clear();
    for (const entry of frame.devices) if (entry.topic === true) topics.add(entry.device_id);
    const listed = new Set<string>();
    for (const entry of frame.devices) {
      listed.add(entry.device_id);
      const local = devices.get(entry.device_id);
      if (!local || local.revoked_at !== null) await remove(entry.device_id).catch(() => log(`remove ${entry.device_id} failed`));
      else if (local.platform !== AGENT_PLATFORM && phonesOn) devices.setCarriage(local.id, entry.carriage, new Date().toISOString());
    }
    for (const device of served()) {
      if ((device.carriage || device.platform === AGENT_PLATFORM) && !listed.has(device.id)) await register(device).catch(() => log(`register ${device.id} failed`));
    }
    // Resume each listed phone with carriage on from the cursor the relay holds; a phone registered just now starts at the store's cursor then.
    for (const entry of frame.devices) {
      const local = devices.get(entry.device_id);
      if (local && local.revoked_at === null && local.platform !== AGENT_PLATFORM && phonesOn && entry.carriage) sent.set(local.id, entry.cursor);
    }
    for (const id of sent.keys()) void pump(id);
  };

  /** Sends one frame on the open socket, and counts its bytes toward when the heartbeat may expect a pong. */
  const transmit = (frame: string): boolean => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    const before = socket.bufferedAmount;
    socket.send(frame);
    // A frame sent now must not read as the queue failing to shrink.
    queued += socket.bufferedAmount - before;
    // Frames are JSON around base64 text, so their length is their byte count.
    drainedAt = Math.max(drainedAt, Date.now()) + frame.length / heartbeat.uplinkBytesPerMs;
    return true;
  };

  const send = (frame: unknown): boolean => transmit(JSON.stringify(frame));

  /**
   * One store line's item frame, sealed under the phone's key. `after` is the
   * seq the phone's previous item reached, so a phone that last saw a lower
   * seq knows an item was delayed or dropped and reads the list again. Past
   * the WebSocket message limit the line goes down as a placeholder
   * (`too_large: true`), and the cursor moves past it: one oversized line
   * must not hold every later line and every command behind a reconnect loop.
   */
  const recordFrame = async (deviceId: string, line: InboxLine, after: number, key: string): Promise<string> => {
    const seal = async (plaintext: object) =>
      JSON.stringify({ type: "item", device_id: deviceId, cursor: line.seq, ciphertext: await encryptWithKey(JSON.stringify(plaintext), key) });
    const frame = await seal({ v: 1, type: "record", after, ...(context.payload(line) as object) });
    if (Buffer.byteLength(frame) <= WEBSOCKET_MESSAGE_LIMIT) return frame;
    log(`record ${line.seq} too large for ${deviceId}`);
    return seal({ v: 1, type: "record", after, seq: line.seq, kind: line.kind, id: line.id, too_large: true });
  };

  /**
   * Send one phone every store line after the seq it has reached, sealed
   * under its key, until it has them all. One pass at a time per phone; a
   * line written meanwhile asks for another pass.
   */
  const pump = async (deviceId: string): Promise<void> => {
    if (isAgent(deviceId)) {
      sent.delete(deviceId);
      return;
    }
    if (pumping.has(deviceId)) {
      again.add(deviceId);
      return;
    }
    pumping.add(deviceId);
    try {
      do {
        again.delete(deviceId);
        const secret = devices.secret(deviceId);
        if (!secret) return;
        const { key } = await deriveRelayKeys(secret, deviceId);
        pass: for (;;) {
          const from = sent.get(deviceId);
          if (from === undefined) return;
          const lines = store.changesSince(from);
          if (lines.length === 0) break;
          let reached = from;
          for (const line of lines) {
            if (!devices.get(deviceId)?.carriage) return;
            const frame = await recordFrame(deviceId, line, reached, key);
            // A carriage frame moved the cursor meanwhile: start again from it.
            if (sent.get(deviceId) !== reached) continue pass;
            if (!transmit(frame)) return;
            reached = line.seq;
            sent.set(deviceId, reached);
          }
        }
      } while (again.has(deviceId));
    } finally {
      pumping.delete(deviceId);
    }
  };

  /** The command a phone sealed under its up key, or null when no key here opens it (a revoked phone, a forged or reflected envelope). */
  const openCommand = async (frame: CommandFrame, upKey: string): Promise<CommandPlaintext | null> => {
    try {
      const opened = JSON.parse(await decryptWithKey(frame.ciphertext, upKey)) as CommandPlaintext;
      return opened?.v === 1 && typeof opened.method === "string" && typeof opened.path === "string" ? opened : null;
    } catch {
      return null;
    }
  };

  /** The result item for a command, sealed under the phone's key; past the WebSocket message limit, a 413 in its place. */
  const resultFrame = async (deviceId: string, id: string, answer: Response, key: string): Promise<string> => {
    const seal = (status: number, contentType: string, bytes: Buffer) => sealRelayResult(deviceId, id, status, contentType, bytes, key, (context.now ?? Date.now)());
    // base64 grows a body by 4/3 before the JSON and the seal: anything over
    // 3/4 of the frame limit can never fit, so it is refused without being
    // read, and a body without a length is read only up to that bound.
    const bytes = await readRelayBody(answer, RELAY_BODY_LIMIT);
    if (bytes) {
      const frame = await seal(answer.status, answer.headers.get("content-type") ?? "application/octet-stream", bytes);
      if (Buffer.byteLength(frame) <= WEBSOCKET_MESSAGE_LIMIT) return frame;
      log(`command ${deviceId} result too large: ${bytes.length} bytes`);
    } else {
      log(`command ${deviceId} result too large: over ${RELAY_BODY_LIMIT} bytes, not read`);
    }
    const refusal = {
      error: "This answer is too large to carry through the relay. Open it over the Wi-Fi or the tailnet.",
      code: "result_too_large",
      limit_bytes: WEBSOCKET_MESSAGE_LIMIT,
    };
    return seal(413, "application/json; charset=utf-8", Buffer.from(JSON.stringify(refusal)));
  };

  /**
   * One command: opened with the phone's up key, applied through the door,
   * answered with a result item under the id sealed inside it, then reported
   * applied. A sealed id that is not the relay's frame id is refused: the
   * relay must not be able to file one command's result under another's id.
   */
  const openAgentCommand = async (frame: CommandFrame, upKey: string): Promise<InboxAgentCommandPlaintext | null> => {
    try {
      const opened = JSON.parse(await decryptWithKey(frame.ciphertext, upKey)) as InboxAgentCommandPlaintext;
      return opened?.v === 1 && opened.type === "agent_call" && typeof opened.id === "string" && typeof opened.tool === "string" ? opened : null;
    } catch {
      return null;
    }
  };

  const onAgentCommand = async (frame: CommandFrame): Promise<void> => {
    const secret = devices.secret(frame.device_id);
    const keys = secret && context.agents ? await deriveRelayKeys(secret, frame.device_id) : null;
    const opened = keys ? await openAgentCommand(frame, keys.upKey) : null;
    if (keys && opened && opened.id === frame.id) {
      const repeat = applied?.answerOf(frame.device_id, opened.id) ?? null;
      let answer: Response;
      if (repeat) {
        log(`agent command ${frame.device_id} repeated`);
        answer = repeat;
      } else {
        const first = await context.agents!.apply(frame.device_id, { tool: opened.tool, arguments: opened.arguments }, opened.id);
        const body = await first.text();
        applied?.record(frame.device_id, opened.id, first.status, body);
        log(`agent command ${frame.device_id} ${first.status}`);
        answer = new Response(body, { status: first.status, headers: { "Content-Type": first.headers.get("content-type") ?? "application/json; charset=utf-8" } });
      }
      const item = await resultFrame(frame.device_id, opened.id, answer, keys.key);
      transmit(item);
    } else {
      log(`agent command ${frame.device_id} refused`);
    }
    send({ type: "applied", device_id: frame.device_id, id: frame.id });
  };

  const onCommand = async (frame: CommandFrame): Promise<void> => {
    if (isAgent(frame.device_id)) return onAgentCommand(frame);
    if (!phonesOn) {
      log(`command ${frame.device_id} refused`);
      send({ type: "applied", device_id: frame.device_id, id: frame.id });
      return;
    }
    const secret = devices.secret(frame.device_id);
    const keys = secret ? await deriveRelayKeys(secret, frame.device_id) : null;
    const opened = keys ? await openCommand(frame, keys.upKey) : null;
    const command = opened && opened.id === frame.id ? opened : null;
    if (opened && !command) log(`command ${frame.device_id} refused: its sealed id is not the frame's`);
    if (keys && command) {
      // Its time is checked by the door, after its key (inbox-devices.ts `claim`): a command already applied replays
      // its answer however late it comes back (a hello re-sends one never acknowledged); a late first one is 410.
      const answer = await context.apply(frame.device_id, { method: command.method, path: command.path, body: command.body, app: command.app, not_after: command.not_after });
      log(`command ${frame.device_id} ${command.method} ${answer.status}`);
      if (devices.get(frame.device_id)?.carriage) {
        const item = await resultFrame(frame.device_id, command.id, answer, keys.key);
        transmit(item);
      }
    } else {
      // Refused the same way whatever the reason: reported applied, so the relay lets it go.
      log(`command ${frame.device_id} refused`);
    }
    send({ type: "applied", device_id: frame.device_id, id: frame.id });
  };

  const onFrame = async (text: string): Promise<void> => {
    let frame: HelloFrame | CarriageFrame | CommandFrame | TopicFrame;
    try {
      frame = JSON.parse(text);
    } catch {
      return;
    }
    if (frame?.type === "hello" && Array.isArray(frame.devices)) {
      delay = RECONNECT_FIRST_MS;
      await onHello(frame);
    } else if (frame?.type === "carriage" && typeof frame.device_id === "string" && typeof frame.on === "boolean") {
      if (isAgent(frame.device_id) || !phonesOn) return;
      devices.setCarriage(frame.device_id, frame.on, new Date().toISOString());
      // On: resume after the cursor the phone holds. Off: nothing more goes to it.
      if (frame.on && typeof frame.cursor === "number") {
        sent.set(frame.device_id, frame.cursor);
        void pump(frame.device_id);
      } else {
        sent.delete(frame.device_id);
      }
    } else if (frame?.type === "command" && typeof frame.device_id === "string" && typeof frame.id === "string" && typeof frame.ciphertext === "string") {
      await onCommand(frame);
    } else if (frame?.type === "topic" && typeof frame.device_id === "string" && typeof frame.topic === "boolean") {
      if (frame.topic) topics.add(frame.device_id);
      else topics.delete(frame.device_id);
      log(`topic ${frame.device_id} ${frame.topic ? "on" : "off"}`);
    }
  };

  const clearHeartbeat = () => {
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    heartbeatTimer = null;
  };

  /** The one socket, open while the mailbox has a paired device; it reconnects when it drops. */
  const connect = () => {
    if (stopped || socket || retry || !mailbox || served().length === 0) return;
    const url = `${mailbox.url.replace(/^http/, "ws")}${mailboxPath("/socket")}`;
    // Bun's WebSocket takes headers: the Inbox's bearer goes in Authorization, never in the URL.
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${mailbox.secret}` } } as unknown as string[]) as RelaySocket;
    socket = ws;
    drainedAt = 0;
    let awaiting: Buffer | null = null;
    const dropped = (reason?: string) => {
      if (socket !== ws) return;
      clearHeartbeat();
      socket = null;
      sent.clear();
      reachable = false;
      if (reason) {
        log(reason);
        ws.terminate();
      }
      if (stopped || served().length === 0) return;
      retry = setTimeout(() => {
        retry = null;
        connect();
      }, delay);
      delay = Math.min(delay * 2, RECONNECT_LAST_MS);
    };
    const awaitPong = (due: number, movedAt: number, ms: number) => {
      heartbeatTimer = setTimeout(() => {
        if (socket !== ws) return;
        const left = ws.bufferedAmount;
        const next = heartbeatLook({ now: Date.now(), left, queued, movedAt, due }, heartbeat);
        queued = left;
        if (next.drop) dropped("socket heartbeat timed out");
        else awaitPong(due, next.movedAt, next.ms);
      }, ms);
    };
    const schedulePing = () => {
      heartbeatTimer = setTimeout(() => {
        if (socket !== ws || ws.readyState !== WebSocket.OPEN) return;
        // Cloudflare answers protocol pings without waking the mailbox or changing its wire format.
        awaiting = randomBytes(8);
        ws.ping(awaiting);
        queued = ws.bufferedAmount;
        // The ping waits behind every frame already sent: its pong is due once those could have left.
        const now = Date.now();
        awaitPong(Math.max(now, drainedAt) + heartbeat.timeoutMs, now, heartbeat.timeoutMs);
      }, heartbeat.intervalMs);
    };
    ws.onopen = () => {
      if (socket !== ws) return;
      reachable = true;
      schedulePing();
    };
    ws.addEventListener("pong", (event) => {
      if (socket !== ws || !awaiting || !(event instanceof MessageEvent)) return;
      if (!Buffer.isBuffer(event.data) || !awaiting.equals(event.data)) return;
      awaiting = null;
      clearHeartbeat();
      schedulePing();
    });
    ws.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      const text = event.data;
      frames = frames.then(() => (socket === ws ? onFrame(text) : undefined)).catch((error) => log(`frame failed: ${error instanceof Error ? error.message : String(error)}`));
    };
    ws.onerror = () => dropped("socket error");
    ws.onclose = () => dropped();
  };

  const disconnect = () => {
    if (retry) clearTimeout(retry);
    retry = null;
    clearHeartbeat();
    const ws = socket;
    socket = null;
    ws?.close(1000, "closed");
  };

  /**
   * One push per phone whose switch is on, for an agent's message that
   * notifies (inbox-relay-push.ts: a question, a guided review, a permission
   * prompt, a failed turn, a new thread, or replaced questions). Pushes
   * collapse per thread, so a withdrawal that asks nothing new still pushes
   * (`kind: "replaced"`, `question: null`, no answer actions) to replace the
   * older notification and its lock-screen answers. A snoozed thread pushes
   * nothing.
   */
  const pushFor = async (messageId: string): Promise<void> => {
    const message = store.message(messageId);
    if (!mailbox || !message || !phonesOn) return;
    // The phones that take pushes, first: with none, nothing more is read.
    const phones = devices.list().filter((device) => device.carriage && device.platform !== AGENT_PLATFORM && devices.secret(device.id) !== null);
    if (phones.length === 0) return;
    // A kind push 2 added goes only to a phone whose app registered its topic through relay 1.1 (a phone in use before keeps its pushes as they were).
    const takes = (deviceId: string, kind: InboxPushKind | undefined) => !kind || !INBOX_PUSH_KINDS_FOR_NEW_APPS.has(kind) || topics.has(deviceId);
    const summary = inboxPushSummary(store, messageId, context.rows ?? (() => store.listRows()), (kind) => phones.some((device) => takes(device.id, kind)));
    if (!summary) return;
    for (const device of phones) {
      if (!takes(device.id, summary.kind)) continue;
      const secret = devices.secret(device.id);
      if (!secret) continue;
      try {
        const { key, collapseKey } = await deriveRelayKeys(secret, device.id);
        const ciphertext = await sizedPushEnvelope(summary, key);
        // The collapse id: the thread id under the phone's collapse key (its own HKDF label, never the envelope key), so a thread's newer push replaces its older one and the relay never learns the thread.
        const collapseId = await inboxPushCollapseId(collapseKey, message.thread_id);
        const answer = await call("POST", mailboxPath("/push"), mailbox.secret, { device_id: device.id, collapse_id: collapseId, ciphertext });
        const result = (await answer.json().catch(() => ({}))) as { reason?: string; code?: string };
        log(`push ${message.id} ${device.id} ${answer.status}${result.reason ? ` ${result.reason}` : result.code ? ` ${result.code}` : ""}`);
      } catch (error) {
        log(`push ${message.id} ${device.id} failed: ${error instanceof Error ? error.name : "error"}`);
      }
    }
  };

  /**
   * A Live Activity update to one phone (relay 1.1): counts only, in the
   * clear, since no extension opens it. Sent only to a relay whose `hello`
   * said 1.1 or later; to a 1.0 relay it is not sent (`relay_too_old`).
   */
  const live = async (deviceId: string, counts: InboxLiveCounts, event: "update" | "end" = "update"): Promise<string> => {
    if (!mailbox || !phonesOn) return "no_relay";
    if (relayVersion === null || relayVersion === RELAY_VERSION_BEFORE_HELLO) return "relay_too_old";
    const body = {
      device_id: deviceId,
      kind: "live",
      live: { timestamp: Math.floor((context.now ?? Date.now)() / 1000), event, "content-state": { working: counts.working, stopped_on_you: counts.stopped_on_you, ended: counts.ended } },
    };
    try {
      const answer = await call("POST", mailboxPath("/push"), mailbox.secret, body);
      const result = (await answer.json().catch(() => ({}))) as { sent?: boolean; reason?: string; code?: string };
      log(`live ${deviceId} ${answer.status}${result.reason ? ` ${result.reason}` : result.code ? ` ${result.code}` : ""}`);
      return result.sent === true ? "sent" : (result.reason ?? result.code ?? String(answer.status));
    } catch (error) {
      log(`live ${deviceId} failed: ${error instanceof Error ? error.name : "error"}`);
      return "failed";
    }
  };

  // ── A snoozed thread coming back pushes as the window notifies for it (notify.ts `returnedItems`): once per
  // return, when it has a question open. A return that came while this Inbox was not running does not push.
  /** Returns already handled, `<thread>:<until>`. */
  const returned = new Set<string>();
  let snoozeTimer: ReturnType<typeof setTimeout> | null = null;
  let unsubscribeSnoozes: (() => void) | null = null;
  /** A timer never waits longer than this: a clock moved or a machine asleep is caught at the next look. */
  const SNOOZE_LOOK_MAX_MS = 60 * 60 * 1000;

  const pushReturn = (threadId: string) => {
    const messages = store.thread(threadId)?.messages ?? [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]!;
      if (message.author.kind !== "agent" || !store.questionsOf(message.id).some((q) => q.state === "open")) continue;
      void pushFor(message.id);
      return;
    }
  };

  const lookAtSnoozes = (push: boolean) => {
    if (snoozeTimer) clearTimeout(snoozeTimer);
    snoozeTimer = null;
    if (stopped) return;
    const now = (context.now ?? Date.now)();
    let next = Number.POSITIVE_INFINITY;
    for (const snooze of store.snoozes()) {
      const at = Date.parse(snooze.until);
      const key = `${snooze.thread_id}:${snooze.until}`;
      if (at > now) next = Math.min(next, at);
      else if (!returned.has(key)) {
        returned.add(key);
        if (push) pushReturn(snooze.thread_id);
      }
    }
    if (Number.isFinite(next)) {
      snoozeTimer = setTimeout(() => lookAtSnoozes(true), Math.min(next - now, SNOOZE_LOOK_MAX_MS));
      (snoozeTimer as { unref?: () => void }).unref?.();
    }
  };

  const signal = async (deviceId: string): Promise<void> => {
    if (!mailbox || !isAgent(deviceId)) return;
    const answer = await call("POST", mailboxPath(`/devices/${deviceId}/signal`), mailbox.secret).catch(() => null);
    log(`signal ${deviceId} ${answer?.status ?? "failed"}`);
  };

  return {
    /** A phone just paired: the mailbox (made now when there is none), its registration, the socket. Null when the relay cannot be reached. */
    async paired(device: InboxDevice): Promise<{ url: string; mailbox_id: string } | null> {
      const made = await ensureMailbox();
      if (!made) return null;
      // A registration that fails here is made when the socket next says hello.
      await register(device).catch(() => log(`register ${device.id} failed`));
      connect();
      return { url: made.url, mailbox_id: made.mailbox_id };
    },
    /** A phone was removed on the computer or by itself: gone from the relay with all it held. */
    revoked(device: InboxDevice): void {
      // One that fails here is removed when the socket next says hello.
      sent.delete(device.id);
      void remove(device.id).catch(() => log(`remove ${device.id} failed`));
      if (served().length === 0) disconnect();
    },
    signal,
    live,
    /** The relay's version from its last `hello` ("1.0" for a relay that names none); null before the first. */
    relayVersion: (): string | null => relayVersion,
    reachable: (): boolean | null => (served().some((device) => device.platform === AGENT_PLATFORM && device.revoked_at === null) ? reachable : null),
    start(): void {
      unsubscribe = store.subscribe((line) => {
        // Every line goes down to each phone this socket is carrying.
        for (const id of sent.keys()) void pump(id);
        if (context.agents && mailbox) for (const id of context.agents.signalsFor(line)) void signal(id);
        // A message's first line: `at` is its `created_at`. Its questions are written in the same turn, so they are read after it (as is a permission prompt's end of a snooze).
        if (line.kind !== "message" || line.record.author.kind !== "agent" || line.at !== line.record.created_at) return;
        const id = line.record.id;
        queueMicrotask(() => void pushFor(id));
      });
      lookAtSnoozes(false);
      unsubscribeSnoozes = store.onSnoozesChange(() => lookAtSnoozes(true));
      connect();
    },
    stop(): void {
      stopped = true;
      unsubscribe?.();
      unsubscribeSnoozes?.();
      if (snoozeTimer) clearTimeout(snoozeTimer);
      disconnect();
    },
  };
}
