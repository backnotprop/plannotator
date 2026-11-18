/** Files whose semantic view is shorter (`shrinks`) or taller (`grows`) than the line diff, and a long plain one. */

const text = (...blocks: string[][]) => blocks.flat().join('\n');
const body = (name: string, lines: string[]) => [`export function ${name}(value: number): number {`, ...lines.map((line) => `  ${line}`), '  return value;', '}', ''];
const steps = (name: string, count: number, edit = -1) => Array.from({ length: count }, (_, i) => `value += ${i === edit ? 50 : i}; // ${name}`);
const shared = (name: string) => Array.from({ length: 2 }, (_, i) => `value = value * ${i + 2} + 1; // ${name}`);
export const shrinks = (name: string): [string, string] => [
  text(body(`${name}Big`, steps(name, 12)), body(`${name}Tiny`, ['value -= 1;'])),
  text(body(`${name}Tiny`, ['value -= 1;']), body(`${name}Big`, steps(name, 12, 5))),
];
export const grows = (name: string): [string, string] => [
  text(body(`${name}A`, [...shared(name), 'value -= 3;']), body(`${name}B`, [...shared(name), 'value -= 4;'])),
  text(body(`${name}B`, [...shared(name), 'value -= 40;']), body(`${name}A`, [...shared(name), 'value -= 30;'])),
];
export const totals = (name: string, changed: boolean) =>
  Array.from({ length: 80 }, (_, i) => `export const ${name}${i + 1} = ${changed && (i < 30 || i === 70) ? (i + 1) * 10 : i + 1};`).join('\n') + '\n';
