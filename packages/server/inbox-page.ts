/**
 * STUB PAGE, to be replaced by the designed Inbox window (packages/inbox,
 * apps/inbox) once its design spec is approved. It exists only so
 * `plannotator inbox` opens something real in step 1: the list model (a row
 * per thread, in its section, with a project filter) and a read-only thread,
 * kept live by the event stream. It answers nothing; answers go through the
 * API. Opening a thread marks it seen.
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
  .unread { font-weight: 600; }
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
  let serverSession = null;
  const hashParam = (name) => (new RegExp("[#&]" + name + "=([A-Za-z0-9_]+)").exec(location.hash) || [])[1] || null;
  const setHash = (project, thread) => { location.hash = [project ? "project=" + project : "", thread ? "thread=" + thread : ""].filter(Boolean).join("&"); };
  async function loadList() {
    const project = hashParam("project");
    const res = await fetch("/api/inbox/threads" + (project ? "?project=" + project : ""));
    const data = await res.json();
    serverSession = data.serverSession;
    notice.textContent = data.update ? "A newer Plannotator is installed: restart the Inbox to update." : (data.notice || "");
    list.replaceChildren();
    if (!data.projects) return;
    const filter = el("p", null, "meta");
    const all = el("a", "All projects");
    all.href = "#";
    all.addEventListener("click", (e) => { e.preventDefault(); setHash(null, hashParam("thread")); });
    filter.append(all);
    for (const p of data.projects) {
      const a = el("a", p.name + " (" + p.threads + ")");
      a.href = "#project=" + p.id;
      a.title = p.root;
      a.addEventListener("click", (e) => { e.preventDefault(); setHash(p.id, hashParam("thread")); });
      filter.append(" · ", a);
    }
    list.append(filter);
    if (!data.sections.some((s) => s.threads.length)) list.append(el("p", "Nothing yet. Agents send messages here with the plannotator inbox MCP.", "meta"));
    for (const section of data.sections) {
      if (!section.threads.length) continue;
      list.append(el("h2", section.label));
      const ul = el("ul");
      for (const t of section.threads) {
        const li = el("li");
        li.dataset.section = section.id;
        const a = el("a", t.subject || t.thread_id);
        a.href = "#" + (project ? "project=" + project + "&" : "") + "thread=" + t.thread_id;
        if (t.unread) a.className = "unread";
        const facts = [t.project.name];
        if (t.thread_name) facts.push("thread: " + t.thread_name);
        if (t.questions.open) facts.push(t.questions.open + " open");
        if (t.answered_not_sent) facts.push("Answered, not sent");
        facts.push(t.message_count + " messages");
        if (t.resolved_at) facts.push("resolved");
        li.append(a, el("div", facts.join(" · "), "meta"));
        ul.append(li);
      }
      list.append(ul);
    }
  }
  async function loadThread() {
    const id = hashParam("thread");
    threadView.replaceChildren();
    if (!id) return;
    const res = await fetch("/api/inbox/threads/" + id);
    if (!res.ok) return;
    const { thread } = await res.json();
    // Opening a thread is a look: its messages so far leave "New since you looked".
    fetch("/api/inbox/threads/" + id + "/seen", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ serverSession }) }).catch(() => {});
    threadView.append(el("h2", thread.subject || thread.thread_id));
    for (const msg of thread.messages) {
      threadView.append(el("div", (msg.author.kind === "person" ? "You" : (msg.author.name || "Agent")) + " · " + msg.created_at, "meta"));
      threadView.append(el("pre", msg.body));
      for (const q of msg.questions || []) threadView.append(el("div", "Q " + q.key + " · " + q.state + (q.answer ? " · " + JSON.stringify(q.answer.selected) : ""), "meta"));
    }
  }
  const refresh = () => { loadList().catch(() => {}); loadThread().catch(() => {}); };
  addEventListener("hashchange", refresh);
  refresh();
  const events = new EventSource("/api/inbox/events");
  events.addEventListener("record", refresh);
  events.addEventListener("status", refresh);
})();
</script>
</body>
</html>`;
}
