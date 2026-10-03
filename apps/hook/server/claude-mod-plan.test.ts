/**
 * `plannotator claude-mod-plan`, the CLI half of the Claude Code mod's
 * non-blocking plan review, run as the real process: revisions arrive through
 * the revision file, the decision leaves through the host result file.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseModPlanInput, readModPlanRevision } from "./claude-mod-plan";

const entry = resolve(import.meta.dir, "index.ts");
const distDir = resolve(import.meta.dir, "../dist");
const roots: string[] = [];
let stubs: string[] = [];

beforeAll(() => {
  // The CLI imports the built HTML; API-only tests need just a stub.
  stubs = ["index.html", "review.html"].map((name) => join(distDir, name)).filter((path) => !existsSync(path));
  mkdirSync(distDir, { recursive: true });
  for (const path of stubs) writeFileSync(path, "<!doctype html><title>test</title>");
});
afterAll(() => {
  for (const path of stubs) rmSync(path, { force: true });
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function waitFor<T>(read: () => T | null | undefined, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(25);
  }
}

function start(plan: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-claude-mod-plan-")));
  roots.push(root);
  // The launch layout the mod uses: result.json must sit under the data dir's
  // claude-code-mod/ folder or the CLI refuses the path.
  const launch = join(root, "data", "claude-code-mod", "session-1", "launch-1");
  mkdirSync(launch, { recursive: true });
  const files = {
    ready: join(launch, "ready"),
    result: join(launch, "result.json"),
    revision: join(launch, "revision.json"),
  };
  const proc = Bun.spawn([process.execPath, "run", entry, "claude-mod-plan"], {
    cwd: root,
    env: {
      ...process.env,
      PLANNOTATOR_DATA_DIR: join(root, "data"),
      PLANNOTATOR_PORT: "0",
      PLANNOTATOR_REMOTE: "0",
      PLANNOTATOR_SKIP_BROWSER_OPEN: "1",
      PLANNOTATOR_READY_FILE: files.ready,
      PLANNOTATOR_HOST_RESULT_FILE: files.result,
      PLANNOTATOR_AI: "disabled",
      PLANNOTATOR_SHARE: "disabled",
    },
    stdin: new TextEncoder().encode(JSON.stringify({ plan, revisionFile: files.revision })),
    stdout: "pipe",
    stderr: "pipe",
  });
  const port = async () => {
    const line = await waitFor(() => (existsSync(files.ready) ? readFileSync(files.ready, "utf8").split("\n")[0] : null));
    return (JSON.parse(line) as { port: number }).port;
  };
  return { proc, files, port };
}

describe("claude-mod-plan", () => {
  test("a revision lands in the open review, and the approval carries exactly that text", async () => {
    const { proc, files, port } = start("# Plan\n\n1. First.\n");
    const base = `http://localhost:${await port()}`;

    writeFileSync(files.revision, JSON.stringify({ seq: 1, plan: "# Plan\n\n1. First.\n2. Second.\n" }));
    const ack = await waitFor(() => (existsSync(`${files.revision}.ack`) ? readFileSync(`${files.revision}.ack`, "utf8") : null));
    expect(JSON.parse(ack)).toMatchObject({ seq: 1, accepted: true, revision: 1 });

    const shown = (await (await fetch(`${base}/api/plan`)).json()) as { plan: string; planRevision?: number };
    expect(shown.plan).toBe("# Plan\n\n1. First.\n2. Second.\n");
    expect(shown.planRevision).toBe(1);

    const approve = await fetch(`${base}/api/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ planRevision: 1, permissionMode: "acceptEdits" }),
    });
    expect(approve.status).toBe(200);
    expect(await proc.exited).toBe(0);

    const record = JSON.parse(readFileSync(files.result, "utf8"));
    expect(record).toMatchObject({
      v: 1,
      surface: "plan",
      decision: "approved",
      noop: false,
      approvedPlan: "# Plan\n\n1. First.\n2. Second.\n",
      permissionMode: "acceptEdits",
    });
  }, 30_000);

  test("an answers-only deny publishes the answered prompt, not the denied one", async () => {
    const { proc, files, port } = start("# Plan\n\n:::question\nWhich?\n- A\n- B\n:::\n");
    const base = `http://localhost:${await port()}`;

    const deny = await fetch(`${base}/api/deny`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ feedback: "Which? → A", answersOnly: true }),
    });
    expect(deny.status).toBe(200);
    expect(await proc.exited).toBe(0);

    const record = JSON.parse(readFileSync(files.result, "utf8"));
    expect(record.decision).toBe("answered");
    expect(record.message).toContain("Which? → A");
    expect(record.message).not.toContain("YOUR PLAN WAS NOT APPROVED");
  }, 30_000);
});

describe("claude-mod-plan input", () => {
  test("refuses a missing or blank plan", () => {
    expect(parseModPlanInput("{}")).toBeNull();
    expect(parseModPlanInput('{"plan":"  "}')).toBeNull();
    expect(parseModPlanInput("nope")).toBeNull();
    expect(parseModPlanInput('{"plan":"# P","revisionFile":"/x/r.json"}')).toEqual({
      plan: "# P",
      planFilePath: undefined,
      permissionMode: undefined,
      revisionFile: "/x/r.json",
    });
  });

  test("a revision file being written, or an old one, reads as nothing new", () => {
    const root = mkdtempSync(join(tmpdir(), "plannotator-mod-revision-"));
    roots.push(root);
    const path = join(root, "revision.json");
    expect(readModPlanRevision(path, 0)).toBeNull();
    writeFileSync(path, '{"seq":2,"plan":"# P');
    expect(readModPlanRevision(path, 0)).toBeNull();
    writeFileSync(path, '{"seq":2,"plan":"# P"}');
    expect(readModPlanRevision(path, 2)).toBeNull();
    expect(readModPlanRevision(path, 1)).toEqual({ seq: 2, plan: "# P" });
  });
});
