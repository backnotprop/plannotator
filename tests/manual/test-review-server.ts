/**
 * Test script for Code Review server
 *
 * Usage:
 *   bun run tests/manual/test-review-server.ts
 *
 * What it does:
 *   1. Starts the review server with OpenCode origin
 *   2. Opens browser for you to test the UI (should show "OpenCode" badge)
 *   3. Prints the feedback result when submitted
 */

import {
  startReviewServer,
  handleReviewServerReady,
} from "@plannotator/server/review";

// @ts-ignore - Bun import attribute for text
import html from "../../apps/review/dist/index.html" with { type: "text" };

// Sample git diff for testing
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

console.error("Starting Code Review server with OpenCode origin...");

const server = await startReviewServer({
  rawPatch: sampleDiff,
  gitRef: "working tree",
  origin: "opencode",
  htmlContent: html as unknown as string,
  onReady: (url, isRemote, port) => handleReviewServerReady(url, isRemote, port),
});

const result = await server.waitForDecision();
await Bun.sleep(1500);
server.stop();

console.log(JSON.stringify(result, null, 2));
process.exit(0);
