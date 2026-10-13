/**
 * The decision table of `/api/review-markdown-image`, against a fake side
 * reader: every refusal, the side and folder each path resolves against,
 * and that a read is never attempted before the cheap checks pass.
 */
import { describe, expect, test } from "bun:test";
import type { DiffSide, FileBytesRead } from "./review-core";
import {
  handleReviewMarkdownImageRequest,
  markdownImageRefs,
  resolveMarkdownImagePath,
  type ReviewMarkdownImageRequest,
} from "./review-markdown-image";

const encoder = new TextEncoder();

function png(width: number, height: number): Uint8Array {
  const out = new Uint8Array(33 + 16);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(out.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return out;
}

const PATCH = [
  "diff --git a/docs/guide.md b/docs/guide.md",
  "--- a/docs/guide.md",
  "+++ b/docs/guide.md",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "diff --git a/docs/old.md b/docs/moved/new.md",
  "similarity index 90%",
  "rename from docs/old.md",
  "rename to docs/moved/new.md",
  "--- a/docs/old.md",
  "+++ b/docs/moved/new.md",
  "@@ -1 +1 @@",
  "-a",
  "+b",
  "diff --git a/gone.md b/gone.md",
  "deleted file mode 100644",
  "--- a/gone.md",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-x",
  "diff --git a/src/app.ts b/src/app.ts",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1 +1 @@",
  "-a",
  "+b",
  "diff --git a/notes.livemd b/notes.livemd",
  "--- a/notes.livemd",
  "+++ b/notes.livemd",
  "@@ -1 +1 @@",
  "-a",
  "+b",
  "",
].join("\n");

type Store = Record<string, Uint8Array | FileBytesRead>;

/** A fake repository: `${side}:${path}` → bytes (or a read result). */
function makeRequest(
  query: Record<string, string>,
  store: Store,
  overrides: Partial<ReviewMarkdownImageRequest> = {},
): { request: ReviewMarkdownImageRequest; reads: string[] } {
  const reads: string[] = [];
  const request: ReviewMarkdownImageRequest = {
    params: new URLSearchParams({ snapshot: "s1", ...query }),
    available: true,
    patch: PATCH,
    markdownExtensions: [".livemd"],
    isCurrentSnapshot: (snapshot) => snapshot === "s1",
    readSide: async (side: DiffSide, filePath: string, oldPath: string | undefined) => {
      const path = side === "old" ? oldPath ?? filePath : filePath;
      reads.push(`${side}:${path}`);
      const value = store[`${side}:${path}`];
      if (!value) return { kind: "missing" };
      if (value instanceof Uint8Array) return { kind: "ok", bytes: value, etag: `"${side}-${path}"` };
      return value;
    },
    ...overrides,
  };
  return { request, reads };
}

async function answer(query: Record<string, string>, store: Store, overrides?: Partial<ReviewMarkdownImageRequest>) {
  const { request, reads } = makeRequest(query, store, overrides);
  const response = await handleReviewMarkdownImageRequest(request);
  const reason = response.headers["Content-Type"] === "application/json"
    ? (JSON.parse(String(response.body)) as { reason: string }).reason
    : null;
  return { response, reason, reads };
}

const doc = (text: string) => encoder.encode(text);

describe("markdownImageRefs", () => {
  test("inline, angle-bracket, titled, reference-style and <img> sources; remote ones are left out", () => {
    const refs = markdownImageRefs([
      "![a](img/a.png)",
      '![b](<img/my b.png> "title")',
      "![c](img/c.png 'title')",
      "![d][logo] and ![Logo][] and ![logo]",
      "[logo]: assets/logo.svg",
      '<img alt="x" src="img/x&amp;y.png">',
      "![remote](https://example.com/r.png)",
      "![data](data:image/png;base64,AAAA)",
    ].join("\n"));
    expect([...refs].sort()).toEqual([
      "assets/logo.svg",
      "img/a.png",
      "img/c.png",
      "img/my b.png",
      "img/x&y.png",
    ]);
  });

  test("images inside fenced code blocks and inline code spans are not references", () => {
    const refs = markdownImageRefs([
      "```md",
      "![fenced](img/fenced.png)",
      '<img src="img/fenced-html.png">',
      "```",
      "~~~~",
      "![tilde](img/tilde.png)",
      "```",
      "still inside the tilde fence ![t2](img/t2.png)",
      "~~~~",
      "Inline `![span](img/span.png)` and ``<img src=\"img/span2.png\">`` are code.",
      "![shown](img/shown.png)",
      "[logo]: assets/logo.png",
      "```",
      "![logo]",
      "```",
    ].join("\n"));
    expect([...refs]).toEqual(["img/shown.png"]);
    // An unclosed fence runs to the end of the text, as CommonMark has it.
    expect(markdownImageRefs("```\n![a](a.png)\n").size).toBe(0);
    // A stray backtick does not swallow the next paragraph's image.
    expect([...markdownImageRefs("A `stray backtick.\n\n![b](b.png) and ` another")]).toEqual(["b.png"]);
  });

  test("sources are compared with leading and trailing whitespace dropped, as a browser does", () => {
    expect([...markdownImageRefs('<img src=" img/a.png\t">')]).toEqual(["img/a.png"]);
  });

  test("a link definition alone is not an image reference", () => {
    expect(markdownImageRefs("[logo]: assets/logo.png\n[see it][logo]\n").size).toBe(0);
  });
});

describe("resolveMarkdownImagePath", () => {
  test("relative to the document's folder; `/` is the repository root; query and fragment dropped; %xx decoded", () => {
    expect(resolveMarkdownImagePath("docs/guide.md", "img/a.png")).toEqual({ kind: "ok", path: "docs/img/a.png" });
    expect(resolveMarkdownImagePath("docs/guide.md", "./img/../b.png?v=2#x")).toEqual({ kind: "ok", path: "docs/b.png" });
    expect(resolveMarkdownImagePath("docs/guide.md", "/assets/logo.png")).toEqual({ kind: "ok", path: "assets/logo.png" });
    expect(resolveMarkdownImagePath("docs/guide.md", "../top.png")).toEqual({ kind: "ok", path: "top.png" });
    expect(resolveMarkdownImagePath("README.md", "my%20shot.png")).toEqual({ kind: "ok", path: "my shot.png" });
  });

  test("refusals: climbing above the root, schemes, `//`, backslashes, control characters, non-images", () => {
    expect(resolveMarkdownImagePath("docs/guide.md", "../../up.png").kind).toBe("outside-repo");
    expect(resolveMarkdownImagePath("README.md", "/../x.png").kind).toBe("outside-repo");
    expect(resolveMarkdownImagePath("README.md", "https://e.com/x.png").kind).toBe("bad-request");
    expect(resolveMarkdownImagePath("README.md", "file:///etc/x.png").kind).toBe("bad-request");
    expect(resolveMarkdownImagePath("README.md", "C:/x.png").kind).toBe("bad-request");
    expect(resolveMarkdownImagePath("README.md", "//host/x.png").kind).toBe("bad-request");
    expect(resolveMarkdownImagePath("README.md", "img\\..\\..\\x.png").kind).toBe("bad-request");
    expect(resolveMarkdownImagePath("README.md", "img/%5C..%5Cx.png").kind).toBe("bad-request");
    expect(resolveMarkdownImagePath("README.md", "a\u0000.png").kind).toBe("bad-request");
    expect(resolveMarkdownImagePath("README.md", `${"a/".repeat(1100)}x.png`).kind).toBe("bad-request");
    expect(resolveMarkdownImagePath("README.md", "notes.txt").kind).toBe("not-image");
    expect(resolveMarkdownImagePath("README.md", "image.png.exe").kind).toBe("not-image");
  });
});

describe("handleReviewMarkdownImageRequest", () => {
  const STORE: Store = {
    "new:docs/guide.md": doc("![a](img/a.png)\n![r](/assets/r.png)\n![up](../../up.png)\n![t](notes.txt)\n![lfs](img/lfs.png)\n![zip](img/zip.png)\n![big](img/big.png)\n"),
    "old:docs/guide.md": doc("![a](img/a.png)\n"),
    "new:docs/img/a.png": png(4, 3),
    "old:docs/img/a.png": png(2, 2),
    "new:assets/r.png": png(1, 1),
    "new:docs/img/lfs.png": encoder.encode("version https://git-lfs.github.com/spec/v1\noid sha256:abc\n"),
    "new:docs/img/zip.png": new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
    "new:docs/img/big.png": { kind: "too-large", size: 11 * 1024 * 1024 },
    "old:docs/old.md": doc("![s](shot.png)\n"),
    "new:docs/moved/new.md": doc("![s](shot.png)\n"),
    "old:docs/shot.png": png(5, 5),
    "new:docs/moved/shot.png": png(6, 6),
    "old:gone.md": doc("![g](g.png)\n"),
    "old:g.png": png(7, 7),
    "new:notes.livemd": doc("![n](n.png)\n"),
    "new:n.png": png(8, 8),
  };

  test("serves the image at the requested side, relative to the document's folder at THAT side", async () => {
    const newSide = await answer({ doc: "docs/guide.md", side: "new", src: "img/a.png" }, STORE);
    expect(newSide.response.status).toBe(200);
    expect(newSide.response.headers["X-Image-Width"]).toBe("4");
    expect(newSide.response.headers["Content-Security-Policy"]).toContain("sandbox");
    expect(newSide.reads).toEqual(["new:docs/guide.md", "new:docs/img/a.png"]);

    const oldSide = await answer({ doc: "docs/guide.md", side: "old", src: "img/a.png" }, STORE);
    expect(oldSide.response.headers["X-Image-Width"]).toBe("2");

    // A renamed document: each side resolves against its own folder.
    const renamedNew = await answer({ doc: "docs/moved/new.md", side: "new", src: "shot.png" }, STORE);
    expect(renamedNew.response.headers["X-Image-Width"]).toBe("6");
    const renamedOld = await answer({ doc: "docs/moved/new.md", side: "old", src: "shot.png" }, STORE);
    expect(renamedOld.response.headers["X-Image-Width"]).toBe("5");
    expect(renamedOld.reads).toEqual(["old:docs/old.md", "old:docs/shot.png"]);

    // `/` is the root; a deleted document's old side; a config extension.
    expect((await answer({ doc: "docs/guide.md", side: "new", src: "/assets/r.png" }, STORE)).response.status).toBe(200);
    expect((await answer({ doc: "gone.md", side: "old", src: "g.png" }, STORE)).response.headers["X-Image-Width"]).toBe("7");
    expect((await answer({ doc: "notes.livemd", side: "new", src: "n.png" }, STORE)).response.status).toBe(200);
  });

  test("the source is matched as written, whitespace around it dropped on both sides", async () => {
    const spaced = await answer({ doc: "docs/guide.md", side: "new", src: " img/a.png " }, {
      ...STORE,
      "new:docs/guide.md": doc('<img src=" img/a.png">\n'),
    });
    expect(spaced.response.status).toBe(200);
    expect(spaced.reads).toEqual(["new:docs/guide.md", "new:docs/img/a.png"]);
  });

  test("an image shown only inside a code block is refused without reading it", async () => {
    const result = await answer({ doc: "docs/guide.md", side: "new", src: "img/a.png" }, {
      ...STORE,
      "new:docs/guide.md": doc("```\n![a](img/a.png)\n```\n"),
    });
    expect([result.response.status, result.reason]).toEqual([403, "not-referenced"]);
    expect(result.reads).toEqual(["new:docs/guide.md"]);
  });

  test("a matching If-None-Match is a bodyless 304", async () => {
    const { response } = await answer(
      { doc: "docs/guide.md", side: "new", src: "img/a.png" },
      STORE,
      { ifNoneMatch: '"new-docs/img/a.png"' },
    );
    expect(response.status).toBe(304);
    expect(response.body).toBeNull();
  });

  test("refusals before anything is read", async () => {
    const cases: Array<[Record<string, string>, Partial<ReviewMarkdownImageRequest> | undefined, number, string]> = [
      [{ doc: "docs/guide.md", side: "new", src: "img/a.png" }, { available: false }, 400, "unavailable"],
      [{ doc: "docs/guide.md", side: "sideways", src: "img/a.png" }, undefined, 400, "bad-request"],
      [{ doc: "docs/guide.md", side: "new" }, undefined, 400, "bad-request"],
      [{ doc: "docs/guide.md", side: "new", src: "img/a.png", snapshot: "s0" }, undefined, 409, "stale"],
      [{ doc: "docs/unknown.md", side: "new", src: "img/a.png" }, undefined, 404, "not-in-diff"],
      [{ doc: "src/app.ts", side: "new", src: "img/a.png" }, undefined, 404, "not-in-diff"],
      [{ doc: "gone.md", side: "new", src: "g.png" }, undefined, 404, "absent"],
      [{ doc: "docs/guide.md", side: "new", src: "../../up.png" }, undefined, 403, "outside-repo"],
      [{ doc: "docs/guide.md", side: "new", src: "notes.txt" }, undefined, 415, "not-image"],
      [{ doc: "docs/guide.md", side: "new", src: "https://example.com/a.png" }, undefined, 400, "bad-request"],
    ];
    for (const [query, overrides, status, reason] of cases) {
      const result = await answer(query, STORE, overrides);
      expect([query, result.response.status, result.reason]).toEqual([query, status, reason]);
      expect(result.reads).toEqual([]);
    }
  });

  test("an image the document does not show is refused without reading it", async () => {
    const result = await answer({ doc: "docs/guide.md", side: "new", src: "img/secret.png" }, {
      ...STORE,
      "new:docs/img/secret.png": png(9, 9),
    });
    expect(result.response.status).toBe(403);
    expect(result.reason).toBe("not-referenced");
    expect(result.reads).toEqual(["new:docs/guide.md"]);

    // The old document never showed /assets/r.png.
    expect((await answer({ doc: "docs/guide.md", side: "old", src: "/assets/r.png" }, STORE)).reason).toBe("not-referenced");
  });

  test("the image answer matches /api/review-image: size cap, LFS pointer, sniffed type", async () => {
    expect((await answer({ doc: "docs/guide.md", side: "new", src: "img/big.png" }, STORE)).reason).toBe("too-large");
    expect((await answer({ doc: "docs/guide.md", side: "new", src: "img/lfs.png" }, STORE)).reason).toBe("lfs-pointer");
    expect((await answer({ doc: "docs/guide.md", side: "new", src: "img/zip.png" }, STORE)).reason).toBe("not-image");
  });

  test("a document over the read cap is 413; a missing document is 404", async () => {
    const tooBig = await answer({ doc: "docs/guide.md", side: "new", src: "img/a.png" }, {
      ...STORE,
      "new:docs/guide.md": { kind: "too-large", size: 3 * 1024 * 1024 },
    });
    expect([tooBig.response.status, tooBig.reason]).toEqual([413, "too-large"]);
    const missing = await answer({ doc: "docs/guide.md", side: "new", src: "img/a.png" }, {
      ...STORE,
      "new:docs/guide.md": { kind: "missing" },
    });
    expect([missing.response.status, missing.reason]).toEqual([404, "missing"]);
  });
});
