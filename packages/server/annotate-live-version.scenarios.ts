import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashSourceBytes } from "@plannotator/shared/source-save-node";

export interface LiveVersionScenarioServer {
  url: string;
  stop: () => void;
}

export type StartLiveVersionScenarioServer = (options: {
  markdown: string;
  filePath: string;
  project: string;
  mode?: "annotate" | "annotate-folder";
  folderPath?: string;
  renderHtml?: boolean;
  rawHtml?: string;
}) => Promise<LiveVersionScenarioServer>;

const ENV_KEYS = [
  "PLANNOTATOR_DATA_DIR",
  "PLANNOTATOR_PORT",
  "PLANNOTATOR_REMOTE",
  "PLANNOTATOR_AI",
  "PLANNOTATOR_ANNOTATE_HISTORY",
] as const;

const PROJECT = "live-version-test";
const hashOf = (text: string) => hashSourceBytes(new TextEncoder().encode(text));

interface PlanPayload {
  plan: string;
  liveVersions?: boolean;
  serverSession: string;
  previousPlan?: string | null;
  versionInfo?: { version: number; totalVersions: number; project: string };
}

export function defineAnnotateLiveVersionScenarios(runtime: string, start: StartLiveVersionScenarioServer): void {
  describe(`${runtime} annotate: a disk change becomes a version (#2037)`, () => {
    const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
    let root = "";
    let docDir = "";
    let dataDir = "";
    const servers: LiveVersionScenarioServer[] = [];

    beforeEach(() => {
      for (const key of ENV_KEYS) saved[key] = process.env[key];
      root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-live-version-")));
      dataDir = join(root, "data");
      process.env.PLANNOTATOR_DATA_DIR = dataDir;
      delete process.env.PLANNOTATOR_PORT;
      process.env.PLANNOTATOR_REMOTE = "0";
      process.env.PLANNOTATOR_AI = "disabled";
      delete process.env.PLANNOTATOR_ANNOTATE_HISTORY;
      docDir = join(root, "docs");
      mkdirSync(docDir, { recursive: true });
    });

    afterEach(() => {
      for (const server of servers.splice(0)) server.stop();
      for (const key of ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key]!;
      }
      rmSync(root, { recursive: true, force: true });
    });

    async function openFile(name: string, text: string): Promise<{ server: LiveVersionScenarioServer; path: string }> {
      const path = join(docDir, name);
      writeFileSync(path, text);
      const server = await start({ markdown: text, filePath: path, project: PROJECT });
      servers.push(server);
      return { server, path };
    }

    const plan = async (server: LiveVersionScenarioServer) =>
      (await (await fetch(`${server.url}/api/plan`)).json()) as PlanPayload;

    const saveVersion = (server: LiveVersionScenarioServer, body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${server.url}/api/plan/versions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      });

    const versionFiles = () => {
      const projectDir = join(dataDir, "history", PROJECT);
      if (!existsSync(projectDir)) return [];
      return readdirSync(projectDir).flatMap((slug) =>
        readdirSync(join(projectDir, slug)).filter((name) => /^\d+\.md$/.test(name)),
      );
    };

    test("an edit on disk is saved as the next version, diffed against the one before", async () => {
      const { server, path } = await openFile("notes.md", "# Notes\n\nv1\n");
      const opened = await plan(server);
      expect(opened.versionInfo?.version).toBe(1);
      expect(opened.liveVersions).toBe(true);

      writeFileSync(path, "# Notes\n\nv2\n");
      expect((await plan(server)).versionInfo?.version).toBe(1);
      expect(versionFiles()).toHaveLength(1);

      const res = await saveVersion(server, { serverSession: opened.serverSession, hash: hashOf("# Notes\n\nv2\n") });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        ok: true,
        saved: true,
        previousPlan: "# Notes\n\nv1\n",
        versionInfo: { version: 2, totalVersions: 2, project: PROJECT },
      });
      expect(versionFiles()).toHaveLength(2);

      const reloaded = await plan(server);
      expect(reloaded.plan).toBe("# Notes\n\nv2\n");
      expect(reloaded.previousPlan).toBe("# Notes\n\nv1\n");
      expect(reloaded.versionInfo?.version).toBe(2);
      const listed = await (await fetch(`${server.url}/api/plan/versions`)).json();
      expect(listed.versions).toHaveLength(2);

      writeFileSync(path, "# Notes\n\nv3\n");
      const third = await (await saveVersion(server, { hash: hashOf("# Notes\n\nv3\n") })).json();
      expect(third).toMatchObject({ saved: true, previousPlan: "# Notes\n\nv2\n", versionInfo: { version: 3 } });
    });

    test("the same text twice saves one version", async () => {
      const { server, path } = await openFile("notes.md", "a\n");
      writeFileSync(path, "b\n");
      const first = await (await saveVersion(server, { hash: hashOf("b\n") })).json();
      expect(first).toMatchObject({ saved: true, versionInfo: { version: 2 } });
      const again = await (await saveVersion(server, { hash: hashOf("b\n") })).json();
      expect(again).toMatchObject({ ok: true, saved: false, previousPlan: "a\n", versionInfo: { version: 2 } });
      expect(versionFiles()).toHaveLength(2);
    });

    test("a file that moved on since the editor read it saves nothing", async () => {
      const { server, path } = await openFile("notes.md", "a\n");
      writeFileSync(path, "c\n");
      const res = await saveVersion(server, { hash: hashOf("b\n") });
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe("stale");
      expect(versionFiles()).toHaveLength(1);
    });

    test("PLANNOTATOR_ANNOTATE_HISTORY=0 writes nothing", async () => {
      process.env.PLANNOTATOR_ANNOTATE_HISTORY = "0";
      const { server, path } = await openFile("notes.md", "a\n");
      expect((await plan(server)).liveVersions).toBeUndefined();
      writeFileSync(path, "b\n");
      const res = await saveVersion(server, { hash: hashOf("b\n") });
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe("history_off");
      expect(existsSync(join(dataDir, "history"))).toBe(false);
    });

    test("a deleted or empty file saves nothing", async () => {
      const { server, path } = await openFile("notes.md", "a\n");
      writeFileSync(path, "");
      const empty = await saveVersion(server, { hash: hashOf("") });
      expect(empty.status).toBe(409);
      expect((await empty.json()).code).toBe("empty");
      rmSync(path);
      const missing = await saveVersion(server, { hash: hashOf("a\n") });
      expect(missing.status).toBe(409);
      expect((await missing.json()).code).toBe("missing");
      expect(versionFiles()).toHaveLength(1);
    });

    test("a file that was empty at open gets its first version from the first text", async () => {
      const { server, path } = await openFile("notes.md", "");
      const opened = await plan(server);
      expect(opened.versionInfo).toBeUndefined();
      expect(opened.liveVersions).toBe(true);
      writeFileSync(path, "first\n");
      const body = await (await saveVersion(server, { hash: hashOf("first\n") })).json();
      expect(body).toMatchObject({ saved: true, previousPlan: null, versionInfo: { version: 1, totalVersions: 1 } });
      expect((await plan(server)).versionInfo?.version).toBe(1);
    });

    test("a file past the 2 MB annotate cap is refused with 413", async () => {
      const { server, path } = await openFile("notes.md", "a\n");
      const big = "x".repeat(2 * 1024 * 1024 + 1);
      writeFileSync(path, big);
      const res = await saveVersion(server, { hash: hashOf(big) });
      expect(res.status).toBe(413);
      expect((await res.json()).code).toBe("too_large");
      expect(versionFiles()).toHaveLength(1);
    });

    test("data files and diagram sources do not take live versions", async () => {
      for (const [name, text] of [["config.yaml", "a: 1\n"], ["data.json", "{}\n"], ["flow.mmd", "graph TD\n  A-->B\n"]] as const) {
        const { server } = await openFile(name, text);
        expect((await plan(server)).liveVersions).toBeUndefined();
        const res = await saveVersion(server, { hash: hashOf(text) });
        expect(res.status).toBe(404);
        expect((await res.json()).code).toBe("not_eligible");
      }
    });

    test("a tab from another session, a bad body and another site are refused", async () => {
      const { server, path } = await openFile("notes.md", "a\n");
      writeFileSync(path, "b\n");
      const mismatch = await saveVersion(server, { serverSession: "not-this-session", hash: hashOf("b\n") });
      expect(mismatch.status).toBe(409);
      expect((await mismatch.json()).code).toBe("session_mismatch");

      const noHash = await saveVersion(server, {});
      expect(noHash.status).toBe(400);
      expect((await noHash.json()).code).toBe("validation_error");

      const notJson = await fetch(`${server.url}/api/plan/versions`, { method: "POST", body: "{nope" });
      expect(notJson.status).toBe(400);

      const crossSite = await saveVersion(server, { hash: hashOf("b\n") }, { Origin: "https://evil.example" });
      expect(crossSite.status).toBe(403);
      expect(versionFiles()).toHaveLength(1);
    });

    test("raw HTML and folder sessions do not take live versions", async () => {
      const htmlPath = join(docDir, "page.html");
      writeFileSync(htmlPath, "<p>a</p>");
      const html = await start({ markdown: "", filePath: htmlPath, project: PROJECT, renderHtml: true, rawHtml: "<p>a</p>" });
      servers.push(html);
      const htmlRes = await saveVersion(html, { hash: hashOf("<p>a</p>") });
      expect(htmlRes.status).toBe(404);
      expect((await htmlRes.json()).code).toBe("not_eligible");

      const folder = await start({ markdown: "", filePath: docDir, project: PROJECT, mode: "annotate-folder", folderPath: docDir });
      servers.push(folder);
      const folderRes = await saveVersion(folder, { hash: hashOf("x") });
      expect(folderRes.status).toBe(404);
      expect((await folderRes.json()).code).toBe("not_eligible");
    });
  });
}
