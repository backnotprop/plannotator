/**
 * `plannotator inbox --help` and Branch reviews. What regresses: the guide naming send_message's `branch` field while
 * Branch reviews (or Code review) is off, so an agent sends a field the Inbox refuses, or the guide changing at all for
 * a person who has it off.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_BRANCH_FIELD_DESCRIPTION } from "@plannotator/core/inbox-branch-reports";
import { createAgentEnvironmentFor } from "@plannotator/server/inbox-agents";
import { formatInboxHelp } from "./inbox-help";

const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-help-branch-")));
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
  codeReview: true,
};

test("off, the guide is byte for byte the guide without Branch reviews; on, send_message lists `branch` once", () => {
  const unset = formatInboxHelp(base);
  expect(formatInboxHelp({ ...base, branchReviews: false })).toBe(unset);
  // Code review off: no branch field, whatever the Branch reviews switch says.
  expect(formatInboxHelp({ ...base, codeReview: false, branchReviews: true })).toBe(formatInboxHelp({ ...base, codeReview: false }));
  expect(unset).not.toContain(INBOX_BRANCH_FIELD_DESCRIPTION);
  const on = formatInboxHelp({ ...base, branchReviews: true });
  const send = on.slice(on.indexOf("### send_message"), on.indexOf("###", on.indexOf("### send_message") + 4));
  expect(send).toContain("`branch`");
  expect(send).toContain(INBOX_BRANCH_FIELD_DESCRIPTION);
  expect(on.split(INBOX_BRANCH_FIELD_DESCRIPTION)).toHaveLength(2);
});
