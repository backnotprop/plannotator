/**
 * `plannotator inbox call fetch_file` on this computer (inbox-call-far-fetch.ts): it asks this computer's Inbox for a
 * linked machine's file, with the registry's token, and saves the streamed bytes itself. What regresses: the folder
 * sent to the Inbox (the Inbox would write where the caller names), a dotenv name that passes as sent but is one as
 * saved, a file past 100 MB, cut short, stalled or not matching its SHA-256 left on disk, a folder that cannot be made
 * leaving the stream open, an extra field passed on, an older Inbox's 404 read as a missing file, a refusal's words lost.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchFarFile } from "./inbox-call-far-fetch";

const entry = { port: 4321, token: "registry-token" };
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const scratch = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-far-fetch-cli-")));
  roots.push(dir);
  return dir;
};

/** A stand-in Inbox: what it was asked, and its answer. */
function inbox(answer: () => Response) {
  const asked: { url: string; auth: string | null; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    asked.push({ url, auth: new Headers(init.headers).get("authorization"), body: JSON.parse(String(init.body)) });
    return answer();
  }) as unknown as typeof fetch;
  return { asked, fetchImpl };
}

/** The Inbox's streamed file: its bytes (or a stream), and the headers it names them with. */
function streamed(body: BodyInit, file: { name: string; size: number; sha256: string }, onCancel?: () => void): Response {
  const stream =
    onCancel && typeof body === "string"
      ? new ReadableStream<Uint8Array>({ start: (c) => c.enqueue(new TextEncoder().encode(body)), cancel: onCancel })
      : body;
  return new Response(stream, {
    headers: {
      "Content-Type": "text/markdown",
      "X-Plannotator-File-Name": encodeURIComponent(file.name),
      "X-Plannotator-File-Size": String(file.size),
      "X-Plannotator-File-Sha256": file.sha256,
      "X-Plannotator-File-Machine": "ibx_1",
    },
  });
}
const plan = (name = "plan.md", text = "# Plan\n") => ({ name, size: Buffer.byteLength(text), sha256: sha(text) });

describe("fetch_file on this computer", () => {
  test("asks this computer's Inbox with its token and no folder, and saves the bytes itself, in the folder it was given", async () => {
    const cwd = scratch();
    const stub = inbox(() => streamed("# Plan\n", plan()));
    const got = await fetchFarFile({ message_id: "msg_1", file: "att_1", folder: "out" }, cwd, entry, stub.fetchImpl);
    expect(got).toEqual({ ok: true, saved: { path: join(cwd, "out", "plan.md"), name: "plan.md", size: 7, sha256: sha("# Plan\n"), content_type: "text/markdown", machine: "ibx_1" } });
    expect(readFileSync(join(cwd, "out", "plan.md"), "utf8")).toBe("# Plan\n");
    // The Inbox is told which file, never where: the folder is this command's.
    expect(stub.asked).toEqual([{ url: "http://127.0.0.1:4321/api/inbox/control/machines/fetch-file", auth: "Bearer registry-token", body: { message_id: "msg_1", file: "att_1" } }]);
  });

  test("with no folder, a new folder in this process's own temp folder", async () => {
    const tmp = scratch();
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = tmp;
    try {
      const got = await fetchFarFile({ message_id: "msg_1", file: "att_1" }, "/", entry, inbox(() => streamed("# Plan\n", plan())).fetchImpl);
      expect(got.ok && got.saved.path.startsWith(join(tmp, "plannotator-file-"))).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
    }
  });

  test("a name that is a dotenv one as saved is refused here, whatever the Inbox passed on: no file, the stream let go", async () => {
    for (const name of [".env ", " .envrc", "x.env.", "notes.env . "]) {
      const cwd = scratch();
      let cancelled = false;
      const got = await fetchFarFile({ message_id: "msg_1", file: "att_1", folder: "." }, cwd, entry, inbox(() => streamed("SECRET=1", plan(name, "SECRET=1"), () => (cancelled = true))).fetchImpl);
      expect(got).toMatchObject({ ok: false, code: "attachment_refused" });
      expect(readdirSync(cwd)).toEqual([]);
      expect(cancelled).toBe(true);
    }
  });

  test("past 100 MB, cut short, longer than named, stalled or not matching: nothing is left, in the words for each", async () => {
    const cwd = scratch();
    const run = (answer: () => Response, stallMs?: number) => fetchFarFile({ message_id: "msg_1", file: "att_1", folder: "." }, cwd, entry, inbox(answer).fetchImpl, stallMs ? { stallMs } : {});
    expect(await run(() => streamed("x", { name: "shot.png", size: 240 * 1024 * 1024, sha256: sha("x") }))).toEqual({ ok: false, code: "file_too_large", message: "shot.png is 240 MB; an agent fetches a file of at most 100 MB." });
    expect(await run(() => streamed("half", { name: "shot.png", size: 100, sha256: sha("x") }))).toEqual({ ok: false, code: "machine_offline", message: "The other computer stopped sending shot.png. Nothing was saved; fetch it again." });
    expect(await run(() => streamed("longer than named", { name: "a.txt", size: 3, sha256: sha("lon") }))).toMatchObject({ ok: false, code: "fetch_mismatch" });
    expect(await run(() => streamed("same size", { name: "a.txt", size: 9, sha256: sha("othersize") }))).toMatchObject({ ok: false, code: "fetch_mismatch" });
    const stall = new ReadableStream<Uint8Array>({ start: (c) => c.enqueue(new TextEncoder().encode("half")) });
    expect(await run(() => streamed(stall, { name: "shot.png", size: 100, sha256: sha("x") }), 30)).toMatchObject({ ok: false, code: "machine_offline" });
    const broken = new ReadableStream<Uint8Array>({ start: (c) => (c.enqueue(new TextEncoder().encode("half")), c.error(new Error("reset"))) });
    expect(await run(() => streamed(broken, { name: "shot.png", size: 100, sha256: sha("x") }))).toMatchObject({ ok: false, code: "machine_offline" });
    expect(readdirSync(cwd)).toEqual([]);
  });

  test("a folder that cannot be made says why, and lets the stream go", async () => {
    const cwd = scratch();
    writeFileSync(join(cwd, "taken"), "a file, not a folder");
    let cancelled = false;
    const got = await fetchFarFile({ message_id: "msg_1", file: "att_1", folder: "taken/out" }, cwd, entry, inbox(() => streamed("# Plan\n", plan(), () => (cancelled = true))).fetchImpl);
    expect(got).toMatchObject({ ok: false, code: "fetch_unwritable" });
    expect((got as { message: string }).message).toStartWith("Could not save the file here: ");
    expect(cancelled).toBe(true);
  });

  test("refusals keep their code and words; an older Inbox says to restart it; an extra field is refused before asking", async () => {
    const refused = inbox(() => Response.json({ code: "machine_offline", error: "Mini cannot be reached now." }, { status: 400 }));
    expect(await fetchFarFile({ message_id: "msg_1", file: "att_1" }, "/w", entry, refused.fetchImpl)).toEqual({ ok: false, code: "machine_offline", message: "Mini cannot be reached now." });
    const older = inbox(() => Response.json({ code: "not_found", error: "Not found" }, { status: 404 }));
    expect(await fetchFarFile({ message_id: "msg_1", file: "att_1" }, "/w", entry, older.fetchImpl)).toMatchObject({ ok: false, code: "inbox_too_old" });
    const none = inbox(() => Response.json({}));
    expect(await fetchFarFile({ message_id: "msg_1", file: "att_1", offset: 3 }, "/w", entry, none.fetchImpl)).toMatchObject({ ok: false, code: "invalid_arguments" });
    expect(none.asked).toEqual([]);
  });
});
