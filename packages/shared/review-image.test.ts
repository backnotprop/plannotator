/**
 * Code-review image preview (#1598), pure half: the decisions the Bun server
 * and the Pi mirror share. Each block names the regression it guards.
 */
import { describe, expect, test } from "bun:test";
import {
  type DiffType,
  type GitCommandOptions,
  type ReviewGitRuntime,
  findPatchFileEntry,
  resolveDiffSideSources,
  validateFilePath,
} from "./review-core";
import {
  ReviewImageAbortError,
  createConcurrencyLimiter,
  handleReviewImageRequest,
  readImageDimensions,
  readPRImageSide,
  sniffImageContentType,
} from "./review-image";
import { isImagePreviewCandidate, MAX_REVIEW_IMAGE_PREVIEW_BYTES } from "./diff-paths";
import { fetchGhPRFileBytes } from "./pr-github";
import { fetchGlFileBytes } from "./pr-gitlab";
import type { PRRuntime } from "./pr-types";
import { getJjFileBytesForDiff, type ReviewJjRuntime } from "./jj-core";

const enc = (text: string) => new TextEncoder().encode(text);
const bytes = (...values: number[]) => new Uint8Array(values);
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
};
const u32be = (n: number) => bytes((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);

function pngHeader(width: number, height: number): Uint8Array {
  return concat(
    bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    u32be(13),
    enc("IHDR"),
    u32be(width),
    u32be(height),
    bytes(8, 6, 0, 0, 0),
  );
}

describe("sniffImageContentType (content type comes from bytes, never the name)", () => {
  test("recognizes every served raster format by its signature", () => {
    expect(sniffImageContentType(pngHeader(1, 1))).toBe("image/png");
    expect(sniffImageContentType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
    expect(sniffImageContentType(enc("GIF89a\x01\x00\x01\x00"))).toBe("image/gif");
    expect(sniffImageContentType(enc("RIFF\x00\x00\x00\x00WEBPVP8X"))).toBe("image/webp");
    expect(sniffImageContentType(concat(u32be(24), enc("ftypavif"), u32be(0), enc("mif1")))).toBe("image/avif");
    // A mif1-major AVIF names avif only among its compatible brands.
    expect(sniffImageContentType(concat(u32be(24), enc("ftypmif1"), u32be(0), enc("avif")))).toBe("image/avif");
    expect(sniffImageContentType(concat(enc("BM"), new Uint8Array(30)))).toBe("image/bmp");
    expect(sniffImageContentType(concat(bytes(0, 0, 1, 0, 1, 0), new Uint8Array(20)))).toBe("image/x-icon");
  });

  test("SVG is recognized after a BOM, XML declaration, comment and doctype", () => {
    const svg = '﻿<?xml version="1.0"?>\n<!-- exported -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x">\n<svg xmlns="http://www.w3.org/2000/svg"/>';
    expect(sniffImageContentType(enc(svg))).toBe("image/svg+xml");
  });

  test("HTML, a zip named .png, an LFS pointer and an empty file are not images", () => {
    // Serving HTML as image/svg+xml (or at all) from the session origin is the
    // risk the sniffer exists for.
    expect(sniffImageContentType(enc("<!DOCTYPE html><html><svg></svg></html>"))).toBeNull();
    expect(sniffImageContentType(enc("<html><body><svg/></body></html>"))).toBeNull();
    expect(sniffImageContentType(bytes(0x50, 0x4b, 0x03, 0x04, 0, 0))).toBeNull();
    expect(sniffImageContentType(enc("version https://git-lfs.github.com/spec/v1\noid sha256:ab\nsize 12\n"))).toBeNull();
    expect(sniffImageContentType(new Uint8Array(0))).toBeNull();
  });
});

describe("readImageDimensions (the decode-bomb guard reads real header fields)", () => {
  test("parses width and height per format", () => {
    expect(readImageDimensions(pngHeader(640, 480), "image/png")).toEqual({ width: 640, height: 480 });
    expect(readImageDimensions(concat(enc("GIF89a"), bytes(0x80, 0x02, 0xe0, 0x01)), "image/gif")).toEqual({ width: 640, height: 480 });
    // JPEG: SOI, an APP0 segment to skip, then SOF0 (height before width).
    const jpeg = concat(
      bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00),
      bytes(0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03),
    );
    expect(readImageDimensions(jpeg, "image/jpeg")).toEqual({ width: 640, height: 480 });
    // WebP VP8X: canvas size minus one, 24-bit little endian.
    const vp8x = concat(enc("RIFF\x00\x00\x00\x00WEBPVP8X"), new Uint8Array(8), bytes(0x7f, 0x02, 0x00, 0xdf, 0x01, 0x00));
    expect(readImageDimensions(vp8x, "image/webp")).toEqual({ width: 640, height: 480 });
    // WebP VP8L: 14-bit fields packed after the 0x2f signature byte.
    const w = 639;
    const h = 479;
    const bits = w | (h << 14);
    const vp8l = concat(enc("RIFF\x00\x00\x00\x00WEBPVP8L"), new Uint8Array(4), bytes(0x2f, bits & 255, (bits >> 8) & 255, (bits >> 16) & 255, (bits >> 24) & 255));
    expect(readImageDimensions(vp8l, "image/webp")).toEqual({ width: 640, height: 480 });
    // BMP (BITMAPINFOHEADER): a negative height means top-down rows.
    const bmp = new Uint8Array(30);
    bmp.set(enc("BM"), 0);
    new DataView(bmp.buffer).setInt32(14, 40, true);
    new DataView(bmp.buffer).setInt32(18, 640, true);
    new DataView(bmp.buffer).setInt32(22, -480, true);
    expect(readImageDimensions(bmp, "image/bmp")).toEqual({ width: 640, height: 480 });
    // ICO: a zero byte means 256.
    expect(readImageDimensions(concat(bytes(0, 0, 1, 0, 1, 0, 0, 16), new Uint8Array(14)), "image/x-icon")).toEqual({ width: 256, height: 16 });
  });

  test("a truncated header yields no dimensions rather than garbage", () => {
    expect(readImageDimensions(pngHeader(640, 480).subarray(0, 18), "image/png")).toBeNull();
    expect(readImageDimensions(bytes(0xff, 0xd8, 0xff, 0xe0, 0x00), "image/jpeg")).toBeNull();
    expect(readImageDimensions(enc("GIF89a"), "image/gif")).toBeNull();
  });
});

describe("findPatchFileEntry (only files that are really in the patch are servable)", () => {
  const PATCH = [
    "diff --git a/img/old.png b/img/new.png",
    "similarity index 90%",
    "rename from img/old.png",
    "rename to img/new.png",
    "index 111..222 100644",
    "Binary files a/img/old.png and b/img/new.png differ",
    "diff --git a/added.png b/added.png",
    "new file mode 100644",
    "index 000..333",
    "Binary files /dev/null and b/added.png differ",
    "diff --git a/gone.png b/gone.png",
    "deleted file mode 100644",
    "index 444..000",
    "Binary files a/gone.png and /dev/null differ",
    "diff --git a/notes.md b/notes.md",
    "--- a/notes.md",
    "+++ b/notes.md",
    "@@ -1 +1 @@",
    "-diff --git a/secret.png b/secret.png",
    "+Binary files a/secret.png and b/secret.png differ",
    "",
  ].join("\n");

  test("a rename takes its old path from the chunk", () => {
    expect(findPatchFileEntry(PATCH, "img/new.png")).toMatchObject({
      oldPath: "img/old.png",
      newPath: "img/new.png",
      status: "renamed",
      hasHunks: false,
      isBinary: true,
    });
  });

  test("added and deleted binaries carry only the side that exists", () => {
    const added = findPatchFileEntry(PATCH, "added.png");
    expect(added?.status).toBe("added");
    expect(added?.oldPath).toBeUndefined();
    const deleted = findPatchFileEntry(PATCH, "gone.png");
    expect(deleted?.status).toBe("deleted");
    expect(deleted?.newPath).toBeUndefined();
    expect(deleted?.oldPath).toBe("gone.png");
  });

  test("a path that only appears inside hunk content, or nowhere, is not matched", () => {
    expect(findPatchFileEntry(PATCH, "secret.png")).toBeNull();
    expect(findPatchFileEntry(PATCH, "img/old.png")).toBeNull();
    expect(findPatchFileEntry(PATCH, "elsewhere.png")).toBeNull();
    expect(findPatchFileEntry(PATCH, "notes.md")?.hasHunks).toBe(true);
  });
});

describe("isImagePreviewCandidate (client eligibility)", () => {
  test("hunkless image chunks qualify, including a marker-less header-only PR fallback chunk", () => {
    expect(isImagePreviewCandidate("diff --git a/a.PNG b/a.PNG\nBinary files a/a.PNG and b/a.PNG differ\n", "a.PNG")).toBe(true);
    expect(isImagePreviewCandidate("diff --git a/a.webp b/a.webp\n", "a.webp")).toBe(true);
    // A rename of a deleted-extension file still previews through its old path.
    expect(isImagePreviewCandidate("diff --git a/a.png b/a.bin\n", "a.bin", "a.png")).toBe(true);
  });

  test("text diffs, non-image binaries and excluded formats do not", () => {
    expect(isImagePreviewCandidate("diff --git a/a.svg b/a.svg\n@@ -1 +1 @@\n-a\n+b\n", "a.svg")).toBe(false);
    expect(isImagePreviewCandidate("diff --git a/a.zip b/a.zip\nBinary files a/a.zip and b/a.zip differ\n", "a.zip")).toBe(false);
    expect(isImagePreviewCandidate("diff --git a/a.tiff b/a.tiff\nBinary files differ\n", "a.tiff")).toBe(false);
  });
});

describe("resolveDiffSideSources (bytes and text read the same refs)", () => {
  const runtime: ReviewGitRuntime = {
    async runGit(args: string[], _options?: GitCommandOptions) {
      if (args[0] === "merge-base") return { stdout: "mb000\n", stderr: "", exitCode: 0 };
      if (args.includes("@{upstream}")) return { stdout: "origin/feature\n", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 1 };
    },
    readTextFile: async () => null,
    getFileInfo: async () => null,
    readLink: async () => null,
  };
  const table: Array<[string, unknown, unknown]> = [
    ["uncommitted", { kind: "object", rev: "HEAD", path: "old.png" }, { kind: "worktree", path: "new.png" }],
    ["staged", { kind: "object", rev: "HEAD", path: "old.png" }, { kind: "object", rev: ":0", path: "new.png" }],
    ["unstaged", { kind: "object", rev: ":0", path: "old.png" }, { kind: "worktree", path: "new.png" }],
    ["since-base", { kind: "object", rev: "mb000", path: "old.png" }, { kind: "worktree", path: "new.png" }],
    ["local-vs-remote", { kind: "object", rev: "origin/feature", path: "old.png" }, { kind: "worktree", path: "new.png" }],
    ["branch", { kind: "object", rev: "main", path: "old.png" }, { kind: "object", rev: "HEAD", path: "new.png" }],
    ["merge-base", { kind: "object", rev: "mb000", path: "old.png" }, { kind: "object", rev: "HEAD", path: "new.png" }],
    ["last-commit", { kind: "object", rev: "HEAD~1", path: "old.png" }, { kind: "object", rev: "HEAD", path: "new.png" }],
    ["commit:abc123", { kind: "object", rev: "abc123^", path: "old.png" }, { kind: "object", rev: "abc123", path: "new.png" }],
    ["all", null, { kind: "object", rev: "HEAD", path: "new.png" }],
  ];
  for (const [diffType, old, next] of table) {
    test(diffType, async () => {
      const sources = await resolveDiffSideSources(runtime, diffType as DiffType, "main", "new.png", "old.png", "/repo");
      expect(sources).toEqual({ cwd: "/repo", old, new: next });
    });
  }

  test("worktree:<path>:<sub> resolves the sub-type inside that worktree", async () => {
    const sources = await resolveDiffSideSources(runtime, "worktree:/wt/one:staged" as DiffType, "main", "a.png", undefined, "/repo");
    expect(sources).toEqual({
      cwd: "/wt/one",
      old: { kind: "object", rev: "HEAD", path: "a.png" },
      new: { kind: "object", rev: ":0", path: "a.png" },
    });
  });
});

describe("handleReviewImageRequest (request rules)", () => {
  const PATCH = [
    "diff --git a/a.png b/a.png",
    "new file mode 100644",
    "Binary files /dev/null and b/a.png differ",
    "diff --git a/b.ts b/b.ts",
    "--- a/b.ts",
    "+++ b/b.ts",
    "@@ -1 +1 @@",
    "-x",
    "+y",
    "",
  ].join("\n");
  const base = {
    available: true,
    patch: PATCH,
    isCurrentSnapshot: (s: string) => s === "snap",
  };
  const params = (q: string) => new URLSearchParams(q);

  test("never reads a side for an unavailable session, a stale snapshot, or a file outside the patch", async () => {
    let reads = 0;
    const readSide = async () => {
      reads++;
      return { kind: "ok" as const, bytes: pngHeader(1, 1) };
    };
    const cases: Array<[Parameters<typeof handleReviewImageRequest>[0], number, string]> = [
      [{ ...base, available: false, params: params("path=a.png&side=new&snapshot=snap"), readSide }, 400, "unavailable"],
      [{ ...base, params: params("path=a.png&side=new&snapshot=old"), readSide }, 409, "stale"],
      [{ ...base, params: params("path=b.ts&side=new&snapshot=snap"), readSide }, 404, "not-in-diff"],
      [{ ...base, params: params("path=../a.png&side=new&snapshot=snap"), readSide }, 404, "not-in-diff"],
      [{ ...base, params: params("path=a.png&side=old&snapshot=snap"), readSide }, 404, "absent"],
      [{ ...base, params: params("path=a.png&side=both&snapshot=snap"), readSide }, 400, "bad-request"],
    ];
    for (const [request, status, reason] of cases) {
      const response = await handleReviewImageRequest(request);
      expect(response.status).toBe(status);
      expect(JSON.parse(String(response.body)).reason).toBe(reason);
    }
    expect(reads).toBe(0);
  });

  test("a platform failure maps to 502, an LFS pointer and a decode bomb are refused", async () => {
    const request = { ...base, params: params("path=a.png&side=new&snapshot=snap") };
    const failed = await handleReviewImageRequest({ ...request, readSide: async () => { throw new Error("gh: HTTP 500"); } });
    expect(failed.status).toBe(502);
    const lfs = await handleReviewImageRequest({
      ...request,
      readSide: async () => ({ kind: "ok", bytes: enc("version https://git-lfs.github.com/spec/v1\n") }),
    });
    expect(lfs.status).toBe(415);
    expect(JSON.parse(String(lfs.body)).reason).toBe("lfs-pointer");
    const bomb = await handleReviewImageRequest({
      ...request,
      readSide: async () => ({ kind: "ok", bytes: pngHeader(20_000, 20_000) }),
    });
    expect(bomb.status).toBe(413);
    expect(JSON.parse(String(bomb.body))).toMatchObject({ width: 20_000, height: 20_000 });
  });
});

describe("readPRImageSide (checkout first, platform API second)", () => {
  const noGit: ReviewGitRuntime = {
    runGit: async () => ({ stdout: "", stderr: "fatal", exitCode: 128 }),
    runGitBytes: async () => ({ stdout: new Uint8Array(0), stderr: "", exitCode: 128 }),
    readTextFile: async () => null,
    getFileInfo: async () => null,
    readLink: async () => null,
  };

  test("an object missing from a shallow checkout falls back to the API at the same sha", async () => {
    const calls: string[] = [];
    const result = await readPRImageSide({
      gitRuntime: noGit,
      poolCwd: "/pool/pr-1",
      oldSha: "base111",
      headSha: "head222",
      side: "old",
      filePath: "new.png",
      oldPath: "old.png",
      maxBytes: 100,
      fetchBytes: async (sha, path) => {
        calls.push(`${sha}:${path}`);
        return { kind: "ok", bytes: pngHeader(1, 1) };
      },
    });
    expect(result.kind).toBe("ok");
    expect(calls).toEqual(["base111:old.png"]);
  });
});

describe("PR platform byte fetchers", () => {
  const ghRef = { platform: "github" as const, host: "github.com", owner: "o", repo: "r", number: 1 };
  const glRef = { platform: "gitlab" as const, host: "gitlab.com", projectPath: "g/p", iid: 1 };
  const b64 = (data: Uint8Array) => btoa(String.fromCharCode(...data));

  function fakeRuntime(responses: Record<string, string>): PRRuntime & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      async runCommand(_cmd, args) {
        const endpoint = args[1];
        calls.push(endpoint);
        const key = Object.keys(responses).find((k) => endpoint.includes(k));
        return key
          ? { stdout: responses[key], stderr: "", exitCode: 0 }
          : { stdout: "", stderr: "gh: Not Found (HTTP 404)", exitCode: 1 };
      },
    };
  }

  test("GitHub: files over 1 MB (encoding none) come from the blobs API", async () => {
    const data = pngHeader(2, 2);
    const runtime = fakeRuntime({
      "/contents/": JSON.stringify({ type: "file", sha: "a".repeat(40), size: 2_000_000, encoding: "none", content: "" }),
      "/git/blobs/": JSON.stringify({ size: 2_000_000, encoding: "base64", content: b64(data) }),
    });
    const result = await fetchGhPRFileBytes(runtime, ghRef, "head", "img/a.png", MAX_REVIEW_IMAGE_PREVIEW_BYTES);
    expect(result).toMatchObject({ kind: "ok", bytes: data });
    expect(runtime.calls.some((c) => c.includes("/git/blobs/"))).toBe(true);
  });

  test("GitHub: a size over the cap never makes the second call", async () => {
    const runtime = fakeRuntime({
      "/contents/": JSON.stringify({ type: "file", sha: "a".repeat(40), size: 50_000_000, encoding: "none", content: "" }),
    });
    const result = await fetchGhPRFileBytes(runtime, ghRef, "head", "a.png", MAX_REVIEW_IMAGE_PREVIEW_BYTES);
    expect(result).toEqual({ kind: "too-large", size: 50_000_000 });
    expect(runtime.calls).toHaveLength(1);
  });

  test("GitHub: a 404 is missing, not a transport failure", async () => {
    const result = await fetchGhPRFileBytes(fakeRuntime({}), ghRef, "head", "a.png", 100);
    expect(result).toEqual({ kind: "missing" });
  });

  test("GitLab: the JSON files API decodes base64 bytes intact", async () => {
    // 0xff / 0x80 bytes are exactly what a UTF-8 decode of /raw would corrupt.
    const data = concat(pngHeader(1, 1), bytes(0xff, 0x80, 0x00));
    const runtime = fakeRuntime({
      "/repository/files/": JSON.stringify({ size: data.byteLength, encoding: "base64", content: b64(data), blob_id: "b1" }),
    });
    const result = await fetchGlFileBytes(runtime, glRef, "head", "a.png", 1000);
    expect(result).toMatchObject({ kind: "ok", bytes: data });
    expect(runtime.calls[0]).not.toContain("/raw");
  });
});

describe("getJjFileBytesForDiff (jj-current through runJjBytes)", () => {
  test("reads @- at the old path and @ at the new path, bytes intact; over the cap is too-large", async () => {
    const data = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0x80, 0x00]);
    const calls: string[][] = [];
    const runtime: ReviewJjRuntime = {
      async runJj(args) {
        return args[0] === "workspace"
          ? { stdout: "/repo\n", stderr: "", exitCode: 0 }
          : { stdout: "", stderr: "", exitCode: 1 };
      },
      async runJjBytes(args, options) {
        calls.push(args);
        if ((options?.maxOutputBytes ?? Infinity) < data.byteLength) {
          return { stdout: new Uint8Array(0), stderr: "", exitCode: 137, truncated: true };
        }
        return { stdout: data, stderr: "", exitCode: 0 };
      },
    };
    const old = await getJjFileBytesForDiff(runtime, "jj-current", "", "new.png", "old.png", "old", 100, "/repo");
    expect(old).toEqual({ kind: "ok", bytes: data });
    expect(calls[0]).toEqual(["file", "show", "-r", "@-", "--", "old.png"]);
    await getJjFileBytesForDiff(runtime, "jj-current", "", "new.png", "old.png", "new", 100, "/repo");
    expect(calls[1]).toEqual(["file", "show", "-r", "@", "--", "new.png"]);
    const big = await getJjFileBytesForDiff(runtime, "jj-current", "", "new.png", undefined, "new", 3, "/repo");
    expect(big.kind).toBe("too-large");
  });
});

describe("request aborts (scrolling past cards must not hold the read slots)", () => {
  test("a queued read whose request aborted never runs, and its slot goes to the next read", async () => {
    const run = createConcurrencyLimiter(1);
    let releaseFirst!: () => void;
    const started: string[] = [];
    const first = run(() => {
      started.push("first");
      return new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
    });
    const gone = new AbortController();
    const abandoned = run(async () => {
      started.push("abandoned");
    }, gone.signal);
    const visible = run(async () => {
      started.push("visible");
    });
    gone.abort();
    await expect(abandoned).rejects.toBeInstanceOf(ReviewImageAbortError);
    releaseFirst();
    await first;
    await visible;
    expect(started).toEqual(["first", "visible"]);
  });

  test("an already-aborted request is refused without queueing", async () => {
    const run = createConcurrencyLimiter(4);
    const controller = new AbortController();
    controller.abort();
    let ran = false;
    await expect(run(async () => { ran = true; }, controller.signal)).rejects.toBeInstanceOf(ReviewImageAbortError);
    expect(ran).toBe(false);
  });

  test("no platform API call is made for a request that went away", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    await expect(readPRImageSide({
      gitRuntime: {
        runGit: async () => ({ stdout: "", stderr: "", exitCode: 128 }),
        readTextFile: async () => null,
        getFileInfo: async () => null,
        readLink: async () => null,
      },
      oldSha: "a",
      headSha: "b",
      side: "new",
      filePath: "x.png",
      maxBytes: 10,
      signal: controller.signal,
      fetchBytes: async () => {
        calls++;
        return { kind: "missing" };
      },
    })).rejects.toBeInstanceOf(ReviewImageAbortError);
    expect(calls).toBe(0);
  });

  test("the handler answers an aborted read as aborted, not as a platform failure", async () => {
    const controller = new AbortController();
    controller.abort();
    const response = await handleReviewImageRequest({
      available: true,
      patch: "diff --git a/a.png b/a.png\nBinary files a/a.png and b/a.png differ\n",
      isCurrentSnapshot: () => true,
      params: new URLSearchParams("path=a.png&side=new&snapshot=s"),
      signal: controller.signal,
      readSide: async () => {
        throw new ReviewImageAbortError();
      },
    });
    expect(response.status).toBe(499);
  });
});

describe("validateFilePath (shared with /api/file-content)", () => {
  test("a `..` inside a file name is an ordinary name", () => {
    expect(() => validateFilePath("assets/logo..v2.png")).not.toThrow();
    expect(() => validateFilePath("a..b/c...d.png")).not.toThrow();
  });

  test("traversal and absolute paths are still refused", () => {
    for (const path of ["../x.png", "a/../../x.png", "a/..", "..", "a\\..\\x.png", "/etc/passwd", "C:/x.png", "\\\\server\\x.png"]) {
      expect(() => validateFilePath(path)).toThrow();
    }
  });

  test("dot-only segments are refused: `...` is Perforce's recursive wildcard (p4 print would dump the subtree)", () => {
    for (const path of ["...", "dir/...", "....", "dir/.../x.png", "dir\\...", "./x.png"]) {
      expect(() => validateFilePath(path)).toThrow();
    }
  });
});

describe("isNotFoundCommandFailure", () => {
  test("only an HTTP 404 means the file is missing; a missing CLI is a transport failure", async () => {
    const ghRef = { platform: "github" as const, host: "github.com", owner: "o", repo: "r", number: 1 };
    const runtime: PRRuntime = {
      runCommand: async () => ({ stdout: "", stderr: "zsh: command not found: gh", exitCode: 127 }),
    };
    await expect(fetchGhPRFileBytes(runtime, ghRef, "sha", "a.png", 10)).rejects.toThrow();
  });
});

describe("createConcurrencyLimiter", () => {
  test("never runs more than the limit at once", async () => {
    const run = createConcurrencyLimiter(4);
    let active = 0;
    let peak = 0;
    await Promise.all(Array.from({ length: 12 }, () => run(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
    })));
    expect(peak).toBe(4);
  });
});
