import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { INBOX_DATA_CHECK_MS } from "@plannotator/server/inbox";
import { isPidAlive } from "@plannotator/shared/inbox/registry";
import { type InboxEntry, inboxEntryOf, stopProvenInboxes } from "../../../tests/helpers/inbox-process";
import { createInboxWorld, registry, removeStubbedHtml, stubBuiltHtml, worldEnv, type InboxWorld } from "../../../tests/helpers/inbox-world";

const worlds: InboxWorld[] = [];
const started: { entry: InboxEntry; root: string }[] = [];
let stubs: string[] = [];

afterEach(async () => {
  await stopProvenInboxes(started.splice(0), { signal: "SIGKILL" });
  for (const w of worlds.splice(0)) rmSync(w.root, { recursive: true, force: true });
  removeStubbedHtml(stubs.splice(0));
});

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
  const entry = inboxEntryOf(w.dataDir);
  if (entry) started.push({ entry, root: w.root });
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
      expect(await exitsWithin(pid, 3 * INBOX_DATA_CHECK_MS)).toBe(true);
      expect(existsSync(w.root)).toBe(false);
    }, 60_000);
  }
});
