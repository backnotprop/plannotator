export function checkout(items: Item[]) {
  const subtotal = sumLineItems(items);
  return subtotal * 1.2;
}

function sumLineItems(items: Item[]): number {
  let subtotal = 0;
  for (const item of items) {
    subtotal += item.price * item.qty;
  }
  return subtotal;
}
