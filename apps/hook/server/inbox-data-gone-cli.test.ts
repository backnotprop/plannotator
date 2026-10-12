/**
 * `plannotator inbox` as a process: an Inbox whose data folder is removed
 * (an e2e's temp dir, cleaned up while the Inbox it started still runs) exits
 * on its own instead of running on headless, with or without `--tailscale`
 * (a fake `tailscale` inside the world, removed with it), and never makes the
 * folder again. The CLI from source, or the compiled binary when
 * PLANNOTATOR_INBOX_TEST_BINARY names one. Temp worlds only; the real
 * `tailscale` never runs; only the pids these tests started are signalled.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { INBOX_DATA_CHECK_MS } from "@plannotator/server/inbox";
import { isPidAlive } from "@plannotator/shared/inbox/registry";
import { createInboxWorld, registry, removeStubbedHtml, stubBuiltHtml, worldEnv, type InboxWorld } from "../../../tests/helpers/inbox-world";

const worlds: InboxWorld[] = [];
const pids = new Set<number>();
let stubs: string[] = [];

afterEach(() => {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // gone
    }
  }
  pids.clear();
  for (const w of worlds.splice(0)) rmSync(w.root, { recursive: true, force: true });
  removeStubbedHtml(stubs.splice(0));
});

/** `tailscale` as a script in the world: the owner, an empty serve config, serve on and off. Removed with the world. */
function fakeTailscale(w: InboxWorld): void {
  const script = [
    "#!/bin/sh",
    'case "$1 $2" in',
    `  "status --json") echo '{"Self":{"DNSName":"box.tail0000.ts.net.","UserID":1},"User":{"1":{"LoginName":"owner@example.com"}}}'; exit 0;;`,
    `  "serve status") echo '{}'; exit 0;;`,
    "esac",
    'for a in "$@"; do case "$a" in --https=*) P="${a#--https=}";; esac; done',
    'case "$*" in *--bg*) echo "https://box.tail0000.ts.net:$P/"; exit 0;; *off*) exit 0;; esac',
    "exit 2",
  ].join("\n");
  writeFileSync(join(w.bin, "tailscale"), `${script}\n`);
  chmodSync(join(w.bin, "tailscale"), 0o755);
}

function startBackground(w: InboxWorld, args: string[]): number {
  const run = Bun.spawnSync([join(w.bin, "plannotator"), "inbox", "--background", ...args], {
    env: { ...process.env, ...worldEnv(w), PLANNOTATOR_INBOX_TAILSCALE: "" },
    cwd: w.root,
  });
  expect(run.exitCode, run.stderr.toString()).toBe(0);
  const { pid } = registry(w);
  pids.add(pid);
  return pid;
}

async function exitsWithin(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await Bun.sleep(100);
  }
  return !isPidAlive(pid);
}

describe("plannotator inbox: the data folder removed while it runs", () => {
  for (const args of [[], ["--tailscale"]]) {
    test(`${["inbox", "--background", ...args].join(" ")}: the Inbox exits within two checks and the folder stays removed`, async () => {
      stubs = stubBuiltHtml();
      const w = createInboxWorld("plannotator-inbox-data-gone-", "data-gone", "data-gone");
      worlds.push(w);
      if (args.includes("--tailscale")) fakeTailscale(w);
      const pid = startBackground(w, args);
      expect(isPidAlive(pid)).toBe(true);
      if (args.includes("--tailscale")) expect(registry(w)).toMatchObject({ tailscale: { url: expect.stringContaining("box.tail0000.ts.net") } });

      rmSync(w.root, { recursive: true, force: true });
      // Two misses in a row, plus slack for a loaded machine.
      expect(await exitsWithin(pid, 3 * INBOX_DATA_CHECK_MS)).toBe(true);
      expect(existsSync(w.root)).toBe(false);
    }, 60_000);
  }
});
