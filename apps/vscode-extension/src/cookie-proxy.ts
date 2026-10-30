import * as http from "http";
import { EventEmitter } from "events";
import { buildThemeListenerScript, THEME_MODE_COOKIE } from "./vscode-theme";

export interface CookieProxyOptions {
  loadCookies: () => string;
  onSaveCookies: (cookies: string) => void;
  onClose?: () => void;
}

export interface CookieProxy {
  server: http.Server;
  port: number;
  events: EventEmitter;
  rewriteUrl: (originalUrl: string) => string;
}

export function createCookieProxy(
  options: CookieProxyOptions,
): Promise<CookieProxy> {
  return new Promise((resolve, reject) => {
    const events = new EventEmitter();
    let upstream: string | null = null;
    /** `http://127.0.0.1:<port>` once listening: the origin the panel's page has. */
    let proxyOrigin: string | null = null;

    const server = http.createServer((req, res) => {
      const reqUrl = new globalThis.URL(req.url!, "http://localhost");

      // Special endpoint: save cookies
      if (reqUrl.pathname === "/___ext/cookies" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk: string) => (body += chunk));
        req.on("end", () => {
          options.onSaveCookies(body);
          res.writeHead(200);
          res.end("ok");
        });
        return;
      }

      // Special endpoint: close panel
      if (reqUrl.pathname === "/___ext/close" && req.method === "POST") {
        options.onClose?.();
        events.emit("close");
        res.writeHead(200);
        res.end("ok");
        return;
      }

      // Proxy to upstream
      if (!upstream) {
        res.writeHead(502);
        res.end("no upstream configured");
        return;
      }

      const targetUrl = new globalThis.URL(req.url!, upstream);
      const proxyHeaders: Record<string, string | string[] | undefined> = {
        ...req.headers,
        host: targetUrl.host,
        "accept-encoding": "identity",
      };
      // The page lives on this proxy's origin, so its writes carry
      // `Origin: http://127.0.0.1:<proxy port>` while Host now names the
      // server. Re-anchor that one Origin onto the upstream so the server's
      // same-origin check sees its own page (servers also accept
      // `Sec-Fetch-Site: same-origin`, which covers older extensions). Any
      // other Origin passes through untouched and stays foreign.
      if (proxyOrigin && req.headers.origin === proxyOrigin) {
        proxyHeaders.origin = new globalThis.URL(upstream).origin;
      }

      // Buffer request body so retries can replay it
      const bodyChunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => bodyChunks.push(chunk));
      req.on("end", () => {
        const body = Buffer.concat(bodyChunks);
        const MAX_RETRIES = 3;
        const BASE_DELAY = 200;

        function tryUpstreamRequest(attempt: number): void {
          const proxyReq = http.request(
            targetUrl.toString(),
            {
              method: req.method,
              headers: proxyHeaders,
              // Browsers resolve *.localhost themselves; Node's OS resolver may not.
              // Pin only the socket address, keeping the advertised Host and Origin.
              // Plain `localhost` and every other name resolve as before.
              ...upstreamConnectOptions(targetUrl.hostname),
            },
            (proxyRes) => {
              const contentType = proxyRes.headers["content-type"] || "";

              if (contentType.includes("text/html")) {
                // Buffer HTML to inject cookie sync script
                const chunks: Buffer[] = [];
                proxyRes.on("data", (chunk: Buffer) => chunks.push(chunk));
                proxyRes.on("end", () => {
                  const html = Buffer.concat(chunks).toString("utf-8");
                  const savedCookies = options.loadCookies();
                  const injected = injectScript(html, savedCookies);
                  const headers = { ...proxyRes.headers };
                  delete headers["content-length"];
                  delete headers["content-encoding"];
                  delete headers["transfer-encoding"];
                  // Restore cookies via Set-Cookie headers (works before any JS runs)
                  const setCookieHeaders = buildSetCookieHeaders(savedCookies);
                  if (setCookieHeaders.length > 0) {
                    headers["set-cookie"] = setCookieHeaders;
                  }
                  res.writeHead(proxyRes.statusCode || 200, headers);
                  res.end(injected);
                });
              } else {
                // Pass through non-HTML responses
                res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
                proxyRes.pipe(res);
              }
            },
          );

          proxyReq.on("error", () => {
            if (attempt < MAX_RETRIES) {
              const delay = BASE_DELAY * Math.pow(2, attempt);
              setTimeout(() => tryUpstreamRequest(attempt + 1), delay);
            } else {
              res.writeHead(502);
              res.end("proxy error");
            }
          });

          proxyReq.end(body);
        }

        tryUpstreamRequest(0);
      });
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        proxyOrigin = `http://127.0.0.1:${port}`;
        resolve({
          server,
          port,
          events,
          rewriteUrl(originalUrl: string): string {
            const parsed = new globalThis.URL(originalUrl);
            upstream = parsed.origin;
            return `http://127.0.0.1:${port}${parsed.pathname}${parsed.search}`;
          },
        });
      } else {
        reject(new Error("Failed to get proxy address"));
      }
    });

    server.on("error", reject);
  });
}

/**
 * How the proxy connects to its upstream. A session advertised at a
 * localhost subdomain (`urlHost: "plannotator.localhost"`, #2184) is
 * listening on 127.0.0.1, which a browser knows but Node's OS resolver may
 * not (Linux without `*.localhost` in nss), so only that shape connects to
 * the literal. `localhost` and every other name are resolved as they always
 * were. The same rule as `isLocalhostSubdomain` in packages/shared/loopback-host.ts.
 */
export function upstreamConnectOptions(hostname: string): { hostname?: string } {
  return /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+localhost$/i.test(hostname) ? { hostname: "127.0.0.1" } : {};
}

function buildSetCookieHeaders(savedCookies: string): string[] {
  if (!savedCookies) return [];
  return savedCookies
    .split("; ")
    .filter((c) => c.startsWith("plannotator-"))
    .map((c) => `${c}; Path=/; Max-Age=31536000; SameSite=Lax`);
}

function parseCookieString(str: string): Record<string, string> {
  const store: Record<string, string> = {};
  if (!str) return store;
  for (const c of str.split("; ")) {
    const eq = c.indexOf("=");
    if (eq > 0) store[c.slice(0, eq)] = c.slice(eq + 1);
  }
  return store;
}

/**
 * Marks a cookie store as having been through the seeding rules below, and at
 * which version. Written on every load, so its ABSENCE means exactly one thing:
 * this store was last written by an extension that predates the rules. That is
 * the only condition under which the legacy re-seed runs, which is what makes
 * it a one-time migration rather than a policy that keeps re-applying.
 *
 * It rides in the same jar as everything else: the page POSTs its whole
 * `document.cookie` back every 2s, so the marker lands in `globalState` with
 * the rest. If a panel closes before that first sync, nothing was persisted at
 * all and the migration simply runs again next time, on the same store.
 *
 * `plannotator-` prefixed so it travels with the rest of the store — that
 * prefix is what `buildSetCookieHeaders` restores as real cookies, so the jar
 * and the document agree about it. The app ignores cookies it does not know.
 *
 * The version is recorded for a future migration to read; the legacy re-seed
 * below gates on the marker being ABSENT rather than on the version matching,
 * because a bumped version must not re-run a rule whose whole justification is
 * that the stored value predates it.
 */
export const PANEL_SEED_COOKIE = "plannotator-vscode-seed";
export const PANEL_SEED_VERSION = "1";

/**
 * The mode a legacy panel store carries when the user never picked one.
 *
 * Plannotator's ThemeProvider persists the mode it resolved on its FIRST mount,
 * default included (`writeThemePairCookies` in packages/ui/config/settings.ts,
 * driven by the mirror effect in ThemeProvider.tsx and by the store's
 * cookie backfill in configStore.ensureLoaded). So any panel that ever loaded
 * has a mode cookie, and for a user who never chose one it is `dark` — the
 * app's default, which has never been anything else.
 */
const LEGACY_AUTO_SEEDED_MODE = "dark";

/**
 * Values the panel starts its virtual cookie jar with, on top of whatever the
 * user has already stored.
 *
 * The theme mode is SEEDED to System on a panel that has never stored one.
 * Plannotator's own default is Dark, which would leave a first-time user in a
 * light IDE staring at a dark panel now that the theme bridge no longer forces
 * the mode onto the app (see vscode-theme.ts). System is what "adapts to your
 * VS Code color theme" means here. It is a seed and not a write: an already
 * stored mode is never touched, so the moment the user picks one this stops
 * applying.
 *
 * ---
 *
 * Upgrade path (issue #1053 again, for the users who reported it). Seeding an
 * absent mode only ever helped panels opened for the FIRST time on this
 * version. Every panel opened before it already stored `dark` — written by the
 * app, not chosen by the user — so the seed above never fired for them and the
 * panel stayed dark in a light IDE: the exact bug, still broken for exactly the
 * people who hit it.
 *
 * There is no provenance to read. The store is one flat cookie string in
 * `globalState` with no timestamps and no per-cookie metadata, and the app
 * writes the same `plannotator-theme=dark` whether the user picked Dark or
 * never opened the theme settings. So `dark` alone cannot be interpreted, and
 * this migration leans on the three things that CAN be:
 *
 *  1. Value. `light` and `system` are never what the auto-seed writes, so a
 *     store carrying either is a choice and is left alone. Only the exact
 *     legacy default is re-seeded.
 *  2. The marker above. The re-seed runs once per store, so a Dark chosen
 *     after the migration is permanent — that is the case that must never be
 *     clobbered, and it cannot be, because by then the marker is present.
 *  3. The app's own record of the choice. `configStore.set` (what the theme
 *     picker calls) writes the mode to ~/.plannotator/config.json, while
 *     `seed`/`ensureLoaded` deliberately never do. `configStore.init` then
 *     applies that server value OVER the cookie and rewrites the cookie to
 *     match. So for any mode the user actually picked while a Plannotator
 *     server was running — which is every panel session — the choice outranks
 *     whatever we seed, re-asserts itself in the same page load, and syncs
 *     back into the store alongside the marker.
 *
 * What that leaves: a user whose explicit Dark exists ONLY as a cookie, with
 * nothing in config.json to restore it. They are indistinguishable from a user
 * who never chose, and they get System once. In a dark IDE that resolves to
 * dark and nothing changes; in a light IDE the panel turns light and re-picking
 * Dark makes it stick for good. That one-time cost is the price of unbreaking
 * every user who never chose at all, and it is paid at most once.
 */
export function applyPanelCookieDefaults(
  store: Record<string, string>,
): Record<string, string> {
  const seeded: Record<string, string> = {
    ...store,
    "plannotator-auto-close": "true",
  };
  const storedMode = seeded[THEME_MODE_COOKIE];
  const alreadyMarked = seeded[PANEL_SEED_COOKIE] !== undefined;
  if (!storedMode || (!alreadyMarked && storedMode === LEGACY_AUTO_SEEDED_MODE)) {
    seeded[THEME_MODE_COOKIE] = "system";
  }
  // Unconditional, and unconditional on a fresh store too: a user who picks
  // Dark right after their first panel opens must not look like a legacy store
  // the next time one does.
  seeded[PANEL_SEED_COOKIE] = PANEL_SEED_VERSION;
  return seeded;
}

/**
 * The panel's clipboard bridge and key forwarder, as plain JavaScript source
 * injected into the proxied page (and evaluated by the tests). It is a function
 * `(win, doc, post) => { write, read }`, where `post` sends one message to the
 * extension host.
 *
 * Clipboard: inside a nested cross-origin webview iframe the document never
 * holds focus, so the async Clipboard API is rejected and native copy/cut/paste
 * events never fire. Reads and writes go through the extension host (which owns
 * the system clipboard), driven off keydown, the only input signal the iframe
 * still receives.
 *
 * Key forwarding: every other key goes to VS Code so its keybindings keep
 * working while the panel has focus, but only a key no handler on the page took.
 * The listener is registered first (it runs in <head>), so it cannot read
 * `defaultPrevented` when it runs; it reads it after the event has finished
 * dispatching. That has to be a task, not a microtask: for a key the user
 * presses, the browser runs microtasks between listener calls, so a microtask
 * queued here would run before the app's own listeners.
 */
export const KEY_BRIDGE_SOURCE = `function(win,doc,post){
  var readSeq=0,readPending={};
  function write(text){post({type:"plannotator-clipboard-write",text:String(text==null?"":text)});}
  function read(){return new Promise(function(resolve){var id=++readSeq;readPending[id]=resolve;post({type:"plannotator-clipboard-read",id:id});});}
  function fieldSelection(el){
    if(el&&(el.tagName==="INPUT"||el.tagName==="TEXTAREA")&&el.selectionStart!=null&&el.selectionEnd>el.selectionStart){
      return el.value.slice(el.selectionStart,el.selectionEnd);
    }
    return (win.getSelection&&win.getSelection().toString())||"";
  }
  win.addEventListener("message",function(e){var d=e.data;if(d&&d.type==="plannotator-clipboard-data"){var cb=readPending[d.id];if(cb){delete readPending[d.id];cb(d.text||"");}}});
  win.addEventListener("keydown",function(e){
    var k=(e.key||"").toLowerCase();
    if((e.metaKey||e.ctrlKey)&&!e.altKey){
      if(k==="c"||k==="x"){
        var sel=fieldSelection(doc.activeElement);
        if(sel){
          e.preventDefault();
          write(sel);
          if(k==="x")doc.execCommand("delete");
        }
        return;
      }
      if(k==="v"){
        e.preventDefault();
        read().then(function(text){if(text)doc.execCommand("insertText",false,text);});
        return;
      }
      // Undo/redo/select-all stay native; forwarding them would hijack them.
      if(k==="a"||k==="z"||k==="y")return;
    }
    var ev={
      key:e.key,code:e.code,keyCode:e.keyCode,which:e.which,location:e.location,
      ctrlKey:e.ctrlKey,shiftKey:e.shiftKey,altKey:e.altKey,metaKey:e.metaKey,repeat:e.repeat
    };
    // VS Code's own window keys (Quick Open, the Command Palette, close
    // editor, switch editor) always reach VS Code, even when the page took
    // them: inside the panel they must keep doing what they do everywhere.
    var global=((e.metaKey||e.ctrlKey)&&!e.altKey&&(k==="p"||(k==="w"&&!e.shiftKey)))||(e.ctrlKey&&!e.metaKey&&!e.altKey&&e.key==="Tab");
    setTimeout(function(){
      if(e.defaultPrevented&&!global)return;
      try{post({type:"plannotator-keydown",event:ev});}catch(err){}
    },0);
  });
  return {write:write,read:read};
}`;

function injectScript(html: string, savedCookies: string): string {
  const initial = JSON.stringify(
    applyPanelCookieDefaults(parseCookieString(savedCookies)),
  );
  const themeListener = buildThemeListenerScript();

  // Virtual cookie jar: overrides document.cookie so plannotator works even
  // when the browser blocks third-party cookies inside the iframe.
  const script = themeListener + `<script>(function(){
      var S=${initial};
      Object.defineProperty(document,"cookie",{configurable:true,
        get:function(){return Object.keys(S).map(function(k){return k+"="+S[k]}).join("; ");},
        set:function(v){
          var p=v.split(";"),nv=p[0].trim(),eq=nv.indexOf("=");
          if(eq<1)return;
          var n=nv.slice(0,eq);
          if(/max-age\\s*=\\s*0/i.test(v)){delete S[n];}else{S[n]=nv.slice(eq+1);}
        }
      });
      function sc(){var c=document.cookie;if(c)fetch("/___ext/cookies",{method:"POST",body:c}).catch(function(){});}
      setTimeout(sc,500);setInterval(sc,2000);
      var ci=setInterval(function(){if(document.body&&document.body.textContent.indexOf("Your response has been sent")!==-1){clearInterval(ci);sc();fetch("/___ext/close",{method:"POST"});}},500);
      try{window.parent.postMessage("plannotator-ready","*");}catch(e){}
      // Clipboard bridge and key forwarding: see KEY_BRIDGE_SOURCE.
      var keyBridge=(${KEY_BRIDGE_SOURCE})(window,document,function(msg){window.parent.postMessage(msg,"*");});
      try{Object.defineProperty(navigator,"clipboard",{configurable:true,value:{
        writeText:function(t){keyBridge.write(t);return Promise.resolve();},
        readText:function(){return keyBridge.read();}
      }});}catch(err){}
      // External-link bridge (#1583): the webview sandbox has no allow-popups,
      // so window.open and target=_blank links do nothing in this frame. Route
      // absolute http(s) URLs to the extension host (vscode.env.openExternal);
      // anything else keeps the native behavior.
      function externalHref(u){try{var r=new URL(String(u),location.href);if((r.protocol==="http:"||r.protocol==="https:")&&r.origin!==location.origin)return r.href;}catch(err){}return null;}
      function openExternal(href){window.parent.postMessage({type:"plannotator-open-external",url:href},"*");}
      var nativeOpen=window.open;
      window.open=function(u,t,f){var href=u?externalHref(u):null;if(href){openExternal(href);return null;}return nativeOpen.apply(window,arguments);};
      document.addEventListener("click",function(e){
        if(e.defaultPrevented||e.button!==0)return;
        var a=e.target&&e.target.closest?e.target.closest("a[href]"):null;
        if(!a||a.target!=="_blank")return;
        var href=externalHref(a.getAttribute("href"));
        if(!href)return;
        e.preventDefault();openExternal(href);
      },false);
    })();</script>`;

  const headMatch = html.match(/<head(\s[^>]*)?>/) ;
  if (headMatch) {
    const idx = html.indexOf(headMatch[0]) + headMatch[0].length;
    return html.slice(0, idx) + script + html.slice(idx);
  }
  return script + html;
}
