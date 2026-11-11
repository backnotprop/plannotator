/** HTML document for a thread's decisions; this module is the whole template. Self-contained: a CSP allows `data:` images, inline style and one hashed script, no other request. The v1 JSON rides in an inert script with `<` escaped, and all thread text goes through `esc`. */
import { createHash } from "node:crypto";
import { DECISION_EXPORT_OTHER_STATES, DECISION_EXPORT_STATE_TITLES, decisionExportZone, type DecisionExportItem, type DecisionExportState, type DecisionExportV1 } from "./decision-export";

/** Thread text is untrusted. */
export function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** JSON inside a `<script>`: nothing in it can close the element or start a comment. */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

type Other = Exclude<DecisionExportState, "decided">;

const SHORT: Readonly<Record<Other, string>> = {
  open: "open",
  picked_unsent: "draft",
  answered_in_words: "in words",
  skipped: "skipped",
  set_aside: "set aside",
  archived: "archived",
  replaced: "replaced",
};

const STYLE = `
:root{--bg:#ffffff;--fg:#1d1d1f;--fg2:#5f5f66;--fg3:#74747b;--line:#e4e4e8;--hover:#f4f4f6;--accent:#5a46d4;--accent-soft:rgba(90,70,212,.14);
--sans:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Inter,sans-serif;--mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;
--col:680px;--tick:36px;--in:36px;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--fg:#ececef;--fg2:#a3a3ab;--fg3:#87878f;--line:#2a2a2f;--hover:#1d1d21;--accent:#a294ff;--accent-soft:rgba(162,148,255,.18)}}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
@media (prefers-reduced-motion:no-preference){html{scroll-behavior:smooth}}
body{margin:0;background:var(--bg);color:var(--fg);font:400 17px/1.55 var(--sans);-webkit-font-smoothing:antialiased;font-feature-settings:"kern"}
main,footer{max-width:calc(var(--col) + 48px);margin:0 auto;padding:0 24px}
main{padding-top:96px}
p{margin:0}
a{color:inherit;text-decoration:none}
a:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:3px;border-radius:4px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.num,.meta,time,.facts-line,.rail{font-variant-numeric:tabular-nums}
.num{font:500 13px/1 var(--mono);color:var(--fg3);letter-spacing:0}
h1{font-size:34px;line-height:1.12;font-weight:650;letter-spacing:-.022em;margin:0;text-wrap:balance}
.facts-line{margin-top:12px;font:400 13px/1.6 var(--mono);color:var(--fg2)}
.facts-line .sep{margin:0 2px;color:var(--fg3)}
.facts-line .f{white-space:nowrap}
.facts-line a{color:var(--accent);border-bottom:1px solid transparent;transition:border-color .15s ease-out}
.facts-line a:hover{border-bottom-color:currentColor}
.decision{padding:48px 0;border-top:1px solid var(--line);scroll-margin-top:24px}
.decision h2{margin:0 0 20px;font-size:22px;line-height:1.3;font-weight:620;letter-spacing:-.012em;text-wrap:balance}
.decision h2 .num{display:inline-block;width:36px;margin:0;vertical-align:3px;transition:color .15s ease-out}
.decision h2 .q{display:inline}
.decision h2 .num:hover,.decision:target h2 .num{color:var(--accent)}
.choices{list-style:none;margin:0 0 0 calc(var(--in) - var(--tick));padding:0}
.choice{display:grid;grid-template-columns:var(--tick) 1fr;padding:4px 0;color:var(--fg2)}
.choice .m{padding-top:5px;color:var(--accent);line-height:0}
.choice .label{font-weight:400}
.choice.is-chosen{color:var(--fg)}
.choice.is-chosen .label{font-weight:600}
.choice .desc{color:var(--fg2);font-size:15px}
.choice .desc::before{content:"\\00b7";margin:0 6px 0 2px;color:var(--fg3)}
.choice .rec{font-size:13px;color:var(--fg2);margin-left:6px;white-space:nowrap}
.choice .rec::before{content:"";display:inline-block;width:5px;height:5px;border-radius:50%;border:1px solid currentColor;margin-right:6px;vertical-align:2px}
.choice.is-own .label{font-weight:600}
.sign{display:inline-block;width:14px;font-family:var(--mono);color:var(--fg3)}
.figs{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:16px;margin:20px 0 4px var(--in)}
.figs figure{margin:0}
.figs img{display:block;width:100%;height:auto;border:1px solid var(--line);border-radius:6px;background:#fff}
@media (prefers-color-scheme:dark){.figs img{opacity:.88}}
.figs figcaption{margin-top:8px;font-size:13px;color:var(--fg2)}
.noimg{display:block;font-size:13px;color:var(--fg2);font-style:italic}
.verdict{margin:16px 0 0 var(--in);font-size:15px;color:var(--fg2)}
.note{margin:12px 0 0 var(--in);padding:0 0 0 16px;border-left:2px solid var(--line);max-width:64ch}
.note p{font-size:16px;line-height:1.55;color:var(--fg);text-wrap:pretty;white-space:pre-wrap}
.context{margin:28px 0 0 var(--in);font-size:15px;line-height:1.6;color:var(--fg2);max-width:66ch;text-wrap:pretty;white-space:pre-wrap}
.facts{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;margin:16px 0 0 var(--in);font-size:14px;line-height:1.5}
.facts dt{color:var(--fg3)}
.facts dd{margin:0;color:var(--fg2);max-width:60ch}
.facts a{color:var(--accent)}
.meta{margin:24px 0 0 var(--in);font:400 12.5px/1.5 var(--mono);color:var(--fg3)}
.meta>span{white-space:nowrap}
.rest{padding:40px 0 8px;border-top:1px solid var(--line)}
.rest h2{margin:0 0 16px;font-size:15px;font-weight:600;letter-spacing:0;color:var(--fg)}
.rest-list{list-style:none;margin:0;padding:0}
.rest-list li{display:grid;grid-template-columns:40px 1fr;padding:6px 0 10px;scroll-margin-top:24px}
.rest-list .num{padding-top:5px}
.rest-list li:target .num{color:var(--accent)}
.rest-list .q{font-size:16px;color:var(--fg)}
.rest-list .hint{display:block;font-size:14px;color:var(--fg2);margin-top:2px}
.rest-list .hint a{color:var(--accent)}
.rest-list .hint a:hover{text-decoration:underline}
.rest-list .meta{margin:4px 0 0}
footer{padding-top:48px;padding-bottom:64px}
footer p{border-top:1px solid var(--line);padding-top:20px;font:400 12.5px/1.5 var(--mono);color:var(--fg3)}
.toc{margin:40px 0 56px}
.toc table{width:100%;border-collapse:collapse;font-size:14.5px;line-height:1.45}
.toc th{text-align:left;font-weight:500;font-size:12.5px;color:var(--fg2);padding:0 12px 8px 0;border-bottom:1px solid var(--line)}
.toc td{padding:10px 12px 10px 0;border-bottom:1px solid var(--line);vertical-align:top}
.toc tr:last-child td{border-bottom:0}
.toc .c-n{width:40px}
.toc td.c-n .num{display:inline-block;padding-top:3px}
.toc .c-q{width:44%}
.toc .c-q a{font-weight:500;transition:color .15s ease-out}
.toc .c-q a:hover{color:var(--accent)}
.toc .c-a{color:var(--fg2)}
.toc .c-r{white-space:nowrap;color:var(--fg2);padding-right:0;font-size:13px;width:1%}
.toc th.c-r{font-size:12.5px}
.toc .undecided .c-q a{font-weight:400;color:var(--fg2)}
.toc .undecided .c-a{color:var(--fg3);font-size:13px}
.dot{display:inline-block;width:6px;height:6px;border-radius:50%;border:1px solid var(--fg3);margin-right:8px;vertical-align:1px}
.dot.on{background:var(--accent);border-color:var(--accent)}
.rw{display:none}
details{margin:20px 0 0 var(--in)}
summary{display:inline-flex;align-items:center;gap:8px;cursor:pointer;list-style:none;font-size:14px;color:var(--fg2);transition:color .15s ease-out;border-radius:4px}
summary::-webkit-details-marker{display:none}
summary::before{content:"";width:6px;height:6px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(-45deg);transition:transform .2s cubic-bezier(.2,.7,.2,1);margin-right:2px}
details[open] summary::before{transform:rotate(45deg) translate(-1px,-1px)}
summary:hover{color:var(--fg)}
.fold{padding:4px 0 0 16px}
.fold .context,.fold .facts{margin-left:0}
.fold .context{margin-top:12px}
.pcs{margin-top:16px;font-size:14px;line-height:1.5;color:var(--fg2)}
.pcrow{display:flex;flex-wrap:wrap;gap:0 16px;padding:3px 0}
.pcrow .label{color:var(--fg);font-weight:500;flex-basis:100%}
.rail{display:none}
@media (min-width:1180px){
.rail{display:block;position:fixed;top:96px;left:calc(50% - var(--col)/2 - 120px);width:64px;font:500 12.5px/1 var(--mono)}
.rail ol{list-style:none;margin:16px 0 0;padding:0;border-left:1px solid var(--line)}
.rail a{display:block;padding:7px 0 7px 14px;margin-left:-1px;border-left:1.5px solid transparent;color:var(--fg3);transition:color .15s ease-out,border-color .15s ease-out}
.rail .top{padding-left:15px;border:0;font-weight:400}
.rail a:hover{color:var(--fg)}
.rail a[aria-current]{color:var(--fg);border-left-color:var(--accent)}
.rail .undecided a{color:var(--fg3);opacity:.75}
}
@media (max-width:600px){
body{font-size:16px}
main,footer{padding:0 20px}
main{padding-top:48px}
h1{font-size:27px}
.decision{padding:36px 0}
.decision h2{font-size:19px}
:root{--tick:22px;--in:22px}
.verdict{margin-top:12px}
.facts{grid-template-columns:1fr;gap:0}
.facts dd{margin-bottom:8px}
.choice{padding:6px 0}
.choice .desc{display:block}
.choice .desc::before{display:none}
.choice .rec{margin-left:0}
.choice .label + .rec::before{margin-left:6px}
.rw{display:inline}
.toc .c-n,.toc .c-q,.toc .c-r{width:auto}
.toc table,.toc tbody,.toc tr,.toc td{display:block;width:auto}
.toc thead{display:none}
.toc tr{display:grid;grid-template-columns:36px 1fr;padding:10px 0;border-bottom:1px solid var(--line)}
.toc tr:last-child{border-bottom:0}
.toc td{border:0;padding:0}
.toc .c-n{grid-row:span 3}
.toc .c-a{grid-column:2;font-size:14px}
.toc .c-r{grid-column:2;width:auto;margin-top:2px}
.toc .c-r:empty{display:none}
.decision h2 .num{display:block;margin-bottom:8px}
.decision h2 .q{display:block}
}
@media print{
:root{--bg:#fff;--fg:#000;--fg2:#444;--fg3:#666;--line:#ccc;--accent:#000}
body{font-size:11pt}
main{padding-top:0}
main,footer{max-width:none;padding:0}
.rail{display:none}
.decision{padding:20pt 0;break-inside:auto}
.decision h2,.choices,.verdict,.note{break-inside:avoid;break-after:avoid}
.figs{break-inside:avoid}
details::details-content{content-visibility:visible;display:contents}
details summary{display:none}
.toc table{font-size:9.5pt}
a[href^="https:"]::after{content:" (" attr(href) ")";font-size:9pt;color:var(--fg2)}
}
`;

/** Allowed by its hash, so nothing injected could run. */
const SCRIPT = `(()=>{const links=[...document.querySelectorAll('.rail ol a')];
addEventListener('beforeprint',()=>document.querySelectorAll('details').forEach(d=>d.open=true));
if(!links.length||!('IntersectionObserver' in window))return;
const by=new Map(links.map(a=>[a.hash.slice(1),a]));let cur=null;
const io=new IntersectionObserver(es=>{for(const e of es){if(!e.isIntersecting)continue;
const a=by.get(e.target.id);if(a&&a!==cur){cur&&cur.removeAttribute('aria-current');a.setAttribute('aria-current','location');cur=a;}}},
{rootMargin:'-15% 0px -75% 0px'});
by.forEach((a,id)=>{const el=document.getElementById(id);el&&io.observe(el);});})();`;
const SCRIPT_HASH = createHash("sha256").update(SCRIPT).digest("base64");
export const DECISION_EXPORT_HTML_CSP = `default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'sha256-${SCRIPT_HASH}'; base-uri 'none'; form-action 'none'`;

const DATA_URI = /^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/;

const CHECK =
  '<svg class="tick" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function dates(tz: string) {
  const timeZone = decisionExportZone(tz);
  const format = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short" });
  const parts = (iso: string) => {
    const got = Object.fromEntries(format.formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
    return { y: got.year!, m: got.month!, d: got.day!, hm: `${got.hour}:${got.minute}`, zone: got.timeZoneName ?? "" };
  };
  const day = (iso: string) => {
    const p = parts(iso);
    return `${p.m} ${p.d}`;
  };
  const same = (a: ReturnType<typeof parts>, b: ReturnType<typeof parts>) => a.y === b.y && a.m === b.m && a.d === b.d;
  return {
    day,
    stamp: (iso: string) => `${day(iso)} ${parts(iso).hm}`,
    time: (iso: string) => parts(iso).hm,
    sameDay: (a: string, b: string) => same(parts(a), parts(b)),
    range: (a: string | null, b: string | null): string => {
      if (!a || !b) {
        const one = a ?? b;
        return one ? `${day(one)}, ${parts(one).y}` : "";
      }
      const [x, y] = [parts(a), parts(b)];
      if (same(x, y)) return `${x.m} ${x.d}, ${x.y}`;
      if (x.y === y.y && x.m === y.m) return `${x.m} ${x.d} to ${y.d}, ${y.y}`;
      if (x.y === y.y) return `${x.m} ${x.d} to ${y.m} ${y.d}, ${y.y}`;
      return `${x.m} ${x.d}, ${x.y} to ${y.m} ${y.d}, ${y.y}`;
    },
    footer: (iso: string) => {
      const p = parts(iso);
      return `${p.m} ${p.d}, ${p.y}, ${p.hm} ${p.zone}`.trim();
    },
  };
}
type Dates = ReturnType<typeof dates>;

const joinWords = (items: string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);
const clip = (s: string, n = 70) => (s.length <= n ? s : `${s.slice(0, n - 1).replace(/[ ,.]+$/, "")}…`);

function answerText(d: DecisionExportItem): string {
  const a = d.answer;
  if (!a) return "";
  return [...a.selected, ...(a.other ? [a.other] : []), ...(a.text ? [a.text] : [])].join(", ");
}

function recLine(d: DecisionExportItem): [string, string] | null {
  const labels = d.recommendation.labels;
  if (labels.length === 0 && !d.recommendation.text) return null;
  const a = d.answer;
  const sel = a?.selected ?? [];
  if (d.recommendation.taken) return ["Took the recommendation.", "taken"];
  if (d.kind === "multi" && labels.length > 0 && labels.every((l) => sel.includes(l)) && !a?.other) {
    const added = sel.filter((s) => !labels.includes(s));
    return [`Took the recommendation and added ${esc(joinWords(added))}.`, `taken +${added.length}`];
  }
  if (a?.other) return ["Wrote their own answer instead of the recommendation.", "not taken"];
  return ["Chose differently from the recommendation.", "not taken"];
}

function figure(uri: string | undefined, alt: string, caption: string, sized: boolean): string {
  const img = uri && DATA_URI.test(uri) ? `<img src="${uri}" alt="${esc(alt)}"${sized ? ' width="200" height="140"' : ""} loading="lazy">` : `<span class="noimg">${esc(alt)}</span>`;
  return `<figure>${img}<figcaption>${esc(caption)}</figcaption></figure>`;
}

function choicesHtml(doc: DecisionExportV1, d: DecisionExportItem): string {
  const out = ['<ul class="choices">'];
  const figs: string[] = [];
  if (d.shows?.image) figs.push(figure(doc.images[d.shows.image.ref], d.shows.image.alt, d.shows.label, false));
  for (const c of d.choices) {
    const mark = c.chosen ? `${CHECK}<span class="sr">Chosen: </span>` : "";
    let line = `<span class="label">${esc(c.label)}</span>`;
    if (c.description) line += ` <span class="desc">${esc(c.description)}</span>`;
    if (c.recommended) line += ' <span class="rec">recommended</span>';
    if (c.settled) line += ' <span class="rec">already settled by the agent</span>';
    if (c.prototype) line += ` <span class="desc">prototype: ${esc(c.prototype)}</span>`;
    out.push(`<li class="choice${c.chosen ? " is-chosen" : ""}"><span class="m">${mark}</span><div>${line}</div></li>`);
    if (c.image) figs.push(figure(doc.images[c.image.ref], c.image.alt, c.label, true));
  }
  for (const own of [d.answer?.other, d.answer?.text]) {
    if (own) out.push(`<li class="choice is-chosen is-own"><span class="m">${CHECK}<span class="sr">Chosen: </span></span><div><span class="label">${esc(own)}</span> <span class="desc">own answer</span></div></li>`);
  }
  out.push("</ul>");
  if (figs.length) out.push(`<div class="figs">${figs.join("")}</div>`);
  return out.join("");
}

function factsHtml(doc: DecisionExportV1, d: DecisionExportItem, when: Dates): string {
  const rows: [string, string][] = [];
  if (d.stakes) rows.push(["Stakes", esc(d.stakes)]);
  if (d.recommendation.text) rows.push(["Recommendation", esc(d.recommendation.text)]);
  if (d.why) rows.push(["Why", esc(d.why)]);
  if (d.reversible) rows.push(["Can't be undone", esc(d.reversible.why ?? "yes")]);
  if (d.holds_up?.length) rows.push(["Held up", esc(d.holds_up.join(", "))]);
  if (d.shows && !d.shows.image) rows.push(["Shows", esc(d.shows.label)]);
  if (d.prototype) rows.push(["Prototype", esc(d.prototype)]);
  for (const old of d.replaces ?? []) {
    const kept = doc.others.find((x) => x.id === old.id);
    const ref = kept ? `<a href="#d${kept.n}">D${kept.n}</a>, ` : "";
    rows.push(["Replaces", `${ref}“${esc(old.prompt)}”${old.asked_at ? `, asked ${esc(when.day(old.asked_at))}` : ""}`]);
  }
  if (!rows.length) return "";
  return `<dl class="facts">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("")}</dl>`;
}

function metaHtml(d: DecisionExportItem, when: Dates): string {
  const parts = [`<span>${esc(d.asked.by)}</span>`, `<span>asked <time datetime="${esc(d.asked.at)}">${esc(when.stamp(d.asked.at))}</time></span>`];
  const at = d.answered?.sent_at ?? d.answered?.at ?? null;
  if (at) parts.push(`<span>answered <time datetime="${esc(at)}">${esc(when.sameDay(at, d.asked.at) ? when.time(at) : when.stamp(at))}</time></span>`);
  return `<p class="meta">${parts.join(' <span aria-hidden="true">·</span> ')}</p>`;
}

function decisionHtml(doc: DecisionExportV1, d: DecisionExportItem, when: Dates): string {
  const rec = recLine(d);
  const note = d.answer?.note;
  let after = rec ? `<p class="verdict">${rec[0]}</p>` : "";
  if (note) after += `<blockquote class="note"><p>${esc(note)}</p></blockquote>`;
  const ctx = d.context ? `<p class="context">${esc(d.context)}</p>` : "";
  const facts = factsHtml(doc, d, when);
  const withPc = d.choices.filter((c) => c.pros?.length || c.cons?.length);
  let folded = ctx + facts;
  if (withPc.length) {
    folded += `<div class="pcs">${withPc
      .map(
        (c) =>
          `<p class="pcrow"><span class="label">${esc(c.label)}</span>` +
          (c.pros ?? []).map((p) => `<span class="pro"><span class="sign" aria-label="Pro">+</span>${esc(p)}</span>`).join("") +
          (c.cons ?? []).map((p) => `<span class="con"><span class="sign" aria-label="Con">−</span>${esc(p)}</span>`).join("") +
          "</p>",
      )
      .join("")}</div>`;
  }
  const label = facts || withPc.length ? "Context and trade-offs" : "Context";
  const det = folded ? `<details><summary>${label}</summary><div class="fold">${folded}</div></details>` : "";
  return (
    `<section class="decision" id="d${d.n}" aria-labelledby="d${d.n}-h">` +
    `<h2 id="d${d.n}-h"><a class="num" href="#d${d.n}" aria-label="Link to D${d.n}">D${d.n}</a><span class="q">${esc(d.prompt)}</span></h2>` +
    choicesHtml(doc, d) +
    after +
    det +
    metaHtml(d, when) +
    `</section>`
  );
}

function groupsOf(doc: DecisionExportV1): { state: Other; items: DecisionExportItem[] }[] {
  return DECISION_EXPORT_OTHER_STATES.map((state) => ({ state, items: doc.others.filter((d) => d.state === state) })).filter((g) => g.items.length > 0);
}

function replacement(doc: DecisionExportV1, d: DecisionExportItem): DecisionExportItem | null {
  const id = d.replaced_by?.id;
  if (!id) return null;
  return [...doc.decisions, ...doc.others].find((x) => x.id === id) ?? null;
}

function shortState(doc: DecisionExportV1, d: DecisionExportItem): string {
  if (d.state === "picked_unsent") return "draft, not sent to the agent";
  if (d.state === "replaced") {
    const r = replacement(doc, d);
    return r ? `replaced by D${r.n}` : SHORT.replaced;
  }
  return SHORT[d.state as Other];
}

function restHint(doc: DecisionExportV1, d: DecisionExportItem): string {
  const a = d.answer;
  const recs = d.recommendation.labels.length ? d.recommendation.labels : d.recommendation.text ? [d.recommendation.text] : [];
  if (a && !a.sent && !a.skipped) {
    const picked = [...a.selected, ...(a.other ? [a.other] : []), ...(a.text ? [a.text] : [])];
    const note = a.note ? ` <q>${esc(a.note)}</q>` : "";
    if (picked.length || note) return `Draft: ${esc(joinWords(picked))}${note}`;
  }
  if (d.state === "skipped" && a?.note) return `<q>${esc(a.note)}</q>`;
  if (d.state === "replaced") {
    const r = replacement(doc, d);
    if (r) return `Replaced by <a href="#d${r.n}">D${r.n}</a>, ${esc(r.prompt)}`;
    return d.replaced_by?.prompt ? `Replaced by “${esc(d.replaced_by.prompt)}”` : "Withdrawn";
  }
  return recs.length ? `Recommended: ${esc(joinWords(recs))}` : "";
}

function restHtml(doc: DecisionExportV1, when: Dates): string {
  return groupsOf(doc)
    .map(({ state, items }) => {
      const sid = `s-${state.replace(/_/g, "-")}`;
      const lis = items
        .map((d) => {
          const hint = restHint(doc, d);
          return (
            `<li id="d${d.n}"><a class="num" href="#d${d.n}">D${d.n}</a><div><p class="q">${esc(d.prompt)}</p>` +
            (hint ? `<span class="hint">${hint}</span>` : "") +
            `<p class="meta">${esc(d.asked.by)} · asked <time datetime="${esc(d.asked.at)}">${esc(when.stamp(d.asked.at))}</time></p></div></li>`
          );
        })
        .join("");
      return `<section class="rest" id="${sid}" aria-labelledby="${sid}-h"><h2 id="${sid}-h">${esc(DECISION_EXPORT_STATE_TITLES[state])}</h2><ol class="rest-list">${lis}</ol></section>`;
    })
    .join("");
}

function overviewHtml(doc: DecisionExportV1): string {
  const rows = doc.decisions.map((d) => {
    const rec = recLine(d);
    const word = rec ? `<span class="dot${rec[1].startsWith("taken") ? " on" : ""}" aria-hidden="true"></span><span class="rw">Recommendation </span>${rec[1]}` : "";
    return `<tr><td class="c-n"><a class="num" href="#d${d.n}">D${d.n}</a></td><td class="c-q"><a href="#d${d.n}">${esc(d.prompt)}</a></td><td class="c-a">${esc(clip(answerText(d)))}</td><td class="c-r">${word}</td></tr>`;
  });
  for (const { items } of groupsOf(doc)) {
    for (const d of items) {
      rows.push(`<tr class="undecided"><td class="c-n"><a class="num" href="#d${d.n}">D${d.n}</a></td><td class="c-q"><a href="#d${d.n}">${esc(d.prompt)}</a></td><td class="c-a">${esc(shortState(doc, d))}</td><td class="c-r"></td></tr>`);
    }
  }
  return `<nav class="toc" aria-label="Decisions"><table><thead><tr><th class="c-n" scope="col"><span class="sr">Number</span></th><th scope="col">Question</th><th scope="col">Answer</th><th class="c-r" scope="col">Recommendation</th></tr></thead><tbody>${rows.join("")}</tbody></table></nav>`;
}

function railHtml(doc: DecisionExportV1): string {
  const lis = doc.decisions.map((d) => `<li><a href="#d${d.n}">D${d.n}</a></li>`);
  for (const { items } of groupsOf(doc)) for (const d of items) lis.push(`<li class="undecided"><a href="#d${d.n}">D${d.n}</a></li>`);
  return `<nav class="rail" aria-label="Jump to decision"><a class="top" href="#top">Top</a><ol>${lis.join("")}</ol></nav>`;
}

function tally(doc: DecisionExportV1): string {
  return [`${doc.decisions.length} decided`, ...groupsOf(doc).map(({ state, items }) => `${items.length} ${SHORT[state]}`)].join(", ");
}

export function renderDecisionExportHtml(doc: DecisionExportV1): string {
  const when = dates(doc.tz);
  const t = doc.thread;
  const facts: string[] = [];
  if (t.project) facts.push(`<span class="f">${esc(t.project)}</span>`);
  const range = when.range(t.started_at, t.last_at);
  if (range) facts.push(`<span class="f">${esc(range)}</span>`);
  for (const p of doc.pulls) {
    if (/^https:\/\/[^\s"'<>]+$/.test(p.url)) facts.push(`<a class="f" href="${esc(p.url)}" title="${esc(p.title ?? "")}">${esc(p.ref)}</a>`);
    else facts.push(`<span class="f">${esc(p.ref)}</span>`);
  }
  facts.push(`<span class="f">${esc(tally(doc))}</span>`);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${DECISION_EXPORT_HTML_CSP}">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light dark">
<meta name="generator" content="${esc(doc.generator)}">
<title>${esc(t.subject)} · Decisions</title>
<style>${STYLE}</style>
</head>
<body>
${railHtml(doc)}
<main id="top">
<article>
<header class="doc-head">
<h1>${esc(t.subject)}</h1>
<p class="facts-line">${facts.join(' <span class="sep" aria-hidden="true">·</span> ')}</p>
</header>
${overviewHtml(doc)}
${doc.decisions.map((d) => decisionHtml(doc, d, when)).join("")}
${restHtml(doc, when)}
</article>
</main>
<footer><p>Exported from Plannotator on <time datetime="${esc(doc.exported_at)}">${esc(when.footer(doc.exported_at))}</time>.</p></footer>
<script type="application/json" id="plannotator-decisions">${jsonForScript({ ...doc, images: {} })}</script>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

export { dates as decisionExportDesignDates };
