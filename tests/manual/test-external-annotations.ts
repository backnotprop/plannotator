/**
 * Test script for External Annotations API
 *
 * Usage:
 *   bun run tests/manual/test-external-annotations.ts
 *
 * What it does:
 *   1. Starts the review server with a sample diff (sandbox mode)
 *   2. Opens browser so you can see annotations arrive in real-time
 *   3. Sends a batch of annotations over timed intervals
 *   4. Demonstrates single add, batch add, delete, and clear operations
 *   5. Prints server decision when you submit feedback
 */

import {
  startReviewServer,
  handleReviewServerReady,
} from "@plannotator/server/review";

// @ts-ignore - Bun import attribute for text
import html from "../../apps/review/dist/index.html" with { type: "text" };

// ---------------------------------------------------------------------------
// Sample diff (same as test-review-server.ts)
// ---------------------------------------------------------------------------

const sampleDiff = `diff --git a/src/utils/parser.ts b/src/utils/parser.ts
index 1234567..abcdefg 100644
--- a/src/utils/parser.ts
+++ b/src/utils/parser.ts
@@ -10,6 +10,8 @@ export function parseMarkdown(input: string): Block[] {
   const blocks: Block[] = [];
   const lines = input.split('\\n');

+  // Handle empty input
+  if (lines.length === 0) return blocks;
+
   for (const line of lines) {
     if (line.startsWith('#')) {
       blocks.push({ type: 'heading', content: line });
@@ -25,7 +27,7 @@ export function parseMarkdown(input: string): Block[] {
 }

 export function formatBlock(block: Block): string {
-  return block.content;
+  return block.content.trim();
 }

 // New helper function
diff --git a/src/components/App.tsx b/src/components/App.tsx
index 7654321..fedcba9 100644
--- a/src/components/App.tsx
+++ b/src/components/App.tsx
@@ -1,5 +1,6 @@
 import React, { useState, useEffect } from 'react';
 import { parseMarkdown } from '../utils/parser';
+import { formatBlock } from '../utils/parser';

 export function App() {
   const [blocks, setBlocks] = useState<Block[]>([]);
@@ -15,6 +16,10 @@ export function App() {
     fetchData();
   }, []);

+  const handleFormat = (block: Block) => {
+    return formatBlock(block);
+  };
+
   return (
     <div className="app">
       <h1>Plannotator</h1>
@@ -22,7 +27,7 @@ export function App() {
         {blocks.map((block, i) => (
           <div key={i} className="block">
             <span className="type">{block.type}</span>
-            <span className="content">{block.content}</span>
+            <span className="content">{handleFormat(block)}</span>
           </div>
         ))}
       </div>
diff --git a/package.json b/package.json
index 1111111..2222222 100644
--- a/package.json
+++ b/package.json
@@ -5,7 +5,8 @@
   "scripts": {
     "dev": "vite",
     "build": "vite build",
-    "test": "vitest"
+    "test": "vitest",
+    "lint": "eslint src/"
   },
   "dependencies": {
     "react": "^18.2.0"
`;

// ---------------------------------------------------------------------------
// Annotation sequences to send
// ---------------------------------------------------------------------------

const ANNOTATIONS = {
  // Wave 1: Single annotation (eslint warning)
  wave1: {
    source: "eslint",
    kind: "warning",
    filePath: "src/utils/parser.ts",
    lineStart: 12,
    lineEnd: 12,
    comment: "Unexpected empty return. Consider returning an explicit empty array for clarity.",
    ruleId: "no-implicit-return",
    url: "https://eslint.org/docs/rules/no-implicit-return",
  },

  // Wave 2: Batch of 3 annotations (linter + type checker)
  wave2: [
    {
      source: "eslint",
      kind: "error",
      filePath: "src/components/App.tsx",
      lineStart: 3,
      lineEnd: 3,
      selectedText: "import { formatBlock } from '../utils/parser';",
      comment: "Duplicate import from '../utils/parser'. Merge with line 2.",
      ruleId: "no-duplicate-imports",
    },
    {
      source: "typescript",
      kind: "error",
      filePath: "src/components/App.tsx",
      lineStart: 19,
      lineEnd: 21,
      selectedText: "const handleFormat = (block: Block) => {\n    return formatBlock(block);\n  };",
      comment: "Parameter 'block' implicitly has an 'any' type. Add explicit type annotation.",
      ruleId: "TS7006",
    },
    {
      source: "eslint",
      kind: "suggestion",
      filePath: "src/utils/parser.ts",
      lineStart: 28,
      lineEnd: 28,
      selectedText: "return block.content.trim();",
      comment: "Consider using optional chaining for safer access.",
      suggestedCode: "return block.content?.trim() ?? '';",
      ruleId: "prefer-optional-chain",
    },
  ],

  // Wave 3: Info annotation (coverage report)
  wave3: {
    source: "coverage",
    kind: "info",
    filePath: "src/utils/parser.ts",
    comment: "Branch coverage: 67% (2/3 branches). Missing: empty input path.",
    metadata: { coverage: 67, branches: { covered: 2, total: 3 } },
  },

  // Wave 4: Package.json suggestion
  wave4: {
    source: "depcheck",
    kind: "warning",
    filePath: "package.json",
    lineStart: 9,
    lineEnd: 9,
    comment: "eslint is referenced in scripts but not listed in devDependencies.",
    ruleId: "missing-dependency",
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE = "/api/external-annotations";

async function post(port: number, body: object) {
  const res = await fetch(`http://localhost:${port}${BASE}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function del(port: number, params: string) {
  const res = await fetch(`http://localhost:${port}${BASE}?${params}`, {
    method: "DELETE",
  });
  return res.json();
}

function log(msg: string) {
  const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
  console.error(`[${ts}] ${msg}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

log("Starting Code Review server with external annotations demo...");

const server = await startReviewServer({
  rawPatch: sampleDiff,
  gitRef: "demo (external annotations)",
  origin: "claude-code",
  htmlContent: html as unknown as string,
  onReady: (url, isRemote, port) => {
    handleReviewServerReady(url, isRemote, port);
    log(`Server running at ${url}`);
    log("");
    log("=== External Annotations Demo ===");
    log("Watch the browser — annotations will arrive in real-time.");
    log("");

    // Schedule annotation waves
    scheduleWaves(port);
  },
});

async function scheduleWaves(port: number) {
  // Wave 1: Single annotation after 2s
  await Bun.sleep(2000);
  log("Wave 1: Sending single eslint warning...");
  const r1 = await post(port, ANNOTATIONS.wave1);
  log(`  → Created: ${JSON.stringify(r1.ids)}`);

  // Wave 2: Batch of 3 after 3s
  await Bun.sleep(3000);
  log("Wave 2: Sending batch of 3 annotations (eslint + typescript)...");
  const r2 = await post(port, { annotations: ANNOTATIONS.wave2 });
  log(`  → Created: ${JSON.stringify(r2.ids)}`);

  // Wave 3: Info annotation after 3s
  await Bun.sleep(3000);
  log("Wave 3: Sending coverage info annotation...");
  const r3 = await post(port, ANNOTATIONS.wave3);
  log(`  → Created: ${JSON.stringify(r3.ids)}`);

  // Wave 4: One more after 2s
  await Bun.sleep(2000);
  log("Wave 4: Sending depcheck warning...");
  const r4 = await post(port, ANNOTATIONS.wave4);
  log(`  → Created: ${JSON.stringify(r4.ids)}`);

  // Wave 5: Delete the first annotation after 3s
  await Bun.sleep(3000);
  const firstId = r1.ids[0];
  log(`Wave 5: Deleting first annotation (${firstId})...`);
  await del(port, `id=${firstId}`);
  log(`  → Deleted`);

  // Wave 6: Clear all eslint annotations after 4s
  await Bun.sleep(4000);
  log("Wave 6: Clearing all eslint annotations...");
  const r6 = await del(port, "source=eslint");
  log(`  → Cleared ${r6.removed} eslint annotations`);

  log("");
  log("=== Demo complete ===");
  log("Remaining annotations should be: coverage + depcheck");
  log("Submit feedback or close the browser when done.");
}

// Wait for user to submit
const result = await server.waitForDecision();
await Bun.sleep(1500);
server.stop();

log("");
log("Result:");
console.log(JSON.stringify(result, null, 2));
process.exit(0);
