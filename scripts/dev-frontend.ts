#!/usr/bin/env bun

import { $ } from "bun";
import path from "path";

const entry = "apps/hook/server/index.ts";
const frontendDir = path.resolve(import.meta.dirname!, "../apps/frontend");

console.log("[dev] Stopping existing daemon...");
await $`bun run ${entry} daemon stop`.quiet().nothrow();

console.log("[dev] Starting daemon from source...");
const start = await $`bun run ${entry} daemon start`.quiet().nothrow();
const output = start.stdout.toString().trim();

try {
  const result = JSON.parse(output);
  const url = result.status?.endpoint?.baseUrl ?? result.browserUrl ?? "unknown";
  console.log(`[dev] Daemon running at ${url}`);
} catch {
  console.log("[dev] Daemon started");
}

console.log("[dev] Starting frontend dev server...");
console.log("[dev] Press Ctrl+C to stop everything\n");

const frontend = Bun.spawn(["bun", "run", "dev"], {
  cwd: frontendDir,
  stdio: ["inherit", "inherit", "inherit"],
});

process.on("SIGINT", async () => {
  frontend.kill();
  console.log("\n[dev] Stopping daemon...");
  await $`bun run ${entry} daemon stop`.quiet().nothrow();
  process.exit(0);
});

await frontend.exited;
