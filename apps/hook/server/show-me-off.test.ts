/**
 * Show me (approval "shape-in-code-review") gates every word it adds to an
 * agent on the Code review switch. With Code review off, no Show me word is in
 * what an agent can read: the Inbox's MCP tool list, the guide brief,
 * `plannotator inbox --help`, the top-level help (Board off and on) and
 * `plannotator review --help`; `plannotator review draw …` and `review drawings …`
 * are the review parse's (`review <DIRECTORY>`), the drawings routes are the
 * unknown route, and a version-3 guide snapshot is refused with the release's
 * own "Unsupported snapshot version" words.
 *
 * What regresses: a Show me word (the `overview.diagram` rules, `review draw`,
 * the skills' drawing lines) reaching an agent whose person has Code review
 * off. These texts change for everyone on purpose, so the test names the words
 * and not the texts; a control proves each word is real, with Code review on.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { startInboxServer } from "@plannotator/server/inbox";
import { createAgentEnvironmentFor } from "@plannotator/server/inbox-agents";
import { formatInboxHelp } from "./inbox-help";
import { formatSubcommandHelp, formatTopLevelHelp } from "./cli";
import { isReviewDrawCommand, runReviewDrawCommand } from "./review-draw-command";
import { INBOX_REVIEW_SKILLS } from "@plannotator/core/inbox-review";
import { FIXTURE_V2_HTML } from "@plannotator/core/guide-format-fixtures";
import { checkInboxGuide } from "../../../packages/server/inbox-guides";

const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-show-me-off-")));
const home = join(root, "home");
mkdirSync(home, { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));

/**
 * The words Show me added, by the text that carries them with Code review on, copied from
 * `packages/core/inbox-review.ts`. A word holds no double quote or line break: the MCP texts are JSON, where those are escaped.
 */
const SHOW_ME_WORDS = {
  /** INBOX_REVIEW_OVERVIEW_DIAGRAM_DOC */
  get_guide_brief: ["overview.diagram", "one drawing of how the whole change works", "review draw"],
  /** INBOX_REVIEW_DRAW_HELP */
  "review draw --help": ["review draw", "review drawings", "Show me", "data-code", "data-mark", "data-step"],
  /** INBOX_REVIEW_CURATE_DRAWING_LINE and INBOX_REVIEW_RECHECK_DRAWING_LINE */
  "the review skills": ["overview.diagram", "give the overview one drawing", "redrawn, as this review's", "review drawings"],
};

/** Each text an agent reads, with Code review on or off. */
async function agentTexts(codeReview: boolean): Promise<Record<string, string>> {
  const dataDir = join(root, codeReview ? "data-texts-on" : "data-texts-off");
  mkdirSync(dataDir, { recursive: true });
  const saved = process.env.PLANNOTATOR_DATA_DIR;
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  const server = await startInboxServer({ dataDir, codeReview, phones: false });
  const client = new Client({ name: "show-me-off-test", version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
    const { tools } = await client.listTools();
    const brief = await client.callTool({ name: "get_guide_brief", arguments: {} });
    // A failed call would hold no word at all: the off test must read the real texts.
    expect(tools.map((tool) => tool.name)).toContain("get_guide_brief");
    expect(brief.isError).toBeFalsy();
    return {
      "mcp tools/list": JSON.stringify(tools),
      get_guide_brief: JSON.stringify(brief),
      "inbox --help": formatInboxHelp({
        command: ["/opt/example/plannotator"],
        dataDir: "/home/someone/.plannotator",
        platform: "linux",
        agentEnvironment: createAgentEnvironmentFor({ platform: "linux", homeDir: home, env: { HOME: home, PATH: "" } }),
        board: true,
        steps: true,
        codeReview,
      }),
      "--help": formatTopLevelHelp(),
      "--help (board)": formatTopLevelHelp({ board: true }),
      "review --help": formatSubcommandHelp("review"),
    };
  } finally {
    await client.close().catch(() => {});
    server.stop();
    if (saved === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
    else process.env.PLANNOTATOR_DATA_DIR = saved;
  }
}

test("Code review off: no agent text holds a Show me word", async () => {
  const words = [...new Set(Object.values(SHOW_ME_WORDS).flat())];
  const texts = await agentTexts(false);
  const leaks = Object.entries(texts).flatMap(([name, text]) => words.filter((word) => text.includes(word)).map((word) => `${name}: ${word}`));
  expect(leaks).toEqual([]);
});

test("Code review on: the text that carries each Show me word holds it, so a word misspelt in the list fails", async () => {
  const printed: string[] = [];
  const code = await runReviewDrawCommand(["draw", "--help"], {
    cwd: root,
    ensureRunning: () => Promise.reject(new Error("help reads no Inbox")),
    stdout: (text) => printed.push(text),
  });
  expect(code).toBe(0);
  const carriers: Record<keyof typeof SHOW_ME_WORDS, string> = {
    get_guide_brief: (await agentTexts(true)).get_guide_brief!,
    "review draw --help": printed.join("\n"),
    "the review skills": INBOX_REVIEW_SKILLS.map((skill) => skill.body).join("\n"),
  };
  const missing = Object.entries(SHOW_ME_WORDS).flatMap(([name, words]) =>
    words.filter((word) => !carriers[name as keyof typeof SHOW_ME_WORDS].includes(word)).map((word) => `${name}: ${word}`),
  );
  expect(missing).toEqual([]);
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
    expect(isReviewDrawCommand(argv, () => false)).toBe(false);
  }
  // The switch (config.json) is read only for `review draw|drawings`: every other command reads nothing new.
  let reads = 0;
  for (const argv of [["--version"], ["--help"], ["review", "--help"], ["review"], ["annotate", "x.md"], ["sessions"]]) {
    isReviewDrawCommand(argv, () => (reads++, true));
  }
  expect(reads).toBe(0);
});

test("Code review off with a broken config.json: --version, --help, review --help and every review draw|drawings form print what 0.28.49 printed", async () => {
  const { removeStubbedHtml, stubHookDistHtml } = await import("../../../tests/helpers/hook-dist-stub");
  const { NO_BROWSER } = await import("../../../tests/helpers/no-browser");
  const dataDir = join(root, "data-broken");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "config.json"), "{ not json");
  const stubbed = stubHookDistHtml();
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_BROWSER: "1",
    NO_ANON_PING: "1",
    PLANNOTATOR_UPDATE_CHECK: "0",
    PLANNOTATOR_INBOX_CONNECT: "0",
    PLANNOTATOR_TEST_SANDBOX: "1",
  };
  // In a folder that is no repository: the review parse answers at once, nothing is reviewed.
  const runWith = async (data: string, argv: string[]) => {
    const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "index.ts"), ...argv], { cwd: root, env: { ...env, PLANNOTATOR_DATA_DIR: data }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, code };
  };
  const cli = (...argv: string[]) => runWith(dataDir, argv);
  try {
    // What 0.28.49 printed: --version reads no config; --help reads it once (the Board's help line), and
    // `review --help` once (its Tailscale default). Show me adds no read, so no second warning.
    const warnings = (stderr: string) => stderr.split("\n").filter((line) => line.includes("failed to read config.json")).length;
    const version = await cli("--version");
    expect([version.code, warnings(version.stderr)]).toEqual([0, 0]);
    const help = await cli("--help");
    expect([help.code, help.stdout, warnings(help.stderr)]).toEqual([0, `${formatTopLevelHelp()}\n`, 1]);
    const reviewHelp = await cli("review", "--help");
    expect([reviewHelp.code, reviewHelp.stdout, warnings(reviewHelp.stderr)]).toEqual([0, `${formatSubcommandHelp("review")}\n`, 1]);

    // Every shaped `review draw|drawings` form: a broken config is Code review off, so each prints what it prints
    // with Code review off, plus the warnings the review parse always gave (0.28.49's): as many as the same words
    // with the command's word misspelt (`drawx`), which never reach Show me's code.
    const offDir = join(root, "data-off");
    mkdirSync(offDir, { recursive: true });
    writeFileSync(join(offDir, "config.json"), JSON.stringify({ inboxCodeReview: false }));
    const review = "msg_01J8ZK3TQ4VW7Y9A2B5C6D8E0F";
    for (const argv of [
      ["review", "draw", "--help"],
      ["review", "draw", "-h"],
      ["review", "drawings", "--help"],
      ["review", "drawings", "-h"],
      ["review", "drawings", review],
      ["review", "draw", "--file", "d.json", "--review", review, "--turn", "turn-0001"],
      ["review", "draw", "--turn=t"],
    ]) {
      const broken = await cli(...argv);
      const offRun = await runWith(offDir, argv);
      expect([argv, broken.code, broken.stdout]).toEqual([argv, offRun.code, offRun.stdout]);
      const twin = await cli(...argv.map((word, i) => (i === 1 ? `${word}x` : word)));
      expect([argv, warnings(broken.stderr)]).toEqual([argv, warnings(twin.stderr)]);
      expect(warnings(broken.stderr)).toBeGreaterThan(0);
      const rest = broken.stderr.split("\n").filter((line) => !line.includes("failed to read config.json")).join("\n");
      expect([argv, rest]).toEqual([argv, offRun.stderr]);
    }
  } finally {
    removeStubbedHtml(stubbed);
  }
}, 120_000);

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

test("a version-2 snapshot taken while Code review is off is taken while on, html overview diagram and all", () => {
  // The repo's own v2 html fixture (a `code:` link) and a guide-builder picture with <style>: the guide format's, not Shape's.
  const styled = { ...FIXTURE_V2_HTML, guide: { ...FIXTURE_V2_HTML.guide, overview: { text: "x", diagram: { kind: "html" as const, source: '<style>.a{color:red}</style><a class="a" href="chapter:1">One</a>' } } } };
  for (const snapshot of [FIXTURE_V2_HTML, styled]) {
    const off = checkInboxGuide({ snapshot }, root, { codeReview: false });
    const on = checkInboxGuide({ snapshot }, root, { codeReview: true });
    expect(off.ok).toBe(true);
    expect(on).toEqual(off);
  }
});
