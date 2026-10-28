/**
 * Cursor agent jobs never start another program named `agent`.
 *
 * Cursor's installer links `cursor-agent` and `agent`; Grok Build (and other
 * tools) install an `agent` too. With PATH holding only a scratch folder of
 * fake programs (plus /usr/bin:/bin for the shell), /api/agents/capabilities
 * lists Cursor only when `cursor-agent` is there or the `agent` answers like
 * Cursor's CLI, and a launched job starts that program. The real Cursor and
 * Grok CLIs are never run.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgetSameProgramAnswers } from "@plannotator/shared/agent-program";
import { createAgentJobHandler } from "./agent-jobs";
import { buildMarkerCommand, MARKER_ENGINES } from "./marker-review";

const posix = process.platform !== "win32";
const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-cursor-jobs-")));
const log = join(root, "ran.log");
let bin = "";
let realPath: string | undefined;

/** A fake CLI: `--version` prints `version`; anything else logs its argv and prints nothing. */
function fake(name: string, version: string): string {
  const path = join(bin, name);
  writeFileSync(path, `#!/bin/sh\necho "${name} $*" >> '${log}'\nif [ "$1" = "--version" ]; then echo "${version}"; fi\nexit 0\n`);
  chmodSync(path, 0o755);
  return path;
}

const ran = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []);

function handler(onDone?: () => void) {
  return createAgentJobHandler({
    mode: "review",
    getServerUrl: () => "http://localhost:1234",
    getCwd: () => root,
    async buildCommand() {
      const { command } = buildMarkerCommand(MARKER_ENGINES.cursor, "review this", undefined, root);
      return { command, prompt: "review this", cwd: root, captureStdout: true };
    },
    async onJobComplete() {
      onDone?.();
    },
  });
}

async function cursorAvailable(h: ReturnType<typeof handler>): Promise<boolean> {
  const res = await h.handle(new Request("http://localhost/api/agents/capabilities"), new URL("http://localhost/api/agents/capabilities"));
  const body = (await res!.json()) as { providers: { id: string; available: boolean }[] };
  return body.providers.find((p) => p.id === "cursor")!.available;
}

function launch(h: ReturnType<typeof handler>) {
  return h.handle(
    new Request("http://localhost/api/agents/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "cursor" }) }),
    new URL("http://localhost/api/agents/jobs"),
  );
}

beforeEach(() => {
  forgetSameProgramAnswers();
  rmSync(log, { force: true });
  bin = mkdtempSync(join(root, "bin-"));
  realPath = process.env.PATH;
  process.env.PATH = `${bin}:/usr/bin:/bin`;
});
afterEach(() => {
  process.env.PATH = realPath;
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe.if(posix)("Cursor agent jobs and another program named agent", () => {
  test("Grok Build's `agent` alone: Cursor is not available and nothing is started", async () => {
    fake("agent", "grok 1.0.70 (f50904eaee6c) [stable]");
    const h = handler();
    expect(await cursorAvailable(h)).toBe(false);
    const res = await launch(h);
    expect(res?.status).toBe(400);
    // Only its `--version` was read; it was never started as a review.
    expect(ran()).toEqual(["agent --version"]);
  });

  test("Cursor's `agent` alone: available, and the job starts it", async () => {
    fake("agent", "2026.07.08-0c04a8a");
    let done: () => void = () => {};
    const finished = new Promise<void>((resolve) => (done = resolve));
    const h = handler(done);
    expect(await cursorAvailable(h)).toBe(true);
    expect((await launch(h))?.status).toBe(201);
    await finished;
    const job = ran().find((line) => line.includes(" -p "));
    expect(job).toStartWith("agent -p --mode ask");
    h.killAll();
  });

  test("`cursor-agent` wins, and another `agent` is never asked", async () => {
    fake("cursor-agent", "2026.07.08-0c04a8a");
    fake("agent", "grok 1.0.70 (f50904eaee6c) [stable]");
    let done: () => void = () => {};
    const finished = new Promise<void>((resolve) => (done = resolve));
    const h = handler(done);
    expect(await cursorAvailable(h)).toBe(true);
    expect((await launch(h))?.status).toBe(201);
    await finished;
    expect(ran().some((line) => line.startsWith("agent "))).toBe(false);
    expect(ran().find((line) => line.includes(" -p "))).toStartWith("cursor-agent -p --mode ask");
    h.killAll();
  });
});
