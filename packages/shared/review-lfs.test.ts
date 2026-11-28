import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { isImagePreviewCandidate, parseLfsPointer, parseLfsPointerDiff, MAX_REVIEW_IMAGE_PREVIEW_BYTES } from "./diff-paths";
import { findPatchFileEntry, type ReviewGitRuntime } from "./review-core";
import { handleReviewImageRequest } from "./review-image";
import { createLocalLfsImageReader, ReviewLfsMismatchError } from "./review-lfs";

const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "plannotator-lfs-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const body = new TextEncoder().encode("a locally cached image");
const pointer = (bytes = body) => ({ oid: createHash("sha256").update(bytes).digest("hex"), size: bytes.length });
const text = (p = pointer()) => `version https://git-lfs.github.com/spec/v1\noid sha256:${p.oid}\nsize ${p.size}\n`;
const git = (cwd: string, args: string[]) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", exitCode: result.status ?? 1 };
};
const runtime: ReviewGitRuntime = { runGit: async (args, options) => git(options!.cwd!, args), readTextFile: async () => null, getFileInfo: async () => null, readLink: async () => null };
function fixture(storage = "lfs") {
  const cwd = temp();
  if (git(cwd, ["init", "-q"]).exitCode) throw new Error("git init failed");
  if (storage !== "lfs") git(cwd, ["config", "lfs.storage", storage]);
  const p = pointer();
  const object = join(resolve(cwd, ".git", storage), "objects", p.oid.slice(0, 2), p.oid.slice(2, 4), p.oid);
  const cache = (bytes = body) => { mkdirSync(dirname(object), { recursive: true }); writeFileSync(object, bytes); };
  const reader = createLocalLfsImageReader(runtime);
  const read = (extra: Partial<Parameters<typeof reader>[0]> = {}) => reader({ cwd, pointer: p, ...extra });
  return { cwd, object, cache, read };
}

function patch(old: string | null, next: string | null, rename = false) {
  const lines = ["diff --git a/old.png b/new.png", ...(rename ? ["rename from old.png", "rename to new.png"] : []), `--- ${old === null ? "/dev/null" : "a/old.png"}`, `+++ ${next === null ? "/dev/null" : "b/new.png"}`, `@@ -${old === null ? "0,0" : "1,3"} +${next === null ? "0,0" : "1,3"} @@`];
  if (old !== null) lines.push(...old.trimEnd().split("\n").map((line) => `-${line}`));
  if (next !== null) lines.push(...next.trimEnd().split("\n").map((line) => `+${line}`));
  return `${lines.join("\n")}\n`;
}

test("only complete single-hunk pointer sides qualify, and an absent advert keeps source", () => {
  const diff = patch(text(), text(pointer(new Uint8Array([2]))), true);
  expect(parseLfsPointerDiff(diff)?.old).toEqual(pointer());
  expect(findPatchFileEntry(diff, "new.png")?.lfsPointers?.old).toEqual(pointer());
  expect(isImagePreviewCandidate(diff, "new.png")).toBe(false);
  expect(isImagePreviewCandidate(diff, "new.png", "old.png", true)).toBe(true);
  expect(isImagePreviewCandidate(diff, "new.txt", undefined, true)).toBe(false);
  expect(parseLfsPointerDiff(patch(null, text()))?.old).toBeUndefined();
  expect(findPatchFileEntry(patch(text(), null), "new.png")?.newPath).toBeUndefined();
  for (const invalid of [diff.replace("1,3", "2,3"), `${diff}@@ -1,3 +1,3 @@\n`, diff.replace("+version", "+garbage"), diff.replace(`size ${body.length}`, `size 0${body.length}`), `${diff}+extra\n`]) expect(parseLfsPointerDiff(invalid)).toBeNull();
  for (const invalid of [text().replace("sha256:", "sha256:../"), text().replace(`size ${body.length}`, "size -1"), text().replace(`size ${body.length}`, "size 9007199254740992"), `${text()}extra\n`, ""]) expect(parseLfsPointer(invalid)).toBeNull();
  for (const host of ["git-lfsXgithub.com", "git-lfs.githubXcom", "git-lfsXgithubXcom"]) {
    expect(parseLfsPointer(text().replace("git-lfs.github.com", host))).toBeNull();
  }
});

test("cache objects in default, relative and external shared storage are verified", async () => {
  for (const storage of ["lfs", "custom-lfs", "..", temp()]) {
    const f = fixture(storage); f.cache();
    expect(await f.read()).toEqual({ kind: "ok", bytes: body });
    f.cache(new TextEncoder().encode(text()));
    await expect(f.read()).rejects.toBeInstanceOf(ReviewLfsMismatchError);
  }
});

test("relative lfs.storage may point outside the repository", async () => {
  const shared = temp();
  const f = fixture(shared); f.cache();
  git(f.cwd, ["config", "lfs.storage", relative(join(f.cwd, ".git"), shared)]);
  expect(await f.read()).toEqual({ kind: "ok", bytes: body });
});

test("a working-tree side may use a smudged file, never an arbitrary historical side", async () => {
  const f = fixture(); writeFileSync(join(f.cwd, "new.png"), body);
  expect(await f.read({ worktreePath: "new.png" })).toEqual({ kind: "ok", bytes: body });
  expect(await f.read()).toEqual({ kind: "missing" });
  writeFileSync(join(f.cwd, "new.png"), text());
  expect(await f.read({ worktreePath: "new.png" })).toEqual({ kind: "missing" });
});

test("edited worktree files of any size are missing, not cache corruption", async () => {
  const f = fixture();
  for (const bytes of [new Uint8Array(body.length), body.subarray(1), new Uint8Array(body.length + 1), new Uint8Array(MAX_REVIEW_IMAGE_PREVIEW_BYTES + 1)]) {
    writeFileSync(join(f.cwd, "new.png"), bytes);
    expect(await f.read({ worktreePath: "new.png" })).toEqual({ kind: "missing" });
  }
});

test("missing, malformed and over-cap pointers perform no object read", async () => {
  const f = fixture();
  expect(await f.read()).toEqual({ kind: "missing" });
  const noGit = { ...runtime, runGit: async () => { throw new Error("must not resolve a path"); } };
  const read = createLocalLfsImageReader(noGit);
  expect(await read({ cwd: f.cwd, pointer: { oid: "../../outside", size: 1 } })).toEqual({ kind: "missing" });
  expect(await read({ cwd: f.cwd, pointer: { ...pointer(), size: MAX_REVIEW_IMAGE_PREVIEW_BYTES + 1 } })).toEqual({ kind: "too-large", size: MAX_REVIEW_IMAGE_PREVIEW_BYTES + 1 });
});

test("bad hashes and both smaller and larger objects fail closed without trying the worktree", async () => {
  for (const bytes of [new Uint8Array(body.length), body.subarray(1), new Uint8Array(body.length + 1)]) {
    const f = fixture(); f.cache(bytes); writeFileSync(join(f.cwd, "new.png"), body);
    await expect(f.read({ worktreePath: "new.png" })).rejects.toBeInstanceOf(ReviewLfsMismatchError);
  }
});

test("object and worktree symlinks cannot escape even with external storage", async () => {
  const outside = temp(); writeFileSync(join(outside, "image"), body);
  const f = fixture(); mkdirSync(dirname(f.object), { recursive: true });
  symlinkSync(join(outside, "image"), f.object);
  expect(await f.read()).toEqual({ kind: "missing" });
  rmSync(join(f.cwd, ".git", "lfs"), { recursive: true });
  symlinkSync(outside, join(f.cwd, ".git", "lfs"));
  expect(await f.read()).toEqual({ kind: "missing" });
  symlinkSync(outside, join(f.cwd, "escape"));
  expect(await f.read({ worktreePath: "escape/image" })).toEqual({ kind: "missing" });
  expect(await f.read({ worktreePath: "../image" })).toEqual({ kind: "missing" });
  const external = fixture(temp());
  mkdirSync(dirname(external.object), { recursive: true });
  symlinkSync(join(outside, "image"), external.object);
  expect(await external.read()).toEqual({ kind: "missing" });
});

test("a linked worktree uses its common git directory", async () => {
  const f = fixture(); f.cache();
  git(f.cwd, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "initial"]);
  const checkout = join(temp(), "checkout");
  expect(git(f.cwd, ["worktree", "add", "--detach", checkout]).exitCode).toBe(0);
  expect(await f.read({ cwd: checkout })).toEqual({ kind: "ok", bytes: body });
});

test("aborting local resolution stops it", async () => {
  const f = fixture(); f.cache(); const controller = new AbortController(); controller.abort();
  await expect(f.read({ signal: controller.signal })).rejects.toThrow();
  const midRead = new AbortController();
  const read = createLocalLfsImageReader({ ...runtime, runGit: async (args, options) => { midRead.abort(); return runtime.runGit(args, options); } });
  await expect(read({ cwd: f.cwd, pointer: pointer(), signal: midRead.signal })).rejects.toThrow();
  expect(await read({ cwd: f.cwd, pointer: pointer() })).toEqual({ kind: "ok", bytes: body });
});

test("concurrent image sides share three metadata queries per cwd and session", async () => {
  const first = fixture(); first.cache();
  const second = fixture(); second.cache();
  const calls: Array<{ args: string[]; cwd?: string }> = [];
  const counted = { ...runtime, runGit: async (args: string[], options?: { cwd?: string }) => {
    calls.push({ args, cwd: options?.cwd });
    return runtime.runGit(args, options);
  } };
  const read = createLocalLfsImageReader(counted);
  await Promise.all([first.cwd, first.cwd, second.cwd, second.cwd].map((cwd) => read({ cwd, pointer: pointer() })));
  expect(calls).toHaveLength(6);
  for (const cwd of [first.cwd, second.cwd]) {
    expect(calls.filter((call) => call.cwd === cwd).map((call) => call.args)).toEqual([
      ["rev-parse", "--show-toplevel"],
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      ["config", "--path", "--get", "lfs.storage"],
    ]);
  }
  const external = temp();
  git(first.cwd, ["config", "lfs.storage", external]);
  expect(await read({ cwd: first.cwd, pointer: pointer() })).toEqual({ kind: "ok", bytes: body });
  expect(calls).toHaveLength(6);
  expect(await createLocalLfsImageReader(counted)({ cwd: first.cwd, pointer: pointer() })).toEqual({ kind: "missing" });
  expect(calls).toHaveLength(9);
});

test("missing repository metadata is cached, but a failed lookup may retry", async () => {
  const f = fixture(); f.cache();
  let calls = 0;
  const missing = createLocalLfsImageReader({ ...runtime, runGit: async () => { calls++; return { stdout: "", stderr: "", exitCode: 1 }; } });
  expect(await missing({ cwd: f.cwd, pointer: pointer() })).toEqual({ kind: "missing" });
  const afterFirst = calls;
  expect(await missing({ cwd: f.cwd, pointer: pointer() })).toEqual({ kind: "missing" });
  expect(calls).toBe(afterFirst);
  let fail = true;
  const retry = createLocalLfsImageReader({ ...runtime, runGit: async (args, options) => {
    if (fail) { fail = false; throw new Error("git failed"); }
    return runtime.runGit(args, options);
  } });
  await expect(retry({ cwd: f.cwd, pointer: pointer() })).rejects.toThrow("git failed");
  expect(await retry({ cwd: f.cwd, pointer: pointer() })).toEqual({ kind: "ok", bytes: body });
});

test("equal object ids need no read; missing and corrupt sides retain distinct errors", async () => {
  const request = { available: true, patch: patch(text(), text({ ...pointer(), size: body.length + 1 })), params: new URLSearchParams("path=new.png&side=new&snapshot=s"), isCurrentSnapshot: () => true, readSide: async () => { throw new Error("no platform read"); }, readLfsSide: async () => { throw new Error("no local read"); } };
  expect((await handleReviewImageRequest(request)).status).toBe(204);
  const changed = { ...request, patch: patch(text(), text(pointer(new Uint8Array([2])))) };
  const missing = await handleReviewImageRequest({ ...changed, readLfsSide: async () => ({ kind: "missing" }) });
  expect(missing.status).toBe(415); expect(JSON.parse(missing.body as string).reason).toBe("lfs-pointer");
  const corrupt = await handleReviewImageRequest({ ...changed, readLfsSide: async () => { throw new ReviewLfsMismatchError(); } });
  expect(corrupt.status).toBe(502); expect(JSON.parse(corrupt.body as string).reason).toBe("lfs-mismatch");
  expect((await handleReviewImageRequest({ ...changed, readLfsSide: undefined })).status).toBe(404);
  let current = true;
  const stale = await handleReviewImageRequest({ ...changed, isCurrentSnapshot: () => current, readLfsSide: async () => { current = false; return { kind: "ok", bytes: body }; } });
  expect(stale.status).toBe(409);
  const controller = new AbortController();
  const aborted = await handleReviewImageRequest({ ...changed, signal: controller.signal, readLfsSide: async () => { controller.abort(); return { kind: "missing" }; } });
  expect(aborted.status).toBe(499);
});
