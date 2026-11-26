/**
 * A pin dragged on the project rail (PlaceRail.tsx): the pins' order while it is carried over another pin, before
 * (the pointer on that pin's upper half) or after it (its lower half). Pure, so the order a drop saves is tested.
 */
export function movedPins(order: readonly string[], carried: string, over: string, after: boolean): string[] {
  if (carried === over || !order.includes(carried) || !order.includes(over)) return [...order];
  const without = order.filter((key) => key !== carried);
  const at = without.indexOf(over) + (after ? 1 : 0);
  without.splice(at, 0, carried);
  return without;
}
