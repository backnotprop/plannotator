/**
 * `plannotator inbox --help` and Code review (approval
 * "inbox-code-review-direction"). What regresses: the guide naming
 * submit_guide's `review` field while the person has Code review off (an
 * agent would send a field the Inbox refuses), or leaving out a field the
 * Inbox serves while it is on.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { startInboxServer } from "@plannotator/server/inbox";
import { createAgentEnvironmentFor } from "@plannotator/server/inbox-agents";
import { INBOX_FILLED_ARGUMENTS } from "@plannotator/shared/inbox/connection";
import { formatInboxHelp } from "./inbox-help";

const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-help-code-review-")));
const home = join(root, "home");
mkdirSync(home, { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));

const base = {
  command: ["/opt/example/plannotator"],
  dataDir: "/home/someone/.plannotator",
  platform: "linux" as const,
  agentEnvironment: createAgentEnvironmentFor({ platform: "linux", homeDir: home, env: { HOME: home, PATH: "" } }),
  board: true,
  steps: true,
};

const section = (help: string, name: string) => {
  const start = help.indexOf(`\n### ${name}\n`);
  return help.slice(start, help.indexOf("\n### ", start + 5));
};

test("off (unset or false), the guide is byte-equal and names no review field; on, submit_guide covers every field the Inbox serves", async () => {
  const unset = formatInboxHelp(base);
  expect(formatInboxHelp({ ...base, codeReview: false })).toBe(unset);
  expect(section(unset, "submit_guide")).not.toContain("`review`");
  const on = formatInboxHelp({ ...base, codeReview: true });
  expect(section(on, "submit_guide")).toContain("`review`");
  // Only submit_guide's section changes.
  expect(on.replace(section(on, "submit_guide"), "")).toBe(unset.replace(section(unset, "submit_guide"), ""));

  const dataDir = join(root, "served");
  const saved = process.env.PLANNOTATOR_DATA_DIR;
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  const server = await startInboxServer({ dataDir, codeReview: true, phones: false });
  const client = new Client({ name: "inbox-help-code-review-test", version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
    const { tools } = await client.listTools();
    const properties = Object.keys((tools.find((tool) => tool.name === "submit_guide")!.inputSchema as { properties: Record<string, unknown> }).properties);
    expect(properties).toContain("review");
    for (const property of properties) {
      const covered = (INBOX_FILLED_ARGUMENTS as readonly string[]).includes(property) || section(on, "submit_guide").includes(`\`${property}\``);
      expect(covered, `submit_guide's argument ${property} is not in the guide`).toBe(true);
    }
  } finally {
    await client.close();
    server.stop();
    if (saved === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
    else process.env.PLANNOTATOR_DATA_DIR = saved;
  }
});
