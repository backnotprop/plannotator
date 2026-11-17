/**
 * Plannotator Inbox: a short-lived client of a Rex server (superlogical.com/rex), over its unix socket.
 *
 * Rex serves its control API as a WebSocket at `GET /api/control` (subprotocol `rex.control.v1`) on the socket the
 * server listens on. Bun's `ws+unix://` cannot open a socket whose path has a space, and Rex's macOS socket lives
 * under `~/Library/Application Support`, so this speaks the few frames it needs itself over `node:net`: the upgrade,
 * text frames (masked, as a client must), pings answered, a close. No `rex` binary, so no server is ever started
 * (the CLI's `--autostart` default would start one).
 *
 * Every failure (no socket, a refused connection, a server that never says welcome, a closed connection, a deadline)
 * rejects with `RexUnavailable`; the callers treat it as "no Rex", silently.
 */
import { createHash, randomBytes } from "node:crypto";
import { createConnection, type Socket } from "node:net";

/** The newest Rex control API revision this client was written for (the server translates older ones). */
export const REX_API_REVISION = 7;
/** The largest message this client takes (Rex never sends more than 1 MiB). */
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export class RexUnavailable extends Error {}

/** A Rex method's error (`{ code, message, status }` on a response). */
export class RexCallError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface RexConnection {
  /** Call one method and wait for its response (its `payload`), or a `RexCallError` for its `error`. */
  call(method: string, payload?: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): void;
}

/** One client frame: FIN, the opcode, masked. */
function frame(opcode: number, data: Buffer): Buffer {
  const mask = randomBytes(4);
  const length = data.length;
  const head = length < 126 ? Buffer.from([0x80 | opcode, 0x80 | length]) : length <= 0xffff ? Buffer.alloc(4) : Buffer.alloc(10);
  if (length >= 126 && length <= 0xffff) {
    head[0] = 0x80 | opcode;
    head[1] = 0x80 | 126;
    head.writeUInt16BE(length, 2);
  } else if (length > 0xffff) {
    head[0] = 0x80 | opcode;
    head[1] = 0x80 | 127;
    head.writeBigUInt64BE(BigInt(length), 2);
  }
  const body = Buffer.alloc(length);
  for (let i = 0; i < length; i++) body[i] = data[i]! ^ mask[i % 4]!;
  return Buffer.concat([head, mask, body]);
}

/**
 * Open a control connection to the Rex server on `socketPath` and say hello. Resolves once the server's welcome
 * arrived; rejects with `RexUnavailable` when that does not happen within `timeoutMs`.
 */
export function connectRex(socketPath: string, options: { timeoutMs: number; version?: string }): Promise<RexConnection> {
  return new Promise<RexConnection>((resolveConnection, rejectConnection) => {
    let socket: Socket;
    try {
      socket = createConnection({ path: socketPath });
    } catch {
      rejectConnection(new RexUnavailable("no socket"));
      return;
    }
    const key = randomBytes(16).toString("base64");
    const expectAccept = createHash("sha1").update(key + WS_GUID).digest("base64");
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    let welcomed = false;
    let ended = false;
    let fragments: Buffer[] = [];
    let nextId = 0;
    const waiting = new Map<string, { resolve: (value: Record<string, unknown>) => void; reject: (cause: Error) => void }>();

    const end = (cause: Error) => {
      if (ended) return;
      ended = true;
      clearTimeout(deadline);
      socket.destroy();
      if (!welcomed) rejectConnection(cause instanceof RexUnavailable ? cause : new RexUnavailable(cause.message));
      for (const pending of waiting.values()) pending.reject(cause instanceof RexCallError ? cause : new RexUnavailable(cause.message));
      waiting.clear();
    };
    const deadline = setTimeout(() => end(new RexUnavailable("no welcome in time")), options.timeoutMs);

    const send = (opcode: number, data: Buffer) => {
      if (!ended) socket.write(frame(opcode, data));
    };

    const connection: RexConnection = {
      call(method, payload = {}) {
        if (ended) return Promise.reject(new RexUnavailable("closed"));
        const id = String(++nextId);
        return new Promise((resolve, reject) => {
          waiting.set(id, { resolve, reject });
          send(0x1, Buffer.from(JSON.stringify({ type: "request", id, method, payload })));
        });
      },
      close() {
        if (ended) return;
        // A close frame: Rex ends the client at once.
        try {
          send(0x8, Buffer.from([0x03, 0xe8]));
        } catch {}
        end(new RexUnavailable("closed"));
      },
    };

    const onMessage = (text: string) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(text) as Record<string, unknown>;
      } catch {
        return end(new RexUnavailable("not JSON"));
      }
      if (!welcomed) {
        if (message.type !== "welcome" || message.protocol !== "rex.control.v1") return end(new RexUnavailable("no welcome"));
        welcomed = true;
        clearTimeout(deadline);
        resolveConnection(connection);
        return;
      }
      // Events and kinds this client does not know are skipped, as Rex asks.
      if (message.type !== "response" || typeof message.id !== "string") return;
      const pending = waiting.get(message.id);
      if (!pending) return;
      waiting.delete(message.id);
      const error = message.error as { code?: unknown; message?: unknown; status?: unknown } | null | undefined;
      if (error && typeof error === "object") {
        pending.reject(new RexCallError(typeof error.code === "string" ? error.code : "internal", typeof error.message === "string" ? error.message : "", typeof error.status === "number" ? error.status : 500));
        return;
      }
      const result = message.payload;
      pending.resolve(result && typeof result === "object" && !Array.isArray(result) ? (result as Record<string, unknown>) : {});
    };

    /** Read every whole frame in `buffer`. */
    const readFrames = () => {
      while (buffer.length >= 2) {
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
          const long = buffer.readBigUInt64BE(2);
          if (long > BigInt(MAX_MESSAGE_BYTES)) return end(new RexUnavailable("message too large"));
          length = Number(long);
          at = 10;
        }
        if (length > MAX_MESSAGE_BYTES) return end(new RexUnavailable("message too large"));
        const maskAt = at;
        if (masked) at += 4;
        if (buffer.length < at + length) return;
        let data = buffer.subarray(at, at + length);
        if (masked) {
          const mask = buffer.subarray(maskAt, maskAt + 4);
          data = Buffer.from(data.map((byte, i) => byte ^ mask[i % 4]!));
        }
        buffer = buffer.subarray(at + length);
        if (opcode === 0x8) return end(new RexUnavailable("closed by Rex"));
        if (opcode === 0x9) {
          send(0xa, Buffer.from(data));
          continue;
        }
        if (opcode === 0xa) continue;
        if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
          fragments.push(Buffer.from(data));
          if (fragments.reduce((n, part) => n + part.length, 0) > MAX_MESSAGE_BYTES) return end(new RexUnavailable("message too large"));
          if (!fin) continue;
          const whole = Buffer.concat(fragments);
          fragments = [];
          onMessage(whole.toString("utf8"));
          if (ended) return;
        }
      }
    };

    socket.on("connect", () => {
      socket.write(
        [
          "GET /api/control HTTP/1.1",
          "Host: localhost",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${key}`,
          "Sec-WebSocket-Version: 13",
          "Sec-WebSocket-Protocol: rex.control.v1",
          "",
          "",
        ].join("\r\n"),
      );
    });
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const headEnd = buffer.indexOf("\r\n\r\n");
        if (headEnd < 0) {
          if (buffer.length > 16 * 1024) end(new RexUnavailable("bad upgrade"));
          return;
        }
        const head = buffer.subarray(0, headEnd).toString("latin1").split("\r\n");
        const status = /^HTTP\/1\.[01] (\d{3})/.exec(head[0] ?? "")?.[1];
        const headers = new Map(head.slice(1).map((line) => [line.slice(0, line.indexOf(":")).trim().toLowerCase(), line.slice(line.indexOf(":") + 1).trim()]));
        if (status !== "101" || headers.get("sec-websocket-accept") !== expectAccept) return end(new RexUnavailable("not a Rex server"));
        upgraded = true;
        buffer = buffer.subarray(headEnd + 4);
        // Under 512 bytes, uncompressed (Rex's rule for a hello).
        send(0x1, Buffer.from(JSON.stringify({ type: "hello", api_revision: REX_API_REVISION, client: { kind: "other", name: "Plannotator", ...(options.version ? { version: options.version } : {}) } })));
      }
      readFrames();
    });
    socket.on("error", (cause) => end(new RexUnavailable(cause.message)));
    socket.on("close", () => end(new RexUnavailable("closed")));
  });
}
