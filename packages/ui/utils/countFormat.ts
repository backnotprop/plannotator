const NUMBER = new Intl.NumberFormat('en-US');

export function formatCount(value: number): string {
  return NUMBER.format(value);
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${formatCount(count)} ${count === 1 ? one : many}`;
}

export function shortCount(value: number): string {
  if (value < 10_000) return formatCount(value);
  const [unit, size] = value < 1_000_000 ? ['k', 1_000] : ['M', 1_000_000];
  const scaled = value / size;
  return `${scaled < 100 ? scaled.toFixed(1).replace(/\.0$/, '') : Math.round(scaled)}${unit}`;
}
