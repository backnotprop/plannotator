/**
 * OpenCode 2 `/plannotator-annotate` against the REAL plannotator CLI
 * (apps/hook/server/index.ts), end to end through `runNativeCommand`.
 *
 * Found in the 0.28.6 release smoke: `/plannotator-annotate . notes.md` opened
 * nothing and showed nothing. The plugin passed the words as ONE argument
 * (`annotate ". notes.md" --json`), which the real CLI reads as one path
 * ("File not found: . notes.md"); the stub CLI the earlier test used split
 * that argument itself, so it could not catch it. And the failure only went
 * to the log, which OpenCode 2 discards.
 *
 * Every run sandboxes HOME, the XDG dirs and PLANNOTATOR_DATA_DIR in a temp
 * directory; nothing touches the real ~/.plannotator or ~/.config/opencode.
 */
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runNativeCommand, type NativeCommandDeps } from "./native-commands";
import { OpenCodeLaunchRegistry } from "./plannotator-tool";

const ENTRY = path.resolve(import.meta.dir, "../hook/server/index.ts");
const DIST = path.resolve(import.meta.dir, "../hook/dist");
let stubs: string[] = [];
let root = "";
let savedBin: string | undefined;

beforeAll(() => {
  // The CLI imports the built HTML; API-only tests need just a stub.
  stubs = ["index.html", "review.html"].map((name) => path.join(DIST, name)).filter((p) => !existsSync(p));
  mkdirSync(DIST, { recursive: true });
  for (const p of stubs) writeFileSync(p, "<!doctype html><title>test</title>");
});
afterAll(() => {
  for (const p of stubs) rmSync(p, { force: true });
});

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "plannotator-oc2-annotate-words-")));
  for (const dir of ["home", "config", "cache", "data", "pn"]) mkdirSync(path.join(root, dir));
  writeFileSync(path.join(root, "notes.md"), "# Notes\n\nHello.\n");
  writeFileSync(path.join(root, "my notes.md"), "# My notes\n");
  // The real CLI, with its environment sandboxed inside the wrapper so the
  // test process's own environment is never touched beyond PLANNOTATOR_BIN.
  const env = {
    HOME: path.join(root, "home"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_DATA_HOME: path.join(root, "data"),
    PLANNOTATOR_DATA_DIR: path.join(root, "pn"),
    PLANNOTATOR_SKIP_BROWSER_OPEN: "1",
    PLANNOTATOR_REMOTE: "0",
    PLANNOTATOR_PORT: "0",
    PLANNOTATOR_AI: "disabled",
    PLANNOTATOR_SHARE: "disabled",
    PLANNOTATOR_FEEDBACK_HISTORY: "0",
    PLANNOTATOR_ANNOTATE_HISTORY: "0",
  };
  const exports = Object.entries(env).map(([key, value]) => `export ${key}=${JSON.stringify(value)}`).join("\n");
  const bin = path.join(root, "plannotator");
  writeFileSync(bin, `#!/bin/sh\n${exports}\nexec ${JSON.stringify(process.execPath)} run ${JSON.stringify(ENTRY)} "$@"\n`, { mode: 0o755 });
  savedBin = process.env.PLANNOTATOR_BIN;
  process.env.PLANNOTATOR_BIN = bin;
});

afterEach(() => {
  if (savedBin === undefined) delete process.env.PLANNOTATOR_BIN;
  else process.env.PLANNOTATOR_BIN = savedBin;
  rmSync(root, { recursive: true, force: true });
});

/** A fake OpenCode 2 context: transcript notices and prompts are recorded. */
function makeHost() {
  const prompts: Array<{ sessionID: string; text: string }> = [];
  const notices: Array<{ sessionID: string; text: string; description?: string; resume?: boolean }> = [];
  const ctx: any = {
    session: {
      get: async () => ({ location: { directory: root } }),
      prompt: mock(async (input: { sessionID: string; text: string }) => {
        prompts.push({ sessionID: input.sessionID, text: input.text });
        return {};
      }),
      synthetic: mock(async (input: { sessionID: string; text: string; description?: string; resume?: boolean }) => {
        notices.push(input);
        return {};
      }),
      context: async () => [],
    },
    location: { directory: root },
  };
  const registry = new OpenCodeLaunchRegistry();
  const deps: NativeCommandDeps = {
    ctx,
    getAgents: async () => [],
    getBridgeContext: async () => ({ sharingEnabled: false }),
    launches: registry,
  };
  return { prompts, notices, registry, deps };
}

async function waitFor<T>(read: () => T | undefined | null | false, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(25);
  }
}

/** Run the slash command with `words`, wait for the page, and answer with feedback. */
async function openAndSendFeedback(words: string) {
  const host = makeHost();
  const running = runNativeCommand("plannotator-annotate", { sessionID: "ses_a", prompt: { text: words } }, host.deps);
  let settled = false;
  void running.finally(() => { settled = true; });
  const launch = await waitFor(() => host.registry.openFor("ses_a").find((entry) => entry.port) ?? (settled && "ended"));
  if (launch === "ended") {
    throw new Error(`the command ended without opening; notices: ${host.notices.map((n) => n.text).join(" | ")}`);
  }
  const plan = await (await fetch(`http://127.0.0.1:${launch.port}/api/plan`)).json() as { filePath?: string };
  const res = await fetch(`http://127.0.0.1:${launch.port}/api/feedback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ feedback: "Tighten the intro.", annotations: [] }),
  });
  expect(res.status).toBe(200);
  await running;
  return { host, plan, launch };
}

describe.skipIf(process.platform === "win32")("OpenCode 2 /plannotator-annotate words through the real CLI", () => {
  // Failure caught: the words passed as one argument, which the real CLI
  // reads as the path ". notes.md" (opened nothing).
  for (const words of [". notes.md", "notes.md .", "please notes.md"]) {
    test(`"${words}" opens notes.md`, async () => {
      const { host, plan } = await openAndSendFeedback(words);
      expect(plan.filePath).toBe(path.join(root, "notes.md"));
      expect(host.prompts).toHaveLength(1);
      expect(host.prompts[0]!.text).toContain(`Target: ${path.join(root, "notes.md")}`);
      expect(host.prompts[0]!.text).toContain("Tighten the intro.");
    }, 30_000);
  }

  // Failure caught: splitting breaking a path with spaces, quoted or not.
  test("a path with spaces opens whether quoted beside prose or typed alone unquoted", async () => {
    const quoted = await openAndSendFeedback('"my notes.md" please');
    expect(quoted.plan.filePath).toBe(path.join(root, "my notes.md"));
    const bare = await openAndSendFeedback("my notes.md");
    expect(bare.plan.filePath).toBe(path.join(root, "my notes.md"));
  }, 60_000);

  // Failure caught: a failed command visible nowhere (OpenCode 2 discards the
  // log), or reported as a prompt that starts a model turn.
  test("a CLI failure is a transcript notice that starts no turn", async () => {
    const host = makeHost();
    await runNativeCommand("plannotator-annotate", { sessionID: "ses_a", prompt: { text: "nothere.md" } }, host.deps);
    expect(host.prompts).toHaveLength(0);
    expect(host.notices).toHaveLength(1);
    const notice = host.notices[0]!;
    expect(notice.sessionID).toBe("ses_a");
    expect(notice.resume).toBe(false);
    expect(notice.description).toBe(notice.text);
    expect(notice.text.startsWith("Plannotator /plannotator-annotate failed: ")).toBe(true);
    expect(notice.text).toContain("nothere.md");
  }, 30_000);

  // `./` is an explicit path to a folder, so beside a file it is a second
  // target: the CLI's ambiguity error, which the person now sees.
  test("./ beside a file is the CLI's ambiguity error, shown in the transcript", async () => {
    const host = makeHost();
    await runNativeCommand("plannotator-annotate", { sessionID: "ses_a", prompt: { text: "./ notes.md" } }, host.deps);
    expect(host.prompts).toHaveLength(0);
    expect(host.notices).toHaveLength(1);
    expect(host.notices[0]!.text).toContain("Ambiguous annotate arguments");
    expect(host.notices[0]!.text).toContain(path.join(root, "notes.md"));
  }, 30_000);
});
