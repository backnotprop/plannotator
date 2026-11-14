export function checkout(items: Item[]) {
  let subtotal = 0;
  for (const item of items) {
    subtotal += item.price * item.qty;
  }
  return subtotal * 1.2;
}

function logItems(items: Item[]): void {
  for (const item of items) {
    console.log(item.name);
  }
}
