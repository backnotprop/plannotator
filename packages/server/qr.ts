/** Terminal QR code for advertised session URLs; TTY only, so piped stderr keeps just the plain URL line. */

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
