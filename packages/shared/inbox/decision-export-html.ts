/**
 * The HTML document of a thread's decisions: v1 JSON in, one self-contained file out. This module is the whole
 * template (markup here, styling in `STYLE`), so a new design replaces this file and nothing else.
 *
 * Rules any design keeps (decision-export-html.test.ts guards them):
 * - Self-contained: a CSP meta allows `data:` images, inline style and the one hashed script; no other request.
 * - Light and dark through `prefers-color-scheme`, plus the "Light / dark" toggle (hidden in print).
 * - The v1 JSON rides in an inert `<script type="application/json" id="plannotator-decisions">`, `<` escaped. Its
 *   `images` is left empty: the pictures are in the page once (`<img src="data:…">`), so the file stays under its cap.
 * - Every piece of thread text goes through `esc`.
 */
import { createHash } from "node:crypto";
import { decisionAnswerLine, decisionExportDates, type DecisionExportChoice, type DecisionExportItem, type DecisionExportV1 } from "./decision-export";

/** HTML text and attribute escaping: thread text is untrusted. */
export function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** JSON inside a `<script>`: nothing in it can close the element or start a comment. */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

const STYLE = `
:root{color-scheme:light dark;--bg:oklch(0.97 0.005 260);--card:oklch(1 0 0);--fg:oklch(0.18 0.02 260);--mfg:oklch(0.40 0.02 260);--border:oklch(0.88 0.01 260);--primary:oklch(0.50 0.25 280);--pfg:oklch(1 0 0);--accent:oklch(0.60 0.22 50);--ok:oklch(0.55 0.14 155);--hair:color-mix(in srgb,var(--border) 70%,transparent);--chosen:color-mix(in srgb,var(--primary) 9%,var(--card));--rec:color-mix(in srgb,var(--accent) 14%,var(--card));--shadow:0 1px 0 color-mix(in srgb,var(--border) 60%,transparent),0 8px 24px -14px oklch(0.2 0.03 260/.25)}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:oklch(0.15 0.02 260);--card:oklch(0.20 0.02 260);--fg:oklch(0.90 0.01 260);--mfg:oklch(0.72 0.02 260);--border:oklch(0.33 0.02 260);--primary:oklch(0.75 0.18 280);--pfg:oklch(0.15 0.02 260);--accent:oklch(0.72 0.18 60);--ok:oklch(0.75 0.14 155);--shadow:0 0 0 1px color-mix(in srgb,var(--fg) 6%,transparent)}}
:root[data-theme=dark]{--bg:oklch(0.15 0.02 260);--card:oklch(0.20 0.02 260);--fg:oklch(0.90 0.01 260);--mfg:oklch(0.72 0.02 260);--border:oklch(0.33 0.02 260);--primary:oklch(0.75 0.18 280);--pfg:oklch(0.15 0.02 260);--accent:oklch(0.72 0.18 60);--ok:oklch(0.75 0.14 155);--shadow:0 0 0 1px color-mix(in srgb,var(--fg) 6%,transparent)}
*{box-sizing:border-box}
html{background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
body{margin:0}
main{max-width:860px;margin:0 auto;padding:44px 28px 64px}
.eyebrow{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--mfg)}
.logo{width:18px;height:18px;border-radius:5px;background:var(--primary);display:inline-grid;place-items:center;color:var(--pfg);font-size:11px;font-weight:800}
h1{font-size:28px;line-height:1.2;margin:10px 0;font-weight:700}
.meta{display:flex;flex-wrap:wrap;gap:6px 14px;color:var(--mfg);font-size:13.5px;align-items:center}
.meta b{color:var(--fg)}
.pr{padding:2px 9px;border-radius:999px;border:1px solid var(--border);color:var(--fg);text-decoration:none;font-size:12.5px}
.counts{display:flex;gap:10px;margin:22px 0 8px;flex-wrap:wrap}
.count{flex:1 1 140px;background:var(--card);border-radius:10px;box-shadow:var(--shadow);padding:12px 14px}
.count .n{font-size:24px;font-weight:700}
.count .l{font-size:12.5px;color:var(--mfg)}
.toc{margin:22px 0 30px;background:var(--card);border-radius:12px;box-shadow:var(--shadow);overflow:hidden}
.toc table{width:100%;border-collapse:collapse;font-size:13.5px}
.toc th{text-align:left;font-weight:600;font-size:12px;color:var(--mfg);padding:9px 14px;border-bottom:1px solid var(--hair)}
.toc td{padding:9px 14px;border-bottom:1px solid var(--hair);vertical-align:top}
.toc tr:last-child td{border-bottom:0}
.toc a{color:inherit;text-decoration:none}
.num{font-weight:700;color:var(--primary);white-space:nowrap}
.pill{display:inline-block;font-size:11.5px;font-weight:600;padding:1px 8px;border-radius:999px;white-space:nowrap}
.pill.took{background:color-mix(in srgb,var(--ok) 16%,transparent);color:var(--ok)}
.pill.diff{background:color-mix(in srgb,var(--accent) 18%,transparent);color:color-mix(in srgb,var(--accent) 80%,var(--fg))}
.decision{background:var(--card);border-radius:14px;box-shadow:var(--shadow);padding:22px 24px 18px;margin:0 0 18px;break-inside:avoid}
.dhead{display:flex;gap:12px;align-items:baseline}
.dhead h2{font-size:19px;line-height:1.3;margin:0;font-weight:650}
.dnum{flex:none;font-size:12px;font-weight:700;color:var(--primary);background:color-mix(in srgb,var(--primary) 12%,transparent);border-radius:6px;padding:2px 7px}
.answer{margin:14px 0 4px;padding:12px 14px;border-radius:10px;background:var(--chosen);border:1px solid color-mix(in srgb,var(--primary) 30%,transparent)}
.answer .top{display:flex;justify-content:space-between;gap:8px;align-items:center}
.answer .k{font-size:11.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--primary)}
.answer .v{font-size:15.5px;font-weight:600;margin-top:2px;white-space:pre-wrap}
.answer .o{font-weight:500;color:var(--mfg)}
.answer ul{margin:4px 0 0;padding-left:20px;font-weight:600}
.note{margin:10px 0 0;padding:2px 0 2px 12px;border-left:3px solid var(--border);font-size:14px;white-space:pre-wrap}
.note b{color:var(--mfg)}
.facts{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:13.5px;margin:14px 0 0}
.facts dt{color:var(--mfg);font-weight:600}
.facts dd{margin:0}
.ctx{font-size:14px;margin:12px 0 0;white-space:pre-wrap}
.choices{list-style:none;padding:0;margin:16px 0 0;display:grid;gap:8px}
.choice{display:grid;grid-template-columns:20px 1fr;gap:10px;padding:10px 12px;border-radius:10px;border:1px solid var(--hair)}
.choice.chosen{border-color:color-mix(in srgb,var(--primary) 45%,transparent);background:var(--chosen)}
.box{width:18px;height:18px;border-radius:5px;border:1.5px solid color-mix(in srgb,var(--mfg) 60%,transparent);margin-top:2px;display:grid;place-items:center}
.single .box{border-radius:50%}
.chosen .box{background:var(--primary);border-color:var(--primary)}
.chosen .box::after{content:"";width:8px;height:5px;border:2px solid var(--pfg);border-top:0;border-right:0;transform:rotate(-45deg) translate(1px,-1px)}
.clabel{font-weight:600}
.cdesc{color:var(--mfg)}
.tag{margin-left:6px;font-size:11px;font-weight:700;padding:1px 7px;border-radius:999px;background:var(--rec);color:color-mix(in srgb,var(--accent) 75%,var(--fg))}
.pc{display:flex;gap:18px;flex-wrap:wrap;font-size:13px;margin-top:4px;color:var(--mfg)}
.pc b{font-weight:600;color:var(--fg)}
.pic{margin-top:8px;display:block;width:200px;max-width:100%;border-radius:8px;border:1px solid var(--hair)}
.alt{display:block;margin-top:4px;font-size:13px;color:var(--mfg);font-style:italic}
.foot{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:12.5px;color:var(--mfg);margin-top:14px;padding-top:12px;border-top:1px solid var(--hair)}
.replaced{font-size:12.5px;color:var(--mfg);margin-top:8px}
section.rest{margin-top:30px}
section.rest h3{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--mfg);margin:0 0 10px}
.restlist{background:var(--card);border-radius:12px;box-shadow:var(--shadow);margin:0 0 20px;padding:4px 16px;list-style:none}
.restlist li{padding:10px 0;border-bottom:1px solid var(--hair);font-size:14px}
.restlist li:last-child{border-bottom:0}
.restlist small{color:var(--mfg)}
footer{margin-top:36px;font-size:12px;color:var(--mfg);text-align:center}
.theme{position:fixed;top:14px;right:14px;border:1px solid var(--border);background:var(--card);color:var(--mfg);border-radius:8px;font:inherit;font-size:12px;padding:4px 9px;cursor:pointer}
@media print{html{background:#fff;color:#000}.theme{display:none}.decision,.count,.toc,.restlist{box-shadow:none;border:1px solid #ddd}main{padding:0}a{color:inherit}}
`;

/** The toggle, the file's one script: allowed by its hash, so nothing injected could run. `#theme=dark` picks a look. */
const SCRIPT = `(function(){var r=document.documentElement,m=/theme=(light|dark)/.exec(location.hash);if(m)r.dataset.theme=m[1];var b=document.getElementById("theme");if(b)b.addEventListener("click",function(){var d=r.dataset.theme==="dark"||(!r.dataset.theme&&matchMedia("(prefers-color-scheme: dark)").matches);r.dataset.theme=d?"light":"dark"})})();`;
const SCRIPT_HASH = createHash("sha256").update(SCRIPT).digest("base64");
export const DECISION_EXPORT_HTML_CSP = `default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'sha256-${SCRIPT_HASH}'; base-uri 'none'; form-action 'none'`;

function picture(doc: DecisionExportV1, image: { alt: string; ref: string } | undefined): string {
  if (!image) return "";
  const src = doc.images[image.ref];
  // Only an embedded picture, never an address.
  if (src && /^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/i.test(src)) return `<img class="pic" alt="${esc(image.alt)}" src="${src}">`;
  return `<span class="alt">(picture: ${esc(image.alt)})</span>`;
}

function choiceHtml(doc: DecisionExportV1, choice: DecisionExportChoice): string {
  const pc = [choice.pros?.length ? `<span><b>Pros</b> ${esc(choice.pros.join("; "))}</span>` : "", choice.cons?.length ? `<span><b>Cons</b> ${esc(choice.cons.join("; "))}</span>` : ""].join("");
  return (
    `<li class="choice${choice.chosen ? " chosen" : ""}"><span class="box" aria-hidden="true"></span><div>` +
    `<span class="clabel">${esc(choice.label)}</span>` +
    (choice.description ? ` <span class="cdesc">— ${esc(choice.description)}</span>` : "") +
    (choice.recommended ? `<span class="tag">Recommended</span>` : "") +
    (choice.settled ? `<span class="tag">already settled by the agent</span>` : "") +
    (pc ? `<div class="pc">${pc}</div>` : "") +
    (choice.prototype ? `<div class="pc"><span><b>Prototype</b> ${esc(choice.prototype)}</span></div>` : "") +
    picture(doc, choice.image) +
    `</div></li>`
  );
}

function card(doc: DecisionExportV1, item: DecisionExportItem, when: ReturnType<typeof decisionExportDates>): string {
  const a = item.answer!;
  const pill = item.recommendation.taken === true ? `<span class="pill took">Took the recommendation</span>` : item.recommendation.taken === false ? `<span class="pill diff">Chose differently</span>` : "";
  let value = "";
  if (a.selected.length > 1) value = `<ul>${a.selected.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>`;
  else if (a.selected.length === 1) value = `<div class="v">${esc(a.selected[0]!)}</div>`;
  if (a.other) value += `<div class="v"><span class="o">Other:</span> ${esc(a.other)}</div>`;
  if (a.text) value += `<div class="v">${esc(a.text)}</div>`;
  const note = a.note ? `<div class="note"><b>Note</b> ${esc(a.note)}</div>` : "";
  const facts: [string, string][] = [];
  if (item.stakes) facts.push(["Stakes", item.stakes]);
  if (item.recommendation.text) facts.push(["Recommendation", item.recommendation.text]);
  if (item.why) facts.push(["Why", item.why]);
  if (item.reversible) facts.push(["Can't be undone", item.reversible.why ?? ""]);
  if (item.holds_up?.length) facts.push(["Held up", item.holds_up.join(", ")]);
  if (item.prototype) facts.push(["Prototype", item.prototype]);
  if (item.shows && !item.shows.image) facts.push(["Shows", item.shows.label]);
  const sent = item.answered?.sent_at ?? item.answered?.at ?? null;
  return (
    `<article class="decision ${item.kind === "multi" ? "multi" : "single"}" id="d${item.n}">` +
    `<div class="dhead"><span class="dnum">D${item.n}</span><h2>${esc(item.prompt)}</h2></div>` +
    `<div class="answer"><div class="top"><span class="k">Answer</span>${pill}</div>${value}${note}</div>` +
    (item.context ? `<p class="ctx">${esc(item.context)}</p>` : "") +
    (facts.length ? `<dl class="facts">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>` : "") +
    (item.shows?.image ? picture(doc, item.shows.image) : "") +
    (item.choices.length ? `<ul class="choices">${item.choices.map((c) => choiceHtml(doc, c)).join("")}</ul>` : "") +
    (item.replaces ?? []).map((r) => `<div class="replaced">Replaces an earlier question, “${esc(r.prompt)}”${r.asked_at ? `, asked ${esc(when.day(r.asked_at))}` : ""}.</div>`).join("") +
    `<div class="foot"><span>Asked by ${esc(item.asked.by)}, ${esc(when.at(item.asked.at))}</span>${sent ? `<span>Answered ${esc(when.at(sent))}</span>` : ""}<span>${item.kind === "multi" ? "Pick any" : item.kind === "text" ? "Written answer" : "Pick one"}</span></div>` +
    `</article>`
  );
}

/** The whole file. */
export function renderDecisionExportHtml(doc: DecisionExportV1): string {
  const when = decisionExportDates(doc.tz);
  const offered = doc.decisions.filter((d) => d.recommendation.taken !== null);
  const took = offered.filter((d) => d.recommendation.taken === true).length;
  const counts = [
    [String(doc.counts.decided), "decided"],
    ...(offered.length > 0 ? [[`${took} of ${offered.length}`, "took the recommendation"]] : []),
    [String(doc.counts.skipped), "skipped"],
    [String(doc.counts.open), "still open"],
  ];
  const toc = doc.decisions.length
    ? `<div class="toc"><table><thead><tr><th></th><th>Question</th><th>Answer</th><th>Recommendation</th></tr></thead><tbody>${doc.decisions
        .map((d) => {
          const pill = d.recommendation.taken === true ? `<span class="pill took">Taken</span>` : d.recommendation.taken === false ? `<span class="pill diff">Not taken</span>` : "";
          return `<tr><td class="num"><a href="#d${d.n}">D${d.n}</a></td><td><a href="#d${d.n}">${esc(d.prompt)}</a></td><td>${esc(decisionAnswerLine(d))}</td><td>${pill}</td></tr>`;
        })
        .join("")}</tbody></table></div>`
    : "";
  const rest = (title: string, items: DecisionExportItem[], line: (item: DecisionExportItem) => string) =>
    items.length ? `<h3>${esc(title)}</h3><ul class="restlist">${items.map((item) => `<li>${esc(item.prompt)}<br><small>${line(item)}</small></li>`).join("")}</ul>` : "";
  const skipped = rest("Skipped", doc.not_answered, (item) => `Skipped · asked by ${esc(item.asked.by)}, ${esc(when.day(item.asked.at))}`);
  const open = rest("Still open", doc.still_open, (item) => {
    const rec = item.recommendation.labels.length ? item.recommendation.labels.join(", ") : item.recommendation.text;
    return `${rec ? `Recommended: ${esc(rec)} · ` : ""}asked by ${esc(item.asked.by)}, ${esc(when.day(item.asked.at))}`;
  });
  const pulls = doc.pulls.map((p) => (/^https:\/\/[^\s"'<>]+$/.test(p.url) ? `<a class="pr" href="${esc(p.url)}">${esc(p.ref)}</a>` : `<span class="pr">${esc(p.ref)}</span>`)).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${DECISION_EXPORT_HTML_CSP}">
<meta name="referrer" content="no-referrer">
<title>Decisions: ${esc(doc.thread.subject)}</title>
<style>${STYLE}</style></head>
<body><button class="theme" id="theme" type="button">Light / dark</button>
<main>
<div class="eyebrow"><span class="logo">P</span>Decisions · Plannotator Inbox</div>
<h1>${esc(doc.thread.subject)}</h1>
<div class="meta">${doc.thread.project ? `<b>${esc(doc.thread.project)}</b>` : ""}<span>${esc(when.range(doc.thread.started_at, doc.thread.last_at))}</span>${pulls}</div>
<div class="counts">${counts.map(([n, l]) => `<div class="count"><div class="n">${esc(n!)}</div><div class="l">${esc(l!)}</div></div>`).join("")}</div>
${toc}
${doc.decisions.map((d) => card(doc, d, when)).join("\n")}
${skipped || open ? `<section class="rest">${skipped}${open}</section>` : ""}
<footer>Exported from Plannotator on ${esc(when.at(doc.exported_at))}.</footer>
</main>
<script type="application/json" id="plannotator-decisions">${jsonForScript({ ...doc, images: {} })}</script>
<script>${SCRIPT}</script>
</body></html>
`;
}
