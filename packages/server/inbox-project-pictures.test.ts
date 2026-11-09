/**
 * A project's letter-mark picture (inbox-project-pictures.ts; approval "inbox-letter-marks"): the order (the one set
 * with Set picture…, the repo's logo, the GitHub owner's picture, else none so the window draws letters), where a
 * repo's logo is found, and how the GitHub picture is fetched, kept and refreshed.
 * What this catches: a picture from the wrong source winning; a repo logo read from outside the project's folder (a
 * `..` link or a symlink) or from the network; GitHub asked for a project on another host, asked twice for one owner,
 * asked on every read, or asked at all from a test; a failed refresh that drops the kept picture; an upload that is
 * not an image, or too big, kept anyway.
 *
 * Never the network: every GitHub answer comes from a scripted fetch, and the sandbox case replaces the global fetch
 * with a tripwire.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectPictures, findRepoLogo, githubOwner, iconHref, pictureSources } from "./inbox-project-pictures";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PNG_B = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9, 9]);
const ICO = new Uint8Array([0, 0, 1, 0, ...new Array(30).fill(7)]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>');
const GITHUB = { display: "acme/web", host: "github.com" };

let scratch = "";
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "lm-pictures-"));
});

function repo(files: Record<string, Uint8Array | string>): string {
  const root = mkdtempSync(join(scratch, "repo-"));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
}

/** A scripted GitHub: answers each URL from `answers` (a picture, a status or a redirect), counting the calls. */
function fakeGithub(answers: (url: string) => Response) {
  const calls: string[] = [];
  return {
    calls,
    fetch: async (url: string) => {
      calls.push(url);
      return answers(url);
    },
  };
}
const picture = (bytes: Uint8Array<ArrayBuffer>, type = "image/png") => new Response(bytes, { status: 200, headers: { "content-type": type } });

describe("a repo's logo", () => {
  test("found in the usual places, in order, and in a monorepo's apps/*", () => {
    expect(findRepoLogo(repo({ "favicon.svg": SVG, "public/favicon.ico": ICO }))?.type).toBe("image/svg+xml");
    expect(findRepoLogo(repo({ "public/favicon.ico": ICO }))?.type).toBe("image/x-icon");
    expect(findRepoLogo(repo({ "app/icon.png": PNG }))?.type).toBe("image/png");
    expect(findRepoLogo(repo({ "apps/site/public/favicon.png": PNG }))?.type).toBe("image/png");
    expect(findRepoLogo(repo({ "README.md": "# none" }))).toBeNull();
  });

  test("an index.html's <link rel=icon>: a local path only, never a URL, never outside the folder", () => {
    expect(iconHref('<link rel="stylesheet" href="a.css"><link href="/brand/mark.png" rel="shortcut icon">')).toBe("/brand/mark.png");
    expect(findRepoLogo(repo({ "index.html": '<link rel="icon" href="/brand/mark.png?v=2">', "public/brand/mark.png": PNG }))?.type).toBe("image/png");
    expect(findRepoLogo(repo({ "index.html": "<link rel=icon href=img/i.png>", "img/i.png": PNG }))?.type).toBe("image/png");
    // A URL is never fetched: no logo.
    expect(findRepoLogo(repo({ "index.html": '<link rel="icon" href="https://cdn.example/icon.png">' }))).toBeNull();
    // A path out of the folder is refused, even when the file exists there.
    writeFileSync(join(scratch, "outside.png"), PNG);
    expect(findRepoLogo(repo({ "index.html": '<link rel="icon" href="../outside.png">' }))).toBeNull();
  });

  test("a symlink that leads out of the folder is refused; a file that is not an image is skipped", () => {
    const root = repo({});
    writeFileSync(join(scratch, "secret.png"), PNG);
    symlinkSync(join(scratch, "secret.png"), join(root, "favicon.png"));
    expect(findRepoLogo(root)).toBeNull();
    expect(findRepoLogo(repo({ "favicon.svg": "<html><script>x</script></html>", "favicon.png": PNG }))?.type).toBe("image/png");
  });

  test("an index.html that is a symlink out of the folder is not read", () => {
    const outside = repo({ "index.html": '<link rel="icon" href="img/i.png">' });
    const root = repo({ "img/i.png": PNG });
    symlinkSync(join(outside, "index.html"), join(root, "index.html"));
    expect(findRepoLogo(root)).toBeNull();
  });
});

describe("the GitHub owner", () => {
  test("github.com only, a valid login only", () => {
    expect(githubOwner(GITHUB)).toBe("acme");
    expect(githubOwner({ display: "acme/web", host: "GitHub.com" })).toBe("acme");
    expect(githubOwner({ display: "acme/web", host: "gitlab.com" })).toBeNull();
    expect(githubOwner({ display: "acme/web", host: "github.example.com" })).toBeNull();
    expect(githubOwner({ display: "../x/web", host: "github.com" })).toBeNull();
    expect(githubOwner(null)).toBeNull();
  });
});

describe("the picture in order", () => {
  test("the one set wins over the repo's logo, which wins over GitHub; the switches decide the last two", async () => {
    const gh = fakeGithub(() => picture(PNG_B));
    const pictures = createProjectPictures({ dir: join(scratch, "data"), fetch: gh.fetch });
    const project = { id: "prj_a", root: repo({ "favicon.svg": SVG }) };
    const all = { logo: true, github: true, repo: () => GITHUB };
    expect((await pictures.get(project, all))?.from).toBe("repo");
    expect((await pictures.get(project, { ...all, logo: false }))?.from).toBe("github");
    expect(await pictures.get(project, { ...all, logo: false, github: false })).toBeNull();
    expect(pictures.setUpload("prj_a", PNG).ok).toBe(true);
    expect((await pictures.get(project, all))?.from).toBe("upload");
    expect(pictures.removeUpload("prj_a")).toBe(true);
    expect((await pictures.get(project, all))?.from).toBe("repo");
    // A project with no logo and GitHub off: none, so the letters show.
    expect(await pictures.get({ id: "prj_b", root: repo({}) }, { ...all, github: false })).toBeNull();
  });

  test("the switch off never asks GitHub, nor reads the remote; another host never asks either", async () => {
    const gh = fakeGithub(() => picture(PNG));
    const pictures = createProjectPictures({ dir: join(scratch, "data"), fetch: gh.fetch });
    let readRepo = 0;
    const project = { id: "prj_a", root: repo({}) };
    await pictures.get(project, { logo: true, github: false, repo: () => (readRepo++, GITHUB) });
    expect(readRepo).toBe(0);
    expect(await pictures.get(project, { logo: false, github: true, repo: () => ({ display: "team/infra", host: "gitlab.com" }) })).toBeNull();
    expect(gh.calls).toEqual([]);
  });
});

describe("which pictures a read may use", () => {
  // The list dialog's Detailed card draws a look the person has not saved: with `logo=1` it shows the repo's logo
  // (a local file), but a request never turns GitHub on, so a page never makes the Inbox ask GitHub by itself.
  test("the saved switches, plus the repo's logo when the window asks for it; GitHub only from the saved switch", () => {
    const q = (query: string) => new URLSearchParams(query);
    expect(pictureSources([], q("v=0-10"))).toEqual({ logo: false, github: false });
    expect(pictureSources([], q("v=0-10&logo=1"))).toEqual({ logo: true, github: false });
    expect(pictureSources(["repoLogo"], q("v=0-10"))).toEqual({ logo: true, github: false });
    expect(pictureSources([], q("logo=1&github=1&githubPictures=1"))).toEqual({ logo: true, github: false });
    expect(pictureSources(["githubPictures"], q(""))).toEqual({ logo: false, github: true });
    expect(pictureSources([], q("logo=true"))).toEqual({ logo: false, github: false });
  });
});

describe("the GitHub picture", () => {
  test("fetched once per owner, from GitHub's picture host at 64 px, kept on disk across restarts", async () => {
    const gh = fakeGithub(() => picture(PNG));
    const dir = join(scratch, "data");
    const pictures = createProjectPictures({ dir, fetch: gh.fetch });
    const use = { logo: false, github: true, repo: () => GITHUB };
    const [a, b] = await Promise.all([pictures.get({ id: "prj_a", root: repo({}) }, use), pictures.get({ id: "prj_b", root: repo({}) }, use)]);
    expect(a?.from).toBe("github");
    expect(b?.body).toEqual(PNG);
    await pictures.get({ id: "prj_a", root: repo({}) }, use);
    expect(gh.calls).toEqual(["https://avatars.githubusercontent.com/acme?s=64"]);
    // A new Inbox on the same data dir serves the kept picture without asking.
    const later = fakeGithub(() => picture(PNG_B));
    const again = createProjectPictures({ dir, fetch: later.fetch });
    expect((await again.get({ id: "prj_c", root: repo({}) }, use))?.body).toEqual(PNG);
    expect(later.calls).toEqual([]);
  });

  test("a week later it is fetched again; a failed refresh keeps the old picture; a failure is not retried for an hour", async () => {
    let now = 1_000_000;
    let answer: () => Response = () => picture(PNG);
    const gh = fakeGithub(() => answer());
    const pictures = createProjectPictures({ dir: join(scratch, "data"), fetch: gh.fetch, now: () => now });
    const use = { logo: false, github: true, repo: () => GITHUB };
    const project = { id: "prj_a", root: repo({}) };
    await pictures.get(project, use);
    now += 6 * 24 * 60 * 60 * 1000;
    await pictures.get(project, use);
    expect(gh.calls).toHaveLength(1);
    now += 2 * 24 * 60 * 60 * 1000;
    answer = () => new Response("down", { status: 503 });
    expect((await pictures.get(project, use))?.body).toEqual(PNG);
    expect(gh.calls).toHaveLength(2);
    now += 30 * 60 * 1000;
    await pictures.get(project, use);
    expect(gh.calls).toHaveLength(2);
    now += 31 * 60 * 1000;
    answer = () => picture(PNG_B);
    expect((await pictures.get(project, use))?.body).toEqual(PNG_B);
    expect(gh.calls).toHaveLength(3);
  });

  test("offline with nothing kept: none (the letters); an SVG, a redirect off GitHub or a thrown fetch gives none too", async () => {
    const use = { logo: false, github: true, repo: () => GITHUB };
    const offline = createProjectPictures({ dir: join(scratch, "a"), fetch: async () => Promise.reject(new Error("offline")) });
    expect(await offline.get({ id: "prj_a", root: repo({}) }, use)).toBeNull();
    const svg = createProjectPictures({ dir: join(scratch, "b"), fetch: fakeGithub(() => picture(SVG, "image/svg+xml")).fetch });
    expect(await svg.get({ id: "prj_a", root: repo({}) }, use)).toBeNull();
    const away = fakeGithub(() => new Response(null, { status: 302, headers: { location: "https://evil.example/a.png" } }));
    const redirected = createProjectPictures({ dir: join(scratch, "c"), fetch: away.fetch });
    expect(await redirected.get({ id: "prj_a", root: repo({}) }, use)).toBeNull();
    expect(away.calls).toHaveLength(1);
    // GitHub's own redirect (to /u/<id>) is followed.
    const own = fakeGithub((url) => (url.includes("/u/") ? picture(PNG) : new Response(null, { status: 302, headers: { location: "/u/42?v=4" } })));
    const followed = createProjectPictures({ dir: join(scratch, "d"), fetch: own.fetch });
    expect((await followed.get({ id: "prj_a", root: repo({}) }, use))?.body).toEqual(PNG);
    expect(own.calls).toEqual(["https://avatars.githubusercontent.com/acme?s=64", "https://avatars.githubusercontent.com/u/42?v=4"]);
  });

  describe("under the test sandbox", () => {
    const realFetch = globalThis.fetch;
    afterEach(() => {
      globalThis.fetch = realFetch;
    });
    test("with no fetcher given, nothing is fetched: only a kept picture is served", async () => {
      const tripped: string[] = [];
      globalThis.fetch = (async (url: unknown) => {
        tripped.push(String(url));
        throw new Error("no network in tests");
      }) as unknown as typeof fetch;
      const pictures = createProjectPictures({ dir: join(scratch, "data"), env: { PLANNOTATOR_TEST_SANDBOX: "1" } });
      expect(await pictures.get({ id: "prj_a", root: repo({}) }, { logo: false, github: true, repo: () => GITHUB })).toBeNull();
      expect(tripped).toEqual([]);
    });
  });
});

describe("Set picture…", () => {
  test("an image is kept per project, each time with a newer key; not an image or too big is refused and changes nothing", () => {
    let now = 5;
    const pictures = createProjectPictures({ dir: join(scratch, "data"), now: () => now });
    expect(pictures.uploadedAt("prj_a")).toBeUndefined();
    const first = pictures.setUpload("prj_a", PNG);
    expect(first).toEqual({ ok: true, at: 5 });
    // Set again within the same millisecond: the key still moves, so the window shows the new one.
    expect(pictures.setUpload("prj_a", SVG)).toEqual({ ok: true, at: 6 });
    expect(pictures.setUpload("prj_a", new TextEncoder().encode("<html></html>"))).toEqual({ ok: false, reason: "not_image" });
    expect(pictures.setUpload("prj_a", new Uint8Array(600 * 1024).fill(1))).toEqual({ ok: false, reason: "too_big" });
    // Set picture… takes the five the refusal names: a favicon's ICO is a repo logo only.
    expect(pictures.setUpload("prj_a", ICO)).toEqual({ ok: false, reason: "not_image" });
    expect(pictures.uploadedAt("prj_a")).toBe(6);
    // A new Inbox on the same data dir knows it.
    now = 100;
    expect(createProjectPictures({ dir: join(scratch, "data") }).uploadedAt("prj_a")).toBe(6);
    expect(pictures.removeUpload("prj_a")).toBe(true);
    expect(pictures.uploadedAt("prj_a")).toBeUndefined();
    expect(createProjectPictures({ dir: join(scratch, "data") }).uploadedAt("prj_a")).toBeUndefined();
  });
});
