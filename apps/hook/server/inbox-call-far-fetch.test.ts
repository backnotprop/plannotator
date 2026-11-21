/**
 * `plannotator inbox call fetch_file` on this computer (inbox-call-far-fetch.ts): it asks this computer's Inbox to
 * save a linked machine's file, with the registry's token. What regresses: a relative folder sent as the Inbox's own
 * folder, an extra field passed on, an older Inbox's 404 read as a missing file, a refusal's words lost.
 */
import { describe, expect, test } from "bun:test";
import { fetchFarFile } from "./inbox-call-far-fetch";

const entry = { port: 4321, token: "registry-token" };

/** A stand-in Inbox: what it was asked, and its answer. */
function inbox(status: number, body: unknown) {
  const asked: { url: string; auth: string | null; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    asked.push({ url, auth: new Headers(init.headers).get("authorization"), body: JSON.parse(String(init.body)) });
    return Response.json(body, { status });
  }) as unknown as typeof fetch;
  return { asked, fetchImpl };
}

describe("fetch_file on this computer", () => {
  test("asks this computer's Inbox with its token, the folder made absolute, and prints where it saved", async () => {
    const saved = { path: "/tmp/plannotator-file-x/plan.md", name: "plan.md", size: 3, sha256: "a".repeat(64), content_type: "text/markdown", machine: "ibx_1" };
    const stub = inbox(200, { saved });
    const got = await fetchFarFile({ message_id: "msg_1", file: "att_1", folder: "out" }, "/work/repo", entry, stub.fetchImpl);
    expect(got).toEqual({ ok: true, saved });
    expect(stub.asked).toEqual([{ url: "http://127.0.0.1:4321/api/inbox/control/machines/fetch-file", auth: "Bearer registry-token", body: { message_id: "msg_1", file: "att_1", folder: "/work/repo/out" } }]);
  });

  test("refusals keep their code and words; an older Inbox says to restart it; an extra field is refused before asking", async () => {
    const refused = inbox(400, { code: "machine_offline", error: "Mini cannot be reached now." });
    expect(await fetchFarFile({ message_id: "msg_1", file: "att_1" }, "/w", entry, refused.fetchImpl)).toEqual({ ok: false, code: "machine_offline", message: "Mini cannot be reached now." });
    const older = inbox(404, { code: "not_found", error: "Not found" });
    expect(await fetchFarFile({ message_id: "msg_1", file: "att_1" }, "/w", entry, older.fetchImpl)).toMatchObject({ ok: false, code: "inbox_too_old" });
    const none = inbox(200, {});
    expect(await fetchFarFile({ message_id: "msg_1", file: "att_1", offset: 3 }, "/w", entry, none.fetchImpl)).toMatchObject({ ok: false, code: "invalid_arguments" });
    expect(none.asked).toEqual([]);
  });
});
