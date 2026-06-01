#!/usr/bin/env node

const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const bundledRepoBin = path.resolve(__dirname, "..", "..", "..", "bin", "plannotator.js");

function findRepoBin(startDir) {
  let dir = path.resolve(startDir);

  while (true) {
    const packageJsonPath = path.join(dir, "package.json");
    const candidateBin = path.join(dir, "bin", "plannotator.js");

    if (fs.existsSync(packageJsonPath) && fs.existsSync(candidateBin)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
        if (pkg && pkg.name === "plannotator") {
          return candidateBin;
        }
      } catch {
        // Ignore malformed package.json while walking up.
      }
    }

    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return fs.existsSync(bundledRepoBin) ? bundledRepoBin : null;
}

function writeIfPresent(stream, text) {
  if (!text) return;
  stream.write(text.endsWith("\n") ? text : `${text}\n`);
}

function runPlannotator(args) {
  const repoBin = findRepoBin(process.cwd());
  const env = {
    ...process.env,
    PLANNOTATOR_CWD: process.cwd(),
    PLANNOTATOR_ORIGIN: "droid",
  };

  let result = childProcess.spawnSync("plannotator", args, {
    encoding: "utf8",
    env,
  });

  if (result.error && result.error.code === "ENOENT" && repoBin) {
    result = childProcess.spawnSync(process.execPath, [repoBin, ...args], {
      encoding: "utf8",
      env,
    });
  }

  return result;
}

function exitWithFailure(result, invocation) {
  writeIfPresent(process.stderr, result.stderr);
  writeIfPresent(process.stderr, result.stdout);

  if (result.error && result.error.code === "ENOENT") {
    writeIfPresent(
      process.stderr,
      [
        `Could not run \`${invocation}\` because the \`plannotator\` CLI is not installed or not on PATH.`,
        "Install it first: https://plannotator.ai/docs/getting-started/installation/",
      ].join("\n"),
    );
  } else if (result.error) {
    writeIfPresent(process.stderr, `${invocation} failed: ${result.error.message}`);
  }

  process.exit(typeof result.status === "number" ? result.status : 1);
}

function emitAnnotateDecision(rawOutput, heading) {
  const output = rawOutput.trim();
  if (!output) {
    process.stdout.write("Annotation session closed.\n");
    return;
  }

  try {
    const parsed = JSON.parse(output);
    if (parsed && typeof parsed === "object") {
      if (parsed.decision === "approved") {
        process.stdout.write("Approved.\n");
        return;
      }

      if (parsed.decision === "dismissed") {
        process.stdout.write("Annotation session closed.\n");
        return;
      }

      if (parsed.decision === "annotated") {
        const feedback = typeof parsed.feedback === "string" ? parsed.feedback.trim() : "";
        if (!feedback) {
          process.stdout.write("Annotation session closed.\n");
          return;
        }
        process.stdout.write(
          `# ${heading}\n\n${feedback}\n\nPlease address the annotation feedback above.\n`,
        );
        return;
      }
    }
  } catch {
    // Fall back to the raw output below.
  }

  writeIfPresent(process.stdout, output);
}

module.exports = {
  emitAnnotateDecision,
  exitWithFailure,
  runPlannotator,
};
