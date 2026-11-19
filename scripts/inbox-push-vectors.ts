/**
 * Rewrites packages/core/fixtures/inbox-relay-push-v2-vectors.json from the Inbox's push rules
 * (packages/core/inbox-push-vectors.ts). Envelopes get fresh IVs; everything else is fixed by
 * the inputs there. packages/core/inbox-push.test.ts fails until the file matches the code.
 *
 *   bun scripts/inbox-push-vectors.ts
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inboxPushVectors } from "../packages/core/inbox-push-vectors";

const file = fileURLToPath(new URL("../packages/core/fixtures/inbox-relay-push-v2-vectors.json", import.meta.url));
writeFileSync(file, `${JSON.stringify(await inboxPushVectors(), null, 2)}\n`);
console.log(`wrote ${file}`);
