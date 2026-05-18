import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runPlannotatorCommand } from "./run-plannotator";
import { parseSessionReadyLine } from "./session-ready";

describe("Plannotator process runner", () => {
  test("parses PLANNOTATOR_SESSION_READY from stderr", () => {
    const session = parseSessionReadyLine(
      'PLANNOTATOR_SESSION_READY {"mode":"plan","url":"http://127.0.0.1:19432/s/a","port":19432,"isRemote":false}',
    );

    expect(session?.mode).toBe("plan");
    expect(session?.url).toContain("/s/a");
  });

  test("captures stdout, stderr, exit status, and session readiness", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plannotator-process-"));
    const script = join(dir, "child.ts");
    await writeFile(
      script,
      `
console.error('progress line');
console.error('PLANNOTATOR_SESSION_READY {"mode":"review","url":"http://127.0.0.1:19432/s/review","port":19432,"isRemote":false}');
console.log('{"ok":true}');
`,
    );

    const result = await runPlannotatorCommand({
      command: process.execPath,
      args: [script],
      cwd: dir,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('"ok":true');
    expect(result.stderr).toContain("progress line");
    expect(result.session?.mode).toBe("review");
  });
});
