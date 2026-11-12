export interface MessageWindow {
  readonly parent: MessageWindow | null | undefined;
  readonly origin?: string;
}

export function fromWebviewHost(event: { source: unknown; origin: string }, self: MessageWindow = window as unknown as MessageWindow): boolean {
  const source = event.source as MessageWindow | null;
  if (source && source !== self && isInside(source, self)) return false;
  const own = self.origin ?? "null";
  if (own === "null") return event.origin === "null" && (source === self || source === self.parent);
  return event.origin === own;
}

function isInside(w: MessageWindow, self: MessageWindow): boolean {
  let cur: MessageWindow | null | undefined = w;
  for (let hops = 0; hops < 32 && cur; hops++) {
    let next: MessageWindow | null | undefined;
    try {
      next = cur.parent;
    } catch {
      return false;
    }
    if (!next || next === cur) return false;
    if (next === self) return true;
    cur = next;
  }
  return false;
}
