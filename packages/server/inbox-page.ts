/**
 * STUB PAGE, to be replaced by the designed Inbox window (packages/inbox,
 * apps/inbox) once its design spec is approved. It exists only so
 * `plannotator inbox` opens something real in step 1: the list model (rows by
 * project, threads with their question counts) and a read-only thread, kept
 * live by the event stream. It answers nothing; answers go through the API.
 *
 * Every piece of agent text is placed with textContent, never as HTML, and the
 * page runs under a nonce CSP with no other script source.
 */

export function inboxStubPageHtml(nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Plannotator Inbox</title>
<style nonce="${nonce}">
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { margin: 0; padding: 1.5rem; max-width: 960px; }
  .stub { font-size: .8rem; padding: .4rem .6rem; border: 1px dashed currentColor; opacity: .7; margin-bottom: 1rem; }
  h2 { font-size: 1rem; margin: 1.25rem 0 .4rem; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { padding: .35rem 0; border-bottom: 1px solid #8884; }
  a { color: inherit; }
  .meta { font-size: .8rem; opacity: .7; }
  pre { white-space: pre-wrap; font: inherit; background: #8881; padding: .6rem; border-radius: 4px; }
</style>
</head>
<body>
<div class="stub" data-inbox-stub>Stub page: the designed Inbox window replaces it. Read-only.</div>
<h1>Plannotator Inbox</h1>
<div id="notice" class="meta"></div>
<div id="list"></div>
<div id="thread"></div>
<script nonce="${nonce}">
(() => {
  const list = document.getElementById("list");
  const threadView = document.getElementById("thread");
  const notice = document.getElementById("notice");
  const el = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
  async function loadList() {
    const res = await fetch("/api/inbox/projects");
    const data = await res.json();
    notice.textContent = data.update ? "A newer Plannotator is installed: restart the Inbox to update." : (data.notice || "");
    list.replaceChildren();
    if (!data.projects.length) list.append(el("p", "Nothing yet. Agents send messages here with the plannotator inbox MCP.", "meta"));
    for (const entry of data.projects) {
      list.append(el("h2", entry.project.name + " — " + entry.project.root));
      const ul = el("ul");
      for (const t of entry.threads) {
        const li = el("li");
        const a = el("a", t.subject || t.thread_id);
        a.href = "#thread=" + t.thread_id;
        li.append(a, el("div", (t.waiting_on_person ? "Waiting on you · " : "") + t.questions.open + " open, " + t.questions.picked + " picked · " + t.message_count + " messages" + (t.resolved_at ? " · resolved" : ""), "meta"));
        ul.append(li);
      }
      list.append(ul);
    }
  }
  async function loadThread() {
    const m = /thread=([A-Za-z0-9_]+)/.exec(location.hash);
    threadView.replaceChildren();
    if (!m) return;
    const res = await fetch("/api/inbox/threads/" + m[1]);
    if (!res.ok) return;
    const { thread } = await res.json();
    threadView.append(el("h2", thread.subject || thread.thread_id));
    for (const msg of thread.messages) {
      threadView.append(el("div", (msg.author.kind === "person" ? "You" : (msg.author.name || "Agent")) + " · " + msg.created_at, "meta"));
      threadView.append(el("pre", msg.body));
      for (const q of msg.questions || []) threadView.append(el("div", "Q " + q.key + " · " + q.state + (q.answer ? " · " + JSON.stringify(q.answer.selected) : ""), "meta"));
    }
  }
  const refresh = () => { loadList().catch(() => {}); loadThread().catch(() => {}); };
  addEventListener("hashchange", () => loadThread().catch(() => {}));
  refresh();
  const events = new EventSource("/api/inbox/events");
  events.addEventListener("record", refresh);
  events.addEventListener("status", refresh);
})();
</script>
</body>
</html>`;
}
