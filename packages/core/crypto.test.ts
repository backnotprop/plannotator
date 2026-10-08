/**
 * End-to-end encryption tests for the paste service.
 *
 * Tests the full pipeline: compress → encrypt → store → retrieve → decrypt → decompress
 * Run: bun test packages/shared/crypto.test.ts
 */

import { describe, expect, test } from "bun:test";
import { encrypt, decrypt, decryptWithKey, deriveRelayKeys, encryptWithKey } from "./crypto";
import vectors from "./fixtures/inbox-relay-vectors.json";
import { deflateSync, inflateSync } from "bun";

// Bun's test runner doesn't have CompressionStream (browser API).
// Use Bun's native zlib for the same deflate-raw + base64url pipeline.
function compress(data: unknown): string {
  const json = JSON.stringify(data);
  const compressed = deflateSync(new TextEncoder().encode(json));
  let binary = "";
  for (let i = 0; i < compressed.length; i++) {
    binary += String.fromCharCode(compressed[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function decompress(b64: string): unknown {
  const base64 = b64.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  const decompressed = inflateSync(bytes);
  return JSON.parse(new TextDecoder().decode(decompressed));
}

const PASTE_API = "https://plannotator-paste.plannotator.workers.dev";

// Realistic plan payload matching SharePayload shape
const SAMPLE_PAYLOAD = {
  p: "# Implementation Plan\n\n## Step 1: Add authentication\n\nWe'll use JWT tokens stored in httpOnly cookies.\n\n## Step 2: Create middleware\n\nAdd auth middleware to all protected routes.\n\n```typescript\nconst authMiddleware = async (req: Request) => {\n  const token = getCookie(req, 'auth');\n  if (!token) throw new UnauthorizedError();\n  return verify(token, SECRET);\n};\n```\n\n## Step 3: Update database schema\n\nAdd users table with email, password_hash, created_at columns.",
  a: [
    ["C", "Add auth middleware", "Consider rate limiting on login endpoint", "reviewer", []],
    ["R", "JWT tokens stored in httpOnly cookies", "Use refresh token rotation instead of single JWT", null, []],
    ["D", "Add users table with email, password_hash, created_at columns.", null, []],
  ],
};

// --- Unit tests (no network) ---

describe("encrypt / decrypt round-trip", () => {
  test("encrypts and decrypts a string", async () => {
    const plaintext = "hello world";
    const { ciphertext, key } = await encrypt(plaintext);

    expect(ciphertext).not.toBe(plaintext);
    expect(key.length).toBeGreaterThan(0);

    const decrypted = await decrypt(ciphertext, key);
    expect(decrypted).toBe(plaintext);
  });

  test("each encryption produces a unique ciphertext (random IV)", async () => {
    const plaintext = "same input";
    const a = await encrypt(plaintext);
    const b = await encrypt(plaintext);

    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.key).not.toBe(b.key);
  });

  test("wrong key fails to decrypt", async () => {
    const { ciphertext } = await encrypt("secret");
    const { key: wrongKey } = await encrypt("other");

    expect(decrypt(ciphertext, wrongKey)).rejects.toThrow();
  });

  test("tampered ciphertext fails to decrypt", async () => {
    const { ciphertext, key } = await encrypt("secret");

    // Flip a character in the middle of the ciphertext
    const mid = Math.floor(ciphertext.length / 2);
    const tampered = ciphertext.slice(0, mid) +
      (ciphertext[mid] === 'A' ? 'B' : 'A') +
      ciphertext.slice(mid + 1);

    expect(decrypt(tampered, key)).rejects.toThrow();
  });

  test("handles large payloads", async () => {
    const large = "x".repeat(100_000);
    const { ciphertext, key } = await encrypt(large);
    const decrypted = await decrypt(ciphertext, key);
    expect(decrypted).toBe(large);
  });
});

describe("full pipeline: compress → encrypt → decrypt → decompress", () => {
  test("round-trips a SharePayload", async () => {
    const compressed = await compress(SAMPLE_PAYLOAD);
    const { ciphertext, key } = await encrypt(compressed);

    // Ciphertext should not contain the original plan text
    expect(ciphertext).not.toContain("Implementation Plan");

    const decrypted = await decrypt(ciphertext, key);
    const decompressed = await decompress(decrypted);

    expect(decompressed).toEqual(SAMPLE_PAYLOAD);
  });
});

// --- Integration tests (hit live paste service) ---

describe("live paste service E2E", () => {
  test("encrypt → POST → GET → decrypt → decompress", async () => {
    // 1. Compress
    const compressed = await compress(SAMPLE_PAYLOAD);

    // 2. Encrypt
    const { ciphertext, key } = await encrypt(compressed);

    // 3. Store — server sees only ciphertext
    const postRes = await fetch(`${PASTE_API}/api/paste`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: ciphertext }),
    });
    expect(postRes.status).toBe(201);
    const { id } = (await postRes.json()) as { id: string };
    expect(id).toMatch(/^[A-Za-z0-9]{8}$/);

    // 4. Retrieve
    const getRes = await fetch(`${PASTE_API}/api/paste/${id}`);
    expect(getRes.status).toBe(200);

    // Verify Cache-Control header
    expect(getRes.headers.get("cache-control")).toBe("private, no-store");

    const { data: storedData } = (await getRes.json()) as { data: string };

    // 5. Verify server stores only ciphertext (not readable plan data)
    expect(storedData).toBe(ciphertext);
    expect(storedData).not.toContain("Implementation Plan");

    // 6. Decrypt
    const decrypted = await decrypt(storedData, key);

    // 7. Decompress
    const result = await decompress(decrypted);
    expect(result).toEqual(SAMPLE_PAYLOAD);
  });

  test("GET without key returns opaque ciphertext", async () => {
    const compressed = await compress({ p: "secret plan", a: [] });
    const { ciphertext } = await encrypt(compressed);

    const postRes = await fetch(`${PASTE_API}/api/paste`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: ciphertext }),
    });
    const { id } = (await postRes.json()) as { id: string };

    const getRes = await fetch(`${PASTE_API}/api/paste/${id}`);
    const { data } = (await getRes.json()) as { data: string };

    // Data is opaque — cannot be decompressed without decryption
    expect(() => decompress(data)).toThrow();
  });

  test("expired/nonexistent paste returns 404", async () => {
    const res = await fetch(`${PASTE_API}/api/paste/ZZZZZZZZ`);
    expect(res.status).toBe(404);
  });
});

/**
 * The Inbox relay's keys and envelope (adr/implementation/inbox-mobile.md,
 * section 4) against the committed vectors, which the iPhone app checks in
 * Swift too (M5): if either side derives or lays out bytes differently, a
 * phone cannot open what the Inbox sends.
 */
describe("the Inbox relay's vectors", () => {
  test("the pairing secret and device id derive the vectors' key and relay secret", async () => {
    const derived = await deriveRelayKeys(vectors.pairing_secret, vectors.device_id);
    expect(derived).toEqual({ key: vectors.derived.key, relaySecret: vectors.derived.relay_secret });
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(derived.relaySecret)));
    expect(Buffer.from(digest).toString("hex")).toBe(vectors.derived.relay_secret_sha256);
  });

  test("every vector envelope opens to its plaintext, and sealing it again with its IV gives the same bytes", async () => {
    const key = await crypto.subtle.importKey("raw", Buffer.from(vectors.derived.key, "base64url"), "AES-GCM", false, ["encrypt"]);
    for (const { plaintext, envelope } of vectors.envelopes) {
      expect(await decryptWithKey(envelope, vectors.derived.key)).toBe(plaintext);
      const bytes = Buffer.from(envelope, "base64url");
      const iv = bytes.subarray(0, 12);
      const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)));
      expect(Buffer.concat([iv, sealed]).toString("base64url")).toBe(envelope);
    }
  });

  test("encryptWithKey makes a fresh IV each time, and a wrong key or a changed byte does not open", async () => {
    const plaintext = vectors.envelopes[0]!.plaintext;
    const a = await encryptWithKey(plaintext, vectors.derived.key);
    const b = await encryptWithKey(plaintext, vectors.derived.key);
    expect(a).not.toBe(b);
    expect(await decryptWithKey(a, vectors.derived.key)).toBe(plaintext);
    const other = (await deriveRelayKeys(vectors.pairing_secret, "dev_00000000000000000000000001")).key;
    await expect(decryptWithKey(a, other)).rejects.toThrow();
    const flipped = Buffer.from(a, "base64url");
    flipped[20] ^= 1;
    await expect(decryptWithKey(flipped.toString("base64url"), vectors.derived.key)).rejects.toThrow();
  });
});
