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
