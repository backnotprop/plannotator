import { encode } from 'uqr';

/**
 * A QR code as one SVG path of unit squares (`uqr`, error correction M), with
 * its width in modules. Pure: the pairing panel draws it, and the browser
 * proof reads the path on screen back against the offer's own link.
 */
export function qrModules(text: string): { d: string; size: number } {
  const { data } = encode(text, { ecc: 'M', border: 0 });
  let d = '';
  data.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) d += `M${x} ${y}h1v1h-1z`;
    }),
  );
  return { d, size: data.length };
}
