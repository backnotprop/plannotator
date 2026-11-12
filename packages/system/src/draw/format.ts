export const KIND: Record<string, string> = {
  conceptual: 'Conceptual',
  logical: 'Logical',
  deployment: 'Deployment',
  service: 'Service sheet',
  flow: 'Data flow',
  algorithm: 'Algorithm',
  landscape: 'Landscape',
};
export const kindLabel = (k: string) => KIND[k] ?? (k ? k.charAt(0).toUpperCase() + k.slice(1) : 'Sheet');

const nf = new Intl.NumberFormat('en-US');
const pr = new Intl.PluralRules('en');
export const plural = (n: number, one: string, many = one + 's') => `${nf.format(n)} ${pr.select(n) === 'one' ? one : many}`;

export function middle(text: string | null | undefined, max = 34): string {
  const t = String(text ?? '');
  if (t.length <= max) return t;
  const keep = max - 1;
  const head = Math.ceil(keep * 0.45);
  return t.slice(0, head) + '…' + t.slice(t.length - (keep - head));
}
