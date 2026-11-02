/**
 * `tailscale` as a script, for a real server's "Reach from my tailnet" (`startInboxServer`'s `tailscale`): this
 * machine's owner, serve status, serve on and off. Nothing runs the real CLI.
 */
import type { TailscaleRunner } from "@plannotator/shared/tailscale";

export const TAILNET_MAGIC = "macbook-pro.tail0000.ts.net";
export const TAILNET_OWNER = "owner@example.com";

export function scriptedTailscale(): TailscaleRunner {
  const serve = new Map<number, string>();
  return (args) => {
    const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
    if (args[0] === "status") return ok(JSON.stringify({ Self: { DNSName: `${TAILNET_MAGIC}.`, UserID: 42 }, User: { "42": { ID: 42, LoginName: TAILNET_OWNER, DisplayName: "Owner" } } }));
    if (args[1] === "status") {
      const TCP = Object.fromEntries([...serve.keys()].map((p) => [String(p), { HTTPS: true }]));
      const Web = Object.fromEntries([...serve].map(([p, proxy]) => [`${TAILNET_MAGIC}:${p}`, { Handlers: { "/": { Proxy: proxy } } }]));
      return ok(serve.size === 0 ? "{}" : JSON.stringify({ TCP, Web }));
    }
    const httpsPort = Number(/--https=(\d+)/.exec(args.join(" "))![1]);
    if (args.includes("off")) {
      serve.delete(httpsPort);
      return ok();
    }
    serve.set(httpsPort, args.at(-1)!);
    return ok(`https://${TAILNET_MAGIC}:${httpsPort}/\n|-- proxy ${args.at(-1)}\n`);
  };
}
