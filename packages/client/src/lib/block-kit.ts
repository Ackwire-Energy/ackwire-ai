/**
 * The kit a live block runs on (ADR 0109): the controls, numbers and charts every block gets, inside its sandboxed
 * frame, on the web and in the phone's web view alike. Only this runs before the agent's code, and it holds no secret:
 * a page can read or replace it, and nothing outside trusts what it says. It is text here because it never runs in
 * the app. Parts and how to use them: `BLOCK_MANUAL` in `packages/engine/src/blocks.ts`.
 */

export const BLOCK_KIT_CSS = String.raw`:root{--ink:#151514;--ink2:#2a2a28;--muted:#5c5c58;--faint:#6f6f6a;--line:rgba(23,23,22,.07);--line2:rgba(23,23,22,.12);--raised:#fff;--sunken:#f3f3f0;--well:#fbfbf9;--plate:rgba(127,127,127,.1);--plate2:rgba(127,127,127,.06);--ok:#1f7a45;--warn:#9a5b00;--danger:#c4321c;--focus:rgba(75,140,245,.35);color-scheme:light}
html[data-theme=dark]{--ink:#efefec;--ink2:#d6d6d2;--muted:#a3a39e;--faint:#8f8f89;--line:rgba(255,255,255,.1);--line2:rgba(255,255,255,.15);--raised:#1c1c1b;--sunken:#0a0a09;--well:#141413;--plate:rgba(127,127,127,.14);--plate2:rgba(127,127,127,.08);--ok:#5fc48a;--warn:#e0a84a;--danger:#f08a80;--focus:rgba(75,140,245,.45);color-scheme:dark}
*{box-sizing:border-box}
html{overflow:hidden auto}
html,body{margin:0;background:transparent}
body{display:flex;flex-direction:column;gap:14px;padding:6px 16px 16px;color:var(--ink);font:400 14px/1.5 var(--font,Onest),"Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
button{font:inherit;color:inherit;cursor:pointer;border:0;background:none;padding:0}
:where(button:not([class]):not(.ac-seg button)){min-height:36px;padding:0 14px;border-radius:10px;font-size:13px;font-weight:600;background:var(--raised);box-shadow:inset 0 0 0 1px var(--line2)}
:where(button:not([class]):not(.ac-seg button)):hover{background:var(--plate2)}
button[disabled]{opacity:.45;cursor:default}
button:focus-visible,input:focus-visible,textarea:focus-visible{outline:none;box-shadow:0 0 0 3px var(--focus)}
h1,h2,h3,p{margin:0}
[hidden],[data-off]{display:none!important}
ac-slider,ac-choice,ac-field,ac-check,ac-stat,ac-chart,ac-table,ac-more{display:block;min-width:0}
ac-note{display:block;font-size:12.5px;line-height:18px;color:var(--faint);text-wrap:pretty}
ac-row,ac-stats{display:grid;gap:14px 16px;grid-template-columns:repeat(auto-fit,minmax(130px,1fr))}
ac-stats{gap:10px;grid-template-columns:repeat(auto-fit,minmax(96px,1fr))}
@media (max-width:440px){ac-row{grid-template-columns:minmax(0,1fr)}.ac-stat{padding:8px 10px}.ac-stat b{font-size:17px;line-height:23px}.ac-stat small{font-size:11.5px;line-height:15px}}
ac-text{display:inline}
ac-send{display:none}
.ac-l{display:flex;justify-content:space-between;gap:12px;margin-bottom:6px;font-size:13px;font-weight:550;color:var(--muted)}
.ac-l b{font-weight:650;color:var(--ink);font-variant-numeric:tabular-nums}
input[type=range]{--p:50%;appearance:none;-webkit-appearance:none;display:block;width:100%;height:22px;margin:0;background:none;cursor:pointer;border-radius:6px}
input[type=range]::-webkit-slider-runnable-track{height:6px;border-radius:999px;background:linear-gradient(90deg,var(--ink) var(--p),var(--line2) var(--p))}
input[type=range]::-moz-range-track{height:6px;border-radius:999px;background:linear-gradient(90deg,var(--ink) var(--p),var(--line2) var(--p))}
input[type=range]::-webkit-slider-thumb{appearance:none;-webkit-appearance:none;width:20px;height:20px;margin-top:-7px;border-radius:7px 7px 7px 3px;background:linear-gradient(180deg,#fff,#f1f1ee);box-shadow:0 0 0 1px rgba(23,23,22,.14),0 2px 5px rgba(23,23,22,.2),inset 0 1px 0 #fff;transition:transform .12s cubic-bezier(.34,1.36,.5,1)}
input[type=range]::-moz-range-thumb{width:20px;height:20px;border:0;border-radius:7px 7px 7px 3px;background:#fff;box-shadow:0 0 0 1px rgba(23,23,22,.14),0 2px 5px rgba(23,23,22,.2)}
input[type=range]:active::-webkit-slider-thumb{transform:scale(1.1)}
.ac-seg{display:inline-flex;flex-wrap:wrap;gap:2px;max-width:100%;padding:3px;border-radius:12px;background:var(--plate)}
.ac-seg button{min-height:30px;padding:3px 12px;border-radius:9px;font-size:13px;font-weight:550;color:var(--muted);white-space:nowrap}
.ac-seg button[aria-pressed=true]{background:var(--raised);color:var(--ink);box-shadow:0 1px 2px rgba(0,0,0,.1),0 0 0 1px var(--line)}
.ac-in{display:block;width:100%;height:38px;padding:0 12px;border:0;border-radius:10px;background:var(--raised);box-shadow:inset 0 0 0 1px var(--line2);color:var(--ink);font:500 14px var(--font,Onest),system-ui,sans-serif}
textarea.ac-in{height:auto;min-height:70px;padding:8px 12px;resize:vertical;line-height:1.45}
.ac-in::placeholder{color:var(--faint);font-weight:400}
.ac-sw{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;min-height:30px;font-size:13.5px;font-weight:550;color:var(--ink2);text-align:left}
.ac-sw i{position:relative;flex:none;width:34px;height:20px;border-radius:999px;background:var(--line2);transition:background .15s}
.ac-sw i::after{content:"";position:absolute;left:2px;top:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.3);transition:transform .15s}
.ac-sw[aria-checked=true] i{background:var(--ok)}.ac-sw[aria-checked=true] i::after{transform:translateX(14px)}
.ac-stat{padding:10px 12px;border-radius:12px 12px 12px 4px;background:var(--well);box-shadow:inset 0 0 0 1px var(--line)}
.ac-stat span{display:block;font-size:12.5px;color:var(--muted)}
.ac-stat b{display:block;margin-top:1px;font-size:21px;line-height:27px;font-weight:650;letter-spacing:-.01em;font-variant-numeric:tabular-nums;white-space:nowrap}
.ac-stat small{display:block;min-height:17px;font-size:12px;line-height:17px;color:var(--faint);font-variant-numeric:tabular-nums}
.ac-stat[data-tone=up] small{color:var(--ok)}.ac-stat[data-tone=down] small{color:var(--danger)}
.ac-title{margin-bottom:6px;font-size:13px;font-weight:550;color:var(--muted)}
.ac-bar{display:grid;grid-template-columns:minmax(64px,auto) minmax(0,1fr) auto;align-items:center;gap:10px;width:100%;min-height:26px;padding:2px 0;border-radius:7px;text-align:left}
.ac-bar[data-click]{cursor:pointer}.ac-bar[data-click]:hover .ac-bar__l{color:var(--ink)}
.ac-bars[data-sel] .ac-bar:not([data-on]) .ac-bar__f{opacity:.45}
.ac-bar__l{font-size:13px;color:var(--ink2);white-space:nowrap}
.ac-bars{--lw:64px}
.ac-bar__r{display:block;height:14px;border-radius:5px;background:var(--plate2)}
.ac-bar__f{display:block;height:100%;overflow:hidden;border-radius:5px;transition:width .24s cubic-bezier(.2,.8,.2,1),opacity .15s}
.ac-bar__f canvas{display:block;height:14px;image-rendering:pixelated}
.ac-bar__v{font-size:13px;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}
.ac-line{position:relative;height:130px;touch-action:pan-y}
.ac-line canvas{position:absolute;inset:0;width:100%;height:100%;image-rendering:pixelated}
.ac-line svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
.ac-line path{fill:none;stroke-width:2;vector-effect:non-scaling-stroke;stroke-linecap:round;stroke-linejoin:round}
.ac-axis{display:flex;justify-content:space-between;margin-top:4px;font-size:12px;color:var(--faint)}
.ac-tip{position:absolute;z-index:2;transform:translate(-50%,-120%);padding:3px 8px;border-radius:8px 8px 8px 3px;background:var(--ink);color:var(--raised);font-size:12px;font-weight:600;white-space:nowrap;pointer-events:none}
.ac-dot{position:absolute;width:8px;height:8px;margin:-4px 0 0 -4px;border-radius:3px;background:var(--raised);box-shadow:0 0 0 2px var(--cink);pointer-events:none}
table.ac-t{width:100%;border-collapse:collapse;font-size:13px}
.ac-t th{padding:0 8px 6px 0;text-align:left;font-weight:550;color:var(--muted)}
.ac-t td{padding:6px 8px 6px 0;border-top:1px solid var(--line);color:var(--ink2);font-variant-numeric:tabular-nums}
details.ac-more summary{display:inline-flex;align-items:center;gap:5px;font-size:12.5px;font-weight:600;color:var(--muted);cursor:pointer;list-style:none;border-radius:6px}
details.ac-more summary::-webkit-details-marker{display:none}
details.ac-more summary::before{content:"";width:6px;height:6px;border-right:1.6px solid;border-bottom:1.6px solid;transform:rotate(-45deg);transition:transform .15s}
details.ac-more[open] summary::before{transform:rotate(45deg)}
details.ac-more > div{margin-top:6px;font-size:12.5px;line-height:18px;color:var(--muted)}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;transition-duration:.01ms!important}}`;

export const BLOCK_KIT_JS = String.raw`(function(){
var R=window.__block||{};
function mem(){var d={};return{getItem:function(k){return k in d?d[k]:null},setItem:function(k,v){d[k]=String(v)},removeItem:function(k){delete d[k]},clear:function(){d={}}}}
["localStorage","sessionStorage"].forEach(function(n){try{void window[n].length}catch(e){try{Object.defineProperty(window,n,{value:mem(),configurable:true})}catch(_){}}});
try{void document.cookie}catch(e){try{Object.defineProperty(document,"cookie",{get:function(){return""},set:function(){},configurable:true})}catch(_){}}
var L=R.labels||{send:"Send",more:"More",thousand:"k"},LOC=R.locale||"pt-BR";
var post=function(m){m.agentes=1;try{var n=window.ReactNativeWebView;if(n)n.postMessage(JSON.stringify(m));else parent.postMessage(m,"*")}catch(_){}};
var state=Object.assign({},R.state||{}),calc=[],subs=[],derived={},queued=false;
var view=function(){return Object.assign({},state,derived)};
function flush(){queued=false;derived={};calc.forEach(function(f){try{Object.assign(derived,f(view())||{})}catch(e){post({type:"error",message:String(e.message||e).slice(0,200)})}});
  var v=view();subs.forEach(function(f){try{f(v)}catch(e){post({type:"error",message:String(e.message||e).slice(0,200)})}});
  document.querySelectorAll("[when]").forEach(function(el){var m=/^(.+?)(!?=)(.*)$/.exec(el.getAttribute("when"));if(!m)return;var on=String(v[m[1]])===m[3];if(m[2]==="!=")on=!on;on?el.removeAttribute("data-off"):el.setAttribute("data-off","")});
  post({type:"state",state:state})}
var touch=function(){if(!queued){queued=true;queueMicrotask(flush)}};
var fmt=function(v,f,u){if(v===undefined||v===null||v!==v)return"–";var n=Number(v),pt=function(x,d){return x.toLocaleString(LOC,{maximumFractionDigits:d===undefined?1:d})};
  if(f==="brl")return"R$ "+pt(n,0);if(f==="mil")return"R$ "+pt(n,1)+(L.thousand==="k"?"k":" "+L.thousand);if(f==="pct")return pt(n,1)+"%";if(f==="int")return pt(n,0);if(typeof v==="number")return pt(n)+(u?" "+u:"");return String(v)};
var esc=function(s){return String(s).replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]})};
var opts=function(s){return String(s||"").split("|").map(function(x){return x.trim()}).filter(Boolean)};
var fill=function(t,v){return t.replace(/\{(\w+)(?::(\w+))?\}/g,function(_,k,f){return fmt(v[k],f)})};
var agentes=window.agentes={get state(){return view()},set:function(k,v){state[k]=v;touch()},compute:function(f){calc.push(f);touch()},on:function(f){subs.push(f);touch()},fmt:fmt,
  send:function(text,label,ready){post({type:"draft",text:text,label:label||L.send,ready:ready!==false})}};
function theme(t){document.documentElement.dataset.theme=t}
theme(R.theme||"light");
if(R.ramp)document.documentElement.style.setProperty("--c",R.ramp[4]);
var ramp=function(){return R.ramp||["#cfe2ff","#9ec5ff","#5aa8ff","#3d8bff","#0063d1","#00408a"]};
var ink=function(){return document.documentElement.dataset.theme==="dark"?ramp()[2]:ramp()[4]};
var B=[0,8,2,10,12,4,14,6,3,11,1,9,15,7,13,5].map(function(v){return(v+.5)/16}),bay=function(x,y){return B[((y&3)<<2)|(x&3)]};
var repaint=[];
function E(name,cls){customElements.define(name,cls)}
class Base extends HTMLElement{a(n,d){var v=this.getAttribute(n);return v===null?d:v}connectedCallback(){if(this._up)return;this._up=true;this.build();subs.push(this.sync.bind(this));touch()}build(){}sync(){}}
E("ac-slider",class extends Base{build(){var n=this.a("name"),self=this;if(state[n]===undefined)state[n]=+this.a("value",this.a("min",0));this.innerHTML='<label><span class="ac-l"><span>'+esc(this.a("label",""))+'</span><b></b></span><input type="range" min="'+this.a("min",0)+'" max="'+this.a("max",100)+'" step="'+this.a("step",1)+'" aria-label="'+esc(this.a("label",""))+'"></label>';this.input=this.querySelector("input");this.out=this.querySelector("b");this.input.value=state[n];this.input.addEventListener("input",function(){agentes.set(n,+self.input.value)})}
  sync(v){var n=this.a("name"),i=this.input,x=v[n];i.value=x;i.style.setProperty("--p",((x-i.min)/(i.max-i.min)*100)+"%");this.out.textContent=fmt(x,this.a("format"),this.a("unit"))}});
E("ac-choice",class extends Base{build(){var n=this.a("name"),self=this,o=opts(this.a("options"));if(state[n]===undefined)state[n]=this.a("value",o[0]);this.innerHTML=(this.a("label")?'<div class="ac-title">'+esc(this.a("label"))+'</div>':"")+'<div class="ac-seg" role="group">'+o.map(function(x){return'<button type="button" data-v="'+esc(x)+'">'+esc(x)+'</button>'}).join("")+'</div>';this.querySelectorAll("button").forEach(function(b){b.addEventListener("click",function(){agentes.set(n,b.dataset.v)})})}
  sync(v){var x=v[this.a("name")];this.querySelectorAll("button").forEach(function(b){b.setAttribute("aria-pressed",b.dataset.v===String(x))})}});
E("ac-field",class extends Base{build(){var n=this.a("name"),t=this.a("type","text"),ph=esc(this.a("placeholder","")),big=t==="textarea";if(state[n]===undefined)state[n]=this.a("value","");this.innerHTML='<label><span class="ac-l"><span>'+esc(this.a("label",""))+'</span></span>'+(big?'<textarea class="ac-in" placeholder="'+ph+'"></textarea>':'<input class="ac-in" type="'+esc(t)+'" placeholder="'+ph+'">')+'</label>';var i=this.querySelector(".ac-in");i.value=state[n];i.addEventListener("input",function(){agentes.set(n,i.value)})}});
E("ac-check",class extends Base{build(){var n=this.a("name"),b;if(state[n]===undefined)state[n]=this.hasAttribute("checked");this.innerHTML='<button type="button" class="ac-sw" role="switch"><span>'+esc(this.a("label",""))+'</span><i></i></button>';b=this.querySelector("button");b.addEventListener("click",function(){agentes.set(n,!state[n])})}sync(v){this.querySelector("button").setAttribute("aria-checked",!!v[this.a("name")])}});
E("ac-stat",class extends Base{build(){this.innerHTML='<div class="ac-stat"><span>'+esc(this.a("label",""))+'</span><b></b><small></small></div>'}
  sync(v){var x=this.a("bind")?v[this.a("bind")]:this.a("value");this.querySelector("b").textContent=fmt(x,this.a("format"),this.a("unit"));var s=this.a("sub-bind")?v[this.a("sub-bind")]:this.a("sub","");this.querySelector("small").textContent=s===undefined?"":s;var t=this.a("tone-bind");if(t)this.firstChild.dataset.tone=v[t]||""}});
E("ac-text",class extends Base{sync(v){this.textContent=fmt(v[this.a("bind")],this.a("format"))}});
E("ac-send",class extends Base{sync(v){var need=opts((this.a("needs")||"").replace(/,/g,"|"));var ok=need.every(function(k){return v[k]});post({type:"draft",text:fill(this.a("text",""),v),label:this.a("label",L.send),ready:ok,hint:ok?"":this.a("hint","")})}});
E("ac-more",class extends HTMLElement{connectedCallback(){var s=this;setTimeout(function(){if(s._up)return;s._up=true;s.innerHTML='<details class="ac-more"><summary>'+esc(s.getAttribute("label")||L.more)+'</summary><div>'+s.innerHTML+'</div></details>'})}});
E("ac-chart",class extends Base{build(){this.innerHTML=(this.a("label")?'<div class="ac-title">'+esc(this.a("label"))+'</div>':"")+'<div class="ac-body"></div>';this.body=this.lastChild;var me=this;repaint.push(function(){me.key=null;me.sync(view())})}
  sync(v){var d=v[this.a("bind")]||[];if(this.a("type")==="line")this.line(d);else this.bars(d,v)}
  bars(d,v){var f=this.a("format"),u=this.a("unit"),sel=this.a("select"),max=Math.max.apply(null,d.map(function(x){return x.value}).concat(1e-9)),key=d.map(function(x){return x.label}).join("|")+document.documentElement.dataset.theme,me=this;
    if(this.key!==key){this.key=key;this.body.innerHTML='<div class="ac-bars">'+d.map(function(x){return'<'+(sel?'button type="button" data-click':'div')+' class="ac-bar" data-l="'+esc(x.label)+'"><span class="ac-bar__l">'+esc(x.label)+'</span><span class="ac-bar__r"><span class="ac-bar__f" style="width:0"><canvas></canvas></span></span><span class="ac-bar__v"></span></'+(sel?'button':'div')+'>'}).join("")+'</div>';
      if(sel)this.body.querySelectorAll("[data-click]").forEach(function(b){b.addEventListener("click",function(){var cur=state[sel],all=me.a("all");agentes.set(sel,cur===b.dataset.l&&all?all:b.dataset.l)})});
      var w=this.body.querySelector(".ac-bar__r");var W=w?w.clientWidth||300:300;this.body.querySelectorAll("canvas").forEach(function(c,i){var cols=Math.ceil(W/2),rows=7,g,r=ramp();c.width=cols;c.height=rows;c.style.width=W+"px";g=c.getContext("2d");for(var y=0;y<rows;y++)for(var x=0;x<cols;x++){var q=(.12+x/(cols-1)*(i===0?.8:.55))*5,lo=Math.floor(q),t=Math.min(5,lo+(q-lo>bay(x,y)?1:0));g.fillStyle=r[t];g.fillRect(x,y,1,1)}})}
    var cur=sel?state[sel]:null,hit=false;var rows=this.body.querySelectorAll(".ac-bar");d.forEach(function(x,i){var r=rows[i];if(!r)return;r.querySelector(".ac-bar__f").style.width=Math.max(0,x.value/max*100)+"%";r.querySelector(".ac-bar__v").textContent=fmt(x.value,f,u);if(cur===x.label){r.dataset.on="";hit=true}else delete r.dataset.on});
    var box=this.body.querySelector(".ac-bars");if(box){if(hit)box.dataset.sel="";else delete box.dataset.sel}}
  line(d){if(!d.length)return;var me=this,f=this.a("format"),u=this.a("unit"),box=this.body;var dark=document.documentElement.dataset.theme==="dark";if(!box.querySelector(".ac-line")){box.innerHTML='<div class="ac-line"><canvas></canvas><svg preserveAspectRatio="none"><path></path></svg></div><div class="ac-axis"></div>';var L=box.firstChild;L.addEventListener("pointermove",function(e){me.hover(e)});L.addEventListener("pointerleave",function(){me.hover(null)})}
    this.pts=d;var L2=box.querySelector(".ac-line"),W=L2.clientWidth||300,H=130,top=8,bot=H-6,vals=d.map(function(x){return x.value}),mx=Math.max.apply(null,vals),lo=Math.min.apply(null,vals),pad=(mx-lo)*.35||mx*.1||1,mn=lo<0?lo-pad:Math.max(0,lo-pad),sp=(mx-mn)||1;
    var P=d.map(function(x,i){return[d.length>1?i/(d.length-1)*W:W/2,bot-(x.value-mn)/sp*(bot-top)]});this.P=P;var path="";P.forEach(function(p,i){if(!i){path="M"+p[0]+" "+p[1];return}var a=P[i-1],c=(p[0]-a[0])/2;path+=" C"+(a[0]+c)+" "+a[1]+" "+(p[0]-c)+" "+p[1]+" "+p[0]+" "+p[1]});
    var svg=L2.querySelector("svg");svg.setAttribute("viewBox","0 0 "+W+" "+H);var pe=L2.querySelector("path");pe.setAttribute("d",path);pe.style.stroke=ink();L2.style.setProperty("--cink",ink());
    var cv=L2.querySelector("canvas"),cols=Math.ceil(W/2),rows=H/2,g;cv.width=cols;cv.height=rows;g=cv.getContext("2d");var r=ramp(),t1=dark?r[4]:r[1],t2=dark?r[5]:r[0];
    var yAt=function(px){var i=0;while(i<P.length-2&&P[i+1][0]<px)i++;var a=P[i],b=P[i+1]||a,k=b[0]===a[0]?0:(px-a[0])/(b[0]-a[0]);k=k*k*(3-2*k);return a[1]+(b[1]-a[1])*k};
    for(var x=0;x<cols;x++){var y0=Math.round(yAt(x*2)/2)+2;for(var y=y0;y<rows;y++){var q=1-(y-y0)/(rows-y0+1);if(q*.85>bay(x,y)+.1){g.fillStyle=q>.6?t1:t2;g.fillRect(x,y,1,1)}}}
    var ax=box.querySelector(".ac-axis"),n=d.length;ax.innerHTML=(n?[d[0],d[Math.floor((n-1)/2)],d[n-1]]:[]).map(function(x){return'<span>'+esc(x.label)+'</span>'}).join("");this.lf=function(v){return fmt(v,f,u)}}
  hover(e){var L=this.body.querySelector(".ac-line"),t=L.querySelector(".ac-tip"),o=L.querySelector(".ac-dot");if(!e){if(t)t.remove();if(o)o.remove();return}var r=L.getBoundingClientRect(),x=e.clientX-r.left,best=0;this.P.forEach(function(p,i){if(Math.abs(p[0]-x)<Math.abs(this.P[best][0]-x))best=i},this);var p=this.P[best],d=this.pts[best];if(!t){t=document.createElement("div");t.className="ac-tip";L.appendChild(t);o=document.createElement("div");o.className="ac-dot";L.appendChild(o)}t.textContent=d.label+": "+this.lf(d.value);t.style.left=Math.min(r.width-50,Math.max(50,p[0]))+"px";t.style.top=p[1]+"px";o.style.left=p[0]+"px";o.style.top=p[1]+"px"}});
E("ac-table",class extends Base{sync(v){var c=opts(this.a("columns")).map(function(x){var p=x.split(":");return{t:p[0],k:p[1],f:p[2]}}),d=v[this.a("bind")]||[];this.innerHTML='<table class="ac-t"><thead><tr>'+c.map(function(x){return'<th>'+esc(x.t)+'</th>'}).join("")+'</tr></thead><tbody>'+d.map(function(r){return'<tr>'+c.map(function(x){return'<td>'+esc(fmt(r[x.k],x.f))+'</td>'}).join("")+'</tr>'}).join("")+'</tbody></table>'}});
function height(){post({type:"height",height:Math.ceil(document.body.getBoundingClientRect().height)})}
function host(m){if(m&&m.theme){theme(m.theme);repaint.forEach(function(f){f()})}}
window.__agentesHost=host;
addEventListener("message",function(e){if(e.source===parent&&e.source!==window)host(e.data)});
addEventListener("error",function(e){post({type:"error",message:String(e.message||"").slice(0,200)})});
addEventListener("DOMContentLoaded",function(){touch();if(window.ResizeObserver)new ResizeObserver(height).observe(document.body);height();post({type:"ready"})});
})();`;
