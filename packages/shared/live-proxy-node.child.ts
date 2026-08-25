/**
 * Test-only child entry for live-proxy-node.test.ts.
 *
 * Hosts the Node live proxy in a REAL node process: the transport's runtime
 * is node:http under Pi (jiti on Node), and Bun's node:http shim differs in
 * exactly the place that matters most here — writes to an 'upgrade' event's
 * socket never reach the wire under the shim (verified against Bun 1.x),
 * so an in-process proxy under `bun test` would fail WS passthrough that
 * works in production and vice versa could mask real breakage. The suite
 * builds this file with Bun.build, launches it under `node`, and drives the
 * proxy over the wire.
 *
 * Env contract: LIVE_PROXY_TARGET (required upstream origin),
 * LIVE_PROXY_EDITOR_ORIGINS (comma-separated), LIVE_PROXY_BRIDGE (bridge
 * body). Prints one JSON line { port } once listening, then stays alive
 * until killed.
 */

import { startLiveAppProxyNode } from "./live-proxy-node";

const targetUrl = process.env.LIVE_PROXY_TARGET;
if (!targetUrl) {
  throw new Error("LIVE_PROXY_TARGET is required");
}

const proxy = await startLiveAppProxyNode({
  targetUrl,
  editorOrigins: (process.env.LIVE_PROXY_EDITOR_ORIGINS ?? "").split(",").filter(Boolean),
  bridgeJs: process.env.LIVE_PROXY_BRIDGE ?? "// bridge",
});

process.stdout.write(JSON.stringify({ port: proxy.port }) + "\n");
