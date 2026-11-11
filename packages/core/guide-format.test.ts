import { describe, expect, test } from "bun:test";
import {
  GUIDE_SNAPSHOT_SCRIPT_ID,
  buildGuideSnapshot,
  createGuideHtml,
  detectGuideLanguages,
  escapeJsonForHtmlScript,
  guideExportFilename,
  guideLanguageForPath,
  listGuidePatchFiles,
  normalizeGuideViewerBaseUrl,
  parseGuideSnapshot,
  parseGuideSnapshotJson,
  readEmbeddedGuideSnapshot,
  type GuideSnapshot,
  type GuideSnapshotV1,
} from "./guide-format";
import { FIXTURE_PATCH_TS_JSON, FIXTURE_V1_LOCAL, FIXTURE_V1_PR, FIXTURE_V2_HTML, FIXTURE_V2_OVERVIEW, GUIDE_SNAPSHOT_FIXTURES } from "./guide-format-fixtures";
import { checkGuideNotes } from "./guide-notes";

const VIEWER = {
  baseUrl: "https://guides.show/v1/",
  js: "viewer.8f3a2c.js",
  css: "viewer.8f3a2c.css",
  jsIntegrity: "sha384-AAAA",
  cssIntegrity: "sha384-BBBB",
  langs: { typescript: "langs/typescript.ab12.js", json: "langs/json.cd34.js", python: "langs/python.ef56.js" },
};

function snapshotFromHtml(html: string): GuideSnapshot {
  const doc = {
    getElementById(id: string) {
      const match = new RegExp(`<script id="${id}" type="application/json">([\\s\\S]*?)</script>`).exec(html);
      return match ? { textContent: match[1] } : null;
    },
  };
  const parsed = readEmbeddedGuideSnapshot(doc);
  if (!parsed) throw new Error("snapshot script missing");
  if (!parsed.ok) throw new Error(`${parsed.error.path}: ${parsed.error.message}`);
  return parsed.value;
}

describe("compatibility: every shipped fixture parses with the current parser", () => {
  for (const { name, snapshot } of GUIDE_SNAPSHOT_FIXTURES) {
    test(name, () => {
      const parsed = parseGuideSnapshot(JSON.parse(JSON.stringify(snapshot)));
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.value.guide.reviewed).toHaveLength(parsed.value.guide.sections.length);
        expect(parsed.value.source.kind).toBe(snapshot.source.kind);
        expect(parsed.value.version).toBe(snapshot.version);
        expect(parsed.value).toEqual(JSON.parse(JSON.stringify(snapshot)));
      }
    });
  }
});

describe("parseGuideSnapshot rejects what it must", () => {
  const cases: Array<[string, (s: any) => void, string]> = [
    ["unknown top-level field", (s) => (s.annotations = []), "$"],
    ["unknown guide field", (s) => (s.guide.saved = true), "$.guide"],
    ["unknown section field", (s) => (s.guide.sections[0].order = 1), "$.guide.sections[0]"],
    ["unknown version", (s) => (s.version = 6), "$.version"],
    ["overview on a version-1 snapshot", (s) => (s.guide.overview = { text: "x" }), "$.guide"],
    ["empty overview text", (s) => { s.version = 2; s.guide.overview = { text: "  " }; }, "$.guide.overview.text"],
    ["unknown overview field", (s) => { s.version = 2; s.guide.overview = { text: "x", links: [] }; }, "$.guide.overview"],
    ["bad diagram kind", (s) => { s.version = 2; s.guide.overview = { text: "x", diagram: { kind: "svg", source: "<svg/>" } }; }, "$.guide.overview.diagram.kind"],
    ["empty diagram source", (s) => { s.version = 2; s.guide.overview = { text: "x", diagram: { kind: "mermaid", source: "" } }; }, "$.guide.overview.diagram.source"],
    ["unknown diagram field", (s) => { s.version = 2; s.guide.overview = { text: "x", diagram: { kind: "mermaid", source: "graph TD", theme: "x" } }; }, "$.guide.overview.diagram"],
    ["wrong kind", (s) => (s.kind = "nope"), "$.kind"],
    ["non-boolean reviewed", (s) => (s.guide.reviewed = ["yes"]), "$.guide.reviewed[0]"],
    ["empty sections", (s) => (s.guide.sections = []), "$.guide.sections"],
    ["bad source kind", (s) => (s.source.kind = "branch"), "$.source.kind"],
    ["pr without url", (s) => (s.source.pr = { number: 1 }), "$.source.pr.url"],
    ["bad platform", (s) => (s.source.pr = { url: "https://x", platform: "bitbucket" }), "$.source.pr.platform"],
    ["pr url with a script scheme", (s) => (s.source.pr = { url: "javascript:alert(1)" }), "$.source.pr.url"],
    ["missing rawPatch", (s) => delete s.review.rawPatch, "$.review.rawPatch"],
    ["bad exportedAt", (s) => (s.exportedAt = "yesterday"), "$.exportedAt"],
  ];
  for (const [name, mutate, path] of cases) {
    test(name, () => {
      const s = JSON.parse(JSON.stringify(FIXTURE_V1_PR));
      mutate(s);
      const parsed = parseGuideSnapshot(s);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error.path).toBe(path);
    });
  }

  test("reviewed is normalized to sections.length (pad + truncate)", () => {
    const s = JSON.parse(JSON.stringify(FIXTURE_V1_LOCAL));
    s.guide.reviewed = [true, false, true, true];
    const parsed = parseGuideSnapshot(s);
    expect(parsed.ok && parsed.value.guide.reviewed).toEqual([true, false]);
    s.guide.reviewed = [];
    const parsed2 = parseGuideSnapshot(s);
    expect(parsed2.ok && parsed2.value.guide.reviewed).toEqual([false, false]);
  });

  test("invalid JSON text is a parse error, not a throw", () => {
    const parsed = parseGuideSnapshotJson("{nope");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.path).toBe("$");
  });
});

describe("createGuideHtml", () => {
  test("a patch line containing </script> cannot terminate the snapshot element", () => {
    const html = createGuideHtml(FIXTURE_V1_LOCAL, { viewer: VIEWER });
    expect(html).not.toContain("'</script><!--'");
    expect(snapshotFromHtml(html).review.rawPatch).toBe(FIXTURE_PATCH_TS_JSON);
  });

  test("escapeJsonForHtmlScript escapes &, <, >, U+2028, U+2029 as JSON unicode escapes", () => {
    const escaped = escapeJsonForHtmlScript(JSON.stringify("a<b>&c\u2028d\u2029"));
    expect(escaped).not.toMatch(/[<>&\u2028\u2029]/);
    expect(JSON.parse(escaped)).toBe("a<b>&c\u2028d\u2029");
  });

  test("pins the exact viewer build with integrity and preloads only detected languages", () => {
    const html = createGuideHtml(FIXTURE_V1_LOCAL, { viewer: VIEWER });
    expect(html).toContain('src="https://guides.show/v1/viewer.8f3a2c.js" integrity="sha384-AAAA"');
    expect(html).toContain('href="https://guides.show/v1/viewer.8f3a2c.css" integrity="sha384-BBBB"');
    expect(html).toContain("langs/typescript.ab12.js");
    expect(html).toContain("langs/json.cd34.js");
    expect(html).not.toContain("langs/python.ef56.js");
  });

  test("CSP allows only the viewer origin, inline styles, and blob workers", () => {
    const html = createGuideHtml(FIXTURE_V1_LOCAL, { viewer: VIEWER });
    const csp = /Content-Security-Policy" content="([^"]+)"/.exec(html)![1];
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src https://guides.show 'wasm-unsafe-eval' blob:");
    expect(csp).toContain("connect-src https://guides.show");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toContain("http:");
  });

  test("the no-JS fallback body carries the guide text and the PR link", () => {
    const html = createGuideHtml(FIXTURE_V1_PR, { viewer: VIEWER });
    const body = html.slice(html.indexOf('<div id="root">'), html.indexOf(`<script id="${GUIDE_SNAPSHOT_SCRIPT_ID}"`));
    expect(body).toContain("PR: auth token refresh");
    expect(body).toContain("Guard the refresh entry point");
    expect(body).toContain("<code>src/auth.ts</code>");
    expect(body).toContain('href="https://github.com/acme/demo/pull/42"');
  });

  test("HTML-significant characters in guide text are escaped in the fallback body", () => {
    const s: GuideSnapshotV1 = {
      ...FIXTURE_V1_LOCAL,
      guide: { ...FIXTURE_V1_LOCAL.guide, title: '<img src=x onerror=alert(1)> "quoted"' },
    };
    const html = createGuideHtml(s, { viewer: VIEWER });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  test("document overhead beyond the snapshot stays small (D1)", () => {
    const html = createGuideHtml(FIXTURE_V1_LOCAL, { viewer: VIEWER });
    const snapshotBytes = new TextEncoder().encode(escapeJsonForHtmlScript(JSON.stringify(FIXTURE_V1_LOCAL))).byteLength;
    const overhead = new TextEncoder().encode(html).byteLength - snapshotBytes;
    expect(overhead).toBeLessThan(6_000);
  });

  test("refuses a non-https viewer base (except http localhost)", () => {
    expect(() => createGuideHtml(FIXTURE_V1_LOCAL, { viewer: { ...VIEWER, baseUrl: "javascript:alert(1)" } })).toThrow();
    expect(() => createGuideHtml(FIXTURE_V1_LOCAL, { viewer: { ...VIEWER, baseUrl: "http://evil.example/v1/" } })).toThrow();
    expect(() => createGuideHtml(FIXTURE_V1_LOCAL, { viewer: { ...VIEWER, baseUrl: "http://localhost:5173/" } })).not.toThrow();
  });
});

describe("normalizeGuideViewerBaseUrl", () => {
  test("strips credentials, query and hash; forces trailing slash", () => {
    const url = normalizeGuideViewerBaseUrl("https://user:pw@guides.show/v1?x=1#y");
    expect(url?.href).toBe("https://guides.show/v1/");
  });
  test("rejects non-https and garbage", () => {
    expect(normalizeGuideViewerBaseUrl("ftp://guides.show/")).toBeNull();
    expect(normalizeGuideViewerBaseUrl("not a url")).toBeNull();
  });
});

describe("language detection", () => {
  test("maps common extensions and special basenames", () => {
    expect(guideLanguageForPath("src/a.ts")).toBe("typescript");
    expect(guideLanguageForPath("src/a.tsx")).toBe("tsx");
    expect(guideLanguageForPath("Dockerfile")).toBe("docker");
    expect(guideLanguageForPath("build/Makefile")).toBe("make");
    expect(guideLanguageForPath("README")).toBeUndefined();
    expect(guideLanguageForPath("weird.unknownext")).toBeUndefined();
  });
  test("detectGuideLanguages is sorted and deduplicated across the whole patch", () => {
    expect(detectGuideLanguages(FIXTURE_PATCH_TS_JSON)).toEqual(["json", "typescript"]);
  });
  test("listGuidePatchFiles resolves the post-image path per chunk", () => {
    expect(listGuidePatchFiles(FIXTURE_PATCH_TS_JSON).map((f) => f.path)).toEqual(["src/auth.ts", "package.json"]);
  });
});

describe("guideExportFilename", () => {
  test("slugs punctuation and diacritics, bounds length, always has a stem", () => {
    expect(guideExportFilename("Auth: token refresh (v2)!")).toBe("guided-review-auth-token-refresh-v2.html");
    expect(guideExportFilename("Éclair déjà vu")).toBe("guided-review-eclair-deja-vu.html");
    expect(guideExportFilename("🎉🎉")).toBe("guided-review-export.html");
    expect(guideExportFilename("x".repeat(200)).length).toBeLessThanOrEqual("guided-review-".length + 80 + ".html".length);
  });
});

describe("format version 2: the overview", () => {
  const pieces = {
    reviewed: [true, false],
    review: { rawPatch: FIXTURE_PATCH_TS_JSON, gitRef: "origin/main..HEAD", diffType: "since-base", base: "origin/main", source: FIXTURE_V1_LOCAL.source },
    generator: FIXTURE_V1_LOCAL.generator,
    exportedAt: FIXTURE_V1_LOCAL.exportedAt,
  };

  test("a guide without an overview still builds the version-1 document, byte for byte", () => {
    const { reviewed: _r, ...guide } = FIXTURE_V1_LOCAL.guide;
    const built = buildGuideSnapshot({ ...pieces, guide });
    expect(JSON.stringify(built)).toBe(JSON.stringify(FIXTURE_V1_LOCAL));
    expect(createGuideHtml(built, { viewer: VIEWER })).toBe(createGuideHtml(FIXTURE_V1_LOCAL, { viewer: VIEWER }));
    expect(createGuideHtml(built, { viewer: VIEWER })).toContain('content="v1"');
  });

  test("a guide with an overview builds version 2, the overview after the intent", () => {
    const { reviewed: _r, ...guide } = FIXTURE_V2_OVERVIEW.guide;
    const built = buildGuideSnapshot({ ...pieces, guide });
    expect(built.version).toBe(2);
    expect(JSON.stringify(built)).toBe(JSON.stringify(FIXTURE_V2_OVERVIEW));
    expect(Object.keys(built.guide)).toEqual(["title", "intent", "overview", "sections", "unplacedFiles", "reviewed"]);
  });

  test("stray overview fields never reach the snapshot", () => {
    const { reviewed: _r, ...guide } = FIXTURE_V2_OVERVIEW.guide;
    const sloppy = { ...guide, overview: { ...guide.overview!, extra: 1, diagram: { ...guide.overview!.diagram!, theme: "x" } } };
    const built = buildGuideSnapshot({ ...pieces, guide: sloppy as typeof guide });
    expect(parseGuideSnapshot(JSON.parse(JSON.stringify(built))).ok).toBe(true);
  });

  test("a version-2 document without an overview is read (forward-tolerant)", () => {
    const parsed = parseGuideSnapshot({ ...JSON.parse(JSON.stringify(FIXTURE_V1_LOCAL)), version: 2 });
    expect(parsed.ok && parsed.value.version).toBe(2);
  });

  test("version-2 exports round-trip through the HTML and say v2; the fallback body carries the overview text", () => {
    const html = createGuideHtml(FIXTURE_V2_OVERVIEW, { viewer: VIEWER });
    expect(html).toContain('content="v2"');
    expect(snapshotFromHtml(html)).toEqual(JSON.parse(JSON.stringify(FIXTURE_V2_OVERVIEW)));
    const body = html.slice(html.indexOf('<div id="root">'), html.indexOf(`<script id="${GUIDE_SNAPSHOT_SCRIPT_ID}"`));
    expect(body).toContain("The guard in [`refresh`](symbol:src/auth.ts#refresh) runs first");
  });
});

describe("format version 3: a drawn overview picture (code review's Show me)", () => {
  const pieces = {
    reviewed: [true, false],
    review: { rawPatch: FIXTURE_PATCH_TS_JSON, gitRef: "origin/main..HEAD", diffType: "since-base", base: "origin/main", source: FIXTURE_V1_LOCAL.source },
    generator: FIXTURE_V1_LOCAL.generator,
    exportedAt: FIXTURE_V1_LOCAL.exportedAt,
  };
  const drawn = { kind: "html" as const, source: '<div data-mark="a" data-code="src/auth.ts#L2">guard</div>', css: ".a { color: var(--ink); }", width: 800, height: 360, tall: { source: "<div>guard</div>" } };
  const v3 = (diagram: unknown) => ({ ...JSON.parse(JSON.stringify(FIXTURE_V2_HTML)), version: 3, guide: { ...JSON.parse(JSON.stringify(FIXTURE_V2_HTML.guide)), overview: { text: "x", diagram } } });

  test("a guide whose html diagram carries css, a canvas or tall builds version 3 and reads back unchanged", () => {
    const { reviewed: _r, ...guide } = FIXTURE_V2_HTML.guide;
    const built = buildGuideSnapshot({ ...pieces, guide: { ...guide, overview: { text: "x", diagram: drawn } } });
    expect(built.version).toBe(3);
    const parsed = parseGuideSnapshot(JSON.parse(JSON.stringify(built)));
    expect(parsed.ok && parsed.value.guide.overview?.diagram).toEqual(drawn);
  });

  test("an html diagram with only a source still builds version 2, byte for byte", () => {
    const { reviewed: _r, ...guide } = FIXTURE_V2_HTML.guide;
    const built = buildGuideSnapshot({ ...pieces, guide });
    expect(built.version).toBe(2);
    expect(JSON.stringify(built)).toBe(JSON.stringify({ ...FIXTURE_V2_HTML, review: { ...FIXTURE_V2_HTML.review } }));
  });

  test("drawn fields are refused on a version-2 document: a v2 reader never sees them", () => {
    const parsed = parseGuideSnapshot({ ...v3(drawn), version: 2 });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.path).toBe("$.guide.overview.diagram");
  });

  const bad: Array<[string, unknown]> = [
    ["a version-3 diagram with none of its fields", { kind: "html", source: "<div/>" }],
    ["width without height", { kind: "html", source: "<div/>", width: 800 }],
    ["a canvas out of range", { kind: "html", source: "<div/>", width: 100, height: 300 }],
    ["drawn fields on a mermaid diagram", { kind: "mermaid", source: "flowchart LR", css: "x" }],
    ["an unknown tall field", { kind: "html", source: "<div/>", tall: { source: "<div/>", width: 400 } }],
  ];
  for (const [name, diagram] of bad) {
    test(`refuses ${name}`, () => {
      expect(parseGuideSnapshot(v3(diagram)).ok).toBe(false);
    });
  }
});

describe("format version 4: the guide author's context notes", () => {
  const pieces = {
    reviewed: [true, false],
    review: { rawPatch: FIXTURE_PATCH_TS_JSON, gitRef: "origin/main..HEAD", diffType: "since-base", base: "origin/main", source: FIXTURE_V1_LOCAL.source },
    generator: FIXTURE_V1_LOCAL.generator,
    exportedAt: FIXTURE_V1_LOCAL.exportedAt,
  };
  const { reviewed: _r, ...base } = FIXTURE_V1_LOCAL.guide;
  const withNotes = (notes: unknown) => ({
    ...base,
    sections: base.sections.map((section, i) => (i === 0 ? { ...section, diffs: section.diffs.map((ref) => ({ ...ref, notes })) } : section)),
  });
  const note = { lineStart: 2, lineEnd: 4, text: "Refresh happens here so callers stop retrying." };
  const build = (notes: unknown) => buildGuideSnapshot({ ...pieces, guide: withNotes(notes) as typeof base });

  test("a guide with a note builds version 4 and reads the note back", () => {
    const built = build([note]);
    expect(built.version).toBe(4);
    const parsed = parseGuideSnapshot(JSON.parse(JSON.stringify(built)));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.guide.sections[0]!.diffs[0]!.notes).toEqual([note]);
  });

  test("a guide with an empty notes list still builds version 1, byte for byte", () => {
    const built = build([]);
    expect(built.version).toBe(1);
    expect(JSON.stringify(built)).toBe(JSON.stringify(FIXTURE_V1_LOCAL));
  });

  test("notes are refused below version 4: an older reader never sees them", () => {
    const doc = JSON.parse(JSON.stringify(build([note])));
    for (const version of [1, 2, 3]) expect(parseGuideSnapshot({ ...doc, version }).ok).toBe(false);
  });

  const bad: Array<[string, unknown]> = [
    ["a note with no words", [{ lineStart: 2, lineEnd: 3, text: "  " }]],
    ["lineEnd before lineStart", [{ lineStart: 4, lineEnd: 2, text: "x" }]],
    ["an unknown side", [{ lineStart: 2, lineEnd: 3, side: "left", text: "x" }]],
    ["an unknown field", [{ lineStart: 2, lineEnd: 3, text: "x", author: "me" }]],
    ["notes that are not a list", { lineStart: 2, text: "x" }],
  ];
  for (const [name, notes] of bad) {
    test(`refuses ${name}`, () => {
      const doc = JSON.parse(JSON.stringify(build([note])));
      doc.guide.sections[0].diffs[0].notes = notes;
      expect(parseGuideSnapshot(doc).ok).toBe(false);
    });
  }

  test("checkGuideNotes keeps each note inside one hunk of its file, on its side", () => {
    expect(checkGuideNotes(withNotes([note]), FIXTURE_PATCH_TS_JSON)).toEqual([]);
    expect(checkGuideNotes(withNotes([{ lineStart: 2, lineEnd: 2, side: "old", text: "x" }]), FIXTURE_PATCH_TS_JSON)).toEqual([]);
    const outside = checkGuideNotes(withNotes([{ lineStart: 5, lineEnd: 9, text: "x" }]), FIXTURE_PATCH_TS_JSON);
    expect(outside).toHaveLength(1);
    expect(outside[0]).toContain("sections[0].diffs[0].notes[0]");
    expect(outside[0]).toContain("lines 5–9");
    expect(checkGuideNotes(withNotes([{ lineStart: 6, lineEnd: 6, side: "old", text: "x" }]), FIXTURE_PATCH_TS_JSON)).toHaveLength(1);
    expect(checkGuideNotes({ sections: [{ diffs: [{ file: "src/gone.ts", notes: [note] }] }] }, FIXTURE_PATCH_TS_JSON)).toHaveLength(1);
  });
});

describe("format version 5: a chapter's diagram", () => {
  const pieces = {
    reviewed: [true, false],
    review: { rawPatch: FIXTURE_PATCH_TS_JSON, gitRef: "origin/main..HEAD", diffType: "since-base", base: "origin/main", source: FIXTURE_V1_LOCAL.source },
    generator: FIXTURE_V1_LOCAL.generator,
    exportedAt: FIXTURE_V1_LOCAL.exportedAt,
  };
  const { reviewed: _r, ...base } = FIXTURE_V1_LOCAL.guide;
  const mermaid = { kind: "mermaid" as const, source: "flowchart LR\n  a --> b" };
  const withDiagram = (diagram: unknown, extra: Record<string, unknown> = {}) => ({
    ...base,
    ...extra,
    sections: base.sections.map((section, i) => (i === 0 ? { ...section, diagram } : section)),
  });
  const build = (diagram: unknown, extra: Record<string, unknown> = {}) =>
    buildGuideSnapshot({ ...pieces, guide: withDiagram(diagram, extra) as typeof base });

  test("a chapter with a diagram builds version 5 and reads it back on that chapter only", () => {
    const built = build(mermaid);
    expect(built.version).toBe(5);
    const parsed = parseGuideSnapshot(JSON.parse(JSON.stringify(built)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.guide.sections[0]!.diagram).toEqual(mermaid);
    expect("diagram" in parsed.value.guide.sections[1]!).toBe(false);
  });

  test("stray producer fields on a chapter's diagram never travel", () => {
    const built = build({ ...mermaid, note: "x" });
    expect(built.guide.sections[0]!.diagram).toEqual(mermaid);
  });

  test("version 5 keeps an overview with its old diagram, and notes", () => {
    const overview = { text: "How it fits.", diagram: { kind: "mermaid" as const, source: "flowchart TD\n  x --> y" } };
    const guide = withDiagram(mermaid, { overview });
    guide.sections[1] = { ...guide.sections[1]!, diffs: guide.sections[1]!.diffs.map((ref) => ({ ...ref, notes: [{ lineStart: 1, lineEnd: 1, text: "why" }] })) };
    const built = buildGuideSnapshot({ ...pieces, guide: guide as typeof base });
    expect(built.version).toBe(5);
    const parsed = parseGuideSnapshot(JSON.parse(JSON.stringify(built)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.guide.overview).toEqual(overview);
    expect(parsed.value.guide.sections[1]!.diffs[0]!.notes).toHaveLength(1);
  });

  test("a chapter's diagram is refused below version 5: an older reader never sees one", () => {
    const doc = JSON.parse(JSON.stringify(build(mermaid)));
    for (const version of [1, 2, 3, 4]) expect(parseGuideSnapshot({ ...doc, version }).ok).toBe(false);
  });

  test("a guide with no chapter diagram keeps its old version, byte for byte", () => {
    const built = buildGuideSnapshot({ ...pieces, guide: base as typeof base });
    expect(built.version).toBe(1);
    expect(JSON.stringify(built)).toBe(JSON.stringify(FIXTURE_V1_LOCAL));
  });

  test("an html chapter picture may carry the drawn keys", () => {
    const drawn = { kind: "html" as const, source: "<div/>", css: ".a{}", width: 800, height: 400 };
    const parsed = parseGuideSnapshot(JSON.parse(JSON.stringify(build(drawn))));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.guide.sections[0]!.diagram).toEqual(drawn);
  });

  const bad: Array<[string, unknown]> = [
    ["an unknown kind", { kind: "svg", source: "<svg/>" }],
    ["an empty source", { kind: "mermaid", source: "  " }],
    ["no source", { kind: "mermaid" }],
    ["an unknown field", { kind: "mermaid", source: "flowchart LR", title: "x" }],
    ["drawn fields on a mermaid diagram", { kind: "mermaid", source: "flowchart LR", css: "x" }],
    ["a diagram that is not an object", "flowchart LR"],
  ];
  for (const [name, diagram] of bad) {
    test(`refuses ${name}`, () => {
      const doc = JSON.parse(JSON.stringify(build(mermaid)));
      doc.guide.sections[0].diagram = diagram;
      const parsed = parseGuideSnapshot(doc);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error.path.startsWith("$.guide.sections[0].diagram")).toBe(true);
    });
  }
});
