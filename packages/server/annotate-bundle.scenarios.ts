/**
 * Several files reviewed as one (`annotate-bundle`), driven over HTTP against
 * a real annotate server. Shared by the Bun suite (annotate-bundle.test.ts)
 * and the Pi mirror (apps/pi-extension/server/serverAnnotate-bundle.test.ts),
 * so both runtimes answer the same scenarios.
 *
 * Every test runs under a temp PLANNOTATOR_DATA_DIR; nothing touches the
 * real ~/.plannotator.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnnotateBundleFile } from "../shared/annotate-bundle.ts";

export interface BundleScenarioServer {
  url: string;
  stop: () => void;
}

export type StartBundleScenarioServer = (options: {
  markdown: string;
  filePath: string;
  mode?: "annotate" | "annotate-bundle";
  bundleFiles?: AnnotateBundleFile[];
  project?: string;
  hostControlToken?: string;
}) => Promise<BundleScenarioServer>;

const HOST_TOKEN = "annotate-bundle-scenarios-host-token-0123456789abcdef";

const ENV_KEYS = [
  "PLANNOTATOR_DATA_DIR",
  "PLANNOTATOR_PORT",
  "PLANNOTATOR_REMOTE",
  "PLANNOTATOR_AI",
  "PLANNOTATOR_ANNOTATE_HISTORY",
  "PLANNOTATOR_FEEDBACK_HISTORY",
] as const;

const comment = (id: string, documentPath?: string) => ({
  id,
  blockId: "",
  startOffset: 0,
  endOffset: 4,
  type: "COMMENT",
  text: id,
  originalText: "Body",
  createdA: 1,
  ...(documentPath ? { documentPath } : {}),
});

const idsOf = (body: { annotations?: { id: string }[] }) => (body.annotations ?? []).map((a) => a.id);

export function defineAnnotateBundleScenarios(runtime: string, start: StartBundleScenarioServer): void {
  describe(`${runtime} annotate bundles`, () => {
    const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
    let root = "";
    let spec = "";
    let mock = "";
    let flow = "";
    let sibling = "";
    const servers: BundleScenarioServer[] = [];

    beforeEach(() => {
      for (const key of ENV_KEYS) saved[key] = process.env[key];
      root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-annotate-bundle-")));
      process.env.PLANNOTATOR_DATA_DIR = join(root, "data");
      delete process.env.PLANNOTATOR_PORT;
      process.env.PLANNOTATOR_REMOTE = "0";
      process.env.PLANNOTATOR_AI = "disabled";
      process.env.PLANNOTATOR_ANNOTATE_HISTORY = "1";
      process.env.PLANNOTATOR_FEEDBACK_HISTORY = "1";
      mkdirSync(join(root, "work/docs"), { recursive: true });
      mkdirSync(join(root, "work/ui"), { recursive: true });
      spec = join(root, "work/docs/spec.md");
      mock = join(root, "work/ui/mock.html");
      flow = join(root, "work/docs/flow.mmd");
      sibling = join(root, "work/docs/unlisted.md");
      writeFileSync(spec, "# Spec\n\nBody of the spec.\n");
      writeFileSync(mock, "<!doctype html><h1>Mock</h1><p>Body</p>");
      writeFileSync(flow, "graph TD; A-->B");
      writeFileSync(sibling, "# Unlisted\n");
    });

    afterEach(() => {
      for (const server of servers.splice(0)) server.stop();
      for (const key of ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key]!;
      }
      rmSync(root, { recursive: true, force: true });
    });

    const files = (): AnnotateBundleFile[] => [
      { path: mock, renderAs: "html" },
      { path: spec, renderAs: "markdown" },
      { path: flow, renderAs: "mermaid" },
    ];

    async function openBundle(hostControlToken?: string): Promise<BundleScenarioServer> {
      const server = await start({
        markdown: "",
        filePath: join(root, "work"),
        mode: "annotate-bundle",
        bundleFiles: files(),
        project: "bundle-scenarios",
        ...(hostControlToken ? { hostControlToken } : {}),
      });
      servers.push(server);
      return server;
    }

    const post = (server: BundleScenarioServer, path: string, body: unknown) =>
      fetch(`${server.url}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    const doc = (server: BundleScenarioServer, path: string) =>
      fetch(`${server.url}/api/doc?path=${encodeURIComponent(path)}&doc=1`);

    test("/api/plan names the files in the given order, with their render modes", async () => {
      const server = await openBundle();
      const plan = await (await fetch(`${server.url}/api/plan`)).json();
      expect(plan.mode).toBe("annotate-bundle");
      expect(plan.bundle).toEqual(files());
      // Labels are relative to the deepest directory holding every file.
      expect(plan.projectRoot).toBe(join(root, "work"));
      // Each file's comments are also kept under its own path.
      expect(plan.documentDrafts).toBe(true);
    });

    test("each listed file is served the way it renders alone", async () => {
      const server = await openBundle();
      const html = await (await doc(server, mock)).json();
      expect(html.renderAs).toBe("html");
      expect(html.rawHtml).toContain("<h1>Mock</h1>");
      const markdown = await (await doc(server, spec)).json();
      expect(markdown.renderAs).toBe("markdown");
      expect(markdown.markdown).toContain("Body of the spec.");
      const diagram = await (await doc(server, flow)).json();
      expect(diagram.renderAs).toBe("mermaid");
    });

    test("linked documents follow the single-file rule: a bundle file's directory is served, outside it is refused", async () => {
      const outside = join(root, "elsewhere.md");
      writeFileSync(outside, "# Elsewhere\n");
      const server = await openBundle();
      // A document beside a bundle file opens as a linked document, exactly as
      // it would from that file opened alone.
      const linked = await fetch(`${server.url}/api/doc?path=unlisted.md&base=${encodeURIComponent(join(root, "work/docs"))}`);
      expect(linked.status).toBe(200);
      expect((await linked.json()).filepath).toBe(sibling);
      expect((await doc(server, outside)).status).toBe(403);
    });

    test("the host's status lists the bundle's files in order", async () => {
      const server = await openBundle(HOST_TOKEN);
      const status = await fetch(`${server.url}/api/host/status`, { headers: { Authorization: `Bearer ${HOST_TOKEN}` } });
      expect(status.status).toBe(200);
      expect((await status.json()).documents).toEqual([mock, spec, flow]);
    });

    // The failure: the CLI accepts a symlinked file, then /api/doc refuses
    // it (403) because its real location is outside every root.
    test("a bundle file that is a symlink to elsewhere is served", async () => {
      mkdirSync(join(root, "outside"), { recursive: true });
      writeFileSync(join(root, "outside/real.md"), "# Real\n\nLinked body.\n");
      const link = join(root, "work/docs/link.md");
      symlinkSync(join(root, "outside/real.md"), link);
      const server = await start({
        markdown: "",
        filePath: join(root, "work"),
        mode: "annotate-bundle",
        bundleFiles: [{ path: link, renderAs: "markdown" }, { path: spec, renderAs: "markdown" }],
      });
      servers.push(server);
      const served = await doc(server, link);
      expect(served.status).toBe(200);
      expect((await served.json()).markdown).toContain("Linked body.");
    });

    // Edit Mode: a bundle is several single-file sessions in one review, so
    // each listed file saves back to disk the way it would opened alone.
    const save = (server: BundleScenarioServer, path: string, text: string, baseHash: string) =>
      post(server, "/api/source/save", { path, text, baseHash, allowMissingBase: true });

    test("a bundle file saves", async () => {
      const server = await openBundle();
      const served = await (await doc(server, spec)).json();
      expect(served.sourceSave).toMatchObject({ enabled: true, scope: "folder-file", path: spec });
      const response = await save(server, spec, "# Spec\n\nEdited body.\n", served.sourceSave.hash);
      expect(response.status).toBe(200);
      expect((await response.json()).ok).toBe(true);
      expect(readFileSync(spec, "utf-8")).toBe("# Spec\n\nEdited body.\n");
      // A stale base is a conflict, never an overwrite.
      const stale = await save(server, spec, "lost", served.sourceSave.hash);
      expect(stale.status).toBe(409);
      expect(readFileSync(spec, "utf-8")).toBe("# Spec\n\nEdited body.\n");
      // Raw HTML stays read-only, as it is for a single file.
      expect((await (await doc(server, mock)).json()).sourceSave).toMatchObject({ enabled: false });
    });

    test("a path outside the bundle is refused (403)", async () => {
      const outside = join(root, "elsewhere.md");
      writeFileSync(outside, "# Elsewhere\n");
      const server = await openBundle();
      // A document linked from a bundle file is served, but read-only, exactly
      // as a document linked from a single file is.
      const linked = await (await doc(server, sibling)).json();
      expect(linked.sourceSave?.enabled ?? false).toBe(false);
      const hash = (await (await doc(server, spec)).json()).sourceSave.hash;
      for (const target of [sibling, outside, join(root, "work/docs/new.md"), "../elsewhere.md"]) {
        const response = await save(server, target, "# Overwritten\n", hash);
        expect(response.status).toBe(403);
      }
      // A save without a path names no file at all.
      const noPath = await post(server, "/api/source/save", { text: "x", baseHash: hash });
      expect(noPath.status).toBe(403);
      expect(readFileSync(sibling, "utf-8")).toBe("# Unlisted\n");
      expect(readFileSync(outside, "utf-8")).toBe("# Elsewhere\n");
      expect(readFileSync(spec, "utf-8")).toBe("# Spec\n\nBody of the spec.\n");
    });

    test("a symlink alias resolves to its file", async () => {
      mkdirSync(join(root, "outside"), { recursive: true });
      const real = join(root, "outside/real.md");
      const other = join(root, "outside/other.md");
      writeFileSync(real, "# Real\n\nLinked body.\n");
      writeFileSync(other, "# Other\n");
      const link = join(root, "work/docs/link.md");
      symlinkSync(real, link);
      const server = await start({
        markdown: "",
        filePath: join(root, "work"),
        mode: "annotate-bundle",
        bundleFiles: [{ path: link, renderAs: "markdown" }, { path: spec, renderAs: "markdown" }],
      });
      servers.push(server);
      const served = await (await doc(server, link)).json();
      // The capability names the file the link points to.
      expect(served.sourceSave).toMatchObject({ enabled: true, path: real });
      const viaLink = await save(server, link, "# Real\n\nEdited through the link.\n", served.sourceSave.hash);
      expect(viaLink.status).toBe(200);
      const after = await viaLink.json();
      expect(readFileSync(real, "utf-8")).toBe("# Real\n\nEdited through the link.\n");
      // The real path names the same file, so it saves too.
      const viaReal = await save(server, real, "# Real\n\nAgain.\n", after.hash);
      expect(viaReal.status).toBe(200);
      expect(readFileSync(real, "utf-8")).toBe("# Real\n\nAgain.\n");
      // The link's directory on the far side is not the bundle: its other files stay read-only.
      expect((await save(server, other, "# Overwritten\n", after.hash)).status).toBe(403);
      expect(readFileSync(other, "utf-8")).toBe("# Other\n");
    });

    test("each text file's version history is saved when the review opens", async () => {
      const server = await openBundle();
      const versions = async (path: string) =>
        (await (await fetch(`${server.url}/api/plan/versions?path=${encodeURIComponent(path)}`)).json()).versions as unknown[];
      // Never opened through /api/doc, yet saved.
      expect(await versions(spec)).toHaveLength(1);
      expect(await versions(flow)).toHaveLength(1);
      // Raw HTML keeps no history in a bundle, as in folder sessions.
      expect(await versions(mock)).toHaveLength(0);
    });

    test("one decision archives one record naming every file with its comment count", async () => {
      const server = await openBundle();
      const response = await post(server, "/api/feedback", {
        feedback: "Feedback on two files",
        annotations: [comment("a", spec), comment("b", spec), comment("c", mock), comment("bundle-note")],
      });
      expect(response.ok).toBe(true);
      const index = readFileSync(join(root, "data/feedback/bundle-scenarios/index.jsonl"), "utf-8").trim().split("\n");
      expect(index).toHaveLength(1);
      const record = JSON.parse(index[0]!);
      expect(record.surface).toBe("annotate-bundle");
      expect(record.target).toEqual({
        documents: [
          { path: mock, annotationCount: 1 },
          { path: spec, annotationCount: 2 },
          { path: flow, annotationCount: 0 },
        ],
      });
    });

    test("a file's comments follow it from the bundle into a session on the file alone", async () => {
      const bundle = await openBundle();
      const saved = await post(bundle, "/api/draft/document", {
        documents: [{ path: spec, annotations: [comment("from-bundle")] }],
      });
      expect(saved.ok).toBe(true);
      bundle.stop();
      servers.splice(servers.indexOf(bundle), 1);

      const alone = await start({ markdown: readFileSync(spec, "utf-8"), filePath: spec });
      servers.push(alone);
      expect(idsOf(await (await fetch(`${alone.url}/api/draft`)).json())).toEqual(["from-bundle"]);
    });

    test("a bundle of fewer than two files is refused at startup", async () => {
      await expect(
        start({ markdown: "", filePath: root, mode: "annotate-bundle", bundleFiles: [{ path: spec, renderAs: "markdown" }] }),
      ).rejects.toThrow("at least two files");
    });
  });
}
