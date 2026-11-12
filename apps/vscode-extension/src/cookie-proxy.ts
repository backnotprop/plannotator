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
    let proxyOrigin: string | null = null;

    const server = http.createServer((req, res) => {
      const reqUrl = new globalThis.URL(req.url!, "http://localhost");

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

      if (reqUrl.pathname === "/___ext/close" && req.method === "POST") {
        options.onClose?.();
        events.emit("close");
        res.writeHead(200);
        res.end("ok");
        return;
      }

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
      if (proxyOrigin && req.headers.origin === proxyOrigin) {
        proxyHeaders.origin = new globalThis.URL(upstream).origin;
      }

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
              ...upstreamConnectOptions(targetUrl.hostname),
            },
            (proxyRes) => {
              const contentType = proxyRes.headers["content-type"] || "";

              if (contentType.includes("text/html")) {
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
                  const setCookieHeaders = buildSetCookieHeaders(savedCookies);
                  if (setCookieHeaders.length > 0) {
                    headers["set-cookie"] = setCookieHeaders;
                  }
                  res.writeHead(proxyRes.statusCode || 200, headers);
                  res.end(injected);
                });
              } else {
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

export const PANEL_SEED_COOKIE = "plannotator-vscode-seed";
export const PANEL_SEED_VERSION = "1";

const LEGACY_AUTO_SEEDED_MODE = "dark";

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
  seeded[PANEL_SEED_COOKIE] = PANEL_SEED_VERSION;
  return seeded;
}

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
      if(k==="a"){
        if(e.defaultPrevented||e.isComposing)return;
        var el=doc.activeElement;
        // Native select-all does not reach text fields in the nested webview.
        if(!e.shiftKey&&el&&(el.tagName==="INPUT"||el.tagName==="TEXTAREA")&&el.selectionStart!=null){
          el.select();
          e.preventDefault();
        }
        return;
      }
      // Undo/redo stay native; forwarding them would hijack them.
      if(k==="z"||k==="y")return;
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
