/**
 * A fake `plannotator` CLI for apps/dsh-plugin/tool.test.ts, run as
 * `bun fake-cli.ts <subcommand> ...args`. It records each call, then:
 *   FAKE_CLI_MODE=fail: prints "File not found: <first arg>" and exits 1
 *     before opening anything, as the real CLI does for a bad path;
 *   otherwise: writes the ready line (a URL that serves nothing) and waits
 *     until the test writes `<log dir>/decide-<review id>.json`, then writes
 *     that record to PLANNOTATOR_HOST_RESULT_FILE and exits 0. SIGTERM exits
 *     at once with no record (the plugin's close).
 * Never opens a browser or a port.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [subcommand, ...args] = process.argv.slice(2);
const logDir = process.env.FAKE_CLI_LOG_DIR as string;
const reviewId = process.env.PLANNOTATOR_HOST_REVIEW_ID ?? "none";

appendFileSync(join(logDir, "calls.jsonl"), `${JSON.stringify({
  subcommand,
  args,
  cwd: process.cwd(),
  env: {
    PLANNOTATOR_ORIGIN: process.env.PLANNOTATOR_ORIGIN,
    PLANNOTATOR_SESSION_TAG: process.env.PLANNOTATOR_SESSION_TAG,
    DSH_SESSION_ID: process.env.DSH_SESSION_ID,
    DSH_HOME: process.env.DSH_HOME,
    PLANNOTATOR_HOST_REVIEW_ID: process.env.PLANNOTATOR_HOST_REVIEW_ID,
  },
})}\n`);

if (process.env.FAKE_CLI_MODE === "fail") {
  process.stderr.write(`File not found: ${args[0] ?? ""}\n`);
  process.exit(1);
}

process.on("SIGTERM", () => process.exit(0));

const target = subcommand === "annotate" && args[0] ? resolve(process.cwd(), args[0]) : undefined;
appendFileSync(process.env.PLANNOTATOR_READY_FILE as string, `${JSON.stringify({ url: "http://localhost:9/", port: 9, isRemote: false, ...(target && { target }) })}\n`);

const decideFile = join(logDir, `decide-${reviewId}.json`);
const timer = setInterval(() => {
  if (!existsSync(decideFile)) return;
  clearInterval(timer);
  writeFileSync(process.env.PLANNOTATOR_HOST_RESULT_FILE as string, readFileSync(decideFile, "utf8"));
  process.exit(0);
}, 20);
