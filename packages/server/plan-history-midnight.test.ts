/**
 * A plan revised across UTC midnight keeps its version history (#1679).
 *
 * What regresses if this fails: the plan server keys history by today's date
 * again, so a revision that arrives after midnight lands in a fresh history
 * directory as version 1, `previousPlan` is null and the Versions tab and the
 * diff disappear. Also guards the other half of the split: the decision
 * snapshot in plans/ stays named by the decision day.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPlannotatorServer } from "./index";
import { detectProjectName } from "./project";

const MINIMAL_HTML = "<html><body>Plannotator</body></html>";
const ENV_KEYS = ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_AI", "PLANNOTATOR_PORT", "PLANNOTATOR_REMOTE", "PLANNOTATOR_FEEDBACK_HISTORY"] as const;

async function sandboxed(run: (dataDir: string) => Promise<void>): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  const dataDir = mkdtempSync(join(tmpdir(), "plannotator-plan-midnight-"));
  try {
    process.env.PLANNOTATOR_DATA_DIR = dataDir;
    process.env.PLANNOTATOR_AI = "disabled";
    process.env.PLANNOTATOR_REMOTE = "0";
    process.env.PLANNOTATOR_FEEDBACK_HISTORY = "0";
    delete process.env.PLANNOTATOR_PORT;
    await run(dataDir);
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key]!;
    }
    rmSync(dataDir, { recursive: true, force: true });
  }
}

const utcDay = (ms: number) => new Date(ms).toISOString().split("T")[0];

describe("plan server history across midnight (#1679)", () => {
  test("a plan whose chain started yesterday continues it, while the archive is dated today", async () => sandboxed(async (dataDir) => {
    const project = (await detectProjectName()) ?? "_unknown";
    const v1 = "# Midnight Chain\n\n- [ ] First step.\n";
    const v2 = "# Midnight Chain\n\n- [ ] First step, revised.\n";
    // Version 1 was saved two hours ago under yesterday's UTC date.
    const savedAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const yesterdaySlug = `midnight-chain-${utcDay(Date.now() - 24 * 60 * 60 * 1000)}`;
    const chainDir = join(dataDir, "history", project, yesterdaySlug);
    mkdirSync(chainDir, { recursive: true });
    writeFileSync(join(chainDir, "001.md"), v1);
    utimesSync(join(chainDir, "001.md"), savedAt, savedAt);

    const server = await startPlannotatorServer({ plan: v2, htmlContent: MINIMAL_HTML, origin: "claude-code" });
    try {
      const payload = (await (await fetch(`${server.url}/api/plan`)).json()) as Record<string, any>;
      expect(payload.previousPlan).toBe(v1);
      expect(payload.versionInfo.version).toBe(2);
      expect(payload.versionInfo.totalVersions).toBe(2);
      const versions = (await (await fetch(`${server.url}/api/plan/versions`)).json()) as Record<string, any>;
      expect(versions.slug).toBe(yesterdaySlug);
      expect(existsSync(join(chainDir, "002.md"))).toBe(true);

      const approve = await fetch(`${server.url}/api/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planSave: { enabled: true } }),
      });
      expect(approve.status).toBe(200);
      const decision = await server.waitForDecision();
      expect(decision.savedPath).toBe(join(dataDir, "plans", `midnight-chain-${utcDay(Date.now())}-approved.md`));
    } finally {
      await server.stop();
    }
  }));
});
