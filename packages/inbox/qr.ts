import { encode } from 'uqr';

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
