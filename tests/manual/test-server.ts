import { startPlannotatorServer, handleServerReady } from "@plannotator/server";

// @ts-ignore - Bun import attribute for text
import html from "../../apps/hook/dist/index.html" with { type: "text" };

const origin = process.argv[2] || "claude-code";
const sharingEnabled = process.env.PLANNOTATOR_SHARE !== "disabled";

const plan = `# Test Plan: Sample Feature

## Overview
This is a sample plan for testing the Plannotator UI.

## Implementation

\`\`\`typescript
function hello() {
  console.log("Hello, world!");
}
\`\`\`

## Checklist
- [ ] Step 1
- [ ] Step 2
- [x] Step 3
`;

console.error(`Starting Plannotator server with origin: ${origin}`);

const server = await startPlannotatorServer({
  plan,
  origin,
  sharingEnabled,
  htmlContent: html as unknown as string,
  onReady: (url, isRemote, port) => handleServerReady(url, isRemote, port),
});

const result = await server.waitForDecision();
await Bun.sleep(1500);
server.stop();

console.log(JSON.stringify(result, null, 2));
process.exit(0);
