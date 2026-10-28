#!/usr/bin/env node

// Opens the Plannotator Inbox in the browser (starting it in the background
// when it is not running) and prints its address. Returns at once.
const { exitWithFailure, runPlannotator } = require("../lib/run-plannotator");

// The CLI waits up to 20 s for an Inbox it starts; never wait much longer.
const result = runPlannotator(["inbox", "--open"], { timeout: 30_000 });

if (result.error || result.status !== 0) {
  exitWithFailure(result, "plannotator inbox --open");
}

// Stderr says why no browser opened, when none did (a remote session).
const note = (result.stderr || "").trim();
process.stdout.write(`Plannotator Inbox: ${result.stdout.trim()}${note ? `\n${note}` : ""}\n`);
