import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";

// The module the CLI imports first (index.ts). Run in a child process so its
// process.env change cannot leak into this test process.
const MODULE = join(import.meta.dir, "loopback-no-proxy.ts");

let server: ReturnType<typeof Bun.serve> | null = null;
afterEach(() => {
  server?.stop(true);
  server = null;
});

/** A child Bun with a dead proxy in its environment fetches `url`, after importing the CLI's first module or not. */
async function childFetch(url: string, importFirst: boolean): Promise<string> {
  const env: Record<string, string | undefined> = { ...process.env, http_proxy: "http://127.0.0.1:9" };
  for (const key of ["NO_PROXY", "no_proxy", "HTTP_PROXY", "ALL_PROXY", "all_proxy"]) delete env[key];
  const code = `${importFirst ? `await import(${JSON.stringify(MODULE)});` : ""}
    const answer = await fetch(${JSON.stringify(url)}).then((r) => r.text(), () => "refused");
    process.stdout.write(answer);`;
  const child = Bun.spawn([process.execPath, "-e", code], { cwd: import.meta.dir, env, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(child.stdout).text();
  await child.exited;
  return out;
}

test("the CLI's first module makes a loopback fetch skip the shell's proxy", async () => {
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
  const url = `http://127.0.0.1:${server.port}/`;
  expect(await childFetch(url, false)).toBe("refused");
  expect(await childFetch(url, true)).toBe("ok");
});
