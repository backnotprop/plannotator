import { describe, expect, test } from "bun:test";
import {
  createRepoListingCache,
  decodeRepoFileBytes,
  isRepoWatchIgnored,
  isSafeRepoRequestPath,
  parsePorcelainZ,
  repoDirEntries,
  repoListingHas,
} from "./repo-files";
import { fetchGhPRTree } from "./pr-github";
import { fetchGlTree } from "./pr-gitlab";
import type { PRRuntime } from "./pr-types";

const SORTED = [".gitignore", "a/b/c.ts", "a/b/d.ts", "a/e.ts", "ab.ts", "z.md"];

describe("repoDirEntries", () => {
  test("lists one folder's children, folders first with their file counts", () => {
    expect(repoDirEntries(SORTED, "")).toEqual([
      { name: "a", path: "a", type: "dir", files: 3 },
      { name: ".gitignore", path: ".gitignore", type: "file" },
      { name: "ab.ts", path: "ab.ts", type: "file" },
      { name: "z.md", path: "z.md", type: "file" },
    ]);
    // "a/" never takes "ab.ts", a sibling sharing the prefix.
    expect(repoDirEntries(SORTED, "a")).toEqual([
      { name: "b", path: "a/b", type: "dir", files: 2 },
      { name: "e.ts", path: "a/e.ts", type: "file" },
    ]);
    expect(repoDirEntries(SORTED, "missing")).toEqual([]);
  });
});

describe("repoListingHas", () => {
  test("finds exactly the listed paths", () => {
    for (const path of SORTED) expect(repoListingHas(SORTED, path)).toBe(true);
    for (const path of ["a", "a/b", "a/e", "zz.md", ""]) expect(repoListingHas(SORTED, path)).toBe(false);
  });
});

describe("isSafeRepoRequestPath", () => {
  test("accepts repository paths and refuses anything that could leave the repository", () => {
    for (const ok of ["README.md", "src/a b.ts", ".github/workflows/ci.yml", "dir/.hidden"]) {
      expect(isSafeRepoRequestPath(ok)).toBe(true);
    }
    for (const bad of ["", "../x", "a/../b", "/etc/hosts", "\\\\server\\share", "C:/x", "a//b", "a/", "a\nb", "a\u0000b"]) {
      expect(isSafeRepoRequestPath(bad)).toBe(false);
    }
  });
});

describe("decodeRepoFileBytes", () => {
  test("text decodes; a NUL or invalid UTF-8 reads as binary", () => {
    expect(decodeRepoFileBytes(new TextEncoder().encode("héllo\n"))).toEqual({ content: "héllo\n" });
    expect(decodeRepoFileBytes(new Uint8Array([0x41, 0x00, 0x42]))).toEqual({ reason: "binary" });
    expect(decodeRepoFileBytes(new Uint8Array([0xff, 0xfe, 0x41]))).toEqual({ reason: "binary" });
  });
});

describe("parsePorcelainZ", () => {
  test("keeps every path's code; a rename keeps its new path and skips the original", () => {
    const out = [" M src/a.ts", "?? new file.ts", "R  to.ts", "from.ts", "A  added.ts", ""].join("\0");
    expect([...parsePorcelainZ(out)]).toEqual([
      ["src/a.ts", " M"],
      ["new file.ts", "??"],
      ["to.ts", "R "],
      ["added.ts", "A "],
    ]);
  });
});

describe("isRepoWatchIgnored", () => {
  test("ignores dependency and cache folders, never tracked output folders", () => {
    expect(isRepoWatchIgnored("node_modules/x/index.js")).toBe(true);
    expect(isRepoWatchIgnored(".git/index")).toBe(true);
    expect(isRepoWatchIgnored("apps/web/.next/cache")).toBe(true);
    expect(isRepoWatchIgnored("dist/app.js")).toBe(false);
    expect(isRepoWatchIgnored("public/index.html")).toBe(false);
    expect(isRepoWatchIgnored("src/a.ts")).toBe(false);
  });
});

describe("createRepoListingCache", () => {
  test("loads once per key, again after invalidate, and never keeps a failure", async () => {
    const cache = createRepoListingCache();
    let loads = 0;
    const listing = { paths: ["a"], revision: { kind: "worktree" as const, label: "working tree" }, live: true };
    const load = async () => {
      loads += 1;
      return listing;
    };
    await Promise.all([cache.get("s1", load), cache.get("s1", load)]);
    expect(loads).toBe(1);
    cache.invalidate();
    await cache.get("s1", load);
    expect(loads).toBe(2);
    await cache.get("s2", load);
    expect(loads).toBe(3);

    let failing = 0;
    const fail = async () => {
      failing += 1;
      return null;
    };
    expect(await cache.get("s3", fail)).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await cache.get("s3", fail)).toBeNull();
    expect(failing).toBe(2);
  });
});

function runtimeAnswering(stdout: string, exitCode = 0, seen: string[][] = []): PRRuntime {
  return {
    runCommand: async (cmd: string, args: string[]) => {
      seen.push([cmd, ...args]);
      return { stdout, stderr: "", exitCode };
    },
  } as unknown as PRRuntime;
}

describe("platform tree listings (All files without a checkout)", () => {
  test("GitHub: one recursive trees call, blobs only, truncation reported", async () => {
    const seen: string[][] = [];
    const tree = await fetchGhPRTree(
      runtimeAnswering(JSON.stringify({ truncated: true, paths: ["a.ts", "b/c.ts"] }), 0, seen),
      { platform: "github", host: "github.com", owner: "o", repo: "r", number: 1 },
      "abc123",
    );
    expect(tree).toEqual({ paths: ["a.ts", "b/c.ts"], truncated: true });
    expect(seen[0]).toContain("repos/o/r/git/trees/abc123?recursive=1");
    expect(await fetchGhPRTree(runtimeAnswering("", 1), { platform: "github", host: "github.com", owner: "o", repo: "r", number: 1 }, "x")).toBeNull();
  });

  test("GitLab: page by page, blobs only, stopping at a short page", async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ type: "blob", path: `f${i}.ts` }));
    const answers = [JSON.stringify([{ type: "tree", path: "src" }, ...full.slice(0, 99)]), JSON.stringify([{ type: "blob", path: "README.md" }])];
    const seen: string[][] = [];
    const tree = await fetchGlTree(
      { runCommand: async (_cmd: string, args: string[]) => { seen.push(args); return { stdout: answers.shift() ?? "[]", stderr: "", exitCode: 0 }; } } as never,
      { platform: "gitlab", host: "gitlab.com", projectPath: "g/p", iid: 3 },
      "def456",
    );
    expect(tree?.truncated).toBe(false);
    expect(tree?.paths).toHaveLength(100);
    expect(tree?.paths.at(-1)).toBe("README.md");
    expect(seen).toHaveLength(2);
    expect(seen[0].join(" ")).toContain("projects/g%2Fp/repository/tree?ref=def456&recursive=true&per_page=100&page=1");
    expect(seen[1].join(" ")).toContain("&page=2");
    expect(seen[0]).not.toContain("--paginate");
  });

  test("GitLab: a repository past the page budget is reported truncated", async () => {
    const full = JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ type: "blob", path: `f${i}.ts` })));
    let calls = 0;
    const tree = await fetchGlTree(
      { runCommand: async () => { calls += 1; return { stdout: full, stderr: "", exitCode: 0 }; } } as never,
      { platform: "gitlab", host: "gitlab.com", projectPath: "g/p", iid: 3 },
      "def456",
      3,
    );
    expect(calls).toBe(3);
    expect(tree?.truncated).toBe(true);
    expect(tree?.paths).toHaveLength(300);
  });
});

describe("polling a very large listing backs off while nothing changes", () => {
  test("1.5x per idle look up to 30 s; a change goes back to the start", async () => {
    const { nextRepoPollDelay, REPO_LIVE_POLL_MAX_MS } = await import("./repo-files");
    let delay = 5_000;
    const seen: number[] = [];
    for (let i = 0; i < 8; i += 1) seen.push((delay = nextRepoPollDelay(delay, false)));
    expect(seen.slice(0, 3)).toEqual([7_500, 11_250, 16_875]);
    expect(seen.at(-1)).toBe(REPO_LIVE_POLL_MAX_MS);
    expect(nextRepoPollDelay(REPO_LIVE_POLL_MAX_MS, true)).toBe(5_000);
  });
});
