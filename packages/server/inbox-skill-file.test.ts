/**
 * `GET /api/inbox/skills/file?name=…` (inbox-skill-file.ts): one skill's SKILL.md for the person to read beside the
 * thread, called through `inboxSkillsRoute` with no Inbox started. The failure this catches: a name read as a path
 * (a traversal or an absolute path reaching a file outside the catalog), a skill the reply box does not list being
 * read, a built-in shadowing the person's own skill of the same name, an unbounded read, or another site reading it.
 *
 * Every skill folder is in a temp HOME made here; HOME, CLAUDE_CONFIG_DIR, CODEX_HOME and XDG_CONFIG_HOME point into
 * it for each test and are put back after, so the person's real skills are never read.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PICTURE_IT_SKILL } from "@plannotator/core/picture-it-skill";
import { CREATE_ROUTINE_SKILL } from "@plannotator/core/create-routine-skill";
import { INBOX_REVIEW_SKILLS } from "@plannotator/core/inbox-review";
import { inboxSkillsRoute } from "./inbox-skills";
import { INBOX_SKILL_FILE_MAX_BYTES } from "./inbox-skill-file";

type Json = Record<string, any>;

const ENV_KEYS = ["HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME"] as const;
let savedEnv: Record<string, string | undefined> | null = null;

afterEach(() => {
  if (!savedEnv) return;
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  savedEnv = null;
});

function write(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

const README = "---\nname: readback\ndescription: State the request back.\ndisable-model-invocation: true\n---\n\n# Readback\n\nState what I am asking for.\n";

function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-skill-file-")));
  const home = join(root, "home");
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.HOME = home;
  process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
  process.env.CODEX_HOME = join(home, ".codex");
  process.env.XDG_CONFIG_HOME = join(home, ".config");
  const claude = join(home, ".claude", "skills");
  write(join(claude, "readback", "SKILL.md"), README);
  write(join(claude, "readback", "references", "examples.md"), "# Examples\n");
  write(join(claude, "readback", "scripts", "check.sh"), "echo ok\n");
  write(join(home, ".agents", "skills", "humanizer", "SKILL.md"), "# Humanizer\n");
  // Not in any skill folder: a SKILL.md beside the home, and a project's own skill.
  write(join(root, "outside-skill", "SKILL.md"), "# Outside\n\nNever read.\n");
  write(join(root, "project", ".claude", "skills", "project-only", "SKILL.md"), "# Project\n");
  const read = async (name: string, headers: Record<string, string> = { "Sec-Fetch-Site": "same-origin" }, method = "GET", switches: { codeReview?: boolean; routines?: boolean } = {}) => {
    const req = new Request(`http://127.0.0.1/api/inbox/skills/file?name=${encodeURIComponent(name)}`, { method, headers });
    const response = inboxSkillsRoute(req, new URL(req.url), switches)!;
    return { status: response.status, cache: response.headers.get("cache-control"), body: (await response.json()) as Json };
  };
  return { root, home, claude, read };
}

test("a person's own skill answers its SKILL.md as it is on disk and its source, and names none of its other files", async () => {
  const w = world();
  const answer = await w.read("readback");
  expect(answer.status).toBe(200);
  expect(answer.cache).toBe("no-store");
  expect(answer.body).toEqual({ found: true, name: "readback", source: "own", root: "claude", text: README });
  expect((await w.read("humanizer")).body).toEqual({ found: true, name: "humanizer", source: "own", root: "universal", text: "# Humanizer\n" });
});

test("a built-in skill answers Plannotator's own text; the person's skill of the same name wins", async () => {
  const w = world();
  expect((await w.read("picture-it")).body).toEqual({ found: true, name: "picture-it", source: "plannotator", root: "plannotator", text: PICTURE_IT_SKILL.body });
  write(join(w.claude, "picture-it", "SKILL.md"), "# My picture-it\n");
  expect((await w.read("picture-it")).body).toMatchObject({ found: true, source: "own", root: "claude", text: "# My picture-it\n" });
});

test("a name is only ever matched against the catalog: traversals, paths and unlisted skills are not found", async () => {
  const w = world();
  for (const name of [
    "",
    ".",
    "..",
    "../outside-skill",
    "../../outside-skill",
    "readback/../../../outside-skill",
    "readback/SKILL.md",
    "readback/references/examples.md",
    join(w.root, "outside-skill"),
    join(w.root, "outside-skill", "SKILL.md"),
    join(w.claude, "readback"),
    "outside-skill",
    "project-only",
    "no-such-skill",
  ]) {
    const answer = await w.read(name);
    expect([name, answer.status, answer.body]).toEqual([name, 200, { found: false }]);
  }
});

test("a SKILL.md past the cap answers too_large with no text", async () => {
  const w = world();
  write(join(w.claude, "huge", "SKILL.md"), `# Huge\n\n${"x".repeat(INBOX_SKILL_FILE_MAX_BYTES)}`);
  const answer = await w.read("huge");
  expect(answer.body).toEqual({ found: true, name: "huge", source: "own", root: "claude", too_large: true });
});

test("every built-in is found by its name whatever the Code review and Routines switches say; the person's own still wins", async () => {
  const w = world();
  const review = INBOX_REVIEW_SKILLS[0]!;
  for (const switches of [{}, { codeReview: false, routines: false }, { codeReview: true, routines: true }]) {
    expect((await w.read(review.name, undefined, undefined, switches)).body).toMatchObject({ found: true, source: "plannotator", root: "plannotator" });
    expect((await w.read(CREATE_ROUTINE_SKILL.name, undefined, undefined, switches)).body).toMatchObject({ found: true, source: "plannotator", root: "plannotator" });
  }
  write(join(w.claude, review.name, "SKILL.md"), "# Mine\n");
  expect((await w.read(review.name, undefined, undefined, { codeReview: false })).body).toEqual({ found: true, name: review.name, source: "own", root: "claude", text: "# Mine\n" });
});

test("another site is refused, and only GET reads", async () => {
  const w = world();
  expect((await w.read("readback", { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
  expect((await w.read("readback", { Origin: "https://example.test", Host: "127.0.0.1" })).status).toBe(403);
  expect((await w.read("readback", { "Sec-Fetch-Site": "same-origin" }, "POST")).status).toBe(405);
});
