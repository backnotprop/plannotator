const TOKEN_PAIRS: [string, string][] = [
  ["--vscode-editor-background", "--background"],
  ["--vscode-editor-foreground", "--foreground"],
  ["--vscode-sideBar-background", "--card"],
  ["--vscode-editor-foreground", "--card-foreground"],
  ["--vscode-editorWidget-background", "--popover"],
  ["--vscode-editor-foreground", "--popover-foreground"],
  ["--vscode-button-background", "--primary"],
  ["--vscode-button-foreground", "--primary-foreground"],
  ["--vscode-input-background", "--input"],
  ["--vscode-panel-border", "--border"],
  ["--vscode-focusBorder", "--ring"],
  ["--vscode-errorForeground", "--destructive"],
  ["--vscode-testing-iconPassed", "--success"],
  ["--vscode-editorWarning-foreground", "--warning"],
  ["--vscode-textLink-foreground", "--accent"],
  ["--vscode-descriptionForeground", "--muted-foreground"],
];

export const VSCODE_VARS = [...new Set(TOKEN_PAIRS.map(([v]) => v))];

export const DEFAULT_THEME_CLASS = "theme-plannotator";

export const THEME_MODE_COOKIE = "plannotator-theme";

export function buildWrapperThemeScript(): string {
  const varsJson = JSON.stringify(VSCODE_VARS);
  return `<script>(function(){
  var vars=${varsJson};
  function readTheme(){
    var s=getComputedStyle(document.documentElement);
    var t={};
    for(var i=0;i<vars.length;i++){
      var v=s.getPropertyValue(vars[i]).trim();
      if(v)t[vars[i]]=v;
    }
    var kind=document.body.getAttribute("data-vscode-theme-kind")||"vscode-dark";
    return{type:"plannotator-vscode-theme",tokens:t,themeKind:kind};
  }
  function send(){
    var f=document.querySelector("iframe");
    if(f&&f.contentWindow)f.contentWindow.postMessage(readTheme(),"*");
  }
  window.addEventListener("load",function(){send();setTimeout(send,300);});
  var ob=new MutationObserver(function(){send();});
  ob.observe(document.documentElement,{attributes:true,attributeFilter:["style","class"]});
  ob.observe(document.body,{attributes:true,attributeFilter:["data-vscode-theme-kind"]});
})();</script>`;
}

export function buildThemeListenerScript(): string {
  const pairsJson = JSON.stringify(TOKEN_PAIRS);
  const defaultThemeClass = JSON.stringify(DEFAULT_THEME_CLASS);
  const modeCookie = JSON.stringify(THEME_MODE_COOKIE);
  return `<script>(function(){
  window.__PLANNOTATOR_VSCODE=true;
  var pairs=${pairsJson};
  var DEFAULT_THEME_CLASS=${defaultThemeClass};
  var MODE_COOKIE=${modeCookie};
  var root=document.documentElement;
  var latest=null;
  var applied=false;
  function hexToComponents(h){
    h=h.replace("#","");
    if(h.length===3)h=h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
    return[parseInt(h.slice(0,2),16),parseInt(h.slice(2,4),16),parseInt(h.slice(4,6),16)];
  }
  function adjustBrightness(color,amount){
    if(!color)return null;
    var c=hexToComponents(color);
    var r=Math.min(255,Math.max(0,c[0]+amount));
    var g=Math.min(255,Math.max(0,c[1]+amount));
    var b=Math.min(255,Math.max(0,c[2]+amount));
    return"rgb("+r+","+g+","+b+")";
  }
  function ideIsLight(kind){return kind==="vscode-light"||kind==="vscode-high-contrast-light";}
  function appIsLight(){return root.classList.contains("light");}
  /* The palette ThemeProvider is currently rendering, "" before it mounts. */
  function appPalette(){
    var list=root.classList;
    for(var i=0;i<list.length;i++){if(list[i].indexOf("theme-")===0)return list[i];}
    return"";
  }
  /* Read lazily: the virtual cookie jar is installed by a later script. */
  function appMode(){
    var parts=String(document.cookie||"").split("; ");
    for(var i=0;i<parts.length;i++){
      var eq=parts[i].indexOf("=");
      if(eq>0&&parts[i].slice(0,eq)===MODE_COOKIE)return decodeURIComponent(parts[i].slice(eq+1));
    }
    return"";
  }
  function clearOverrides(){
    if(!applied)return;
    for(var i=0;i<pairs.length;i++)root.style.removeProperty(pairs[i][1]);
    root.style.removeProperty("--muted");
    applied=false;
  }
  function applyOverrides(){
    var tokens=latest.tokens||{};
    for(var i=0;i<pairs.length;i++){
      var val=tokens[pairs[i][0]];
      if(val)root.style.setProperty(pairs[i][1],val);
    }
    var bg=tokens["--vscode-editor-background"];
    if(bg){
      var muted=adjustBrightness(bg,ideIsLight(latest.themeKind)?-20:20);
      if(muted)root.style.setProperty("--muted",muted);
    }
    applied=true;
  }
  function reconcile(){
    if(!latest)return;
    /* A palette the user picked is never stood in for. */
    if(appPalette()!==DEFAULT_THEME_CLASS){clearOverrides();return;}
    var wantLight=ideIsLight(latest.themeKind);
    /* System means "follow the environment", and here that is the IDE. */
    if(appMode()==="system"&&appIsLight()!==wantLight){
      if(wantLight)root.classList.add("light");
      else root.classList.remove("light");
    }
    /* Never paint one mode's colors onto the other mode's surface. */
    if(appIsLight()!==wantLight){clearOverrides();return;}
    applyOverrides();
  }
  /* An IDE theme change lands in one frame, as ThemeProvider's switches do:
     theme.css zeroes every transition while <html> has pn-theme-switching. */
  var holds=0;
  function holdThemeSwitch(){
    root.classList.add("pn-theme-switching");
    var n=++holds;
    var frame=window.requestAnimationFrame?function(f){window.requestAnimationFrame(f);}:function(f){setTimeout(f,16);};
    frame(function(){frame(function(){if(n===holds)root.classList.remove("pn-theme-switching");});});
  }
  window.addEventListener("message",function(e){
    if(!e.data||e.data.type!=="plannotator-vscode-theme")return;
    latest=e.data;
    holdThemeSwitch();
    reconcile();
  });
  /* ThemeProvider rewrites these classes whenever the user changes theme. */
  if(typeof MutationObserver!=="undefined"){
    new MutationObserver(function(){reconcile();})
      .observe(root,{attributes:true,attributeFilter:["class"]});
  }
})();</script>`;
}
