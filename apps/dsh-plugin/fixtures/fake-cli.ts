import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [subcommand, ...args] = process.argv.slice(2);
const logDir = process.env.FAKE_CLI_LOG_DIR as string;
const reviewId = process.env.PLANNOTATOR_HOST_REVIEW_ID ?? "none";
const mode = process.env.FAKE_CLI_MODE;
const delay = Number(process.env.FAKE_CLI_DELAY_MS ?? "300");

appendFileSync(join(logDir, "calls.jsonl"), `${JSON.stringify({
  subcommand,
  args,
  pid: process.pid,
  cwd: process.cwd(),
  env: {
    PLANNOTATOR_ORIGIN: process.env.PLANNOTATOR_ORIGIN,
    PLANNOTATOR_SESSION_TAG: process.env.PLANNOTATOR_SESSION_TAG,
    DSH_SESSION_ID: process.env.DSH_SESSION_ID,
    DSH_HOME: process.env.DSH_HOME,
    PLANNOTATOR_HOST_REVIEW_ID: process.env.PLANNOTATOR_HOST_REVIEW_ID,
  },
})}\n`);

if (mode === "fail") {
  process.stderr.write(`File not found: ${args[0] ?? ""}\n`);
  process.exit(1);
}

process.on("SIGTERM", () => {
  if (process.env.FAKE_CLI_IGNORE_TERM !== "1") process.exit(0);
});

const ready = () => {
  const target = subcommand === "annotate" && args[0] ? resolve(process.cwd(), args[0]) : undefined;
  appendFileSync(process.env.PLANNOTATOR_READY_FILE as string, `${JSON.stringify({ url: "http://localhost:9/", port: 9, isRemote: false, ...(target && { target }) })}\n`);
};

if (mode === "hang") {
  setInterval(() => {}, 1000);
} else if (mode === "late-fail") {
  setTimeout(() => {
    process.stderr.write("Port in use\n");
    process.exit(1);
  }, delay);
} else if (mode === "crash") {
  ready();
  setTimeout(() => process.exit(1), delay);
} else {
  ready();
  const decideFile = join(logDir, `decide-${reviewId}.json`);
  const timer = setInterval(() => {
    if (!existsSync(decideFile)) return;
    clearInterval(timer);
    writeFileSync(process.env.PLANNOTATOR_HOST_RESULT_FILE as string, readFileSync(decideFile, "utf8"));
    process.exit(0);
  }, 20);
}
