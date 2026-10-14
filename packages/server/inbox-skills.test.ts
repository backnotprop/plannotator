/**
 * `GET /api/inbox/skills` and `GET /api/inbox/skills/content` on a running
 * Inbox (approval "inbox-skill-references"): the composers' skill picker and
 * the SKILL.md a Send pastes in. The failure this catches: the picker listing
 * the wrong folders (a project's, or nothing), a content name read as a path,
 * another site reading which skills this computer has, or a write accepted.
 *
 * Every skill folder is a temp HOME made here; HOME, CLAUDE_CONFIG_DIR,
 * CODEX_HOME and XDG_CONFIG_HOME point into it for each test and are put back
 * after, so the person's real skills are never read.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startInboxServer, type InboxServer } from "./inbox";

type Json = Record<string, any>;

const ENV_KEYS = ["HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME"] as const;
const roots: string[] = [];
const servers: InboxServer[] = [];
let savedEnv: Record<string, string | undefined> | null = null;

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (savedEnv) {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    savedEnv = null;
  }
});

function skill(dir: string, name: string, frontmatter: string, body: string): void {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\n${frontmatter}---\n\n${body}`);
}

async function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-skills-route-")));
  roots.push(root);
  const home = join(root, "home");
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.HOME = home;
  process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
  process.env.CODEX_HOME = join(home, ".codex");
  process.env.XDG_CONFIG_HOME = join(home, ".config");
  const claude = join(home, ".claude", "skills");
  skill(claude, "write-better", "description: Improve prose.\n", "# Write better\n\nTighten it.\n");
  skill(claude, "readback", "description: State the request back.\ndisable-model-invocation: true\n", "# Readback\n\nState what I am asking for.\n");
  skill(join(home, ".agents", "skills"), "humanizer", "description: Remove AI tells.\n", "# Humanizer\n");
  // A project's own skills folder is never listed.
  skill(join(root, "project", ".claude", "skills"), "project-only", "description: Not global.\n", "# Project\n");
  const server = await startInboxServer({ dataDir: join(root, "data"), binaryPath: null, phones: false });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  const get = async (path: string, headers: Record<string, string> = {}) => {
    const response = await fetch(`${base}${path}`, { headers });
    return { status: response.status, headers: response.headers, body: (await response.json()) as Json };
  };
  return { root, home, base, get };
}

describe("GET /api/inbox/skills", () => {
  test("lists the global skills only, with plan review's shape", async () => {
    const w = await setup();
    const answer = await w.get("/api/inbox/skills");
    expect(answer.status).toBe(200);
    expect(answer.headers.get("cache-control")).toBe("no-store");
    expect(answer.body.skills).toEqual([
      { name: "humanizer", root: "universal", description: "Remove AI tells.", humanOnly: false, dir: join(w.home, ".agents", "skills", "humanizer") },
      { name: "readback", root: "claude", description: "State the request back.", humanOnly: true, dir: join(w.home, ".claude", "skills", "readback") },
      { name: "write-better", root: "claude", description: "Improve prose.", humanOnly: false, dir: join(w.home, ".claude", "skills", "write-better") },
    ]);
  });

  test("a human-only skill's SKILL.md by name; a name is never a path", async () => {
    const w = await setup();
    const answer = await w.get("/api/inbox/skills/content?name=readback");
    expect(answer.status).toBe(200);
    expect(answer.body.skill).toMatchObject({
      name: "readback",
      dir: join(w.home, ".claude", "skills", "readback"),
      path: join(w.home, ".claude", "skills", "readback", "SKILL.md"),
      truncated: false,
      humanOnly: true,
    });
    expect(answer.body.skill.content).toContain("State what I am asking for.");
    for (const name of ["nope", "../readback", join(w.home, ".claude", "skills", "readback"), "project-only", ""]) {
      expect([name, (await w.get(`/api/inbox/skills/content?name=${encodeURIComponent(name)}`)).status]).toEqual([name, 404]);
    }
  });

  test("another site is refused; the window's own page and a plain client are answered; only GET", async () => {
    const w = await setup();
    for (const path of ["/api/inbox/skills", "/api/inbox/skills/content?name=readback"]) {
      for (const headers of [{ "Sec-Fetch-Site": "cross-site" }, { "Sec-Fetch-Site": "same-site" }, { Origin: "http://evil.example" }]) {
        const refused = await w.get(path, headers);
        expect([path, refused.status, refused.body.code]).toEqual([path, 403, "cross_origin"]);
      }
      expect((await w.get(path, { "Sec-Fetch-Site": "same-origin", Origin: w.base })).status).toBe(200);
      expect((await w.get(path)).status).toBe(200);
      const post = await fetch(`${w.base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      expect(post.status).toBe(405);
    }
  });

  test("no skills installed: an empty list, never an error", async () => {
    const w = await setup();
    rmSync(join(w.home), { recursive: true, force: true });
    const answer = await w.get("/api/inbox/skills");
    expect(answer).toMatchObject({ status: 200, body: { skills: [] } });
  });
});
