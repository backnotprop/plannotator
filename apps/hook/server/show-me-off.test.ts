/**
 * Show me and Shape are gone (the owner, 2026-11-23): no agent text names them, with Code review on or off. With
 * Code review off, no chapter diagram word is in what an agent can read either: the Inbox's MCP tool list, the guide
 * brief, `plannotator inbox --help`, the top-level help (Board off and on), `plannotator review --help`;
 * `plannotator review draw …` and `review drawings …` are the review parse's (`review <DIRECTORY>`), and a
 * version-3 guide snapshot is refused with the release's own "Unsupported snapshot version" words.
 *
 * What regresses: a Show me or Shape word (the html drawing kind's rules, `plannotator shape`, the refusal of
 * `review draw`, "Mermaid preferred") reaching any agent; `plannotator shape` answering as a command; a chapter
 * diagram's word reaching an agent whose person has Code review off.
 *
 * Chapter diagrams (Settings → Capabilities, under Code review, config.json `inboxChapterDiagrams`): with Code review
 * on and it off, no chapter diagram word reaches an agent either.
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
import { formatUnknownSubcommandError } from "./unknown-subcommand";
import { INBOX_REVIEW_SKILLS, inboxReviewSkills } from "@plannotator/core/inbox-review";
import { FIXTURE_V2_HTML } from "@plannotator/core/guide-format-fixtures";
import { checkInboxGuide } from "../../../packages/server/inbox-guides";

const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-show-me-off-")));
const home = join(root, "home");
mkdirSync(home, { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));

/**
 * The words Show me and Shape gave agents before they were removed. A word holds no double quote or line break: the
 * MCP texts are JSON, where those are escaped.
 */
const SHAPE_WORDS = ["plannotator shape", "drawing by the rules in", "review_draw_gone", "Show me makes a Shape", "Mermaid preferred", "pressed Show me"];

/** A chapter's Mermaid diagram: Code review's own words (approval "guide-chapter-diagrams"), absent only with Code review off. */
const CHAPTER_WORDS = {
  /** INBOX_REVIEW_CHAPTER_DIAGRAM_DOC */
  get_guide_brief: ["sections[].diagram", "one diagram at the top of a chapter"],
  /** INBOX_REVIEW_CURATE_DRAWING_LINE and INBOX_REVIEW_RECHECK_DRAWING_LINE */
  "the review skills": ["sections[].diagram", "draw it again in the chapter"],
  /** INBOX_GUIDE_FIELD_DESCRIPTION_WITH_NOTES: submit_guide's `guide` field */
  "mcp tools/list": ["diagram?"],
};

/**
 * Each text an agent reads, with Code review on or off. `config`: more of config.json (an older Inbox's `inboxShape`).
 * `diagrams`: Chapter diagrams, written to config.json as the Settings switch writes it (absent: never set, on).
 */
async function agentTexts(codeReview: boolean, diagrams?: boolean, config: Record<string, unknown> = {}): Promise<Record<string, string>> {
  const name = `data-texts-${codeReview ? "on" : "off"}${diagrams === undefined ? "" : diagrams ? "-diagrams" : "-no-diagrams"}${Object.keys(config).join("-")}`;
  const dataDir = join(root, name);
  mkdirSync(dataDir, { recursive: true });
  const written = { ...config, ...(diagrams === undefined ? {} : { inboxChapterDiagrams: diagrams }) };
  if (Object.keys(written).length) writeFileSync(join(dataDir, "config.json"), JSON.stringify(written));
  const saved = process.env.PLANNOTATOR_DATA_DIR;
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  const server = await startInboxServer({ dataDir, codeReview, phones: false });
  const client = new Client({ name: "show-me-off-test", version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
    const { tools } = await client.listTools();
    const brief = await client.callTool({ name: "get_guide_brief", arguments: {} });
    // A failed call would hold no word at all: the test must read the real texts.
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

const leaksOf = (texts: Record<string, string>, words: readonly string[]) =>
  Object.entries(texts).flatMap(([name, text]) => words.filter((word) => text.includes(word)).map((word) => `${name}: ${word}`));

test("Code review off: no agent text holds a Shape word or a chapter diagram's", async () => {
  const words = [...new Set([...SHAPE_WORDS, ...Object.values(CHAPTER_WORDS).flat()])];
  expect(leaksOf(await agentTexts(false), words)).toEqual([]);
});

test("Code review on: no agent text holds a Shape word, and Code review's own words are there", async () => {
  const texts: Record<string, string> = {
    ...(await agentTexts(true)),
    "the review skills": INBOX_REVIEW_SKILLS.map((skill) => skill.body).join("\n"),
  };
  expect(leaksOf(texts, SHAPE_WORDS)).toEqual([]);
  // Code review's own words are still there: the notes rule, and a chapter's Mermaid diagram.
  expect(texts.get_guide_brief).toContain("diffs[].notes");
  const missing = Object.entries(CHAPTER_WORDS).flatMap(([name, words]) => words.filter((word) => !texts[name]!.includes(word)).map((word) => `${name}: ${word}`));
  expect(missing).toEqual([]);
});

test("a config.json an older Inbox wrote with Shape on changes no agent text", async () => {
  for (const codeReview of [false, true]) {
    expect(await agentTexts(codeReview, undefined, { inboxShape: true })).toEqual(await agentTexts(codeReview));
  }
});

test("Code review on and Chapter diagrams off: no agent text holds a chapter diagram's word", async () => {
  // Every word of CHAPTER_WORDS, and in the brief and the skills any diagram or Mermaid word at all.
  const words = [...new Set(Object.values(CHAPTER_WORDS).flat())];
  const texts: Record<string, string> = {
    ...(await agentTexts(true, false)),
    "the review skills": inboxReviewSkills({ diagrams: false }).map((skill) => skill.body).join("\n"),
  };
  const leaks = leaksOf(texts, words);
  for (const name of ["get_guide_brief", "the review skills"]) {
    for (const word of ["diagram", "mermaid"]) if (texts[name]!.toLowerCase().includes(word)) leaks.push(`${name}: ${word}`);
  }
  expect(leaks).toEqual([]);
  // The rest of Code review's words stay: the notes rule.
  expect(texts.get_guide_brief).toContain("diffs[].notes");
  // Turned on again (config.json `true`), every chapter word is back.
  const on = await agentTexts(true, true);
  const back: Record<string, string> = { ...on, "the review skills": inboxReviewSkills({ diagrams: true }).map((skill) => skill.body).join("\n") };
  const missing = Object.entries(CHAPTER_WORDS).flatMap(([name, list]) => list.filter((word) => !back[name]!.includes(word)).map((word) => `${name}: ${word}`));
  expect(missing).toEqual([]);
});

test("Code review on and Chapter diagrams on, or never set: the agent texts are the same byte for byte", async () => {
  expect(await agentTexts(true, true)).toEqual(await agentTexts(true));
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
    HOME: process.env.HOME!,
    PLANNOTATOR_RELAY_URL: "http://127.0.0.1:9",
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
    const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "index.ts"), ...argv], { cwd: root, env: { ...env, PLANNOTATOR_RELAY_URL: "http://127.0.0.1:9", PLANNOTATOR_DATA_DIR: data }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, code };
  };
  const cli = (...argv: string[]) => runWith(dataDir, argv);
  try {
    // What 0.28.49 printed: --version reads no config; --help reads it once (the Board's help line), and
    // `review --help` once (its Tailscale default): no second warning.
    const warnings = (stderr: string) => stderr.split("\n").filter((line) => line.includes("failed to read config.json")).length;
    const version = await cli("--version");
    expect([version.code, warnings(version.stderr)]).toEqual([0, 0]);
    const help = await cli("--help");
    expect([help.code, help.stdout, warnings(help.stderr)]).toEqual([0, `${formatTopLevelHelp()}\n`, 1]);
    const reviewHelp = await cli("review", "--help");
    expect([reviewHelp.code, reviewHelp.stdout, warnings(reviewHelp.stderr)]).toEqual([0, `${formatSubcommandHelp("review")}\n`, 1]);

    // Every shaped `review draw|drawings` form: a broken config is Code review off, so each prints what it prints
    // with Code review off, plus the warnings the review parse always gave (0.28.49's): as many as the same words
    // with the command's word misspelt (`drawx`).
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

test("`plannotator shape` is an unknown command, and `review draw` is the review parse's, whatever config.json says", async () => {
  const { removeStubbedHtml, stubHookDistHtml } = await import("../../../tests/helpers/hook-dist-stub");
  const { NO_BROWSER } = await import("../../../tests/helpers/no-browser");
  const stubbed = stubHookDistHtml();
  const run = async (config: Record<string, boolean>, argv: string[]) => {
    const dataDir = join(root, `data-cli-${Object.keys(config).filter((key) => config[key]).join("-") || "none"}`);
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "config.json"), JSON.stringify(config));
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME!,
      PLANNOTATOR_RELAY_URL: "http://127.0.0.1:9",
      PLANNOTATOR_DATA_DIR: dataDir,
      PLANNOTATOR_BROWSER: NO_BROWSER,
      NO_BROWSER: "1",
      NO_ANON_PING: "1",
      PLANNOTATOR_UPDATE_CHECK: "0",
      PLANNOTATOR_INBOX_CONNECT: "0",
      PLANNOTATOR_TEST_SANDBOX: "1",
    };
    const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "index.ts"), ...argv], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, code };
  };
  const draw = ["review", "draw", "--file", "d.json", "--review", "msg_01J8ZK3TQ4VW7Y9A2B5C6D8E0F", "--turn", "turn-0001"];
  const unknown = { stdout: "", stderr: `${formatUnknownSubcommandError("shape")}\n`, code: 1 };
  try {
    for (const config of [{ inboxCodeReview: true, inboxShape: true }, { inboxCodeReview: false }] as Record<string, boolean>[]) {
      for (const argv of [["shape"], ["shape", "--help"], ["shape", "on"], ["shape", "list", "--thread", "msg_01J8ZK3TQ4VW7Y9A2B5C6D8E0F"]]) {
        expect([argv, await run(config, argv)]).toEqual([argv, unknown]);
      }
    }
    for (const argv of [draw, ["review", "drawings", "msg_01J8ZK3TQ4VW7Y9A2B5C6D8E0F"], ["review", "draw", "--help"]]) {
      const on = await run({ inboxCodeReview: true, inboxShape: true }, argv);
      const off = await run({ inboxCodeReview: false }, argv);
      expect([argv, on]).toEqual([argv, off]);
      expect(on.stderr).not.toContain("review_draw_gone");
    }
  } finally {
    removeStubbedHtml(stubbed);
  }
}, 120_000);

test("Code review off: a version-3 snapshot is an unsupported version", () => {
  // 0.28.49's parser knew versions 1 and 2: any other was "Unsupported snapshot version: <n>", at $.version.
  const snapshot = { kind: "plannotator-guided-review", version: 3, exportedAt: "2026-01-01T00:00:00Z", guide: {}, review: {}, source: {} };
  expect(checkInboxGuide({ snapshot }, root, { codeReview: false })).toEqual({ ok: false, error: "Invalid guide snapshot ($.version): Unsupported snapshot version: 3" });
  expect(checkInboxGuide({ snapshot: JSON.stringify(snapshot) }, root, { codeReview: false })).toEqual({ ok: false, error: "Invalid guide snapshot ($.version): Unsupported snapshot version: 3" });
});

test("a version-2 snapshot taken while Code review is off is taken while on, html overview diagram and all", () => {
  // The repo's own v2 html fixture (a `code:` link) and a guide-builder picture with <style>: the guide format's.
  const styled = { ...FIXTURE_V2_HTML, guide: { ...FIXTURE_V2_HTML.guide, overview: { text: "x", diagram: { kind: "html" as const, source: '<style>.a{color:red}</style><a class="a" href="chapter:1">One</a>' } } } };
  for (const snapshot of [FIXTURE_V2_HTML, styled]) {
    const off = checkInboxGuide({ snapshot }, root, { codeReview: false });
    const on = checkInboxGuide({ snapshot }, root, { codeReview: true });
    expect(off.ok).toBe(true);
    expect(on).toEqual(off);
  }
});
