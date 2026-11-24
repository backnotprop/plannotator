import type {Block, Box, Graph, Panel, Point, Section, Tile, Tiles} from "./model.js";
import {extent, separation} from "./model.js";
import {Painter, cap, n, shade, lightness} from "./paint.js";

function tile(c: Painter, value: Tile): Block {
    const t = c.t, p = typeof value === "string" ? {label:value} : value;
    const st = p.status ? t.statuses[p.status] : undefined;
    c.states.add(p.status || "live");
    const main = c.wrap(p.label,t.tile,t.tile_max_w-2*t.pad,"semibold");
    const sub = p.sub ? c.wrap(p.sub,t.tile_sub,t.tile_max_w-2*t.pad) : [];
    const span = (main.length-1)*t.line_h + sub.length*(t.line_h-1.5);
    return {
        w: Math.max(c.widest(main,t.tile,"semibold"),c.widest(sub,t.tile_sub))+2*t.pad+t.depth,
        h: t.tile_h+span+t.depth,
        draw(x,y,w,h) {
            const fill = st?.fill || t.tile_fill, stroke = st?.stroke || t.tile_stroke, d = t.depth;
            if (d) {
                c.path(`M${n(x)} ${n(y+d)}l${n(d)} ${n(-d)}h${n(w-d)}l${n(-d)} ${n(d)}Z`,shade(fill,.05),stroke,.8,st?.dash);
                c.path(`M${n(x+w-d)} ${n(y+d)}l${n(d)} ${n(-d)}v${n(h-d)}l${n(-d)} ${n(d)}Z`,shade(fill,.15),stroke,.8,st?.dash);
                y += d; w -= d; h -= d;
            }
            c.rect(x,y,w,h,fill,stroke,1.1,d?2:4,st?.dash);
            let cy = y+h/2-span/2;
            for (const line of main) { c.centered(line,x+w/2,cy,t.tile,"semibold"); cy += t.line_h; }
            cy -= 1.5;
            for (const line of sub) { c.centered(line,x+w/2,cy,t.tile_sub,"regular",t.muted); cy += t.line_h-1.5; }
        }
    };
}

function grid(c: Painter, s: Tiles): Block {
    const t = c.t, items = s.tiles.map(p=>tile(c,p));
    const cols = Math.min(s.cols ?? 3,items.length), rows = Math.ceil(items.length/cols);
    const cw = Math.max(...items.map(p=>p.w)), ch = Math.max(...items.map(p=>p.h));
    const labelH = s.label ? t.line_h+4 : 0, gap = t.tile_gap;
    return {w:Math.max(cols*cw+(cols-1)*gap,c.width(s.label || "",t.small,"semibold")),
        h:labelH+rows*ch+(rows-1)*gap,
        draw(x,y,w) {
            if (s.label) c.text(s.label,x,y+11,t.small,"semibold",t.muted);
            const cell = (w-(cols-1)*gap)/cols;
            for (let i=0;i<items.length;i++) {
                const row = Math.floor(i/cols), count = Math.min(cols,items.length-row*cols);
                const left = x+(w-count*cell-(count-1)*gap)/2;
                items[i].draw(left+i%cols*(cell+gap),y+labelH+row*(ch+gap),cell,ch);
            }
        }};
}

const MAX_GRAPH_GRID_PX = 8192;

function innerGraph(c: Painter, g: Graph, path: string): Block {
    function checkGridExtent(width: number, height: number) {
        if (width > MAX_GRAPH_GRID_PX || height > MAX_GRAPH_GRID_PX)
            throw new TypeError(`${path}: the mini-graph grid exceeds ${MAX_GRAPH_GRID_PX} pixels on an axis. Bring node positions closer or reduce the label or panel width.`);
    }
    const t = c.t, nodes = Object.entries(g.nodes).map(([id,label])=>{
        const [col,row] = g.at[id], w = c.width(label,t.body,"semibold")+26;
        return {id,label,x:col*132-w/2,y:row*58-13,w,h:26};
    });
    const bounds = extent(nodes);
    const width = bounds.w + 32, height = bounds.h + 32;
    checkGridExtent(width, height);
    return {w:width,h:height,draw(x,y,w,h) {
        // A containing column or row can stretch a grid beyond its measured width.
        checkGridExtent(w, h);
        c.rect(x,y,w,h,t.graph_fill,t.panel_stroke,.8,4);
        for (let gx=x+18;gx<x+w-1;gx+=18) c.line(gx,y+1,gx,y+h-1,t.graph_grid,.6);
        for (let gy=y+18;gy<y+h-1;gy+=18) c.line(x+1,gy,x+w-1,gy,t.graph_grid,.6);
        const boxes = nodes.map(p=>({...p,x:p.x+x+(w-bounds.w)/2-bounds.x,y:p.y+y+(h-bounds.h)/2-bounds.y}));
        const ids = new Map(boxes.map(p=>[p.id,p]));
        boxes.forEach((a,i)=>{
            for (const b of boxes.slice(i+1)) if (separation(a,b)<0)
                c.report(`graph: nodes '${a.label}' and '${b.label}' overlap. Increase their grid spacing.`);
        });
        function clip(a: Box,b: Box): Point {
            const ax = a.x+a.w/2, ay = a.y+a.h/2, dx = b.x+b.w/2-ax, dy = b.y+b.h/2-ay;
            const f = Math.min((a.w/2+2)/Math.abs(dx),(a.h/2+2)/Math.abs(dy));
            return Number.isFinite(f) ? [ax+dx*f,ay+dy*f] : [ax,ay];
        }
        const labels: (Box & {label:string})[] = [];
        for (const [from,to,label] of g.links) {
            const a = ids.get(from)!, b = ids.get(to)!, p = clip(a,b), q = clip(b,a);
            c.line(...p,...q,t.graph_line);
            for (const node of boxes) {
                if (node===a || node===b) continue;
                for (let i=1;i<40;i++) {
                    const px=p[0]+(q[0]-p[0])*i/40, py=p[1]+(q[1]-p[1])*i/40;
                    if (px>node.x+1 && px<node.x+node.w-1 && py>node.y+1 && py<node.y+node.h-1) {
                        c.report(`graph: the line '${a.label}' to '${b.label}' runs through '${node.label}'`);
                        break;
                    }
                }
            }
            if (label) {
                const lw=c.width(label,t.small)+12;
                labels.push({label,x:(p[0]+q[0]-lw)/2,y:(p[1]+q[1])/2-8,w:lw,h:16});
            }
        }
        boxes.forEach(p=>{c.rect(p.x,p.y,p.w,p.h,t.tile_fill,t.ink,1,13); c.centered(p.label,p.x+p.w/2,p.y+13,t.body,"semibold");});
        labels.forEach((p,i)=>{
            for (const other of [...boxes,...labels.slice(i+1)]) if (separation(p,other)<2)
                c.report(`graph: the label '${p.label}' touches '${other.label}'`);
            c.rect(p.x,p.y,p.w,p.h,t.paper,t.graph_line,.7,8);
            c.centered(p.label,p.x+p.w/2,p.y+8,t.small,"regular",t.muted);
        });
    }};
}

function section(c: Painter,s: Section,path: string): Block {
    const t = c.t;
    if (Array.isArray(s)) return grid(c,{tiles:s});
    if (typeof s==="string" || "text" in s) {
        const lines = c.wrap(typeof s==="string"?s:s.text,t.body,320);
        return {w:c.widest(lines,t.body),h:lines.length*t.line_h,draw(x,y) {
            lines.forEach((v,i)=>c.text(v,x,y+(i+.5)*t.line_h+cap(c,t.body)/2,t.body));
        }};
    }
    if ("content" in s) {
        const block = section(c,s.content,path+".content");
        return {...block, draw(x,y,w,h) {
            c.sections.push({kind:"section",id:s.id,title:s.title,refs:s.refs?.map(ref=>({...ref})) ?? [],x,y,w,h});
            block.draw(x,y,w,h);
        }};
    }
    if ("tiles" in s) return grid(c,s);
    if ("graph" in s) return innerGraph(c,s.graph,path+".graph");
    if ("image" in s) {
        const {width, height} = s.image;
        return {w:width, h:height, draw(x,y,w) {
            c.image(s.image, x+(w-width)/2, y);
        }};
    }
    if ("row" in s) {
        const items = s.row.map((v,i)=>section(c,v,`${path}.row[${i}]`)), gap = t.section_gap;
        const width = items.reduce((w,b)=>w+b.w,0)+(items.length-1)*gap;
        return {w:width,h:Math.max(...items.map(b=>b.h)),draw(x,y,w) {
            items.forEach((b,i)=>{ b.draw(x,y,b.w+(i===items.length-1?w-width:0),b.h); x+=b.w+gap; });
        }};
    }
    const {title,rows,intro} = s.card, keyW=c.widest(rows.map(r=>r[0]),t.body,"semibold");
    const room=380-2*t.pad, introLines=intro?c.wrap(intro,t.body,room):[];
    const values=rows.map(r=>c.wrap(r[1],t.body,room-keyW-14));
    return {w:2*t.pad+Math.max(c.width(title,t.tile,"semibold"),c.widest(introLines,t.body),
            keyW+14+c.widest(values.flat(),t.body)),
        h:2*t.pad+(1+introLines.length+values.flat().length)*t.line_h+(intro?4:0)+4,
        draw(x,y,w,h) {
            c.rect(x,y,w,h,t.tile_fill,t.panel_stroke,1,4);
            let base=y+t.pad+t.line_h/2+cap(c,t.body)/2;
            c.text(title,x+t.pad,base,t.tile,"semibold");
            base+=t.line_h;
            for (const line of introLines) { c.text(line,x+t.pad,base+2,t.body,"regular",t.muted); base+=t.line_h; }
            base+=intro?8:4;
            rows.forEach(([k],i)=>{
                c.text(k,x+t.pad,base,t.body,"semibold");
                for (const line of values[i]) { c.text(line,x+t.pad+keyW+14,base,t.body); base+=t.line_h; }
            });
        }};
}

export function panelBlock(c: Painter,p: Panel,path: string): Block {
    const t=c.t, blocks=(p.sections||[]).map((s,i)=>section(c,s,`${path}.sections[${i}]`));
    if (p.tiles) blocks.unshift(grid(c,{tiles:p.tiles,cols:p.cols,label:p.label}));
    const hh=p.sub?t.header_h_sub:t.header_h, badge=p.step===undefined?0:30, st=p.status?t.statuses[p.status]:undefined;
    if (p.status) c.states.add(p.status);
    const tag=st?c.width(st.label,t.small,"semibold")+16:0, footer=p.footer?p.footer.split("\n"):[];
    const fh=footer.length?14+footer.length*t.line_h:0;
    const width=Math.max(t.panel_min_w,p.width||0,2*t.pad+badge+c.width(p.title,t.panel_title,"semibold")+(st?12+tag:0),
        2*t.pad+badge+c.width(p.sub||"",t.panel_sub),2*t.pad+Math.max(0,...blocks.map(b=>b.w)),
        2*t.pad+4+c.widest(footer,t.small));
    return {w:width,h:t.lid+hh+(blocks.length?2*t.pad:t.pad)+blocks.reduce((h,b)=>h+b.h,0)+Math.max(0,blocks.length-1)*t.section_gap+fh,
        draw(x,y,w,h) {
            const tone=p.tone?.startsWith("#")?p.tone:t.tones[p.tone||"default"], lid=t.lid;
            if (lid) {
                const inset=Math.min(lid*.7,w/4);
                c.path(`M${n(x)} ${n(y+lid)}l${n(inset)} ${n(-lid)}h${n(w-2*inset)}l${n(inset)} ${n(lid)}Z`,shade(tone,.16),shade(tone,.32),.8);
                y+=lid; h-=lid;
            }
            c.rect(x,y,w,h,st?.fill||t.panel_fill,st?.stroke||t.panel_stroke,st?1.3:1,lid?2:t.radius,st?.dash);
            if (lid) c.rect(x,y,w,hh,tone);
            else {
                const r=t.radius;
                c.path(`M${n(x)} ${n(y+hh)}V${n(y+r)}Q${n(x)} ${n(y)} ${n(x+r)} ${n(y)}H${n(x+w-r)}Q${n(x+w)} ${n(y)} ${n(x+w)} ${n(y+r)}V${n(y+hh)}Z`,tone);
            }
            const lum=lightness(tone)+.05, dark=lum/(lightness(t.header_text)+.05)>=(lightness(t.header_text_on_dark)+.05)/lum;
            const cy=y+(p.sub?18:hh/2); let tx=x+t.pad;
            if (badge) {
                c.circle(tx+11,cy,10.5,t.badge_fill||t.paper);
                c.centered(String(p.step),tx+11,cy,11.5,"bold",t.badge_text||tone); tx+=badge;
            }
            c.text(p.title,tx,cy+cap(c,t.panel_title,"semibold")/2,t.panel_title,"semibold",dark?t.header_text:t.header_text_on_dark);
            if (p.sub) c.text(p.sub,tx,y+36+cap(c,t.panel_sub)/2,t.panel_sub,"regular",dark?t.header_sub:t.header_sub_on_dark);
            if (st) {
                c.rect(x+w-t.pad-tag,cy-9,tag,18,t.paper,"",1,9);
                c.centered(st.label,x+w-t.pad-tag/2,cy,t.small,"semibold",st.stroke);
            }
            let by=y+hh+t.pad;
            for (const b of blocks) { b.draw(x+t.pad,by,w-2*t.pad,b.h); by+=b.h+t.section_gap; }
            if (footer.length) {
                const fy=y+h-fh;
                c.line(x+t.pad,fy,x+w-t.pad,fy,t.panel_stroke,.8);
                footer.forEach((line,i)=>{
                    const base=fy+8+(i+.5)*t.line_h+cap(c,t.small)/2, idx=line.indexOf(":");
                    let fx=x+t.pad;
                    if (idx>=0 && idx<40) { fx+=c.text(line.slice(0,idx+1),fx,base,t.small,"semibold"); line=line.slice(idx+1); }
                    c.text(line,fx,base,t.small,"regular",t.muted);
                });
            }
        }};
}
