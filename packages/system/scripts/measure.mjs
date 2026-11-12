import { chromium } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const FRAME = 1000 / 60;
const FILM = 16;
const W = 1600, H = 900;

const cue = (id) => async (p, A) => p.locator(A.cue(id)).first().click();
const key = (k) => async (p) => p.keyboard.press(k);
const sw = async (p, A) => p.locator(A.sw).first().click();

export const PAGE = {
  name: 'a4',
  url: (base, mode, sheet) => `${base}?shot=view&mode=${mode}${sheet ? '&sheet=' + sheet : ''}`,
  stage: '.sys-stage',
  world: '.sys-stage .sys-world',
  nest: 'sys-mini',
  flip: 'sys-flip',
  frame: ':scope > .sys-pframe rect',
  parts: '.sys-world [data-part]:not(.sys-mini)',
  zones: '.sys-world rect.sys-zone[data-zone]',
  words: '.sys-world .sys-fig-term, .sys-world .sys-fig-step, .sys-world .sys-fig-dia, .sys-world .sys-fig-pl, .sys-world .sys-elabel, .sys-world .sys-zlabel',
  names: '.sys-world .sys-name, .sys-world [class*="name"]',
  minis: '.sys-world .sys-mini',
  cue: (id) => `.sys-cur [data-part="${id}"] .sys-win-cue.sys-go`,
  sw: '.sys-seg-o:not([data-on])',
  state: () => {
    const r = document.querySelector('.sys-view');
    const shown = document.querySelector('.sys-crumbs .sys-code')?.textContent;
    return { code: r?.dataset.sheet, depth: document.querySelectorAll('.sys-crumbs .sys-crumb-w').length - (shown && shown !== r?.dataset.sheet ? 1 : 0) };
  },
  windowName: (win) => document.querySelector(`.sys-cur [data-part="${win}"]`)?.getAttribute('aria-label')?.split(',')[0] ?? null,
  focus: async (p, A) => { const r = await p.locator(A.stage).boundingBox(); await p.mouse.click(r.x + 6, r.y + 6); },
};

export const MOVES = {
  'dive-inbox': { act: cue('inbox'), ms: 1700, win: 'inbox', title: 'Dive: the landing into the Inbox (L-201)' },
  'dive-cli': { act: cue('cli'), ms: 1700, win: 'cli', title: 'Dive: the landing into the CLI (L-101)' },
  'out-inbox': { sheet: 'L-201', act: key('Escape'), ms: 1700, title: 'Zoom out: Escape from L-201 to the landing' },
  'kind-L201': { sheet: 'L-201', act: key('2'), ms: 1400, title: 'Kind: L-201 to the second sheet of its scope (key 2)' },
  'simple-C001': { act: sw, ms: 1400, title: 'Full to Simple on the landing' },
  'full-C001': { pre: sw, act: sw, ms: 1400, title: 'Simple to Full on the landing' },
  'wheel-in-inbox': { wheel: { part: 'inbox', dy: -100, n: 40 }, ms: 2600, title: 'Wheel: in over the Inbox, through its door into L-201' },
  'wheel-out-L201': { sheet: 'L-201', wheel: { part: null, dy: 100, n: 40 }, ms: 2600, title: 'Wheel: out of L-201, through the door to the landing' },
  'key-plus': { act: key('+'), ms: 900, title: 'Key +: zoom in one step on the landing' },
  'key-minus': { act: key('-'), ms: 900, title: 'Key -: zoom out one step on the landing' },
  'key-fit': { pre: async (p) => { await p.keyboard.press('+'); await p.keyboard.press('+'); }, act: key('f'), ms: 1100, title: 'Key F: fit after two + steps' },
  'turn-esc': { act: cue('inbox'), turn: { at: 250, k: 'Escape' }, ms: 1700, win: 'inbox', title: 'A dive turned round: Escape 250 ms into the dive into the Inbox' },
  'reduced-dive': { act: cue('inbox'), reduce: true, ms: 700, win: 'inbox', title: 'Reduced motion: the dive into the Inbox is a cut, the drawing fades up' },
  'reduced-simple': { act: sw, reduce: true, ms: 700, title: 'Reduced motion: Full to Simple is a cut, the drawing fades up' },
  'turn-wheel': { act: cue('inbox'), turn: { at: 250, dy: 100, n: 3 }, ms: 1700, win: 'inbox', title: 'A dive turned round: the wheel out 250 ms into the dive into the Inbox' },
};

const PACE_60 = `(() => {
  const raf = window.requestAnimationFrame.bind(window), caf = window.cancelAnimationFrame.bind(window);
  let q = new Map(), n = 0, last = -1e9, on = false;
  const tick = (ts) => {
    if (ts - last < 15) { raf(tick); return; }
    last = ts; on = false;
    const run = q; q = new Map();
    for (const cb of run.values()) { try { cb(ts); } catch (e) { setTimeout(() => { throw e; }); } }
  };
  window.requestAnimationFrame = (cb) => { const id = ++n; q.set(id, cb); if (!on) { on = true; raf(tick); } return id; };
  window.cancelAnimationFrame = (id) => { q.delete(id); };
})();`;

const median = (xs) => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : 0; };
const parseXf = (s) => {
  const m = /translate\(([-\d.e]+)px,\s*([-\d.e]+)px\)\s*scale\(([-\d.e]+)\)/.exec(s || '');
  return m ? { tx: +m[1], ty: +m[2], k: +m[3] } : null;
};
function rises(steps, tol = 1) {
  let pk = -1, pv = -1;
  steps.forEach((x, i) => { if (x != null && x > pv) { pv = x; pk = i; } });
  const first = steps.findIndex((x) => x != null && x > 0.5);
  let n = 0, max = 0;
  for (let i = Math.max(1, first + 1); i < steps.length; i++) {
    let j = i - 1; while (j >= 0 && steps[j] == null) j--;
    if (j < 0 || steps[i] == null) continue;
    const d = steps[i] - steps[j];
    if (d > tol) { n++; max = Math.max(max, d); }
  }
  return { n, max, peakAt: pk };
}

export async function run({ A = PAGE, base, out, name = A.name, mode = 'light', moves, tries = 3, pass = 'both', shots = true, exe } = {}) {
  const b = await chromium.launch({ executablePath: exe || undefined, headless: true });
  const errs = [];
  const fn = (f) => `(${f.toString()})()`;
  const open = async (M, clock) => {
    const ctx = await b.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2, colorScheme: mode, reducedMotion: M.reduce ? 'reduce' : 'no-preference' });
    if (!clock) await ctx.addInitScript(PACE_60);
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errs.push((M.sheet || '') + ': ' + e.message));
    if (clock) await p.clock.install();
    await p.goto(A.url(base, mode, M.sheet));
    await p.waitForTimeout(2500);
    if (A.focus) await A.focus(p, A);
    await p.mouse.move(4, 300);
    if (clock) { await p.clock.pauseAt(await p.evaluate(() => Date.now() + 100)); await p.clock.runFor(400); }
    const glass = await p.locator(A.stage).first().boundingBox();
    return { ctx, p, glass };
  };
  const state = (p) => p.evaluate(fn(A.state));
  const wheelPt = async (p, M, glass) => {
    if (M.wheel.part) { const r = await p.locator(`${A.world} [data-part="${M.wheel.part}"]`).first().boundingBox(); return [r.x + r.width / 2, r.y + r.height / 2]; }
    return [glass.x + glass.width / 2, glass.y + glass.height / 2];
  };

  async function realtime(nm) {
    const M = MOVES[nm];
    const { ctx, p, glass } = await open(M, false);
    if (M.pre) { await M.pre(p, A); await p.waitForTimeout(1800); await p.mouse.move(4, 300); }
    const camStep = (a, c) => {
      let m = 0;
      for (const [x, y] of [[0, 0], [glass.width, 0], [0, glass.height], [glass.width, glass.height], [glass.width / 2, glass.height / 2]]) {
        const wx = (x - a.tx) / a.k, wy = (y - a.ty) / a.k;
        m = Math.max(m, Math.hypot(wx * c.k + c.tx - x, wy * c.k + c.ty - y));
      }
      return m;
    };
    if (M.wheel) await p.mouse.move(...(await wheelPt(p, M, glass)));
    await p.evaluate(({ world, st }) => {
      window.__rec = []; window.__lt = []; window.__stopRec = false;
      try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push({ s: e.startTime, d: e.duration }); }).observe({ type: 'longtask' }); } catch { }
      const S = eval(st);
      const f = (ts) => {
        window.__rec.push({ ts, xf: document.querySelector(world)?.style.transform || '', code: S().code });
        if (!window.__stopRec) requestAnimationFrame(f);
      };
      requestAnimationFrame(f);
    }, { world: A.world, st: `(${A.state.toString()})` });
    await p.waitForTimeout(200);
    const t0 = await p.evaluate(() => performance.now());
    if (M.wheel) {
      const code0 = (await state(p)).code;
      for (let i = 0; i < M.wheel.n; i++) {
        await p.mouse.wheel(0, M.wheel.dy);
        await p.waitForTimeout(50);
        if ((await state(p)).code !== code0) break;
      }
      await p.waitForTimeout(900);
    } else {
      await M.act(p, A);
      if (M.turn) { await p.waitForTimeout(M.turn.at); if (M.turn.k) await p.keyboard.press(M.turn.k); else for (let i = 0; i < M.turn.n; i++) { await p.mouse.wheel(0, M.turn.dy); await p.waitForTimeout(30); } }
      await p.waitForTimeout(M.ms);
    }
    const { rec, lt } = await p.evaluate(() => { window.__stopRec = true; return { rec: window.__rec, lt: window.__lt }; });
    await ctx.close();
    const fr = rec.filter((r) => r.ts >= t0 - 1);
    const xs = fr.map((r) => parseXf(r.xf));
    let last = 0;
    for (let i = 1; i < fr.length; i++) if (xs[i] && xs[i - 1] && (Math.abs(xs[i].k - xs[i - 1].k) > 1e-6 || Math.abs(xs[i].tx - xs[i - 1].tx) > 0.01 || Math.abs(xs[i].ty - xs[i - 1].ty) > 0.01 || fr[i].code !== fr[i - 1].code)) last = i;
    const end = Math.min(fr.length - 1, Math.max(last + 2, Math.round(700 / FRAME)));
    const mv = fr.slice(0, end + 1);
    let dropped = 0, longest = 0, late = 0;
    for (let i = 1; i < mv.length; i++) { const dt = mv[i].ts - mv[i - 1].ts; longest = Math.max(longest, dt); dropped += Math.max(0, Math.round(dt / FRAME) - 1); if (dt > FRAME * 1.3) late++; }
    const tEnd = mv[mv.length - 1]?.ts ?? t0;
    const longTasks = lt.filter((x) => x.s + x.d >= t0 && x.s <= tEnd);
    const steps = [];
    for (let i = 1; i < mv.length; i++) { const a = xs[i - 1], c = xs[i]; if (!a || !c) continue; const dt = mv[i].ts - mv[i - 1].ts; steps.push(mv[i].code !== mv[i - 1].code ? null : (camStep(a, c) * FRAME) / Math.max(1, dt)); }
    const R = rises(steps);
    return {
      frames: mv.length, dropped, late, longest: Math.round(longest * 10) / 10,
      longTasks: longTasks.length, longMax: Math.round(Math.max(0, ...longTasks.map((x) => x.d))),
      camPeak: +Math.max(0, ...steps.filter((x) => x != null)).toFixed(1), camRises: R.n, camRiseMax: +R.max.toFixed(1), ms: Math.round(tEnd - t0),
    };
  }

  const diffPage = await (await b.newContext({ viewport: { width: 800, height: 400 } })).newPage();
  const diffs = (pngs) => diffPage.evaluate(async (list) => {
    const W = 400, H = 225, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const g = cv.getContext('2d', { willReadFrequently: true });
    const px = async (b64) => { const bin = atob(b64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); const im = await createImageBitmap(new Blob([u], { type: 'image/png' })); g.clearRect(0, 0, W, H); g.drawImage(im, 0, 0, W, H); return g.getImageData(0, 0, W, H).data; };
    const out = [0]; let prev = await px(list[0]);
    for (let i = 1; i < list.length; i++) {
      const cur = await px(list[i]); let n = 0, tot = 0;
      for (let y = 14; y < H - 14; y++) for (let x = 0; x < W; x++) { const o = (y * W + x) * 4; tot++; if (Math.abs(cur[o] - prev[o]) > 24 || Math.abs(cur[o + 1] - prev[o + 1]) > 24 || Math.abs(cur[o + 2] - prev[o + 2]) > 24) n++; }
      out.push(n / tot); prev = cur;
    }
    return out;
  }, pngs);

  const look = (p, win, glass) => p.evaluate(({ A, win, glass, st, wn }) => {
    const stage = document.querySelector(A.stage);
    const [L, T, R, B] = [glass.x, glass.y, glass.x + glass.width, glass.y + glass.height];
    const opc = new Map();
    const opOf = (el) => {
      if (!el || el === stage || el === document.body) return 1;
      if (opc.has(el)) return opc.get(el);
      const cs = getComputedStyle(el);
      const v = (cs.display === 'none' || cs.visibility === 'hidden' ? 0 : +cs.opacity) * opOf(el.parentElement);
      opc.set(el, v); return v;
    };
    const boxes = {};
    const depthOf = (el) => { let n = 0; for (let q = el.parentElement; q && q !== stage; q = q.parentElement) if (q.classList.contains(A.nest)) n++; return n; };
    const add = (id0, el) => {
      const id = depthOf(el) + '|' + id0;
      const fr = el.classList.contains(A.flip) ? el.querySelector(A.frame) : null;
      const r = (fr || el).getBoundingClientRect();
      if (r.width < 2 || r.height < 2 || r.right < L || r.bottom < T || r.left > R || r.top > B) return;
      const op = opOf(el);
      if (op < 0.02) return;
      if (!boxes[id] || r.width > boxes[id][5]) boxes[id] = [Math.max(L, r.left), Math.max(T, r.top), Math.min(R, r.right), Math.min(B, r.bottom), Math.min(1, op), r.width, r.left, r.top, r.right, r.bottom];
    };
    for (const e of document.querySelectorAll(A.parts)) add('p:' + e.dataset.part, e);
    for (const e of document.querySelectorAll(A.zones)) add('z:' + e.dataset.zone, e);
    const seen = new Map();
    for (const e of document.querySelectorAll(A.words)) {
      const k = depthOf(e) + ':' + (typeof e.className === 'string' ? e.className : e.className.baseVal).split(' ')[0] + ':' + e.textContent.trim().slice(0, 28);
      const n = (seen.get(k) || 0) + 1; seen.set(k, n);
      add('f:' + k.slice(k.indexOf(':') + 1) + '#' + n, e);
    }
    const S = eval(st)();
    let doubled = 0, others = 0;
    if (win) {
      const nm = window.__nm ?? (window.__nm = eval(wn)(win));
      if (nm) {
        const hits = [...document.querySelectorAll(A.names)]
          .filter((e) => e.textContent.trim() === nm && e.children.length === 0 && opOf(e) > 0.15)
          .map((e) => e.getBoundingClientRect()).filter((r) => r.width > 1);
        for (let i = 0; i < hits.length; i++) for (let j = i + 1; j < hits.length; j++) if (Math.abs(hits[i].left - hits[j].left) < 60 && Math.abs(hits[i].top - hits[j].top) < 30 && Math.abs(hits[i].width - hits[j].width) < hits[i].width * 0.5) doubled++;
      }
      others = Math.max(0, [...document.querySelectorAll(A.minis)].filter((e) => opOf(e) > 0.05).length - 1);
    }
    return { boxes, code: S.code, depth: S.depth, doubled, others };
  }, { A: { stage: A.stage, nest: A.nest, flip: A.flip, frame: A.frame, parts: A.parts, zones: A.zones, words: A.words, names: A.names, minis: A.minis }, win, glass, st: `(${A.state.toString()})`, wn: `(${A.windowName.toString()})` });

  const pairsOf = (a, c) => {
    const off = (c.depth ?? 0) - (a.depth ?? 0), out = [];
    for (const id of Object.keys(c.boxes)) {
      const d = +id.split('|')[0], rest = id.slice(id.indexOf('|') + 1);
      const x = a.boxes[(d + off) + '|' + rest], y = c.boxes[id];
      if (x) out.push([x, y, id]);
    }
    return out;
  };
  const boxStep = (a, c) => {
    let m = 0, who = '';
    for (const [x, y, id] of pairsOf(a, c)) { const ink = Math.min(x[4], y[4]); for (let i = 0; i < 4; i++) { const v = Math.abs(y[i] - x[i]) * ink; if (v > m) { m = v; who = `${id} edge ${i} ${x[i].toFixed(0)}>${y[i].toFixed(0)} ink ${ink.toFixed(2)}`; } } }
    if (process.env.WHO && m > +process.env.WHO) console.log(`    step ${m.toFixed(1)} ${who} (depth ${a.depth}>${c.depth}, ${a.code}>${c.code})`);
    return m;
  };

  async function film(nm) {
    const M = MOVES[nm];
    const { ctx, p, glass } = await open(M, true);
    if (M.pre) { await M.pre(p, A); for (let i = 0; i < 125; i++) await p.clock.runFor(16); await p.mouse.move(4, 300); }
    const sync = () => p.evaluate(() => { for (const a of document.getAnimations()) if (a.__born != null) { a.pause(); a.currentTime = Math.max(0, performance.now() - a.__born); } });
    const now = () => p.evaluate(() => performance.now());
    if (M.wheel) await p.mouse.move(...(await wheelPt(p, M, glass)));
    const N = Math.round(M.ms / FILM);
    const frames = [];
    const shot = async () => (await p.screenshot({ type: 'png', scale: 'css' })).toString('base64');
    frames.push({ i: -1, at: await now(), ...(await look(p, M.win, glass)), png: await shot() });
    const code0 = frames[0].code;
    let notches = 0, turned = 0;
    if (!M.wheel) await M.act(p, A);
    await sync();
    for (let i = 0; i < N; i++) {
      if (M.wheel && i % 3 === 0 && notches < M.wheel.n && frames[frames.length - 1].code === code0) { await p.mouse.wheel(0, M.wheel.dy); notches++; }
      if (M.turn && i * FILM >= M.turn.at && turned < (M.turn.n || 1) && i % 2 === 0) { if (M.turn.k) await p.keyboard.press(M.turn.k); else await p.mouse.wheel(0, M.turn.dy); turned++; }
      await p.clock.runFor(FILM);
      await sync();
      frames.push({ i, at: await now(), ...(await look(p, M.win, glass)), png: await shot() });
    }
    const gaps = frames.slice(1).map((f, i) => f.at - frames[i].at).filter((d) => Math.abs(d - FILM) > 1);
    if (gaps.length) console.log(`    clock: ${gaps.length} frames not ${FILM} ms apart (${gaps.slice(0, 5).map((d) => d.toFixed(0)).join(', ')})`);
    await ctx.close();
    const dd = await diffs(frames.map((f) => f.png));
    frames.forEach((f, i) => { f.diff = dd[i]; f.step = i ? boxStep(frames[i - 1], f) : 0; });
    const st = frames.slice(1).map((f) => f.step);
    const moving = st.map((s, i) => s > 0.5 || frames[i + 1].diff > 0.001);
    const fm = moving.indexOf(true), lm = moving.lastIndexOf(true);
    const R = rises(st);
    const spikes = dd.map((d, i) => (i > 0 && i < dd.length - 1 ? d - Math.max(dd[i - 1], dd[i + 1]) : 0));
    const codes = [...new Set(frames.map((f) => f.code))];
    return {
      frames, n: fm < 0 ? 0 : lm - fm + 1, firstMoving: fm, peak: +Math.max(0, ...st).toFixed(1), peakAt: R.peakAt, rises: R.n, riseMax: +R.max.toFixed(1),
      diffMax: +(Math.max(...dd) * 100).toFixed(1), spikeMax: +(Math.max(0, ...spikes) * 100).toFixed(1),
      doubled: frames.filter((f) => f.doubled > 0).length, others: frames.filter((f) => f.others > 0).length,
      codes, steps: st.map((x) => +x.toFixed(1)),
    };
  }

  async function strip(nm, F) {
    const M = MOVES[nm];
    const fr = F.frames, cells = [];
    for (let i = 0; i < fr.length; i += 3) {
      const s = i === 0 ? 0 : Math.max(0, ...fr.slice(Math.max(1, i - 2), i + 1).map((f) => f.step));
      const t = Math.round(fr[i].i * FILM + FILM);
      cells.push(`<figure><img src="data:image/png;base64,${fr[i].png}"><figcaption><b>${i === 0 ? 'before' : t + ' ms'}</b> · step ${s.toFixed(1)} px · ${fr[i].code}${fr[i].doubled ? ' · <i>name twice</i>' : ''}${fr[i].others ? ' · <i>other windows ' + fr[i].others + '</i>' : ''}</figcaption></figure>`);
      if (cells.length >= 32) break;
    }
    const page = await (await b.newContext({ viewport: { width: 2000, height: 200 }, deviceScaleFactor: 2 })).newPage();
    await page.setContent(`<style>body{margin:0;padding:14px 18px;background:#f4f5f7;font:12px/1.3 -apple-system,Inter,sans-serif;color:#222}h1{font-size:14px;font-weight:600;margin:0 0 4px}p{margin:0 0 10px;color:#555}.g{display:grid;grid-template-columns:repeat(8,240px);gap:8px 6px}figure{margin:0}img{width:240px;height:135px;display:block;border:1px solid #d6d8dd;box-sizing:border-box}figcaption{padding:2px 1px 0;color:#444;font-size:10.5px;font-variant-numeric:tabular-nums}i{color:#b3261e;font-style:normal}</style>
    <h1>${name}: ${M.title} (${mode})</h1><p>One frame every 48 ms of page time (paused clock, one frame per 16 ms). Under each: the largest single-frame step of any box on the glass in that 48 ms. Move: ${F.n} frames, peak ${F.peak} px, ${F.rises} rises after the start (largest +${F.riseMax} px), largest pixel spike ${F.spikeMax}%.</p><div class="g">${cells.join('')}</div>`);
    await page.waitForTimeout(200);
    const file = path.join(out, `${name}-${nm}${mode === 'dark' ? '-dark' : ''}.png`);
    await page.screenshot({ path: file, fullPage: true });
    await page.context().close();
    return file;
  }

  fs.mkdirSync(out, { recursive: true });
  const results = {};
  for (const nm of moves || Object.keys(MOVES)) {
    if (!MOVES[nm]) continue;
    const r = { name: nm };
    if (pass !== 'film') {
      const T = [];
      for (let k = 0; k < tries; k++) T.push(await realtime(nm));
      r.rt = Object.fromEntries(Object.keys(T[0]).map((f) => [f, median(T.map((t) => t[f]))]));
    }
    if (pass !== 'rt') {
      const F = await film(nm);
      const { frames, ...rest } = F;
      r.film = rest;
      if (shots) r.film.shot = await strip(nm, F);
    }
    results[nm] = r;
    const rt = r.rt ? `rt: ${r.rt.frames} fr, dropped ${r.rt.dropped}, late ${r.rt.late}, longest ${r.rt.longest} ms, long tasks ${r.rt.longTasks} (max ${r.rt.longMax} ms), cam peak ${r.rt.camPeak} rises ${r.rt.camRises} (+${r.rt.camRiseMax})` : '';
    const fl = r.film ? `film: ${r.film.n} fr, step peak ${r.film.peak} px @${r.film.peakAt}, rises ${r.film.rises} (+${r.film.riseMax}), spike ${r.film.spikeMax}%, doubled ${r.film.doubled}, others ${r.film.others}, sheets ${r.film.codes.join(' > ')}` : '';
    console.log(`${nm}\n  ${rt}\n  ${fl}${r.film ? '\n  steps ' + r.film.steps.slice(0, 48).join(' ') : ''}`);
  }
  const jf = path.join(out, `${name}${mode === 'dark' ? '-dark' : ''}.json`);
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(jf, 'utf8')); } catch { }
  for (const [k, v] of Object.entries(results)) prev[k] = { ...(prev[k] || {}), ...v };
  fs.writeFileSync(jf, JSON.stringify(prev, null, 1));
  console.log(jf);
  console.log(errs.length ? 'ERR ' + errs.join(' | ') : 'no page errors');
  await b.close();
  return { results, errs };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const base = process.env.SYSTEM_URL;
  if (!base) { console.error('Set SYSTEM_URL to the demo, for example SYSTEM_URL=http://127.0.0.1:<port>/'); process.exit(2); }
  const { results, errs } = await run({
    base: base.endsWith('/') ? base : base + '/',
    out: process.env.OUT || path.join(process.cwd(), 'measure-out'),
    name: process.env.NAME || 'a4',
    mode: process.env.MODE || 'light',
    moves: process.env.MOVES?.split(','),
    tries: +(process.env.TRIES || 3),
    pass: process.env.PASS || 'both',
    shots: process.env.SHOTS !== '0',
    exe: process.env.CHROMIUM,
  });
  if (process.env.STRICT === '1') {
    const bad = Object.values(results).filter((r) => (r.rt && r.rt.longTasks > 0) || (r.film && (r.film.rises > 0 || r.film.doubled > 0)));
    if (bad.length || errs.length) { console.error('FAIL ' + bad.map((r) => r.name).join(', ')); process.exit(1); }
  }
}
