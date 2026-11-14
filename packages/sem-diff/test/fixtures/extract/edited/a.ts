export function report(rows: Row[]) {
  const header = 'Report';
  let total = 0;
  for (const r of rows) {
    if (r.active) {
      total += r.amount;
    }
  }
  console.log(header, total);
  return total;
}
