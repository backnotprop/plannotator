/**
 * The mood gate of the Inbox's emoji reactions (approval
 * "inbox-emoji-reactions", item 3): a TypeScript port of `mood()` in
 * `.product/approved/inbox-emoji-reactions/amendments/2026-11-03-contrast/gate.py`
 * (the amended `mood-gate/gate.py`), whose `tests/cases.json` (54 cases, a
 * copy in fixtures/) is the contract (`reactions.test.ts` runs every case).
 *
 * Deterministic: a pure function of the text. Venting beats an error, an
 * error beats praise; praise needs a praise frame AND VADER's agreement; when
 * unsure, no reaction; venting never gets one. The "Okay, but…" fix: no
 * go-ahead when but / except / however / though / although / apart from /
 * other than / aside from follows the go-ahead. The contrast amendment: the
 * same words after the last praise or win phrase cancel the happy emoji
 * ("that works, but…"): unsure with a critique after them, else the message
 * falls through to the rest of the gate.
 *
 * The regular expressions are gate.py's, unchanged except for JavaScript
 * syntax (`\Z` is `$` without the m flag). Python's `\w` and `\b` also know
 * non-ASCII letters; JavaScript's know ASCII only, which matters only for
 * words in other alphabets, where every lexicon here is English anyway.
 */

import { vaderCompound } from "./vader";

export type ReactionMood = "positive" | "neutral" | "error" | "frustrated" | "unsure";
/** positive: praise | thanks | win | joke. neutral: goahead | looking. error: looking. */
export type ReactionKind = "praise" | "thanks" | "win" | "joke" | "goahead" | "looking";

export interface MoodResult {
  mood: ReactionMood;
  kind: ReactionKind | null;
  reasons: string[];
  vader: number;
}

const vader = (t: string) => (t.trim() ? vaderCompound(t) : 0);

// ──────────────────────────────── own voice ────────────────────────────────

/** Drop what the person did not write in their own voice: pasted blocks, quotes, code, links, paths. */
export function ownVoice(t: string): string {
  let s = t.replace(/<>[\s\S]*?(?:<\/[^\n]*|$)/g, " ");
  s = s.replace(/\[(Pasted text|Image) #\d+[^\]]*\]/g, " ");
  s = s.replace(/```[\s\S]*?```/g, " ");
  s = s.replace(/`[^`\n]*`/g, " ");
  s = s
    .split("\n")
    .filter((l) => !/^\s*(>|⏺|❯|│|⎿|\$ |at |npm |error |warning )/.test(l))
    .join("\n");
  s = s.replace(/"[^"\n]{1,160}"|“[^”\n]{1,160}”|'[^'\n]{3,80}'(?!\w)/g, " ");
  s = s.replace(/https?:\/\/\S+|file:\/\/\S+|(~|\/Users|\/home|\/tmp|\/var|\.{1,2})(\/[\w.@+-]+)+\/?/g, " ");
  // product / proper names that start with a praise word: "Beautiful Mermaid", "Perfect Freehand"
  s = s.replace(/\b(Great|Awesome|Perfect|Nice|Beautiful|Amazing|Brilliant|Super|Cool|Good|Happy|Lovely|Sweet|Fantastic|Excellent|Best|Love)\s+(?=[A-Z][a-z])\w+/g, " NAME ");
  return s.replace(/[ \t]+/g, " ").trim();
}

export function sentences(s: string): string[] {
  return s
    .split(/(?<=[.!?…])\s+|\n+|(?<=\w)\.{2,}\s*/)
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

// ──────────────────────────────── lexicons ────────────────────────────────

const ADJ_WORDS =
  "great|awesome|perfect|nice|beautiful|amazing|excellent|fantastic|sweet|brilliant|lovely|wonderful|incredible|outstanding|stellar|gorgeous|stunning|superb|sick|dope|slick|impressive|insane|killer|legit|fire|epic|phenomenal|terrific|marvelous|spectacular";
const INTENS = "(?:(?:so|very|really|super|pretty|absolutely|fucking|freaking|damn|just|truly|totally|incredibly|definitely|honestly|much|way|so much)\\s+)";
const OPEN = "^\\W*(?:(?:ok(?:ay)?|alright|ah+|oh+|yes+|yep|yeah|wow+|omg|holy (?:shit|fuck|crap|cow)|damn|dude|bro|man)[\\s,.!…]+){0,3}";
const P_INTERJ = new RegExp(
  OPEN +
    INTENS +
    "{0,2}(" +
    ADJ_WORDS +
    "|good job|great job|nice job|good work|great work|nice work|good stuff|good catch|good call|nice catch|much better|way better|so much better|better|thank you|thanks|thx|ty|lgtm|well done|bravo|nailed it|yay|woo+|hell yes|hell yeah|fuck yes|fuck yeah|finally|not bad|love it|love this|love that|i love it|beautiful)" +
    "(?:\\s+(?:work|job|stuff|catch|call|find|progress|news|idea|question|point|thinking|move|one|state))?(?=\\s*(?:[.!,;:…—–-]|$|\\s+(?!for\\b|to\\b|if\\b|as\\b|of\\b)\\w))",
  "i",
);
const P_PRED = new RegExp(
  "\\b(?:this|that|it|thats|its|this one|these|those|everything|all|things|they|the (?:ui|page|video|design|result|output|layout|header|app|render|animation|new \\w+))\\s*(?:'s|’s|(?<=thats)|(?<=its)|\\s+is|\\s+are|\\s+was|\\s+were|\\s+looks?|\\s+looked|\\s+looking|\\s+seems?|\\s+feels?|\\s+sounds?|\\s+turned out|\\s+came out|\\s+reads?)\\s+(?:\\w+\\s+){0,2}?" +
    INTENS +
    "*(" +
    ADJ_WORDS +
    "|good|clean|solid|cool|right on)\\b",
  "gi",
);
const P_LOOKS = new RegExp("(?:^|[\\s,.])(?:looks?|looking|sounds?|seems?|feels?|reads?)\\s+" + INTENS + "*(" + ADJ_WORDS + "|good|clean|solid|right)\\b", "gi");
const P_PHRASE =
  /\b(good job|great job|nice job|nice work|great work|good work|well done|nailed it|you nailed|chef'?s kiss|lgtm|love (?:it|this|that|how|the|these|those|your|what)|loving (?:it|this|the)|i (?:really )?(?:like|love) (?!to\b|when\b|if\b)\w+|(?:i'?m|i am) (?:glad|happy|thrilled|stoked|impressed)|thank you|thanks|thx|appreciate (?:it|you|that|this)|much better|way better|so much better|works (?:great|well|perfectly|beautifully|now|like a charm)|(?:it|that|this|everything|all|things|its|thats)(?:'s|’s| is| are| seem to be| seems to be)? (?:all |now )?working(?! on| with| in| through| together| for| at| out)|^working (?:well|great|perfectly|now)|'?s? working (?:well|great|good|perfectly|now)|(?:it|that|this|everything) works|(?:it|that|this) worked|finally (?:works|working|fixed|!)|hell yes|hell yeah|fuck yes|fuck yeah|not (?:too |that |so )?bad|turned out (?:amazing|great|awesome|really good)|crushed it|killed it|you rock|legend|🔥|🎉|❤️|🙏|🙌|👏|😍|🥳|💯|🤩)/gi;
const GUARD_COND = /\b(if|whether|make sure|ensure|verify|confirm|check|should|until|unless|so that|in order|to see|test|assuming|hopefully|once|would|could|might|want it to|needs? to|to be|how|why|what|when|where)\b[^.!?]*$/i;
const GUARD_NEG = /(\bnot|n't|n’t|\bnever|\bno longer|\bnothing|\bnone|\bbarely|\bhardly|\bisnt|\bdoesnt|\bdont|\bcant|\bwont|\bwasnt|\bwithout)\s+(?:\w+\s+){0,2}$/i;
const JOKE = /\b(lol|lmao|lmfao|haha\w*|hehe\w*|rofl|hilarious|kinda funny|so funny)\b|😂|🤣|😆/i;
const WIN = /\b(works?|working|worked|fixed|finally|shipped|merged|passing|passed|green|landed|solved|done)\b/i;
const THANKS = /\b(thank|thanks|thx|ty|appreciate)\b|🙏/i;

const PROF =
  /\b(fuck\w*|f\*+k\w*|shit\w*|bullshit|wtf|ffs|damn\w*|goddamn\w*|crap\w*|motherfuck\w*|jesus|christ|the hell|dick\w*|piss\w*|retard\w*|stupid|dumb|idiot\w*|useless|garbage|trash|shitty|terrible|horrible|horrific|horrifying|hideous|awful|pathetic|ridiculous|bloat)\b/gi;
const PROF_PRAISE =
  /\b(holy (?:shit|fuck|crap)|hell (?:yes|yeah)|fuck (?:yes|yeah)|(?:so |damn |fucking |freaking )+(?:good|great|awesome|amazing|beautiful|perfect|sick|nice|clean|fast|cool)|(?:fucking|damn|freaking) (?:love|nailed|killed|crushed)|let'?s (?:fucking )?go+|badass|damn good|damn right)\b/gi;
const VENT =
  /\b(i (?:already )?told you|told you (?:already|before|that|this|to)|how many times|so many times|(?:\d+|ten|hundred|million) (?:more )?times|one more time|for the last time|still (?:not|broken|failing|fails|doesn'?t|isn'?t|happening|animating|blinking|appearing|flashing|the same|seeing|there|showing|wrong|missing|empty|loading|going|stuck)|not fixed|are you (?:kidding|serious|joking)|seriously\b|come on\b|stop (?:it|doing|adding|guessing|dicking|running|changing|inventing|giving|touching|suggesting|that)|you keep (?:doing|adding|changing|breaking|saying|suggesting|making|getting|ignoring|forgetting|asking|telling)|whatever you'?re doing|you better|what(?:'s| is| was) the point|why why|^\W*again\b|you (?:always|never)\b|don'?t come back|use your (?:fucking )?brain|what are (?:you|we) (?:even |fucking )?talking about|you(?:'re| are) (?:overassuming|overreacting|inventing|not listening|making (?:poor )?assumptions|wrong)|speak (?:even )?(?:more )?(?:simply|clearly|plainly)|(?:drop|no|so much|too much|stop with the) (?:the )?jargon|so much bloat|sick (?:and|&) tired|i can'?t (?:help|afford|read|take)|not what i (?:asked|said|wanted)|i (?:said|asked for)\b(?! .*\bthanks)|did you not\b|why (?:the hell |the fuck )?(?:did|would|are) you\b|what is (?:your|the) problem|what'?s (?:the|your) (?:fucking )?problem|ugh+|argh+|bro\?+|dude\?+|unacceptable|not acceptable|we had it working|you (?:broke|messed|screwed|fucked)|thanks for nothing|great job breaking|nice try|yeah right|oh great|just great)\b|\?{2,}|!{3,}/gi;

const ERR_STRONG =
  /(Traceback \(most recent call last\)|^\s*at [\w.<>$]+ ?\(?[^\s)]*:\d+:\d+\)?|File "[^"]+", line \d+|\b\w*(?:Error|Exception)\b:|\bERR[!_]|\bE(?:NOENT|ACCES|CONNREFUSED|NOTFOUND|ADDRINUSE|PERM)\b|command not found|no such file or directory|permission denied|cannot find module|module not found|is not defined|cannot read propert|undefined is not|segmentation fault|\bpanic:|\bfatal:|exit(?:ed)? (?:with )?code [1-9]|\b(?:404|500|502|503|504|529|429|403|401)\b(?: \(?(?:not found|internal|bad gateway|service unavailable|overloaded|too many|forbidden|unauthorized))?|net::\w+|unexpected token|syntaxerror|uncaught|status: (?:critical|warning|failed)|alert status|\bdeprecated\b|\bwarn(?:ing)?:)/gim;
const ERR_WEAK =
  /\b((?:doesn'?t|does not|isn'?t|is not|aren'?t|are not|not|never|don'?t) (?:seem to |really |even |actually )?(?:be )?(?:work|working|show|showing|render|rendering|load|loading|appear|appearing|update|updating)|does nothing|do nothing|did nothing|bugs?|buggy|bugged|broken|breaks|broke|crash\w*|fail\w*|errors?|exception|regress\w*|not (?:working|showing|rendering|loading|appearing|updating|saving|sending|responding)|isn'?t (?:working|showing|rendering|loading|appearing)|doesn'?t (?:work|show|render|load|appear|seem to work|gray out)|don'?t (?:work|see)|nothing (?:happens|happened|renders|shows|changed|has changed)|stopped (?:working|responding)|no longer (?:works|working|shows)|(?:blank|empty) (?:page|screen)|red x|is dead|are dead|stuck|hangs?|hung|flash(?:es|ing)|blink\w*|flicker\w*|disappear\w*|glitch\w*|lag(?:gy|ging)|not seeing|can'?t (?:see|click|select|open)|cannot (?:see|click|select|open)|wrong position|overlap\w*|cut off|layout (?:issue|shift)|formatting issues|timed? ?out|not centered|offset)\b/gi;
const ERR_RESOLVED =
  /\b(no (?:more )?(?:errors?|crash\w*|bugs?)|(?:errors?|bugs?|crash\w*|issues?) (?:is |are )?(?:gone|fixed|resolved)|fixed (?:the|that|this|it)|(?:it'?s|it is|now|all|everything'?s?) working(?: now)?|works now|working now)\b/gi;
const CRIT =
  /\b(only (?:issue|thing|problem)|one thing i|too (?:big|small|tall|short|wide|narrow|fast|slow|bright|dark|much|busy|loud|long|heavy|light)|don'?t (?:like|love)|not (?:quite|really|right|ideal|sure)|mess|wrong|weird|janky|ugly|redundant|confus\w*|missing|why is|why are|why does)\b/gi;
const GOAHEAD =
  /^\W*(?:(?:ok(?:ay)?|alright|cool|great|perfect|nice)[\s,.!]+)?(yes|yep|yeah|yup|sure|ok(?:ay)?|sounds good|go ahead|do it|ship it|merge it|let'?s (?:do it|do that|go|ship|merge|get|commit|push)|approved|lgtm|proceed|go for it|i'?m (?:good|fine|ok|okay|happy|cool) with|that'?s fine|fine by me|agreed|correct|exactly|please do|commit|push|squash merge|merge|you (?:can|may) (?:merge|commit|push|go)|you have (?:my|full)|go)\b(?![^.!?\n]*\?)/i;

const NEG_EVAL =
  /\b(ugly|bad|hate|awful|terrible|horrible|worse|worst|broken|wrong|sucks|meh|gross|mess|messy|disappoint\w*|annoying|confusing|janky|clunky|sloppy|lazy|laggy|buggy|weird|off-putting|underwhelming)\b/gi;
const NOT_NEG = /\b((?:not|isn'?t|wasn'?t|ain'?t) (?:too |that |so )?bad|no (?:more )?(?:problem|worries|issues?|errors?|bugs?)|nothing (?:broke|broken))\b/gi;

const GOAHEAD_QUALIFIED = /\b(but|except|however|though|although|apart from|other than|aside from)\b/i;

const ACRONYMS = new Set(
  "API APIS HTML CSS JSON UI UX CLI MCP URL URLS SDK NPM AWS GCP PR PRS TUI SSE SSO SAML OIDC VPC DNS CI CD QA ID IDS HTTP HTTPS SVG PNG JPG GIF PDF MD TS JS JSX TSX ENV LLM LLMS AI GPT OK HN SQL DB KV R2 D1 DO DOS RPC SSH TTL GFM IDE LSP AST CDN WYSIWYG FAQ ETA TBD TODO README LITE USD CEO CTO VS CPU GPU RAM SPA SSR XML YAML TOML CORS JWT OTP ASAP FYI IMO IIRC TLDR BYOA PFM ADR".split(" "),
);

/** Every match of a global pattern, from a fresh lastIndex. */
function all(rx: RegExp, s: string): RegExpExecArray[] {
  rx.lastIndex = 0;
  return [...s.matchAll(rx)];
}

// ──────────────────────────────── the gate ────────────────────────────────

type Hit = { si: number; kind: string; text: string };

/** Praise anchors in praise frames, with the sentence index where each sits. */
function praiseHits(own: string): Hit[] {
  const hits: Hit[] = [];
  sentences(own).forEach((s, si) => {
    const m = P_INTERJ.exec(s);
    if (m) hits.push({ si, kind: "opener", text: m[0].trim() });
    for (const [rx, kind] of [
      [P_PRED, "predicate"],
      [P_LOOKS, "looks"],
      [P_PHRASE, "phrase"],
    ] as const) {
      for (const hit of all(rx, s)) {
        const clause = s.slice(hit.index).split(/[,;:—–]|\s-+\s/)[0]!;
        if (clause.includes("?")) continue;
        const pre = s.slice(0, hit.index);
        if (GUARD_NEG.test(pre) && !/^not (too |that |so )?bad/i.test(hit[0])) continue;
        if (GUARD_COND.test(pre)) continue;
        hits.push({ si, kind, text: hit[0].trim() });
      }
    }
  });
  return hits;
}

/** The mood of a reply, a pure function of its text (gate.py `mood`). */
export function mood(text: string): MoodResult {
  const own = ownVoice(text);
  const R: string[] = [];
  const vOwn = vader(own);
  const sents = sentences(own);
  const out = (mood: ReactionMood, kind: ReactionKind | null): MoodResult => ({ mood, kind, reasons: R, vader: Math.round(vOwn * 1000) / 1000 });
  if (!own && !text.trim()) {
    R.push("empty");
    return out("unsure", null);
  }
  // 1. venting: profanity not used as praise, exasperation phrases, shouting
  const ownNp = own.replace(PROF_PRAISE, " ");
  const prof = all(PROF, ownNp).map((m) => m[0]);
  const vent = all(VENT, own).map((m) => m[0]);
  const caps = (own.match(/\b[A-Z]{3,}\b/g) ?? []).filter((w) => !ACRONYMS.has(w));
  if (caps.length >= 2 && vader(sentences(own).slice(0, 3).join(" ")) < 0.3) vent.push("CAPS:" + caps.slice(0, 3).join(" "));
  if (prof.length || vent.length) {
    R.push("vent: " + [...prof, ...vent].slice(0, 4).join(", "));
    return out("frustrated", null);
  }
  // 2. errors: pasted/console output (whole text) or a plain bug report (own voice)
  const strong = all(ERR_STRONG, text)
    .slice(0, 3)
    .map((m) => m[0].trim());
  let weak = all(ERR_WEAK, own)
    .slice(0, 3)
    .map((m) => m[0]);
  const res = all(ERR_RESOLVED, own);
  if (weak.length && !strong.length && res.length) {
    const last = res[res.length - 1]!;
    const lastEnd = last.index + last[0].length;
    const after = all(ERR_WEAK, own)
      .filter((m) => m.index > lastEnd)
      .map((m) => m[0]);
    if (!after.length && !/\b(but|except|still|however|though)\b/i.test(own.slice(lastEnd))) {
      R.push("error words resolved: " + last[0]);
      weak = [];
    } else weak = after.length ? after : weak;
  }
  if (strong.length || weak.length) {
    if (vOwn <= -0.5) {
      R.push(`error + strongly negative tone (vader ${vOwn.toFixed(2)})`);
      return out("frustrated", null);
    }
    R.push(strong.length ? "error output: " + strong.join(", ") : "bug report: " + weak.join(", "));
    return out("error", "looking");
  }
  // 3. praise: a praise frame in the opening, VADER agrees, no later critique
  const hits = praiseHits(own);
  const opening = hits.filter((x) => x.si <= 1 || own.length < 200);
  let cancelled = false;
  if (opening.length) {
    R.push("praise: " + [...new Set(opening.map((x) => x.text))].sort().join(", ").slice(0, 80));
    const low = own.toLowerCase().replace(PROF_PRAISE, " ").replace(NOT_NEG, " ");
    const negw = all(NEG_EVAL, low)
      .filter((m) => !/(\bnot|n't|\bno|\bnever)\s+(?:\w+\s+)?$/.test(low.slice(0, m.index)))
      .map((m) => m[1]!);
    // VADER does not know dev wins ("it works") or swearing-as-praise; neutralise those before asking it
    const vAdj = vader(sents.slice(0, 2).join(" ").replace(PROF_PRAISE, " great "));
    if (vAdj < 0) {
      R.push(`unsure: praise words but tone negative (vader ${vAdj.toFixed(2)})`);
      return out("unsure", null);
    }
    if (negw.length) {
      R.push("unsure: praise next to negative words (" + negw.slice(0, 3).join(", ") + ")");
      return out("unsure", null);
    }
    const first = Math.max(...opening.map((x) => x.si));
    const crit = sents.slice(first).flatMap((s) =>
      all(CRIT, s)
        .filter((m) => !/(\bnot|n't|\bno)\s+(?:\w+\s+)?$/i.test(s.slice(0, m.index)))
        .map((m) => m[0]),
    );
    if (crit.length && new Set(opening.map((x) => x.text.toLowerCase())).size < 2) {
      R.push("unsure: praise then critique (" + crit.slice(0, 2).join(", ") + ")");
      return out("unsure", null);
    }
    // "That works, but <problem>" (amendment 2026-11-03-contrast): a contrast word after the last praise phrase cancels
    // the praise (a "but" BEFORE the praise, "took a while, but it works now", does not). No praise or win emoji; with
    // a critique after it: unsure, else the message falls through to the rest of the gate (an error or a request can
    // still get a calm 👀/🤔).
    const lo = own.toLowerCase();
    let end = 0;
    for (const x of opening) {
      const at = lo.indexOf(x.text.toLowerCase());
      if (at >= 0) end = Math.max(end, at + x.text.length);
    }
    const qual = GOAHEAD_QUALIFIED.exec(own.slice(end));
    if (qual) {
      R.push(`praise "${[...new Set(opening.map((x) => x.text))].sort()[0]!.slice(0, 30)}" qualified by "${qual[1]}": no praise or win emoji`);
      if (all(CRIT, own.slice(end)).length > 0) {
        R.push("unsure: critique after it");
        return out("unsure", null);
      }
      cancelled = true;
    }
  }
  if (opening.length && !cancelled) {
    const sub: ReactionKind = THANKS.test(own) && !WIN.test(own) ? "thanks" : WIN.test(sents.slice(0, 2).join(" ")) ? "win" : "praise";
    return out("positive", JOKE.test(own) ? "joke" : sub);
  }
  if (hits.length && !cancelled) R.push("praise words only deep in a long message: ignored");
  // 4. neutral, with two unsure bands
  if (vOwn <= -0.5) {
    R.push(`unsure: negative tone without known words (vader ${vOwn.toFixed(2)})`);
    return out("unsure", null);
  }
  if (vOwn >= 0.6 && own.length < 120) {
    R.push(`unsure: positive tone without a praise frame (vader ${vOwn.toFixed(2)})`);
    return out("unsure", null);
  }
  const g = GOAHEAD.exec(own);
  if (g) {
    // "Okay, but <bug>" / "ok, everything is correct except X": the acknowledgement is qualified, so no go-ahead emoji
    const qual = GOAHEAD_QUALIFIED.exec(own.slice(g.index + g[0].length));
    if (qual) {
      R.push(`acknowledgement "${g[1]}" qualified by "${qual[1]}": no go-ahead emoji`);
      R.push("request or question");
      return out("neutral", "looking");
    }
    R.push("go-ahead: " + g[1]);
    return out("neutral", "goahead");
  }
  R.push("request or question");
  return out("neutral", "looking");
}

/** Pasted error or console output (gate.py's ERR_STRONG), for "errors never get one" in the pacing. */
export const ERR_STRONG_OUTPUT = new RegExp(ERR_STRONG.source, "im");
