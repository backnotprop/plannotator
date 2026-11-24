/**
 * A JSON-RPC client on Codex's shared app-server control socket: the background server ("daemon") an interactive
 * Codex TUI runs on since Codex 0.157 (`daemon_auto_start`, on by default), at
 * `$CODEX_HOME/app-server-control/app-server-control.sock`. It speaks WebSocket over a Unix stream socket, one
 * JSON-RPC message per text frame, with no `"jsonrpc"` field (codex-rs/app-server-transport/src/transport/mod.rs,
 * unix_socket.rs; app-server-protocol rpc.rs). Access is the socket's file permissions (0600 in a 0700 folder): any
 * process of the same user may connect, as `codex queue` does; the server checks no token, origin or path. The Codex
 * app runs its own server over stdio, which no other process can reach: its threads are never on this socket.
 *
 * Only what the Codex wake needs (inbox-codex-steer.ts): connect, `request`, `notify`, `close`. Every failure says
 * whether the request may have reached Codex (`maybeSent`), so a caller never sends a text twice and never drops one:
 *
 *  - `unreachable`: no socket, no server behind it, or no WebSocket answer. Nothing was sent.
 *  - `refused`: Codex answered the request with a JSON-RPC error. It was not taken.
 *  - `timeout` / `closed`: written, and no answer. It may have been taken.
 *
 * Bun-only (the Inbox is); nothing here starts Codex or writes under its home.
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";

/** The control socket under a Codex home (codex-rs/app-server-transport/src/transport/mod.rs). */
export function codexControlSocketPath(codexHomeDir: string): string {
  return join(codexHomeDir, "app-server-control", "app-server-control.sock");
}

export type CodexControlFailure = "unreachable" | "refused" | "timeout" | "closed";

export class CodexControlError extends Error {
  constructor(
    readonly kind: CodexControlFailure,
    message: string,
    /** A JSON-RPC error's code (`refused` only). */
    readonly code: number | null = null,
  ) {
    super(message);
  }
  /** Whether the request may have reached Codex: written, and no answer came. */
  get maybeSent(): boolean {
    return this.kind === "timeout" || this.kind === "closed";
  }
}

type Rpc = Record<string, any>;

export interface CodexControl {
  /** One request; resolves with its `result`, rejects with a CodexControlError. */
  request(method: string, params: Rpc, ms: number): Promise<Rpc>;
  /** A notification (no answer). */
  notify(method: string, params?: Rpc): void;
  close(): void;
}

/** The longest frame or handshake this client reads (a thread read with its turns can be large). */
const MAX_INBOUND_BYTES = 32 * 1024 * 1024;
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** A masked client frame (RFC 6455 §5.2). */
function frame(opcode: number, payload: Buffer): Buffer {
  const mask = randomBytes(4);
  const length = payload.length;
  const head = length < 126 ? Buffer.alloc(2) : length < 65_536 ? Buffer.alloc(4) : Buffer.alloc(10);
  head[0] = 0x80 | opcode;
  if (length < 126) head[1] = 0x80 | length;
  else if (length < 65_536) {
    head[1] = 0x80 | 126;
    head.writeUInt16BE(length, 2);
  } else {
    head[1] = 0x80 | 127;
    head.writeBigUInt64BE(BigInt(length), 2);
  }
  const body = Buffer.alloc(length);
  for (let i = 0; i < length; i++) body[i] = payload[i]! ^ mask[i % 4]!;
  return Buffer.concat([head, mask, body]);
}

/**
 * Connect and upgrade. Null when the socket is not there (an older Codex, a TUI started with `--no-daemon`, the
 * desktop app's private server), or nothing answers on it within `ms`.
 */
export async function openCodexControl(socketPath: string, ms: number): Promise<CodexControl | null> {
  if (!existsSync(socketPath)) return null;
  const socket = await new Promise<Socket | null>((resolve) => {
    let settled = false;
    const done = (value: Socket | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!value) one.destroy();
      resolve(value);
    };
    const one = createConnection({ path: socketPath });
    const timer = setTimeout(() => done(null), ms);
    one.once("error", () => done(null));
    one.once("connect", () => {
      const key = randomBytes(16).toString("base64");
      const accept = createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
      let head = Buffer.alloc(0);
      const onData = (chunk: Buffer) => {
        head = Buffer.concat([head, chunk]);
        const end = head.indexOf("\r\n\r\n");
        if (end < 0) {
          if (head.length > 64 * 1024) done(null);
          return;
        }
        one.off("data", onData);
        const text = head.subarray(0, end).toString("latin1");
        const ok = /^HTTP\/1\.1 101\b/.test(text) && new RegExp(`^sec-websocket-accept:\\s*${accept.replace(/[+/=]/g, (c) => `\\${c}`)}\\s*$`, "im").test(text);
        if (!ok) return done(null);
        const rest = head.subarray(end + 4);
        if (rest.length > 0) one.unshift(rest);
        done(one);
      };
      one.on("data", onData);
      // As Codex's own client asks (`ws://localhost/rpc`, app-server-remote-client remote.rs), without zstd: plain text frames.
      one.write(`GET /rpc HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
  });
  if (!socket) return null;
  return controlOn(socket);
}

function controlOn(socket: Socket): CodexControl {
  let ids = 0;
  let closed = false;
  const waiters = new Map<string, { resolve: (result: Rpc) => void; reject: (error: CodexControlError) => void }>();
  const endAll = (why: string) => {
    closed = true;
    for (const waiter of waiters.values()) waiter.reject(new CodexControlError("closed", why));
    waiters.clear();
  };

  // ── Reading frames: text messages, pings answered, a close ends it ──
  let buffer: Buffer = Buffer.alloc(0);
  let pieces: Buffer[] = [];
  let piecesBytes = 0;
  const onMessage = (text: string) => {
    let message: Rpc;
    try {
      message = JSON.parse(text) as Rpc;
    } catch {
      return;
    }
    if (message.id === undefined || message.id === null || typeof message.method === "string") return;
    const waiter = waiters.get(String(message.id));
    if (!waiter) return;
    waiters.delete(String(message.id));
    if (message.error) {
      const code = typeof message.error.code === "number" ? message.error.code : null;
      waiter.reject(new CodexControlError("refused", String(message.error.message ?? "Codex refused it"), code));
    } else waiter.resolve((message.result ?? {}) as Rpc);
  };
  socket.on("data", (chunk: Buffer) => {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      const fin = (buffer[0]! & 0x80) !== 0;
      const opcode = buffer[0]! & 0x0f;
      const masked = (buffer[1]! & 0x80) !== 0;
      let length = buffer[1]! & 0x7f;
      let at = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        at = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        const big = buffer.readBigUInt64BE(2);
        if (big > BigInt(MAX_INBOUND_BYTES)) return void socket.destroy();
        length = Number(big);
        at = 10;
      }
      if (length > MAX_INBOUND_BYTES) return void socket.destroy();
      const maskAt = at;
      if (masked) at += 4;
      if (buffer.length < at + length) return;
      let payload = buffer.subarray(at, at + length);
      if (masked) {
        const key = buffer.subarray(maskAt, maskAt + 4);
        payload = Buffer.from(payload.map((byte, i) => byte ^ key[i % 4]!));
      }
      buffer = buffer.subarray(at + length);
      if (opcode === 0x8) {
        if (!closed) socket.end(frame(0x8, Buffer.alloc(0)));
        endAll("Codex closed the connection");
        return;
      }
      if (opcode === 0x9) {
        if (!closed) socket.write(frame(0xa, Buffer.from(payload)));
        continue;
      }
      if (opcode === 0xa) continue;
      if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
        if (opcode !== 0x0) {
          pieces = [];
          piecesBytes = 0;
        }
        pieces.push(Buffer.from(payload));
        piecesBytes += payload.length;
        if (piecesBytes > MAX_INBOUND_BYTES) return void socket.destroy();
        if (fin) {
          const text = Buffer.concat(pieces).toString("utf8");
          pieces = [];
          piecesBytes = 0;
          onMessage(text);
        }
      }
    }
  });
  socket.on("error", () => endAll("the connection to Codex failed"));
  socket.on("close", () => endAll("Codex closed the connection"));

  const send = (message: Rpc): boolean => {
    if (closed) return false;
    try {
      socket.write(frame(0x1, Buffer.from(JSON.stringify(message), "utf8")));
      return true;
    } catch {
      return false;
    }
  };

  return {
    request(method, params, ms) {
      return new Promise((resolve, reject) => {
        if (closed) return reject(new CodexControlError("unreachable", "the connection to Codex is closed"));
        const id = `plannotator-${++ids}`;
        const timer = setTimeout(() => {
          waiters.delete(id);
          reject(new CodexControlError("timeout", `Codex did not answer ${method} within ${Math.round(ms / 1000)} s`));
        }, ms);
        waiters.set(id, {
          resolve: (result) => {
            clearTimeout(timer);
            resolve(result);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        if (!send({ id, method, params })) {
          clearTimeout(timer);
          waiters.delete(id);
          reject(new CodexControlError("unreachable", "the connection to Codex is closed"));
        }
      });
    },
    notify(method, params) {
      send(params === undefined ? { method } : { method, params });
    },
    close() {
      if (closed) return;
      closed = true;
      for (const waiter of waiters.values()) waiter.reject(new CodexControlError("closed", "closed by the Inbox"));
      waiters.clear();
      try {
        socket.end(frame(0x8, Buffer.alloc(0)));
      } catch {}
      setTimeout(() => socket.destroy(), 500).unref?.();
    },
  };
}
