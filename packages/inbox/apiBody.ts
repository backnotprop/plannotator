export async function gzipped(text: string): Promise<ArrayBuffer | null> {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    return await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
  } catch {
    return null;
  }
}

export async function wholeBody(response: Response, progress: () => void): Promise<Response> {
  progress();
  const reader = response.body?.getReader();
  if (!reader) return response;
  const parts: Uint8Array[] = [];
  let size = 0;
  for (let part = await reader.read(); !part.done; part = await reader.read()) {
    progress();
    parts.push(part.value);
    size += part.value.length;
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
}
