/**
 * The live probe's redirects (annotate's live app mode and the Inbox's live
 * sites; vendored to Pi): each redirect is judged before it is followed, so a
 * target that redirects to another local service never makes the probe send
 * that service a request. Real servers on loopback, real fetch.
 */
import { afterEach, expect, test } from "bun:test";
import { LIVE_PROBE_MAX_REDIRECTS, probeLiveAppTarget } from "./live-probe";

const servers: { stop: (force?: boolean) => unknown }[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

const html = (body: string) => new Response(body, { headers: { "Content-Type": "text/html" } });

function serve(fetch: (req: Request) => Response) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch });
  servers.push(server);
  return server;
}

async function probe(url: string) {
  return probeLiveAppTarget(url, new URL(url));
}

test("a redirect off the target's origin ends the probe before any request to it", async () => {
  const hits: string[] = [];
  const other = serve((req) => (hits.push(new URL(req.url).pathname), html("<p>admin</p>")));
  const target = serve(() => Response.redirect(`http://127.0.0.1:${other.port}/admin/delete?id=1`, 302));
  const result = await probe(`http://localhost:${target.port}/`);
  expect(result.liveEligible).toBe(false);
  expect(result.probeRedirectedTo).toBe(`http://127.0.0.1:${other.port}/admin/delete?id=1`);
  expect(hits).toEqual([]);
});

test("redirects on the same origin (any loopback spelling of it) are followed, and the final page judged", async () => {
  const target = serve((req) => {
    const path = new URL(req.url).pathname;
    if (path === "/") return Response.redirect("/login", 302);
    if (path === "/login") return Response.redirect(`http://127.0.0.1:${target.port}/login/form`, 307);
    return html("<form>Sign in</form>");
  });
  expect((await probe(`http://localhost:${target.port}/`)).liveEligible).toBe(true);
});

test("a redirect loop on the origin stops after the limit, not eligible", async () => {
  let hits = 0;
  const target = serve(() => (hits += 1, Response.redirect("/again", 302)));
  const result = await probe(`http://localhost:${target.port}/`);
  expect(result.liveEligible).toBe(false);
  expect(result.probeError).toContain("redirects");
  expect(hits).toBe(LIVE_PROBE_MAX_REDIRECTS + 1);
});
