/**
 * What a REAL session (no runner handed in) does with a Forgejo / Gitea link on the plan, annotate and review servers.
 * The route scenarios (ref-card-route.scenarios.ts) hand each server its own runner, so they never take this path.
 * What regresses: the Forgejo reader never wired in by default (a Forgejo link in a plan or an annotated file shows no
 * card, as before), or wired for a test that gave its own runner (a test would reach a real instance). `fetch` is
 * stubbed: nothing here leaves the process.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createRefCards } from "./ref-cards";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("createRefCards and a Forgejo link", () => {
  test("with no runner it reads the Forgejo through its API (token-free here), and with a test's own runner it gets no reader", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response(JSON.stringify({ message: "not found" }), { status: 404, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const real = await createRefCards().get("https://codeberg.org/acme/widgets/pulls/5");
    expect(real).toMatchObject({ ok: false });
    // It asked codeberg.org's API; "unsupported" would mean no reader was wired.
    expect((real as { error: string }).error).not.toBe("unsupported");
    expect(seen.some((url) => url.startsWith("https://codeberg.org/api/v1/repos/acme/widgets/"))).toBe(true);

    const before = seen.length;
    const own = await createRefCards({ run: async () => ({ stdout: "", stderr: "", exitCode: 1 }) }).get("https://codeberg.org/acme/widgets/pulls/5");
    expect(own).toMatchObject({ ok: false, error: "unsupported" });
    expect(seen).toHaveLength(before);
  });
});
