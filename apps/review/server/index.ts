/**
 * Code Review Ephemeral Server
 *
 * Spawned to serve the code review UI for git diffs.
 * Supports both local and remote sessions.
 *
 * Usage:
 *   bun apps/review/server/index.ts           # Unstaged changes (git diff)
 *   bun apps/review/server/index.ts --staged  # Staged changes
 *   bun apps/review/server/index.ts main      # Diff against ref
 *   bun apps/review/server/index.ts HEAD~5..HEAD  # Commit range
 *
 * Environment variables:
 *   PLANNOTATOR_REMOTE - Set to "1" or "true" for remote mode
 *   PLANNOTATOR_PORT   - Fixed port to use (default: random locally, 19432 for remote)
 */

import { $ } from "bun";
import {
  startReviewServer,
  handleReviewServerReady,
} from "@plannotator/server/review";

// Embed the built HTML at compile time
// @ts-ignore - Bun import attribute for text
import indexHtml from "../dist/index.html" with { type: "text" };
const htmlContent = indexHtml as unknown as string;

// Parse CLI arguments
const args = process.argv.slice(2);
const isStaged = args.includes("--staged");
const gitRef = args.filter((arg) => arg !== "--staged").join(" ").trim();

// Build git diff command
let diffCommand: string[];
if (isStaged) {
  diffCommand = ["git", "diff", "--staged"];
} else if (gitRef) {
  diffCommand = ["git", "diff", gitRef];
} else {
  diffCommand = ["git", "diff"];
}

// Execute git diff
let rawPatch = "";
try {
  const result = await $`${diffCommand}`.quiet();
  rawPatch = result.text();
} catch (err) {
  console.error("Failed to get git diff:", err);
  process.exit(1);
}

if (!rawPatch.trim()) {
  console.error("No changes to review");
  process.exit(0);
}

// Determine display ref for UI
let displayRef: string;
if (isStaged) {
  displayRef = "--staged";
} else if (gitRef) {
  displayRef = gitRef;
} else {
  displayRef = "working tree";
}

// Start the review server
const server = await startReviewServer({
  rawPatch,
  gitRef: displayRef,
  htmlContent,
  onReady: (url, isRemote, port) => {
    handleReviewServerReady(url, isRemote, port);
    console.error(`Code review at ${url}`);
    if (isRemote) {
      console.error(`(Remote mode - manually open the URL above)`);
    }
  },
});

// Wait for user feedback submission
const result = await server.waitForDecision();

// Give browser time to receive response and update UI
await Bun.sleep(500);

// Cleanup
server.stop();

// Output the feedback as JSON
console.log(
  JSON.stringify({
    gitRef: displayRef,
    feedback: result.feedback,
    annotations: result.annotations,
  }, null, 2)
);

process.exit(0);
