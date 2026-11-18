/**
 * Build-time stub for `@excalidraw/mermaid-to-excalidraw` in the Inbox.
 *
 * Excalidraw imports it in two places (0.18.1, `dist/prod/index.js`):
 * - its Text-to-diagram dialog, which the thread canvas never shows (no menu, no toolbar entry);
 * - a paste of text that looks like a Mermaid definition:
 *
 *       const api = await import("@excalidraw/mermaid-to-excalidraw");
 *       try { ... await api.parseMermaidToExcalidraw(text) ... return; } catch (err) { console.warn(...) }
 *       // then the text is pasted as text
 *
 * The real module brings a second Mermaid (11.x, nested under it) into inbox.html beside the Inbox's own. With this
 * stub the paste's `parseMermaidToExcalidraw` throws inside Excalidraw's try, and the words are pasted as text.
 */
export async function parseMermaidToExcalidraw(): Promise<never> {
  throw new Error('Mermaid diagrams are not drawn on the thread canvas');
}
