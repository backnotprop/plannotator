import { describe, expect, test } from "bun:test";
import {
  absolutizeGitLabAvatar,
  buildGitHubEmailAvatarMap,
  classifyAvatarRemote,
  createCommitAvatarResolver,
  type CommandResult,
} from "./commit-avatars";

describe("classifyAvatarRemote", () => {
  test("recognises github.com over ssh and https", () => {
    expect(classifyAvatarRemote("git@github.com:owner/repo.git")).toEqual({
      platform: "github",
      host: "github.com",
      path: "owner/repo",
    });
    expect(classifyAvatarRemote("https://github.com/owner/repo.git")).toEqual({
      platform: "github",
      host: "github.com",
      path: "owner/repo",
    });
  });

  test("recognises GHE and self-hosted GitLab by hostname", () => {
    expect(classifyAvatarRemote("git@github.corp.example:owner/repo.git")?.platform).toBe("github");
    expect(classifyAvatarRemote("https://gitlab.example.io/group/sub/project.git")).toEqual({
      platform: "gitlab",
      host: "gitlab.example.io",
      path: "group/sub/project",
    });
  });

  test("returns null for opaque hosts and unparseable urls", () => {
    expect(classifyAvatarRemote("git@git.internal.example:owner/repo.git")).toBeNull();
    expect(classifyAvatarRemote("")).toBeNull();
  });
});

describe("buildGitHubEmailAvatarMap", () => {
  test("maps linked commit authors by email and skips unlinked ones", () => {
    const payload = [
      {
        sha: "a1",
        commit: { author: { email: "dev@example.com" } },
        author: { avatar_url: "https://avatars.example/1" },
      },
      // Unlinked email — the GitHub `author` account is null.
      { sha: "a2", commit: { author: { email: "ghost@example.com" } }, author: null },
      // Duplicate email — first mapping wins.
      {
        sha: "a3",
        commit: { author: { email: "dev@example.com" } },
        author: { avatar_url: "https://avatars.example/other" },
      },
    ];
    const map = buildGitHubEmailAvatarMap(payload);
    expect(map.get("dev@example.com")).toBe("https://avatars.example/1");
    expect(map.has("ghost@example.com")).toBe(false);
    expect(map.size).toBe(1);
  });

  test("tolerates a non-array payload", () => {
    expect(buildGitHubEmailAvatarMap({ message: "Not Found" }).size).toBe(0);
  });
});

describe("absolutizeGitLabAvatar", () => {
  test("pins relative self-hosted paths to the GitLab host", () => {
    expect(absolutizeGitLabAvatar("gitlab.example.io", "/uploads/u/avatar.png")).toBe(
      "https://gitlab.example.io/uploads/u/avatar.png",
    );
    expect(absolutizeGitLabAvatar("gitlab.com", "https://secure.gravatar.com/x")).toBe(
      "https://secure.gravatar.com/x",
    );
  });
});

describe("createCommitAvatarResolver", () => {
  const ok = (stdout: string): CommandResult => ({ stdout, stderr: "", exitCode: 0 });
  const fail = (stderr = "boom"): CommandResult => ({ stdout: "", stderr, exitCode: 1 });

  function makeRunner(handler: (cmd: string, args: string[]) => CommandResult) {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    return {
      calls,
      runner: {
        async runCommand(cmd: string, args: string[]) {
          calls.push({ cmd, args });
          return handler(cmd, args);
        },
      },
    };
  }

  test("resolves GitHub avatars by email with one commits-list fetch, memoized across pages", async () => {
    const { calls, runner } = makeRunner((cmd) => {
      if (cmd === "git") return ok("git@github.com:owner/repo.git\n");
      if (cmd === "gh") {
        return ok(
          JSON.stringify([
            {
              commit: { author: { email: "dev@example.com" } },
              author: { avatar_url: "https://avatars.example/dev" },
            },
          ]),
        );
      }
      return fail();
    });
    const resolver = createCommitAvatarResolver(runner);

    const first = await resolver.resolve("/repo", ["dev@example.com", "ghost@example.com"]);
    expect(first.get("dev@example.com")).toBe("https://avatars.example/dev");
    expect(first.has("ghost@example.com")).toBe(false);

    // Second page: everything answered from cache — no new subprocesses.
    const before = calls.length;
    const second = await resolver.resolve("/repo", ["dev@example.com", "ghost@example.com"]);
    expect(second.get("dev@example.com")).toBe("https://avatars.example/dev");
    expect(calls.length).toBe(before);
  });

  test("a failing gh is memoized — never retried this session", async () => {
    const { calls, runner } = makeRunner((cmd) => {
      if (cmd === "git") return ok("https://github.com/owner/repo.git\n");
      return fail("gh: not logged in");
    });
    const resolver = createCommitAvatarResolver(runner);

    expect((await resolver.resolve("/repo", ["a@example.com"])).size).toBe(0);
    expect((await resolver.resolve("/repo", ["b@example.com"])).size).toBe(0);
    expect(calls.filter((c) => c.cmd === "gh").length).toBe(1);
  });

  test("resolves GitLab avatars per unique email and absolutizes self-hosted paths", async () => {
    const { calls, runner } = makeRunner((cmd, args) => {
      if (cmd === "git") return ok("git@gitlab.example.io:group/project.git\n");
      if (cmd === "glab") {
        expect(args).toContain("--hostname");
        return ok(JSON.stringify({ avatar_url: "/uploads/u/dev.png" }));
      }
      return fail();
    });
    const resolver = createCommitAvatarResolver(runner);

    const result = await resolver.resolve("/repo", ["dev@example.com", "dev@example.com"]);
    expect(result.get("dev@example.com")).toBe("https://gitlab.example.io/uploads/u/dev.png");
    expect(calls.filter((c) => c.cmd === "glab").length).toBe(1);
  });

  test("the GitLab per-call cap does not memoize un-attempted emails as misses", async () => {
    const { calls, runner } = makeRunner((cmd) => {
      if (cmd === "git") return ok("git@gitlab.com:group/project.git\n");
      if (cmd === "glab") return ok(JSON.stringify({ avatar_url: "https://grav.example/x" }));
      return fail();
    });
    const resolver = createCommitAvatarResolver(runner);

    // 12 unique emails — only the first 10 are queried on this call.
    const emails = Array.from({ length: 12 }, (_, i) => `dev${i}@example.com`);
    const first = await resolver.resolve("/repo", emails);
    expect(first.size).toBe(10);
    expect(calls.filter((c) => c.cmd === "glab").length).toBe(10);

    // The capped-out emails were NOT memoized as misses — a later call
    // attempts them.
    const second = await resolver.resolve("/repo", emails);
    expect(second.size).toBe(12);
    expect(calls.filter((c) => c.cmd === "glab").length).toBe(12);
  });

  test("a hanging CLI can't hold resolve() past the fetch timeout, and late results serve later calls", async () => {
    let releaseGh: (r: CommandResult) => void = () => {};
    const runner = {
      async runCommand(cmd: string): Promise<CommandResult> {
        if (cmd === "git") return ok("git@github.com:owner/repo.git\n");
        // gh hangs until the test releases it — a black-holed network.
        return new Promise<CommandResult>((res) => { releaseGh = res; });
      },
    };
    const resolver = createCommitAvatarResolver(runner, { fetchTimeoutMs: 20 });

    const start = Date.now();
    const first = await resolver.resolve("/repo", ["dev@example.com"]);
    expect(Date.now() - start).toBeLessThan(1000);
    expect(first.size).toBe(0); // initials fallback, response not held hostage

    // The background fetch completes later; its results serve the next call
    // (timeout must NOT have memoized the email as a permanent miss).
    releaseGh(ok(JSON.stringify([
      { commit: { author: { email: "dev@example.com" } }, author: { avatar_url: "https://avatars.example/dev" } },
    ])));
    await new Promise((r) => setTimeout(r, 0));
    const second = await resolver.resolve("/repo", ["dev@example.com"]);
    expect(second.get("dev@example.com")).toBe("https://avatars.example/dev");
  });

  test("an unqueryable forge resolves nothing without touching gh/glab", async () => {
    const { calls, runner } = makeRunner((cmd) => {
      if (cmd === "git") return ok("git@git.internal.example:owner/repo.git\n");
      return fail();
    });
    const resolver = createCommitAvatarResolver(runner);

    expect((await resolver.resolve("/repo", ["a@example.com"])).size).toBe(0);
    expect(calls.every((c) => c.cmd === "git")).toBe(true);
  });
});
