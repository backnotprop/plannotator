export function report(rows: Row[]) {
  const header = 'Report';
  const total = activeTotal(rows, true);
  console.log(header, total);
  return total;
}

function activeTotal(rows: Row[], onlyActive: boolean): number {
  let total = 0;
  for (const r of rows) {
    if (!onlyActive || r.active) {
      total += r.amount;
    }
  }
  return total;
}
