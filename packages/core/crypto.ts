/**
 * AES-256-GCM encryption for zero-knowledge paste storage.
 *
 * Uses Web Crypto API — works in browsers, Bun, and edge runtimes.
 * The key never leaves the client; it lives in the URL fragment.
 */

/**
 * Encrypt a compressed base64url string with a fresh AES-256-GCM key.
 *
 * Returns { ciphertext, key } where:
 * - ciphertext: base64url-encoded (12-byte IV prepended to GCM output)
 * - key: base64url-encoded 256-bit key for the URL fragment
 */
export async function encrypt(
  compressedData: string
): Promise<{ ciphertext: string; key: string }> {
  const cryptoKey = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt']
  );

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(compressedData);

  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    cryptoKey,
    plaintext
  );

  // Prepend IV to ciphertext (IV || ciphertext+tag)
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), iv.length);

  const rawKey = await crypto.subtle.exportKey('raw', cryptoKey);

  return {
    ciphertext: bytesToBase64url(combined),
    key: bytesToBase64url(new Uint8Array(rawKey)),
  };
}

/**
 * Decrypt a ciphertext string using a base64url-encoded AES-256-GCM key.
 *
 * Expects ciphertext format: base64url(IV || encrypted+tag)
 * Returns the original compressed base64url string.
 */
export async function decrypt(
  ciphertext: string,
  key: string
): Promise<string> {
  const combined = base64urlToBytes(ciphertext);
  const rawKey = base64urlToBytes(key);

  const iv = combined.slice(0, 12);
  const encrypted = combined.slice(12);

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    rawKey.buffer as ArrayBuffer,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    cryptoKey,
    encrypted
  );

  return new TextDecoder().decode(decrypted);
}

/**
 * The Inbox relay's envelope (adr/implementation/inbox-mobile.md, section 4):
 * the same byte layout as `encrypt`, `base64url(IV || ciphertext || tag)`
 * with a fresh 12-byte IV, under a key the caller holds (base64url, 32 bytes).
 * The plaintext is UTF-8 text, JSON in practice.
 */
export async function encryptWithKey(plaintext: string, key: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    base64urlToBytes(key).buffer as ArrayBuffer,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, new TextEncoder().encode(plaintext));
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), iv.length);
  return bytesToBase64url(combined);
}

/** Open an envelope from `encryptWithKey` (or `encrypt`): the same layout, so the same reader. Throws on a wrong key or a changed byte. */
export function decryptWithKey(envelope: string, key: string): Promise<string> {
  return decrypt(envelope, key);
}

const RELAY_KEY_INFO = 'plannotator-inbox relay key v1';
const RELAY_AUTH_INFO = 'plannotator-inbox relay auth v1';

/**
 * The two values a pairing secret gives one phone at the relay (section 4,
 * "Keys"), both HKDF-SHA256 over the secret with the device id as salt:
 * `key`, the AES-256-GCM key of every envelope between this Inbox and this
 * phone, and `relaySecret`, the phone's bearer at the relay (which keeps only
 * the SHA-256 of that string). All base64url without padding.
 */
export async function deriveRelayKeys(pairingSecret: string, deviceId: string): Promise<{ key: string; relaySecret: string }> {
  const ikm = await crypto.subtle.importKey('raw', base64urlToBytes(pairingSecret).buffer as ArrayBuffer, 'HKDF', false, ['deriveBits']);
  const salt = new TextEncoder().encode(deviceId);
  const derive = async (info: string) =>
    bytesToBase64url(
      new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode(info) }, ikm, 256))
    );
  return { key: await derive(RELAY_KEY_INFO), relaySecret: await derive(RELAY_AUTH_INFO) };
}

// --- Helpers ---

function bytesToBase64url(bytes: Uint8Array): string {
  // Loop to avoid RangeError on large payloads (same approach as compress.ts)
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function base64urlToBytes(b64: string): Uint8Array {
  const base64 = b64.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64);
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}
