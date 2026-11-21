// Words and numbers the drawing prints from data, in one place.

export const KIND: Record<string, string> = {
  conceptual: 'Conceptual',
  logical: 'Logical',
  deployment: 'Deployment',
  service: 'Service sheet',
  flow: 'Data flow',
  algorithm: 'Algorithm',
  landscape: 'Landscape',
};
/** A sheet kind the drawing does not know is still a kind: "threat model" reads "Threat model". */
export const kindLabel = (k: string) => KIND[k] ?? (k ? k.charAt(0).toUpperCase() + k.slice(1) : 'Sheet');

const nf = new Intl.NumberFormat('en-US');
const pr = new Intl.PluralRules('en');
/** "1 sheet", "8 sheets", "1,284 parts". */
export const plural = (n: number, one: string, many = one + 's') => `${nf.format(n)} ${pr.select(n) === 'one' ? one : many}`;

/** Middle truncation: routes and hostnames differ at the end, so keep the head and the tail. */
export function middle(text: string | null | undefined, max = 34): string {
  const t = String(text ?? '');
  if (t.length <= max) return t;
  const keep = max - 1;
  const head = Math.ceil(keep * 0.45);
  return t.slice(0, head) + '…' + t.slice(t.length - (keep - head));
}
