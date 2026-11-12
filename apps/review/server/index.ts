import { $ } from "bun";
import {
  startReviewServer,
  handleReviewServerReady,
} from "@plannotator/server/review";

// @ts-ignore - Bun import attribute for text
import indexHtml from "../dist/index.html" with { type: "text" };
const htmlContent = indexHtml as unknown as string;

const args = process.argv.slice(2);
const isStaged = args.includes("--staged");
const gitRef = args.filter((arg) => arg !== "--staged").join(" ").trim();

let diffCommand: string[];
if (isStaged) {
  diffCommand = ["git", "diff", "--no-ext-diff", "--staged"];
} else if (gitRef) {
  diffCommand = ["git", "diff", "--no-ext-diff", gitRef];
} else {
  diffCommand = ["git", "diff", "--no-ext-diff"];
}

let rawPatch = "";
try {
  const result = await $`${diffCommand}`.quiet();
  rawPatch = result.text();
} catch (err) {
  console.error("Failed to get git diff:", err);
  process.exit(1);
}

let displayRef: string;
if (isStaged) {
  displayRef = "--staged";
} else if (gitRef) {
  displayRef = gitRef;
} else {
  displayRef = "working tree";
}

const server = await startReviewServer({
  rawPatch,
  gitRef: displayRef,
  htmlContent,
  approvalNotesSupported: true,
  onReady: (url, isRemote, port) => {
    handleReviewServerReady(url, isRemote, port);
    console.error(`Code review at ${url}`);
    if (isRemote) {
      console.error(`(Remote mode detected — if no browser opens automatically, use the URL above)`);
    }
  },
});

const result = await server.waitForDecision();

await Bun.sleep(500);

server.stop();

console.log(
  JSON.stringify({
    gitRef: displayRef,
    approved: result.approved,
    feedback: result.feedback,
    annotations: result.annotations,
  }, null, 2)
);

process.exit(0);
