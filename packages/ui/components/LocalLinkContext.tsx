import { createContext, useContext, type ReactNode } from "react";
import { isCodeFilePath } from "@plannotator/core/code-file";

/**
 * What a host makes of a link to a local path (`[the mock](mock.html)`):
 *
 * - `open`: draw a link (Enter and a click call `open`, the browser never
 *   follows the href). `title` is its tooltip. `href`, when given, replaces
 *   the link's own target as its href, so "Open in new tab", a modified
 *   click (Cmd/Ctrl/Shift, middle button), drag and copy use it: a host's
 *   own address for the same thing. Without it, a modified click also calls
 *   `open` and the middle button does nothing.
 * - `unavailable`: draw the link text as inert text with `title` as its
 *   tooltip: no href, so nothing is fetched or navigated. `wrap`, when given,
 *   draws that text instead, without the tooltip (a host's own hover for that
 *   path, which then decides when `title` shows). `after`, when given, is drawn
 *   right after it (a host's own control for that path); deprecated, prefer `wrap`.
 * - `null` from the resolver: the renderer's default for that link.
 */
export type LocalLinkResolution =
  | { kind: "open"; open: () => void; title?: string; href?: string }
  | {
      kind: "unavailable";
      title: string;
      wrap?: (text: ReactNode) => ReactNode;
      /** @deprecated Use `wrap`. Still drawn right after the inert link, as before. */
      after?: ReactNode;
    };

/** Called with the link target as written (fragment and query included). */
export type LocalLinkResolver = (href: string) => LocalLinkResolution | null;

/**
 * Provided by `Viewer` from its optional `resolveLocalLink` prop. Absent
 * (null), every link renders exactly as it always has.
 */
export const LocalLinkContext = createContext<LocalLinkResolver | null>(null);

/**
 * A host's own wrap for an inline code span that names a code file (`src/a.ts:12`): `text` is the span's words, `code`
 * the span as it is drawn without a host. With no provider, nothing changes.
 */
export type CodeSpanRenderer = (text: string, code: ReactNode) => ReactNode;
export const CodeSpanContext = createContext<CodeSpanRenderer | null>(null);

/**
 * Opt-in: which code spans a host's wrap is asked about. Absent, a span that names a code file (`isCodeFilePath`), as
 * always; a host that opens any file (a picture, a page, a document) gives its own test.
 */
export const CodeSpanMatchContext = createContext<((text: string) => boolean) | null>(null);

/** An inline code span as drawn (`children`), through the host's wrap when it names a code file (or what the host's test takes). */
export function CodeSpan({ text, children }: { text: string; children: ReactNode }) {
  const wrap = useContext(CodeSpanContext);
  const match = useContext(CodeSpanMatchContext) ?? isCodeFilePath;
  return <>{wrap && match(text) ? wrap(text, children) : children}</>;
}

export function useLocalLinkResolver(): LocalLinkResolver | null {
  return useContext(LocalLinkContext);
}

/** A click the browser would open in a new tab or window: Cmd/Ctrl/Shift, or not the main button. */
export function isNewTabClick(event: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; button: number }): boolean {
  return event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0;
}

/**
 * Whether a link target names a local path a host resolver is asked about:
 * not an in-page `#anchor`, not protocol-relative (`//host`), and no URL
 * scheme (`https:`, `mailto:`, `file:` …). A Windows drive path (`C:\x`,
 * `C:/x`) is a path.
 */
export function isLocalLinkTarget(href: string): boolean {
  const target = href.trim();
  if (target === "" || target.startsWith("#") || target.startsWith("//")) return false;
  if (/^[a-z]:[\\/]/i.test(target)) return true;
  return !/^[a-z][a-z0-9+.-]*:/i.test(target);
}
