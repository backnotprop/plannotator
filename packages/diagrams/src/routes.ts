import {extent,separation} from "./model.js";
import type {Box,DiagramSpec,Group,Placed,Point,Side} from "./model.js";
import {Painter,n} from "./paint.js";

const dirs: Record<Side,Point> = {left:[-1,0],right:[1,0],top:[0,-1],bottom:[0,1]};
const horizontal = (side: Side)=>side==="left" || side==="right";
const shift = (p: Point,d: Point,k: number): Point=>[p[0]+d[0]*k,p[1]+d[1]*k];
const distance = (a:Point,b:Point)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
const mix = (a: Point,b: Point,f:number): Point=>[a[0]+(b[0]-a[0])*f,a[1]+(b[1]-a[1])*f];
const xy = (p: Point)=>p.map(n).join(" ");
function facing(a: Box,b: Box): Side {
    if (Math.max(b.x-a.x-a.w,a.x-b.x-b.w)>=Math.max(b.y-a.y-a.h,a.y-b.y-b.h))
        return b.x+b.w/2>=a.x+a.w/2?"right":"left";
    return b.y+b.h/2>=a.y+a.h/2?"bottom":"top";
}
function anchor(p:Box,side:Side,off:number):Point {
    if (horizontal(side)) return [side==="left"?p.x:p.x+p.w,p.y+off];
    return [p.x+off,side==="top"?p.y:p.y+p.h];
}
export function arrowVertices(tip: Point, direction: Point): Point[] {
    const base=shift(tip,direction,-7);
    const normal:Point=[-direction[1],direction[0]];
    return [tip,shift(base,normal,3.6),shift(base,normal,-3.6)];
}
export function arrow(tip: Point,d: Point) {
    const [end,left,right]=arrowVertices(tip,d);
    return `M${xy(end)}L${xy(left)}L${xy(right)}Z`;
}
function orthogonal(raw: Point[]) {
    const points: Point[]=[];
    for (const p of raw) {
        const b=points[points.length-1],a=points[points.length-2];
        if (b && distance(b,p)<.01) continue;
        if (a) {
            const dx=b[0]-a[0],dy=b[1]-a[1],ex=p[0]-b[0],ey=p[1]-b[1];
            if (Math.abs(dx*ey-dy*ex)<.01 && dx*ex+dy*ey>=0) points.pop();
        }
        points.push(p);
    }
    const segments=points.slice(1).map((b,i)=>({a:points[i],b,len:distance(points[i],b)}));
    let path="M"+xy(points[0]);
    const samples:Point[]=[];
    for (const [i,s] of segments.entries()) {
        const next=segments[i+1];
        if (next) {
            const r=Math.min(10,s.len/2,next.len/2);
            path+="L"+xy(mix(s.b,s.a,r/s.len))+"Q"+xy(s.b)+" "+xy(mix(s.b,next.b,r/next.len));
        } else path+="L"+xy(s.b);
        // A straight segment can be checked geometrically. Limit sampling on unusually long author-specified lanes.
        const count=Math.max(1,Math.min(4096,Math.floor(s.len/5)));
        for (let j=0;j<count;j++) samples.push(mix(s.a,s.b,j/count));
    }
    samples.push(points[points.length-1]);
    const spots=segments.sort((a,b)=>b.len-a.len).slice(0,2).flatMap(s=>[.5,.35,.65,.2,.8].map(f=>mix(s.a,s.b,f)));
    return {path,samples,spots};
}

interface Edge {
    a:Placed; b:Placed; start:Side; end:Side; vx?:number; vy?:number; label:string; kind:string; cross:boolean; offsets:Point;
}
function shape(e: Edge) {
    const {a,b,start,end,vx,vy,offsets}=e, p=anchor(a,start,offsets[0]),tip=anchor(b,end,offsets[1]);
    const ds=dirs[start],dt=dirs[end],q=shift(tip,dt,7), direction:Point=[-dt[0],-dt[1]];
    function curve() {
        const k=Math.max(28,Math.abs(horizontal(start)?q[0]-p[0]:q[1]-p[1])/2);
        const u=shift(p,ds,k),v=shift(q,dt,k);
        const at=(f:number):Point=>{
            const g=1-f;
            return [0,1].map(i=>g**3*p[i]+3*g*g*f*u[i]+3*g*f*f*v[i]+f**3*q[i]) as Point;
        };
        return {path:"M"+xy(p)+"C"+[u,v,q].map(xy).join(" "),samples:Array.from({length:81},(_,i)=>at(i/80)),
            spots:[.5,.42,.58,.34,.66,.26,.74].map(at)};
    }
    function elbow() {
        const s=shift(p,ds,16),t=shift(q,dt,16);
        const mid:Point[]=vy!==undefined?[[s[0],vy],[t[0],vy]]:[[vx!,s[1]],[vx!,t[1]]];
        return orthogonal([p,s,...mid,t,q]);
    }
    const geometry=vx===undefined && vy===undefined?curve():elbow();
    const bounds=extent(geometry.samples.map(([x,y])=>({x,y,w:0,h:0})));
    return {...e,...geometry,bounds,p,tip,direction,labelBox:undefined as Box|undefined};
}
function pointInside([x,y]:Point,b:Box,pad:number) {
    return x>b.x-pad && x<b.x+b.w+pad && y>b.y-pad && y<b.y+b.h+pad;
}
export function route(c:Painter,s:DiagramSpec,panels:Placed[],groups:Group[]) {
    const ids=new Map(panels.map(p=>[p.id,p])),bounds=extent(panels), lanes={top:0,bottom:0};
    const edges:Edge[]=(s.links||[]).map(link=>{
        const a=ids.get(link.from)!, b=ids.get(link.to)!;
        const loop=a===b && !link.lane && link.via_x===undefined && link.via_y===undefined;
        const lane=link.lane || (loop?"top":undefined);
        const start=link.start??lane??(s.columns?"right":"auto"),end=link.end??lane??(s.columns?"left":"auto");
        const vy=lane?(lane==="top"?bounds.y-70-30*lanes.top++:bounds.y+bounds.h+44+30*lanes.bottom++):link.via_y;
        return {a,b,start:start==="auto"?facing(a,b):start,end:end==="auto"?facing(b,a):end,vx:link.via_x,vy,
            label:link.label||"",kind:link.kind||"flow",cross:link.cross_ok||false,offsets:[0,0]};
    });
    type End={edge:Edge;i:0|1;heading:number};
    const buckets=new Map<Placed,Map<Side,End[]>>();
    for (const e of edges) for (const i of [0,1] as const) {
        const [p,other,side]=i?[e.b,e.a,e.end] as const:[e.a,e.b,e.start] as const;
        const sides=buckets.get(p)??new Map<Side,End[]>(); buckets.set(p,sides);
        const items=sides.get(side)??[]; sides.set(side,items);
        items.push({edge:e,i,heading:horizontal(side)?(e.vy??other.y+other.h/2):(e.vx??other.x+other.w/2)});
    }
    for (const [p,sides] of buckets) for (const [side,items] of sides) {
        const [lo,hi]=horizontal(side)?[c.t.lid+p.head+8,p.h-10]:[18,p.w-18];
        const loop=items.length===2 && items[0].edge===items[1].edge;
        const step=loop ? Math.max(14,(hi-lo)*.75) : Math.min((hi-lo)/items.length,14);
        items.sort((a,b)=>a.heading-b.heading).forEach((end,i)=>{
            end.edge.offsets[end.i]=(lo+hi)/2+(i-(items.length-1)/2)*step;
        });
    }
    const lines=edges.map(shape);
    const obstacles=[...panels.map(p=>({box:p,name:"'"+p.id+"'"})),...groups.map(g=>({box:g.titleBox,name:"the title of group '"+g.label+"'"}))];
    const lineName=(l:Edge)=>`line '${l.a.id}' -> '${l.b.id}'`;
    for (const l of lines) {
        const name=lineName(l);
        if (l.vx===undefined && l.vy===undefined) {
            const vx=l.tip[0]-l.p[0],vy=l.tip[1]-l.p[1];
            if (vx*dirs[l.start][0]+vy*dirs[l.start][1]<1 || -vx*dirs[l.end][0]-vy*dirs[l.end][1]<1)
                c.report(name+" has a port facing away. Use auto sides or a return lane.");
        }
        if (!l.cross) for (const p of panels) {
            if (p!==l.a && p!==l.b && separation(l.bounds,p)<=0 && l.samples.some(pt=>pointInside(pt,p,-2)))
                c.report(`${name} crosses '${p.id}'. Move the panel or use a return lane.`);
        }
        if (!l.label) continue;
        const w=c.width(l.label,c.t.small,"medium")+14;
        const boxes=l.spots.map(([x,y])=>({x:x-w/2,y:y-9,w,h:18}));
        const coversBox=(box:Box)=>obstacles.some(o=>separation(o.box,box)<0);
        const hitsLine=(box:Box,other:typeof l)=>l!==other && separation(other.bounds,box)<2 &&
            other.samples.some(pt=>pointInside(pt,box,2));
        const box=boxes.find(b=>!coversBox(b) && !lines.some(other=>hitsLine(b,other)));
        l.labelBox=box||boxes[0];
        if (!box) {
            const covered=obstacles.filter(o=>separation(o.box,boxes[0])<0).map(o=>o.name);
            for (const other of lines) if (hitsLine(boxes[0],other)) covered.push(lineName(other));
            for (const part of covered)
                c.report(`the label '${l.label}' on ${name} sits on ${part}. Widen the gap or move the line.`);
        }
        obstacles.push({box:l.labelBox,name:"the label '"+l.label+"'"});
    }
    return lines;
}
