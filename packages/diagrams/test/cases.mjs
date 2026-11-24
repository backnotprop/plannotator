import {readFileSync} from "node:fs";

const json=path=>JSON.parse(readFileSync(new URL(path,import.meta.url),"utf8"));
export const gold={
    catalogue:json("./fixtures/atlas.json"),
    email:json("./fixtures/email_delivery.json"),
    cycle:json("./fixtures/release_cycle.json"),
    layers:json("./fixtures/layers.json"),
    systems:json("./fixtures/systems.json"),
    cutover:json("./fixtures/cutover.json"),
};

export function mesh(n) {
    const panels=[],links=[];
    for(let row=0;row<n;row++) for(let col=0;col<n;col++) {
        const id=`r${row}c${col}`;
        panels.push({id,title:`Region ${row+1} / shard ${col+1}`,tiles:["Index","Checkpoint"],x:col*310,y:row*200});
        if(col) links.push({from:`r${row}c${col-1}`,to:id,label:"publish"});
        if(row) links.push({from:`r${row-1}c${col}`,to:id,label:"replicate",kind:"planned"});
    }
    return {title:"Regional indexing mesh",panels,links};
}

function random(seed) {
    seed=Math.imul(seed^0x9e3779b9,2654435761)>>>0;
    return ()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
}
export function variant(seed) {
    const rand=random(seed);
    const pick=a=>a[Math.floor(rand()*a.length)];
    const words=["Receipt","Quorum","A/B & <review>","AVAILABILITY","Audit trail","Verify all replicas before making the new index public",
        "Révision Łódź","Έλεγχος","Журнал"];
    const size=2+Math.floor(rand()*6);
    const panels=Array.from({length:size},(_,i)=>({id:"p"+i,title:pick(words)+" "+i,
        sub:rand()<.5?"Reconcile revision "+i:undefined,tone:pick(["default","dark","accent"]),step:i+1,
        footer:rand()<.5?"Owner: Release operators":undefined,
        sections:[{tiles:Array.from({length:1+Math.floor(rand()*5)},()=>({label:pick(words),sub:rand()<.45?pick(words):undefined,
            status:pick(["planned","building","live","trial"])})),cols:1+Math.floor(rand()*3)}]}));
    const links=panels.slice(1).map((p,i)=>({from:panels[i].id,to:p.id,kind:pick(["flow","planned"]),label:pick(["send","review","store"])}));
    const spec={title:"Publish revision "+seed,theme:{lid:pick([0,6,9]),depth:pick([0,2,4])},links};
    if (seed % 4 === 0) {
        spec.title+=" · Ω";
        spec.subtitle="Δοκιμή";
        links[0].label="Łódź";
    }
    if(seed%3===0) return {...spec,ring:panels,center:[{title:"Approvals",tiles:["Quorum"]}],gap:90};
    if(seed%3===1) return {...spec,columns:panels,gap:100,valign:pick(["top","center","bottom"]),groups:[{label:"Intake",members:["p0"]}],
        links:[...links,{from:panels.at(-1).id,to:"p0",lane:"bottom",label:"revise"}]};
    return {...spec,panels:panels.map((p,i)=>({...p,x:(i%3)*650-40,y:Math.floor(i/3)*420})),
        links:links.map(l=>({...l,start:"auto",end:"auto"}))};
}
