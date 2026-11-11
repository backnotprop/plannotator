import { createHmac, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decryptWithKey, deriveRelayKeys, encryptWithKey } from "@plannotator/core/crypto";
import { displayInboxSubject, inboxAgentName } from "@plannotator/core/inbox-types";
import { sha256Hex, type InboxDevice, type InboxDevices } from "@plannotator/shared/inbox/devices";
import { inboxDir } from "@plannotator/shared/inbox/schema";
import type { InboxLine } from "@plannotator/core/inbox-types";
import type { InboxStore } from "@plannotator/shared/inbox/store";

export const DEFAULT_RELAY_URL = "https://relay.plannotator.ai";
export const INBOX_RELAY_FILE = "relay.json";

const RELAY_REQUEST_MS = 10_000;
const APNS_BODY_LIMIT = 4096;
/** Cloudflare's WebSocket message limit (32 MiB). An oversized result is answered with a small 413 so it cannot block the commands queued behind it. */
const WEBSOCKET_MESSAGE_LIMIT = 32 * 1024 * 1024;
/** The largest answer body the relay reads: base64 makes it 4/3 larger, so a larger one cannot fit one frame. */
export const RELAY_BODY_LIMIT = Math.floor((WEBSOCKET_MESSAGE_LIMIT * 3) / 4);

/** A result frame is about 16n/9 bytes for an n-byte body (two base64 layers), so a 10 MB image still fits WEBSOCKET_MESSAGE_LIMIT. */
export async function sealRelayResult(deviceId: string, id: string, status: number, contentType: string, bytes: Buffer, key: string): Promise<string> {
  const result = { v: 1, type: "result", id, status, content_type: contentType, body_b64: bytes.toString("base64") };
  return JSON.stringify({ type: "item", device_id: deviceId, cursor: null, ciphertext: await encryptWithKey(JSON.stringify(result), key) });
}

export const RELAY_WEBSOCKET_MESSAGE_LIMIT = WEBSOCKET_MESSAGE_LIMIT;

/** Null when the body exceeds `cap`. Refused from Content-Length before reading, and a body without a length is cancelled once past the cap, never held whole. */
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

const RECONNECT_FIRST_MS = 1_000;
const RECONNECT_LAST_MS = 60_000;

export interface InboxRelayFile {
  v: 1;
  url: string;
  mailbox_id: string;
  secret: string;
}

/** Must match apps/relay/src/apns.ts `apnsBody` byte for byte: the push is sized against it. */
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

interface PushPlaintext {
  v: 1;
  /** Pushes and down items share the device key: the reader checks the type, so a relay cannot pass one off as the other. */
  type: "push";
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
  const { v, type, thread_id, message_id } = summary;
  const tries: PushPlaintext[] = [summary];
  if (summary.question?.context) tries.push({ ...summary, question: { ...summary.question, context: null } });
  if (summary.question) tries.push({ ...summary, question: null });
  tries.push({ v, type, thread_id, message_id });
  for (const plaintext of tries) {
    const envelope = await encryptWithKey(JSON.stringify(plaintext), key);
    if (Buffer.byteLength(apnsBody(envelope)) <= APNS_BODY_LIMIT) return envelope;
  }
  return encryptWithKey(JSON.stringify({ v, type, thread_id, message_id }), key);
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
  payload: (line: InboxLine) => unknown;
  apply: (deviceId: string, command: { method: string; path: string; body?: unknown }) => Promise<Response>;
  url?: string;
  /** Ids and status codes only. */
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
  const sent = new Map<string, number>();
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

  /** Past the WebSocket message limit the line goes down as a `too_large` placeholder and the cursor moves past it, so one oversized line cannot hold later lines behind a reconnect loop. */
  const recordFrame = async (deviceId: string, line: InboxLine, after: number, key: string): Promise<string> => {
    const seal = async (plaintext: object) =>
      JSON.stringify({ type: "item", device_id: deviceId, cursor: line.seq, ciphertext: await encryptWithKey(JSON.stringify(plaintext), key) });
    const frame = await seal({ v: 1, type: "record", after, ...(context.payload(line) as object) });
    if (Buffer.byteLength(frame) <= WEBSOCKET_MESSAGE_LIMIT) return frame;
    log(`record ${line.seq} too large for ${deviceId}`);
    return seal({ v: 1, type: "record", after, seq: line.seq, kind: line.kind, id: line.id, too_large: true });
  };

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
            const frame = await recordFrame(deviceId, line, reached, key);
            if (sent.get(deviceId) !== reached) continue pass;
            if (!socket || socket.readyState !== WebSocket.OPEN) return;
            socket.send(frame);
            reached = line.seq;
            sent.set(deviceId, reached);
          }
        }
      } while (again.has(deviceId));
    } finally {
      pumping.delete(deviceId);
    }
  };

  const openCommand = async (frame: CommandFrame, upKey: string): Promise<CommandPlaintext | null> => {
    try {
      const opened = JSON.parse(await decryptWithKey(frame.ciphertext, upKey)) as CommandPlaintext;
      return opened?.v === 1 && typeof opened.method === "string" && typeof opened.path === "string" ? opened : null;
    } catch {
      return null;
    }
  };

  const resultFrame = async (deviceId: string, id: string, answer: Response, key: string): Promise<string> => {
    const seal = (status: number, contentType: string, bytes: Buffer) => sealRelayResult(deviceId, id, status, contentType, bytes, key);
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

  /** A sealed id that is not the relay's frame id is refused: the relay must not file one command's result under another's id. */
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

  /** Pushes collapse per thread, so a withdrawal that asks nothing new still pushes (`question: null`) to replace the older notification. */
  const pushFor = async (messageId: string): Promise<void> => {
    const message = store.message(messageId);
    if (!mailbox || !message) return;
    const questions = store.questionsOf(messageId);
    const supersedes = store.supersededBy(messageId).length > 0;
    if (questions.length === 0 && !message.guide && !supersedes) return;
    // Only an open question is ever offered for a lock-screen answer (an action item, `kind: "action"`, pushes like one but has no lock-screen Done).
    const open = questions.filter((q) => q.state === "open" && q.kind !== "action");
    const only = open.length === 1 ? open[0]! : null;
    const summary: PushPlaintext = {
      v: 1,
      type: "push",
      thread_id: message.thread_id,
      message_id: message.id,
      subject: store.threadSubject(message.thread_id) ?? displayInboxSubject(message.subject) ?? "",
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
    async paired(device: InboxDevice): Promise<{ url: string; mailbox_id: string } | null> {
      const made = await ensureMailbox();
      if (!made) return null;
      // A registration that fails here is made when the socket next says hello.
      await register(device).catch(() => log(`register ${device.id} failed`));
      connect();
      return { url: made.url, mailbox_id: made.mailbox_id };
    },
    revoked(device: InboxDevice): void {
      // One that fails here is removed when the socket next says hello.
      sent.delete(device.id);
      void remove(device.id).catch(() => log(`remove ${device.id} failed`));
      if (devices.list().length === 0) disconnect();
    },
    start(): void {
      unsubscribe = store.subscribe((line) => {
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
