import { renderUnicodeCompact } from "uqr";

export function writeUrlQr(url: string): void {
  if (!process.stderr.isTTY) return;
  try {
    const qr = renderUnicodeCompact(url)
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n");
    process.stderr.write(`${qr}\n\n`);
  } catch {
  }
}
