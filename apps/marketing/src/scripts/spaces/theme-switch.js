(function(){
  // Light/dark switch. The first choice is made in the page head; this keeps it.
  // A click is saved in the site's plannotator-theme cookie (as the site's own toggle does), so it holds on every page.
  // Until someone chooses (no cookie, or the site's "system"), the page follows a change of the system setting.
  // The header has two: one in the strip and one in the phone menu, shown at different widths.
  var root=document.documentElement,btns=[].slice.call(document.querySelectorAll(".thm")),mq=matchMedia("(prefers-color-scheme: light)");
  if(!btns.length)return;
  function chosen(){var m=document.cookie.match(/(?:^|; )plannotator-theme=([^;]*)/),t=m?decodeURIComponent(m[1]):"";return t==="light"||t==="dark"?t:""}
  function show(light){
    root.classList.toggle("light",light);
    btns.forEach(function(btn){btn.setAttribute("aria-label",light?"Switch to dark theme. Current theme: Light.":"Switch to light theme. Current theme: Dark.")});
  }
  show(root.classList.contains("light"));
  btns.forEach(function(btn){btn.addEventListener("click",function(){
    var light=!root.classList.contains("light");
    document.cookie="plannotator-theme="+(light?"light":"dark")+";path=/;max-age=31536000;SameSite=Lax";
    show(light);
  })});
  function follow(){if(!chosen())show(mq.matches)}
  if(mq.addEventListener)mq.addEventListener("change",follow);else if(mq.addListener)mq.addListener(follow);
})();
