#!/usr/bin/env node

const { exitWithFailure, runPlannotator } = require("../lib/run-plannotator");

const result = runPlannotator(["review", ...process.argv.slice(2)]);

if (result.error || result.status !== 0) {
  exitWithFailure(result, "plannotator review");
}

const output = result.stdout.trim();
process.stdout.write(output ? `${output}\n` : "Review session closed without feedback.\n");
