const RS256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

const b64 = (bytes: Uint8Array | string) => Buffer.from(typeof bytes === "string" ? bytes : bytes).toString("base64url");

export interface TestKeys {
  kid: string;
  jwks: { keys: Record<string, unknown>[] };
  sign: (claims: Record<string, unknown>, header?: Record<string, unknown>) => Promise<string>;
}

export async function makeTestKeys(kid = "test-kid-1"): Promise<TestKeys> {
  const pair = (await crypto.subtle.generateKey(
    { ...RS256, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pub = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return {
    kid,
    jwks: { keys: [{ kty: "RSA", kid, alg: "RS256", use: "sig", n: pub.n, e: pub.e }] },
    sign: async (claims, header = {}) => {
      const h = b64(JSON.stringify({ alg: "RS256", kid, typ: "JWT", ...header }));
      const p = b64(JSON.stringify(claims));
      const sig = new Uint8Array(await crypto.subtle.sign(RS256, pair.privateKey, new TextEncoder().encode(`${h}.${p}`)));
      return `${h}.${p}.${b64(sig)}`;
    },
  };
}

export const TEST_TEAM = "plannotator-test.cloudflareaccess.com";
export const TEST_AUD = "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6";
export const TEST_HOST = "inbox.example.test";
export const TEST_SESSION_HOST = "inbox-s.example.test";
export const TEST_OWNER = "owner@example.com";

export function ownerClaims(nowS: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { iss: `https://${TEST_TEAM}`, aud: [TEST_AUD], email: TEST_OWNER, exp: nowS + 600, iat: nowS - 5, nbf: nowS - 5, type: "app", ...extra };
}
