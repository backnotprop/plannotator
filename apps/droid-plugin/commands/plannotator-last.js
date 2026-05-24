#!/usr/bin/env node

const { emitAnnotateDecision, exitWithFailure, runPlannotator } = require("../lib/run-plannotator");

const result = runPlannotator(["annotate-last", ...process.argv.slice(2), "--json"]);

if (result.error || result.status !== 0) {
  exitWithFailure(result, "plannotator annotate-last");
}

emitAnnotateDecision(result.stdout, "Message Annotations");
