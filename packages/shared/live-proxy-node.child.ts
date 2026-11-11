/**
 * Test-only child entry for live-proxy-node.test.ts: hosts the Node live proxy in a REAL node process, because Bun's node:http shim never writes an 'upgrade' socket's data to the wire, so an in-process proxy would fail or mask WS passthrough.
 * Env: LIVE_PROXY_TARGET (required upstream origin), LIVE_PROXY_EDITOR_ORIGINS (comma-separated), LIVE_PROXY_BRIDGE (bridge body). Prints one JSON line { port } once listening, or { error: { name, message } } when the start fails, then exits with code 3 once nothing is left open.
 */

import { startLiveAppProxyNode } from "./live-proxy-node";

const targetUrl = process.env.LIVE_PROXY_TARGET;
if (!targetUrl) {
  throw new Error("LIVE_PROXY_TARGET is required");
}

try {
  const proxy = await startLiveAppProxyNode({
    targetUrl,
    editorOrigins: (process.env.LIVE_PROXY_EDITOR_ORIGINS ?? "").split(",").filter(Boolean),
    bridgeJs: process.env.LIVE_PROXY_BRIDGE ?? "// bridge",
  });
  process.stdout.write(JSON.stringify({ port: proxy.port }) + "\n");
} catch (error) {
  // A failed start is reported, and the process is left to end by itself:
  // it exits only if the failed start left no listener (or other handle)
  // open, which is what the port tests check.
  const { name, message } = error instanceof Error ? error : new Error(String(error));
  process.stdout.write(JSON.stringify({ error: { name, message } }) + "\n");
  process.exitCode = 3;
}
