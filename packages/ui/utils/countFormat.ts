const NUMBER = new Intl.NumberFormat('en-US');

export function formatCount(value: number): string {
  return NUMBER.format(value);
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${formatCount(count)} ${count === 1 ? one : many}`;
}
