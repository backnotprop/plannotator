/**
 * `ui://plannotator/annotate` — the MCP Apps view for the annotate tool.
 *
 * Deliberately tiny and self-contained (no build step, no network): the host
 * renders it in a sandboxed webview that cannot load the local Plannotator
 * page, so it does not try to. It shows the session state and link, opens
 * the session through `ui/open-link`, and learns state by calling the
 * app-only `annotate_session_status` tool through the host (`tools/call`).
 *
 * Delivery rule: the blocking tool result is how feedback reaches the model.
 * The view only posts the feedback with `ui/message` when the session has
 * been decided but the host never delivered the tool result to the view
 * (`ui/notifications/tool-result`) within a grace period — so a host that
 * behaves per spec never gets the feedback twice. If the host does not
 * render MCP Apps at all, none of this runs and the tool result is
 * unchanged.
 */
export const ANNOTATE_APP_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Plannotator</title>
<style>
  :root { color-scheme: light dark; font-family: var(--font-sans, system-ui, -apple-system, sans-serif); }
  body { margin: 0; padding: 12px 14px; font-size: 13px; line-height: 1.45; background: transparent; color: var(--color-text-primary, CanvasText); }
  .row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .title { font-weight: 600; }
  .state { opacity: .75; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #999; flex: none; }
  .dot.open { background: #d9a400; } .dot.decided { background: #2e9d57; } .dot.failed, .dot.cancelled { background: #c9423a; }
  .url { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; word-break: break-all; opacity: .8; margin-top: 6px; }
  button { font: inherit; padding: 4px 12px; border-radius: 6px; border: 1px solid color-mix(in srgb, currentColor 25%, transparent); background: transparent; color: inherit; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  .note { margin-top: 6px; opacity: .7; font-size: 12px; }
</style>
</head>
<body>
  <div class="row">
    <span class="dot" id="dot"></span>
    <span class="title">Plannotator</span>
    <span class="state" id="state">Starting…</span>
    <button id="open" disabled>Open Plannotator</button>
  </div>
  <div class="url" id="url"></div>
  <div class="note" id="note"></div>
<script>
(function () {
  var nextId = 1;
  var pending = {};
  var target = null;           // tool-input arguments.target
  var session = null;          // matched session record
  var toolResultSeen = false;  // host delivered the tool result to the view
  var cancelled = false;
  var posted = false;
  var decidedAt = 0;
  var GRACE_MS = 5000;
  var POLL_MS = 1500;
  var $ = function (id) { return document.getElementById(id); };

  function send(msg) { window.parent.postMessage(msg, "*"); }
  function request(method, params) {
    var id = nextId++;
    send({ jsonrpc: "2.0", id: id, method: method, params: params || {} });
    return new Promise(function (resolve, reject) { pending[id] = { resolve: resolve, reject: reject }; });
  }
  function notify(method, params) { send({ jsonrpc: "2.0", method: method, params: params || {} }); }

  function render(state, text, note) {
    $("dot").className = "dot " + state;
    $("state").textContent = text;
    if (note !== undefined) $("note").textContent = note;
    var url = session && session.url;
    $("url").textContent = url || "";
    $("open").disabled = !url || state !== "open";
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var msg = event.data;
    if (!msg || msg.jsonrpc !== "2.0") return;
    if (msg.id !== undefined && pending[msg.id] && (msg.result !== undefined || msg.error !== undefined)) {
      var p = pending[msg.id]; delete pending[msg.id];
      if (msg.error) p.reject(msg.error); else p.resolve(msg.result);
      return;
    }
    if (msg.method === "ui/notifications/tool-input") {
      target = msg.params && msg.params.arguments && msg.params.arguments.target;
    } else if (msg.method === "ui/notifications/tool-result") {
      toolResultSeen = true;
      var sc = msg.params && msg.params.structuredContent;
      var decision = sc && sc.decision;
      render(msg.params && msg.params.isError ? "failed" : "decided",
        decision === "approved" ? "Approved" : decision === "dismissed" ? "Closed" : decision === "annotated" ? "Feedback sent" : "Finished",
        msg.params && msg.params.isError ? "" : "Delivered to Codex as the tool result.");
    } else if (msg.method === "ui/notifications/tool-cancelled") {
      cancelled = true;
      render("cancelled", "Cancelled", "The call was cancelled, so the session was closed.");
    } else if (msg.id !== undefined && msg.method === "ui/resource-teardown") {
      send({ jsonrpc: "2.0", id: msg.id, result: {} });
    } else if (msg.id !== undefined && msg.method === "ping") {
      send({ jsonrpc: "2.0", id: msg.id, result: {} });
    }
  });

  $("open").addEventListener("click", function () {
    if (session && session.url) request("ui/open-link", { url: session.url }).catch(function () {
      $("note").textContent = "Could not open the link; copy the URL above into your browser.";
    });
  });

  function pick(sessions) {
    if (!sessions || !sessions.length) return null;
    if (target) {
      for (var i = 0; i < sessions.length; i++) if (sessions[i].target === target) return sessions[i];
    }
    return sessions[0];
  }

  function maybePostFallback() {
    if (posted || toolResultSeen || cancelled || !session || session.state !== "decided") return;
    if (!decidedAt) decidedAt = Date.now();
    if (Date.now() - decidedAt < GRACE_MS) return;
    posted = true;
    request("ui/message", {
      role: "user",
      content: [{ type: "text", text: "Plannotator feedback on " + session.target + ":\\n\\n" + (session.resultText || "") }]
    }).then(function () {
      render("decided", "Feedback posted", "Posted to the thread as a message.");
    }).catch(function () {
      posted = false;
      render("decided", "Finished", "The host did not accept the message.");
    });
  }

  function poll() {
    if (toolResultSeen || cancelled || posted) return;
    request("tools/call", { name: "annotate_session_status", arguments: {} }).then(function (result) {
      var sessions = result && result.structuredContent && result.structuredContent.sessions;
      var s = pick(sessions);
      if (s) {
        session = s;
        if (!toolResultSeen && !cancelled && !posted) {
          if (s.state === "open") render("open", "Waiting for your review", s.isRemote ? "Remote session: open the URL on your local machine (forward the port if needed)." : "");
          else if (s.state === "decided") render("decided", "Finished", "");
          else if (s.state === "failed") render("failed", "Failed", s.error || "");
          else if (s.state === "cancelled") render("cancelled", "Cancelled", "");
        }
        maybePostFallback();
      }
    }).catch(function () { /* status is best effort */ })
      .then(function () { setTimeout(poll, POLL_MS); });
  }

  request("ui/initialize", {
    protocolVersion: "2026-01-26",
    appInfo: { name: "plannotator-annotate", version: "1" },
    appCapabilities: { availableDisplayModes: ["inline"] }
  }).then(function () {
    notify("ui/notifications/initialized");
    notify("ui/notifications/size-changed", { width: document.body.scrollWidth, height: document.body.scrollHeight });
    poll();
  }).catch(function () {
    render("failed", "Host did not initialize the view");
  });
})();
</script>
</body>
</html>
`;
