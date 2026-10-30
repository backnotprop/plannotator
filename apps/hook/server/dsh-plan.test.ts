/**
 * DeepSeek Harness plan bridge tests (`plannotator dsh-plan`).
 *
 * Run: bun test apps/hook/server/dsh-plan.test.ts
 *
 * Every composition test passes its own config, so none reads config.json.
 * The process test runs the real subcommand under a temp data dir.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { PlannotatorConfig } from "@plannotator/shared/config";
import { composeDshPlanOutput, parseDshPlanInput } from "./dsh-plan";
import { removeStubbedHtml, stubHookDistHtml } from "../../../tests/helpers/hook-dist-stub";
import { NO_BROWSER } from "../../../tests/helpers/no-browser";

const noConfig: PlannotatorConfig = {};

describe("parseDshPlanInput", () => {
  test("accepts a plan with an optional timeout and cwd", () => {
    expect(parseDshPlanInput(JSON.stringify({ plan: "# Plan", timeoutSeconds: 30, cwd: "/repo" }))).toEqual({
      ok: true,
      input: { plan: "# Plan", timeoutSeconds: 30, cwd: "/repo" },
    });
  });

  // Catches: a zero, negative or non-numeric timeout ending the review at once.
  test("a missing or unusable timeout waits for a decision", () => {
    for (const timeoutSeconds of [undefined, null, 0, -5, "30"]) {
      const parsed = parseDshPlanInput(JSON.stringify({ plan: "# Plan", timeoutSeconds }));
      expect(parsed.ok && parsed.input.timeoutSeconds).toBeNull();
    }
  });

  // Catches: opening an empty review (the plugin then waits on nothing) or
  // crashing on bad JSON instead of exiting non-zero so the plugin falls back.
  test("refuses bad JSON and an empty plan", () => {
    expect(parseDshPlanInput("{").ok).toBe(false);
    expect(parseDshPlanInput(JSON.stringify({ plan: "   " })).ok).toBe(false);
    expect(parseDshPlanInput(JSON.stringify({})).ok).toBe(false);
  });
});

describe("composeDshPlanOutput", () => {
  // Catches: the plugin steering an empty "approved with notes" message into
  // the agent after a plain approval.
  test("a plain approval carries no message", () => {
    expect(composeDshPlanOutput({ approved: true }, noConfig)).toEqual({ approved: true });
    expect(composeDshPlanOutput({ approved: true, feedback: "  \n" }, noConfig)).toEqual({ approved: true });
  });

  test("an approval with notes carries the notes in the message", () => {
    const out = composeDshPlanOutput({ approved: true, feedback: "Use the existing cache.", savedPath: "/p/plan.md" }, noConfig);
    expect(out.approved).toBe(true);
    expect(out.feedback).toBe("Use the existing cache.");
    expect(out.savedPath).toBe("/p/plan.md");
    expect(out.message).toContain("Use the existing cache.");
    expect(out.message).toContain("/p/plan.md");
  });

  // Catches: dsh-plan ignoring the user's prompt overrides (the reason the
  // message is composed here and not in the plugin).
  test("a runtime prompt override for dsh applies", () => {
    const config: PlannotatorConfig = {
      prompts: { plan: { runtimes: { dsh: { approvedWithNotes: "NOTES: {{feedback}}", denied: "NO via {{toolName}}: {{feedback}}" } } } },
    };
    expect(composeDshPlanOutput({ approved: true, feedback: "x" }, config).message).toBe("NOTES: x");
    expect(composeDshPlanOutput({ approved: false, feedback: "y" }, config).message).toBe("NO via exit_plan_mode: y");
  });

  // Catches: the denied prompt naming another host's plan tool, which sends
  // the DSH agent looking for a tool it does not have.
  test("a denial names exit_plan_mode and carries the feedback", () => {
    const out = composeDshPlanOutput({ approved: false, feedback: "Split step 2." }, noConfig);
    expect(out.approved).toBe(false);
    expect(out.feedback).toBe("Split step 2.");
    expect(out.message).toContain("exit_plan_mode");
    expect(out.message).toContain("Split step 2.");
    expect(out.answersOnly).toBeUndefined();
  });

  // Catches: an answers-only deny getting the "not approved" prompt.
  test("an answers-only denial uses the answered prompt and says so", () => {
    const answered = composeDshPlanOutput({ approved: false, feedback: "A: yes", answersOnly: true }, noConfig);
    const denied = composeDshPlanOutput({ approved: false, feedback: "A: yes" }, noConfig);
    expect(answered.answersOnly).toBe(true);
    expect(answered.message).toContain("A: yes");
    expect(answered.message).not.toBe(denied.message);
  });
});

describe("plannotator dsh-plan", () => {
  const entry = resolve(import.meta.dir, "index.ts");
  const roots: string[] = [];
  let stubs: string[] = [];

  beforeAll(() => {
    // The CLI imports the built HTML; API-only tests need just a stub.
    stubs = stubHookDistHtml();
  });
  afterAll(() => {
    removeStubbedHtml(stubs);
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  // Catches: the subcommand not wired to the dsh origin, the server not
  // offering approve-with-notes, or stdout missing the composed message the
  // plugin steers into the agent.
  test("an approval with notes comes back as one JSON line with the composed message", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-dsh-plan-")));
    roots.push(root);
    const readyFile = join(root, "ready");
    const proc = Bun.spawn([process.execPath, "run", entry, "dsh-plan"], {
      cwd: root,
      env: {
        ...process.env,
        PLANNOTATOR_DATA_DIR: join(root, "data"),
        PLANNOTATOR_PORT: "0",
        PLANNOTATOR_REMOTE: "0",
        PLANNOTATOR_SKIP_BROWSER_OPEN: "1",
        // Explicit, not only from the preload: this child must never open a browser.
        PLANNOTATOR_BROWSER: NO_BROWSER,
        PLANNOTATOR_READY_FILE: readyFile,
        PLANNOTATOR_AI: "disabled",
        PLANNOTATOR_SHARE: "disabled",
      },
      stdin: new TextEncoder().encode(JSON.stringify({ plan: "# Plan\n\n1. Do it.\n", cwd: root })),
      stdout: "pipe",
      stderr: "pipe",
    });

    const deadline = Date.now() + 20_000;
    while (!existsSync(readyFile) || !readFileSync(readyFile, "utf8").trim()) {
      if (Date.now() > deadline) throw new Error("dsh-plan never became ready");
      await Bun.sleep(25);
    }
    const { port } = JSON.parse(readFileSync(readyFile, "utf8").split("\n")[0]) as { port: number };
    const base = `http://localhost:${port}`;

    const shown = (await (await fetch(`${base}/api/plan`)).json()) as { origin?: string; approvalNotesSupported?: boolean };
    expect(shown.origin).toBe("dsh");
    expect(shown.approvalNotesSupported).toBe(true);

    const approve = await fetch(`${base}/api/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ feedback: "Keep the old flag." }),
    });
    expect(approve.status).toBe(200);
    expect(await proc.exited).toBe(0);

    const lines = (await new Response(proc.stdout).text()).trim().split("\n");
    const out = JSON.parse(lines[lines.length - 1]) as { approved: boolean; feedback?: string; message?: string };
    expect(out.approved).toBe(true);
    expect(out.feedback).toContain("Keep the old flag.");
    expect(out.message).toContain("Keep the old flag.");
  }, 30_000);
});
