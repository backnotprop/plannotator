(function(){
  var d=document.getElementById("signup-dialog"),form=document.getElementById("signup-form"),from=null,de=document.documentElement;
  if(!d||!d.showModal)return;
  [].slice.call(document.querySelectorAll("[data-signup]")).forEach(function(b){b.addEventListener("click",function(){from=b;d.showModal();de.classList.add("sg-open");var f=form.classList.contains("ws-submitted")?d.querySelector(".ws-success"):d.querySelector('[name="email"]');if(f)f.focus()})});
  d.querySelector("[data-signup-close]").addEventListener("click",function(){d.close()});
  d.addEventListener("click",function(e){if(e.target===d)d.close()});
  d.addEventListener("close",function(){de.classList.remove("sg-open");if(from&&from.focus)from.focus()});
  var n=0,slot=document.getElementById("sg-form-err"),own={"Required":1,"Looks invalid":1,"Pick one":1};
  function tidy(){
    [].slice.call(form.querySelectorAll(".ws-err")).forEach(function(err){
      if(!err.id){err.id="sg-err-"+(++n);err.setAttribute("role","alert");err.textContent=err.textContent.replace(/^\u21b3\s*/,"")}
      if(slot&&err.parentNode!==slot&&!own[err.textContent]){slot.textContent="";slot.appendChild(err)}
    });
    [].slice.call(form.querySelectorAll(".ws-field")).forEach(function(f){
      var err=f.querySelector(".ws-err"),c=f.querySelector("input,textarea,.ws-pills");
      if(!c)return;
      if(err){if(c.matches("input,textarea"))c.setAttribute("aria-invalid","true");c.setAttribute("aria-describedby",err.id)}
      else{c.removeAttribute("aria-invalid");c.removeAttribute("aria-describedby")}
    });
    if(form.classList.contains("ws-submitted")&&!form.dataset.told){form.dataset.told="1";var s=form.querySelector(".ws-success");if(s)s.focus()}
  }
  new MutationObserver(tidy).observe(form,{childList:true,subtree:true,attributes:true,attributeFilter:["class"]});
  function wipe(){if(slot&&slot.firstChild)slot.textContent=""}
  form.addEventListener("input",wipe);form.addEventListener("click",function(e){if(e.target.closest(".ws-pill,#contributor-toggle"))wipe()});
})();
