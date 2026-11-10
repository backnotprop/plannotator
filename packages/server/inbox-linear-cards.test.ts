/**
 * Linear hover cards on the server (inbox-linear-cards.ts). What can regress: a Linear link not reaching
 * Linear (or a forge link reaching it), the key leaking anywhere but api.linear.app's authorization header, the
 * answer's fields, the errors (no key, not found, rate limit), one request per issue while fresh, the teams for
 * bare identifiers, and the route's guard. Every Linear answer is a stub; no network.
 */
import { expect, test } from "bun:test";
import { createLinearCards, LINEAR_API_URL, linearRefsRoute, parseLinearTeamsAnswer, withLinearCards } from "./inbox-linear-cards";

const ISSUE = {
  data: {
    issue: {
      identifier: "ENG-123",
      number: 123,
      title: "Retry webhook deliveries",
      url: "https://linear.app/acme/issue/ENG-123/retry-webhook-deliveries",
      description: "Deliveries that time out are dropped.",
      priorityLabel: "High",
      priority: 2,
      estimate: 3,
      createdAt: "2026-11-01T10:00:00.000Z",
      updatedAt: "2026-11-09T10:00:00.000Z",
      completedAt: null,
      canceledAt: null,
      state: { name: "In Review", type: "started", color: "#0F783C" },
      team: { key: "ENG", name: "Engineering" },
      project: { name: "Webhooks" },
      creator: { displayName: "ada", name: "Ada Example", avatarUrl: "https://evil.example/a.png" },
      assignee: { displayName: "bo", name: "Bo Example", avatarUrl: null },
      labels: { nodes: [{ name: "Bug", color: "#eb5757" }] },
      comments: { nodes: [{ body: "On it.", createdAt: "2026-11-09T09:00:00.000Z", user: { displayName: "bo" } }] },
      allComments: { nodes: [{ id: "1" }, { id: "2" }] },
      attachments: { nodes: [{ url: "https://github.com/acme/api/pull/7", title: "Retry", sourceType: "github", metadata: { number: 7, status: "merged", title: "Retry deliveries" } }] },
    },
  },
};

function stub(answer: (body: { query: string; variables: Record<string, string> }) => { status?: number; body: unknown }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const a = answer(JSON.parse(String(init.body)));
    return new Response(JSON.stringify(a.body), { status: a.status ?? 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const LINK = "https://linear.app/acme/issue/ENG-123/retry-webhook-deliveries";

test("a Linear link: one query with the key as is, the card's fields, fresh answers shared", async () => {
  const { calls, fetchImpl } = stub(() => ({ body: ISSUE }));
  const cards = createLinearCards({ apiKey: () => "lin_api_test", fetch: fetchImpl, avatar: async () => null });
  const result = await cards.get(LINK);
  expect(result?.ok).toBe(true);
  if (!result?.ok) throw new Error("no card");
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe(LINEAR_API_URL);
  expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("lin_api_test");
  expect(JSON.parse(String(calls[0]!.init.body)).variables).toEqual({ id: "ENG-123" });
  const data = result.data as unknown as { platform: string; repo: string; linear: Record<string, unknown>; linked: unknown[]; comments: number; author: { avatarUrl: string | null } };
  expect(data.platform).toBe("linear");
  expect(data.repo).toBe("ENG");
  expect(data.linear).toMatchObject({ identifier: "ENG-123", team: "Engineering", stateName: "In Review", stateType: "started", stateColor: "0f783c", priority: "High", project: "Webhooks", estimate: 3 });
  expect(data.linked).toEqual([{ number: 7, title: "Retry deliveries", url: "https://github.com/acme/api/pull/7", state: "merged" }]);
  expect(data.comments).toBe(2);
  // An avatar off Linear's own hosts is never fetched.
  expect(data.author.avatarUrl).toBeNull();
  // Another workspace key, the same identifier: one issue, the cached answer.
  await cards.get("https://linear.app/other/issue/ENG-123");
  expect(calls).toHaveLength(1);
});

test("not a Linear link: null, and withLinearCards hands it to the forge cards", async () => {
  const { calls, fetchImpl } = stub(() => ({ body: ISSUE }));
  const linear = createLinearCards({ apiKey: () => "k", fetch: fetchImpl, avatar: async () => null });
  expect(await linear.get("https://github.com/acme/api/pull/7")).toBeNull();
  expect(await linear.get("http://linear.app/acme/issue/ENG-1")).toBeNull();
  const forge: string[] = [];
  const cards = withLinearCards({ get: async (href: string) => (forge.push(href), { ok: false as const, error: "unsupported" as const, fetchedAt: 0 }) }, linear);
  await cards.get("https://github.com/acme/api/pull/7");
  await cards.get(LINK);
  expect(forge).toEqual(["https://github.com/acme/api/pull/7"]);
  expect(calls).toHaveLength(1);
  // No Linear source: the forge cards as they were.
  const plain = { get: async () => null };
  expect(withLinearCards(plain, null)).toBe(plain);
});

test("errors: no key is signed_out without a request; not found; a rate limit pauses Linear", async () => {
  const none = stub(() => ({ body: ISSUE }));
  expect(await createLinearCards({ apiKey: () => null, fetch: none.fetchImpl }).get(LINK)).toMatchObject({ ok: false, error: "signed_out" });
  expect(none.calls).toHaveLength(0);
  const missing = stub(() => ({ body: { data: { issue: null } } }));
  expect(await createLinearCards({ apiKey: () => "k", fetch: missing.fetchImpl }).get(LINK)).toMatchObject({ ok: false, error: "not_found" });
  let t = 0;
  const limited = stub(() => ({ status: 429, body: { errors: [{ message: "slow down", extensions: { code: "RATELIMITED" } }] } }));
  const cards = createLinearCards({ apiKey: () => "k", fetch: limited.fetchImpl, now: () => t });
  expect(await cards.get(LINK)).toMatchObject({ ok: false, error: "rate_limited" });
  t = 31_000; // past the failure's 30 s, inside the 60 s pause
  expect(await cards.get("https://linear.app/acme/issue/ENG-124")).toMatchObject({ ok: false, error: "rate_limited" });
  expect(limited.calls).toHaveLength(1);
});

test("teams for bare identifiers, and the route with its guard", async () => {
  const { fetchImpl } = stub((body) => ({ body: body.query.includes("organization") ? { data: { organization: { urlKey: "acme" }, teams: { nodes: [{ key: "ENG" }, { key: "bad key" }] } } } : ISSUE }));
  const linear = createLinearCards({ apiKey: () => "k", fetch: fetchImpl });
  expect(await linear.issueRefs()).toEqual({ workspace: "acme", teams: ["ENG"] });
  expect(parseLinearTeamsAnswer({ data: {} })).toBeNull();
  const json = (body: unknown, status = 200) => Response.json(body, { status });
  const ok = await linearRefsRoute(new Request("http://127.0.0.1:1/api/inbox/linear-refs", { headers: { host: "127.0.0.1:1" } }), "/api/inbox/linear-refs", linear, "sess", json);
  expect(await ok!.json()).toEqual({ serverSession: "sess", workspace: "acme", teams: ["ENG"] });
  const cross = await linearRefsRoute(new Request("http://127.0.0.1:1/api/inbox/linear-refs", { headers: { host: "127.0.0.1:1", origin: "https://evil.example", "sec-fetch-site": "cross-site" } }), "/api/inbox/linear-refs", linear, "sess", json);
  expect(cross!.status).toBe(403);
  const off = await linearRefsRoute(new Request("http://127.0.0.1:1/api/inbox/linear-refs", { headers: { host: "127.0.0.1:1" } }), "/api/inbox/linear-refs", null, "sess", json);
  expect(await off!.json()).toEqual({ serverSession: "sess", workspace: null, teams: [] });
  expect(await linearRefsRoute(new Request("http://127.0.0.1:1/x"), "/x", linear, "sess", json)).toBeNull();
});
