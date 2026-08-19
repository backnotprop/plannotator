import { expect, test } from "bun:test";
import type { PRMetadata } from "@plannotator/shared/pr-types";
import type { WorktreePool } from "@plannotator/shared/worktree-pool";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SPA_HTML = "<!doctype html><html><body>test</body></html>";
const ISOLATED_CHILD_ENV = "PLANNOTATOR_AI_DISABLED_TEST_CHILD";

interface RunningServer {
  readonly url: string;
  stop(): void;
}

async function verifyDisabledAIEndpoints(server: RunningServer): Promise<void> {
  const aiCapabilitiesResponse = await fetch(`${server.url}/api/ai/capabilities`);
  expect(aiCapabilitiesResponse.status).toBe(200);
  expect(await aiCapabilitiesResponse.json()).toEqual({
    available: false,
    providers: [],
  });

  const aiQueryResponse = await fetch(`${server.url}/api/ai/query`, { method: "POST" });
  expect(aiQueryResponse.status).toBe(503);
  expect(await aiQueryResponse.json()).toEqual({
    error: "AI backend not available",
  });
}

async function verifyDisabledReviewServer(server: RunningServer): Promise<void> {
  const diffResponse = await fetch(`${server.url}/api/diff`);
  expect(diffResponse.status).toBe(200);
  const diff = await diffResponse.json() as Record<string, unknown>;
  expect(diff.aiEnabled).toBe(false);
  expect("aiReviewContext" in diff).toBe(false);

  await verifyDisabledAIEndpoints(server);

  const agentCapabilitiesResponse = await fetch(`${server.url}/api/agents/capabilities`);
  expect(agentCapabilitiesResponse.status).toBe(200);
  expect(await agentCapabilitiesResponse.json()).toEqual({
    mode: "review",
    providers: [],
    available: false,
  });

  const launchResponse = await fetch(`${server.url}/api/agents/jobs`, { method: "POST" });
  expect(launchResponse.status).toBe(503);
  expect(await launchResponse.json()).toEqual({
    error: "AI features disabled",
  });
}

async function verifyDisabledServers(): Promise<void> {
  process.env.PLANNOTATOR_AI = "disabled";
  process.env.PLANNOTATOR_REMOTE = "0";
  delete process.env.PLANNOTATOR_PORT;

  const servers: RunningServer[] = [];
  let worktreeEnsureCalls = 0;
  try {
    const [
      { startAnnotateServer: startBunAnnotateServer },
      { startPlannotatorServer: startBunPlanServer },
      { startReviewServer: startBunReviewServer },
      {
        startAnnotateServer: startPiAnnotateServer,
        startPlanReviewServer: startPiPlanServer,
        startReviewServer: startPiReviewServer,
      },
    ] = await Promise.all([
      import("./annotate"),
      import("./index"),
      import("./review"),
      import("../../apps/pi-extension/server"),
    ]);

    servers.push(await startBunReviewServer({
      rawPatch: "",
      gitRef: "HEAD",
      origin: "claude-code",
      htmlContent: SPA_HTML,
    }));
    servers.push(await startPiReviewServer({
      rawPatch: "",
      gitRef: "HEAD",
      origin: "pi",
      htmlContent: SPA_HTML,
    }));

    for (const server of servers) {
      await verifyDisabledReviewServer(server);
    }

    const nonReviewServers = [
      await startBunPlanServer({
        plan: "# Test Plan",
        origin: "claude-code",
        htmlContent: SPA_HTML,
      }),
      await startBunAnnotateServer({
        markdown: "# Test Document",
        filePath: "test.md",
        origin: "claude-code",
        htmlContent: SPA_HTML,
      }),
      await startPiPlanServer({
        plan: "# Test Plan",
        origin: "pi",
        htmlContent: SPA_HTML,
      }),
      await startPiAnnotateServer({
        markdown: "# Test Document",
        filePath: "test.md",
        origin: "pi",
        htmlContent: SPA_HTML,
      }),
    ];
    servers.push(...nonReviewServers);
    for (const server of nonReviewServers) {
      await verifyDisabledAIEndpoints(server);
    }

    const prMetadata: PRMetadata = {
      platform: "github",
      host: "github.com",
      owner: "example",
      repo: "repo",
      number: 1,
      title: "Test PR",
      author: "reviewer",
      baseBranch: "main",
      headBranch: "feature",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      url: "https://github.com/example/repo/pull/1",
    };
    const worktreePool: WorktreePool = {
      get: () => undefined,
      has: () => false,
      resolve: () => undefined,
      ensure: async () => {
        worktreeEnsureCalls += 1;
        throw new Error("disabled AI must not prepare a worktree");
      },
      entries: function* () {},
      cleanup: async () => {},
    };
    const piPRServer = await startPiReviewServer({
      rawPatch: "",
      gitRef: "HEAD",
      origin: "pi",
      htmlContent: SPA_HTML,
      prMetadata,
      worktreePool,
    });
    servers.push(piPRServer);

    const disabledSessionResponse = await fetch(`${piPRServer.url}/api/ai/session`, {
      method: "POST",
    });
    expect(disabledSessionResponse.status).toBe(503);
    expect(worktreeEnsureCalls).toBe(0);
  } finally {
    for (const server of servers) server.stop();
  }
}

async function runInIsolatedDataDirectory(): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "plannotator-ai-disabled-"));
  const childEnv = {
    ...process.env,
    [ISOLATED_CHILD_ENV]: "1",
    PLANNOTATOR_AI: "disabled",
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_REMOTE: "0",
  };
  delete childEnv.PLANNOTATOR_PORT;

  try {
    // storage.ts captures PLANNOTATOR_DATA_DIR at module load, so a child
    // process is required to keep this test isolated regardless of which
    // test files Bun evaluated first in the parent process.
    const child = Bun.spawn(
      [process.execPath, "test", fileURLToPath(import.meta.url)],
      {
        cwd: process.cwd(),
        env: childEnv,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (exitCode !== 0) {
      throw new Error(
        `Isolated disabled-AI test failed (${exitCode})\n${stdout}\n${stderr}`,
      );
    }
    expect(existsSync(join(dataDir, "history"))).toBe(true);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

test("PLANNOTATOR_AI=disabled disables AI across server surfaces", async () => {
  if (process.env[ISOLATED_CHILD_ENV] === "1") {
    await verifyDisabledServers();
    return;
  }
  await runInIsolatedDataDirectory();
}, 20_000);
