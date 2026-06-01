#!/usr/bin/env node

const { exitWithFailure, runPlannotator } = require("../lib/run-plannotator");

const result = runPlannotator(["archive", ...process.argv.slice(2)]);

if (result.error || result.status !== 0) {
  exitWithFailure(result, "plannotator archive");
}

process.stdout.write("Archive browsing finished.\n");
