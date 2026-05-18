#!/usr/bin/env node
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(path.dirname(__filename), "..");
const sourceEntry = path.join(repoRoot, "apps", "hook", "server", "index.ts");

if (!fs.existsSync(sourceEntry)) {
  console.error(`Could not find Plannotator source entry at ${sourceEntry}`);
  process.exit(1);
}

const child = childProcess.spawn("bun", [sourceEntry, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  stdio: "inherit",
});

let forwardedSignal = null;
const forwardSignal = (signal) => {
  forwardedSignal = signal;
  if (!child.killed) child.kill(signal);
};

process.once("SIGINT", () => forwardSignal("SIGINT"));
process.once("SIGTERM", () => forwardSignal("SIGTERM"));

child.on("error", (err) => {
  console.error(err.message);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (code !== null) {
    process.exit(code);
  }
  if (signal || forwardedSignal) {
    process.exit(signal === "SIGINT" || forwardedSignal === "SIGINT" ? 130 : 143);
  }
  process.exit(1);
});
