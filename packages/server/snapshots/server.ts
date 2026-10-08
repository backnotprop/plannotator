/**
 * The standalone Plannotator Snapshots hub process (`plannotator snapshot hub`):
 * `createSnapshotsHub` on its own loopback Bun server, registered in
 * `snapshots/hub.json`. Inside another long-lived Plannotator process the hub
 * would be mounted with `createSnapshotsHub` directly instead.
 */

import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { createServerSessionNonce } from "@plannotator/core/server-session";
import { createSnapshotsToken, readSnapshotsRegistry, snapshotsDir, writeSnapshotsRegistry, type SnapshotsHubEntry } from "@plannotator/shared/snapshots/registry";
import { createSnapshotsHub, type SnapshotsHub } from "./hub";

const LOOPBACK = "127.0.0.1";
/** Remote mode's fixed port is never taken. */
const FORBIDDEN_PORT = 19432;

export interface StartSnapshotsHubOptions {
  dataDir: string;
  version: string;
  htmlContent?: string;
  cli: string[];
  onStop?: () => void;
}

export interface SnapshotsHubServer {
  entry: SnapshotsHubEntry;
  hub: SnapshotsHub;
  stop(): void;
}

export function startSnapshotsHubServer(options: StartSnapshotsHubOptions): SnapshotsHubServer {
  const token = createSnapshotsToken();
  const serverSession = createServerSessionNonce();
  const logPath = join(snapshotsDir(options.dataDir), "hub.log");
  const log = (line: string) => {
    try {
      appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
    } catch {
      // Logging never breaks the hub.
    }
  };
  let port: number | undefined;
  const hub = createSnapshotsHub({
    dataDir: options.dataDir,
    version: options.version,
    token,
    serverSession,
    htmlContent: options.htmlContent,
    getPort: () => port,
    onStop: options.onStop,
    log,
  });
  const serve = (preferred: number) =>
    Bun.serve({ hostname: LOOPBACK, port: preferred, idleTimeout: 0, fetch: (req) => hub.handle(req) });
  let server: ReturnType<typeof Bun.serve>;
  const previous = readSnapshotsRegistry(options.dataDir)?.port;
  try {
    server = serve(previous && previous !== FORBIDDEN_PORT ? previous : 0);
  } catch {
    server = serve(0);
  }
  const bound = server.port as number;
  port = bound;
  const entry: SnapshotsHubEntry = {
    v: 1,
    pid: process.pid,
    port: bound,
    url: `http://${LOOPBACK}:${bound}`,
    version: options.version,
    token,
    serverSession,
    startedAt: new Date().toISOString(),
    cli: options.cli,
  };
  writeSnapshotsRegistry(options.dataDir, entry);
  log(`hub started on ${entry.url} (pid ${process.pid})`);
  return {
    entry,
    hub,
    stop() {
      hub.dispose();
      server.stop(true);
    },
  };
}
