// The Spaces header (src/components/spaces/SpacesTopStrip.astro): the "Open source" drop-down
// at 760px and wider, and the phone menu under 760px. Crossing 760 closes whichever is open.
(function(){
  var header=document.querySelector("header.nav");
  if(!header)return;
  var wide=matchMedia("(min-width:760px)");

  // The drop-down. A click, Enter or Space toggles it; Arrow Down opens it on the first row and
  // Arrow Up on the last. Escape, a press outside the header, focus leaving it, or a scroll closes it.
  var dd=header.querySelector(".lk-dd"),trigger=dd&&dd.querySelector(".lk-t"),panel=dd&&dd.querySelector(".lk-p");
  function items(){return panel?[].slice.call(panel.querySelectorAll("[data-menu-item]")):[]}
  function ddOpen(){return !!trigger&&trigger.getAttribute("aria-expanded")==="true"}
  function ddShow(next,focus){
    if(!trigger)return;
    trigger.setAttribute("aria-expanded",next?"true":"false");
    panel.setAttribute("data-state",next?"open":"closed");
    if(next&&focus){var list=items();(focus==="last"?list[list.length-1]:list[0]).focus()}
  }
  function nextInHeader(){
    var all=[].slice.call(header.querySelectorAll("a[href],button:not([disabled]),summary"));
    for(var i=0;i<all.length;i++){
      var el=all[i];
      if(dd.contains(el)||!(dd.compareDocumentPosition(el)&Node.DOCUMENT_POSITION_FOLLOWING))continue;
      if(el.getClientRects().length)return el;
    }
    return null;
  }
  if(trigger){
    trigger.addEventListener("click",function(){ddShow(!ddOpen())});
    trigger.addEventListener("keydown",function(e){
      var open=ddOpen();
      if(e.key==="Enter"||e.key===" "){e.preventDefault();if(open)ddShow(false);else ddShow(true,"first")}
      else if(e.key==="ArrowDown"){e.preventDefault();ddShow(true,"first")}
      else if(e.key==="ArrowUp"){e.preventDefault();ddShow(true,"last")}
      else if(e.key==="Escape"&&open){e.preventDefault();ddShow(false)}
      else if(e.key==="Tab"&&!e.shiftKey&&open){e.preventDefault();items()[0].focus()}
    });
    panel.addEventListener("keydown",function(e){
      var list=items(),i=list.indexOf(document.activeElement),to=null;
      if(e.key==="Escape"){e.preventDefault();ddShow(false);trigger.focus();return}
      if(e.key==="Tab"){
        if(!e.shiftKey&&i===list.length-1){e.preventDefault();ddShow(false);(nextInHeader()||trigger).focus()}
        else if(e.shiftKey&&i===0){e.preventDefault();trigger.focus()}
        return;
      }
      if(i<0)return;
      if(e.key==="ArrowDown")to=list[(i+1)%list.length];
      else if(e.key==="ArrowUp")to=list[(i-1+list.length)%list.length];
      else if(e.key==="Home")to=list[0];
      else if(e.key==="End")to=list[list.length-1];
      if(to){e.preventDefault();to.focus()}
    });
    dd.addEventListener("focusout",function(e){
      if(!ddOpen())return;
      var to=e.relatedTarget;
      if(to&&dd.contains(to))return;
      if(!to&&dd.matches(":hover"))return;
      ddShow(false);
    });
    document.addEventListener("pointerdown",function(e){if(ddOpen()&&!header.contains(e.target))ddShow(false)});
    addEventListener("scroll",function(e){if(ddOpen()&&!(e.target instanceof Node&&panel.contains(e.target)))ddShow(false)},{capture:true,passive:true});
  }

  // The phone menu. While it is open the page holds still behind it, Tab stays inside the button
  // and the menu, and Escape, a press outside or following a link closes it; focus goes into the
  // menu when it opens and back to the button when it closes.
  var wrap=header.querySelector(".hm"),btn=wrap&&wrap.querySelector(".hm-b"),sheet=wrap&&wrap.querySelector(".hm-sheet"),dim=wrap&&wrap.querySelector(".hm-dim");
  var list=sheet&&sheet.querySelector("details"),page=document.documentElement,was=null;
  function stops(){
    return [btn].concat([].slice.call(sheet.querySelectorAll("a[href],button:not([disabled]),summary"))).filter(function(el){
      return !el.closest("details:not([open]) > :not(summary)")&&el.getClientRects().length>0;
    });
  }
  function menuOpen(){return !!btn&&btn.getAttribute("aria-expanded")==="true"}
  function setMenu(next){
    if(!btn||next===menuOpen())return;
    btn.setAttribute("aria-expanded",next?"true":"false");
    if(next){
      was={overflow:page.style.overflow,gutter:page.style.scrollbarGutter};
      page.style.overflow="hidden";page.style.scrollbarGutter="stable";
      var first=stops()[1];if(first)first.focus();
    }else{
      if(was){page.style.overflow=was.overflow;page.style.scrollbarGutter=was.gutter;was=null}
      if(list)list.open=false;
    }
  }
  function closeMenu(){
    var at=document.activeElement,held=at&&sheet.contains(at);
    setMenu(false);
    if(held&&btn.getClientRects().length)btn.focus();
  }
  if(btn){
    btn.addEventListener("click",function(){if(menuOpen())closeMenu();else setMenu(true)});
    dim.addEventListener("mousedown",function(e){e.preventDefault()});
    dim.addEventListener("click",closeMenu);
    sheet.addEventListener("click",function(e){if(e.target instanceof Element&&e.target.closest("a"))setMenu(false)});
    document.addEventListener("keydown",function(e){
      if(!menuOpen()||e.defaultPrevented)return;
      if(e.key==="Escape"){e.preventDefault();closeMenu();return}
      if(e.key!=="Tab")return;
      var s=stops(),first=s[0],last=s[s.length-1],at=document.activeElement;
      if(!wrap.contains(at)){e.preventDefault();first.focus()}
      else if(e.shiftKey&&at===first){e.preventDefault();last.focus()}
      else if(!e.shiftKey&&at===last){e.preventDefault();first.focus()}
    });
    document.addEventListener("pointerdown",function(e){if(menuOpen()&&!wrap.contains(e.target))closeMenu()});
  }
  // The repository list inside the menu: the first Escape closes it, a press outside it closes it.
  if(list){
    list.addEventListener("keydown",function(e){
      if(e.key!=="Escape"||!list.open)return;
      e.preventDefault();list.open=false;list.querySelector("summary").focus();
    });
    document.addEventListener("pointerdown",function(e){if(list.open&&!list.contains(e.target))list.open=false});
  }

  function cross(){if(wide.matches)closeMenu();else ddShow(false)}
  if(wide.addEventListener)wide.addEventListener("change",cross);else if(wide.addListener)wide.addListener(cross);
})();
