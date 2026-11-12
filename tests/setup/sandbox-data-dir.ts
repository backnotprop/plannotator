import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isScratchDataDir, refuseRealDataDir, TEST_SANDBOX_ENV } from "../helpers/real-data-dir";

const current = process.env.PLANNOTATOR_DATA_DIR?.trim();
if (!current || !isScratchDataDir(current)) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-test-")));
  if (current) process.stderr.write(`tests/setup/sandbox-data-dir.ts: PLANNOTATOR_DATA_DIR=${current} is not a scratch folder; using ${dir} instead.\n`);
  process.env.PLANNOTATOR_DATA_DIR = dir;
  process.env[TEST_SANDBOX_ENV] = dir;
  process.once("exit", () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
    }
  });
}
refuseRealDataDir(process.env.PLANNOTATOR_DATA_DIR, "tests/setup/sandbox-data-dir.ts");
