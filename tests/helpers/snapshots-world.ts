/**
 * A REAL Plannotator Snapshots hub for host proofs, started the way a person's
 * `plannotator snapshot` starts it: `plannotator snapshot hub --background`
 * through the world's `plannotator` wrapper (the compiled binary when
 * PLANNOTATOR_INBOX_TEST_BINARY names one, the CLI from source otherwise),
 * under the world's temp HOME and PLANNOTATOR_DATA_DIR. The native app never
 * runs: the world's HOME has no ~/Applications app and neither build embeds
 * one (only index-darwin.ts does), so the test plays the HUD through the hub
 * API (attach, capture a PNG, Send, Ask) with `snapshotsHubClient`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type InboxWorld, worldEnv } from "./inbox-world";
import { snapshotsHubClient, type SnapshotsHubClient } from "./snapshots-hub";

export interface CliSnapshotsHub extends SnapshotsHubClient {
  pid: number;
  token: string;
}

function registryFile(w: InboxWorld): string {
  return join(w.dataDir, "snapshots", "hub.json");
}

/** `plannotator snapshot hub --background` in the world; returns the HUD's view of it. */
export async function startCliSnapshotsHub(w: InboxWorld): Promise<CliSnapshotsHub> {
  const run = Bun.spawnSync([join(w.bin, "plannotator"), "snapshot", "hub", "--background"], {
    env: { ...process.env, ...worldEnv(w) },
    cwd: w.root,
  });
  if (run.exitCode !== 0) throw new Error(`snapshot hub --background failed: ${run.stderr.toString()}`);
  const entry = JSON.parse(readFileSync(registryFile(w), "utf8")) as { pid: number; url: string; token: string };
  const client = await snapshotsHubClient(entry.url, entry.token);
  w.proof(`> plannotator snapshot hub --background\n${entry.url} (pid ${entry.pid})\n`);
  return { ...client, pid: entry.pid, token: entry.token };
}

/** Stop the world's hub (SIGKILL; only the process this world started). */
export function stopCliSnapshotsHub(w: InboxWorld): void {
  const file = registryFile(w);
  if (!existsSync(file)) return;
  try {
    process.kill(JSON.parse(readFileSync(file, "utf8")).pid, "SIGKILL");
  } catch {
    // gone
  }
}
