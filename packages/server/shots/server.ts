/**
 * The standalone Plannotator Shots hub process (`plannotator screenshot hub`):
 * `createShotsHub` on its own loopback Bun server, registered in
 * `shots/hub.json`. Inside another long-lived Plannotator process the hub
 * would be mounted with `createShotsHub` directly instead.
 */

import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { createServerSessionNonce } from "@plannotator/core/server-session";
import { createShotsToken, readShotsRegistry, shotsDir, writeShotsRegistry, type ShotsHubEntry } from "@plannotator/shared/shots/registry";
import { createShotsHub, type ShotsHub } from "./hub";

const LOOPBACK = "127.0.0.1";
/** Remote mode's fixed port is never taken. */
const FORBIDDEN_PORT = 19432;

export interface StartShotsHubOptions {
  dataDir: string;
  version: string;
  htmlContent?: string;
  cli: string[];
  onStop?: () => void;
}

export interface ShotsHubServer {
  entry: ShotsHubEntry;
  hub: ShotsHub;
  stop(): void;
}

export function startShotsHubServer(options: StartShotsHubOptions): ShotsHubServer {
  const token = createShotsToken();
  const serverSession = createServerSessionNonce();
  const logPath = join(shotsDir(options.dataDir), "hub.log");
  const log = (line: string) => {
    try {
      appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
    } catch {
      // Logging never breaks the hub.
    }
  };
  let port: number | undefined;
  const hub = createShotsHub({
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
  const previous = readShotsRegistry(options.dataDir)?.port;
  try {
    server = serve(previous && previous !== FORBIDDEN_PORT ? previous : 0);
  } catch {
    server = serve(0);
  }
  const bound = server.port as number;
  port = bound;
  const entry: ShotsHubEntry = {
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
  writeShotsRegistry(options.dataDir, entry);
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
