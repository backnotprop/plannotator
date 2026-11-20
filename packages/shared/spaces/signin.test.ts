/**
 * The "Keep this space" sign-in against the stand-in, which answers `/cli/login`, `/cli/token` and `GET /v1/me` as the
 * service does (tests/helpers/fake-spaces.ts). The only socket is the sign-in's own listener on 127.0.0.1. What
 * regresses if these fail:
 * - the code is traded in a shape the service refuses (JSON, a missing `grant_type`, a way back that is not the one
 *   the login page got), so every sign-in ends "Sign-in did not finish";
 * - a code is traded twice (the service spends it on the first try, so a second load of the page or a retry fails);
 * - an account with no name, or a name that cannot be read, fails a sign-in that worked;
 * - the token leaks into a URL, or the exchange carries an Origin, a cookie or an Authorization header.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createFakeSpaces } from "../../../tests/helpers/fake-spaces";
import { startSpacesSignIn, type SpacesSignIn } from "./signin";

const HOST = "http://127.0.0.1:1";
const open: SpacesSignIn[] = [];
afterEach(() => {
  for (const signIn of open.splice(0)) signIn.cancel();
});

async function signInWith(spaces: ReturnType<typeof createFakeSpaces>, doFetch: typeof fetch = spaces.fetch) {
  const signIn = await startSpacesSignIn({ host: HOST, fetch: doFetch });
  open.push(signIn);
  // The "browser": the login page sends it back to this computer's listener.
  const login = await spaces.fetch(signIn.url, { redirect: "manual" });
  const back = login.headers.get("location");
  const landed = back ? await fetch(back) : null;
  return { signIn, login, back, landed, credential: await signIn.done };
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
