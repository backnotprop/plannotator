import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("createAIRuntime Codex discovery", () => {
  test("capabilities does not execute Codex and session activation does", async () => {
    if (process.platform === "win32") return;

    const dir = mkdtempSync(join(tmpdir(), "plannotator-lazy-codex-"));
    tempDirs.push(dir);
    const marker = join(dir, "codex-ran");
    const codex = join(dir, "codex");
    writeFileSync(codex, `#!/bin/sh\necho ran > '${marker}'\nexit 1\n`);
    chmodSync(codex, 0o755);

    const runner = join(dir, "runner.ts");
    const runtimeUrl = pathToFileURL(join(import.meta.dir, "ai-runtime.ts")).href;
    writeFileSync(runner, `
      import { existsSync } from "node:fs";
      import { createAIRuntime } from ${JSON.stringify(runtimeUrl)};
      const runtime = await createAIRuntime({ cwd: ${JSON.stringify(dir)} });
      const capabilities = await runtime.endpoints["/api/ai/capabilities"](
        new Request("http://localhost/api/ai/capabilities"),
      );
      const data = await capabilities.json();
      const afterCapabilities = existsSync(${JSON.stringify(marker)});
      const session = await runtime.endpoints["/api/ai/session"](
        new Request("http://localhost/api/ai/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            context: { mode: "plan-review", plan: { plan: "# Test" } },
            providerId: "codex-sdk",
          }),
        }),
      );
      console.log(JSON.stringify({
        hasCodex: data.providers.some((provider) => provider.id === "codex-sdk"),
        afterCapabilities,
        sessionStatus: session.status,
        afterSession: existsSync(${JSON.stringify(marker)}),
      }));
      runtime.dispose();
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
    expect(JSON.parse(stdout.trim())).toEqual({
      hasCodex: true,
      afterCapabilities: false,
      sessionStatus: 200,
      afterSession: true,
    });
  }, 15_000);

  test("capabilities?activate= runs discovery once and shares it with the session path", async () => {
    if (process.platform === "win32") return;

    const dir = mkdtempSync(join(tmpdir(), "plannotator-activate-codex-"));
    tempDirs.push(dir);
    const marker = join(dir, "codex-ran");
    const codex = join(dir, "codex");
    writeFileSync(codex, `#!/bin/sh\necho ran >> '${marker}'\nexit 1\n`);
    chmodSync(codex, 0o755);

    const runner = join(dir, "runner.ts");
    const runtimeUrl = pathToFileURL(join(import.meta.dir, "ai-runtime.ts")).href;
    writeFileSync(runner, `
      import { existsSync, readFileSync } from "node:fs";
      import { createAIRuntime } from ${JSON.stringify(runtimeUrl)};
      const runs = () => existsSync(${JSON.stringify(marker)})
        ? readFileSync(${JSON.stringify(marker)}, "utf8").trim().split("\\n").length
        : 0;
      const runtime = await createAIRuntime({ cwd: ${JSON.stringify(dir)} });
      const probe = await runtime.endpoints["/api/ai/capabilities"](
        new Request("http://localhost/api/ai/capabilities"),
      );
      const runsAfterProbe = runs();
      const activate = await runtime.endpoints["/api/ai/capabilities"](
        new Request("http://localhost/api/ai/capabilities?activate=codex-sdk"),
      );
      const runsAfterActivate = runs();
      const session = await runtime.endpoints["/api/ai/session"](
        new Request("http://localhost/api/ai/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            context: { mode: "plan-review", plan: { plan: "# Test" } },
            providerId: "codex-sdk",
          }),
        }),
      );
      console.log(JSON.stringify({
        probeStatus: probe.status,
        runsAfterProbe,
        activateStatus: activate.status,
        runsAfterActivate,
        sessionStatus: session.status,
        runsAfterSession: runs(),
      }));
      runtime.dispose();
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
    expect(JSON.parse(stdout.trim())).toEqual({
      probeStatus: 200,
      runsAfterProbe: 0,
      activateStatus: 200,
      runsAfterActivate: 1,
      sessionStatus: 200,
      runsAfterSession: 1,
    });
  }, 15_000);
});

describe("createAIRuntime Pi discovery", () => {
  // Pi's model discovery spawns `pi` and waits up to 10s for its answer. It
  // used to run at startup and hold every plain capabilities answer until it
  // finished; it now waits for ?activate= (or a session) like Codex.
  test("plain capabilities answers at once without spawning a slow pi; ?activate= spawns it", async () => {
    if (process.platform === "win32") return;

    const dir = mkdtempSync(join(tmpdir(), "plannotator-lazy-pi-"));
    tempDirs.push(dir);
    const marker = join(dir, "pi-ran");
    const pi = join(dir, "pi");
    writeFileSync(pi, `#!/bin/sh\necho ran >> '${marker}'\nsleep 5\n`);
    chmodSync(pi, 0o755);

    const runner = join(dir, "runner.ts");
    const runtimeUrl = pathToFileURL(join(import.meta.dir, "ai-runtime.ts")).href;
    writeFileSync(runner, `
      import { existsSync } from "node:fs";
      import { createAIRuntime } from ${JSON.stringify(runtimeUrl)};
      const runtime = await createAIRuntime({ cwd: ${JSON.stringify(dir)} });
      const startedAt = Date.now();
      const capabilities = await runtime.endpoints["/api/ai/capabilities"](
        new Request("http://localhost/api/ai/capabilities"),
      );
      const elapsedMs = Date.now() - startedAt;
      const data = await capabilities.json();
      const afterCapabilities = existsSync(${JSON.stringify(marker)});
      void runtime.endpoints["/api/ai/capabilities"](
        new Request("http://localhost/api/ai/capabilities?activate=pi-sdk"),
      );
      let afterActivate = false;
      for (let i = 0; i < 60 && !afterActivate; i++) {
        await Bun.sleep(50);
        afterActivate = existsSync(${JSON.stringify(marker)});
      }
      console.log(JSON.stringify({
        hasPi: data.providers.some((provider) => provider.id === "pi-sdk"),
        fast: elapsedMs < 2000,
        afterCapabilities,
        afterActivate,
      }));
      process.exit(0);
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
    expect(JSON.parse(stdout.trim())).toEqual({
      hasPi: true,
      fast: true,
      afterCapabilities: false,
      afterActivate: true,
    });
  }, 15_000);
});
