import DOMPurify from "dompurify";
import { Marked } from "marked";

const marked = new Marked({ gfm: true, breaks: false });

const ALERT_KINDS: Record<string, string> = {
  NOTE: "Note",
  TIP: "Tip",
  IMPORTANT: "Important",
  WARNING: "Warning",
  CAUTION: "Caution",
};

const LINK_RE = /^(code|symbol|chapter):/i;

type Purifier = typeof DOMPurify;
let purifier: Purifier | null = null;

function purify(): Purifier {
  if (purifier) return purifier;
  purifier = typeof DOMPurify.sanitize === "function" ? DOMPurify : (DOMPurify as unknown as (w: Window) => Purifier)(window);
  return purifier;
}

let hooked = false;
function hookOnce(): void {
  if (hooked) return;
  hooked = true;
  purify().addHook("afterSanitizeAttributes", (node) => {
    if (node.nodeName === "A") {
      const href = node.getAttribute("href") ?? "";
      node.removeAttribute("href");
      node.removeAttribute("target");
      if (LINK_RE.test(href)) {
        node.setAttribute("data-link", href);
        node.setAttribute("class", "pn-link");
        node.setAttribute("tabindex", "0");
        node.setAttribute("role", "link");
      } else if (/^https?:\/\//i.test(href)) {
        node.setAttribute("data-external", href);
        node.setAttribute("class", "pn-ext");
        node.setAttribute("tabindex", "0");
        node.setAttribute("role", "link");
      }
    }
  });
}

const PURIFY_CONFIG = {
  ALLOWED_URI_REGEXP: /^(?:code:|symbol:|chapter:|https?:)/i,
  ALLOW_DATA_ATTR: false,
  FORBID_TAGS: ["style", "form", "input", "button", "textarea", "select", "iframe", "object", "embed", "img", "video", "audio", "svg", "math"],
  FORBID_ATTR: ["style", "id", "class"],
};

function textOnly(text: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const p = document.createElement("p");
  p.textContent = text;
  fragment.appendChild(p);
  return fragment;
}

export function renderMarkdown(text: string): DocumentFragment {
  if (!purify().isSupported) return textOnly(text);
  hookOnce();
  const html = marked.parse(text, { async: false }) as string;
  const fragment = purify().sanitize(html, { ...PURIFY_CONFIG, RETURN_DOM_FRAGMENT: true }) as DocumentFragment;
  for (const quote of Array.from(fragment.querySelectorAll("blockquote"))) markAlert(quote);
  return fragment;
}

export function renderInlineMarkdown(text: string): DocumentFragment {
  if (!purify().isSupported) {
    const fragment = document.createDocumentFragment();
    fragment.appendChild(document.createTextNode(text));
    return fragment;
  }
  hookOnce();
  const html = marked.parseInline(text, { async: false }) as string;
  return purify().sanitize(html, { ...PURIFY_CONFIG, RETURN_DOM_FRAGMENT: true }) as DocumentFragment;
}

function markAlert(quote: HTMLQuoteElement): void {
  const first = quote.querySelector("p");
  if (!first) return;
  const m = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i.exec(first.textContent ?? "");
  if (!m) return;
  const kind = m[1].toUpperCase();
  quote.classList.add("pn-alert", `pn-alert-${kind.toLowerCase()}`);
  const walker = document.createTreeWalker(first, NodeFilter.SHOW_TEXT);
  const textNode = walker.nextNode() as Text | null;
  if (textNode) textNode.data = textNode.data.replace(/^\s*\[![A-Z]+\]\s*/i, "");
  const title = document.createElement("div");
  title.className = "pn-alert-title";
  title.textContent = ALERT_KINDS[kind];
  quote.insertBefore(title, quote.firstChild);
}
