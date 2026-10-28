/** The webview's tiny DOM helpers. */

export type Child = Node | string | null | undefined | false;

export function h(tag: string, attrs: Record<string, string | number | boolean | undefined | null | ((e: Event) => void)> = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (typeof v === "function") el.addEventListener(k.replace(/^on/, "").toLowerCase(), v as EventListener);
    else if (k === "class") el.className = String(v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

export function icon(name: string, extra = ""): HTMLElement {
  return h("span", { class: `codicon codicon-${name} ${extra}`, "aria-hidden": "true" });
}
