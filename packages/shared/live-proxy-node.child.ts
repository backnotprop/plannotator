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
  const { name, message } = error instanceof Error ? error : new Error(String(error));
  process.stdout.write(JSON.stringify({ error: { name, message } }) + "\n");
  process.exitCode = 3;
}
