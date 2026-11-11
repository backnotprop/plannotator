/**
 * A `.env` file is annotatable when the person names it, and the session
 * keeps nothing of it in the data dir: no version copy, no submit record, no
 * feedback archive entry (through 0.28.61 it was refused outright, because
 * annotate history copies the file there). It is still never found by name
 * search. One scratch data dir, set before the modules read it.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "plannotator-env-data-"));
const savedDataDir = process.env.PLANNOTATOR_DATA_DIR;
process.env.PLANNOTATOR_DATA_DIR = dataDir;
const { startAnnotateServer } = await import("./annotate");
const { resolveAnnotateTarget } = await import("../../apps/hook/server/annotate-resolution");

const SECRET = `sk_live_${Math.random().toString(36).slice(2)}`;
const dirs: string[] = [];

afterAll(() => {
  if (savedDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
  for (const dir of [dataDir, ...dirs]) rmSync(dir, { recursive: true, force: true });
});

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path));
    else out.push(path);
  }
  return out;
}

test("a named .env opens as a code document, a nested one is never found by name, and nothing of it lands in the data dir", async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-env-project-")));
  dirs.push(project);
  const envPath = join(project, ".env");
  writeFileSync(envPath, `API_KEY=${SECRET}\n`);

  const named = await resolveAnnotateTarget({ rawFilePath: ".env", projectRoot: project, noJina: true, renderMarkdown: false, log: () => {} });
  expect(named.ok).toBe(true);
  if (named.ok) expect(named.markdown).toContain(SECRET);
  // A bare name only resolves through the in-project search, which never lists a .env.
  const nested = join(project, "app");
  require("node:fs").mkdirSync(nested);
  writeFileSync(join(nested, ".env.local"), "X=1\n");
  expect((await resolveAnnotateTarget({ rawFilePath: ".env.local", projectRoot: project, noJina: true, renderMarkdown: false, log: () => {} })).ok).toBe(false);

  const server = await startAnnotateServer({ markdown: `API_KEY=${SECRET}\n`, filePath: envPath, htmlContent: "<html></html>", project: "env-test" });
  try {
    const plan = (await (await fetch(`${server.url}/api/plan`)).json()) as Record<string, unknown>;
    expect(plan.renderAs).toBe("code");
    expect("versionInfo" in plan && plan.versionInfo).toBeFalsy();
    const feedback = await fetch(`${server.url}/api/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feedback: `Rotate \`${SECRET}\`.`, annotations: [{ id: "a1", originalText: SECRET }] }),
    });
    expect(feedback.status).toBe(200);
  } finally {
    server.stop();
  }
  for (const file of filesUnder(dataDir)) expect([file, readFileSync(file, "utf-8").includes(SECRET)]).toEqual([file, false]);
});
