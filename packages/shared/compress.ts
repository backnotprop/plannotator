/**
 * Portable deflate-raw + base64url compression.
 *
 * Uses only Web APIs (CompressionStream, TextEncoder, btoa) so it works
 * in browsers, Bun, and edge runtimes.  Both @plannotator/server and
 * @plannotator/ui import from here — single source of truth.
 */

export async function compress(data: unknown): Promise<string> {
  const json = JSON.stringify(data);
  const byteArray = new TextEncoder().encode(json);

  const stream = new CompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  writer.write(byteArray);
  writer.close();

  const buffer = await new Response(stream.readable).arrayBuffer();
  const compressed = new Uint8Array(buffer);

  // Loop instead of spread to avoid RangeError on large payloads
  // (String.fromCharCode(...arr) has a ~65K argument limit)
  let binary = '';
  for (let i = 0; i < compressed.length; i++) {
    binary += String.fromCharCode(compressed[i]);
  }
  const base64 = btoa(binary);
  return base64
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

export async function decompress(b64: string): Promise<unknown> {
  const base64 = b64
    .replace(/-/g, '+')
    .replace(/_/g, '/');

  const binary = atob(base64);
  const byteArray = Uint8Array.from(binary, c => c.charCodeAt(0));

  const stream = new DecompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  writer.write(byteArray);
  writer.close();

  const buffer = await new Response(stream.readable).arrayBuffer();
  const json = new TextDecoder().decode(buffer);

  return JSON.parse(json);
}
