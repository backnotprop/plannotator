/** End-to-end /api/skills wiring on the Bun and Pi plan and annotate servers: a handler missing from a route table falls through to the SPA HTML catch-all. */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Distinct module key so unrelated mock.module() tests cannot replace the real server.
import { startAnnotateServer as startBunAnnotateServer } from "./annotate.ts?skills-endpoint";
import { startPlannotatorServer as startBunPlanServer } from "./index";
import {
  startAnnotateServer as startPiAnnotateServer,
  startPlanReviewServer as startPiPlanServer,
} from "../../apps/pi-extension/server";
import { checkoutIsScratch, makeOutsideScratch } from "../../tests/helpers/outside-scratch";

const SPA_HTML = "<!doctype html><html><body>SPA fallback</body></html>";

interface RunningServer {
  readonly url: string;
  stop(): void;
}

let base = "";
let home = "";
let archivePath = "";
const ENV_KEYS = [
  "HOME",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "XDG_CONFIG_HOME",
  "PLANNOTATOR_DATA_DIR",
  "PLANNOTATOR_PORT",
  "PLANNOTATOR_REMOTE",
  "PLANNOTATOR_TEST_SANDBOX",
] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "plannotator-skills-endpoint-"));
  home = join(base, "home");
  archivePath = join(base, "plans");
  mkdirSync(home, { recursive: true });
  mkdirSync(archivePath, { recursive: true });

  const root = join(home, ".claude", "skills");
  for (const [name, fm] of [
    ["endpoint-skill", "description: A test skill."],
    ["endpoint-human-only", "disable-model-invocation: true"],
  ] as const) {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\n${fm}\n---\n# ${name}\n`);
  }
  writeFileSync(join(home, "outside.md"), "must never be served");
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.HOME = home;
  process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
  process.env.CODEX_HOME = join(home, ".codex");
  process.env.XDG_CONFIG_HOME = join(home, ".config");
  process.env.PLANNOTATOR_DATA_DIR = join(base, "data");
  delete process.env.PLANNOTATOR_PORT;
  process.env.PLANNOTATOR_REMOTE = "0";
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const serverCases = [
  {
    name: "Bun plan",
    start: () =>
      startBunPlanServer({
        plan: "# Test Plan",
        origin: "claude-code",
        htmlContent: SPA_HTML,
        mode: "archive",
        customPlanPath: archivePath,
      }) as Promise<RunningServer>,
  },
  {
    name: "Bun annotate",
    start: () =>
      startBunAnnotateServer({
        markdown: "# Test Document",
        filePath: join(tmpdir(), "test.md"),
        origin: "claude-code",
        htmlContent: SPA_HTML,
      }) as Promise<RunningServer>,
  },
  {
    name: "Pi plan",
    start: () =>
      startPiPlanServer({
        plan: "# Test Plan",
        origin: "pi",
        htmlContent: SPA_HTML,
        mode: "archive",
        customPlanPath: archivePath,
      }) as unknown as Promise<RunningServer>,
  },
  {
    name: "Pi annotate",
    start: () =>
      startPiAnnotateServer({
        markdown: "# Test Document",
        filePath: join(tmpdir(), "test.md"),
        origin: "pi",
        htmlContent: SPA_HTML,
      }) as unknown as Promise<RunningServer>,
  },
] as const;

describe("GET /api/skills route wiring", () => {
  for (const serverCase of serverCases) {
    test(`${serverCase.name}: served as JSON with the discovered catalog, not the SPA catch-all`, async () => {
      const server = await serverCase.start();
      try {
        const response = await fetch(`${server.url}/api/skills`);
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("application/json");

        const body = (await response.json()) as {
          skills: Array<{ name: string; root: string; humanOnly: boolean }>;
        };
        expect(Array.isArray(body.skills)).toBe(true);
        const byName = new Map(body.skills.map((s) => [s.name, s]));
        expect(byName.get("endpoint-skill")).toMatchObject({
          root: "claude",
          humanOnly: false,
          description: "A test skill.",
          dir: join(home, ".claude", "skills", "endpoint-skill"),
        });
        expect(byName.get("endpoint-human-only")).toMatchObject({
          root: "claude",
          humanOnly: true,
          dir: join(home, ".claude", "skills", "endpoint-human-only"),
        });
      } finally {
        server.stop();
      }
    });
  }
});

// Pi runs its own vendored copy of the loader.
describe.skipIf(checkoutIsScratch)("GET /api/skills under the test sandbox", () => {
  for (const serverCase of serverCases) {
    test(`${serverCase.name}: a home that is not scratch is read only outside the sandbox`, async () => {
      const outside = makeOutsideScratch();
      const server = await serverCase.start();
      try {
        const dir = join(outside, ".claude", "skills", "outside-skill");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "SKILL.md"), "---\nname: outside-skill\n---\n# outside-skill\n");
        process.env.HOME = outside;
        process.env.CLAUDE_CONFIG_DIR = join(outside, ".claude");
        const names = async () =>
          ((await (await fetch(`${server.url}/api/skills`)).json()) as { skills: Array<{ name: string }> }).skills.map((s) => s.name);

        process.env.PLANNOTATOR_TEST_SANDBOX = "1";
        expect(await names()).not.toContain("outside-skill");
        delete process.env.PLANNOTATOR_TEST_SANDBOX;
        expect(await names()).toContain("outside-skill");
      } finally {
        server.stop();
        rmSync(outside, { recursive: true, force: true });
      }
    });
  }
});

describe("GET /api/skills/content route wiring", () => {
  for (const serverCase of serverCases) {
    test(`${serverCase.name}: serves the frontmatter-stripped body, 404s the unknown, rejects traversal`, async () => {
      const server = await serverCase.start();
      try {
        const dir = join(home, ".claude", "skills", "endpoint-human-only");
        const ok = await fetch(
          `${server.url}/api/skills/content?name=endpoint-human-only`,
        );
        expect(ok.status).toBe(200);
        expect(ok.headers.get("content-type")).toContain("application/json");
        const body = (await ok.json()) as { skill: Record<string, unknown> };
        expect(body.skill).toMatchObject({
          name: "endpoint-human-only",
          dir,
          path: join(dir, "SKILL.md"),
          content: "# endpoint-human-only",
          truncated: false,
          humanOnly: true,
        });

        const missing = await fetch(`${server.url}/api/skills/content?name=nope`);
        expect(missing.status).toBe(404);

        for (const name of ["../../outside.md", "..%2F..%2Foutside.md", "/etc/hosts"]) {
          const res = await fetch(
            `${server.url}/api/skills/content?name=${encodeURIComponent(name)}`,
          );
          expect(res.status).toBe(404);
          expect(await res.text()).not.toContain("must never be served");
        }
      } finally {
        server.stop();
      }
    });
  }
});
