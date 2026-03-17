import * as http from "http";
import { EventEmitter } from "events";
import { buildThemeListenerScript } from "./vscode-theme";

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
            { method: req.method, headers: proxyHeaders },
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

function injectScript(html: string, savedCookies: string): string {
  const initial = JSON.stringify(parseCookieString(savedCookies));
  const themeListener = buildThemeListenerScript();

  // Virtual cookie jar: overrides document.cookie so plannotator works even
  // when the browser blocks third-party cookies inside the iframe.
  const script = themeListener + `<script>(function(){
      var S=${initial};S["plannotator-auto-close"]="true";
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
    })();</script>`;

  const headMatch = html.match(/<head(\s[^>]*)?>/) ;
  if (headMatch) {
    const idx = html.indexOf(headMatch[0]) + headMatch[0].length;
    return html.slice(0, idx) + script + html.slice(idx);
  }
  return script + html;
}
