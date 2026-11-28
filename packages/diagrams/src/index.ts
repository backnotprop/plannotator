import {fonts} from "./assets.js";
import {panelBlock} from "./blocks.js";
import {describe} from "./describe.js";
import {extent,separation} from "./model.js";
import type {Box, DiagramPart, Point, DiagramSpec, Fonts, Group, Placed, Weight} from "./model.js";
import {cap, escape, ExtraFontRequired, n, Painter} from "./paint.js";
import {arrow, arrowVertices, route} from "./routes.js";
import {prepare, type PreparedPanel} from "./spec.js";
export type {DiagramSpec, DiagramImage, DiagramPart, DiagramReference, Box, Point, Side, Panel, Section, Connection, Theme} from "./model.js";

function layout(c:Painter,s:DiagramSpec,input:ReturnType<typeof prepare>):Placed[] {
    const t=c.t,gap=s.gap??t.col_gap,rowGap=s.row_gap??t.row_gap;
    const make=(panel:PreparedPanel):Placed=>{
        const block=panelBlock(c,panel,panel.sourcePath);
        return {id:panel.id!,panel,head:panel.sub?t.header_h_sub:t.header_h,block,x:panel.x??0,y:panel.y??0,w:block.w,h:block.h};
    };
    if(input.panels) return input.panels.map(make);
    if(input.columns) {
        const columns=input.columns.map(col=>col.map(make));
        const hs=columns.map(col=>col.reduce((h,p)=>h+p.h,0)+(col.length-1)*rowGap),tallest=Math.max(...hs);
        let x=0;
        columns.forEach((col,i)=>{
            let y=(tallest-hs[i])*(s.valign==="top"?0:s.valign==="bottom"?1:.5);
            const width=Math.max(...col.map(p=>p.w));
            for(const p of col) {p.x=x;p.y=y;p.w=width;y+=p.h+rowGap;}
            x+=width+gap;
        });
        return columns.flat();
    }
    const ring=input.ring!.map(make),middle=(input.center||[]).map(make);
    const stretch=Math.min(1.8,Math.max(1,ring.reduce((w,p)=>w+p.w,0)/ring.reduce((h,p)=>h+p.h,0)));
    const centerW=Math.max(0,...middle.map(p=>p.w)),centerH=middle.reduce((h,p)=>h+p.h,0)+Math.max(0,middle.length-1)*t.row_gap;
    const vectors=ring.map((_,i)=>{const a=((s.start_angle??-90)+360*i/ring.length)*Math.PI/180;return [stretch*Math.cos(a),Math.sin(a)];});
    // Solve the radius for each pair, then snap to the reference renderer's 40 + 6k grid.
    let required=40;
    const obstacles=middle.length?[...ring,{w:centerW,h:centerH}]:ring;
    const v=middle.length?[...vectors,[0,0]]:vectors;
    for(let i=0;i<obstacles.length;i++) for(let j=0;j<i;j++) {
        const a=obstacles[i],b=obstacles[j];
        const rx=((a.w+b.w)/2+gap)/Math.abs(v[i][0]-v[j][0]);
        const ry=((a.h+b.h)/2+gap)/Math.abs(v[i][1]-v[j][1]);
        required=Math.max(required,Math.min(rx,ry));
    }
    const radius=40+6*Math.ceil((required-40)/6);
    ring.forEach((p,i)=>{p.x=radius*vectors[i][0]-p.w/2;p.y=radius*vectors[i][1]-p.h/2;});
    let y=-centerH/2;
    for(const p of middle) {p.x=-centerW/2;p.y=y;p.w=centerW;y+=p.h+t.row_gap;}
    const all=[...ring,...middle],bounds=extent(all);
    all.forEach(p=>{p.x-=bounds.x;p.y-=bounds.y;});
    return all;
}

function header(c:Painter,s:DiagramSpec,contentWidth:number) {
    const t=c.t,m=t.margin,note=s.note,lines=(note?.lines??[]).flatMap(l=>c.wrap(l,t.body,330-2*t.pad));
    const noteW=note?2*t.pad+Math.max(c.width(note.title,13,"semibold"),c.widest(lines,t.body)):0;
    const noteH=note?2*t.pad+18+lines.length*t.line_h:0;
    const tagW=s.tag?c.width(s.tag,13,"bold")+24:0;
    const titleW=(tagW?tagW+12:0)+c.width(s.title,t.title,"bold");
    const show=s.legend!==false, steps=show?s.steps??[]:[];
    const firstStep=c.width((s.steps_label??"Steps")+":",t.legend,"semibold")+12;
    const stepWidth=steps.reduce((w,[,label])=>w+42+c.width(label,t.legend),firstStep);
    const minWidth=Math.max(titleW,c.width(s.subtitle||"",t.subtitle),steps.length?stepWidth-18:0);
    const width=Math.max(640,contentWidth+2*m,2*m+minWidth+(note?48+noteW:0));
    const room=width-2*m-(note?noteW+40:0);
    const kinds=new Set(s.links?.map(l=>l.kind||"flow"));
    const items=[...Object.entries(t.statuses).filter(([k])=>c.states.has(k)).map(([key,st])=>({line:false,key,label:st.label})),
        ...Object.entries(t.link_labels).filter(([k])=>kinds.has(k)).map(([key,label])=>({line:true,key,label}))];
    const rows:(typeof items)[]=[]; let used=0;
    if(show) for(const item of items) {
        const w=(item.line?34:30)+c.width(item.label,t.legend)+22;
        if(!rows.length || (used && used+w>room)) {rows.push([]);used=0;}
        rows[rows.length-1].push(item);used+=w;
    }
    const h=Math.max(noteH,34+(s.subtitle?24:0)+(rows.length||steps.length?14:0)+24*rows.length+(steps.length?24:0));
    function draw() {
        let x=m,y=m+34;
        if(s.tag) {c.rect(x,m+1,tagW,28,t.paper,t.tag_color,1.4,14);c.centered(s.tag,x+tagW/2,m+15,13,"bold",t.tag_color);x+=tagW+12;}
        c.text(s.title,x,m+15+cap(c,t.title,"bold")/2,t.title,"bold");
        if(s.subtitle) {c.text(s.subtitle,m,y+10+cap(c,t.subtitle)/2,t.subtitle,"regular",t.muted);y+=24;}
        if(rows.length||steps.length) y+=14;
        for(const row of rows) {
            let lx=m;const ly=y+10;
            for(const item of row) {
                if(item.line) {
                    const dotted=item.key==="planned";
                    c.line(lx,ly,lx+22,ly,t.line,dotted?1.6:1.3,dotted?"dotted":null);
                    c.path(arrow([lx+28,ly],[1,0]),t.line);lx+=34;
                } else {
                    const st=t.statuses[item.key];
                    c.rect(lx,ly-7,22,14,st.fill,st.stroke,1.2,3,st.dash);lx+=30;
                }
                lx+=c.text(item.label,lx,ly+cap(c,t.legend)/2,t.legend)+22;
            }
            y+=24;
        }
        if(steps.length) {
            const ly=y+10;
            let lx=m+c.text((s.steps_label??"Steps")+":",m,ly+cap(c,t.legend,"semibold")/2,t.legend,"semibold")+12;
            for(const [num,label] of steps) {
                c.circle(lx+9,ly,9,t.badge_fill||t.tones.default);
                c.centered(String(num),lx+9,ly,10.5,"bold",t.badge_text||t.paper);
                lx+=24+c.text(label,lx+24,ly+cap(c,t.legend)/2,t.legend)+18;
            }
        }
        if(note) {
            const nx=width-m-noteW;
            c.rect(nx,m,noteW,noteH,t.note_fill,t.note_stroke,1.2,t.radius);
            c.text(note.title,nx+t.pad,m+t.pad+12,13,"semibold");
            lines.forEach((line,i)=>c.text(line,nx+t.pad,m+t.pad+29+i*t.line_h,t.body,"regular",t.muted));
        }
    }
    return {width,h,draw};
}
function contains(a:Box,b:Box) {
    return a.x<=b.x && a.y<=b.y && a.x+a.w>=b.x+b.w && a.y+a.h>=b.y+b.h;
}
/** Blank titles and labels in legacy drawings still need a selectable part. */
function reviewIds(raw: string[], kind: string): Map<string,string> {
    const reserved=new Set(raw);
    const result=new Map<string,string>();
    let ordinal=0;
    for (const value of raw) {
        let id=value;
        if (!id.trim()) {
            do { id=kind+"#"+(++ordinal); } while (reserved.has(id));
            reserved.add(id);
        }
        result.set(value,id);
    }
    return result;
}
function build(s:DiagramSpec,pack:Fonts,extended:ReadonlySet<Weight>) {
    const input=prepare(s),t=input.t,c=new Painter(t,pack,extended),panels=layout(c,s,input);
    if ((s.steps?.length || panels.some(p=>p.panel.step!==undefined)) && t.badge_fill &&
        panels.some(({panel:p})=>(t.tones[p.tone??"default"]??p.tone)===t.tones.accent)) {
        t.badge_fill=t.tones.dark;t.badge_text=t.header_text_on_dark;
    }
    const ids=new Map(panels.map(p=>[p.id,p]));
    const groups:Group[]=(s.groups||[]).map(g=>{
        const b=extent(g.members.map(id=>ids.get(id)!)),pad=t.pad+8,extra=t.line_h*(g.sub?2:1)+6;
        const x=b.x-pad,y=b.y-pad-extra,titleW=Math.max(c.width(g.label,12.5,"semibold"),c.width(g.sub||"",t.small));
        return {...g,x,y,w:Math.max(b.w+2*pad,titleW+26),h:b.h+2*pad+extra,titleBox:{x:x+10,y:y+7,w:titleW+8,h:extra+2}};
    });
    for(const [i,p] of panels.entries()) for(const b of panels.slice(i+1)) {
        const d=separation(p,b);
        if(d<t.min_gap) c.report(d<0?`'${p.id}' and '${b.id}' overlap. Move one panel.`:`'${p.id}' and '${b.id}' are ${n(d)} px apart.`);
    }
    for(const [i,g] of groups.entries()) {
        for(const p of panels) if(!g.members.includes(p.id) && separation(g,p)<0) c.report(`group '${g.label}' overlaps '${p.id}'`);
        for(const b of groups.slice(i+1)) if(separation(g,b)<0 && !contains(g,b) && !contains(b,g)) c.report(`groups '${g.label}' and '${b.label}' overlap`);
    }
    const links=route(c,s,panels,groups);
    const bounds=extent([...panels,...groups,...links.map(l=>l.bounds),...links.flatMap(l=>l.labelBox?[l.labelBox]:[])]);
    const plan=header(c,s,bounds.w), top=t.margin+plan.h+32, width=Math.ceil(plan.width),height=Math.ceil(top+bounds.h+t.margin);
    const dx=t.margin-bounds.x+Math.max(0,plan.width-2*t.margin-bounds.w)/2,dy=top-bounds.y;
    plan.draw();
    c.parts.push(`<g transform="translate(${n(dx)} ${n(dy)})">`);
    for(const g of groups) c.rect(g.x,g.y,g.w,g.h,t.group_fill,t.group_stroke,1.1,t.radius+4,"dashed");
    for(const l of links) {
        const dotted=l.kind==="planned";
        c.parts.push(`<g data-from="${escape(l.a.id)}" data-to="${escape(l.b.id)}" data-kind="${escape(l.kind)}">`);
        c.path(l.path,"none",t.line,dotted?1.6:1.3,dotted?"dotted":null);c.path(arrow(l.tip,l.direction),t.line);
        c.parts.push("</g>");
    }
    for(const g of groups) {
        const b=g.titleBox;
        c.rect(b.x,b.y,b.w,b.h,t.group_fill,"",1,3);
        c.text(g.label,g.x+14,g.y+12+cap(c,12.5,"semibold"),12.5,"semibold");
        if(g.sub) c.text(g.sub,g.x+14,g.y+12+t.line_h+cap(c,t.small),t.small,"regular",t.muted);
    }
    for(const p of panels) {
        c.parts.push(`<g data-panel="${escape(p.id)}">`);
        p.block.draw(p.x,p.y,p.w,p.h);
        c.parts.push("</g>");
    }
    for(const l of links) if(l.labelBox) {
        const b=l.labelBox;c.rect(b.x,b.y,b.w,b.h,t.paper,t.line,.8,9);c.centered(l.label,b.x+b.w/2,b.y+9,t.small,"medium");
    }
    c.parts.push("</g>");
    if(c.minText<t.min_text) c.report(`smallest text is ${c.minText} px. The theme minimum is ${t.min_text} px.`);
    const description=describe(s,panels);
    const svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img"><title>${escape(s.title)}</title><desc>${escape(description)}</desc><rect width="${width}" height="${height}" fill="${t.paper}"/>${c.parts.join("")}</svg>\n`;
    const box=(b:Box)=>({x:b.x+dx,y:b.y+dy,w:b.w,h:b.h});
    const panelIds=reviewIds(panels.map(p=>p.id),"panel");
    const groupIds=reviewIds(groups.map(g=>g.id??g.label),"group");
    const parts:DiagramPart[]=[
        ...groups.map(g=>({kind:"group" as const,id:groupIds.get(g.id??g.label)!,title:g.label,summary:g.sub,refs:g.refs?.map(ref=>({...ref}))??[],...box(g)})),
        ...panels.map(p=>({kind:"panel" as const,id:panelIds.get(p.id)!,title:p.panel.title,summary:p.panel.sub,refs:p.panel.refs?.map(ref=>({...ref}))??[],...box(p)})),
        ...c.sections.map(section=>({...section,...box(section)})),
    ];
    const used=new Set(s.links?.flatMap(link=>link.id === undefined ? [] : [link.id]));
    const occurrences=new Map<string,number>();
    for (const [index,link] of links.entries()) {
        const authored=s.links![index];
        const pair=JSON.stringify([link.a.id,link.b.id]);
        let id=authored.id;
        if (id === undefined) {
            let ordinal=occurrences.get(pair)??0;
            do { id=pair+"#"+(++ordinal); } while (used.has(id));
            occurrences.set(pair,ordinal);
        }
        const hitBoxes=[link.bounds,...arrowVertices(link.tip,link.direction).map(([x,y])=>({x,y,w:0,h:0}))];
        if (link.labelBox) hitBoxes.push(link.labelBox);
        parts.push({kind:"link",id,title:link.label || link.a.panel.title+" → "+link.b.panel.title,
            refs:authored.refs?.map(ref=>({...ref}))??[],from:panelIds.get(link.a.id)!,to:panelIds.get(link.b.id)!,...box(extent(hitBoxes)),
            labelBox:link.labelBox && box(link.labelBox),
            points:link.samples.concat([link.tip]).map(([x,y]):Point=>[x+dx,y+dy])});
    }
    return {svg,width,height,parts,minText:Number.isFinite(c.minText)?c.minText:null,description,problems:c.getProblems(),
        panels:panels.map(p=>({id:p.id,title:p.panel.title,x:p.x+dx,y:p.y+dy,w:p.w,h:p.h})),
        links:links.map(l=>({from:l.a.id,to:l.b.id,label:l.label,kind:l.kind,start:l.start,end:l.end}))};
}

const availableFonts = {...fonts};
const extendedWeights = new Set<Weight>();
const loadFace={
    regular:()=>import("./regular-face.js"), medium:()=>import("./medium-face.js"),
    semibold:()=>import("./semibold-face.js"), bold:()=>import("./bold-face.js")
};
export type DiagramRenderResult = ReturnType<typeof build>;

/** Render the measured diagram, loading additional Inter outlines only when needed. */
export async function renderDiagram(spec: DiagramSpec): Promise<DiagramRenderResult> {
    for (;;) {
        try {
            return build(spec, availableFonts, extendedWeights);
        } catch (error) {
            if (!(error instanceof ExtraFontRequired)) throw error;
            const weight = error.weight;
            availableFonts[weight] = (await loadFace[weight]()).face;
            extendedWeights.add(weight);
        }
    }
}
