#!/usr/bin/env node

const { exitWithFailure, runPlannotator } = require("../lib/run-plannotator");

const result = runPlannotator(["snapshot", "--wait", ...process.argv.slice(2)]);

if (result.error || result.status !== 0) {
  exitWithFailure(result, "plannotator snapshot");
}

const output = result.stdout.trim();
process.stdout.write(output ? `${output}\n` : "Plannotator Snapshots closed without sending anything.\n");
