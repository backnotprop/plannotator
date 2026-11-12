import { expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { INBOX_TOOL_COST, type InboxToolCostHost } from "../../packages/core/inbox-types";

export function expectMeasuredCost(host: InboxToolCostHost, entry: string): void {
  const bytes = Buffer.byteLength(entry);
  if (process.env.INBOX_TOOL_COST_DUMP) writeFileSync(`${process.env.INBOX_TOOL_COST_DUMP}/${host}.json`, entry);
  const stated = INBOX_TOOL_COST[host];
  console.log(`[inbox tool cost] ${host}: measured ${bytes} bytes; the window states ${stated.bytes} bytes, about ${stated.tokens} tokens`);
  expect(Math.abs(bytes - stated.bytes) / stated.bytes).toBeLessThanOrEqual(0.05);
}
