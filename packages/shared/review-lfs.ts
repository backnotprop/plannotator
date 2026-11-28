import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { type LfsPointer, MAX_REVIEW_IMAGE_PREVIEW_BYTES, parseLfsPointer } from "./diff-paths";
import type { FileBytesRead, ReviewGitRuntime } from "./review-core";

export class ReviewLfsMismatchError extends Error {
  constructor() {
    super("The local Git LFS object does not match its pointer");
  }
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

async function readContained(root: string, path: string, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array | null> {
  signal?.throwIfAborted();
  if (!within(root, path)) return null;
  try {
    const canonicalRoot = await realpath(root);
    const canonical = await realpath(path);
    if (!within(canonicalRoot, canonical)) return null;
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) return null;
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev) return null;
      if (opened.size > maxBytes) throw new ReviewLfsMismatchError();
      const buffer = new Uint8Array(opened.size);
      let offset = 0;
      while (offset < buffer.length) {
        signal?.throwIfAborted();
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      signal?.throwIfAborted();
      if ((await handle.stat()).size > maxBytes) throw new ReviewLfsMismatchError();
      return buffer.subarray(0, offset);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof ReviewLfsMismatchError || signal?.aborted) throw error;
    return null;
  }
}

interface LfsImageReadOptions {
  cwd?: string;
  pointer: LfsPointer;
  worktreePath?: string;
  signal?: AbortSignal;
}

async function lfsRepository(runtime: ReviewGitRuntime, cwd: string): Promise<{ root: string; storage: string } | null> {
  const run = async (args: string[]) => {
    const result = await runtime.runGit(args, { cwd });
    return result.exitCode === 0 ? result.stdout.trim() : null;
  };
  const root = await run(["rev-parse", "--show-toplevel"]);
  const common = await run(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!root || !common) return null;
  const configured = await run(["config", "--path", "--get", "lfs.storage"]);
  return { root, storage: configured ? resolve(common, configured) : join(common, "lfs") };
}

/** One reader per review session; only repository locations, never image bytes, are memoized. */
export function createLocalLfsImageReader(runtime: ReviewGitRuntime) {
  const repositories = new Map<string, ReturnType<typeof lfsRepository>>();
  return async (options: LfsImageReadOptions): Promise<FileBytesRead> => {
    const { pointer, signal } = options;
    signal?.throwIfAborted();
    if (!/^[a-f0-9]{64}$/.test(pointer.oid) || !Number.isSafeInteger(pointer.size) || pointer.size < 0) return { kind: "missing" };
    if (pointer.size > MAX_REVIEW_IMAGE_PREVIEW_BYTES) return { kind: "too-large", size: pointer.size };
    const cwd = resolve(options.cwd ?? process.cwd());
    let pending = repositories.get(cwd);
    if (!pending) {
      pending = lfsRepository(runtime, cwd);
      repositories.set(cwd, pending);
      const started = pending;
      void started.catch(() => { if (repositories.get(cwd) === started) repositories.delete(cwd); });
    }
    // A cancelled image must not cancel the metadata lookup another side shares.
    const repository = await pending;
    signal?.throwIfAborted();
    if (!repository) return { kind: "missing" };
    const { root, storage } = repository;
    const candidates: Array<{ base: string; path: string; worktree?: boolean }> = [
      { base: storage, path: join(storage, "objects", pointer.oid.slice(0, 2), pointer.oid.slice(2, 4), pointer.oid) },
    ];
    if (options.worktreePath) candidates.push({ base: root, path: resolve(root, options.worktreePath), worktree: true });
    for (const { base, path, worktree } of candidates) {
      let bytes: Uint8Array | null;
      try {
        bytes = await readContained(base, path, pointer.size, signal);
      } catch (error) {
        if (worktree && error instanceof ReviewLfsMismatchError) continue;
        throw error;
      }
      if (!bytes) continue;
      if (worktree && bytes.byteLength <= 1024 && parseLfsPointer(new TextDecoder().decode(bytes))) continue;
      if (bytes.byteLength !== pointer.size || createHash("sha256").update(bytes).digest("hex") !== pointer.oid) {
        if (worktree) continue;
        throw new ReviewLfsMismatchError();
      }
      return { kind: "ok", bytes };
    }
    return { kind: "missing" };
  };
}
