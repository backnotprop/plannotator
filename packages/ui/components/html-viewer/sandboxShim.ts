/**
 * What a page needs to run in the viewer's frame as it runs in a browser tab.
 *
 * The frame is sandboxed with scripts but without `allow-same-origin`: an
 * opaque origin, so two web APIs throw where a tab never would, and a page
 * that calls one of them while it builds itself stops there and stays blank:
 *
 * - `history.replaceState` / `pushState`. A srcdoc document's address is
 *   `about:srcdoc`, and the URL a page passes resolves against the viewer's
 *   `<base href>` (the page's folder on the asset route), so even
 *   `replaceState(null, '', '#state=C4')` names another address and throws a
 *   SecurityError. A served page (the Inbox's "Pages only") takes it, but its
 *   address becomes the folder's. A bare fragment (or an empty URL) is applied
 *   to the page's own address, as in a tab; any other URL the frame refuses
 *   keeps the page's address and takes only that URL's fragment. The state
 *   object is kept either way.
 * - `localStorage` / `sessionStorage`, whose getter throws in an opaque
 *   origin. Each becomes an in-memory Storage for this load of the page:
 *   nothing is written anywhere, so the frame still keeps nothing between
 *   loads (the sandbox is unchanged; this only stops the throw).
 *
 * Never in live mode: a proxied app runs on its own real origin. The shim is
 * idempotent: the inline path runs it first in `<head>` (so a page's own head
 * scripts find it) and the bridge runs it again (so the `bridgeScriptUrl`
 * path gets it too), where it does nothing the second time.
 *
 * A dependency-free string, like BRIDGE_SCRIPT: no backslashes, backticks or
 * closing script tag.
 */
export const SANDBOX_SHIM_SCRIPT = `(function() {
  var h = window.history;
  if (h && !(h.replaceState && h.replaceState.plannotatorSandboxShim)) {
    ['pushState', 'replaceState'].forEach(function(name) {
      var original = h[name];
      if (typeof original !== 'function') return;
      var shim = function(state, unused, url) {
        if (url === undefined || url === null) return original.apply(this, arguments);
        var raw = String(url);
        var own = location.href.split('#')[0];
        if (raw === '' || raw.charAt(0) === '#') return original.call(this, state, unused, own + raw);
        try {
          return original.call(this, state, unused, url);
        } catch (error) {
          if (!error || error.name !== 'SecurityError') throw error;
          var hash = '';
          try { hash = new URL(raw, document.baseURI).hash; } catch (ignored) {}
          return original.call(this, state, unused, own + hash);
        }
      };
      shim.plannotatorSandboxShim = true;
      h[name] = shim;
    });
  }

  function memoryStorage() {
    var items = new Map();
    var api = {
      getItem: function(key) { key = String(key); return items.has(key) ? items.get(key) : null; },
      setItem: function(key, value) { items.set(String(key), String(value)); },
      removeItem: function(key) { items.delete(String(key)); },
      clear: function() { items.clear(); },
      key: function(index) {
        var keys = Array.from(items.keys());
        index = Math.floor(Number(index)) || 0;
        return index >= 0 && index < keys.length ? keys[index] : null;
      }
    };
    var isApi = function(p) { return Object.prototype.hasOwnProperty.call(api, p); };
    var target = typeof Storage === 'function' ? Object.create(Storage.prototype) : {};
    return new Proxy(target, {
      get: function(t, p) {
        if (p === 'length') return items.size;
        if (typeof p === 'string' && isApi(p)) return api[p];
        if (typeof p === 'string' && items.has(p)) return items.get(p);
        return Reflect.get(t, p);
      },
      set: function(t, p, value) {
        if (typeof p !== 'string') return Reflect.set(t, p, value);
        if (!isApi(p) && p !== 'length') items.set(p, String(value));
        return true;
      },
      deleteProperty: function(t, p) {
        if (typeof p === 'string') items.delete(p);
        return true;
      },
      has: function(t, p) { return (typeof p === 'string' && items.has(p)) || p in t; },
      ownKeys: function() { return Array.from(items.keys()); },
      getOwnPropertyDescriptor: function(t, p) {
        if (typeof p === 'string' && items.has(p)) {
          return { value: items.get(p), writable: true, enumerable: true, configurable: true };
        }
        return undefined;
      }
    });
  }
  ['localStorage', 'sessionStorage'].forEach(function(name) {
    try { if (window[name]) return; } catch (denied) {}
    try {
      Object.defineProperty(window, name, { value: memoryStorage(), configurable: true, enumerable: true });
    } catch (ignored) {}
  });
})();`;
