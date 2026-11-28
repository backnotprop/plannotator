/**
 * Linear hover cards on the server (inbox-linear-cards.ts). What can regress: a Linear link not reaching
 * Linear (or a forge link reaching it), the key leaking anywhere but api.linear.app's authorization header, the
 * answer's fields, the errors (no key, not found, rate limit), one request per issue while fresh, the teams for
 * bare identifiers, and the route's guard. Every Linear answer is a stub; no network.
 */
import { expect, test } from "bun:test";
import { createLinearCards, LINEAR_API_URL, linearRefsRoute, parseLinearRefAnswer, parseLinearTeamsAnswer, withLinearCards } from "./inbox-linear-cards";

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
  // The same identifier again: the cached answer.
  await cards.get(`${LINK}?again`);
  expect(calls).toHaveLength(1);
});

test("another workspace's ENG-123 is not the key's: not found, never the key's issue", async () => {
  const { calls, fetchImpl } = stub(() => ({ body: ISSUE }));
  const cards = createLinearCards({ apiKey: () => "k", fetch: fetchImpl, avatar: async () => null });
  expect(await cards.get("https://linear.app/othercorp/issue/ENG-123")).toMatchObject({ ok: false, error: "not_found" });
  // Its own cache entry: the key's workspace still gets its card.
  expect((await cards.get(LINK))?.ok).toBe(true);
  expect(calls).toHaveLength(2);
});

test("Open in Linear: an issue url that is not an https linear.app link is dropped", async () => {
  const odd = structuredClone(ISSUE);
  odd.data.issue.url = "javascript:alert(1)//linear.app/acme/issue/ENG-123";
  const { fetchImpl } = stub(() => ({ body: odd }));
  // With no usable url the workspace can't be matched either, so no card data reaches the window.
  expect(await createLinearCards({ apiKey: () => "k", fetch: fetchImpl, avatar: async () => null }).get(LINK)).toMatchObject({ ok: false, error: "not_found" });
  expect((parseLinearRefAnswer(odd) as { url: string }).url).toBe("");
});

test("a removed or refused key: no card asked or cached under the old key is shown again", async () => {
  // Removed while a fetch runs: the answer under the old key is dropped and asked again under the new one.
  let key: string | null = "k";
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const asked: (string | null)[] = [];
  const slow = (async (_url: string, init: RequestInit) => {
    asked.push((init.headers as Record<string, string>).authorization);
    await gate;
    return Response.json(ISSUE);
  }) as unknown as typeof fetch;
  const cards = createLinearCards({ apiKey: () => key, fetch: slow, avatar: async () => null });
  const first = cards.get(LINK);
  await new Promise((resolve) => setTimeout(resolve, 0));
  key = null;
  cards.forget();
  release();
  expect(await first).toMatchObject({ ok: false, error: "signed_out" });
  expect(await cards.get(LINK)).toMatchObject({ ok: false, error: "signed_out" });
  expect(asked).toEqual(["k"]);

  // Refused by Linear on a refresh: the good card cached before is not kept.
  let t = 0;
  let revoked = false;
  const { fetchImpl } = stub(() => (revoked ? { status: 401, body: { errors: [{ message: "bad key", extensions: { code: "AUTHENTICATION_ERROR" } }] } } : { body: ISSUE }));
  const later = createLinearCards({ apiKey: () => "k", fetch: fetchImpl, now: () => t, avatar: async () => null });
  expect((await later.get(LINK))?.ok).toBe(true);
  revoked = true;
  t = 61_000; // stale: served once while it refreshes
  expect((await later.get(LINK))?.ok).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(await later.get(LINK)).toMatchObject({ ok: false, error: "signed_out" });
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
  expect(await ok!.json()).toEqual({ serverSession: "sess", workspace: "acme", teams: ["ENG"], key: "accepted" });
  const cross = await linearRefsRoute(new Request("http://127.0.0.1:1/api/inbox/linear-refs", { headers: { host: "127.0.0.1:1", origin: "https://evil.example", "sec-fetch-site": "cross-site" } }), "/api/inbox/linear-refs", linear, "sess", json);
  expect(cross!.status).toBe(403);
  const off = await linearRefsRoute(new Request("http://127.0.0.1:1/api/inbox/linear-refs", { headers: { host: "127.0.0.1:1" } }), "/api/inbox/linear-refs", null, "sess", json);
  expect(await off!.json()).toEqual({ serverSession: "sess", workspace: null, teams: [], key: "none" });
  expect(await linearRefsRoute(new Request("http://127.0.0.1:1/x"), "/x", linear, "sess", json)).toBeNull();
});

test("the route says whether Linear took the key: refused on a 401 or an auth error, none without one, unknown until Linear answers", async () => {
  const json = (body: unknown, status = 200) => Response.json(body, { status });
  const refsOf = async (linear: ReturnType<typeof createLinearCards>) =>
    (await (await linearRefsRoute(new Request("http://127.0.0.1:1/api/inbox/linear-refs", { headers: { host: "127.0.0.1:1" } }), "/api/inbox/linear-refs", linear, "sess", json))!.json()) as { key: string; teams: string[] };
  const refused = stub(() => ({ status: 401, body: { errors: [{ message: "Authentication required", extensions: { code: "AUTHENTICATION_ERROR" } }] } }));
  expect(await refsOf(createLinearCards({ apiKey: () => "not-a-key", fetch: refused.fetchImpl }))).toMatchObject({ key: "refused", teams: [] });
  // Linear's GraphQL can answer 200 with an auth error.
  const authError = stub(() => ({ body: { errors: [{ message: "x", extensions: { code: "AUTHENTICATION_ERROR" } }] } }));
  expect(await refsOf(createLinearCards({ apiKey: () => "k", fetch: authError.fetchImpl }))).toMatchObject({ key: "refused" });
  expect(await refsOf(createLinearCards({ apiKey: () => null, fetch: refused.fetchImpl }))).toMatchObject({ key: "none" });
  const down = createLinearCards({ apiKey: () => "k", fetch: (async () => { throw new Error("offline"); }) as unknown as typeof fetch });
  expect(await refsOf(down)).toMatchObject({ key: "unknown" });
  // A key that reads the teams but is refused one team's issue (403 / FORBIDDEN) is still accepted.
  const partial = stub((body) => (body.query.includes("organization") ? { body: { data: { organization: { urlKey: "acme" }, teams: { nodes: [{ key: "ENG" }] } } } } : { status: 403, body: { errors: [{ message: "Forbidden", extensions: { code: "FORBIDDEN" } }] } }));
  const scoped = createLinearCards({ apiKey: () => "k", fetch: partial.fetchImpl, avatar: async () => null });
  expect(await refsOf(scoped)).toMatchObject({ key: "accepted" });
  expect(await scoped.get(LINK)).toMatchObject({ ok: false });
  expect(await refsOf(scoped)).toMatchObject({ key: "accepted", teams: ["ENG"] });
  // A new key starts over: the old key's refusal is not the new one's.
  let key = "bad";
  let ok = false;
  const switching = stub((body) => (ok ? { body: body.query.includes("organization") ? { data: { organization: { urlKey: "acme" }, teams: { nodes: [{ key: "ENG" }] } } } : ISSUE } : { status: 401, body: {} }));
  const linear = createLinearCards({ apiKey: () => key, fetch: switching.fetchImpl });
  expect(await refsOf(linear)).toMatchObject({ key: "refused" });
  key = "good";
  ok = true;
  linear.forget();
  expect(await refsOf(linear)).toMatchObject({ key: "accepted", teams: ["ENG"] });
});

test("the key goes only to api.linear.app's authorization header: never in an avatar fetch, an answer, a route body or a log line", async () => {
  const KEY = "lin_api_key_must_not_leak_7f3a";
  const seen: { url: string; init?: RequestInit }[] = [];
  let mode: "ok" | "auth" | "throw" = "ok";
  const avatarIssue = structuredClone(ISSUE);
  avatarIssue.data.issue.creator.avatarUrl = "https://public.linear.app/avatars/ada.png";
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    seen.push({ url, init });
    if (url !== LINEAR_API_URL) return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
    if (mode === "throw") throw new Error("network down");
    if (mode === "auth") return Response.json({ errors: [{ message: "Authentication required", extensions: { code: "AUTHENTICATION_ERROR" } }] }, { status: 401 });
    const body = JSON.parse(String(init!.body)) as { query: string };
    return Response.json(body.query.includes("organization") ? { data: { organization: { urlKey: "acme" }, teams: { nodes: [{ key: "ENG" }] } } } : avatarIssue);
  }) as unknown as typeof fetch;
  const logged: string[] = [];
  const consoleMethods = ["log", "info", "warn", "error", "debug"] as const;
  const originals = consoleMethods.map((m) => console[m]);
  for (const m of consoleMethods) console[m] = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
  const answers: unknown[] = [];
  try {
    let t = 0;
    const cards = createLinearCards({ apiKey: () => KEY, fetch: fetchImpl, now: () => (t += 100_000) });
    answers.push(await cards.get(LINK));
    mode = "auth";
    answers.push(await cards.get("https://linear.app/acme/issue/ENG-2"));
    mode = "throw";
    answers.push(await cards.get("https://linear.app/acme/issue/ENG-3"));
    mode = "ok";
    const json = (body: unknown, status = 200) => Response.json(body, { status });
    const route = await linearRefsRoute(new Request("http://127.0.0.1:1/api/inbox/linear-refs", { headers: { host: "127.0.0.1:1" } }), "/api/inbox/linear-refs", cards, "sess", json);
    answers.push(await route!.json());
  } finally {
    consoleMethods.forEach((m, i) => (console[m] = originals[i]!));
  }
  expect((answers[0] as { ok: boolean }).ok).toBe(true);
  const avatarFetches = seen.filter((s) => s.url !== LINEAR_API_URL);
  expect(avatarFetches.map((s) => s.url)).toEqual(["https://public.linear.app/avatars/ada.png"]);
  for (const s of seen) {
    const sent = JSON.stringify({ url: s.url, headers: s.init?.headers ?? null, body: s.init?.body ?? null });
    if (s.url === LINEAR_API_URL) {
      expect((s.init!.headers as Record<string, string>).authorization).toBe(KEY);
      expect(String(s.init!.body)).not.toContain(KEY);
    } else {
      expect(sent).not.toContain(KEY);
    }
  }
  expect(JSON.stringify(answers)).not.toContain(KEY);
  expect(logged.join("\n")).not.toContain(KEY);
});

test("a new key: forget() drops the no-key card and the teams, so the next hover asks Linear with it", async () => {
  const { calls, fetchImpl } = stub((body) => ({ body: body.query.includes("organization") ? { data: { organization: { urlKey: "acme" }, teams: { nodes: [{ key: "ENG" }] } } } : ISSUE }));
  let key: string | null = null;
  const cards = createLinearCards({ apiKey: () => key, fetch: fetchImpl, avatar: async () => null });
  expect(await cards.get(LINK)).toMatchObject({ ok: false, error: "signed_out" });
  expect(await cards.issueRefs()).toBeNull();
  key = "lin_api_new";
  cards.forget();
  expect(await cards.get(LINK)).toMatchObject({ ok: true });
  expect(await cards.issueRefs()).toEqual({ workspace: "acme", teams: ["ENG"] });
  expect(calls).toHaveLength(2);
});
