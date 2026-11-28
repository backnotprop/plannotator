(function(){
  var root=document.documentElement,frame=document.querySelector(".frame"),art=document.querySelector(".art"),h1=document.querySelector("h1");
  var pairs=[["v","mark.v",".main.plan .hit"],["a","mark.a",".main.call .hit"],["g","mark.g",".main.mock .hit"]];
  function draw(){
    var w=root.clientWidth,wide=!matchMedia("(max-width:1180px)").matches,z=wide&&w<1440?w/1440:1;
    frame.style.zoom=z===1?"":z;
    frame.style.height=z===1?"":Math.max(860,Math.min(1000,root.clientHeight/z))+"px";
    if(!wide)return;
    var o=art.getBoundingClientRect(),k=o.width/1440||1;
    pairs.forEach(function(p){
      var b=h1.querySelector(p[1]).getBoundingClientRect(),t=art.querySelector(p[2]).getBoundingClientRect();
      var n=[b.right-o.left,b.top-o.top,b.bottom-o.top,t.left-o.left,t.top-o.top,t.bottom-o.top].map(function(v){return Math.round(v/k*10)/10});
      art.querySelector(".beams ."+p[0]).setAttribute("points",[n[0],n[1],n[3],n[4],n[3],n[5],n[0],n[2],n[0]-6,n[2],n[0]-6,n[1]].join(" "));
    });
  }
  draw();
  if(document.fonts&&document.fonts.ready)document.fonts.ready.then(draw);
  addEventListener("resize",draw);
})();
(function(){
  var root=document.documentElement;
  function $(s,p){return [].slice.call((p||document).querySelectorAll(s))}
  function lay(){
    var w=root.clientWidth,narrow=matchMedia("(max-width:1180px)").matches,z=!narrow&&w<1440?w/1440:1;
    $(".pg,.nav,.ft").forEach(function(e){e.style.zoom=z===1?"":z});
    $(".pg .rw").forEach(function(e){
      e.style.minHeight="";
      if(narrow)e.style.minHeight=Math.ceil((e.getBoundingClientRect().height-.5)/50)*50+"px";
    });
    var field=document.querySelector(".fanf"),box=document.querySelector(".fanbox"),cards=$(".shf-card",box);
    box.style.removeProperty("--fh");field.style.height="";box.style.top="";
    if(!narrow){
      var tall=0;
      cards.forEach(function(c){var f=c.firstElementChild;c.style.height=f.style.height="auto";tall=Math.max(tall,f.offsetHeight);c.style.height=f.style.height=""});
      box.style.setProperty("--fh",tall+"px");
      var f0=field.getBoundingClientRect(),lo=1e9,hi=-1e9;
      cards.forEach(function(c){var r=c.getBoundingClientRect();lo=Math.min(lo,(r.top-f0.top)/z);hi=Math.max(hi,(r.bottom-f0.top)/z)});
      var h=Math.ceil((hi-lo+100)/50)*50;
      field.style.height=h+200+"px";
      box.style.top=430+(h-(hi-lo))/2-lo+"px";
    }
    $(".dev").forEach(function(sec){
      var tile=sec.querySelector(".tl"),poly=sec.querySelector(".wg polygon");
      tile.style.top="";poly.setAttribute("points","");
      if(narrow||getComputedStyle(tile).display==="none")return;
      function loc(e){var s=sec.getBoundingClientRect(),r=e.getBoundingClientRect();return {l:(r.left-s.left)/z,t:(r.top-s.top)/z,r:(r.right-s.left)/z,b:(r.bottom-s.top)/z}}
      var cap=loc(sec.querySelector(".cap.wide")),b=tile.dataset.t.split(",").map(Number);
      var x0=cap.l+b[0],y0=cap.t+b[1],x1=cap.l+b[2],y1=cap.t+b[3],pts;
      if(tile.dataset.edge==="t"){var tr=loc(tile);pts=[tr.l,tr.b,tr.r,tr.b,x1,cap.t,x0,cap.t]}
      else{var top=Math.round(((y0+y1)/2-25)/50)*50,wb=loc(sec.querySelector(".words")).b;top=Math.max(top,Math.ceil((wb+25)/50)*50);tile.style.top=top+"px";var r=loc(tile).r;pts=[r,top,cap.l,y0,cap.l,y1,r,top+50]}
      poly.setAttribute("points",pts.map(function(v){return Math.round(v*10)/10}).join(" "));
    });
  }
  lay();addEventListener("resize",lay);
  if(document.fonts&&document.fonts.ready)document.fonts.ready.then(lay);
})();
(function(){
  var de=document.documentElement,c=de.classList;
  if(!c.contains("pfc")){c.add("pfr");return}
  function on(){
    if((window.scrollY||0)<=60)return;
    removeEventListener("scroll",on);
    var calm=matchMedia("(prefers-reduced-motion: reduce)").matches,logos=[].slice.call(document.querySelectorAll(".pf-s .pf-logo"));
    var tags=[].slice.call(document.querySelectorAll(".pf-s .pf-chip,.pf-at")),twas=tags.map(function(l){return l.getBoundingClientRect()});
    var was=logos.map(function(l){return l.getBoundingClientRect()}),z=parseFloat(getComputedStyle(document.querySelector(".pg")).zoom)||1;
    c.remove("pfc");c.add("pfo");c.add("pfr");
    if(calm||!logos[0].animate)return;
    logos.forEach(function(l,i){var b=l.getBoundingClientRect();l.animate([{transform:"translate("+(was[i].left-b.left)/z+"px,"+(was[i].top-b.top)/z+"px)"},{transform:"none"}],{duration:500,easing:"cubic-bezier(.23,1,.32,1)"})});
    tags.forEach(function(l,i){var b=l.getBoundingClientRect(),t="translate("+(twas[i].left-b.left)/z+"px,"+(twas[i].top-b.top)/z+"px)";l.animate([{transform:t,opacity:1},{transform:t,opacity:0}],{duration:200,easing:"ease"})});
  }
  addEventListener("scroll",on,{passive:true});on();
})();
(function(){
  if(!("IntersectionObserver" in window)||matchMedia("(prefers-reduced-motion: reduce)").matches)return;
  var io=new IntersectionObserver(function(es){
    es.forEach(function(e){
      var s=e.target,c=s.classList,vh=e.rootBounds?e.rootBounds.height:innerHeight;
      if(!s.dataset.met){
        s.dataset.met="1";
        if(!e.isIntersecting&&e.boundingClientRect.top>=vh){c.add("wait");return}
        io.unobserve(s);return;
      }
      if(c.contains("wait")&&e.isIntersecting&&(e.intersectionRatio>=.35||e.intersectionRect.height>=.6*vh)){c.remove("wait");c.add("go");io.unobserve(s)}
    });
  },{threshold:[0,.1,.2,.3,.35,.5]});
  [].slice.call(document.querySelectorAll(".pg .dev")).forEach(function(s){io.observe(s)});
  document.addEventListener("animationend",function(e){if(e.animationName==="wg-reveal"||e.animationName==="wg-reveal-d"){var s=e.target.closest(".dev");if(s)s.classList.add("done")}});
})();

(function(){
  if(!("IntersectionObserver" in window)||matchMedia("(prefers-reduced-motion: reduce)").matches)return;
  var io=new IntersectionObserver(function(es){
    es.forEach(function(e){
      var s=e.target,c=s.classList,vh=e.rootBounds?e.rootBounds.height:innerHeight;
      if(!s.dataset.met){
        s.dataset.met="1";
        if(!e.isIntersecting&&e.boundingClientRect.top>=vh){c.add("wait");return}
        io.unobserve(s);return;
      }
      if(c.contains("wait")&&e.isIntersecting&&e.intersectionRatio>=.85){c.remove("wait");c.add("go");io.unobserve(s)}
    });
  },{threshold:[0,.5,.85,1]});
  [].slice.call(document.querySelectorAll(".pg .gm")).forEach(function(s){io.observe(s)});
  document.addEventListener("animationend",function(e){if(e.animationName==="wg-reveal-u"){var s=e.target.closest(".gm");if(s)s.classList.add("done")}});
})();
(function(){var t=document.querySelector(".pf-track");if(!t)return;document.addEventListener("pointerdown",function(e){if(e.pointerType==="mouse")return;t.classList.toggle("hold",t.contains(e.target))},{passive:true})})();
