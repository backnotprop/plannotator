import { describe, expect, test } from "bun:test";
import { createAgentJobHandler } from "./agent-jobs";

describe("agent jobs daemon event publication", () => {
  test("rejects the old persistent stream route", async () => {
    const handler = createAgentJobHandler({
      mode: "review",
      getServerUrl: () => "http://localhost",
      getCwd: () => process.cwd(),
    });

    const res = await handler.handle(
      new Request("http://localhost/api/agents/jobs/stream"),
      new URL("http://localhost/api/agents/jobs/stream"),
    );

    expect(res?.status).toBe(410);
    expect(res?.headers.get("content-type")).not.toContain("text/event-stream");
    handler.dispose();
  });

  test("registers and unregisters a snapshot provider", () => {
    let provider: (() => unknown) | undefined;
    let unregistered = false;
    const handler = createAgentJobHandler({
      mode: "review",
      getServerUrl: () => "http://localhost",
      getCwd: () => process.cwd(),
      registerSnapshotProvider: (next) => {
        provider = next;
        return () => {
          unregistered = true;
        };
      },
    });

    expect(provider?.()).toEqual({ type: "snapshot", jobs: [], logs: {}, version: 0 });
    handler.dispose();
    expect(unregistered).toBe(true);
  });

  test("publishes job lifecycle events through the daemon callback", async () => {
    const originalWhich = Bun.which;
    (Bun as unknown as { which: typeof Bun.which }).which = (command: string) =>
      command === "claude" ? process.execPath : null;
    const events: string[] = [];
    const handler = createAgentJobHandler({
      mode: "review",
      getServerUrl: () => "http://localhost",
      getCwd: () => process.cwd(),
      publishEvent: (event) => events.push(event.type),
    });

    try {
      const res = await handler.handle(
        new Request("http://localhost/api/agents/jobs", {
          method: "POST",
          body: JSON.stringify({
            provider: "claude",
            command: [process.execPath, "-e", "console.error('agent log line')"],
            label: "test job",
          }),
        }),
        new URL("http://localhost/api/agents/jobs"),
      );

      expect(res?.status).toBe(201);
      expect(events).toContain("job:started");
      await Bun.sleep(300);
      expect(events).toContain("job:completed");

      const snapshot = await handler.handle(
        new Request("http://localhost/api/agents/jobs"),
        new URL("http://localhost/api/agents/jobs"),
      );
      expect(snapshot?.status).toBe(200);
      const body = await snapshot!.json() as { logs: Record<string, string> };
      expect(Object.values(body.logs).join("")).toContain("agent log line");
    } finally {
      handler.dispose();
      (Bun as unknown as { which: typeof Bun.which }).which = originalWhich;
    }
  });

  test("does not publish process output after disposal", async () => {
    const originalWhich = Bun.which;
    (Bun as unknown as { which: typeof Bun.which }).which = (command: string) =>
      command === "claude" ? process.execPath : null;
    const events: string[] = [];
    const handler = createAgentJobHandler({
      mode: "review",
      getServerUrl: () => "http://localhost",
      getCwd: () => process.cwd(),
      publishEvent: (event) => events.push(event.type),
    });

    try {
      const res = await handler.handle(
        new Request("http://localhost/api/agents/jobs", {
          method: "POST",
          body: JSON.stringify({
            provider: "claude",
            command: [
              process.execPath,
              "-e",
              "process.on('SIGTERM',()=>{}); setTimeout(()=>console.error('late log after dispose'),30); setTimeout(()=>process.exit(0),80);",
            ],
            label: "late log job",
          }),
        }),
        new URL("http://localhost/api/agents/jobs"),
      );

      expect(res?.status).toBe(201);
      handler.dispose();
      await Bun.sleep(150);
      expect(events).toEqual(["job:started"]);
    } finally {
      handler.dispose();
      (Bun as unknown as { which: typeof Bun.which }).which = originalWhich;
    }
  });

  test("caps retained job logs in snapshots", async () => {
    const originalWhich = Bun.which;
    (Bun as unknown as { which: typeof Bun.which }).which = (command: string) =>
      command === "claude" ? process.execPath : null;
    const handler = createAgentJobHandler({
      mode: "review",
      getServerUrl: () => "http://localhost",
      getCwd: () => process.cwd(),
    });

    try {
      const res = await handler.handle(
        new Request("http://localhost/api/agents/jobs", {
          method: "POST",
          body: JSON.stringify({
            provider: "claude",
            command: [
              process.execPath,
              "-e",
              "console.error('x'.repeat(300000) + 'TAIL')",
            ],
            label: "verbose job",
          }),
        }),
        new URL("http://localhost/api/agents/jobs"),
      );

      expect(res?.status).toBe(201);
      await Bun.sleep(300);

      const snapshot = await handler.handle(
        new Request("http://localhost/api/agents/jobs"),
        new URL("http://localhost/api/agents/jobs"),
      );
      const body = await snapshot!.json() as { logs: Record<string, string> };
      const log = Object.values(body.logs).join("");
      expect(log.length).toBeLessThan(300_000);
      expect(log).toContain("TAIL");
    } finally {
      handler.dispose();
      (Bun as unknown as { which: typeof Bun.which }).which = originalWhich;
    }
  });
});
