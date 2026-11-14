import { replaceEqualDeep } from '@tanstack/react-query';

/**
 * A map of plain values built again on each render, with each key's value kept as the held one while it is equal
 * (deep). A message body compares its data by identity (parts/MessageView.tsx), so a value rebuilt equal must stay the
 * same object or every body that reads it draws again.
 */
export function keepEqualByKey<V>(held: ReadonlyMap<string, V> | null, next: Map<string, V>): Map<string, V> {
  if (!held) return next;
  for (const [key, value] of next) next.set(key, replaceEqualDeep(held.get(key), value));
  return next;
}
