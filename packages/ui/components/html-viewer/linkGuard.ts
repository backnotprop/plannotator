/**
 * The link guard: the only way a link in the viewer's frame reaches the host.
 *
 * A link the person followed moves the host (in the Inbox: to another thread),
 * so it never rides the window-wide postMessage the page's own script can
 * forge. The guard runs FIRST in the frame's document, before any page script
 * (`injectLinkGuard`, at the start of `<head>` or before a script that comes
 * ahead of it):
 *
 * - It makes a MessageChannel and offers one end to the host at once
 *   (`plannotator-bridge-link-offer`, with the key of this load). It keeps the
 *   other end in its closure: no page script can ever reach it.
 * - It records, in a capture listener on the window registered before any page
 *   listener, the person's click being dispatched (`isTrusted`).
 * - It exposes one function, `window.__plannotatorLinkGuard.follow(kind, msg)`,
 *   which the bridge calls from its click handlers. It sends a `link-click` on
 *   its port only while a person's click is being dispatched, and only for the
 *   link that click is on (`kind: 'link'`: the same href, read from the
 *   clicked element at that moment), or for a GET form's address (`kind:
 *   'form'`: the click is on a button or input; a query, no fragment). The
 *   page owns its DOM: during a real click its script can rewrite the link or
 *   wrap the clicked element in one, so it controls the address sent (never
 *   `javascript:`), and the host's own scheme and origin checks decide what
 *   that opens. It can never send anything without a person's click.
 *
 * The host takes ONE offer per document it loaded itself, and only with that
 * load's key (`armLinkOffer` in useHtmlAnnotation): the key is new for every
 * srcdoc the viewer builds, and for every address it gives a served frame
 * (`__pnk` in the query, read and removed here before any page script sees
 * it). A forged `ready`, a second offer, a page that navigated its own frame
 * elsewhere (the asset route's copy has no guard) or rewrote itself with
 * `document.open()`: none of them gets a port.
 *
 * Every built-in it uses later is read now, before a page script can replace
 * it. A dependency-free string, like BRIDGE_SCRIPT and the sandbox shim: no
 * backslashes, backticks or closing script tag.
 */

/** The frame's one offer per load: `{ type, key }`, with the port the guard keeps the other end of. */
export const LINK_OFFER_MESSAGE = "plannotator-bridge-link-offer";

/** What the guard sends on that port for a person's click: `{ type, href }` (the raw href, at most 2048 chars). */
export const LINK_CLICK_MESSAGE = "plannotator-bridge-link-click";

/** The query parameter that carries a served frame's key (removed by the guard). */
export const LINK_KEY_PARAM = "__pnk";

/** A load's key: 32 hex characters. */
export const LINK_KEY_RE = /^[0-9a-f]{32}$/;

/** A fresh key for one load of the frame. */
export function newLinkKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * `url` with this load's key as its last `__pnk` query parameter (any other
 * `__pnk` removed). The rest of the query and the fragment are kept as they
 * are, so the page reads the same `location.search` once the guard removes it.
 */
export function withLinkKey(url: string, key: string, base: string): string {
  // A path on the host's own server stays a path (the address the host gave),
  // whatever the base is (a host document at about:blank included).
  const rootPath = isRootPath(url);
  let next: URL;
  try {
    next = new URL(url, rootPath ? "http://root-path.invalid/" : base);
  } catch {
    return url;
  }
  const kept = next.search.slice(1).split("&").filter((part) => part !== "" && !part.startsWith(`${LINK_KEY_PARAM}=`));
  kept.push(`${LINK_KEY_PARAM}=${key}`);
  next.search = `?${kept.join("&")}`;
  return rootPath ? `${next.pathname}${next.search}${next.hash}` : next.href;
}

/** A path on the host's own server (`/x`, not `//host/x`). */
export function isRootPath(url: string): boolean {
  return url.startsWith("/") && !url.startsWith("//");
}

/** The guard, as a function expression taking the key of this load. */
export const LINK_GUARD_FUNCTION = `(function(inlineKey) {
  if (window.__plannotatorLinkGuard) return;
  var host = window.parent;
  if (!host || host === window) return;
  var KEY_PARAM = '${LINK_KEY_PARAM}=';
  var isKey = function(value) { return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value); };
  var key = isKey(inlineKey) ? inlineKey : null;
  // A served frame's address carries its own key (new for every load the host
  // starts); the page never sees it.
  try {
    var search = location.search;
    if (search.indexOf(KEY_PARAM) >= 0) {
      var kept = [];
      var parts = search.slice(1).split('&');
      for (var i = 0; i < parts.length; i++) {
        if (parts[i].indexOf(KEY_PARAM) === 0) {
          var value = parts[i].slice(KEY_PARAM.length);
          if (isKey(value)) key = value;
        } else if (parts[i] !== '') {
          kept.push(parts[i]);
        }
      }
      var own = location.href.split('#')[0].split('?')[0];
      try { history.replaceState(history.state, '', own + (kept.length ? '?' + kept.join('&') : '') + location.hash); } catch (ex) {}
    }
  } catch (ex) {}
  if (!key) return;
  var channel;
  try { channel = new MessageChannel(); } catch (ex) { return; }
  var port = channel.port1;
  var callOf = Function.prototype.bind.bind(Function.prototype.call);
  var getterOf = function(proto, name) {
    var d = proto && Object.getOwnPropertyDescriptor(proto, name);
    return d && typeof d.get === 'function' ? callOf(d.get) : function(target) { return target[name]; };
  };
  var portPost = callOf(Object.getPrototypeOf(port).postMessage);
  var phaseOf = getterOf(Event.prototype, 'eventPhase');
  var targetOf = getterOf(Event.prototype, 'target');
  var nodeTypeOf = getterOf(Node.prototype, 'nodeType');
  var parentOf = getterOf(Node.prototype, 'parentElement');
  var closest = callOf(Element.prototype.closest);
  var attr = callOf(Element.prototype.getAttribute);
  var trim = callOf(String.prototype.trim);
  var slice = callOf(String.prototype.slice);
  var indexOf = callOf(String.prototype.indexOf);
  var test = callOf(RegExp.prototype.test);
  var scriptHref = /^javascript:/i;
  var LINK_CLICK = 'plannotator-bridge-link-click';
  // The person's click being dispatched. First on the path of every click: a
  // window capture listener registered before any page script ran.
  var current = null;
  window.addEventListener('click', function(e) { if (e.isTrusted) current = e; }, true);
  function clickedElement() {
    var e = current;
    if (!e || phaseOf(e) === 0) return null;
    var target = targetOf(e);
    if (!target) return null;
    return nodeTypeOf(target) === 1 ? target : parentOf(target);
  }
  function follow(kind, msg) {
    var href = msg && typeof msg.href === 'string' ? String(msg.href) : '';
    if (!href || href.length > 2048) return false;
    var el = clickedElement();
    if (!el) return false;
    if (kind === 'link') {
      var link = closest(el, 'a,area');
      if (!link) return false;
      var raw = attr(link, 'href');
      if (typeof raw !== 'string') raw = attr(link, 'xlink:href');
      if (typeof raw !== 'string') return false;
      raw = trim(raw);
      if (!raw || test(scriptHref, raw) || slice(raw, 0, 2048) !== href) return false;
    } else if (kind === 'form') {
      if (!closest(el, 'button, input')) return false;
      if (indexOf(href, '?') < 0 || indexOf(href, '#') >= 0) return false;
    } else {
      return false;
    }
    try { portPost(port, { type: LINK_CLICK, href: href }); } catch (ex) { return false; }
    return true;
  }
  try {
    Object.defineProperty(window, '__plannotatorLinkGuard', {
      value: Object.freeze({ follow: follow }),
      enumerable: false,
      writable: false,
      configurable: false
    });
  } catch (ex) { return; }
  try { host.postMessage({ type: 'plannotator-bridge-link-offer', key: key }, '*', [channel.port2]); } catch (ex) {}
})`;

/** The guard's inline `<script>` for one load (inline path: first in the document). */
export function linkGuardScriptTag(key: string): string {
  if (!LINK_KEY_RE.test(key)) throw new Error("link guard: the key must be 32 hex characters");
  return `<script>${LINK_GUARD_FUNCTION}('${key}');</script>`;
}
