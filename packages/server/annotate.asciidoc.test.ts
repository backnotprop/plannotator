/**
 * Annotate server: AsciiDoc sources (.adoc/.asciidoc).
 *
 * The editor parses a document with the AsciiDoc block parser only when the
 * server names it in `renderAs`, so /api/plan and /api/doc must say
 * "asciidoc" and serve the file's RAW text (never converted). The CLI must
 * accept the file, and a review of several files must carry the kind per file.
 * Pi mirrors this in apps/pi-extension/server/serverAnnotate-asciidoc.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAnnotateServer } from "./annotate";
import { resolveAnnotateTarget } from "../../apps/hook/server/annotate-resolution";
import { resolveAnnotateBundleFiles } from "@plannotator/shared/annotate-target";
import { NO_BROWSER } from "../../tests/helpers/no-browser";

const MINIMAL_HTML = "<html><body>Plannotator</body></html>";
const ADOC = "= Guide\n\nNOTE: Read *this* first.\n\n[source,bash]\n----\nmake\n----\n";

const ENV_KEYS = ["PLANNOTATOR_PORT", "PLANNOTATOR_REMOTE", "PLANNOTATOR_DATA_DIR", "PLANNOTATOR_ANNOTATE_HISTORY", "PLANNOTATOR_BROWSER"] as const;
let dir: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pn-adoc-"));
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  delete process.env.PLANNOTATOR_PORT;
  process.env.PLANNOTATOR_REMOTE = "0";
  process.env.PLANNOTATOR_DATA_DIR = join(dir, ".data");
  process.env.PLANNOTATOR_ANNOTATE_HISTORY = "0";
  process.env.PLANNOTATOR_BROWSER = NO_BROWSER;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

async function planPayload(filePath: string, markdown: string) {
  const server = await startAnnotateServer({ markdown, filePath, htmlContent: MINIMAL_HTML });
  try {
    return (await (await fetch(`${server.url}/api/plan`)).json()) as { plan: string; renderAs?: string };
  } finally {
    server.stop();
  }
}

describe("/api/plan", () => {
  test("an .adoc file is served as asciidoc with its raw text", async () => {
    const file = join(dir, "guide.adoc");
    writeFileSync(file, ADOC);
    const json = await planPayload(file, ADOC);
    expect(json.renderAs).toBe("asciidoc");
    expect(json.plan).toBe(ADOC);
  });

  test("a URL target ending in .adoc is not an AsciiDoc session", async () => {
    const json = await planPayload("https://example.com/docs/guide.adoc", "# Converted");
    expect(json.renderAs).toBe("markdown");
  });
});

describe("/api/doc", () => {
  test("serves an .asciidoc file in a folder with its kind and raw text", async () => {
    const file = join(dir, "legacy.asciidoc");
    writeFileSync(file, ADOC);
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
      expect(json.renderAs).toBe("asciidoc");
      expect(json.markdown).toBe(ADOC);
    } finally {
      server.stop();
    }
  });
});

describe("CLI target resolution", () => {
  test("resolves an .adoc file as itself", async () => {
    writeFileSync(join(dir, "guide.adoc"), ADOC);
    const result = await resolveAnnotateTarget({
      rawFilePath: "guide.adoc", projectRoot: dir, noJina: true, renderMarkdown: false, log: () => {},
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.markdown).toBe(ADOC);
  });

  test("a review of several files names AsciiDoc per file", () => {
    const adoc = join(dir, "guide.adoc");
    const md = join(dir, "notes.md");
    writeFileSync(adoc, ADOC);
    writeFileSync(md, "# Notes\n");
    expect(resolveAnnotateBundleFiles([adoc, md])).toEqual({
      ok: true,
      files: [
        { path: adoc, renderAs: "asciidoc" },
        { path: md, renderAs: "markdown" },
      ],
    });
  });
});
