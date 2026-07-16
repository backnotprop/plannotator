#!/usr/bin/env node

const { emitAnnotateDecision, exitWithFailure, runPlannotator } = require("../lib/run-plannotator");

const result = runPlannotator(["annotate", ...process.argv.slice(2), "--json"]);

if (result.error || result.status !== 0) {
  exitWithFailure(result, "plannotator annotate");
}

emitAnnotateDecision(result.stdout, "Markdown Annotations");
