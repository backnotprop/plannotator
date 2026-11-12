export type GuidesWebviewMode = "home" | "generating" | "answer";

export function webviewCsp(cspSource: string, nonce: string, mode: GuidesWebviewMode): string {
  return [
    "default-src 'none'",
    `img-src ${cspSource} data:`,
    `style-src ${cspSource} 'unsafe-inline'`,
    `font-src ${cspSource}`,
    mode === "answer" ? `script-src ${cspSource} 'unsafe-inline'` : `script-src 'nonce-${nonce}' 'strict-dynamic'`,
  ].join("; ");
}
