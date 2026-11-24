import type {DiagramSpec, Placed, Section, Tile} from "./model.js";

function tile(v:Tile) {
    if(typeof v==="string") return v;
    return v.label+(v.sub?" — "+v.sub:"")+(v.status?" ("+v.status+")":"");
}
function section(v:Section):string[] {
    if(typeof v==="string") return [v];
    if(Array.isArray(v)) return [v.map(tile).join(", ")];
    if("content" in v) return section(v.content);
    if("tiles" in v) return [(v.label?v.label+": ":"")+v.tiles.map(tile).join(", ")];
    if("text" in v) return [v.text];
    if("image" in v) return [v.image.alt];
    if("row" in v) return v.row.flatMap(section);
    if("card" in v) return [v.card.title,v.card.intro||"",...v.card.rows.map(([k,x])=>k+": "+x)];
    const g=v.graph;
    return [Object.values(g.nodes).join(", "),...g.links.map(([a,b,label])=>
        g.nodes[a]+" -> "+g.nodes[b]+(label?' labeled "'+label+'"':""))];
}
export function describe(s:DiagramSpec,panels:Placed[]) {
    const titles=new Map(panels.map(p=>[p.id,p.panel.title]));
    const lines=[s.title,s.subtitle,s.note?.title,...s.note?.lines??[]];
    for(const {panel:p} of panels) {
        const meta=[p.step!==undefined?"step "+p.step:"",p.status].filter(Boolean).join(", ");
        lines.push(p.title+(meta?" ["+meta+"]":""),p.sub);
        if (p.tiles) lines.push((p.label?p.label+": ":"")+p.tiles.map(tile).join(", "));
        for(const v of p.sections??[]) lines.push(...section(v));
        lines.push(p.footer);
    }
    for(const g of s.groups??[]) lines.push(g.label+" contains "+g.members.map(id=>titles.get(id)).join(", "),g.sub);
    for(const l of s.links??[]) lines.push(titles.get(l.from)+" -> "+titles.get(l.to)+(l.label?' labeled "'+l.label+'"':"")+" ("+(l.kind??"flow")+")");
    for(const [step,label] of s.steps??[]) lines.push("Step "+step+": "+label);
    return lines.filter(Boolean).join("\n");
}
