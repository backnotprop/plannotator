import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { startInboxServer } from "@plannotator/server/inbox";
import { createAgentEnvironmentFor } from "@plannotator/server/inbox-agents";
import { formatInboxHelp } from "./inbox-help";
import { formatSubcommandHelp, formatTopLevelHelp, SHAPE_COMMAND_USAGE } from "./cli";
import { SHAPE_SKILL } from "@plannotator/core/shape-skill";
import { isReviewDrawCommand } from "./review-draw-command";
import { INBOX_REVIEW_DRAW_GONE, INBOX_REVIEW_SKILLS, inboxReviewSkills } from "@plannotator/core/inbox-review";
import { FIXTURE_V2_HTML } from "@plannotator/core/guide-format-fixtures";
import { checkInboxGuide } from "../../../packages/server/inbox-guides";

const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-show-me-off-")));
const home = join(root, "home");
mkdirSync(home, { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));

const SHOW_ME_WORDS = {
  get_guide_brief: ["plannotator shape --help", "drawing by the rules in"],
  "review draw": ["review_draw_gone", "Show me makes a Shape"],
  "the review skills": ["Mermaid preferred"],
};

const CHAPTER_WORDS = {
  get_guide_brief: ["sections[].diagram", "one diagram at the top of a chapter"],
  "the review skills": ["sections[].diagram", "draw it again in the chapter"],
  "mcp tools/list": ["diagram?"],
};

async function agentTexts(codeReview: boolean, shape = false, diagrams?: boolean): Promise<Record<string, string>> {
  const dataDir = join(root, `data-texts-${codeReview ? "on" : "off"}${shape ? "-shape" : ""}${diagrams === undefined ? "" : diagrams ? "-diagrams" : "-no-diagrams"}`);
  mkdirSync(dataDir, { recursive: true });
  if (diagrams !== undefined) writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxChapterDiagrams: diagrams }));
  const saved = process.env.PLANNOTATOR_DATA_DIR;
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  const server = await startInboxServer({ dataDir, codeReview, shape, phones: false });
  const client = new Client({ name: "show-me-off-test", version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
    const { tools } = await client.listTools();
    const brief = await client.callTool({ name: "get_guide_brief", arguments: {} });
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

const SHAPE_TEXT_SHA256 = { "shape --help": "ce2ee98da4eebc163bb184abb8dc6c32f43e2d0ea5407a0a2030395faa0df196", "/shape skill": "2d311dca120c01f3e9c6dbe6d360bdde401f3b8c857b6ef3f2455748a72e39f9" };

test("Code review off: Shape's own agent text is byte for byte what it was", () => {
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  expect({ "shape --help": sha(SHAPE_COMMAND_USAGE), "/shape skill": sha(JSON.stringify(SHAPE_SKILL)) }).toEqual(SHAPE_TEXT_SHA256);
});

test("Code review off: no agent text holds a Show me word or a chapter diagram's", async () => {
  const words = [...new Set([...Object.values(SHOW_ME_WORDS).flat(), ...Object.values(CHAPTER_WORDS).flat()])];
  const texts = await agentTexts(false);
  const leaks = Object.entries(texts).flatMap(([name, text]) => words.filter((word) => text.includes(word)).map((word) => `${name}: ${word}`));
  expect(leaks).toEqual([]);
});

test("Code review on and Shape off: no agent text holds a Show me word (no overview.diagram, no Shape drawing rules)", async () => {
  const words = [...new Set(Object.values(SHOW_ME_WORDS).flat())];
  const texts = {
    ...(await agentTexts(true, false)),
    "the review skills": INBOX_REVIEW_SKILLS.map((skill) => skill.body).join("\n"),
  };
  const leaks = Object.entries(texts).flatMap(([name, text]) => words.filter((word) => text.includes(word)).map((word) => `${name}: ${word}`));
  expect(leaks).toEqual([]);
  expect(texts.get_guide_brief).toContain("diffs[].notes");
  const missing = Object.entries(CHAPTER_WORDS).flatMap(([name, words]) => words.filter((word) => !texts[name]!.includes(word)).map((word) => `${name}: ${word}`));
  expect(missing).toEqual([]);
});

test("Code review on and Chapter diagrams off: no agent text holds a chapter diagram's word, Shape off or on", async () => {
  const words = [...new Set(Object.values(CHAPTER_WORDS).flat())];
  for (const shape of [false, true]) {
    const texts = {
      ...(await agentTexts(true, shape, false)),
      "the review skills": inboxReviewSkills({ shape, diagrams: false }).map((skill) => skill.body).join("\n"),
    };
    const leaks = Object.entries(texts).flatMap(([name, text]) => words.filter((word) => text.includes(word)).map((word) => `${shape}: ${name}: ${word}`));
    for (const name of ["get_guide_brief", "the review skills"]) {
      for (const word of ["diagram", "mermaid", "plannotator shape --help"]) if (texts[name]!.toLowerCase().includes(word)) leaks.push(`${shape}: ${name}: ${word}`);
    }
    expect(leaks).toEqual([]);
    expect(texts.get_guide_brief).toContain("diffs[].notes");
  }
  const on = await agentTexts(true, false, true);
  const back = { ...on, "the review skills": inboxReviewSkills({ diagrams: true }).map((skill) => skill.body).join("\n") };
  const missing = Object.entries(CHAPTER_WORDS).flatMap(([name, list]) => list.filter((word) => !back[name]!.includes(word)).map((word) => `${name}: ${word}`));
  expect(missing).toEqual([]);
});

test("Code review on and Chapter diagrams on, or never set: the agent texts are the same byte for byte", async () => {
  for (const shape of [false, true]) {
    const unset = await agentTexts(true, shape);
    const on = await agentTexts(true, shape, true);
    expect(on).toEqual(unset);
  }
});

test("Code review and Shape on: the text that carries each Show me word holds it, so a word misspelt in the list fails", async () => {
  const carriers: Record<keyof typeof SHOW_ME_WORDS, string> = {
    get_guide_brief: (await agentTexts(true, true)).get_guide_brief!,
    "review draw": INBOX_REVIEW_DRAW_GONE,
    "the review skills": inboxReviewSkills({ shape: true }).map((skill) => skill.body).join("\n"),
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
    HOME: process.env.HOME!,
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_BROWSER: "1",
    NO_ANON_PING: "1",
    PLANNOTATOR_UPDATE_CHECK: "0",
    PLANNOTATOR_INBOX_CONNECT: "0",
    PLANNOTATOR_TEST_SANDBOX: "1",
  };
  const runWith = async (data: string, argv: string[]) => {
    const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "index.ts"), ...argv], { cwd: root, env: { ...env, PLANNOTATOR_DATA_DIR: data }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, code };
  };
  const cli = (...argv: string[]) => runWith(dataDir, argv);
  try {
    const warnings = (stderr: string) => stderr.split("\n").filter((line) => line.includes("failed to read config.json")).length;
    const version = await cli("--version");
    expect([version.code, warnings(version.stderr)]).toEqual([0, 0]);
    const help = await cli("--help");
    expect([help.code, help.stdout, warnings(help.stderr)]).toEqual([0, `${formatTopLevelHelp()}\n`, 1]);
    const reviewHelp = await cli("review", "--help");
    expect([reviewHelp.code, reviewHelp.stdout, warnings(reviewHelp.stderr)]).toEqual([0, `${formatSubcommandHelp("review")}\n`, 1]);

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

test("Code review on: `shape` answers only with Shape on, and an old `review draw` is refused only then (Shape off: the review parse's, as with Code review off)", async () => {
  const { removeStubbedHtml, stubHookDistHtml } = await import("../../../tests/helpers/hook-dist-stub");
  const { NO_BROWSER } = await import("../../../tests/helpers/no-browser");
  const { SHAPE_OFF_TEXT } = await import("./shape-command");
  const stubbed = stubHookDistHtml();
  const run = async (config: Record<string, boolean>, argv: string[]) => {
    const dataDir = join(root, `data-cli-${Object.keys(config).filter((key) => config[key]).join("-")}`);
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "config.json"), JSON.stringify(config));
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME!,
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
  try {
    const codeReviewOnly = { inboxCodeReview: true, inboxShape: false };
    expect(await run(codeReviewOnly, ["shape", "--help"])).toEqual({ stdout: "", stderr: `${SHAPE_OFF_TEXT}\n`, code: 1 });
    for (const argv of [draw, ["review", "drawings", "msg_01J8ZK3TQ4VW7Y9A2B5C6D8E0F"], ["review", "draw", "--help"]]) {
      const shapeOff = await run(codeReviewOnly, argv);
      const codeReviewOff = await run({ inboxCodeReview: false, inboxShape: false }, argv);
      expect([argv, shapeOff]).toEqual([argv, codeReviewOff]);
      expect(shapeOff.stderr).not.toContain("review_draw_gone");
    }
    const both = { inboxCodeReview: true, inboxShape: true };
    expect((await run(both, ["shape", "--help"])).code).toBe(0);
    expect(await run(both, draw)).toEqual({ stdout: "", stderr: `${INBOX_REVIEW_DRAW_GONE}\n`, code: 1 });
  } finally {
    removeStubbedHtml(stubbed);
  }
}, 120_000);

test("Code review off: a version-3 snapshot is an unsupported version", () => {
  const snapshot = { kind: "plannotator-guided-review", version: 3, exportedAt: "2026-01-01T00:00:00Z", guide: {}, review: {}, source: {} };
  expect(checkInboxGuide({ snapshot }, root, { codeReview: false })).toEqual({ ok: false, error: "Invalid guide snapshot ($.version): Unsupported snapshot version: 3" });
  expect(checkInboxGuide({ snapshot: JSON.stringify(snapshot) }, root, { codeReview: false })).toEqual({ ok: false, error: "Invalid guide snapshot ($.version): Unsupported snapshot version: 3" });
});

test("a version-2 snapshot taken while Code review is off is taken while on, html overview diagram and all", () => {
  const styled = { ...FIXTURE_V2_HTML, guide: { ...FIXTURE_V2_HTML.guide, overview: { text: "x", diagram: { kind: "html" as const, source: '<style>.a{color:red}</style><a class="a" href="chapter:1">One</a>' } } } };
  for (const snapshot of [FIXTURE_V2_HTML, styled]) {
    const off = checkInboxGuide({ snapshot }, root, { codeReview: false });
    const on = checkInboxGuide({ snapshot }, root, { codeReview: true });
    expect(off.ok).toBe(true);
    expect(on).toEqual(off);
  }
});
