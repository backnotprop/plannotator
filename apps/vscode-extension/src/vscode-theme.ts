/**
 * VS Code Theme Bridge
 *
 * Maps VS Code CSS custom properties to Plannotator's CSS variable system.
 * Used by the cookie proxy to inject a theme listener into the webview iframe,
 * and by the panel manager to read+send theme tokens from the wrapper page.
 *
 * Precedence contract (issue #1053): the app owns its own appearance. The
 * bridge writes INLINE custom properties on <html>, the same element
 * ThemeProvider stamps `theme-<palette>` / `light` on, and an inline property
 * outranks every `.theme-*` rule in the cascade. So the bridge only fills in
 * for a user who has expressed no conflicting preference:
 *
 *   - a palette the user picked always wins; the bridge stays off entirely;
 *   - the mode the app is rendering always wins, so VS Code colors are only
 *     painted while the app is already showing the same light/dark side the
 *     IDE is on. Choosing Light in a dark IDE now yields Plannotator's light
 *     theme instead of dark VS Code tokens under a `.light` class;
 *   - "System" is the one mode that defers: inside VS Code the surrounding
 *     system is the IDE, so the bridge maps it onto the IDE's theme kind.
 *
 * Anything the bridge painted is removed again the moment that stops holding,
 * which is why every decision runs through `reconcile()` rather than being
 * applied once on arrival.
 */

// Each VS Code CSS variable can map to multiple Plannotator variables
// (e.g., editor foreground → foreground, card-foreground, popover-foreground).
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

/** VS Code variable names the wrapper page needs to read */
export const VSCODE_VARS = [...new Set(TOKEN_PAIRS.map(([v]) => v))];

/**
 * Plannotator's default palette (`DEFAULT_COLOR_THEME` in
 * packages/ui/utils/themeRegistry.ts) as the class ThemeProvider puts on
 * <html>. Seeing it means the user never picked a palette, which is the only
 * case VS Code colors may stand in for one. If the id ever drifts, the bridge
 * simply stops syncing and the app renders its own theme: the safe direction
 * for this comparison to fail.
 */
export const DEFAULT_THEME_CLASS = "theme-plannotator";

/**
 * Cookie ThemeProvider persists the mode under (its default `storageKey`).
 * Read to recognize System, the one mode that asks to follow the environment.
 */
export const THEME_MODE_COOKIE = "plannotator-theme";

/**
 * Returns inline JS for the wrapper page (panel-manager.ts).
 * Reads VS Code CSS variables and posts them to the iframe.
 */
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

/**
 * Returns inline JS injected into the iframe HTML (via cookie proxy).
 * Listens for theme messages from the wrapper and applies CSS overrides,
 * subject to the precedence contract documented at the top of this file.
 */
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
  window.addEventListener("message",function(e){
    if(!e.data||e.data.type!=="plannotator-vscode-theme")return;
    latest=e.data;
    reconcile();
  });
  /* ThemeProvider rewrites these classes whenever the user changes theme. */
  if(typeof MutationObserver!=="undefined"){
    new MutationObserver(function(){reconcile();})
      .observe(root,{attributes:true,attributeFilter:["class"]});
  }
})();</script>`;
}
