/**
 * Terminal QR code for advertised session URLs.
 *
 * A remote or tailnet session URL usually has to make a device hop (phone,
 * tablet, another laptop); the QR removes the hand-transcription step. TTY
 * only: piped stderr (hook transcripts, log capture) keeps just the plain
 * URL line the caller already printed.
 */

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
    // A QR is a convenience; never let it break session ready.
  }
}
