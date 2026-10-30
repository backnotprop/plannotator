import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AcpClient, AcpStartAbortedError, killPendingProcessGroups, MAX_CLIENT_READ_BYTES, readTextFileForAgent } from "./client";

const dir = mkdtempSync(join(tmpdir(), "pn-client-read-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("fs/read_text_file for an agent that calls it", () => {
  it("reads a file, or the lines asked for", async () => {
    const p = join(dir, "a.ts");
    writeFileSync(p, "one\ntwo\nthree\n");
    expect(await readTextFileForAgent({ path: p })).toEqual({ content: "one\ntwo\nthree\n" });
    expect(await readTextFileForAgent({ path: p, line: 2, limit: 1 })).toEqual({ content: "two" });
  });

  it("refuses a relative path, a folder, and a file over 10 MB", async () => {
    await expect(readTextFileForAgent({ path: "a.ts" })).rejects.toThrow();
    await expect(readTextFileForAgent({ path: dir })).rejects.toThrow("is not a file");
    const big = join(dir, "big.log");
    writeFileSync(big, "");
    truncateSync(big, MAX_CLIENT_READ_BYTES + 1);
    await expect(readTextFileForAgent({ path: big })).rejects.toThrow("reads files up to");
  });
});

describe("start: an agent that hangs in initialize can be stopped", () => {
  // Never answers initialize, ignores SIGTERM and stdin's end; writes its pid to PID_OUT.
  const HANG = "require('node:fs').writeFileSync(process.env.PID_OUT, String(process.pid)); process.on('SIGTERM', () => {}); process.stdin.on('data', () => {}); process.stdin.on('end', () => {}); setInterval(() => {}, 1000);";
  const pids: number[] = [];
  afterEach(() => {
    for (const pid of pids.splice(0)) {
      try {
        process.kill(pid, "SIGKILL"); // own child (the hanging stand-in), whatever the test asserted
      } catch {
        // Already gone.
      }
    }
  });
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0); // own child
      return true;
    } catch {
      return false;
    }
  };
  const handlers = { onUpdate: () => {}, requestPermission: async () => ({ outcome: { outcome: "cancelled" as const } }) };
  const info = { name: "test", title: "Test", version: "0" };
  async function pidOf(out: string): Promise<number> {
    for (let i = 0; i < 100 && !existsSync(out); i++) await Bun.sleep(20);
    const pid = Number(readFileSync(out, "utf8"));
    pids.push(pid);
    return pid;
  }
  async function gone(pid: number, ms: number): Promise<boolean> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (!alive(pid)) return true;
      await Bun.sleep(50);
    }
    return !alive(pid);
  }

  it("a time limit rejects the start and stops its process group (SIGTERM, then SIGKILL)", async () => {
    const out = join(dir, "pid-timeout");
    const started = AcpClient.start({ command: process.execPath, args: ["-e", HANG], env: { PID_OUT: out } }, handlers, info, { initializeTimeoutMs: 500, augmentPath: false });
    await expect(started).rejects.toBeInstanceOf(AcpStartAbortedError);
    expect(await gone(await pidOf(out), 6000)).toBe(true);
  }, 15_000);

  it("a launch's startHint goes on an agent that fails initialize, never on a stop or time limit", async () => {
    const hint = "HINT: the CLI may be old";
    const exits = AcpClient.start({ command: process.execPath, args: ["-e", "process.exit(3)"], startHint: hint }, handlers, info, { augmentPath: false });
    await expect(exits).rejects.toThrow(hint);
    const out = join(dir, "pid-hint-timeout");
    const hangs = AcpClient.start({ command: process.execPath, args: ["-e", HANG], env: { PID_OUT: out }, startHint: hint }, handlers, info, { initializeTimeoutMs: 500, augmentPath: false });
    const err = await hangs.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AcpStartAbortedError);
    expect((err as Error).message).not.toContain(hint);
    expect(await gone(await pidOf(out), 6000)).toBe(true);
  }, 15_000);

  it('an abort with "kill" rejects the start and kills its process group at once', async () => {
    const out = join(dir, "pid-abort");
    const controller = new AbortController();
    const started = AcpClient.start({ command: process.execPath, args: ["-e", HANG], env: { PID_OUT: out } }, handlers, info, { signal: controller.signal, augmentPath: false });
    const pid = await pidOf(out);
    controller.abort("kill");
    await expect(started).rejects.toBeInstanceOf(AcpStartAbortedError);
    expect(await gone(pid, 1000)).toBe(true);
  }, 15_000);
});

describe("an exited agent's process group: never a signal to an empty group (its id may be reused)", () => {
  // Answers initialize, then exits after EXIT_AFTER ms (never, when unset); dies on SIGTERM. Starts nothing.
  const QUICK = [
    "const rl = require('node:readline').createInterface({ input: process.stdin });",
    "rl.on('line', (line) => { const m = JSON.parse(line); if (m.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } }) + '\\n'); });",
    "if (process.env.EXIT_AFTER) setTimeout(() => process.exit(0), Number(process.env.EXIT_AFTER));",
    "setInterval(() => {}, 1000);",
  ].join("\n");
  const handlers = { onUpdate: () => {}, requestPermission: async () => ({ outcome: { outcome: "cancelled" as const } }) };
  const info = { name: "test", title: "Test", version: "0" };
  /** Every signal this process sends to `-pid` (the group), recorded through a wrapped process.kill. */
  function watchGroupSignals(): { to: (pid: number) => (string | number)[]; restore: () => void } {
    const real = process.kill.bind(process);
    const sent: { pid: number; signal: string | number }[] = [];
    process.kill = ((pid: number, signal?: string | number) => {
      sent.push({ pid, signal: signal ?? "SIGTERM" });
      return real(pid, signal as never);
    }) as typeof process.kill;
    return { to: (pid) => sent.filter((e) => e.pid === -pid).map((e) => e.signal), restore: () => void (process.kill = real) };
  }
  const exited = (client: AcpClient) => new Promise<void>((done) => {
    const tick = () => (client.hasExited ? done() : setTimeout(tick, 20));
    tick();
  });

  it("an agent that exits by itself with nothing left in its group gets no SIGTERM and no SIGKILL, now or after the grace", async () => {
    const watch = watchGroupSignals();
    try {
      const client = await AcpClient.start({ command: process.execPath, args: ["-e", QUICK], env: { EXIT_AFTER: "200" } }, handlers, info, { augmentPath: false });
      const pid = client.pid!;
      await exited(client);
      await Bun.sleep(3500);
      killPendingProcessGroups();
      // Only probes (signal 0): never a real signal to the empty group.
      expect(watch.to(pid).filter((sig) => sig !== 0)).toEqual([]);
      expect(watch.to(pid)).toContain(0);
    } finally {
      watch.restore();
    }
  }, 15_000);

  it("a stopped agent whose whole group ended in the grace: the delayed SIGKILL is cancelled, and killPendingProcessGroups sends none", async () => {
    const watch = watchGroupSignals();
    try {
      const client = await AcpClient.start({ command: process.execPath, args: ["-e", QUICK] }, handlers, info, { augmentPath: false });
      const pid = client.pid!;
      client.dispose();
      await exited(client);
      killPendingProcessGroups();
      await Bun.sleep(3500);
      const real = watch.to(pid).filter((sig) => sig !== 0);
      expect(real).toEqual(["SIGTERM"]);
    } finally {
      watch.restore();
    }
  }, 15_000);
});

describe("this program crashes (an uncaught exception): its exit hook kills the agents' groups", () => {
  const FAKE_AGENT = resolve(import.meta.dir, "..", "..", "tests", "helpers", "fake-acp-agent.ts");
  const CLIENT = resolve(import.meta.dir, "client.ts");
  const strays: number[] = [];
  afterEach(() => {
    for (const pid of strays.splice(0)) {
      try {
        process.kill(pid, "SIGKILL"); // own grandchild (the fake agent's stubborn child), whatever the test asserted
      } catch {
        // Already gone.
      }
    }
  });
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0); // own grandchild
      return true;
    } catch {
      return false;
    }
  };

  for (const mode of ["live", "stopped"] as const) {
    it(`${mode === "live" ? "a running agent" : "an agent stopped inside its grace"}: what it started (ignoring SIGTERM) is killed when the program throws`, async () => {
      const work = mkdtempSync(join(dir, `crash-${mode}-`));
      const log = join(work, "fake.log");
      const script = join(work, "script.json");
      writeFileSync(script, JSON.stringify({ steps: [], turns: [[{ spawnStubborn: true }, { sleep: 60_000 }]] }));
      const crasher = join(work, "crash.ts");
      writeFileSync(
        crasher,
        [
          `import { existsSync, readFileSync } from "node:fs";`,
          `import { AcpClient } from ${JSON.stringify(CLIENT)};`,
          `const client = await AcpClient.start({ command: process.execPath, args: [${JSON.stringify(FAKE_AGENT)}], env: { FAKE_ACP_SCRIPT: ${JSON.stringify(script)}, FAKE_ACP_LOG: ${JSON.stringify(log)} } }, { onUpdate() {}, async requestPermission() { return { outcome: { outcome: "cancelled" } }; } }, { name: "t", title: "t", version: "0" }, { augmentPath: false });`,
          `const { sessionId } = await client.newSession(${JSON.stringify(work)}, []);`,
          `void client.prompt(sessionId, "go").catch(() => {});`,
          `while (!(existsSync(${JSON.stringify(log)}) && readFileSync(${JSON.stringify(log)}, "utf8").includes('"stubborn"'))) await Bun.sleep(20);`,
          mode === "stopped" ? `client.dispose(); await Bun.sleep(300);` : ``,
          `throw new Error("crash");`,
        ].join("\n"),
      );
      const child = Bun.spawn([process.execPath, crasher], { stdout: "ignore", stderr: "ignore", env: { ...process.env } });
      const code = await child.exited;
      expect(code).not.toBe(0);
      const stubborn = (readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) as { event: string; pid?: number }[]).find((e) => e.event === "stubborn")!.pid!;
      strays.push(stubborn);
      // SIGKILL from the exit hook, at once: well inside the 3 s grace a stopped agent's timer would have used.
      const end = Date.now() + 1000;
      while (alive(stubborn) && Date.now() < end) await Bun.sleep(25);
      expect(alive(stubborn)).toBe(false);
    }, 20_000);
  }
});
