import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentJobHandler } from "./agent-jobs";

const originalPath = process.env.PATH;
const tempDirs: string[] = [];

function makeFakeCli(name: string): void {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-agent-jobs-"));
  const path = join(dir, name);
  writeFileSync(path, "#!/bin/sh\nexit 0\n", "utf-8");
  chmodSync(path, 0o755);
  tempDirs.push(dir);
  process.env.PATH = [dir, originalPath].filter(Boolean).join(":");
}

afterEach(() => {
  process.env.PATH = originalPath;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("agent job auth", () => {
  test("rejects launch requests without the session token", async () => {
    makeFakeCli("codex");

    const handler = createAgentJobHandler({
      mode: "review",
      getServerUrl: () => "http://localhost:19432",
      getCwd: () => process.cwd(),
      authToken: "session-token",
    });

    const req = new Request("http://localhost/api/agents/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "codex",
        command: ["/usr/bin/true"],
        label: "Injected",
      }),
    });

    const res = await handler.handle(req, new URL(req.url));
    expect(res?.status).toBe(403);
    expect(await res?.json()).toEqual({ error: "Unauthorized agent job request" });
  });

  test("accepts authenticated launch requests and preserves raw commands when no builder is configured", async () => {
    makeFakeCli("codex");

    const handler = createAgentJobHandler({
      mode: "review",
      getServerUrl: () => "http://localhost:19432",
      getCwd: () => process.cwd(),
      authToken: "session-token",
    });

    const req = new Request("http://localhost/api/agents/jobs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Plannotator-Agent-Token": "session-token",
      },
      body: JSON.stringify({
        provider: "codex",
        command: ["/usr/bin/true"],
        label: "Shell-compatible codex wrapper",
      }),
    });

    const res = await handler.handle(req, new URL(req.url));
    expect(res?.status).toBe(201);

    const payload = await res?.json() as { job: { command: string[]; label: string } };
    expect(payload.job.command).toEqual(["/usr/bin/true"]);
    expect(payload.job.label).toBe("Shell-compatible codex wrapper");

    handler.killAll();
  });
});
