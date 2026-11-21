/**
 * The Guides webviews' Content Security Policy. Scripts run only from the
 * extension, by nonce, except in the answer tab: it shows the agent's page,
 * scripts included, in a sandboxed frame that inherits this policy, so inline
 * scripts must be allowed there (a nonce would turn 'unsafe-inline' off). The
 * answer tab puts no agent HTML in its own DOM. Nothing may connect anywhere.
 */

export type GuidesWebviewMode = "home" | "generating" | "answer";

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
    // Elsewhere only the nonced script runs, and what it loads itself ('strict-dynamic': the diagram
    // engine it imports when it draws one). No host is listed, so markup that got past the sanitizer
    // cannot load any script of its own, not even one of the extension's.
    mode === "answer" ? `script-src ${cspSource} 'unsafe-inline'` : `script-src 'nonce-${nonce}' 'strict-dynamic'`,
  ].join("; ");
}
