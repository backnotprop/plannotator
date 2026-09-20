/**
 * Annotate server — diagram sources (.mmd/.mermaid/.dot/.gv).
 *
 * Guards the contract the editor's single-diagram document runs on: /api/plan
 * must name the engine in `renderAs` and serve the file's RAW text as the
 * document body (the editor feeds that text straight to DiagramBlock), and
 * /api/doc must do the same for folder navigation. Also pins the two things
 * that must NOT change: an unsupported extension is still refused, and the 2MB
 * annotatable cap still applies to a diagram source.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "os";
import { join } from "path";
import { startAnnotateServer } from "./annotate";
import { resolveAnnotateTarget } from "../../apps/hook/server/annotate-resolution";
import { MAX_ANNOTATABLE_FILE_BYTES } from "@plannotator/shared/resolve-file";

const MINIMAL_HTML = "<html><body>Plannotator</body></html>";
const MERMAID = "flowchart TD\n  A[Start] --> B{Choice}\n  B --> C[Done]\n";
const DOT = 'digraph G {\n  a -> b;\n  b -> c;\n}\n';

let dir: string;
let savedPort: string | undefined;
let savedRemote: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pn-diagram-"));
  savedPort = process.env.PLANNOTATOR_PORT;
  savedRemote = process.env.PLANNOTATOR_REMOTE;
  delete process.env.PLANNOTATOR_PORT;
  process.env.PLANNOTATOR_REMOTE = "0";
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (savedPort === undefined) delete process.env.PLANNOTATOR_PORT;
  else process.env.PLANNOTATOR_PORT = savedPort;
  if (savedRemote === undefined) delete process.env.PLANNOTATOR_REMOTE;
  else process.env.PLANNOTATOR_REMOTE = savedRemote;
});

async function planPayload(filePath: string, markdown: string) {
  const server = await startAnnotateServer({ markdown, filePath, htmlContent: MINIMAL_HTML });
  try {
    const res = await fetch(`${server.url}/api/plan`);
    return (await res.json()) as { plan: string; renderAs?: string; rawHtml?: string };
  } finally {
    server.stop();
  }
}

describe("/api/plan", () => {
  test("a .mmd file is served as mermaid with its raw text as the body", async () => {
    const file = join(dir, "flow.mmd");
    writeFileSync(file, MERMAID);
    const json = await planPayload(file, MERMAID);
    expect(json.renderAs).toBe("mermaid");
    expect(json.plan).toBe(MERMAID);
    expect(json.rawHtml).toBeUndefined();
  });

  test("a .dot file is served as graphviz with its raw text as the body", async () => {
    const file = join(dir, "graph.dot");
    writeFileSync(file, DOT);
    const json = await planPayload(file, DOT);
    expect(json.renderAs).toBe("graphviz");
    expect(json.plan).toBe(DOT);
  });

  test("a markdown file is unaffected", async () => {
    const file = join(dir, "notes.md");
    writeFileSync(file, "# Notes");
    const json = await planPayload(file, "# Notes");
    expect(json.renderAs).toBe("markdown");
  });

  test("a URL target whose path ends in .dot is not a diagram session", async () => {
    const json = await planPayload("https://example.com/assets/graph.dot", "# Converted");
    expect(json.renderAs).toBe("markdown");
  });
});

describe("/api/doc", () => {
  test("serves a diagram sibling with its engine and raw text", async () => {
    writeFileSync(join(dir, "index.md"), "# Index\n\n[flow](flow.mmd)\n");
    const file = join(dir, "flow.mmd");
    writeFileSync(file, MERMAID);
    const server = await startAnnotateServer({
      markdown: "",
      filePath: dir,
      folderPath: dir,
      mode: "annotate-folder",
      htmlContent: MINIMAL_HTML,
    });
    try {
      const res = await fetch(`${server.url}/api/doc?path=${encodeURIComponent(file)}`);
      const json = (await res.json()) as { renderAs?: string; markdown?: string };
      expect(res.status).toBe(200);
      expect(json.renderAs).toBe("mermaid");
      expect(json.markdown).toBe(MERMAID);
    } finally {
      server.stop();
    }
  });
});

describe("CLI target resolution", () => {
  test("resolves .mmd and .dot, still refuses an unsupported extension", async () => {
    writeFileSync(join(dir, "flow.mmd"), MERMAID);
    writeFileSync(join(dir, "graph.gv"), DOT);
    writeFileSync(join(dir, "app.py"), "print(1)\n");

    const mmd = await resolveAnnotateTarget({
      rawFilePath: "flow.mmd", projectRoot: dir, noJina: true, renderMarkdown: false, log: () => {},
    });
    expect(mmd.ok).toBe(true);
    if (mmd.ok) expect(mmd.markdown).toBe(MERMAID);

    const gv = await resolveAnnotateTarget({
      rawFilePath: "graph.gv", projectRoot: dir, noJina: true, renderMarkdown: false, log: () => {},
    });
    expect(gv.ok).toBe(true);

    const py = await resolveAnnotateTarget({
      rawFilePath: "app.py", projectRoot: dir, noJina: true, renderMarkdown: false, log: () => {},
    });
    expect(py.ok).toBe(false);
    if (!py.ok) expect(py.message).toContain("File type not supported: .py");
  });

  test("a .env is still not annotatable even though it is plain text", async () => {
    writeFileSync(join(dir, ".env"), "SECRET=1\n");
    const result = await resolveAnnotateTarget({
      rawFilePath: ".env", projectRoot: dir, noJina: true, renderMarkdown: false, log: () => {},
    });
    expect(result.ok).toBe(false);
  });

  test("the 2MB annotatable cap applies to a diagram source", async () => {
    const file = join(dir, "huge.mmd");
    writeFileSync(file, "x".repeat(MAX_ANNOTATABLE_FILE_BYTES + 1));
    const result = await resolveAnnotateTarget({
      rawFilePath: "huge.mmd", projectRoot: dir, noJina: true, renderMarkdown: false, log: () => {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("File too large to annotate");
  });
});
