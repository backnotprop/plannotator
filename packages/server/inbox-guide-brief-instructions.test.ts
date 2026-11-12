import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GUIDE_REVIEW_PROMPT } from "@plannotator/core/guide-prompt";
import { writeGuideInstructions } from "@plannotator/shared/guide-instructions-store";
import { composeGuideMethodology } from "./guide/guide-review";
import { createInboxMcpServer, type InboxMcpContext } from "./inbox-mcp";

let dir: string;
let priorDataDir: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pn-guide-brief-instructions-"));
  priorDataDir = process.env.PLANNOTATOR_DATA_DIR;
  process.env.PLANNOTATOR_DATA_DIR = dir;
});

afterEach(() => {
  if (priorDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = priorDataDir;
  rmSync(dir, { recursive: true, force: true });
});

type Brief = { structuredContent?: { methodology?: string } };
type Registered = Record<string, { handler?: (input: unknown, ctx: unknown) => Promise<unknown> }>;
const methodology = async (): Promise<string | undefined> => {
  const server = createInboxMcpServer({ codeReviewOn: () => false } as unknown as InboxMcpContext);
  const tools = (server as unknown as { _registeredTools: Registered })._registeredTools;
  return ((await tools.get_guide_brief!.handler!({}, {})) as Brief).structuredContent?.methodology;
};

describe("get_guide_brief and the standing instructions", () => {
  test("without instructions the methodology is the organizer prompt, byte for byte", async () => {
    expect(await methodology()).toBe(GUIDE_REVIEW_PROMPT);
  });

  test("stored instructions are appended as the review UI's guide launches append them", async () => {
    const text = "Call the tenant a workspace, never an org. Never invent ticket IDs.";
    writeGuideInstructions(text);
    const got = await methodology();
    expect(got).toBe(composeGuideMethodology(text));
    expect(got!.startsWith(GUIDE_REVIEW_PROMPT)).toBe(true);
    expect(got).toContain("## Additional reviewer instructions");
    expect(got!.endsWith(text)).toBe(true);
  });

  test("the file is read at each call, so a change applies to the next brief", async () => {
    writeGuideInstructions("First.");
    expect(await methodology()).toEndWith("First.");
    writeGuideInstructions("Second.");
    expect(await methodology()).toEndWith("Second.");
    writeGuideInstructions("");
    expect(await methodology()).toBe(GUIDE_REVIEW_PROMPT);
  });
});
