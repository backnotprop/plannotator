/** What a page needs to run in the viewer's frame as it runs in a browser tab. */
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
