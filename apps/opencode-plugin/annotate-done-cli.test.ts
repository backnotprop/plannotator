/**
 * #1701, OpenCode CLI bridge end to end: the plugin runs the REAL plannotator
 * CLI (`annotate <file> --json`), the editor's bare Done is posted the way the
 * UI posts it, and the session must receive no prompt. Real feedback through
 * the same path still arrives, so the test cannot pass by never prompting.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { handleCliCommand } from "./cli-bridge";

const ENTRY = path.resolve(import.meta.dir, "../hook/server/index.ts");
const DIST = path.resolve(import.meta.dir, "../hook/dist");
const roots: string[] = [];
let stubs: string[] = [];

beforeAll(() => {
  // The CLI imports the built HTML; API-only tests need just a stub.
  stubs = ["index.html", "review.html", "inbox.html"].map((name) => path.join(DIST, name)).filter((p) => !existsSync(p));
  mkdirSync(DIST, { recursive: true });
  for (const p of stubs) writeFileSync(p, "<!doctype html><title>test</title>");
});
afterAll(() => {
  for (const p of stubs) rmSync(p, { force: true });
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function runAnnotate(body: Record<string, unknown>) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "plannotator-opencode-done-")));
  roots.push(root);
  writeFileSync(path.join(root, "notes.md"), "# Notes\n\nHello.\n");
  const bin = path.join(root, "plannotator");
  writeFileSync(bin, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} run ${JSON.stringify(ENTRY)} "$@"\n`, { mode: 0o755 });

  const logs: string[] = [];
  const client = {
    app: { log: mock((entry: { message: string }) => { logs.push(entry.message); }) },
    session: { prompt: mock(async (_input: unknown) => ({})), messages: mock(async () => ({ data: [] })) },
  };
  const saved = {
    bin: process.env.PLANNOTATOR_BIN,
    data: process.env.PLANNOTATOR_DATA_DIR,
    skip: process.env.PLANNOTATOR_SKIP_BROWSER_OPEN,
    ai: process.env.PLANNOTATOR_AI,
  };
  try {
    process.env.PLANNOTATOR_BIN = bin;
    process.env.PLANNOTATOR_DATA_DIR = path.join(root, "data");
    process.env.PLANNOTATOR_SKIP_BROWSER_OPEN = "1";
    process.env.PLANNOTATOR_AI = "disabled";
    const run = handleCliCommand({ command: "plannotator-annotate", client, sessionId: "ses_1", cwd: root, rawArgs: "notes.md" });
    const deadline = Date.now() + 20_000;
    let url: string | undefined;
    while (!url && Date.now() < deadline) {
      url = logs.map((m) => m.match(/Open annotation UI: (\S+)/)?.[1]).find(Boolean);
      if (!url) await Bun.sleep(50);
    }
    if (!url) throw new Error(`no session URL; logs: ${logs.join(" | ")}`);
    const res = await fetch(new URL("/api/feedback", url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    await run;
    return client.session.prompt;
  } finally {
    for (const [key, env] of [["PLANNOTATOR_BIN", saved.bin], ["PLANNOTATOR_DATA_DIR", saved.data], ["PLANNOTATOR_SKIP_BROWSER_OPEN", saved.skip], ["PLANNOTATOR_AI", saved.ai]] as const) {
      if (env === undefined) delete process.env[key];
      else process.env[key] = env;
    }
  }
}

describe.skipIf(process.platform === "win32")("OpenCode CLI bridge: annotate Done", () => {
  test("a bare Done starts no turn", async () => {
    const prompt = await runAnnotate({
      feedback: "User reviewed the document and has no feedback.",
      annotations: [],
      codeAnnotations: [],
      nothingToSend: true,
    });
    expect(prompt).not.toHaveBeenCalled();
  }, 30_000);

  test("real feedback through the same path is still delivered", async () => {
    const prompt = await runAnnotate({
      feedback: "1. tighten the intro",
      annotations: [{ id: "a1", type: "COMMENT", text: "tighten the intro", originalText: "Hello." }],
    });
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(prompt.mock.calls[0]?.[0])).toContain("tighten the intro");
  }, 30_000);
});
