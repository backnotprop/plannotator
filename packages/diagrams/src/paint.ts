import type {DiagramPart, DiagramImage, Face, Fonts, Theme, Weight} from "./model.js";

export const escape = (s: string) => s.replace(/[&<>"']/g, c =>
    ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&apos;"}[c]!));
export const n = (x: number) => String(Math.round(x * 100) / 100);
export const cap = (c: Painter, size: number, weight: Weight = "regular") =>
    size * c.fonts[weight].cap / c.fonts[weight].upm;
export class ExtraFontRequired extends Error {
    constructor(readonly weight:Weight) {super("Additional Inter outlines required for "+weight+".");}
}
function pair(f: Face, a: number, b: number): number {
    for (const lookup of f.lookups) {
        if ("pairs" in lookup) {
            const adjust = lookup.pairs[a*65536+b];
            if (adjust !== undefined) return adjust;
        } else if (lookup.left[a] !== undefined) {
            return lookup.values[lookup.left[a]*65536 + (lookup.right[b] ?? 0)] ?? 0;
        }
    }
    return 0;
}
export function shade(color: string, amount: number) {
    const bytes = color.slice(1).match(/../g)!;
    return "#" + bytes.map(c=>Math.round(parseInt(c,16)*(1-amount)).toString(16).padStart(2,"0")).join("");
}
export function lightness(color: string) {
    const rgb = color.slice(1).match(/../g)!.map(c=>{
        const v = parseInt(c,16)/255;
        return v <= 0.03928 ? v/12.92 : ((v+0.055)/1.055)**2.4;
    });
    return 0.2126*rgb[0] + 0.7152*rgb[1] + 0.0722*rgb[2];
}
const MAX_LAYOUT_PROBLEMS = 100;

type Run = {width: number; outline: string};
export class Painter {
    parts: string[] = [];
    sections: DiagramPart[] = [];
    private reportedProblems: string[] = [];
    states = new Set<string>();
    minText = Infinity;
    private runs = new Map<string,Run>();
    constructor(readonly t: Theme, readonly fonts: Fonts, readonly extended: ReadonlySet<Weight>) {}
    report(problem: string) {
        if (this.reportedProblems.length < MAX_LAYOUT_PROBLEMS) this.reportedProblems.push(problem);
        else if (this.reportedProblems.length === MAX_LAYOUT_PROBLEMS)
            this.reportedProblems.push("More layout problems remain. Fix the reported problems and render again.");
    }
    getProblems(): string[] {
        return this.reportedProblems;
    }
    private run(text: string, weight: Weight) {
        const key = weight+"\\0"+text;
        const cached = this.runs.get(key);
        if (cached) return cached;
        const f = this.fonts[weight];
        let width = 0, outline = "", previous = -1;
        for (const c of text) {
            const code = c.codePointAt(0)!;
            let id = f.map[code];
            if (id === undefined) {
                if (!this.extended.has(weight)) throw new ExtraFontRequired(weight);
                id = f.map[0xfffd] ?? 0;
                const warning = `Inter has no glyph for U+${code.toString(16).toUpperCase()} in '${text}'`;
                if (!this.reportedProblems.includes(warning)) this.report(warning);
            }
            if (previous >= 0) width += pair(f,previous,id);
            const [advance,x,y,path] = f.glyphs[id];
            if (path) outline += `M${n(width+x)} ${n(y)}${path}`;
            width += advance;
            previous = id;
        }
        const run = {width,outline};
        this.runs.set(key,run);
        return run;
    }
    width(text: string, size: number, weight: Weight = "regular") {
        return this.run(text,weight).width*size/this.fonts[weight].upm;
    }
    widest(lines: string[], size: number, weight: Weight = "regular") {
        return lines.reduce((v,s)=>Math.max(v,this.width(s,size,weight)),0);
    }
    wrap(text: string, size: number, width: number, weight: Weight = "regular") {
        return text.split("\n").flatMap(paragraph=>{
            const lines: string[] = []; let line = "";
            for (const word of paragraph.split(" ")) {
                const trial = line ? line+" "+word : word;
                if (line && this.width(trial,size,weight)>width) { lines.push(line); line = word; }
                else line = trial;
            }
            return [...lines,line];
        });
    }
    text(s: string,x: number,y: number,size: number,weight: Weight="regular",color=this.t.ink) {
        if (!s) return 0;
        this.minText = Math.min(this.minText,size);
        const run = this.run(s,weight), scale = size/this.fonts[weight].upm;
        if (run.outline) this.parts.push(`<path transform="translate(${n(x)} ${n(y)}) scale(${scale} ${-scale})" fill="${color}" d="${run.outline}"><title>${escape(s)}</title></path>`);
        return run.width*scale;
    }
    centered(s: string,x: number,y: number,size: number,weight: Weight="regular",color=this.t.ink) {
        this.text(s,x-this.width(s,size,weight)/2,y+cap(this,size,weight)/2,size,weight,color);
    }
    private stroke(color: string, width: number, dash?: string | null) {
        if (!color) return "";
        const pattern = dash === "dashed" ? "5 3.5" : dash === "dotted" ? "0.1 3.4" : dash;
        return ` stroke="${color}" stroke-width="${n(width)}"` +
            (pattern ? ` stroke-dasharray="${escape(pattern)}" stroke-linecap="round"` : "");
    }
    rect(x: number,y: number,w: number,h: number,fill: string,stroke="",sw=1,r=0,dash?: string|null) {
        this.parts.push(`<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="${n(r)}" fill="${fill}"${this.stroke(stroke,sw,dash)}/>`);
    }
    path(d: string, fill="none", stroke="", sw=1, dash?: string|null) {
        this.parts.push(`<path d="${d}" fill="${fill}" stroke-linejoin="round"${stroke && !dash ? ' stroke-linecap="round"' : ''}${this.stroke(stroke,sw,dash)}/>`);
    }
    line(x: number,y: number,u: number,v: number,color: string,sw=1,dash?: string|null) {
        this.path(`M${n(x)} ${n(y)}L${n(u)} ${n(v)}`,"none",color,sw,dash);
    }
    circle(x: number,y: number,r: number,fill: string) {
        this.parts.push(`<circle cx="${n(x)}" cy="${n(y)}" r="${n(r)}" fill="${fill}"/>`);
    }
    image({src, alt, width, height}: DiagramImage, x: number, y: number) {
        this.parts.push(`<image x="${n(x)}" y="${n(y)}" width="${n(width)}" height="${n(height)}" ` +
            `preserveAspectRatio="xMidYMid meet" href="${escape(src)}"><title>${escape(alt)}</title></image>`);
    }
}
