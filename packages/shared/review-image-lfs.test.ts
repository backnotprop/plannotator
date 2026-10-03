/**
 * Git LFS images in the code-review image preview (#1665), pure half.
 *
 * Regressions guarded:
 *  - an ordinary text diff mistaken for an LFS pointer (and hidden behind a
 *    preview), or a real pointer chunk not recognized;
 *  - an old client / old server pairing breaking: without the advert or a
 *    resolver, a pointer chunk keeps answering exactly as before;
 *  - bytes that do not hash to the pointer's oid being shown as the image;
 *  - the 10 MB cap being applied only after a download;
 *  - two sides naming one object downloading it twice;
 *  - the platform download following a redirect off GitHub's hosts, or
 *    leaking its tokened URL into an error the browser sees.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  MAX_REVIEW_IMAGE_PREVIEW_BYTES,
  isImagePreviewCandidate,
  parseLfsPointerPatch,
  parseLfsPointerText,
} from "./diff-paths";
import { findPatchFileEntry, type ReviewGitRuntime } from "./review-core";
import {
  createLfsObjectCache,
  handleReviewImageRequest,
  readPRLfsSide,
} from "./review-image";
import { fetchGhPRLfsFileBytes, isAllowedGhLfsDownloadUrl } from "./pr-github";
import { fetchPRLfsFileBytes } from "./pr-provider";
import type { PRRuntime } from "./pr-types";

const enc = (text: string) => new TextEncoder().encode(text);
const sha = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

function png(seed: number): Uint8Array {
  const out = new Uint8Array(33 + 32);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(out.buffer);
  view.setUint32(16, 4);
  view.setUint32(20, 3);
  for (let i = 33; i < out.length; i++) out[i] = (i * 31 + seed) & 0xff;
  return out;
}

const IMG_OLD = png(1);
const IMG_NEW = png(2);
const pointerText = (data: Uint8Array, size = data.byteLength) =>
  `version https://git-lfs.github.com/spec/v1\noid sha256:${sha(data)}\nsize ${size}\n`;

function pointerChunk(path: string, before: string | null, after: string | null): string {
  const lines = (text: string | null) => (text ? text.replace(/\n$/, "").split("\n") : []);
  const oldLines = lines(before);
  const newLines = lines(after);
  const header = [`diff --git a/${path} b/${path}`];
  if (!before) header.push("new file mode 100644", "--- /dev/null", `+++ b/${path}`);
  else if (!after) header.push("deleted file mode 100644", `--- a/${path}`, "+++ /dev/null");
  else header.push(`--- a/${path}`, `+++ b/${path}`);
  const body: string[] = [];
  // Shared first line as context, the way git renders a pointer change.
  if (before && after) {
    body.push(` ${oldLines[0]}`, ...oldLines.slice(1).map((l) => `-${l}`), ...newLines.slice(1).map((l) => `+${l}`));
  } else {
    body.push(...oldLines.map((l) => `-${l}`), ...newLines.map((l) => `+${l}`));
  }
  const hunk = `@@ -${oldLines.length ? 1 : 0},${oldLines.length} +${newLines.length ? 1 : 0},${newLines.length} @@`;
  return [...header, hunk, ...body, ""].join("\n");
}

describe("LFS pointer recognition", () => {
  test("a modified, added and deleted pointer chunk parse to the pointers on each present side", () => {
    const modified = parseLfsPointerPatch(pointerChunk("a.png", pointerText(IMG_OLD), pointerText(IMG_NEW)));
    expect(modified).toEqual({
      old: { oid: sha(IMG_OLD), size: IMG_OLD.byteLength },
      new: { oid: sha(IMG_NEW), size: IMG_NEW.byteLength },
    });
    expect(parseLfsPointerPatch(pointerChunk("a.png", null, pointerText(IMG_NEW)))).toEqual({
      new: { oid: sha(IMG_NEW), size: IMG_NEW.byteLength },
    });
    expect(parseLfsPointerPatch(pointerChunk("a.png", pointerText(IMG_OLD), null))).toEqual({
      old: { oid: sha(IMG_OLD), size: IMG_OLD.byteLength },
    });
  });

  test("text that only looks like a pointer is not one", () => {
    // Docs quoting the version line, an extension pointer, a short oid.
    expect(parseLfsPointerText("version https://git-lfs.github.com/spec/v1\nhello\n")).toBeNull();
    expect(
      parseLfsPointerText(
        `version https://git-lfs.github.com/spec/v1\next-0-foo sha256:${"a".repeat(64)}\noid sha256:${"b".repeat(64)}\nsize 3\n`,
      ),
    ).toBeNull();
    expect(parseLfsPointerText("version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 3\n")).toBeNull();
    const svgEdit = [
      "diff --git a/logo.svg b/logo.svg",
      "--- a/logo.svg",
      "+++ b/logo.svg",
      "@@ -1,3 +1,3 @@",
      " version https://git-lfs.github.com/spec/v1",
      "-<svg/>",
      "+<svg></svg>",
      " size 3",
      "",
    ].join("\n");
    expect(parseLfsPointerPatch(svgEdit)).toBeNull();
  });

  test("the client only treats a pointer chunk as an image when the server advertised LFS support", () => {
    const chunk = pointerChunk("shots/a.png", pointerText(IMG_OLD), pointerText(IMG_NEW));
    expect(isImagePreviewCandidate(chunk, "shots/a.png")).toBe(false);
    expect(isImagePreviewCandidate(chunk, "shots/a.png", undefined, { lfs: true })).toBe(true);
    // A pointer for a non-image path never previews.
    const zip = pointerChunk("data.zip", pointerText(IMG_OLD), pointerText(IMG_NEW));
    expect(isImagePreviewCandidate(zip, "data.zip", undefined, { lfs: true })).toBe(false);
  });

  test("findPatchFileEntry carries the pointers for the matching chunk only", () => {
    const patch = pointerChunk("a.png", pointerText(IMG_OLD), pointerText(IMG_NEW)) +
      pointerChunk("b.png", null, pointerText(IMG_NEW));
    expect(findPatchFileEntry(patch, "a.png")?.lfs?.old?.oid).toBe(sha(IMG_OLD));
    expect(findPatchFileEntry(patch, "b.png")?.lfs).toEqual({ new: { oid: sha(IMG_NEW), size: IMG_NEW.byteLength } });
  });
});

describe("handleReviewImageRequest with LFS pointers", () => {
  const PATCH = pointerChunk("shot.png", pointerText(IMG_OLD), pointerText(IMG_NEW));
  const base = {
    available: true,
    patch: PATCH,
    isCurrentSnapshot: (s: string) => s === "snap",
    readSide: async () => {
      throw new Error("a pointer side is never read as a blob");
    },
  };
  const params = (side: string) => new URLSearchParams(`path=shot.png&side=${side}&snapshot=snap`);
  const reason = (body: unknown) => JSON.parse(String(body)).reason;

  test("without a resolver (an older server shape) the pointer chunk is not previewable", async () => {
    const response = await handleReviewImageRequest({ ...base, params: params("new") });
    expect(response.status).toBe(404);
    expect(reason(response.body)).toBe("not-in-diff");
  });

  test("verified bytes are served with a content-addressed etag", async () => {
    const response = await handleReviewImageRequest({
      ...base,
      params: params("old"),
      resolveLfs: async () => ({ kind: "ok", bytes: IMG_OLD }),
    });
    expect(response.status).toBe(200);
    expect(response.body).toEqual(IMG_OLD);
    expect(response.headers["Content-Type"]).toBe("image/png");
    expect(response.headers.ETag).toBe(`"lfs-${sha(IMG_OLD)}"`);
  });

  test("bytes that do not hash to the oid are an error and never served", async () => {
    const response = await handleReviewImageRequest({
      ...base,
      params: params("new"),
      // Right size, wrong content: only the hash can tell.
      resolveLfs: async () => ({ kind: "ok", bytes: IMG_OLD }),
    });
    expect(response.status).toBe(502);
    expect(reason(response.body)).toBe("lfs-mismatch");
  });

  test("the pointer's size enforces the cap before anything is resolved", async () => {
    const huge = { oid: "c".repeat(64), size: MAX_REVIEW_IMAGE_PREVIEW_BYTES + 1 };
    const patch = pointerChunk(
      "big.png",
      null,
      `version https://git-lfs.github.com/spec/v1\noid sha256:${huge.oid}\nsize ${huge.size}\n`,
    );
    let calls = 0;
    const response = await handleReviewImageRequest({
      ...base,
      patch,
      params: new URLSearchParams("path=big.png&side=new&snapshot=snap"),
      resolveLfs: async () => {
        calls++;
        return { kind: "missing" };
      },
    });
    expect(response.status).toBe(413);
    expect(JSON.parse(String(response.body)).bytes).toBe(huge.size);
    expect(calls).toBe(0);
  });

  test("nowhere to resolve from keeps the pre-#1665 answer", async () => {
    const response = await handleReviewImageRequest({
      ...base,
      params: params("new"),
      resolveLfs: async () => ({ kind: "missing" }),
    });
    expect(response.status).toBe(415);
    expect(reason(response.body)).toBe("lfs-pointer");
  });

  test("a renamed pointer whose oid is unchanged resolves the object once for both sides", async () => {
    // A pure rename is hunkless: each side reads as the pointer itself.
    const patch = [
      "diff --git a/old.png b/new.png",
      "similarity index 100%",
      "rename from old.png",
      "rename to new.png",
      "",
    ].join("\n");
    const lfsObjects = createLfsObjectCache();
    let resolves = 0;
    const request = (side: string) =>
      handleReviewImageRequest({
        ...base,
        patch,
        params: new URLSearchParams(`path=new.png&side=${side}&snapshot=snap`),
        readSide: async () => ({ kind: "ok", bytes: enc(pointerText(IMG_OLD)) }),
        resolveLfs: async () => {
          resolves++;
          await new Promise((r) => setTimeout(r, 5));
          return { kind: "ok", bytes: IMG_OLD };
        },
        lfsObjects,
      });
    const [before, after] = await Promise.all([request("old"), request("new")]);
    expect(before.status).toBe(200);
    expect(after.body).toEqual(before.body);
    expect(resolves).toBe(1);
    // A later request is served from the verified cache, still with no download.
    expect((await request("new")).status).toBe(200);
    expect(resolves).toBe(1);
  });

  test("a side that misses while another side resolves the same oid concurrently still resolves its own", async () => {
    // Regression: the in-flight share handed the old side's path-dependent
    // `missing` to the new side, which then answered `lfs-pointer`.
    const patch = [
      "diff --git a/old.png b/new.png",
      "similarity index 100%",
      "rename from old.png",
      "rename to new.png",
      "",
    ].join("\n");
    const lfsObjects = createLfsObjectCache();
    const request = (side: string) =>
      handleReviewImageRequest({
        ...base,
        patch,
        params: new URLSearchParams(`path=new.png&side=${side}&snapshot=snap`),
        readSide: async () => ({ kind: "ok", bytes: enc(pointerText(IMG_OLD)) }),
        resolveLfs: async (resolveSide) => {
          await new Promise((r) => setTimeout(r, 5));
          return resolveSide === "old" ? { kind: "missing" } : { kind: "ok", bytes: IMG_OLD };
        },
        lfsObjects,
      });
    const [before, after] = await Promise.all([request("old"), request("new")]);
    expect(before.status).toBe(415);
    expect(after.status).toBe(200);
  });
});

describe("readPRLfsSide (checkout first, platform only for a side neither has)", () => {
  const noGit: ReviewGitRuntime = {
    runGit: async () => ({ stdout: "", stderr: "fatal", exitCode: 128 }),
    readTextFile: async () => null,
    getFileInfo: async () => null,
    readLink: async () => null,
    readFileBytes: async () => null,
    realPath: async () => null,
  };

  test("a side the checkout does not hold is fetched at the merge-base sha and the old path", async () => {
    const calls: string[] = [];
    const result = await readPRLfsSide({
      gitRuntime: noGit,
      poolCwd: "/pool/pr-1",
      oldSha: "base111",
      headSha: "head222",
      side: "old",
      filePath: "new.png",
      oldPath: "old.png",
      pointer: { oid: sha(IMG_OLD), size: IMG_OLD.byteLength },
      maxBytes: MAX_REVIEW_IMAGE_PREVIEW_BYTES,
      fetchLfs: async (s, path) => {
        calls.push(`${s}:${path}`);
        return { kind: "ok", bytes: IMG_OLD };
      },
    });
    expect(result.kind).toBe("ok");
    expect(calls).toEqual(["base111:old.png"]);
  });

  test("GitLab and Bitbucket have no LFS route", async () => {
    const runtime: PRRuntime = { runCommand: async () => ({ stdout: "", stderr: "", exitCode: 1 }) };
    const gl = { platform: "gitlab" as const, host: "gitlab.com", projectPath: "g/p", iid: 1 };
    const bb = { platform: "bitbucket" as const, host: "bitbucket.org", workspace: "w", repo: "r", number: 1 };
    expect(await fetchPRLfsFileBytes(runtime, gl, "sha", "a.png", 100)).toBeNull();
    expect(await fetchPRLfsFileBytes(runtime, bb, "sha", "a.png", 100)).toBeNull();
  });
});

describe("GitHub LFS download (fake gh + fake fetch, no network)", () => {
  const ref = { platform: "github" as const, host: "github.com", owner: "o", repo: "r", number: 1 };
  const SIGNED = "https://media.githubusercontent.com/media/o/r/base/shot.png?token=SECRET123";

  function runtime(meta: object, fetchImpl: typeof fetch): PRRuntime & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      fetch: fetchImpl,
      async runCommand(_cmd, args) {
        calls.push(args[1]);
        return { stdout: JSON.stringify(meta), stderr: "", exitCode: 0 };
      },
    };
  }

  test("downloads the real bytes from the contents API download_url", async () => {
    const fetched: string[] = [];
    const rt = runtime({ type: "file", size: IMG_NEW.byteLength, download_url: SIGNED }, (async (url: URL) => {
      fetched.push(String(url));
      return new Response(IMG_NEW, { status: 200 });
    }) as unknown as typeof fetch);
    const result = await fetchGhPRLfsFileBytes(rt, ref, "head", "shot.png", MAX_REVIEW_IMAGE_PREVIEW_BYTES);
    expect(result).toEqual({ kind: "ok", bytes: IMG_NEW });
    expect(rt.calls[0]).toContain("repos/o/r/contents/shot.png?ref=head");
    expect(fetched).toEqual([SIGNED]);
  });

  test("a size over the cap never downloads", async () => {
    let fetches = 0;
    const rt = runtime({ type: "file", size: MAX_REVIEW_IMAGE_PREVIEW_BYTES + 1, download_url: SIGNED }, (async () => {
      fetches++;
      return new Response(IMG_NEW);
    }) as unknown as typeof fetch);
    const result = await fetchGhPRLfsFileBytes(rt, ref, "head", "shot.png", MAX_REVIEW_IMAGE_PREVIEW_BYTES);
    expect(result.kind).toBe("too-large");
    expect(fetches).toBe(0);
  });

  test("a body longer than the cap is cut off as too-large", async () => {
    const rt = runtime({ type: "file", download_url: SIGNED }, (async () =>
      new Response(new Uint8Array(64))) as unknown as typeof fetch);
    expect((await fetchGhPRLfsFileBytes(rt, ref, "head", "shot.png", 32)).kind).toBe("too-large");
  });

  test("redirects are followed only within GitHub's hosts, and errors never carry the tokened URL", async () => {
    const hops: string[] = [];
    const follow = runtime({ type: "file", download_url: SIGNED }, (async (url: URL) => {
      hops.push(url.hostname);
      if (url.hostname === "media.githubusercontent.com") {
        return new Response(null, { status: 302, headers: { location: "https://objects.githubusercontent.com/x?sig=1" } });
      }
      return new Response(IMG_NEW);
    }) as unknown as typeof fetch);
    expect((await fetchGhPRLfsFileBytes(follow, ref, "head", "shot.png", 1024)).kind).toBe("ok");
    expect(hops).toEqual(["media.githubusercontent.com", "objects.githubusercontent.com"]);

    const offHost = runtime({ type: "file", download_url: SIGNED }, (async () =>
      new Response(null, { status: 302, headers: { location: "https://evil.example/steal" } })) as unknown as typeof fetch);
    const error = await fetchGhPRLfsFileBytes(offHost, ref, "head", "shot.png", 1024).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("SECRET123");
    expect((error as Error).message).not.toContain("evil.example");

    const failed = runtime({ type: "file", download_url: SIGNED }, (async () =>
      new Response("denied", { status: 403 })) as unknown as typeof fetch);
    const failure = await fetchGhPRLfsFileBytes(failed, ref, "head", "shot.png", 1024).catch((e: Error) => e);
    expect((failure as Error).message).not.toContain("SECRET123");
  });

  test("a download_url on an unexpected host is refused before any request", async () => {
    let fetches = 0;
    const rt = runtime({ type: "file", download_url: "https://example.com/shot.png" }, (async () => {
      fetches++;
      return new Response(IMG_NEW);
    }) as unknown as typeof fetch);
    await expect(fetchGhPRLfsFileBytes(rt, ref, "head", "shot.png", 1024)).rejects.toThrow();
    expect(fetches).toBe(0);
  });

  test("allowed hosts: githubusercontent.com subdomains on github.com, the instance's own host on Enterprise", () => {
    expect(isAllowedGhLfsDownloadUrl(new URL("https://media.githubusercontent.com/x"), "github.com")).toBe(true);
    expect(isAllowedGhLfsDownloadUrl(new URL("http://media.githubusercontent.com/x"), "github.com")).toBe(false);
    expect(isAllowedGhLfsDownloadUrl(new URL("https://githubusercontent.com.evil.example/x"), "github.com")).toBe(false);
    expect(isAllowedGhLfsDownloadUrl(new URL("https://media.ghe.corp/x"), "ghe.corp")).toBe(true);
    expect(isAllowedGhLfsDownloadUrl(new URL("https://ghe.corp.evil/x"), "ghe.corp")).toBe(false);
  });
});
