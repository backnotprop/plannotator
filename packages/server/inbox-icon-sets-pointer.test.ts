import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { creature } from "../../tests/helpers/fake-icon-set";
import { createIconSetFetcher, INBOX_ICON_SETS_POINTER_DEFAULT } from "./inbox-icon-set-fetch";

const SITE = join(import.meta.dir, "../../apps/marketing/public");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("the site's pointer offers one set the Inbox can get in one click, its mirror tried when the first address fails", async () => {
  const asked: string[] = [];
  const pointer = JSON.parse(readFileSync(join(SITE, "assets/icon-sets/v1/index.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(join(SITE, "assets/icon-sets/v1/pokemon.json"), "utf8"));
  const stand = (async (input: URL | string) => {
    const url = new URL(String(input));
    asked.push(`${url.host}${url.pathname}${url.search}`);
    if (url.href === INBOX_ICON_SETS_POINTER_DEFAULT) return Response.json(pointer);
    if (url.host === "plannotator.ai" && url.pathname.startsWith("/assets/")) return new Response(readFileSync(join(SITE, url.pathname)));
    const at = /\/(\d+)\.png$/.exec(url.pathname);
    if (at && Number(at[1]) % 3 === 0 && !url.host.includes("jsdelivr")) return new Response("busy", { status: 503 });
    if (at) return new Response(creature(Number(at[1])));
    if (url.search.includes("limit=")) return Response.json({ results: Array.from({ length: manifest.count }, (_, i) => ({ name: `name-${i + 1}` })) });
    return new Response("no", { status: 404 });
  }) as unknown as typeof fetch;
  const dir = join(realpathSync(mkdtempSync(join(tmpdir(), "pn-icon-set-site-"))), "icon-sets");
  roots.push(dir);
  const fetcher = createIconSetFetcher({ dir, pointer: INBOX_ICON_SETS_POINTER_DEFAULT, builtIn: new Set(), fetch: stand, classify: async () => "public" });
  const offered = await fetcher.list(true);
  expect(offered).toHaveLength(1);
  expect(offered[0]).toMatchObject({ id: "pokemon", count: 1025, kind: "fetchable", get: { state: "none", have: 0 } });
  await fetcher.get("pokemon");
  await fetcher.running("pokemon");
  const listing = fetcher.listing("pokemon")!;
  expect(listing).toMatchObject({ count: 1025, get: { state: "done", have: 1025 } });
  expect(listing.icons[24]).toEqual({ id: "25", n: 25, name: "Name 25" });
  expect(new Set(asked.map((a) => a.split("/")[0]))).toEqual(new Set(["plannotator.ai", "pokeapi.co", "raw.githubusercontent.com", "cdn.jsdelivr.net"]));
  expect(asked.filter((a) => a.startsWith("cdn.jsdelivr.net"))).toHaveLength(341);
});
