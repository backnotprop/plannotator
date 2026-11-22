/**
 * Bun servers: the network key over SSH (#956). Scenarios are shared with the
 * Pi mirror (apps/pi-extension/server/network-key.test.ts). Also the Bun-only
 * places the key goes: the ready line's link for another computer (a person's
 * terminal only), the ready file, and the session registry (never).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { networkKeyCookieName, resetNetworkKeysForTests, setThisMachineForTests } from "@plannotator/shared/network-key";
import { createTestEnvironment } from "../../tests/helpers/environment";
import { defineNetworkKeyScenarios } from "./network-key.scenarios";
import { startPlannotatorServer } from "./index";
import { startAnnotateServer } from "./annotate";
import { startReviewServer } from "./review";
import { buildAnotherComputerUrl } from "./remote";
import { handleServerReady } from "./shared-handlers";
import { registerSession, unregisterSession } from "./sessions";

const PATCH = "diff --git a/notes.md b/notes.md\n--- a/notes.md\n+++ b/notes.md\n@@ -1 +1 @@\n-a\n+# Notes\n";

defineNetworkKeyScenarios(
  "bun",
  async (kind, { root, docPath, htmlContent }) => {
    if (kind === "review") return startReviewServer({ rawPatch: PATCH, gitRef: "HEAD", htmlContent, agentCwd: root });
    if (kind === "plan") return startPlannotatorServer({ plan: "# Plan\n\nSteps", origin: "claude-code", htmlContent });
    return startAnnotateServer({ markdown: "# Notes\n", filePath: docPath, htmlContent, mode: "annotate" });
  },
  { setThisMachineForTests, resetNetworkKeysForTests, networkKeyCookieName },
);

describe("bun: where the keyed link goes", () => {
  const environment = createTestEnvironment(
    ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_REMOTE", "PLANNOTATOR_URL_HOST", "PLANNOTATOR_PUBLIC_URL", "PLANNOTATOR_BROWSER", "SSH_TTY", "SSH_CONNECTION"],
    "plannotator-network-key-ready-",
  );
  let dataDir = "";
  const isTTY = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
  const write = process.stderr.write;

  function isolate(ssh = true): void {
    environment.reset();
    resetNetworkKeysForTests();
    dataDir = join(environment.makeTempDir(), "data");
    process.env.PLANNOTATOR_DATA_DIR = dataDir;
    process.env.PLANNOTATOR_BROWSER = "/usr/bin/true";
    if (ssh) process.env.SSH_CONNECTION = "10.0.0.2 51000 10.0.0.1 22";
    else process.env.PLANNOTATOR_REMOTE = "1";
    setThisMachineForTests({ addresses: ["10.0.0.1"] });
  }

  afterEach(() => {
    process.stderr.write = write;
    if (isTTY) Object.defineProperty(process.stderr, "isTTY", isTTY);
    else delete (process.stderr as { isTTY?: boolean }).isTTY;
    setThisMachineForTests(null);
    resetNetworkKeysForTests();
    environment.restore();
  });

  async function readyOutput(url: string, tty: boolean, readyFile?: string): Promise<string> {
    let out = "";
    Object.defineProperty(process.stderr, "isTTY", { value: tty, configurable: true });
    process.stderr.write = ((chunk: string | Uint8Array) => {
      out += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      await handleServerReady(url, true, 19432, { skipBrowserOpen: true, ...(readyFile ? { readyFile } : {}) });
    } finally {
      process.stderr.write = write;
    }
    return out;
  }

  const key = () => readFileSync(join(dataDir, "network-key"), "utf8").trim();

  test("a person's terminal gets the link for another computer under the forwarding line", async () => {
    isolate();
    const out = await readyOutput("http://localhost:19432", true);
    expect(out).toContain("  Plannotator session ready: http://localhost:19432\n");
    expect(out).toContain("  Open it on your local machine (forward port 19432 if needed).\n");
    expect(out).toContain(`  From another computer: http://10.0.0.1:19432/?key=${key()}\n`);
  });

  test("an agent's Bash call, a hook or a plugin (no TTY) gets the ready lines exactly as before, no key", async () => {
    isolate();
    const dir = environment.makeTempDir();
    const readyFile = join(dir, "ready.jsonl");
    const out = await readyOutput("http://localhost:19432", false, readyFile);
    expect(out).not.toContain("From another computer");
    expect(out).not.toContain("key=");
    const ready = readFileSync(readyFile, "utf8");
    expect(ready).not.toContain("key=");
    if (process.platform !== "win32") expect(statSync(readyFile).mode & 0o777).toBe(0o600);
  });

  test("no extra link when the SSH address is not this machine's any more, or outside an SSH-only session", async () => {
    isolate();
    setThisMachineForTests({ addresses: ["10.0.0.7"] });
    expect(buildAnotherComputerUrl(19432, "http://localhost:19432")).toBeNull();
    expect(await readyOutput("http://localhost:19432", true)).not.toContain("From another computer");
    environment.restore();
    isolate(false);
    expect(buildAnotherComputerUrl(19432, "http://localhost:19432")).toBeNull();
  });

  test("a URL another computer opens directly is the link itself: no second line", async () => {
    isolate();
    expect(buildAnotherComputerUrl(19432, "http://devbox:19432/?key=x")).toBeNull();
  });

  test("the session registry never holds the key", () => {
    isolate();
    const k = "Q".repeat(43);
    registerSession({ pid: process.pid, port: 19432, url: `http://devbox:19432/?key=${k}`, mode: "plan", project: "p", startedAt: new Date().toISOString(), label: "x" } as Parameters<typeof registerSession>[0]);
    try {
      const folder = join(dataDir, "sessions");
      const files = readdirSync(folder).filter((name) => name.endsWith(".json"));
      expect(files.length).toBe(1);
      const body = readFileSync(join(folder, files[0]!), "utf8");
      expect(body).not.toContain(k);
      expect(JSON.parse(body).url).toBe("http://devbox:19432/");
    } finally {
      unregisterSession();
    }
  });
});
