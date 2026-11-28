/**
 * The "Keep this space" sign-in against the stand-in, which answers `/cli/login`, `/cli/token` and `GET /v1/me` as the
 * service does (tests/helpers/fake-spaces.ts). The only socket is the sign-in's own listener on 127.0.0.1. What
 * regresses if these fail:
 * - the code is traded in a shape the service refuses (JSON, a missing `grant_type`, a way back that is not the one
 *   the login page got), so every sign-in ends "Sign-in did not finish";
 * - a code is traded twice (the service spends it on the first try, so a second load of the page or a retry fails);
 * - an account with no name, or a name that cannot be read, fails a sign-in that worked;
 * - the token leaks into a URL, or the exchange carries an Origin, a cookie or an Authorization header;
 * - the connect page is not told who asks (`client_name`, without which the space never sends a Cancel back), which
 *   space it keeps, or which approval goes with it; or the way back is misread: a Cancel taken for a failure, a claim
 *   someone else won taken for a sign-in, an approval outcome lost or made up.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createFakeSpaces } from "../../../tests/helpers/fake-spaces";
import { startSpacesSignIn, type SpacesKeepAsk, type SpacesSignIn } from "./signin";

const HOST = "http://127.0.0.1:1";
const open: SpacesSignIn[] = [];
afterEach(() => {
  for (const signIn of open.splice(0)) signIn.cancel();
});

async function signInWith(spaces: ReturnType<typeof createFakeSpaces>, doFetch: typeof fetch = spaces.fetch, keep?: SpacesKeepAsk) {
  const signIn = await startSpacesSignIn({ host: HOST, fetch: doFetch, keep });
  open.push(signIn);
  // The "browser": the login page sends it back to this computer's listener.
  const login = await spaces.fetch(signIn.url, { redirect: "manual" });
  const back = login.headers.get("location");
  const landed = back?.includes("/callback") ? await fetch(back) : null;
  if (!landed) signIn.cancel();
  const result = await signIn.done;
  return { signIn, login, back, landed, result, credential: result.kind === "signed_in" ? result.credential : null };
}

/** A space with one page, made with no account, as a share leaves it: its id, the page's id and version. */
async function sharedSpace(spaces: ReturnType<typeof createFakeSpaces>) {
  const made = await spaces.fetch(`${HOST}/v1/workspaces`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: "ws_01JZ0000000000000000000001", name: "Plan", document: { path: "plan.md", body: "# Plan\n" } }) });
  const body = (await made.json()) as { workspace: { id: string }; document: { id: string; version: string } };
  return { space: body.workspace.id, doc: body.document.id, version: body.document.version };
}

describe("the sign-in", () => {
  test("trades the code once, as a form with the same way back, and reads the name from the account", async () => {
    const spaces = createFakeSpaces({ origin: HOST });
    const { signIn, login, landed, credential } = await signInWith(spaces);
    expect(login.status).toBe(302);
    expect(landed!.status).toBe(200);
    expect(credential).toMatchObject({ name: "Maya Chen" });
    expect(credential!.token).toMatch(/^wscli_live_/);
    expect(spaces.exchanges).toHaveLength(1);
    const exchange = spaces.exchanges[0]!;
    expect(exchange.contentType.split(";")[0]).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(exchange.body);
    expect([...form.keys()].sort()).toEqual(["code", "code_verifier", "grant_type", "redirect_uri"]);
    expect(form.get("grant_type")).toBe("authorization_code");
    // Byte for byte the string the login page got, at 127.0.0.1 literally.
    expect(form.get("redirect_uri")).toBe(new URL(signIn.url).searchParams.get("redirect_uri"));
    expect(form.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(form.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect([exchange.origin, exchange.cookie, exchange.authorization]).toEqual([null, null, null]);
    expect(signIn.url).not.toContain(credential!.token);
    expect(signIn.url).not.toContain(form.get("code_verifier")!);
    expect(spaces.calls.some((c) => `${c.path}${c.query}`.includes(credential!.token))).toBe(false);
  });

  test("a second load of the page trades nothing and is not found", async () => {
    const spaces = createFakeSpaces({ origin: HOST });
    const { back, credential } = await signInWith(spaces);
    expect(credential).not.toBeNull();
    const again = await fetch(back!).catch(() => null);
    // The listener closed with the first load; if it still answered, it answers not found.
    if (again) expect(again.status).toBe(404);
    expect(spaces.exchanges).toHaveLength(1);
  });

  test("a code the space refuses ends the sign-in with no second try", async () => {
    const spaces = createFakeSpaces({ origin: HOST });
    // The page is loaded, and its code spent elsewhere first (another tab, a reload): the one try here fails.
    const spent: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/cli/token")) {
        const first = await spaces.fetch(input, init);
        expect(first.status).toBe(200);
        return spaces.fetch(input, init);
      }
      return spaces.fetch(input, init);
    }) as typeof fetch;
    const { landed, credential } = await signInWith(spaces, spent);
    expect(credential).toBeNull();
    expect(landed!.status).toBe(400);
    // The stand-in's own first lookup, then the one from the sign-in: never a third.
    expect(spaces.exchanges).toHaveLength(2);
  });

  test("an account with no name, or a name that cannot be read, still signs in, with no name", async () => {
    const nameless = createFakeSpaces({ origin: HOST, nameless: true });
    expect((await signInWith(nameless)).credential).toMatchObject({ name: null, token: expect.stringMatching(/^wscli_live_/) });

    const spaces = createFakeSpaces({ origin: HOST });
    spaces.failNext(/^GET \/v1\/me$/, 500, "internal_error");
    expect((await signInWith(spaces)).credential).toMatchObject({ name: null, token: expect.stringMatching(/^wscli_live_/) });

    const offline = createFakeSpaces({ origin: HOST });
    offline.failNext(/^GET \/v1\/me$/, 0, "offline");
    expect((await signInWith(offline)).credential).toMatchObject({ name: null, token: expect.stringMatching(/^wscli_live_/) });
  });
});

describe("the connect page", () => {
  test("always names the tool; names the space and the approval only when asked, and an approval only with its space", async () => {
    const spaces = createFakeSpaces({ origin: HOST });
    const plain = new URL((await signInWith(spaces)).signIn.url);
    expect(plain.searchParams.get("client_name")).toBe("Plannotator");
    expect(["space", "approve_document", "approve_version"].filter((k) => plain.searchParams.has(k))).toEqual([]);

    const { space, doc, version } = await sharedSpace(spaces);
    const kept = new URL((await signInWith(spaces, spaces.fetch, { space, approve: { document: doc, version } })).signIn.url);
    expect([kept.searchParams.get("client_name"), kept.searchParams.get("space"), kept.searchParams.get("approve_document"), kept.searchParams.get("approve_version")]).toEqual(["Plannotator", space, doc, version]);

    const loose = new URL((await signInWith(spaces, spaces.fetch, { approve: { document: doc, version } })).signIn.url);
    expect(["space", "approve_document", "approve_version"].filter((k) => loose.searchParams.has(k))).toEqual([]);
  });

  test("Cancel on the page: cancelled, quietly, with nothing traded", async () => {
    const spaces = createFakeSpaces({ origin: HOST, consent: "cancel" });
    const { back, landed, result } = await signInWith(spaces);
    expect(new URL(back!).searchParams.get("error")).toBe("access_denied");
    expect(landed!.status).toBe(200);
    expect(result).toEqual({ kind: "cancelled" });
    expect(spaces.exchanges).toHaveLength(0);
  });

  test("a space taken by someone else between the page and the press: the claim is lost, no token and nothing traded", async () => {
    const spaces = createFakeSpaces({ origin: HOST, login: "page" });
    const { space, doc, version } = await sharedSpace(spaces);
    const signIn = await startSpacesSignIn({ host: HOST, fetch: spaces.fetch, keep: { space, approve: { document: doc, version } } });
    open.push(signIn);
    // The page is drawn while the space is still free ("becomes your space"); someone else keeps it before the press.
    const page = await (await spaces.fetch(signIn.url)).text();
    spaces.keptBy(space, "Someone Else");
    const press = await spaces.fetch(`${HOST}${/href="(\/cli\/login\/allow[^"]+)"/.exec(page)![1]}`, { redirect: "manual" });
    const back = press.headers.get("location")!;
    expect(new URL(back).searchParams.has("code")).toBe(false);
    await fetch(back);
    expect(await signIn.done).toEqual({ kind: "claim_conflict" });
    expect(spaces.exchanges).toHaveLength(0);
    expect(spaces.spaces.get(space)!.owner).toBe("Someone Else");
    expect(spaces.spaces.get(space)!.approvals).toHaveLength(0);
  });

  test("a space someone else owns when the page is drawn: the plain connect, a sign-in with no claim, and the approval asked answered none", async () => {
    const spaces = createFakeSpaces({ origin: HOST });
    const { space, doc, version } = await sharedSpace(spaces);
    spaces.keptBy(space, "Someone Else");
    const { back, result } = await signInWith(spaces, spaces.fetch, { space, approve: { document: doc, version } });
    expect([...new URL(back!).searchParams.entries()].filter(([k]) => k !== "code" && k !== "state")).toEqual([["approval", "none"]]);
    // A sign-in, not a Keep: the space is still the other person's, and nothing was approved.
    expect(result).toMatchObject({ kind: "signed_in", approval: "none" });
    expect(spaces.spaces.get(space)!.owner).toBe("Someone Else");
    expect(spaces.spaces.get(space)!.approvals).toHaveLength(0);
  });

  test("a named space is claimed on the page, and the approval's outcome comes back: recorded, moved, or none", async () => {
    const spaces = createFakeSpaces({ origin: HOST });
    const { space, doc, version } = await sharedSpace(spaces);
    const recorded = await signInWith(spaces, spaces.fetch, { space, approve: { document: doc, version } });
    expect(recorded.result).toMatchObject({ kind: "signed_in", approval: "recorded", credential: { name: "Maya Chen" } });
    expect(spaces.spaces.get(space)!.owner).toBe("Maya Chen");
    expect(spaces.spaces.get(space)!.approvals).toEqual([{ document_id: doc, version, by: "Maya Chen" }]);

    // The page moved on there since: the approval is not recorded.
    spaces.editPage(space, "plan.md", "# Plan\n\nEdited there.\n");
    const moved = await signInWith(spaces, spaces.fetch, { space, approve: { document: doc, version } });
    expect(moved.result).toMatchObject({ kind: "signed_in", approval: "moved" });
    expect(spaces.spaces.get(space)!.approvals).toHaveLength(1);

    // No approval asked: there is no outcome to keep, and the space says none.
    const unasked = await signInWith(spaces, spaces.fetch, { space });
    expect(new URL(unasked.back!).searchParams.has("approval")).toBe(false);
    expect(unasked.result).toMatchObject({ kind: "signed_in", approval: null });
  });

  test("an approval asked and the way back silent on it reads as none", async () => {
    const spaces = createFakeSpaces({ origin: HOST });
    const { space, doc, version } = await sharedSpace(spaces);
    const silent: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const answer = await spaces.fetch(input, init);
      const location = answer.headers.get("location");
      if (!location) return answer;
      const back = new URL(location);
      back.searchParams.delete("approval");
      return new Response(null, { status: answer.status, headers: { Location: back.toString() } });
    }) as typeof fetch;
    const signIn = await startSpacesSignIn({ host: HOST, fetch: spaces.fetch, keep: { space, approve: { document: doc, version } } });
    open.push(signIn);
    const login = await silent(signIn.url, { redirect: "manual" });
    await fetch(login.headers.get("location")!);
    expect(await signIn.done).toMatchObject({ kind: "signed_in", approval: "none" });
  });
});

describe("a forged way back", () => {
  test("a wrong state or none, with a Cancel, a lost claim or an approval, changes nothing; the real way back still works", async () => {
    const spaces = createFakeSpaces({ origin: HOST });
    const { space, doc, version } = await sharedSpace(spaces);
    const signIn = await startSpacesSignIn({ host: HOST, fetch: spaces.fetch, keep: { space, approve: { document: doc, version } } });
    open.push(signIn);
    const redirect = new URL(signIn.url).searchParams.get("redirect_uri")!;
    let ended = false;
    void signIn.done.then(() => (ended = true));
    for (const state of ["not-the-state", null]) {
      for (const forged of [{ error: "claim_conflict" }, { error: "access_denied" }, { code: "forged", approval: "recorded" }]) {
        const back = new URL(redirect);
        for (const [key, value] of Object.entries(forged)) back.searchParams.set(key, value);
        if (state) back.searchParams.set("state", state);
        expect((await fetch(back)).status).toBe(404);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ended).toBe(false);
    expect(spaces.exchanges).toHaveLength(0);
    // The real one, after: signed in, with the approval the page recorded.
    const login = await spaces.fetch(signIn.url, { redirect: "manual" });
    expect((await fetch(login.headers.get("location")!)).status).toBe(200);
    expect(await signIn.done).toMatchObject({ kind: "signed_in", approval: "recorded" });
    expect(spaces.exchanges).toHaveLength(1);
  });
});

describe("the stand-in's connect page answers as the service does", () => {
  test("a tool name it does not know is a 400; with no tool name a Cancel sends nothing back", async () => {
    const spaces = createFakeSpaces({ origin: HOST, consent: "cancel" });
    const signIn = await startSpacesSignIn({ host: HOST, fetch: spaces.fetch });
    open.push(signIn);
    const named = new URL(signIn.url);
    named.searchParams.set("client_name", "Not A Tool");
    expect((await spaces.fetch(named.toString(), { redirect: "manual" })).status).toBe(400);
    named.searchParams.delete("client_name");
    const unnamed = await spaces.fetch(named.toString(), { redirect: "manual" });
    expect(unnamed.headers.get("location")).toBe(`${HOST}/`);
  });
});
