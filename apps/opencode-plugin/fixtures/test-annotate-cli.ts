#!/usr/bin/env bun

// Stand-in for the `plannotator` binary in CLI-bridge annotate tests: records
// its argv and stdin, then prints the decision record the test asked for, the
// way `opencode-annotate-last` / `annotate --json` do.

import { writeFileSync } from "node:fs";

const stdin = await Bun.stdin.text();

const recordFile = process.env.PLANNOTATOR_TEST_RECORD_FILE;
if (recordFile) {
  writeFileSync(recordFile, JSON.stringify({ argv: process.argv.slice(2), stdin }), "utf8");
}

console.log(process.env.PLANNOTATOR_TEST_OUTCOME ?? JSON.stringify({ decision: "dismissed" }));
