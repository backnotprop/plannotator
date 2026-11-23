(function(){
  // Light/dark switch. The first choice is made in the page head; this keeps it.
  // A click is saved in the site's plannotator-theme cookie (as the site's own toggle does), so it holds on every page.
  // Until someone chooses (no cookie, or the site's "system"), the page follows a change of the system setting.
  var root=document.documentElement,btn=document.querySelector(".thm"),mq=matchMedia("(prefers-color-scheme: light)");
  if(!btn)return;
  function chosen(){var m=document.cookie.match(/(?:^|; )plannotator-theme=([^;]*)/),t=m?decodeURIComponent(m[1]):"";return t==="light"||t==="dark"?t:""}
  function show(light){root.classList.toggle("light",light);btn.setAttribute("aria-label",light?"Switch to dark theme":"Switch to light theme")}
  show(root.classList.contains("light"));
  btn.addEventListener("click",function(){
    var light=!root.classList.contains("light");
    document.cookie="plannotator-theme="+(light?"light":"dark")+";path=/;max-age=31536000;SameSite=Lax";
    show(light);
  });
  function follow(){if(!chosen())show(mq.matches)}
  if(mq.addEventListener)mq.addEventListener("change",follow);else if(mq.addListener)mq.addListener(follow);
})();
