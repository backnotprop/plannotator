import { describe, expect, it } from "bun:test";
import { removeShareBeforeDelete } from "./share";

const share = { id: "g_abc", url: "https://guides.show/g/g_abc#key=k", deleteToken: "tok", serviceUrl: "https://guides.example" };

function fakeFetch(status: number, seen: Array<{ url: string; init?: RequestInit }>): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init });
    return new Response(status === 204 ? null : JSON.stringify({ error: "boom" }), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

describe("removing a guide's share link before deleting it", () => {
  it("deletes the link on the host the record names, with its token", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    expect(await removeShareBeforeDelete(share, fakeFetch(204, seen))).toEqual({ ok: true });
    expect(seen[0].url).toBe("https://guides.example/api/g/g_abc");
    expect(seen[0].init?.method).toBe("DELETE");
    expect(new Headers(seen[0].init?.headers).get("authorization")).toBe("Bearer tok");
  });

  it("treats a link the host no longer has as removed", async () => {
    expect(await removeShareBeforeDelete(share, fakeFetch(404, []))).toEqual({ ok: true });
  });

  it("reports any other failure with the command that removes the link later", async () => {
    const r = await removeShareBeforeDelete(share, fakeFetch(500, []));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.url).toBe(share.url);
    expect(r.command).toBe("plannotator guide unshare g_abc --token tok");
  });

  it("has nothing to do for a guide that was never shared", async () => {
    expect(await removeShareBeforeDelete(undefined)).toEqual({ ok: true });
  });
});
