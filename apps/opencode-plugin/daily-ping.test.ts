/**
 * The OpenCode plugin's daily ping wiring, against a loopback receiver in a
 * temp data dir: plan review (runEmbeddedPlanReview), code review, annotate and
 * annotate-last each send their tool's ping; a local build (no release CI mark
 * in `dist/`) is a dev build.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { TELEMETRY_CI_VARS } from "@plannotator/shared/config";
import { handleAnnotateCommand, handleAnnotateLastCommand, handleReviewCommand } from "./commands";
import { OPENCODE_RELEASE_MARK, openCodePingVersion, setOpenCodePingVersionForTests } from "./daily-ping";
import { runEmbeddedPlanReview } from "./embedded";

const KEYS = ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_TELEMETRY_URL", "DO_NOT_TRACK", "NO_ANON_PING", ...TELEMETRY_CI_VARS] as const;
const saved: Record<string, string | undefined> = {};
let dataDir: string;
let root: string;
let receiver: ReturnType<typeof Bun.serve>;
let bodies: string[];

const sent = (): string[] => {
  try {
    return JSON.parse(readFileSync(path.join(dataDir, "ping.json"), "utf8")).sent ?? [];
  } catch {
    return [];
  }
};

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await Bun.sleep(20);
}

const stubServer = () =>
  mock(async (_options: any) => ({
    port: 0,
    url: "http://localhost",
    isRemote: false,
    waitForDecision: async () => ({ feedback: "", annotations: [] }),
    stop: () => {},
  }));

function deps() {
  return {
    client: {
      app: { log: mock((_entry: unknown) => {}) },
      session: {
        prompt: mock(async (_input: unknown) => {}),
        messages: mock(async (_input: unknown) => ({ data: [{ info: { role: "assistant" }, parts: [{ type: "text", text: "Latest assistant message" }] }] })),
      },
      tui: { showToast: mock((_input: any) => {}) },
    },
    htmlContent: "<html></html>",
    reviewHtmlContent: "<html></html>",
    getSharingEnabled: async () => false,
    getShareBaseUrl: () => undefined,
    getPasteApiUrl: () => undefined,
    directory: root,
    startAnnotateServer: stubServer(),
    startReviewServer: stubServer(),
  };
}

beforeEach(() => {
  for (const key of KEYS) saved[key] = process.env[key];
  for (const key of ["DO_NOT_TRACK", "NO_ANON_PING", ...TELEMETRY_CI_VARS]) delete process.env[key];
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "plannotator-opencode-ping-")));
  dataDir = path.join(root, "data");
  mkdirSync(dataDir);
  writeFileSync(path.join(dataDir, "ping.json"), JSON.stringify({ firstWeek: "2026-01-05" }));
  writeFileSync(path.join(root, "plan.md"), "# Plan\n");
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  bodies = [];
  receiver = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      bodies.push(await req.text());
      return new Response(null, { status: 204 });
    },
  });
  process.env.PLANNOTATOR_TELEMETRY_URL = `http://127.0.0.1:${receiver.port}`;
  setOpenCodePingVersionForTests({ version: "0.28.46" });
});

afterEach(() => {
  setOpenCodePingVersionForTests(null);
  receiver.stop(true);
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(root, { recursive: true, force: true });
});

const ping = (tool: string) => `{"version":"0.28.46","age_week":4,"tool":"${tool}","first":1}`;

describe("the daily ping in the OpenCode plugin", () => {
  test("annotate", async () => {
    await handleAnnotateCommand({ properties: { arguments: "plan.md", sessionID: "s" } }, deps() as any);
    await until(() => sent().includes("annotate"));
    expect(bodies).toEqual([ping("annotate")]);
  });

  test("annotate-last is last", async () => {
    await handleAnnotateLastCommand({ properties: { sessionID: "s" } }, deps() as any);
    await until(() => sent().includes("last"));
    expect(bodies).toEqual([ping("last")]);
  });

  test("code review", async () => {
    // Code review needs a repository to review.
    for (const args of [["init", "-q"], ["-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "initial"]]) {
      expect(spawnSync("git", args, { cwd: root, env: { PATH: process.env.PATH ?? "", HOME: root } }).status).toBe(0);
    }
    await handleReviewCommand({ properties: { arguments: "", sessionID: "s" } }, deps() as any).catch(() => {});
    await until(() => sent().includes("review"));
    expect(bodies).toEqual([ping("review")]);
  });

  test("plan review (submit_plan's embedded server)", async () => {
    await runEmbeddedPlanReview({
      client: deps().client,
      planContent: "# Plan",
      sharingEnabled: false,
      htmlContent: "<html></html>",
      timeoutSeconds: 1,
      logReady: () => {},
    });
    await until(() => sent().includes("plan"));
    expect(bodies).toEqual([ping("plan")]);
  }, 15_000);

  test("a local build is a dev build: no release CI mark in dist/, or one for another version", () => {
    const pkg = path.join(root, "pkg");
    mkdirSync(path.join(pkg, "dist"), { recursive: true });
    writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@plannotator/opencode", version: "0.28.46" }));
    const bundle = path.join(pkg, "dist", "index.js");
    expect(openCodePingVersion(bundle)).toBeUndefined();
    writeFileSync(path.join(pkg, "dist", OPENCODE_RELEASE_MARK), JSON.stringify({ version: "0.28.45" }));
    expect(openCodePingVersion(bundle)).toBeUndefined();
    writeFileSync(path.join(pkg, "dist", OPENCODE_RELEASE_MARK), JSON.stringify({ version: "0.28.46" }));
    expect(openCodePingVersion(bundle)).toBe("0.28.46");
  });
});
