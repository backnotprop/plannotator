/**
 * The extension's end of the builder relay (SPEC 4.4): a local pipe the stdio
 * relay script (`dist/guide-mcp.cjs`, started by the agent) connects to. Each
 * connection proves which session it belongs to with that session's random
 * token, then every JSON-RPC line goes to the session's MCP handler and the
 * answer goes back on the same connection.
 *
 * Node only (`net`, `crypto`); no `vscode`, so it is tested at module level.
 */

import { createServer, type Server, type Socket } from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMcpMessageHandler, type McpToolHandler } from "./protocol";

/** Env names the relay script reads. */
export const RELAY_SOCKET_ENV = "PLANNOTATOR_GUIDE_MCP_SOCKET";
export const RELAY_TOKEN_ENV = "PLANNOTATOR_GUIDE_MCP_TOKEN";
/** First line the relay script sends. */
export const RELAY_HELLO = "plannotator-guide-mcp/1";
/** Lines longer than this many bytes end the connection (the relay never needs more). */
const MAX_LINE_BYTES = 8 * 1024 * 1024;
/** A connection that has not proved its session by then is closed. */
const HELLO_TIMEOUT_MS = 10_000;

export interface RelaySession {
  readonly token: string;
  /** The env the relay script needs, to put in the ACP `mcpServers` entry. */
  readonly env: Record<string, string>;
  /** Connections currently open for this session. */
  connectionCount(): number;
  dispose(): void;
}

export interface RelayHost {
  readonly socketPath: string;
  openSession(handler: McpToolHandler): RelaySession;
  close(): Promise<void>;
}

interface SessionEntry {
  tokenBytes: Buffer;
  handle: ReturnType<typeof createMcpMessageHandler>;
  sockets: Set<Socket>;
}

export async function startRelayHost(options: { serverVersion: string; log?: (line: string) => void; maxLineBytes?: number; helloTimeoutMs?: number }): Promise<RelayHost> {
  const maxLineBytes = options.maxLineBytes ?? MAX_LINE_BYTES;
  const helloTimeoutMs = options.helloTimeoutMs ?? HELLO_TIMEOUT_MS;
  const log = options.log ?? (() => {});
  let socketDir: string | null = null;
  let socketPath: string;
  if (process.platform === "win32") {
    socketPath = `\\\\.\\pipe\\plannotator-guide-${randomBytes(12).toString("hex")}`;
  } else {
    // A private directory keeps the socket out of reach of other users; the
    // short name keeps the path under the 104-byte limit on macOS.
    socketDir = mkdtempSync(join(tmpdir(), "pn-g-"));
    socketPath = join(socketDir, "s");
  }
  const sessions = new Map<string, SessionEntry>();

  const findSession = (token: string): SessionEntry | null => {
    const candidate = Buffer.from(token, "utf8");
    for (const entry of sessions.values()) {
      if (entry.tokenBytes.length === candidate.length && timingSafeEqual(entry.tokenBytes, candidate)) return entry;
    }
    return null;
  };

  const server: Server = createServer((socket) => {
    // Raw bytes: a line is cut at the newline byte and decoded whole, so the
    // limit counts bytes and a character split across chunks stays intact.
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let session: SessionEntry | null = null;
    let queue: Promise<void> = Promise.resolve();
    const helloTimer = setTimeout(() => {
      if (!session) {
        log("[guide-mcp] closed a relay connection that never proved its session");
        end();
      }
    }, helloTimeoutMs);
    helloTimer.unref?.();
    const end = () => {
      clearTimeout(helloTimer);
      session?.sockets.delete(socket);
      socket.destroy();
    };
    socket.on("error", () => end());
    socket.on("close", () => {
      clearTimeout(helloTimer);
      session?.sockets.delete(socket);
    });
    socket.on("data", (chunk: Buffer) => {
      let start = 0;
      for (let nl = chunk.indexOf(0x0a); nl >= 0; nl = chunk.indexOf(0x0a, start)) {
        if (pendingBytes + (nl - start) > maxLineBytes) return end();
        pending.push(chunk.subarray(start, nl));
        const raw = Buffer.concat(pending).toString("utf8");
        pending = [];
        pendingBytes = 0;
        start = nl + 1;
        if (!handleLine(raw.replace(/\r$/, ""))) return;
      }
      const rest = chunk.subarray(start);
      pendingBytes += rest.length;
      if (pendingBytes > maxLineBytes) return end();
      if (rest.length) pending.push(Buffer.from(rest));
    });
    /** Handle one line; false when the connection was closed. */
    const handleLine = (line: string): boolean => {
      if (!line.trim()) return true;
      if (!session) {
        let hello: { hello?: unknown; token?: unknown };
        try {
          hello = JSON.parse(line);
        } catch {
          end();
          return false;
        }
        const found = hello.hello === RELAY_HELLO && typeof hello.token === "string" ? findSession(hello.token) : null;
        if (!found) {
          log("[guide-mcp] refused a relay connection with an unknown token");
          end();
          return false;
        }
        session = found;
        clearTimeout(helloTimer);
        session.sockets.add(socket);
        return true;
      }
      const current = session;
      // Answer in order: an agent's client may pipeline calls.
      queue = queue.then(async () => {
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`);
          return;
        }
        const response = await current.handle(message);
        if (response && !socket.destroyed) socket.write(`${JSON.stringify(response)}\n`);
      });
      return true;
    };
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    socketPath,
    openSession(handler) {
      const token = randomBytes(32).toString("hex");
      const entry: SessionEntry = {
        tokenBytes: Buffer.from(token, "utf8"),
        handle: createMcpMessageHandler(handler, options.serverVersion),
        sockets: new Set(),
      };
      sessions.set(token, entry);
      return {
        token,
        env: { [RELAY_SOCKET_ENV]: socketPath, [RELAY_TOKEN_ENV]: token },
        connectionCount: () => entry.sockets.size,
        dispose() {
          sessions.delete(token);
          for (const s of entry.sockets) s.destroy();
          entry.sockets.clear();
        },
      };
    },
    async close() {
      for (const entry of sessions.values()) for (const s of entry.sockets) s.destroy();
      sessions.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (socketDir) rmSync(socketDir, { recursive: true, force: true });
    },
  };
}
