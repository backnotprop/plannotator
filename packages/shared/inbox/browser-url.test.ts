import { expect, test } from "bun:test";
import { inboxBrowserUrl } from "./registry";

test("browser links follow publication without replacing the local registry URL", () => {
  const entry = { url: "http://localhost:4321/", tailscale: { url: "https://machine.tailnet.ts.net:4321/", error: null } };
  expect(inboxBrowserUrl(entry)).toBe(entry.tailscale.url);
  entry.tailscale.url = "";
  expect(inboxBrowserUrl(entry)).toBe(entry.url);
  expect(inboxBrowserUrl({ url: entry.url })).toBe(entry.url);
});
