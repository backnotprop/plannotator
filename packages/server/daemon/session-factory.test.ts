import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { DaemonSessionStore } from "./session-store";
import { createDaemonSessionFactory } from "./session-factory";
import type { DaemonFetchContext } from "./server";

let dirs: string[] = [];
const originalHome = process.env.HOME;

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function run(command: string[], cwd: string): void {
  const result = Bun.spawnSync(command, { cwd, stdout: "ignore", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed: ${new TextDecoder().decode(result.stderr).trim()}`);
  }
}

afterEach(() => {
  process.env.HOME = originalHome;
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe("createDaemonSessionFactory", () => {
  test("creates a daemon-owned plan session and completes through the store", async () => {
    const home = tempDir("plannotator-daemon-home-");
    const cwd = tempDir("plannotator-daemon-cwd-");
    process.env.HOME = home;

    const store = new DaemonSessionStore({ now: () => 1_000 });
    const factory = createDaemonSessionFactory({
      planHtmlContent: "<html><head></head><body>Plan</body></html>",
      reviewHtmlContent: "<html><head></head><body>Review</body></html>",
    });
    const context: DaemonFetchContext = {
      endpoint: {
        hostname: "127.0.0.1",
        port: 4321,
        baseUrl: "http://127.0.0.1:4321",
        isRemote: false,
      },
      store,
    };

    const record = await factory({
      request: {
        action: "plan",
        origin: "opencode",
        cwd,
        plan: "# Test Plan\n\nDo the thing.",
        availableAgents: [
          { name: "build", description: "Build agent", mode: "primary" },
          { name: "hidden", mode: "primary", hidden: true },
          { name: "helper", mode: "subagent" },
        ],
      },
    }, context);

    expect(record.expiresAt).toBeDefined();
    expect(record.htmlContent).toBeUndefined();

    const planResponse = await record.handleRequest!(
      new Request("http://127.0.0.1:4321/api/plan"),
      new URL("http://127.0.0.1:4321/api/plan"),
    );
    const planBody = await planResponse.json();
    expect(planBody.plan).toContain("Do the thing.");
    expect(planBody.projectRoot).toBe(cwd);

    const agentsResponse = await record.handleRequest!(
      new Request("http://127.0.0.1:4321/api/agents"),
      new URL("http://127.0.0.1:4321/api/agents"),
    );
    const agentsBody = await agentsResponse.json();
    expect(agentsBody.agents).toEqual([{ id: "build", name: "build", description: "Build agent" }]);

    await record.handleRequest!(
      new Request("http://127.0.0.1:4321/api/approve", {
        method: "POST",
        body: JSON.stringify({ planSave: { enabled: false } }),
      }),
      new URL("http://127.0.0.1:4321/api/approve"),
    );

    const completed = await store.waitForResult<{ approved: boolean }>(record.id);
    expect(completed.status).toBe("completed");
    expect(completed.result?.approved).toBe(true);
  });

  test("cancelled daemon sessions settle decision watchers without becoming failed", async () => {
    const home = tempDir("plannotator-daemon-home-");
    const cwd = tempDir("plannotator-daemon-cwd-");
    process.env.HOME = home;

    const store = new DaemonSessionStore({ now: () => 1_000 });
    const factory = createDaemonSessionFactory({
      planHtmlContent: "<html><head></head><body>Plan</body></html>",
      reviewHtmlContent: "<html><head></head><body>Review</body></html>",
    });
    const context: DaemonFetchContext = {
      endpoint: {
        hostname: "127.0.0.1",
        port: 4321,
        baseUrl: "http://127.0.0.1:4321",
        isRemote: false,
      },
      store,
    };

    const record = await factory({
      request: {
        action: "plan",
        origin: "opencode",
        cwd,
        plan: "# Test Plan",
      },
    }, context);

    await store.cancel(record.id, "Caller exited.");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(store.get(record.id)?.status).toBe("cancelled");
    expect(store.get(record.id)?.error).toBe("Caller exited.");
  });

  test("uses request timeout for active session TTL and allows disabled timeout", async () => {
    const cwd = tempDir("plannotator-daemon-cwd-");
    const store = new DaemonSessionStore({ now: () => 1_000 });
    const factory = createDaemonSessionFactory({
      planHtmlContent: "<html><head></head><body>Plan</body></html>",
      reviewHtmlContent: "<html><head></head><body>Review</body></html>",
    });
    const context: DaemonFetchContext = {
      endpoint: {
        hostname: "127.0.0.1",
        port: 4321,
        baseUrl: "http://127.0.0.1:4321",
        isRemote: false,
      },
      store,
    };

    const timed = await factory({
      request: {
        action: "plan",
        origin: "opencode",
        cwd,
        plan: "# Timed",
        timeoutMs: 12_000,
      },
    }, context);
    expect(timed.expiresAt).toBe("1970-01-01T00:01:13.000Z");

    const noTimeout = await factory({
      request: {
        action: "plan",
        origin: "opencode",
        cwd,
        plan: "# Untimed",
        timeoutMs: null,
      },
    }, context);
    expect(noTimeout.expiresAt).toBeUndefined();
  });

  test("archive sessions reject approve and deny endpoints without throwing", async () => {
    const home = tempDir("plannotator-daemon-home-");
    const cwd = tempDir("plannotator-daemon-cwd-");
    process.env.HOME = home;

    const store = new DaemonSessionStore({ now: () => 1_000 });
    const factory = createDaemonSessionFactory({
      planHtmlContent: "<html><head></head><body>Archive</body></html>",
      reviewHtmlContent: "<html><head></head><body>Review</body></html>",
    });
    const context: DaemonFetchContext = {
      endpoint: {
        hostname: "127.0.0.1",
        port: 4321,
        baseUrl: "http://127.0.0.1:4321",
        isRemote: false,
      },
      store,
    };

    const record = await factory({
      request: {
        action: "archive",
        origin: "opencode",
        cwd,
      },
    }, context);

    const approve = await record.handleRequest!(
      new Request("http://127.0.0.1:4321/api/approve", { method: "POST", body: "{}" }),
      new URL("http://127.0.0.1:4321/api/approve"),
    );
    const deny = await record.handleRequest!(
      new Request("http://127.0.0.1:4321/api/deny", { method: "POST", body: "{}" }),
      new URL("http://127.0.0.1:4321/api/deny"),
    );

    expect(approve.status).toBe(404);
    expect((await approve.json()).error).toContain("Archive sessions");
    expect(deny.status).toBe(404);
    expect((await deny.json()).error).toContain("Archive sessions");
  });

  test("rejects daemon session requests without an explicit cwd", async () => {
    const store = new DaemonSessionStore();
    const factory = createDaemonSessionFactory({
      planHtmlContent: "<html><head></head><body>Plan</body></html>",
      reviewHtmlContent: "<html><head></head><body>Review</body></html>",
    });
    const context: DaemonFetchContext = {
      endpoint: {
        hostname: "127.0.0.1",
        port: 4321,
        baseUrl: "http://127.0.0.1:4321",
        isRemote: false,
      },
      store,
    };

    await expect(factory({
      request: {
        action: "plan",
        origin: "opencode",
        plan: "# Missing cwd",
      },
    }, context)).rejects.toThrow("Daemon session requests must include cwd.");
  });

  test("rejects plan file requests outside the session cwd", async () => {
    const cwd = tempDir("plannotator-daemon-cwd-");
    const outside = tempDir("plannotator-daemon-outside-");
    writeFileSync(join(outside, "secret.md"), "# Secret", "utf-8");
    const store = new DaemonSessionStore();
    const factory = createDaemonSessionFactory({
      planHtmlContent: "<html><head></head><body>Plan</body></html>",
      reviewHtmlContent: "<html><head></head><body>Review</body></html>",
    });
    const context: DaemonFetchContext = {
      endpoint: {
        hostname: "127.0.0.1",
        port: 4321,
        baseUrl: "http://127.0.0.1:4321",
        isRemote: false,
      },
      store,
    };

    await expect(factory({
      request: {
        action: "plan",
        origin: "opencode",
        cwd,
        planFilePath: join(outside, "secret.md"),
      },
    }, context)).rejects.toThrow("Plugin plan file must resolve inside cwd.");
  });

  test("rejects non-markdown plan file requests", async () => {
    const cwd = tempDir("plannotator-daemon-cwd-");
    writeFileSync(join(cwd, "PLAN.txt"), "# Plan", "utf-8");
    const store = new DaemonSessionStore();
    const factory = createDaemonSessionFactory({
      planHtmlContent: "<html><head></head><body>Plan</body></html>",
      reviewHtmlContent: "<html><head></head><body>Review</body></html>",
    });
    const context: DaemonFetchContext = {
      endpoint: {
        hostname: "127.0.0.1",
        port: 4321,
        baseUrl: "http://127.0.0.1:4321",
        isRemote: false,
      },
      store,
    };

    await expect(factory({
      request: {
        action: "plan",
        origin: "opencode",
        cwd,
        planFilePath: "PLAN.txt",
      },
    }, context)).rejects.toThrow("Plugin plan file must be a markdown file");
  });

  test("resolves relative plan save paths against the request cwd", async () => {
    const home = tempDir("plannotator-daemon-home-");
    const cwd = tempDir("plannotator-daemon-cwd-");
    process.env.HOME = home;

    const store = new DaemonSessionStore({ now: () => 1_000 });
    const factory = createDaemonSessionFactory({
      planHtmlContent: "<html><head></head><body>Plan</body></html>",
      reviewHtmlContent: "<html><head></head><body>Review</body></html>",
    });
    const context: DaemonFetchContext = {
      endpoint: {
        hostname: "127.0.0.1",
        port: 4321,
        baseUrl: "http://127.0.0.1:4321",
        isRemote: false,
      },
      store,
    };

    const record = await factory({
      request: {
        action: "plan",
        origin: "opencode",
        cwd,
        plan: "# Saved Plan\n\nStore this under the session cwd.",
      },
    }, context);

    const response = await record.handleRequest!(
      new Request("http://127.0.0.1:4321/api/approve", {
        method: "POST",
        body: JSON.stringify({ planSave: { enabled: true, customPath: "./plans" } }),
      }),
      new URL("http://127.0.0.1:4321/api/approve"),
    );
    const body = await response.json();

    expect(body.savedPath.startsWith(join(cwd, "plans"))).toBe(true);
    expect(existsSync(body.savedPath)).toBe(true);

    const completed = await store.waitForResult<{ savedPath?: string }>(record.id);
    expect(completed.result?.savedPath).toBe(body.savedPath);
  });

  test("returns remote share notices for the foreground client to print", async () => {
    const home = tempDir("plannotator-daemon-home-");
    const cwd = tempDir("plannotator-daemon-cwd-");
    process.env.HOME = home;

    const store = new DaemonSessionStore({ now: () => 1_000 });
    const factory = createDaemonSessionFactory({
      planHtmlContent: "<html><head></head><body>Plan</body></html>",
      reviewHtmlContent: "<html><head></head><body>Review</body></html>",
      shareBaseUrl: "https://share.example.test",
    });
    const context: DaemonFetchContext = {
      endpoint: {
        hostname: "0.0.0.0",
        port: 4321,
        baseUrl: "http://localhost:4321",
        isRemote: true,
      },
      store,
    };

    const record = await factory({
      request: {
        action: "plan",
        origin: "opencode",
        cwd,
        plan: "# Remote Plan\n\nOpen locally.",
      },
    }, context);

    expect(store.summary(record).remoteShare).toBeUndefined();
    const summary = store.summary(record, { includeRemoteShare: true });
    expect(summary.remoteShare?.url.startsWith("https://share.example.test/#")).toBe(true);
    expect(summary.remoteShare?.verb).toBe("review the plan");
    expect(summary.remoteShare?.noun).toBe("plan only");
    expect(summary.remoteShare?.size).toMatch(/B|KB/);
  });

  test("returns remote share notices for review sessions", async () => {
    const home = tempDir("plannotator-daemon-home-");
    const cwd = tempDir("plannotator-daemon-cwd-");
    process.env.HOME = home;
    run(["git", "init"], cwd);
    run(["git", "config", "user.email", "test@example.com"], cwd);
    run(["git", "config", "user.name", "Test User"], cwd);
    writeFileSync(join(cwd, "file.txt"), "before\n", "utf-8");
    run(["git", "add", "file.txt"], cwd);
    run(["git", "commit", "-m", "initial"], cwd);
    writeFileSync(join(cwd, "file.txt"), "after\n", "utf-8");

    const store = new DaemonSessionStore({ now: () => 1_000 });
    const factory = createDaemonSessionFactory({
      planHtmlContent: "<html><head></head><body>Plan</body></html>",
      reviewHtmlContent: "<html><head></head><body>Review</body></html>",
      shareBaseUrl: "https://share.example.test",
    });
    const context: DaemonFetchContext = {
      endpoint: {
        hostname: "0.0.0.0",
        port: 4321,
        baseUrl: "http://localhost:4321",
        isRemote: true,
      },
      store,
    };

    const record = await factory({
      request: {
        action: "review",
        origin: "opencode",
        cwd,
      },
    }, context);

    const summary = store.summary(record, { includeRemoteShare: true });
    expect(summary.remoteShare?.url.startsWith("https://share.example.test/#")).toBe(true);
    expect(summary.remoteShare?.verb).toBe("review changes");
    expect(summary.remoteShare?.noun).toBe("diff only");
  });

  test("preserves at-reference annotate resolution through the daemon", async () => {
    const home = tempDir("plannotator-daemon-home-");
    const cwd = tempDir("plannotator-daemon-cwd-");
    process.env.HOME = home;
    writeFileSync(join(cwd, "README.md"), "# Notes\n\nReview this.", "utf-8");

    const store = new DaemonSessionStore({ now: () => 1_000 });
    const factory = createDaemonSessionFactory({
      planHtmlContent: "<html><head></head><body>Plan</body></html>",
      reviewHtmlContent: "<html><head></head><body>Review</body></html>",
    });
    const context: DaemonFetchContext = {
      endpoint: {
        hostname: "127.0.0.1",
        port: 4321,
        baseUrl: "http://127.0.0.1:4321",
        isRemote: false,
      },
      store,
    };

    const record = await factory({
      request: {
        action: "annotate",
        origin: "opencode",
        cwd,
        args: "@README.md",
      },
    }, context);

    const planResponse = await record.handleRequest!(
      new Request("http://127.0.0.1:4321/api/plan"),
      new URL("http://127.0.0.1:4321/api/plan"),
    );
    const planBody = await planResponse.json();

    expect(planBody.plan).toContain("Review this.");
    expect(planBody.filePath).toBe(join(cwd, "README.md"));
  });

  test("uses structured annotate filePath verbatim when args are absent", async () => {
    const home = tempDir("plannotator-daemon-home-");
    const cwd = tempDir("plannotator-daemon-cwd-");
    process.env.HOME = home;
    const filePath = join(cwd, "Feature --gate spec.md");
    writeFileSync(filePath, "# Feature Spec\n\nDo not strip the filename.", "utf-8");

    const store = new DaemonSessionStore({ now: () => 1_000 });
    const factory = createDaemonSessionFactory({
      planHtmlContent: "<html><head></head><body>Plan</body></html>",
      reviewHtmlContent: "<html><head></head><body>Review</body></html>",
    });
    const context: DaemonFetchContext = {
      endpoint: {
        hostname: "127.0.0.1",
        port: 4321,
        baseUrl: "http://127.0.0.1:4321",
        isRemote: false,
      },
      store,
    };

    const record = await factory({
      request: {
        action: "annotate",
        origin: "pi",
        cwd,
        filePath,
      },
    }, context);

    const planResponse = await record.handleRequest!(
      new Request("http://127.0.0.1:4321/api/plan"),
      new URL("http://127.0.0.1:4321/api/plan"),
    );
    const planBody = await planResponse.json();

    expect(planBody.plan).toContain("Do not strip the filename.");
    expect(planBody.filePath).toBe(filePath);
  });

  test("treats direct rawHtml annotate requests as HTML render targets", async () => {
    const cwd = tempDir("plannotator-daemon-cwd-");
    const store = new DaemonSessionStore({ now: () => 1_000 });
    const factory = createDaemonSessionFactory({
      planHtmlContent: "<html><head></head><body>Plan</body></html>",
      reviewHtmlContent: "<html><head></head><body>Review</body></html>",
    });
    const context: DaemonFetchContext = {
      endpoint: {
        hostname: "127.0.0.1",
        port: 4321,
        baseUrl: "http://127.0.0.1:4321",
        isRemote: false,
      },
      store,
    };

    const record = await factory({
      request: {
        action: "annotate",
        origin: "opencode",
        cwd,
        filePath: "inline.html",
        rawHtml: "<main><h1>Inline HTML</h1></main>",
      },
    }, context);

    const planResponse = await record.handleRequest!(
      new Request("http://127.0.0.1:4321/api/plan"),
      new URL("http://127.0.0.1:4321/api/plan"),
    );
    const planBody = await planResponse.json();

    expect(planBody.renderAs).toBe("html");
    expect(planBody.rawHtml).toContain("Inline HTML");
    expect(planBody.plan).toBe("");
  });
});
