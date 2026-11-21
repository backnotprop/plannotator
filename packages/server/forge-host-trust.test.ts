import { afterEach, describe, expect, test } from "bun:test";
import { forgeHostTrusted, parseForgeRefUrl } from "@plannotator/core/forge-ref-card";
import { learnForgejoHosts } from "@plannotator/core/forge-refs";
import type { ForgeRefCardData } from "@plannotator/core/forge-ref-card";
import { createRefCards, type RefCli, type RefRunner } from "./ref-cards";

const GLAB_SIGNED_IN = "git.acme.com\n  ✓ Logged in to git.acme.com as dev (keyring)\ngit.acme.com:8443\n  ✓ Logged in to git.acme.com:8443 as dev (keyring)\n";

function stubForges() {
  const calls: { cli: RefCli; args: string[] }[] = [];
  const run: RefRunner = async (cli, args) => {
    calls.push({ cli, args });
    if (args[0] === "auth" && args[1] === "status") return cli === "glab" ? { stdout: "", stderr: GLAB_SIGNED_IN, exitCode: 0 } : { stdout: "{}", stderr: "", exitCode: 0 };
    return { stdout: "", stderr: "stub forge", exitCode: 1 };
  };
  return { run, calls };
}

const ROWS: [href: string, platform: "github" | "gitlab" | null, calls: boolean][] = [
  ["https://github.com/acme/api/pull/1", "github", true],
  ["https://gitlab.com/acme/api/-/merge_requests/1", "gitlab", true],
  ["https://gitlab.acme.com/acme/api/-/merge_requests/1", "gitlab", false],
  ["https://code.gitlab.acme.com/acme/api/-/merge_requests/1", "gitlab", false],
  ["https://git.acme.com/acme/api/-/merge_requests/1", "gitlab", true],
  ["https://git.acme.com/acme/sub/api/-/issues/12", "gitlab", true],
  ["https://source.acme.io/acme/api/-/merge_requests/1", "gitlab", false],
  ["https://acme-gitlab.com/acme/api/-/work_items/3", "gitlab", false],
  ["https://git.acme.com:8443/acme/api/-/merge_requests/1", "gitlab", true],
  ["https://source.acme.io:8443/acme/api/-/merge_requests/1", "gitlab", false],
  ["https://gitlab.evil.example/acme/api/-/merge_requests/1", "gitlab", false],
  ["https://evil.example/acme/api/-/merge_requests/1", "gitlab", false],
  ["http://git.acme.com/acme/api/-/merge_requests/1", null, false],
  ["http://gitlab.com/acme/api/-/merge_requests/1", null, false],
  ["https://gitlab.com:8443/acme/api/-/merge_requests/1", null, false],
  ["https://gitlab.com-evil.example/acme/api/-/merge_requests/1", null, false],
  ["https://gitlab.com.evil.example/acme/api/-/merge_requests/1", null, false],
  // A GitLab by its name is a GitLab, and still asked only when this computer's glab is signed in there.
  ["https://gitlab-master.example.com/acme/api/-/merge_requests/1", "gitlab", false],
  ["https://git.acme.com/acme/api/-/blob/main/README.md", null, false],
  ["https://git.acme.com/acme/api/pull/1", null, false],
];

describe("which links are a forge's, and which hosts are asked", () => {
  test.each(ROWS)("%s → %p, asked: %p", async (href, platform, calls) => {
    const ref = parseForgeRefUrl(href);
    expect(ref?.platform ?? null).toBe(platform);
    const forges = stubForges();
    const cards = createRefCards({ run: forges.run, avatar: async () => null });
    const result = await cards.get(href);
    const host = new URL(href).host;
    const asked = forges.calls.some((call) => call.args.includes(host));
    expect(asked).toBe(calls);
    expect(ref ? forgeHostTrusted(ref, new Set(["git.acme.com", "git.acme.com:8443"])) : false).toBe(calls);
    if (ref && !calls) expect(result).toMatchObject({ ok: false, error: "unsupported" });
  });
});

describe("Forgejo links: the path names the forge, the person's own hosts say where to ask", () => {
  // The known hosts are one global of this process: put it back for every other test.
  afterEach(() => learnForgejoHosts([]));

  const card = (ref: { host: string; owner: string; repo: string; number: number }): ForgeRefCardData => ({
    platform: "forgejo", kind: "pull", repo: `${ref.owner}/${ref.repo}`, number: ref.number, url: `https://${ref.host}/${ref.owner}/${ref.repo}/pulls/${ref.number}`,
    title: "t", state: "open", author: null, createdAt: "", updatedAt: "", closedAt: null, labels: [], assignees: [], comments: 0, body: "", bodyCut: false, lastComment: null, linked: [],
  });

  /** Every CLI call and every host a reader was asked for. */
  function setup() {
    const clis: string[] = [];
    const asked: string[] = [];
    const run: RefRunner = async (cli) => {
      clis.push(cli);
      return { stdout: "", stderr: "must not run", exitCode: 1 };
    };
    const cards = createRefCards({ run, avatar: async () => null, forgejo: async (ref) => (asked.push(ref.host), card(ref)) });
    return { cards, clis, asked };
  }

  test("codeberg.org is asked with nothing configured, and no CLI ever runs for a Forgejo", async () => {
    const { cards, clis, asked } = setup();
    expect(await cards.get("https://codeberg.org/acme/api/pulls/3")).toMatchObject({ ok: true });
    expect(await cards.get("https://codeberg.org/acme/api/issues/4")).toMatchObject({ ok: true });
    expect(asked).toEqual(["codeberg.org", "codeberg.org"]);
    expect(clis).toEqual([]);
  });

  test("a pull request link on any other host is a Forgejo's by its path, but it is not asked until the person named the host", async () => {
    const { cards, clis, asked } = setup();
    const href = "https://git.acme.com/acme/api/pulls/3";
    expect(parseForgeRefUrl(href)).toMatchObject({ platform: "forgejo", host: "git.acme.com", kind: "pull" });
    expect(await cards.get(href)).toMatchObject({ ok: false, error: "unsupported" });
    expect(asked).toEqual([]);
    learnForgejoHosts(["git.acme.com"]);
    expect(await cards.get(href)).toMatchObject({ ok: true });
    expect(asked).toEqual(["git.acme.com"]);
    expect(clis).toEqual([]);
  });

  test("a look-alike or hostile host is never asked, however much its path reads like a Forgejo's", async () => {
    learnForgejoHosts(["git.acme.com"]);
    const { cards, asked } = setup();
    for (const href of [
      "https://codeberg.org.evil.example/acme/api/pulls/1",
      "https://codeberg.org-evil.example/acme/api/pulls/1",
      "https://git.acme.com.evil.example/acme/api/pulls/1",
      "https://evil.example/acme/api/pulls/1",
      "https://git.acme.com:8443/acme/api/pulls/1",
    ]) {
      expect(await cards.get(href)).toMatchObject({ ok: false, error: "unsupported" });
    }
    expect(asked).toEqual([]);
  });

  test("an issue link names no forge by its path: only a host already known as a Forgejo reads it", async () => {
    const { cards, asked } = setup();
    expect(parseForgeRefUrl("https://git.acme.com/acme/api/issues/9")).toBeNull();
    expect(await cards.get("https://git.acme.com/acme/api/issues/9")).toBeNull();
    learnForgejoHosts(["git.acme.com"]);
    expect(parseForgeRefUrl("https://git.acme.com/acme/api/issues/9")).toMatchObject({ platform: "forgejo", kind: "issue" });
    expect(await cards.get("https://git.acme.com/acme/api/issues/9")).toMatchObject({ ok: true });
    expect(asked).toEqual(["git.acme.com"]);
  });

  test("only https, no credentials, no port on codeberg.org", () => {
    for (const bad of ["http://codeberg.org/a/b/pulls/1", "https://user:pw@codeberg.org/a/b/pulls/1", "https://codeberg.org:8443/a/b/pulls/1"]) {
      expect(parseForgeRefUrl(bad)).toBeNull();
    }
  });

  test("trust follows the host the person named, never the CLI's sign-ins", () => {
    const ref = { platform: "forgejo" as const, host: "git.acme.com" };
    expect(forgeHostTrusted(ref, new Set(["git.acme.com"]))).toBe(false);
    learnForgejoHosts(["git.acme.com"]);
    expect(forgeHostTrusted(ref, new Set())).toBe(true);
  });

  test("a host that has not been given a reader answers unsupported, even for codeberg.org", async () => {
    const cards = createRefCards({ run: stubForges().run, avatar: async () => null });
    expect(await cards.get("https://codeberg.org/acme/api/pulls/3")).toMatchObject({ ok: false, error: "unsupported" });
  });
});
