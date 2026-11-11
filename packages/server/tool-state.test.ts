/**
 * Why gh or glab could not answer (packages/shared/tool-state.ts), read from
 * fake tools run through the real runners of both runtimes (Bun's
 * `createBunRefCliRunner`, Pi's `createNodeRefCliRunner`). The failures these
 * guard: a tool that is signed out, hung or refused read as "unavailable"
 * (the card could then only say "try again"), a timeout the runner ended not
 * told apart from a failure, and a status check that a hover waits on (no
 * deadline) or that runs on every read (no cache).
 *
 * The gh lines are the real gh 2.103's own words (run with an empty
 * GH_CONFIG_DIR, outside the tests); the glab lines are simulated from glab's
 * source: there is no GitLab login on the machine this was written on.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolCli, ToolState } from "@plannotator/core/problem-words";
import { createNodeRefCliRunner } from "@plannotator/shared/ref-cards-node";
import { createToolStatus, refineToolState, toolAuthStateOf, toolStateOfRun } from "@plannotator/shared/tool-state";
import { createBunRefCliRunner } from "./ref-cards";

const roots: string[] = [];
const savedPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = savedPath;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A folder holding a fake `cli` (or none: not installed), alone on PATH with the system's basic tools. */
function fakeTool(cli: ToolCli, script: string | null): void {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-tool-state-"));
  roots.push(dir);
  if (script !== null) {
    writeFileSync(join(dir, cli), `#!/bin/sh\n${script}\n`);
    chmodSync(join(dir, cli), 0o755);
  }
  process.env.PATH = `${dir}:/usr/bin:/bin`;
}

const say = (text: string, exit: number) => `printf '%s\\n' "${text.replace(/"/g, '\\"')}" >&2\nexit ${exit}`;
// Catches TERM and never ends, as a glab stuck on an unreachable host did.
const HANGS = "trap '' TERM\nexec /bin/sleep 30";

const CASES: { cli: ToolCli; why: string; script: string | null; state: ToolState }[] = [
  { cli: "gh", why: "not installed", script: null, state: "missing" },
  { cli: "gh", why: "no login (real gh, exit 4)", script: say("To get started with GitHub CLI, please run:  gh auth login", 4), state: "signed_out" },
  { cli: "gh", why: "a token GitHub refuses (real gh)", script: say("gh: Bad credentials (HTTP 401)", 1), state: "signed_out" },
  { cli: "gh", why: "hangs past the deadline", script: HANGS, state: "timed_out" },
  { cli: "gh", why: "no access to the repo", script: say("GraphQL: Could not resolve to a Repository with the name 'acme/secret'. (repository)", 1), state: "refused" },
  { cli: "gh", why: "rate limited", script: say("GraphQL: API rate limit exceeded for user ID 1.", 1), state: "rate_limited" },
  { cli: "gh", why: "offline", script: say("error connecting to api.github.com", 1), state: "failed" },
  { cli: "glab", why: "not installed", script: null, state: "missing" },
  { cli: "glab", why: "no token for the host", script: say("ERROR: 401 Unauthorized", 1), state: "signed_out" },
  { cli: "glab", why: "hangs past the deadline", script: HANGS, state: "timed_out" },
  { cli: "glab", why: "no access to the project", script: say("ERROR: 404 Not Found", 1), state: "refused" },
  { cli: "glab", why: "rate limited", script: say("ERROR: 429 Too Many Requests", 1), state: "rate_limited" },
  { cli: "glab", why: "host unreachable", script: say("dial tcp: lookup gitlab.example.dev: no such host", 1), state: "failed" },
];

describe("each state, from the fake tool's behavior, through both runtimes' runners", () => {
  for (const [runtime, runner] of [
    ["Bun", createBunRefCliRunner(400)],
    ["Pi (Node)", createNodeRefCliRunner(400)],
  ] as const) {
    test(`${runtime}: missing, signed out, timed out, refused, rate limited, failed`, async () => {
      const seen: string[] = [];
      for (const c of CASES) {
        fakeTool(c.cli, c.script);
        const result = await runner(c.cli, ["api", "graphql", "-f", "query=query{viewer{login}}"]);
        seen.push(`${c.cli} ${c.why}: ${toolStateOfRun(c.cli, result)}`);
      }
      expect(seen).toEqual(CASES.map((c) => `${c.cli} ${c.why}: ${c.state}`));
    }, 20_000);
  }
});

describe("the status check", () => {
  test("reads `auth status --hostname`: real gh's no-login lines and glab's are signed out; 0 signed in; 127 missing", () => {
    const r = (stderr: string, exitCode: number) => ({ stdout: "", stderr, exitCode });
    expect(toolAuthStateOf(r("You are not logged into any accounts on ghe.example.com", 1))).toBe("signed_out");
    expect(toolAuthStateOf(r("You are not logged into any GitHub hosts. To log in, run: gh auth login", 1))).toBe("signed_out");
    expect(toolAuthStateOf(r("x gitlab.example.dev has not been authenticated with glab. Run `glab auth login --hostname gitlab.example.dev` to authenticate.", 1))).toBe("signed_out");
    expect(toolAuthStateOf(r("", 0))).toBe("signed_in");
    expect(toolAuthStateOf(r("gh: not found", 127))).toBe("missing");
    // A token gh could not check (offline) is not called signed out.
    expect(toolAuthStateOf(r("X Failed to log in to github.com account dana (keyring)", 1))).toBe("unknown");
  });

  test("has its own deadline and is cached: a tool that never answers costs one run, and later reads wait on nothing", async () => {
    let runs = 0;
    let at = 0;
    const status = createToolStatus({ run: () => (runs++, new Promise(() => {})), now: () => at, deadlineMs: 50 });
    const started = Date.now();
    expect(await status.check("glab", "gitlab.example.dev")).toBe("timed_out");
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(status.peek("glab", "gitlab.example.dev")).toBe("timed_out");
    expect(await status.check("glab", "gitlab.example.dev")).toBe("timed_out");
    expect(runs).toBe(1);
    // Past the short hold for anything but a login: asked again.
    at += 31_000;
    expect(status.peek("glab", "gitlab.example.dev")).toBeUndefined();
    void status.check("glab", "gitlab.example.dev");
    expect(runs).toBe(2);
  });

  test("makes a vague run precise: a refusal or a timeout from a tool with no login there is signed out", async () => {
    const status = createToolStatus({ run: async () => ({ stdout: "", stderr: "x gitlab.example.dev has not been authenticated with glab.", exitCode: 1 }) });
    expect(await refineToolState(status, "glab", "gitlab.example.dev", "refused")).toBe("signed_out");
    expect(await refineToolState(status, "glab", "gitlab.example.dev", "timed_out")).toBe("signed_out");
    // Nothing ran (a host glab lists no login for): the status check alone decides.
    expect(await refineToolState(status, "glab", "gitlab.example.dev", null)).toBe("signed_out");
    const signedIn = createToolStatus({ run: async () => ({ stdout: "", stderr: "", exitCode: 0 }) });
    expect(await refineToolState(signedIn, "gh", "github.com", "timed_out")).toBe("timed_out");
  });
});
