import { describe, expect, test } from "bun:test";
import {
  GUIDE_SNAPSHOT_SCRIPT_ID,
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
  type GuideSnapshotV1,
} from "./guide-format";
import { FIXTURE_PATCH_TS_JSON, FIXTURE_V1_LOCAL, FIXTURE_V1_PR, GUIDE_SNAPSHOT_FIXTURES } from "./guide-format-fixtures";

const VIEWER = {
  baseUrl: "https://guides.show/v1/",
  js: "viewer.8f3a2c.js",
  css: "viewer.8f3a2c.css",
  jsIntegrity: "sha384-AAAA",
  cssIntegrity: "sha384-BBBB",
  langs: { typescript: "langs/typescript.ab12.js", json: "langs/json.cd34.js", python: "langs/python.ef56.js" },
};

/**
 * Read the embedded snapshot back the way the viewer boots: through
 * `readEmbeddedGuideSnapshot` over a document that resolves elements by id, so a
 * writer/reader script-id divergence fails every export test below.
 */
function snapshotFromHtml(html: string): GuideSnapshotV1 {
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
  // This is the promise behind pinned exports (D8/D10). If this fails, an old
  // export would no longer open in the newest viewer — bump the version, don't
  // edit the fixture.
  for (const { name, snapshot } of GUIDE_SNAPSHOT_FIXTURES) {
    test(name, () => {
      const parsed = parseGuideSnapshot(JSON.parse(JSON.stringify(snapshot)));
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.value.guide.reviewed).toHaveLength(parsed.value.guide.sections.length);
        expect(parsed.value.source.kind).toBe(snapshot.source.kind);
      }
    });
  }
});

describe("parseGuideSnapshot rejects what it must", () => {
  const cases: Array<[string, (s: any) => void, string]> = [
    ["unknown top-level field", (s) => (s.annotations = []), "$"],
    ["unknown guide field", (s) => (s.guide.saved = true), "$.guide"],
    ["unknown section field", (s) => (s.guide.sections[0].order = 1), "$.guide.sections[0]"],
    ["wrong version", (s) => (s.version = 2), "$.version"],
    ["wrong kind", (s) => (s.kind = "nope"), "$.kind"],
    ["non-boolean reviewed", (s) => (s.guide.reviewed = ["yes"]), "$.guide.reviewed[0]"],
    ["empty sections", (s) => (s.guide.sections = []), "$.guide.sections"],
    ["bad source kind", (s) => (s.source.kind = "branch"), "$.source.kind"],
    ["pr without url", (s) => (s.source.pr = { number: 1 }), "$.source.pr.url"],
    ["bad platform", (s) => (s.source.pr = { url: "https://x", platform: "bitbucket" }), "$.source.pr.platform"],
    // Rendered into an href on hosted pages: only web URLs.
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
    // The raw string must not appear anywhere in the document…
    expect(html).not.toContain("'</script><!--'");
    // …and the embedded JSON must round-trip byte-for-byte.
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
