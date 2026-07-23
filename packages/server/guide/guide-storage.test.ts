import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeGuideOutput } from "@plannotator/shared/guide";
import {
  createGuideStore,
  createPRGuidePersistenceContext,
  hashGuideChangeset,
  normalizeRepositoryIdentity,
  resolveLocalGuidePersistenceContext,
  type GuidePersistenceContext,
  type PersistedGuide,
} from "./guide-storage";

const tempDirs: string[] = [];
const originalDataDir = process.env.PLANNOTATOR_DATA_DIR;

function tempGuideDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-guide-store-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = originalDataDir;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const guide: CodeGuideOutput = {
  title: "Persisted guide",
  intent: "Verify persistence",
  sections: [{ title: "Storage", overview: "Durable state", diffs: [{ file: "src/a.ts" }] }],
};

function branchContext(
  repository = "github.com/acme/widgets",
  branch = "feature/persist",
  revision = "abc123",
  fingerprint = "patch-one",
): GuidePersistenceContext {
  return {
    targets: [{ kind: "branch", repository, branch }],
    revision,
    fingerprint,
  };
}

function record(
  id: string,
  context: GuidePersistenceContext,
  generatedAt = 1,
  reviewed: boolean[] = [],
): PersistedGuide {
  return {
    version: 1,
    id,
    context,
    generatedAt,
    guide,
    reviewed,
    engine: "claude",
  };
}

describe("normalizeRepositoryIdentity", () => {
  it("normalizes host, slashes, case, and .git suffixes", () => {
    expect(normalizeRepositoryIdentity(" GitHub.COM ", "/Acme/Widgets.git/"))
      .toBe("github.com/acme/widgets");
  });

  it("rejects incomplete repository identities", () => {
    expect(normalizeRepositoryIdentity("", "acme/widgets")).toBeNull();
    expect(normalizeRepositoryIdentity("github.com", "")).toBeNull();
  });
});

describe("createPRGuidePersistenceContext", () => {
  it("indexes a fork PR by both its PR number and canonical head branch", () => {
    expect(createPRGuidePersistenceContext({
      platform: "github",
      host: "GitHub.com",
      owner: "Acme",
      repo: "Widgets",
      number: 42,
      title: "Persist guides",
      author: "dev",
      baseBranch: "main",
      headBranch: "feature/persist",
      headRepository: "Contributor/Widgets",
      baseSha: "base",
      headSha: "head",
      url: "https://github.com/Acme/Widgets/pull/42",
    }, "patch")?.targets).toEqual([
      { kind: "pr", repository: "github.com/acme/widgets", number: 42 },
      { kind: "branch", repository: "github.com/contributor/widgets", branch: "feature/persist" },
    ]);
  });
});

describe("resolveLocalGuidePersistenceContext", () => {
  it("uses the canonical origin repository, branch, and HEAD", async () => {
    const responses = new Map([
      ["branch --show-current", "feature/persist"],
      ["rev-parse HEAD", "abc123"],
      ["remote get-url origin", "git@github.com:Acme/Widgets.git"],
    ]);
    const context = await resolveLocalGuidePersistenceContext({
      async runGit(args) {
        const stdout = responses.get(args.join(" "));
        return { stdout: stdout ? `${stdout}\n` : "", stderr: "", exitCode: stdout ? 0 : 1 };
      },
      async readTextFile() { return null; },
    }, "/repo", "patch");

    expect(context).toEqual({
      targets: [{ kind: "branch", repository: "github.com/acme/widgets", branch: "feature/persist" }],
      revision: "abc123",
      fingerprint: hashGuideChangeset("patch"),
    });
  });

  it("prefers the branch's tracked fork remote over an upstream origin", async () => {
    const responses = new Map([
      ["branch --show-current", "feature/persist"],
      ["rev-parse HEAD", "abc123"],
      ["for-each-ref --format=%(upstream:remotename) refs/heads/feature/persist", "fork"],
      ["remote get-url fork", "https://github.com/contributor/widgets.git"],
      ["remote get-url origin", "https://github.com/acme/widgets.git"],
    ]);
    const context = await resolveLocalGuidePersistenceContext({
      async runGit(args) {
        const stdout = responses.get(args.join(" "));
        return { stdout: stdout ? `${stdout}\n` : "", stderr: "", exitCode: stdout ? 0 : 1 };
      },
      async readTextFile() { return null; },
    }, "/repo", "patch");

    expect(context?.targets).toEqual([
      { kind: "branch", repository: "github.com/contributor/widgets", branch: "feature/persist" },
    ]);
  });

  it("keeps explicit forge ports in repository identity", async () => {
    const resolvePort = (port: number) => resolveLocalGuidePersistenceContext({
      async runGit(args) {
        const key = args.join(" ");
        if (key === "branch --show-current") return { stdout: "main\n", stderr: "", exitCode: 0 };
        if (key === "rev-parse HEAD") return { stdout: "abc123\n", stderr: "", exitCode: 0 };
        if (key.startsWith("for-each-ref ")) return { stdout: "origin\n", stderr: "", exitCode: 0 };
        if (key === "remote get-url origin") return { stdout: `https://git.example:${port}/acme/app.git\n`, stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 1 };
      },
      async readTextFile() { return null; },
    }, "/repo", "patch");

    const first = await resolvePort(8443);
    const second = await resolvePort(9443);
    expect(first?.targets[0]).toEqual({ kind: "branch", repository: "git.example:8443/acme/app", branch: "main" });
    expect(second?.targets[0]).toEqual({ kind: "branch", repository: "git.example:9443/acme/app", branch: "main" });
    expect(first?.targets[0]).not.toEqual(second?.targets[0]);
  });

  it("does not persist detached HEAD reviews", async () => {
    const context = await resolveLocalGuidePersistenceContext({
      async runGit(args) {
        return args[0] === "branch"
          ? { stdout: "", stderr: "", exitCode: 0 }
          : { stdout: "abc123\n", stderr: "", exitCode: 0 };
      },
      async readTextFile() { return null; },
    }, "/repo", "patch");

    expect(context).toBeNull();
  });
});

describe("createGuideStore", () => {
  it("stores default artifacts beneath PLANNOTATOR_DATA_DIR", () => {
    const dataDir = tempGuideDir();
    process.env.PLANNOTATOR_DATA_DIR = dataDir;
    createGuideStore().write(record("job-1", branchContext()));

    expect(existsSync(join(dataDir, "guides"))).toBe(true);
    expect(readdirSync(join(dataDir, "guides")).some((name) => name.endsWith(".json"))).toBe(true);
  });

  it("persists a guide and Reviewed state across store instances", () => {
    const dir = tempGuideDir();
    const context = branchContext();
    const first = createGuideStore(dir);
    first.write(record("job-1", context, 10, [true]));

    const loaded = createGuideStore(dir).readCurrent(context);
    expect(loaded).not.toBeNull();
    expect(loaded?.record.id).toBe("job-1");
    expect(loaded?.record.reviewed).toEqual([true]);
    expect(loaded?.outdated).toBe(false);
  });

  it("uses PR head branches as aliases and selects the newest matching record", () => {
    const dir = tempGuideDir();
    const branch = { kind: "branch" as const, repository: "github.com/fork/widgets", branch: "feature/persist" };
    const pr = { kind: "pr" as const, repository: "github.com/acme/widgets", number: 42 };
    const store = createGuideStore(dir);

    store.write(record("branch-guide", { ...branchContext(branch.repository, branch.branch), targets: [branch] }, 20));
    store.write(record("older-pr-guide", {
      targets: [pr],
      revision: "old",
      fingerprint: "old",
    }, 10));

    const loaded = store.readCurrent({
      targets: [pr, branch],
      revision: "abc123",
      fingerprint: "patch-one",
    });
    expect(loaded?.record.id).toBe("branch-guide");
    expect(loaded?.outdated).toBe(false);
  });

  it("isolates identical branch names in different repositories", () => {
    const dir = tempGuideDir();
    const store = createGuideStore(dir);
    const firstRepo = branchContext("github.com/acme/one", "main");
    const secondRepo = branchContext("github.com/acme/two", "main");
    store.write(record("repo-one", firstRepo));

    expect(store.readCurrent(secondRepo)).toBeNull();
    expect(store.readCurrent(firstRepo)?.record.id).toBe("repo-one");
  });

  it("marks changed revisions and changed fingerprints outdated", () => {
    const dir = tempGuideDir();
    const store = createGuideStore(dir);
    const original = branchContext();
    store.write(record("job-1", original));

    expect(store.readCurrent(branchContext(undefined, undefined, "def456", "patch-one"))?.outdated).toBe(true);
    expect(store.readCurrent(branchContext(undefined, undefined, "abc123", "patch-two"))?.outdated).toBe(true);
  });

  it("ignores invalid persisted data", () => {
    const dir = tempGuideDir();
    const context = branchContext();
    const store = createGuideStore(dir);
    store.write(record("job-1", context));
    const [artifact] = readdirSync(dir).filter((name) => name.endsWith(".json"));
    writeFileSync(join(dir, artifact), "{not json", "utf8");

    expect(createGuideStore(dir).readCurrent(context)).toBeNull();
  });

  it("rejects malformed optional guide fields instead of hydrating unsafe UI data", () => {
    const context = branchContext();
    for (const malformedGuide of [
      { ...guide, unplacedFiles: { path: "src/b.ts" } },
      {
        ...guide,
        sections: [{
          ...guide.sections[0],
          diffs: [{ file: "src/a.ts", summary: { text: "not a string" } }],
        }],
      },
    ]) {
      const dir = tempGuideDir();
      const store = createGuideStore(dir);
      store.write({ ...record("job-1", context), guide: malformedGuide as unknown as CodeGuideOutput });
      expect(createGuideStore(dir).readCurrent(context)).toBeNull();
    }
  });
});

describe("hashGuideChangeset", () => {
  it("is stable and content-sensitive", () => {
    expect(hashGuideChangeset("same patch")).toBe(hashGuideChangeset("same patch"));
    expect(hashGuideChangeset("same patch")).not.toBe(hashGuideChangeset("different patch"));
  });
});
