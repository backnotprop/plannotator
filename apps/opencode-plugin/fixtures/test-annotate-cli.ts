#!/usr/bin/env bun

import { writeFileSync } from "node:fs";

const stdin = await Bun.stdin.text();

const recordFile = process.env.PLANNOTATOR_TEST_RECORD_FILE;
if (recordFile) {
  writeFileSync(recordFile, JSON.stringify({ argv: process.argv.slice(2), stdin }), "utf8");
}

console.log(process.env.PLANNOTATOR_TEST_OUTCOME ?? JSON.stringify({ decision: "dismissed" }));
