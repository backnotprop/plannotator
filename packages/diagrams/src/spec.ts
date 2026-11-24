import {defaults} from "./assets.js";
import type {DiagramSpec,Panel,Section,Theme,Tile} from "./model.js";

const MAX_ADDRESSABLE_PARTS = 512;
const MAX_LABELLED_LINKS = 128;
const MAX_GRAPH_ELEMENTS = 512;

export type PreparedPanel = Panel & {sourcePath: string};

type Check=(value:unknown,path:string)=>void;
type Dict=Record<string,unknown>;
const fail=(path:string,why:string):never=>{throw new TypeError(path+": "+why);};
function object(v:unknown,p:string):Dict {
    if (!v || typeof v!=="object" || Array.isArray(v)) fail(p,"expected an object");
    return v as Dict;
}
const own=(v:object,k:string)=>Object.prototype.hasOwnProperty.call(v,k);
const string:Check=(v,p)=>{if(typeof v!=="string" || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff\ufffe\uffff]/u.test(v)) fail(p,"expected text suitable for SVG");};
const num:Check=(v,p)=>{if(typeof v!=="number" || !Number.isFinite(v) || Math.abs(v)>1_000_000) fail(p,"expected a finite coordinate within one million pixels");};
const positive:Check=(v,p)=>{num(v,p); if ((v as number)<=0) fail(p,"expected a positive number");};
const count:Check=(v,p)=>{positive(v,p);if (!Number.isInteger(v)) fail(p,"expected a whole number");};
const bool:Check=(v,p)=>{if(typeof v!=="boolean") fail(p,"expected a boolean");};
const one=(...choices:string[]):Check=>(v,p)=>{if (!choices.includes(v as string)) fail(p,"expected "+choices.join(" or "));};
const color:Check=(v,p)=>{if (typeof v!=="string" || !/^#[0-9a-f]{6}$/i.test(v)) fail(p,"expected a six-digit hex color");};
const list=(item:Check,min=0):Check=>(v,p)=>{
    if (!Array.isArray(v) || v.length<min) return fail(p,"expected an array with at least "+min+" items");
    v.forEach((x,i)=>item(x,`${p}[${i}]`));
};
const tuple=(...items:Check[]):Check=>(v,p)=>{
    if(!Array.isArray(v) || v.length!==items.length) return fail(p,"expected "+items.length+" entries");
    items.forEach((f,i)=>f(v[i],`${p}[${i}]`));
};
function fields(schema:Record<string,Check>,required:string[]=[]):Check {
    return (v,p)=>{
        const obj=object(v,p);
        for (const k of required) if(!own(obj,k) || obj[k]===undefined) fail(p,"missing "+k);
        for (const [k,value] of Object.entries(obj)) {
            if (!own(schema,k)) fail(p,"unknown key "+k);
            if (value===undefined) continue;
            schema[k](value,p+"."+k);
        }
    };
}
const map=(check:Check):Check=>(v,p)=>{
    for(const [k,value] of Object.entries(object(v,p))) check(value,p+"."+k);
};
const id:Check=(v,p)=>{
    string(v,p);
    if (!(v as string).trim()) fail(p,"expected a nonempty ID");
};
const webUrl:Check=(v,p)=>{
    string(v,p);
    if (typeof v !== "string" || !/^https?:\/\/[^\s/\\]+(?:[/?#][^\s\\]*)?$/i.test(v))
        fail(p,"expected an HTTP or HTTPS URL");
};
const reference:Check=(v,p)=>{
    const ref=object(v,p);
    if (ref.kind === "file") {
        fields({kind:one("file"),title:string,path:string,start:count,end:count,url:webUrl},["kind","title","path"])(v,p);
        const path=ref.path as string;
        if (!path || /^(?:[a-z]:|[/\\])/i.test(path) || path.split(/[/\\]/).includes(".."))
            fail(p+".path","expected a project-relative path");
        if (ref.end !== undefined && (ref.start === undefined || Number(ref.end)<Number(ref.start)))
            fail(p+".end","expected a range starting at start");
    } else {
        fields({kind:one("link"),title:string,url:webUrl},["kind","title","url"])(v,p);
    }
};
const refs=list(reference);
const tile:Check=(v,p)=>typeof v==="string"?string(v,p):fields({label:string,sub:string,status:string},["label"])(v,p);
const tiles={tiles:list(tile,1),cols:count,label:string};
const imageSource: Check = (value, path) => {
    const error = "expected an embedded PNG or JPEG (base64 data URL)";
    if (typeof value !== "string") return fail(path, error);
    const comma = value.indexOf(",");
    const header = value.slice(0, comma);
    const png = header === "data:image/png;base64";
    if (!png && header !== "data:image/jpeg;base64") fail(path, error);
    const data = value.slice(comma + 1);
    // Check the PNG signature and IHDR, or the JPEG start marker, before emitting the URI.
    if (data.length < 48 || data.length % 4 || !data.startsWith(png ? "iVBORw0KGgoAAAANSUhEU" : "/9j/") ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) fail(path, error);
};
const image = fields({src: imageSource, alt: string, width: positive, height: positive},
    ["src", "alt", "width", "height"]);
const graph:Check=(v,p)=>{
    const g=object(v,p);
    fields({nodes:map(string),at:map(tuple(num,num)),links:list((edge,path)=>{
        if (Array.isArray(edge) && edge.length===3) tuple(string,string,string)(edge,path);
        else tuple(string,string)(edge,path);
    })},["nodes","links","at"])(v,p);
    const nodes=g.nodes as Dict, at=g.at as Dict;
    if (!Object.keys(nodes).length) fail(p+".nodes","expected at least one node");
    for(const id of Object.keys(nodes)) if(!own(at,id)) fail(p+".at","missing "+id);
    for(const id of Object.keys(at)) if(!own(nodes,id)) fail(p+".at","unknown node "+id);
    (g.links as string[][]).forEach(([a,b],i)=>{
        for (const id of [a,b]) if(!own(nodes,id)) fail(`${p}.links[${i}]`,"unknown node "+id);
        if(a===b) fail(`${p}.links[${i}]`,"inner graph self-loops require a separate panel and a return lane");
    });
};
const section:Check=(v,p)=>{
    if(typeof v==="string") return string(v,p);
    if(Array.isArray(v)) return list(tile,1)(v,p);
    const obj=object(v,p);
    if(own(obj,"content")) return fields({id,title:string,refs,content:section},["id","title","content"])(v,p);
    if(own(obj,"tiles")) return fields(tiles,["tiles"])(v,p);
    const schema={text:string,row:list(section,1),card:fields({title:string,rows:list(tuple(string,string)),intro:string},["title","rows"]),graph,image};
    const keys=Object.keys(obj);
    if(keys.length!==1) fail(p,"expected one section type");
    fields(schema,keys)(v,p);
};
const panel=fields({id,refs,title:string,sub:string,footer:string,status:string,step:count,tone:string,width:positive,
    x:num,y:num,...tiles,sections:list(section)},["title"]);
const side=one("left","right","top","bottom","auto");
const link=fields({id,refs,from:string,to:string,kind:string,label:string,lane:one("top","bottom"),via_x:num,via_y:num,
    cross_ok:bool,start:side,end:side},["from","to"]);
const theme:Check=(v,p)=>{
    const schema:Record<string,Check>={};
    for (const [k,x] of Object.entries(defaults)) schema[k]=typeof x==="number"?(val,path)=>{
        num(val,path); if ((val as number)<0) fail(path,"expected a nonnegative measurement");
    }:color;
    for (const k of ["badge_text","badge_fill"]) schema[k]=(v,p)=>{if(v!==null) color(v,p);};
    schema.tones=map(color);
    schema.statuses=map(fields({label:string,stroke:color,fill:color,dash:(v,p)=>{if(v!==null) one("dotted","dashed")(v,p);}},["label","stroke","fill"]));
    schema.link_labels=map(string);
    fields(schema)(v,p);
};
const diagram=fields({id,title:string,subtitle:string,tag:string,legend:bool,note:fields({title:string,lines:list(string)},["title"]),
    steps:list(tuple(count,string)),steps_label:string,gap:num,row_gap:num,valign:one("top","center","bottom"),start_angle:num,
    columns:list((v,p)=>Array.isArray(v)?list(panel,1)(v,p):panel(v,p),1),ring:list(panel,2),center:list(panel),panels:list(panel,1),
    groups:list(fields({id,refs,label:string,members:list(string,1),sub:string},["label","members"])),links:list(link),theme,statuses:map(string)},["title"]);

export function prepare(s:DiagramSpec) {
    diagram(s,"diagram");
    if ([s.columns,s.panels,s.ring].filter(Boolean).length!==1) fail("diagram","give exactly one layout");
    if(s.center && !s.ring) fail("center","requires a ring");
    const settings=Object.fromEntries(Object.entries(s.theme??{}).filter(([,v])=>v!==undefined));
    const t:Theme={...defaults,...settings,tones:{...defaults.tones,...s.theme?.tones},
        statuses:{...defaults.statuses,...s.theme?.statuses},
        link_labels:{...defaults.link_labels,...s.theme?.link_labels}};
    let parts = 0, labelledLinks = 0;
    function addPart(path: string) {
        if (++parts > MAX_ADDRESSABLE_PARTS)
            fail(path, `a diagram supports at most ${MAX_ADDRESSABLE_PARTS} addressable parts (panels, named sections, groups and links)`);
    }
    function addLabel(path: string) {
        if (++labelledLinks > MAX_LABELLED_LINKS)
            fail(path, `a diagram supports at most ${MAX_LABELLED_LINKS} labelled links, including mini-graph links`);
    }
    let graphElements = 0;
    function countGraphElements(count: number, path: string) {
        graphElements += count;
        if (graphElements > MAX_GRAPH_ELEMENTS)
            fail(path, `a diagram supports at most ${MAX_GRAPH_ELEMENTS} mini-graph nodes and links combined`);
    }
    const sectionIds=new Set<string>();
    const ids=new Set<string>(), found=new Set<string>();
    const overrides=new Map(Object.entries(s.statuses??{}));
    for (const [k,status] of overrides) if(!own(t.statuses,status)) fail("statuses."+k,"unknown status "+status);
    function state(names:string[],initial:string|undefined,path:string) {
        let status=initial;
        for(const name of names) if(overrides.has(name)) {
            found.add(name); status=overrides.get(name); if(status==="live") status=undefined;
        }
        if(status!==undefined && !own(t.statuses,status)) fail(path,"unknown status "+status);
        return status;
    }
    function tileState(v:Tile,p:string):Tile {
        const obj=typeof v==="string"?{label:v}:v;
        return {...obj,status:state([obj.label],obj.status,p+".status")};
    }
    function sectionState(v:Section,p:string):Section {
        if(Array.isArray(v)) return v.map((x,i)=>tileState(x,`${p}[${i}]`));
        if(typeof v==="string") return v;
        if("content" in v) {
            addPart(p);
            if (sectionIds.has(v.id)) fail(p+".id","duplicate section id "+v.id);
            sectionIds.add(v.id);
            return {...v,content:sectionState(v.content,p+".content")};
        }
        if ("graph" in v) {
            countGraphElements(Object.keys(v.graph.nodes).length, p+".graph.nodes");
            countGraphElements(v.graph.links.length, p+".graph.links");
            v.graph.links.forEach((edge,i) => { if (edge[2]) addLabel(`${p}.graph.links[${i}][2]`); });
        }
        if("row" in v) return {row:v.row.map((x,i)=>sectionState(x,`${p}.row[${i}]`))};
        if("tiles" in v) return {...v,tiles:v.tiles.map((x,i)=>tileState(x,`${p}.tiles[${i}]`))};
        return v;
    }
    const normalize=(v:Panel,p:string,sourcePath=p):PreparedPanel=>{
        addPart(sourcePath);
        const id=v.id??v.title;
        if(ids.has(id)) fail(p+".id","duplicate panel id "+id);
        ids.add(id);
        if(s.panels?(v.x===undefined||v.y===undefined):(v.x!==undefined||v.y!==undefined)) fail(p,"explicit x and y belong together in panels");
        if(v.tone!==undefined && !own(t.tones,v.tone)) color(v.tone,p+".tone");
        if (!v.tiles && (v.cols!==undefined || v.label!==undefined)) fail(p,"cols and label require tiles");
        return {...v,id,sourcePath,status:state([v.title,id],v.status,p+".status"),
            tiles:v.tiles?.map((x,i)=>tileState(x,`${p}.tiles[${i}]`)),sections:v.sections?.map((x,i)=>sectionState(x,`${sourcePath}.sections[${i}]`))};
    };
    const columns=s.columns?.map((col,i)=>{
        const path = `columns[${i}]`;
        // Panel diagnostics historically use the normalized row index, including shorthand columns.
        return Array.isArray(col) ? col.map((p,j)=>normalize(p,`${path}[${j}]`)) : [normalize(col,path+"[0]",path)];
    });
    const ring=s.ring?.map((p,i)=>normalize(p,`ring[${i}]`)),center=s.center?.map((p,i)=>normalize(p,`center[${i}]`));
    const panels=s.panels?.map((p,i)=>normalize(p,`panels[${i}]`));
    for(const k of overrides.keys()) if(!found.has(k)) fail("statuses."+k,"no tile or panel with this name");
    const checkId=(id:string,p:string)=>{if(!ids.has(id)) fail(p,"unknown panel "+id);};
    const linkIds=new Set<string>();
    s.links?.forEach((l,i)=>{
        const p=`links[${i}]`;
        addPart(p);
        if (l.label) addLabel(p+".label");
        if (l.id !== undefined) {
            if (linkIds.has(l.id)) fail(p+".id","duplicate link id "+l.id);
            linkIds.add(l.id);
        }
        checkId(l.from,p+".from"); checkId(l.to,p+".to");
        if(!own(t.link_labels,l.kind??"flow")) fail(p+".kind","unknown link kind");
        if([l.lane,l.via_x,l.via_y].filter(x=>x!==undefined).length>1) fail(p,"give one lane or waypoint");
    });
    const groupIds=new Set<string>();
    s.groups?.forEach((group,i)=>{
        addPart(`groups[${i}]`);
        const id=group.id ?? group.label;
        if (groupIds.has(id)) fail(`groups[${i}].id`,"duplicate group id "+id);
        groupIds.add(id);
        group.members.forEach(member=>checkId(member,`groups[${i}].members`));
    });
    return {t,columns,ring,center,panels};
}
