/**
 * Apple, played locally, for the relay 1.1 proofs: a cleartext HTTP/2 server
 * (the relay reaches it through `APNS_ORIGIN`, loopback only) that checks the
 * provider token's ES256 signature against a key made for the run, records
 * every push it is sent (headers and body), and answers 200, or 410 for a
 * device token that starts with 4100. Nothing reaches Apple.
 */
import http2 from "node:http2";

export interface ApplePush {
  headers: Record<string, string>;
  body: string;
  jwtValid: boolean;
}

export const APPLE_KEY_ID = "KEY0000000";
export const APPLE_TEAM_ID = "TEAM000000";

export async function throwawayAppleKey() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const pkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64");
  return { pkcs8, publicKey: pair.publicKey };
}

async function verifyJwt(authorization: string | undefined, publicKey: CryptoKey): Promise<boolean> {
  const jwt = /^bearer (.+)$/.exec(authorization ?? "")?.[1];
  if (!jwt) return false;
  const [header, claims, signature] = jwt.split(".");
  const parsed = JSON.parse(Buffer.from(header!, "base64url").toString());
  const payload = JSON.parse(Buffer.from(claims!, "base64url").toString());
  if (parsed.alg !== "ES256" || parsed.kid !== APPLE_KEY_ID || payload.iss !== APPLE_TEAM_ID) return false;
  return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, Buffer.from(signature!, "base64url"), new TextEncoder().encode(`${header}.${claims}`));
}

export async function standInApple(): Promise<{ port: number; pushes: ApplePush[]; vars: Record<string, string>; close: () => void }> {
  const key = await throwawayAppleKey();
  const pushes: ApplePush[] = [];
  const server = http2.createServer();
  server.on("stream", (stream, headers) => {
    let body = "";
    stream.on("data", (chunk) => (body += chunk));
    stream.on("end", async () => {
      const flat = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, String(v)]));
      const jwtValid = await verifyJwt(flat.authorization, key.publicKey);
      pushes.push({ headers: flat, body, jwtValid });
      if (!jwtValid) {
        stream.respond({ ":status": 403 });
        stream.end(JSON.stringify({ reason: "InvalidProviderToken" }));
      } else if (flat[":path"]!.startsWith("/3/device/4101")) {
        // A refusal that takes a moment: long enough for the phone to register a new token meanwhile.
        await new Promise((later) => setTimeout(later, 1_500));
        stream.respond({ ":status": 410 });
        stream.end(JSON.stringify({ reason: "Unregistered", timestamp: Date.now() }));
      } else if (flat[":path"]!.startsWith("/3/device/4100")) {
        stream.respond({ ":status": 410 });
        stream.end(JSON.stringify({ reason: "Unregistered", timestamp: Date.now() }));
      } else {
        stream.respond({ ":status": 200, "apns-id": crypto.randomUUID() });
        stream.end();
      }
    });
  });
  const port = await new Promise<number>((ready) => server.listen(0, "127.0.0.1", () => ready((server.address() as { port: number }).port)));
  return {
    port,
    pushes,
    vars: { APNS_KEY: key.pkcs8, APNS_KEY_ID: APPLE_KEY_ID, APNS_TEAM_ID: APPLE_TEAM_ID, APNS_ORIGIN: `http://127.0.0.1:${port}` },
    close: () => server.close(),
  };
}
