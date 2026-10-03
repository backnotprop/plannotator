import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("createAIRuntime (Bun) with a session bridge", () => {
  // Runs in a child with a PATH holding no agent CLIs, so no SDK provider can
  // spawn anything while the bridge is exercised.
  test("registers the bridge after the SDK providers and detaches it before teardown", async () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "plannotator-bridge-runtime-"));
    tempDirs.push(dir);
    const runner = join(dir, "runner.ts");
    const runtimeUrl = pathToFileURL(join(import.meta.dir, "ai-runtime.ts")).href;
    writeFileSync(runner, `
      import { createAIRuntime } from ${JSON.stringify(runtimeUrl)};
      const asks = [];
      const bridge = {
        host: "opencode",
        modes: { turn: true, transient: false },
        status: () => "ready",
        ask: (req, sink, signal) => asks.push({ req, sink, signal }),
      };
      const runtime = await createAIRuntime({ cwd: ${JSON.stringify(dir)}, sessionBridge: bridge });
      const caps = await (await runtime.endpoints["/api/ai/capabilities"](
        new Request("http://localhost/api/ai/capabilities"),
      )).json();
      const created = await (await runtime.endpoints["/api/ai/session"](new Request("http://localhost/api/ai/session", {
        method: "POST",
        body: JSON.stringify({ providerId: "session-bridge", context: { mode: "code-review", review: { patch: "" } } }),
      }))).json();
      const query = runtime.endpoints["/api/ai/query"](new Request("http://localhost/api/ai/query", {
        method: "POST",
        body: JSON.stringify({ sessionId: created.sessionId, prompt: "q" }),
      }));
      const response = await query;
      const reader = response.body.getReader();
      void reader.read();
      while (asks.length === 0) await new Promise((r) => setTimeout(r, 2));
      runtime.dispose();
      await new Promise((r) => setTimeout(r, 10));
      const bridgeEntry = caps.providers.find((p) => p.id === "session-bridge");
      console.log(JSON.stringify({
        last: caps.providers.at(-1).id,
        defaultIsBridge: caps.defaultProvider === "session-bridge" && caps.providers.length > 1,
        label: bridgeEntry.label,
        status: bridgeEntry.sessionBridge.status,
        hostSignalAborted: asks[0].signal.aborted,
      }));
    `);
    const proc = Bun.spawn([process.execPath, runner], {
      cwd: import.meta.dir,
      env: { ...process.env, PATH: `${dir}:/usr/bin:/bin` },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(exitCode, stderr).toBe(0);
    expect(JSON.parse(stdout.trim().split("\n").at(-1)!)).toEqual({
      last: "session-bridge",
      defaultIsBridge: false,
      label: "Ask this session · OpenCode",
      status: "ready",
      // Teardown (a decision or exit) must not stop a turn the session runs for us.
      hostSignalAborted: false,
    });
  }, 15_000);
});
