#!/usr/bin/env node

import { appendFileSync } from "node:fs";

let input = "";
for await (const chunk of process.stdin) input += chunk;

const request = JSON.parse(input);
const mode = process.env.PLANNOTATOR_TEST_PRESENTER_MODE;
const logPath = process.env.PLANNOTATOR_TEST_PRESENTER_LOG;
if (logPath) appendFileSync(logPath, `${JSON.stringify(request)}\n`);

if (mode === "hang") {
  setInterval(() => {}, 1_000);
} else if (mode === "flood") {
  process.stdout.write("x".repeat(128 * 1024));
} else if (mode === "invalid") {
  process.stdout.write("not json\n");
} else if (mode === "failure") {
  process.stdout.write(JSON.stringify({
    protocol: 1,
    ok: false,
    error: { code: "fixture_failed", message: "fixture refused" },
  }) + "\n");
  process.exitCode = 1;
} else if (request.action === "present") {
  process.stdout.write(JSON.stringify({
    protocol: 1,
    ok: true,
    handle: { fixture: request.url, kind: request.kind },
  }) + "\n");
} else {
  process.stdout.write(JSON.stringify({ protocol: 1, ok: true }) + "\n");
}
