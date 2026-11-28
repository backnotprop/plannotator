function shimSource(base: string): string {
  return `(function(){var B=${JSON.stringify(base)};var W=window;var L=W.location;
function fix(u){if(typeof u!=="string")return u;if(u.charAt(0)==="/"&&u.charAt(1)!=="/"){return u.indexOf(B+"/")===0?u:B+u;}
if(u.indexOf("://")<0)return u;
try{var x=new URL(u);var ws=L.protocol==="https:"?"wss:":"ws:";if(x.host===L.host&&(x.protocol===L.protocol||x.protocol===ws)&&x.pathname.indexOf(B+"/")!==0){x.pathname=B+x.pathname;return x.href;}}catch(e){}return u;}
var F=W.fetch;if(F){W.fetch=function(i,o){if(typeof i==="string")return F.call(W,fix(i),o);if(i instanceof URL)return F.call(W,fix(i.href),o);if(W.Request&&i instanceof W.Request){var n=fix(i.url);return F.call(W,n===i.url?i:new W.Request(n,i),o);}return F.call(W,i,o);};}
var X=W.XMLHttpRequest&&W.XMLHttpRequest.prototype;if(X){var xo=X.open;X.open=function(m,u){var a=Array.prototype.slice.call(arguments);a[1]=fix(u instanceof URL?u.href:u);return xo.apply(this,a);};}
function wrap(name){var C=W[name];if(!C)return;var D=function(u,o){return new C(fix(u instanceof URL?u.href:u),o);};D.prototype=C.prototype;for(var k in C){try{D[k]=C[k];}catch(e){}}["CONNECTING","OPEN","CLOSING","CLOSED"].forEach(function(s){if(s in C)D[s]=C[s];});W[name]=D;}
wrap("EventSource");wrap("WebSocket");
var N=W.navigator;if(N&&N.sendBeacon){var sb=N.sendBeacon.bind(N);N.sendBeacon=function(u,d){return sb(fix(u instanceof URL?u.href:u),d);};}
W.__plannotatorDoorBase=B;})();`;
}

export function doorBaseScript(base: string): string {
  return `<script data-plannotator-door>${shimSource(base)}</script>`;
}

const ROOT_ABSOLUTE = /<(script|link)\b([^>]*?)\s(src|href)="\/(?!\/)/gi;

export function injectDoorBase(html: string, base: string): string {
  const rewritten = html.replace(ROOT_ABSOLUTE, (_match, tag: string, attrs: string, attr: string) => `<${tag}${attrs} ${attr}="${base}/`);
  const head = /<head[^>]*>/i.exec(rewritten);
  const at = head ? head.index + head[0].length : 0;
  return `${rewritten.slice(0, at)}${doorBaseScript(base)}${rewritten.slice(at)}`;
}
