/**
 * Shape is gone (it was never on by default). What a person with an older config.json gets, with no Inbox started:
 *  - Code review's switch (`inboxCodeReview`) saves and reads as before, beside an old `inboxShape`;
 *  - `inboxShape` true or false changes nothing an agent or a window reads: the "/" list and get_guide_brief are
 *    the same as with no `inboxShape` at all, and the brief is the one Shape-off gave (a chapter's diagram in Mermaid).
 * What regresses: an old `inboxShape: true` bringing back `/shape`, an html diagram in the brief, or a broken config.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "@plannotator/shared/config";
import { createInboxMcpServer, type InboxMcpContext } from "./inbox-mcp";
import { inboxSkillsRoute } from "./inbox-skills";

const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-after-shape-")));
const savedDataDir = process.env.PLANNOTATOR_DATA_DIR;
afterEach(() => {
  if (savedDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

let worlds = 0;
/** A sandbox data dir holding `config` as config.json (none when null), set as this process's. */
function dataDirWith(config: Record<string, unknown> | null): string {
  const dataDir = join(root, `data-${worlds++}`);
  mkdirSync(dataDir, { recursive: true });
  if (config) writeFileSync(join(dataDir, "config.json"), JSON.stringify(config));
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  return dataDir;
}

const skillNames = async (codeReview: boolean) => {
  const req = new Request("http://127.0.0.1/api/inbox/skills", { headers: { "Sec-Fetch-Site": "same-origin" } });
  const response = inboxSkillsRoute(req, new URL(req.url), { codeReview })!;
  return ((await response.json()) as { skills: { name: string }[] }).skills.map((skill) => skill.name).filter((name) => ["picture-it", "review-curate", "review-walkthrough", "review-recheck", "create-routine", "shape"].includes(name));
};

type Registered = Record<string, { handler?: (input: unknown, ctx: unknown) => Promise<unknown> }>;
const brief = async (codeReview: boolean) => {
  const server = createInboxMcpServer({ codeReviewOn: () => codeReview } as unknown as InboxMcpContext);
  const tools = (server as unknown as { _registeredTools: Registered })._registeredTools;
  return ((await tools.get_guide_brief!.handler!({}, {})) as { structuredContent: { output_schema: Record<string, any>; rules: string[] } }).structuredContent;
};

describe("Code review's switch beside an old inboxShape", () => {
  test("saves and reads as before, and the config still loads", () => {
    for (const shape of [true, false]) {
      const dataDir = dataDirWith({ inboxShape: shape, inboxCodeReview: true });
      expect(loadConfig().inboxCodeReview).toBe(true);
      expect(saveConfig({ inboxCodeReview: false })).toBe(true);
      expect(loadConfig().inboxCodeReview).toBe(false);
      expect(JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")).inboxCodeReview).toBe(false);
    }
  });
});

describe("an old inboxShape changes nothing an agent or a window reads", () => {
  test("the / list and get_guide_brief are the same with inboxShape true, false or absent", async () => {
    for (const codeReview of [true, false]) {
      dataDirWith(null);
      const names = await skillNames(codeReview);
      const plain = await brief(codeReview);
      for (const shape of [true, false]) {
        dataDirWith({ inboxShape: shape, inboxCodeReview: codeReview });
        expect(await skillNames(codeReview)).toEqual(names);
        expect(await brief(codeReview)).toEqual(plain);
      }
      expect(names).toEqual(codeReview ? ["picture-it", "review-curate", "review-walkthrough", "review-recheck"] : ["picture-it"]);
    }
  });

  test("the brief is Shape-off's: a chapter's diagram is Mermaid only and no rule names Shape or html", async () => {
    dataDirWith({ inboxShape: true, inboxCodeReview: true });
    const { output_schema: schema, rules } = await brief(true);
    expect(schema.properties.sections.items.properties.diagram.properties).toEqual({ kind: { enum: ["mermaid"] }, source: { type: "string" } });
    expect(schema.properties.overview.properties).toEqual({ text: { type: "string" } });
    const all = JSON.stringify({ schema, rules });
    for (const word of ["html", "plannotator shape", "Shape", "\"css\"", "\"tall\""]) expect([word, all.includes(word)]).toEqual([word, false]);
  });
});
