import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  MOD_PLAN_APPROVAL_MAX_AGE_MS,
  MOD_PLAN_APPROVAL_VERSION,
  MOD_PLAN_APPROVALS_DIR,
  modPlanApprovalsDir,
  modPlanHash,
  takeModPlanApproval,
} from "./mod-plan-approval";
import {
  normalizePlanForHash,
  PLAN_APPROVAL_RECORD_VERSION,
  PLAN_APPROVALS_DIR,
  planApprovalRecord,
} from "../hooks/mod/plan";
import { planApprovalPathOf } from "../hooks/mod/launch";
import { removeStubbedHtml, stubHookDistHtml } from "../../../tests/helpers/hook-dist-stub";
import { NO_BROWSER } from "../../../tests/helpers/no-browser";

const PLAN = "# Ship it\n\n1. Do the thing.\n";
const SESSION = "0b7c1f7e-1111-4222-8333-444455556666";
const roots: string[] = [];

function scratch(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-mod-plan-approval-")));
  roots.push(root);
  return root;
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function modSha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function writeModRecord(
  dataDir: string,
  options: { session?: string; toolUseId?: string; plan?: string; permissionMode?: string; at?: number } = {},
): Promise<string> {
  const plan = options.plan ?? PLAN;
  const { dir, path } = planApprovalPathOf(dataDir, options.session ?? SESSION, options.toolUseId ?? "toolu_02");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const record = planApprovalRecord(
    { hash: await modSha256(normalizePlanForHash(plan)), plan, permissionMode: options.permissionMode, version: 1 },
    options.at ?? Date.now(),
  );
  writeFileSync(path, JSON.stringify(record));
  return path;
}

function permissionRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: SESSION,
    transcript_path: "/nowhere/transcript.jsonl",
    cwd: "/work",
    permission_mode: "plan",
    hook_event_name: "PermissionRequest",
    tool_name: "ExitPlanMode",
    tool_input: { plan: PLAN },
    ...overrides,
  };
}

describe("the mod and the CLI agree on the record", () => {
  test("the folder name, the version and the hash", async () => {
    expect(PLAN_APPROVALS_DIR).toBe(MOD_PLAN_APPROVALS_DIR);
    expect(PLAN_APPROVAL_RECORD_VERSION).toBe(MOD_PLAN_APPROVAL_VERSION);
    const plan = `${PLAN}\n\n  `;
    expect(modPlanHash(plan)).toBe(await modSha256(normalizePlanForHash(plan)));
    expect(planApprovalPathOf("/data", SESSION, "t").dir).toBe(modPlanApprovalsDir("/data", SESSION)!);
  });
});

describe("takeModPlanApproval", () => {
  test("an approved plan is allowed once, with the approved text and the reviewer's mode", async () => {
    const dataDir = scratch();
    const path = await writeModRecord(dataDir, { permissionMode: "acceptEdits" });
    const event = permissionRequest({ tool_input: { plan: `${PLAN}\n`, planFilePath: "/nowhere/p.md" } });

    expect(takeModPlanApproval(event, { dataDir, now: Date.now() })).toEqual({
      behavior: "allow",
      updatedInput: { plan: PLAN, planFilePath: "/nowhere/p.md" },
      updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
    });
    expect(existsSync(path)).toBe(false);
    expect(takeModPlanApproval(event, { dataDir, now: Date.now() })).toBeNull();
  });

  test("the plan file wins over a stale inline plan, as the mod matched it (#1667)", async () => {
    const dataDir = scratch();
    const planFile = join(dataDir, "plan.md");
    writeFileSync(planFile, PLAN);
    await writeModRecord(dataDir);
    const event = permissionRequest({ tool_input: { plan: "# Stale snapshot\n", planFilePath: planFile } });

    expect(takeModPlanApproval(event, { dataDir, now: Date.now() })?.updatedInput.plan).toBe(PLAN);
  });

  test("no mode chosen: no setMode", async () => {
    const dataDir = scratch();
    await writeModRecord(dataDir);
    expect(takeModPlanApproval(permissionRequest(), { dataDir, now: Date.now() })).toEqual({
      behavior: "allow",
      updatedInput: { plan: PLAN },
    });
  });

  test("everything else is left to the classic review, and the record stays", async () => {
    const dataDir = scratch();
    const now = Date.now();
    const path = await writeModRecord(dataDir, { at: now });
    const cases: Array<[string, Record<string, unknown>, number]> = [
      ["another plan", permissionRequest({ tool_input: { plan: "# Something else\n" } }), now],
      ["another session", permissionRequest({ session_id: "another-session" }), now],
      ["a subagent", permissionRequest({ agent_id: "agent-1" }), now],
      ["another tool", permissionRequest({ tool_name: "Bash" }), now],
      ["another event", permissionRequest({ hook_event_name: "PreToolUse" }), now],
      ["no session", permissionRequest({ session_id: undefined }), now],
      ["an empty plan", permissionRequest({ tool_input: { plan: "  " } }), now],
      ["a stale record", permissionRequest(), now + MOD_PLAN_APPROVAL_MAX_AGE_MS + 1],
    ];
    for (const [name, event, at] of cases) {
      expect([name, takeModPlanApproval(event, { dataDir, now: at })]).toEqual([name, null]);
    }
    expect(existsSync(path)).toBe(true);
  });

  test("a session id cannot name a folder outside the mod's", async () => {
    const dataDir = scratch();
    expect(modPlanApprovalsDir(dataDir, "..")).toBeNull();
    expect(modPlanApprovalsDir(dataDir, ".")).toBeNull();
    expect(modPlanApprovalsDir(dataDir, "")).toBeNull();
    expect(modPlanApprovalsDir(dataDir, "../x")).toBe(join(dataDir, "claude-code-mod", ".._x", MOD_PLAN_APPROVALS_DIR));
  });

  test("a record whose plan is not the one its hash names is ignored", async () => {
    const dataDir = scratch();
    const dir = modPlanApprovalsDir(dataDir, SESSION)!;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, "toolu_02.json");
    writeFileSync(path, JSON.stringify({ v: 1, hash: modPlanHash(PLAN), plan: "# Never reviewed\n", at: Date.now() }));

    expect(takeModPlanApproval(permissionRequest(), { dataDir, now: Date.now() })).toBeNull();
    expect(existsSync(path)).toBe(true);
  });

  test("a symlinked plan-approvals folder is not followed", async () => {
    const dataDir = scratch();
    const elsewhere = join(scratch(), "elsewhere");
    await writeModRecord(elsewhere);
    const real = modPlanApprovalsDir(elsewhere, SESSION)!;
    const linked = modPlanApprovalsDir(dataDir, SESSION)!;
    mkdirSync(join(linked, ".."), { recursive: true });
    symlinkSync(real, linked);

    expect(takeModPlanApproval(permissionRequest(), { dataDir, now: Date.now() })).toBeNull();
    expect(readdirSync(real)).toEqual(["toolu_02.json"]);
  });

  test("a malformed record is skipped, a good one beside it still answers", async () => {
    const dataDir = scratch();
    await writeModRecord(dataDir, { toolUseId: "toolu_09" });
    const dir = modPlanApprovalsDir(dataDir, SESSION)!;
    writeFileSync(join(dir, "toolu_01.json"), "{not json");
    writeFileSync(join(dir, "toolu_03.json"), JSON.stringify({ v: 2, hash: modPlanHash(PLAN), plan: "# Wrong\n", at: Date.now() }));

    expect(takeModPlanApproval(permissionRequest(), { dataDir, now: Date.now() })?.updatedInput.plan).toBe(PLAN);
    expect(readdirSync(dir).sort()).toEqual(["toolu_01.json", "toolu_03.json"]);
  });
});

describe("the classic hook as a process", () => {
  const entry = resolve(import.meta.dir, "index.ts");
  let stubs: string[] = [];
  beforeAll(() => {
    stubs = stubHookDistHtml();
  });
  afterAll(() => removeStubbedHtml(stubs));

  async function runHook(dataDir: string, event: Record<string, unknown>, timeoutMs: number) {
    const root = scratch();
    const proc = Bun.spawn([process.execPath, "run", entry], {
      cwd: root,
      stdin: new TextEncoder().encode(JSON.stringify(event)),
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        PLANNOTATOR_DATA_DIR: dataDir,
        PLANNOTATOR_PORT: "0",
        PLANNOTATOR_REMOTE: "0",
        PLANNOTATOR_SKIP_BROWSER_OPEN: "1",
        NO_BROWSER,
        BROWSER: NO_BROWSER,
        PLANNOTATOR_BROWSER: NO_BROWSER,
        PLANNOTATOR_AI: "disabled",
        PLANNOTATOR_SHARE: "disabled",
        PLANNOTATOR_ORIGIN: "claude-code",
      },
    });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    return { stdout, stderr, code };
  }

  test("an approved plan is allowed at once: no review server starts", async () => {
    const dataDir = scratch();
    await writeModRecord(dataDir, { permissionMode: "acceptEdits" });

    const { stdout, stderr, code } = await runHook(dataDir, permissionRequest(), 20_000);

    expect(code).toBe(0);
    expect(stderr).not.toContain("http://");
    expect(JSON.parse(stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "allow",
          updatedInput: { plan: PLAN },
          updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
        },
      },
    });
    expect(existsSync(join(dataDir, "sessions")) ? readdirSync(join(dataDir, "sessions")) : []).toEqual([]);
  }, 30_000);

  test("without a record the classic review opens as before", async () => {
    const dataDir = scratch();
    const { stdout, stderr } = await runHook(dataDir, permissionRequest(), 6_000);

    expect(stdout).toBe("");
    expect(stderr).toContain("http://");
  }, 30_000);
});
