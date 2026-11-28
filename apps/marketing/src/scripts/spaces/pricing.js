// The Spaces pricing page (src/pages/workspaces/pricing.astro).
(function(){
  // Between 1181 and 1440 wide the page is the 1440 design scaled down, as on /workspaces/.
  var root=document.documentElement;
  function fit(){
    var w=root.clientWidth,z=!matchMedia("(max-width:1180px)").matches&&w<1440?w/1440:1;
    [].slice.call(document.querySelectorAll(".pp-pg,.nav,.ft")).forEach(function(e){e.style.zoom=z===1?"":z});
  }
  fit();addEventListener("resize",fit);
})();
(function(){
  // Monthly or Yearly: one radio group; the arrow keys move the choice. ?bill=year starts on Yearly.
  var choices=[].slice.call(document.querySelectorAll(".pp-sw [role=radio]")),cards=[].slice.call(document.querySelectorAll(".pp-card"));
  if(!choices.length)return;
  function pick(interval){
    choices.forEach(function(c){var on=c.dataset.interval===interval;c.setAttribute("aria-checked",on?"true":"false");c.tabIndex=on?0:-1});
    cards.forEach(function(card){
      var amount=card.dataset[interval+"Amount"],per=card.dataset[interval+"Per"];
      card.querySelector(".pp-said").textContent=per?amount+" "+per:amount;
      card.querySelector(".pp-price b").textContent=amount;
      var p=card.querySelector(".pp-per");if(p)p.textContent=per;
    });
  }
  choices.forEach(function(c,i){
    c.addEventListener("click",function(){pick(c.dataset.interval)});
    c.addEventListener("keydown",function(e){
      var step=e.key==="ArrowRight"||e.key==="ArrowDown"?1:e.key==="ArrowLeft"||e.key==="ArrowUp"?-1:0;
      if(!step)return;
      e.preventDefault();
      var next=choices[(i+step+choices.length)%choices.length];
      pick(next.dataset.interval);next.focus();
    });
  });
  if(new URLSearchParams(location.search).get("bill")==="year")pick("year");
})();
