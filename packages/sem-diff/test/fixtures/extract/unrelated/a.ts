export function checkout(items: Item[]) {
  let subtotal = 0;
  for (const item of items) {
    subtotal += item.price * item.qty;
  }
  return subtotal * 1.2;
}
