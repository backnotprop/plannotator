export type ParsedPortSelection =
  | { readonly kind: "fixed"; readonly ports: [number] }
  | { readonly kind: "range"; readonly ports: number[] };

export function parsePortSelection(value: string): ParsedPortSelection | null {
  const trimmed = value.trim();
  const rangeMatch = /^(\d+)-(\d+)$/.exec(trimmed);

  if (rangeMatch) {
    const start = Number(rangeMatch[1]);
    const end = Number(rangeMatch[2]);
    if (start < 1 || end > 65535 || start > end) {
      return null;
    }

    return {
      kind: "range",
      ports: Array.from({ length: end - start + 1 }, (_, index) => start + index),
    };
  }

  if (!/^\d+$/.test(trimmed)) {
    return null;
  }

  const port = Number(trimmed);
  return port <= 65535 ? { kind: "fixed", ports: [port] } : null;
}
