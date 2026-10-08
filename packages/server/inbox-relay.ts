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
 *    message lands with a question or a guided review (where the window's
 *    browser notification fires for a question, packages/inbox/notify.ts),
 *    the summary encrypted under that phone's key.
 *
 * The phone registers its own APNs token at the relay with its relay secret
 * (exchange 7.29); the Inbox never sees it.
 *
 * The relay is `https://relay.plannotator.ai` unless `PLANNOTATOR_RELAY_URL`
 * names another (a `wrangler dev` relay in a proof). A mailbox, once made,
 * stays at the URL relay.json names.
 */

import { createHmac, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decryptWithKey, deriveRelayKeys, encryptWithKey } from "@plannotator/core/crypto";
import { inboxAgentName } from "@plannotator/core/inbox-types";
import { sha256Hex, type InboxDevice, type InboxDevices } from "@plannotator/shared/inbox/devices";
import { inboxDir } from "@plannotator/shared/inbox/schema";
import type { InboxLine } from "@plannotator/core/inbox-types";
import type { InboxStore } from "@plannotator/shared/inbox/store";

export const DEFAULT_RELAY_URL = "https://relay.plannotator.ai";
export const INBOX_RELAY_FILE = "relay.json";

/** How long one call to the relay may take: a pairing waits on it before answering. */
const RELAY_REQUEST_MS = 10_000;
/** Apple's ceiling on a push body (section 4, "Push"). */
const APNS_BODY_LIMIT = 4096;
/**
 * Cloudflare's WebSocket message limit (32 MiB), the platform's, not ours: a
 * result whose item frame would pass it is answered with a small 413 result
 * instead, so one oversized answer never stops the relay for every command
 * queued behind it (contract section 4).
 */
const WEBSOCKET_MESSAGE_LIMIT = 32 * 1024 * 1024;
/** Reconnect delays for the socket, doubling from the first to the last. */
const RECONNECT_FIRST_MS = 1_000;
const RECONNECT_LAST_MS = 60_000;

export interface InboxRelayFile {
  v: 1;
  url: string;
  mailbox_id: string;
  secret: string;
}

/**
 * The body the relay sends to APNs around an envelope, byte for byte as
 * apps/relay/src/apns.ts `apnsBody` writes it: the push is sized against it.
 */
export function apnsBody(envelope: string): string {
  return JSON.stringify({ aps: { alert: { title: "Plannotator", body: "New in your Inbox" }, "mutable-content": 1, sound: "default" }, e: envelope });
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

/** The push summary a phone decrypts (section 4, "Push"). */
interface PushPlaintext {
  v: 1;
  thread_id: string;
  message_id: string;
  subject?: string;
  project?: string;
  agent?: string;
  question?: {
    key: string;
    revision: number;
    prompt: string;
    context: string | null;
    choices: { label: string; recommended: boolean }[];
  } | null;
}

/** The fullest summary whose APNs body fits Apple's 4096 bytes: without the context, then without the question, then ids alone. */
async function sizedEnvelope(summary: PushPlaintext, key: string): Promise<string> {
  const { v, thread_id, message_id } = summary;
  const tries: PushPlaintext[] = [summary];
  if (summary.question?.context) tries.push({ ...summary, question: { ...summary.question, context: null } });
  if (summary.question) tries.push({ ...summary, question: null });
  tries.push({ v, thread_id, message_id });
  for (const plaintext of tries) {
    const envelope = await encryptWithKey(JSON.stringify(plaintext), key);
    if (Buffer.byteLength(apnsBody(envelope)) <= APNS_BODY_LIMIT) return envelope;
  }
  return encryptWithKey(JSON.stringify({ v, thread_id, message_id }), key);
}

interface HelloFrame {
  type: "hello";
  devices: { device_id: string; cursor: number; carriage: boolean; apns: boolean }[];
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
}

export interface InboxRelayContext {
  dataDir: string;
  store: InboxStore;
  devices: InboxDevices;
  /** A store line as the event stream's `record` event writes it (`eventPayload` in inbox.ts). */
  payload: (line: InboxLine) => unknown;
  /** Apply a command as a device, in-process through the device door (inbox-devices.ts `asDevice`). */
  apply: (deviceId: string, command: { method: string; path: string; body?: unknown }) => Promise<Response>;
  /** Where a new mailbox is made. Default: `relayUrl()`. */
  url?: string;
  /** One line per event, ids and status codes only (the Inbox's log). */
  log?: (line: string) => void;
}

export function createInboxRelay(context: InboxRelayContext) {
  const log = context.log ?? ((line: string) => process.stderr.write(`relay: ${line}\n`));
  const { store, devices } = context;
  let mailbox = readRelayFile(context.dataDir);
  let making: Promise<InboxRelayFile | null> | null = null;
  let socket: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let delay = RECONNECT_FIRST_MS;
  let stopped = false;
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
          return null;
        }
        const { mailbox_id } = (await answer.json()) as { mailbox_id: string };
        mailbox = { v: 1, url, mailbox_id, secret };
        writeRelayFile(context.dataDir, mailbox);
        log(`mailbox ${mailbox_id}`);
        return mailbox;
      } catch (error) {
        log(`mailbox not made: ${error instanceof Error ? error.message : String(error)}`);
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
    const answer = await call("PUT", mailboxPath(`/devices/${device.id}`), mailbox.secret, { secret_sha256: sha256Hex(relaySecret), cursor });
    log(`register ${device.id} ${answer.status}`);
    // On an open socket the phone is carried from here; otherwise the next hello lists it with this cursor.
    if (answer.ok && socket?.readyState === WebSocket.OPEN && !sent.has(device.id)) sent.set(device.id, cursor);
  };

  const remove = async (deviceId: string): Promise<void> => {
    if (!mailbox) return;
    const answer = await call("DELETE", mailboxPath(`/devices/${deviceId}`), mailbox.secret);
    log(`remove ${deviceId} ${answer.status}`);
  };

  const onHello = async (frame: HelloFrame): Promise<void> => {
    log(`hello ${frame.devices.length}`);
    sent.clear();
    const listed = new Set<string>();
    for (const entry of frame.devices) {
      listed.add(entry.device_id);
      const local = devices.get(entry.device_id);
      if (!local || local.revoked_at !== null) await remove(entry.device_id).catch(() => log(`remove ${entry.device_id} failed`));
      else devices.setCarriage(local.id, entry.carriage, new Date().toISOString());
    }
    for (const device of devices.list()) {
      if (device.carriage && !listed.has(device.id)) await register(device).catch(() => log(`register ${device.id} failed`));
    }
    // Resume each listed phone with carriage on from the cursor the relay holds; a phone registered just now starts at the store's cursor then.
    for (const entry of frame.devices) {
      const local = devices.get(entry.device_id);
      if (local && local.revoked_at === null && entry.carriage) sent.set(local.id, entry.cursor);
    }
    for (const id of sent.keys()) void pump(id);
  };

  const send = (frame: unknown): boolean => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(frame));
    return true;
  };

  /**
   * Send one phone every store line after the seq it has reached, sealed
   * under its key, until it has them all. One pass at a time per phone; a
   * line written meanwhile asks for another pass.
   */
  const pump = async (deviceId: string): Promise<void> => {
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
            const ciphertext = await encryptWithKey(JSON.stringify({ v: 1, type: "record", ...(context.payload(line) as object) }), key);
            // A carriage frame moved the cursor meanwhile: start again from it.
            if (sent.get(deviceId) !== reached) continue pass;
            if (!send({ type: "item", device_id: deviceId, cursor: line.seq, ciphertext })) return;
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
    const seal = async (status: number, contentType: string, bytes: Buffer) => {
      const result = { v: 1, type: "result", id, status, content_type: contentType, body_b64: bytes.toString("base64") };
      return JSON.stringify({ type: "item", device_id: deviceId, cursor: null, ciphertext: await encryptWithKey(JSON.stringify(result), key) });
    };
    const bytes = Buffer.from(await answer.arrayBuffer());
    const frame = await seal(answer.status, answer.headers.get("content-type") ?? "application/octet-stream", bytes);
    if (Buffer.byteLength(frame) <= WEBSOCKET_MESSAGE_LIMIT) return frame;
    log(`command ${deviceId} result too large: ${bytes.length} bytes`);
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
  const onCommand = async (frame: CommandFrame): Promise<void> => {
    const secret = devices.secret(frame.device_id);
    const keys = secret ? await deriveRelayKeys(secret, frame.device_id) : null;
    const opened = keys ? await openCommand(frame, keys.upKey) : null;
    const command = opened && opened.id === frame.id ? opened : null;
    if (opened && !command) log(`command ${frame.device_id} refused: its sealed id is not the frame's`);
    if (keys && command) {
      const answer = await context.apply(frame.device_id, { method: command.method, path: command.path, body: command.body });
      log(`command ${frame.device_id} ${command.method} ${answer.status}`);
      if (devices.get(frame.device_id)?.carriage) {
        const item = await resultFrame(frame.device_id, command.id, answer, keys.key);
        if (socket && socket.readyState === WebSocket.OPEN) socket.send(item);
      }
    } else {
      // Refused the same way whatever the reason: reported applied, so the relay lets it go.
      log(`command ${frame.device_id} refused`);
    }
    send({ type: "applied", device_id: frame.device_id, id: frame.id });
  };

  const onFrame = async (text: string): Promise<void> => {
    let frame: HelloFrame | CarriageFrame | CommandFrame;
    try {
      frame = JSON.parse(text);
    } catch {
      return;
    }
    if (frame?.type === "hello" && Array.isArray(frame.devices)) {
      delay = RECONNECT_FIRST_MS;
      await onHello(frame);
    } else if (frame?.type === "carriage" && typeof frame.device_id === "string" && typeof frame.on === "boolean") {
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
    }
  };

  /** The one socket, open while the mailbox has a paired phone; it reconnects when it drops. */
  const connect = () => {
    if (stopped || socket || retry || !mailbox || devices.list().length === 0) return;
    const url = `${mailbox.url.replace(/^http/, "ws")}${mailboxPath("/socket")}`;
    // Bun's WebSocket takes headers: the Inbox's bearer goes in Authorization, never in the URL.
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${mailbox.secret}` } } as unknown as string[]);
    socket = ws;
    ws.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      const text = event.data;
      frames = frames.then(() => (socket === ws ? onFrame(text) : undefined)).catch((error) => log(`frame failed: ${error instanceof Error ? error.message : String(error)}`));
    };
    ws.onclose = () => {
      if (socket !== ws) return;
      socket = null;
      sent.clear();
      if (stopped || devices.list().length === 0) return;
      retry = setTimeout(() => {
        retry = null;
        connect();
      }, delay);
      delay = Math.min(delay * 2, RECONNECT_LAST_MS);
    };
  };

  const disconnect = () => {
    if (retry) clearTimeout(retry);
    retry = null;
    const ws = socket;
    socket = null;
    ws?.close(1000, "closed");
  };

  /** One push per phone whose switch is on, for an agent's message with a question or a guided review. */
  const pushFor = async (messageId: string): Promise<void> => {
    const message = store.message(messageId);
    if (!mailbox || !message) return;
    const questions = store.questionsOf(messageId);
    if (questions.length === 0 && !message.guide) return;
    const only = questions.length === 1 ? questions[0]! : null;
    const summary: PushPlaintext = {
      v: 1,
      thread_id: message.thread_id,
      message_id: message.id,
      subject: store.message(message.thread_id)?.subject ?? message.subject ?? "",
      project: store.project(message.project_id)?.name ?? "",
      agent: inboxAgentName(message.author),
      // Apple shows at most four actions: one single-choice question with up to four choices is answered from the lock screen.
      question:
        only && only.kind === "single" && only.choices.length > 0 && only.choices.length <= 4
          ? {
              key: only.key,
              revision: only.revision,
              prompt: only.prompt,
              context: only.context || null,
              choices: only.choices.map((choice) => ({ label: choice.label, recommended: choice.recommended })),
            }
          : null,
    };
    for (const device of devices.list()) {
      if (!device.carriage) continue;
      const secret = devices.secret(device.id);
      if (!secret) continue;
      try {
        const { key, collapseKey } = await deriveRelayKeys(secret, device.id);
        const ciphertext = await sizedEnvelope(summary, key);
        // The collapse id: the thread id under the phone's collapse key (its own HKDF label, never the envelope key), so a thread's newer push replaces its older one and the relay never learns the thread.
        const collapseId = createHmac("sha256", Buffer.from(collapseKey, "base64url")).update(message.thread_id).digest("hex");
        const answer = await call("POST", mailboxPath("/push"), mailbox.secret, { device_id: device.id, collapse_id: collapseId, ciphertext });
        const result = (await answer.json().catch(() => ({}))) as { reason?: string; code?: string };
        log(`push ${message.id} ${device.id} ${answer.status}${result.reason ? ` ${result.reason}` : result.code ? ` ${result.code}` : ""}`);
      } catch (error) {
        log(`push ${message.id} ${device.id} failed: ${error instanceof Error ? error.name : "error"}`);
      }
    }
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
      if (devices.list().length === 0) disconnect();
    },
    start(): void {
      unsubscribe = store.subscribe((line) => {
        // Every line goes down to each phone this socket is carrying.
        for (const id of sent.keys()) void pump(id);
        // A message's first line: `at` is its `created_at`. Its questions are written in the same turn, so they are read after it.
        if (line.kind !== "message" || line.record.author.kind !== "agent" || line.at !== line.record.created_at) return;
        const id = line.record.id;
        queueMicrotask(() => void pushFor(id));
      });
      connect();
    },
    stop(): void {
      stopped = true;
      unsubscribe?.();
      disconnect();
    },
  };
}
