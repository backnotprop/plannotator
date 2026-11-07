/**
 * A file an agent's message names, opened in the pane and attached when commented on (approval
 * "inbox-file-refs-open-viewer"): the view, raw and attach routes of packages/server/inbox-open-in.ts, called on the
 * route itself with a scratch store. No Inbox starts and nothing launches; every file, the home folder included, is a
 * fixture under a temp folder (never the real home).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { InboxError } from "@plannotator/shared/inbox/schema";
import { createInboxOpenInRoute, type InboxOpenInLauncher } from "./inbox-open-in";

type Json = Record<string, any>;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a1b00000000049454e44ae426082", "hex");

const launcher: InboxOpenInLauncher = {
  platform: "darwin",
  apps: () => [],
  reveal: async () => {
    throw new Error("nothing launches here");
  },
  openWithApp: async () => {
    throw new Error("nothing launches here");
  },
  openWithSystemDefault: async () => {
    throw new Error("nothing launches here");
  },
};

const SESSION = "srv-session";

/**
 * `linkedHome`: the Inbox is given the home folder through a symlink (`/home` -> `/var/home`), and `~/.plannotator` is
 * made only after it starts.
 */
function world(pulls: { threadPulls?: () => string[]; pullFile?: (pull: string, path: string) => Promise<any>; linkedHome?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-refs-")));
  roots.push(root);
  const home = join(root, "home");
  const project = join(root, "project");
  const elsewhere = join(root, "elsewhere");
  for (const dir of [home, join(home, ".ssh"), join(home, ".aws"), join(home, "notes"), project, join(project, "docs"), elsewhere]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(project, "docs", "plan.md"), "# Plan\n\nShip it.\n");
  writeFileSync(join(project, ".env"), "TOKEN=secret\n");
  writeFileSync(join(project, "shot.png"), PNG);
  writeFileSync(join(project, "logo.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  writeFileSync(join(elsewhere, "out.log"), "line one\nline two\n");
  writeFileSync(join(home, "notes", "todo.md"), "- one\n");
  writeFileSync(join(home, ".ssh", "id_ed25519"), "-----BEGIN OPENSSH PRIVATE KEY-----\n");
  writeFileSync(join(home, ".ssh", "id_rsa"), "-----BEGIN RSA PRIVATE KEY-----\n");
  writeFileSync(join(home, ".aws", "credentials"), "[default]\n");
  symlinkSync(join(project, ".env"), join(project, "settings.txt"));
  symlinkSync(join(home, ".ssh", "id_rsa"), join(elsewhere, "key.txt"));
  // Plannotator's own state (tokens, secrets, logs) in the data folder in use and in ~/.plannotator; its plans are documents.
  const data = join(root, "data");
  for (const dir of [join(data, "inbox", "device-secrets"), join(data, "plans"), join(home, ".plannotator", "inbox"), join(project, "src", "keychains"), join(home, "Library", "Keychains")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(data, "inbox", "machines.json"), '{"token":"secret"}\n');
  writeFileSync(join(data, "inbox", "relay.json"), '{"secret":"x"}\n');
  writeFileSync(join(data, "inbox", "device-secrets", "dev_1"), "secret\n");
  writeFileSync(join(data, "config.json"), "{}\n");
  writeFileSync(join(data, "plans", "saved.md"), "# Saved plan\n");
  writeFileSync(join(home, ".plannotator", "inbox", "machines.json"), '{"token":"secret"}\n');
  symlinkSync(join(data, "inbox", "relay.json"), join(elsewhere, "relay.txt"));
  writeFileSync(join(project, "src", "keychains", "index.ts"), "export const keychains = [];\n");
  writeFileSync(join(home, "Library", "Keychains", "login.txt"), "secret\n");

  const givenHome = pulls.linkedHome ? join(root, "home-link") : home;
  if (pulls.linkedHome) {
    symlinkSync(home, givenHome);
    renameSync(join(home, ".plannotator"), join(root, "plannotator-later"));
  }
  const store = InboxStore.open(join(root, "data"));
  const prj = store.ensureProject({ name: "project", root: project });
  const sent = store.sendMessage({ project_id: prj.id, author: { kind: "agent", host: "claude-code", session: "ses_a", name: "Claude Code" }, body: "See docs/plan.md and /tmp/x." });
  const message = sent.message;
  const route = createInboxOpenInRoute({
    store,
    serverSession: SESSION,
    readBody: async (req) => (await req.json()) as Record<string, unknown>,
    json: (body, status = 200) => Response.json(body, { status }),
    localOnly: () => Response.json({ code: "local_only" }, { status: 403 }),
    launcher,
    // Off: opening a file a message names never needs Code review.
    codeReviewOn: () => false,
    shapeRoot: () => null,
    repoRoots: () => [],
    threadPulls: pulls.threadPulls ?? (() => []),
    pullFile: pulls.pullFile ?? (async () => null),
    ownerOrLocal: (_req, via) => via === "local",
    home: givenHome,
  });
  if (pulls.linkedHome) renameSync(join(root, "plannotator-later"), join(home, ".plannotator"));
  const call = async (req: Request, via: "local" | "tailnet" = "local"): Promise<Response> => {
    const path = new URL(req.url).pathname;
    try {
      return (await route(req, path, via))!;
    } catch (error) {
      if (error instanceof InboxError) return Response.json({ code: error.code, error: error.message }, { status: 400 });
      throw error;
    }
  };
  const query = (path: string) => new URLSearchParams({ thread: message.thread_id, message: message.id, path });
  const view = async (path: string, via: "local" | "tailnet" = "local") => {
    const response = await call(new Request(`http://127.0.0.1/api/inbox/open-in/file/view?${query(path)}`), via);
    return { status: response.status, body: (await response.json()) as Json };
  };
  const raw = (path: string) => call(new Request(`http://127.0.0.1/api/inbox/open-in/file/raw?${query(path)}`));
  const attach = async (path: string, messageId = message.id, threadId = message.thread_id) => {
    const response = await call(
      new Request("http://127.0.0.1/api/inbox/open-in/file/attach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ thread: threadId, message: messageId, path, serverSession: SESSION }),
      }),
    );
    return { status: response.status, body: (await response.json()) as Json };
  };
  return { root, home, project, elsewhere, store, message, prj, view, raw, attach };
}

describe("a file a message names: the view", () => {
  test("opens without Code review: a relative path from the project, an absolute path outside it, and a ~ path", async () => {
    const w = world();
    const plan = await w.view("docs/plan.md");
    expect(plan.body).toMatchObject({ found: true, kind: "markdown", contents: "# Plan\n\nShip it.\n" });
    const outside = await w.view(join(w.elsewhere, "out.log"));
    expect(outside.body).toMatchObject({ found: true, contents: "line one\nline two\n" });
    const home = await w.view("~/notes/todo.md");
    expect(home.body).toMatchObject({ found: true, contents: "- one\n" });
    expect((await w.view(join(w.elsewhere, "gone.md"))).body).toMatchObject({ found: false, reason: "missing" });
  });

  test("never a secret: .env, SSH keys and credential stores are refused, as named and through a symlink, and nothing of them is sent", async () => {
    const w = world();
    for (const path of [".env", join(w.project, ".env"), "~/.ssh/id_ed25519", join(w.home, ".ssh", "id_rsa"), "~/.aws/credentials", "settings.txt", join(w.elsewhere, "key.txt")]) {
      const { body } = await w.view(path);
      expect([path, body.found, body.reason, body.contents]).toEqual([path, false, "refused", undefined]);
    }
  });

  test("never Plannotator's own state: the Inbox's tokens and secrets, in the data folder in use and in ~/.plannotator; its saved plans open", async () => {
    const w = world();
    const data = join(w.root, "data");
    for (const path of [
      join(data, "inbox", "machines.json"),
      join(data, "inbox", "relay.json"),
      join(data, "inbox", "device-secrets", "dev_1"),
      join(data, "inbox", "inbox.json"),
      join(data, "config.json"),
      "~/.plannotator/inbox/machines.json",
      join(w.elsewhere, "relay.txt"),
    ]) {
      const { body } = await w.view(path);
      expect([path, body.found, body.contents]).toEqual([path, false, undefined]);
    }
    expect((await w.view(join(data, "plans", "saved.md"))).body).toMatchObject({ found: true, contents: "# Saved plan\n" });
    expect((await w.attach(join(data, "inbox", "machines.json"))).body.code).toBe("attachment_missing");
  });

  test("~/.plannotator made after the Inbox starts, under a home folder that is a symlink, is refused by either spelling", async () => {
    const w = world({ linkedHome: true });
    for (const path of [join(w.home, ".plannotator", "inbox", "machines.json"), join(w.root, "home-link", ".plannotator", "inbox", "machines.json"), "~/.plannotator/inbox/machines.json"]) {
      expect([path, (await w.view(path)).body.found]).toEqual([path, false]);
    }
    expect((await w.view("~/notes/todo.md")).body).toMatchObject({ found: true, contents: "- one\n" });
  });

  test("a folder named keychains in a project opens; the real Keychains folder does not", async () => {
    const w = world();
    expect((await w.view("src/keychains/index.ts")).body).toMatchObject({ found: true, contents: "export const keychains = [];\n" });
    expect((await w.view("~/Library/Keychains/login.txt")).body).toMatchObject({ found: false, reason: "refused" });
  });

  test("never a path on another computer: a UNC path is refused before anything touches it", async () => {
    const w = world();
    for (const path of ["//fileserver/share/plan.md", "//10.255.255.1/c$/x.md"]) expect((await w.view(path)).body).toMatchObject({ found: false, reason: "refused" });
  });

  test("through the tailnet only the owner reads it", async () => {
    const w = world();
    expect((await w.view("docs/plan.md", "tailnet")).status).toBe(403);
  });
});

describe("a file a message names: the bytes of an image", () => {
  test("an image is served by its bytes' type, sandboxed, never sniffed or cached; a secret or a document is not", async () => {
    const w = world();
    const png = await w.raw("shot.png");
    expect(png.status).toBe(200);
    expect(png.headers.get("content-type")).toBe("image/png");
    expect(png.headers.get("x-content-type-options")).toBe("nosniff");
    expect(png.headers.get("content-security-policy")).toContain("sandbox");
    expect(png.headers.get("cache-control")).toBe("no-store");
    expect(Buffer.from(await png.arrayBuffer()).equals(PNG)).toBe(true);
    // An SVG shows as a picture and never runs: its CSP is a sandbox with no script source.
    const svg = await w.raw("logo.svg");
    expect(svg.headers.get("content-type")).toBe("image/svg+xml");
    expect(svg.headers.get("content-security-policy")).toMatch(/^sandbox; default-src 'none'/);
    expect(svg.headers.get("content-security-policy")).not.toContain("script");
    expect((await w.raw("~/.ssh/id_ed25519")).status).toBe(404);
    expect((await w.raw("docs/plan.md")).status).toBe(404);
  });
});

describe("a file a message names, in a thread with a pull request", () => {
  const pr = (contents: string) => ({ threadPulls: () => ["gh:o/r#7"], pullFile: async (_pull: string, path: string) => (path === "docs/plan.md" ? { contents, label: "#7", platform: "github", url: "https://github.com/o/r/pull/7" } : null) });

  test("the view shows the pull request's version; a comment attaches the file here only when it is that text", async () => {
    const differs = world(pr("# Plan\n\nShip it in the PR.\n"));
    const shown = await differs.view("docs/plan.md");
    expect(shown.body).toMatchObject({ found: true, contents: "# Plan\n\nShip it in the PR.\n", local_matches: false, pull: { label: "#7" } });
    expect((await differs.attach("docs/plan.md")).body.code).toBe("annotation_not_allowed");
    expect(differs.store.message(differs.message.id)!.attachments ?? []).toEqual([]);

    const same = world(pr("# Plan\n\nShip it.\n"));
    expect((await same.view("docs/plan.md")).body.local_matches).toBe(true);
    expect((await same.attach("docs/plan.md")).body.attachment).toMatchObject({ name: "plan.md" });
  });
});

describe("a file a message names: attached when commented on", () => {
  test("looking attaches nothing; the comment's attach adds exactly one attachment, once, and the view then names it", async () => {
    const w = world();
    await w.view("docs/plan.md");
    expect(w.store.message(w.message.id)!.attachments ?? []).toEqual([]);

    const first = await w.attach("docs/plan.md");
    expect(first.status).toBe(200);
    expect(first.body.attachment).toMatchObject({ name: "plan.md", kind: "markdown", path: join(w.project, "docs", "plan.md"), message_id: w.message.id });
    const again = await w.attach("./docs/plan.md");
    expect(again.body.attachment.id).toBe(first.body.attachment.id);

    const attachments = w.store.message(w.message.id)!.attachments ?? [];
    expect(attachments.map((a) => a.id)).toEqual([first.body.attachment.id]);
    // Its sent version is kept, as an agent's attachment's is.
    expect(attachments[0]!.sent_sha256).toMatch(/^[0-9a-f]{64}$/);
    // A comment on it is saved like any attachment's.
    const record = w.store.saveAnnotation({ attachment_id: first.body.attachment.id, version: "current", annotation: { id: "ann-1", blockId: "b1", type: "COMMENT", text: "Why?", originalText: "Ship it." } });
    expect(record.attachment_id).toBe(first.body.attachment.id);
    expect((await w.view("docs/plan.md")).body.attachment_id).toBe(first.body.attachment.id);
    // Reopened from disk, still one.
    expect(InboxStore.open(join(w.root, "data")).message(w.message.id)!.attachments!.length).toBe(1);
  });

  test("a file outside the project attaches; a secret, a missing file and the person's own message do not", async () => {
    const w = world();
    expect((await w.attach(join(w.elsewhere, "out.log"))).body.attachment).toMatchObject({ name: "out.log" });
    expect((await w.attach(".env")).body.code).toBe("attachment_missing");
    expect((await w.attach("~/.ssh/id_rsa")).body.code).toBe("attachment_missing");
    expect((await w.attach("settings.txt")).body.code).toBe("attachment_missing");
    expect((await w.attach("docs/nope.md")).body.code).toBe("attachment_missing");
    const person = w.store.startPersonThread({ project_id: w.prj.id, body: "Mine: docs/plan.md", to: { host: "claude-code", session: "ses_a" }, idempotency_key: "k-1" }).message;
    // The person's own words keep their links as they are: never an attachment of their message.
    expect((await w.attach("docs/plan.md", person.id, person.thread_id)).body.code).toBe("validation_error");
    // A message named with another thread brings nothing.
    expect((await w.attach("docs/plan.md", person.id)).body.code).toBe("message_not_found");
    expect((w.store.message(w.message.id)!.attachments ?? []).map((a) => a.name)).toEqual(["out.log"]);
  });

  test("a resolved thread takes no attach, and keeps no copy of the file", async () => {
    const w = world();
    const blobs = join(w.root, "data", "inbox", "blobs");
    const before = existsSync(blobs) ? readdirSync(blobs, { recursive: true }).length : 0;
    w.store.resolveThread(w.message.thread_id, true, "person");
    expect((await w.attach("docs/plan.md")).body.code).toBe("thread_resolved");
    expect(existsSync(blobs) ? readdirSync(blobs, { recursive: true }).length : 0).toBe(before);
  });
});
