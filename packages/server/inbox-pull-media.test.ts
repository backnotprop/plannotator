/**
 * The Inbox's PR media route (inbox-pull-media.ts): a pull request's own pictures and videos, fetched by the Inbox so
 * the window loads nothing from the web. A scripted fetch and a fake `gh`: never the network, never the real CLI.
 *
 * What regresses:
 *  - the route fetching a URL outside GitHub's own upload hosts (a look-alike host, another site): an open proxy;
 *  - an upload the PR's text never names being fetched with the person's sign-in;
 *  - a redirect leading off GitHub's upload hosts and bucket being followed, or the person's token reaching the bucket;
 *  - something not a picture or video served from the Inbox's origin;
 *  - the normal path (a 302 to GitHub's bucket, then the picture) failing, or a video's seek losing its 206.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { PRContext, PRRuntime } from "@plannotator/shared/pr-types";
import type { InboxPull } from "@plannotator/core/inbox-pulls";
import { pullMediaResponse } from "./inbox-pull-media";

const SHOT = "https://github.com/user-attachments/assets/1111-aaaa";
const CLIP = "https://github.com/user-attachments/assets/2222-bbbb";
const UNNAMED = "https://github.com/user-attachments/assets/3333-cccc";
const RAW = "https://github.com/acme/widgets/raw/main/a.png";
const BUCKET = "https://github-production-user-asset-6210df.s3.amazonaws.com/1/1111-aaaa.png?X-Amz-Signature=x";

const pull = {
  key: "github.com/acme/widgets#42",
  platform: "github",
  host: "github.com",
  repo: "acme/widgets",
  number: 42,
  url: "https://github.com/acme/widgets/pull/42",
  title: "Widgets",
  author: "kim",
  base: "main",
  head: "widgets",
  head_sha: "abc",
  updated_at: "2026-11-11T00:00:00Z",
} as InboxPull;

const context = {
  // A repository file is named too: the review app's proxy may read it, this route never does.
  body: `Before and after:\n\n<img width="720" alt="shot" src="${SHOT}" />\n\n![raw](${RAW})`,
  comments: [{ id: "c1", author: "lee", body: `The clip:\n\n${CLIP}`, createdAt: "2026-11-11T00:00:00Z", url: "" }],
  reviews: [],
  reviewThreads: [],
} as unknown as PRContext;

const runtime: PRRuntime = {
  runCommand: async (cmd, args) => ({ stdout: cmd === "gh" && args[0] === "auth" ? "gho_fake\n" : "", stderr: "", exitCode: 0 }),
};

const pulls = { text: async () => ({ pull, context, runtime }) };

const realFetch = globalThis.fetch;
let fetched: string[] = [];
let auth: (string | null)[] = [];
function script(answer: (url: string, init?: RequestInit) => Response) {
  fetched = [];
  auth = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    fetched.push(url);
    auth.push(new Headers(init?.headers).get("authorization"));
    return answer(url, init);
  }) as typeof fetch;
}
afterEach(() => {
  globalThis.fetch = realFetch;
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describe("GET /api/inbox/pulls/media", () => {
  test("a URL outside GitHub's upload hosts, or one the PR's text never names, is refused before any fetch", async () => {
    script(() => new Response(PNG, { headers: { "content-type": "image/png" } }));
    for (const url of [
      "https://example.com/a.png",
      "https://github.com.evil.example/user-attachments/assets/1111-aaaa",
      RAW,
      "http://github.com/user-attachments/assets/1111-aaaa",
      "https://github.com:8443/user-attachments/assets/1111-aaaa",
      UNNAMED,
    ]) {
      const res = await pullMediaResponse(pulls, pull.key, url, null);
      expect({ url, status: res.status }).toEqual({ url, status: 403 });
    }
    expect(fetched).toEqual([]);
  });

  test("GitHub's redirect to its bucket is followed and the picture served from the Inbox; a redirect elsewhere is not", async () => {
    script((url) =>
      url === SHOT
        ? new Response(null, { status: 302, headers: { location: BUCKET } })
        : new Response(PNG, { headers: { "content-type": "image/png" } }),
    );
    const res = await pullMediaResponse(pulls, pull.key, SHOT, null);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
    expect(fetched).toEqual([SHOT, BUCKET]);
    expect(auth).toEqual(["Bearer gho_fake", null]);

    const signed = "https://private-user-images.githubusercontent.com/1/1111-aaaa.png?jwt=x";
    script((url) =>
      url === SHOT
        ? new Response(null, { status: 302, headers: { location: signed } })
        : new Response(PNG, { headers: { "content-type": "image/png" } }),
    );
    expect((await pullMediaResponse(pulls, pull.key, SHOT, null)).status).toBe(200);
    expect(fetched).toEqual([SHOT, signed]);
    expect(auth).toEqual(["Bearer gho_fake", null]);

    script((url) =>
      url === SHOT
        ? new Response(null, { status: 302, headers: { location: "https://github-production-user-asset-6210df.s3.amazonaws.com.evil.example/x.png" } })
        : new Response(PNG, { headers: { "content-type": "image/png" } }),
    );
    const away = await pullMediaResponse(pulls, pull.key, SHOT, null);
    expect(away.status).toBe(403);
    expect(fetched).toEqual([SHOT]);
  });

  test("a video seek keeps its 206; an answer that is not a picture or video is refused", async () => {
    script((_url, init) => {
      const range = new Headers(init?.headers).get("range");
      return new Response(new Uint8Array([0, 0, 0, 0x18]), { status: 206, headers: { "content-type": "video/mp4", "content-range": `bytes 100-103/5000`, "x-range": range ?? "" } });
    });
    const seek = await pullMediaResponse(pulls, pull.key, CLIP, "bytes=100-");
    expect(seek.status).toBe(206);
    expect(seek.headers.get("content-range")).toBe("bytes 100-103/5000");

    for (const type of ["text/html", "image/svg+xml", "application/octet-stream"]) {
      script(() => new Response("<svg onload=alert(1)>", { headers: { "content-type": type } }));
      expect({ type, status: (await pullMediaResponse(pulls, pull.key, SHOT, null)).status }).toEqual({ type, status: 415 });
    }
  });
});
