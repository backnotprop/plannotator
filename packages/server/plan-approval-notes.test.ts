/** The plan server advertises `approvalNotesSupported` on /api/plan; absent must read as false so an unknown host is never offered a row that loses notes. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPlannotatorServer } from "./index";

const MINIMAL_HTML = "<html><body>Plannotator</body></html>";
const ENV_KEYS = ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_AI", "PLANNOTATOR_PORT", "PLANNOTATOR_REMOTE", "PLANNOTATOR_FEEDBACK_HISTORY"] as const;
const saved: Record<string, string | undefined> = {};
const tempDirs: string[] = [];

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  const dir = mkdtempSync(join(tmpdir(), "plannotator-plan-notes-"));
  tempDirs.push(dir);
  process.env.PLANNOTATOR_DATA_DIR = dir;
  process.env.PLANNOTATOR_AI = "disabled";
  process.env.PLANNOTATOR_REMOTE = "0";
  process.env.PLANNOTATOR_FEEDBACK_HISTORY = "0";
  delete process.env.PLANNOTATOR_PORT;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key]!;
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function newPlan(): string {
  const plan = `# Plan notes advert ${Math.random().toString(36).slice(2, 10)}\n\nStep one.\n`;
  return plan;
}

async function advert(options: { approvalNotesSupported?: boolean }) {
  const server = await startPlannotatorServer({ plan: newPlan(), htmlContent: MINIMAL_HTML, origin: "claude-code", ...options });
  try {
    const body = (await (await fetch(`${server.url}/api/plan`)).json()) as { approvalNotesSupported?: unknown };
    return body.approvalNotesSupported;
  } finally {
    await server.stop();
  }
}

describe("plan /api/plan approvalNotesSupported", () => {
  test("absent option advertises false (the classic hook, Gemini, Codex, Copilot, Vibe)", async () => {
    expect(await advert({})).toBe(false);
  });

  test("a host that delivers notes on approval advertises true", async () => {
    expect(await advert({ approvalNotesSupported: true })).toBe(true);
  });

  test("the approval's feedback and the bare approval reach the decision unchanged", async () => {
    for (const body of [{ feedback: "# Plan Feedback\n\nKeep it small.\n" }, {}]) {
      const server = await startPlannotatorServer({
        plan: newPlan(), htmlContent: MINIMAL_HTML, origin: "opencode", approvalNotesSupported: true,
      });
      try {
        const response = await fetch(`${server.url}/api/approve`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ planSave: { enabled: false }, ...body }),
        });
        expect(response.status).toBe(200);
        const decision = await server.waitForDecision();
        expect(decision.approved).toBe(true);
        expect(decision.feedback).toBe("feedback" in body ? body.feedback : undefined);
      } finally {
        await server.stop();
      }
    }
  });
});
