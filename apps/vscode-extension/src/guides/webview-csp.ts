/**
 * The Guides webviews' Content Security Policy. Scripts run only from the
 * extension, by nonce, except in the answer tab: it shows the agent's page,
 * scripts included, in a sandboxed frame that inherits this policy, so inline
 * scripts must be allowed there (a nonce would turn 'unsafe-inline' off). The
 * answer tab puts no agent HTML in its own DOM. Nothing may connect anywhere.
 */

export type GuidesWebviewMode = "home" | "generating" | "guide" | "chapter" | "answer";

export function webviewCsp(cspSource: string, nonce: string, mode: GuidesWebviewMode): string {
  return [
    "default-src 'none'",
    `img-src ${cspSource} data:`,
    `style-src ${cspSource} 'unsafe-inline'`,
    `font-src ${cspSource}`,
    // 'unsafe-inline' here ONLY because the answer page's sandboxed srcdoc frame inherits this
    // policy and its scripts must run. The answer tab itself must never insert unsanitized HTML
    // into its own DOM (agent text goes through DOMPurify; the agent's page only into the frame),
    // and it accepts messages only from the webview host (main.ts `fromWebviewHost`).
    mode === "answer" ? `script-src ${cspSource} 'unsafe-inline'` : `script-src 'nonce-${nonce}'`,
  ].join("; ");
}
