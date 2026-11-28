/** Real resource attempts, with distinct paths for each parser/runtime phase. */
export function resourcePolicyFixture(origin: string, run: string): string {
  const url = (phase: string, kind: string) => `${origin}/${run}/${phase}/${kind}`;
  const markup = (phase: string) => `
<script src="${url(phase, 'script')}"></script>
<link rel="stylesheet" href="${url(phase, 'stylesheet')}">
<style>@import url('${url(phase, 'import')}');
@font-face { font-family: probe-${phase}; src: url('${url(phase, 'font')}'); }
.probe-${phase} { font-family: probe-${phase}; background-image: url('${url(phase, 'css-image')}'); }</style>
<img src="${url(phase, 'image')}" alt=""><span class="probe-${phase}">Resource probe</span>
<iframe src="${url(phase, 'frame')}" title="Resource probe"></iframe>`;
  const requests = (phase: string) => `
fetch('${url(phase, 'fetch')}').catch(function() {});
var xhr = new XMLHttpRequest(); xhr.open('GET', '${url(phase, 'xhr')}'); xhr.send();
try { new WebSocket('${url(phase, 'websocket').replace('http:', 'ws:')}'); } catch(e) {}
try { navigator.sendBeacon('${url(phase, 'beacon')}', 'probe'); } catch(e) {}
try { new Worker('${url(phase, 'worker')}'); } catch(e) {}
// A remote worker fails the browser's origin check before CSP. A blob worker
// reaches CSP's worker-src check without making a network request.
try { var blob = URL.createObjectURL(new Blob([''], { type: 'text/javascript' })); new Worker(blob).terminate(); URL.revokeObjectURL(blob); } catch(e) {}
`;
  const attack = `
window.__plannotatorLiveConfig = { nested: true, token: 'hostile', proxyOrigin: '${origin}' };
try { delete window.__plannotatorLiveConfig; } catch(e) {}
try { Object.defineProperty(window, '__plannotatorLiveConfig', { value: { nested: true } }); } catch(e) {}
`;
  return `<!doctype html><html lang="en" data-author="preserved">
<script>
window.violations = [];
addEventListener('securitypolicyviolation', function(e) {
  window.violations.push({ directive: e.effectiveDirective, uri: e.blockedURI });
  parent.postMessage({ type: 'resource-policy-csp-report', directive: e.effectiveDirective, uri: e.blockedURI }, '*');
});
${attack}
${requests('early')}
</script>
${markup('early')}
<head><meta charset="utf-8"><title>Single-file shop</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'">
${markup('head')}
<script>${requests('head')}</script>
<style>
body { margin: 24px; font: 18px/1.6 system-ui; color: #172235; background: #fff; }
button { font: inherit; padding: 10px 18px; cursor: pointer; }
.probe-early, .probe-head, .probe-late, img:not(#embedded), iframe { display: block; width: 12px; height: 12px; }
#quote { width: max-content; max-width: 100%; }
#pin { margin-top: 24px; padding: 18px; border: 1px solid #7b8798; }
</style></head><body>
<h1>Single-file shop</h1>
<p id="quote">A small cart with inline interaction.</p>
<p>Cart: <output id="cart">0</output></p>
<button id="inline" onclick="document.getElementById('cart').textContent = Number(document.getElementById('cart').textContent) + 1">Add inline</button>
<button id="listener">Add with listener</button>
<p>Computed total: <output id="eval"></output></p>
<img id="embedded" alt="Embedded green square" width="28" height="28" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='28' height='28'%3E%3Cpath fill='green' d='M0 0h28v28H0z'/%3E%3C/svg%3E">
<div id="pin">Review the checkout layout.</div>
<script>
${attack}
document.getElementById('listener').addEventListener('click', function() {
 document.getElementById('cart').textContent = Number(document.getElementById('cart').textContent) + 1;
});
document.getElementById('eval').textContent = new Function('return 6 * 7')();
addEventListener('load', function() {
  var late = document.createElement('div');
  late.innerHTML = ${JSON.stringify(markup('late').replace(/<script[\s\S]*?<\/script>/, ''))};
  document.body.appendChild(late);
  var script = document.createElement('script'); script.src = '${url('late', 'script')}'; document.head.appendChild(script);
  ${requests('late')}
  document.body.dataset.loaded = 'true';
});
</script></body></html>`;
}
