#!/usr/bin/env bun

import { appendFileSync } from "node:fs";

await Bun.stdin.text();

const port = Number(process.env.PLANNOTATOR_PORT);
if (!Number.isInteger(port) || port < 1) {
  throw new Error("PLANNOTATOR_PORT must contain a fixed test port");
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch: () => Response.json({ plan: "# CLI fixture" }),
});

const readyFile = process.env.PLANNOTATOR_READY_FILE;
if (readyFile) {
  appendFileSync(readyFile, `${JSON.stringify({
    url: `http://localhost:${port}`,
    isRemote: false,
    port,
  })}\n`, "utf8");
}

if (process.env.PLANNOTATOR_TEST_CLI_MODE === "fail-after-ready") {
  setTimeout(() => {
    server.stop(true);
    console.error("fixture failed after binding");
    process.exit(2);
  }, 300);
}

const stop = () => {
  server.stop(true);
  process.exit(143);
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

await new Promise(() => {});
