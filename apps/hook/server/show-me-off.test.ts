/**
 * Show me (approval "shape-in-code-review") gates every word it adds to an
 * agent on the Code review switch. With Code review off, what an agent can
 * read is byte-equal to the release before Show me (0.28.49): the Inbox's
 * MCP tool list, the guide brief, `plannotator inbox --help`, the top-level
 * help (Board off and on) and `plannotator review --help`; `plannotator review
 * draw …` and `review drawings …` are the review parse's (`review <DIRECTORY>`),
 * the drawings routes are the unknown route, and a version-3 guide snapshot is
 * refused with the release's own "Unsupported snapshot version" words.
 *
 * What regresses: a Show me word (the `overview.diagram` rules, `review draw`,
 * the skills' drawing lines) reaching an agent whose person has Code review
 * off. The pins are sha256 of each text as 0.28.49 printed it; a change that
 * means to alter these texts for everyone updates them on purpose.
 * `SHOW_ME_OFF_PRINT=1` prints the current hashes.
 */
import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { startInboxServer } from "@plannotator/server/inbox";
import { createAgentEnvironmentFor } from "@plannotator/server/inbox-agents";
import { formatInboxHelp } from "./inbox-help";
import { formatSubcommandHelp, formatTopLevelHelp } from "./cli";
import { isReviewDrawCommand } from "./review-draw-command";
import { FIXTURE_V2_HTML } from "@plannotator/core/guide-format-fixtures";
import { checkInboxGuide } from "../../../packages/server/inbox-guides";

const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-show-me-off-")));
const home = join(root, "home");
mkdirSync(home, { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** sha256 of each text an agent reads, as 0.28.49 (main at 730fa68d2, before Show me) printed it. */
const PINNED: Record<string, string> = {
  "mcp tools/list": "ee76aa0665dd05fbfc32c08d84c10cd1bd20ac3e7b2b4358cd41fbbebd7f9ddd",
  get_guide_brief: "906b6918c50a7639c3c5ca8094f499c14dd26f3556b9e74213a683236e937314",
  "inbox --help": "bd041c8a25674db7de36f7b4d8f9beafb2880d819148a6029a1c7f01ee7572e1",
  "--help": "bffe3a2f6adab3d1ab955d88dca3c3242e506c2974ebe926b1c5ffa1800bf3bf",
  "--help (board)": "110b8dba443cdea2e192cdb845df97acf6b8b5ec57ed27f308143af2f9945deb",
  "review --help": "91cfedf817e69cdc1506dd8e49ca4e71918f37132286a2e6767faf1c909edd42",
};

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

test("Code review off: every agent text is byte-equal to the release before Show me", async () => {
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  const saved = process.env.PLANNOTATOR_DATA_DIR;
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  const server = await startInboxServer({ dataDir, codeReview: false, phones: false });
  const client = new Client({ name: "show-me-off-test", version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
    const { tools } = await client.listTools();
    const brief = await client.callTool({ name: "get_guide_brief", arguments: {} });
    const texts: Record<string, string> = {
      "mcp tools/list": JSON.stringify(tools),
      get_guide_brief: JSON.stringify(brief),
      "inbox --help": formatInboxHelp({
        command: ["/opt/example/plannotator"],
        dataDir: "/home/someone/.plannotator",
        platform: "linux",
        agentEnvironment: createAgentEnvironmentFor({ platform: "linux", homeDir: home, env: { HOME: home, PATH: "" } }),
        board: true,
        steps: true,
        codeReview: false,
      }),
      "--help": formatTopLevelHelp(),
      "--help (board)": formatTopLevelHelp({ board: true }),
      "review --help": formatSubcommandHelp("review"),
    };
    const hashes = Object.fromEntries(Object.entries(texts).map(([name, text]) => [name, sha(text)]));
    if (process.env.SHOW_ME_OFF_PRINT === "1") console.log(JSON.stringify(hashes, null, 2));
    expect(hashes).toEqual(PINNED);
  } finally {
    await client.close().catch(() => {});
    server.stop();
    process.env.PLANNOTATOR_DATA_DIR = saved;
  }
});

test("Code review off: `review draw` and `review drawings` are the review parse's, every form", () => {
  const review = "msg_01J8ZK3TQ4VW7Y9A2B5C6D8E0F";
  for (const argv of [
    ["review", "draw", "--help"],
    ["review", "draw", "--file", "d.json", "--review", review, "--turn", "turn-0001"],
    ["review", "drawings", review],
    ["review", "drawings", "--help"],
    ["review", "drawings"],
  ]) {
    expect(isReviewDrawCommand(argv, false)).toBe(false);
  }
});

test("Code review off: the drawings routes are the unknown route, and a version-3 snapshot is an unsupported version", async () => {
  const dataDir = join(root, "data-routes");
  mkdirSync(dataDir, { recursive: true });
  const server = await startInboxServer({ dataDir, codeReview: false, phones: false });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const path = "/api/inbox/reviews/msg_01J8ZK3TQ4VW7Y9A2B5C6D8E0F/drawings";
    for (const headers of [{ "sec-fetch-site": "same-origin" }, { authorization: "Bearer x" }]) {
      const unknown = await fetch(`${base}/api/inbox/reviewz/msg_01J8ZK3TQ4VW7Y9A2B5C6D8E0F/drawings`, { headers });
      const read = await fetch(`${base}${path}`, { headers });
      expect([read.status, await read.text()]).toEqual([unknown.status, await unknown.text()]);
      expect(read.status).toBe(404);
    }
  } finally {
    server.stop();
  }
  // 0.28.49's parser knew versions 1 and 2: any other was "Unsupported snapshot version: <n>", at $.version.
  const snapshot = { kind: "plannotator-guided-review", version: 3, exportedAt: "2026-01-01T00:00:00Z", guide: {}, review: {}, source: {} };
  expect(checkInboxGuide({ snapshot }, root, { codeReview: false })).toEqual({ ok: false, error: "Invalid guide snapshot ($.version): Unsupported snapshot version: 3" });
  expect(checkInboxGuide({ snapshot: JSON.stringify(snapshot) }, root, { codeReview: false })).toEqual({ ok: false, error: "Invalid guide snapshot ($.version): Unsupported snapshot version: 3" });
});

test("an html overview diagram in a version-2 snapshot: Shape's check while Code review is on, untouched while off", () => {
  const outside = '<div data-mark="a" data-code="src/not-in-the-patch.ts#L1">a</div>';
  const snapshot = { ...FIXTURE_V2_HTML, guide: { ...FIXTURE_V2_HTML.guide, overview: { text: "x", diagram: { kind: "html" as const, source: outside } } } };
  expect(checkInboxGuide({ snapshot }, root, { codeReview: false }).ok).toBe(true);
  const on = checkInboxGuide({ snapshot }, root, { codeReview: true });
  expect(on.ok).toBe(false);
  if (!on.ok) expect(on.error).toContain('data-code="src/not-in-the-patch.ts#L1": src/not-in-the-patch.ts is not a file in this review');
});
