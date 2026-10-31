import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * Agent-made HTML, isolated: a blob URL in an iframe sandboxed with
 * `allow-scripts` only. Without `allow-same-origin` the page gets an opaque
 * origin: no cookies, storage or DOM of ours. Never inlined into our DOM.
 */
export const HTML_SANDBOX = "allow-scripts";

/** How long the page has to say it started before we try the next way to load it. */
const READY_MS = 4000;

/**
 * Runs first inside the page. In an opaque origin `localStorage`,
 * `sessionStorage` and `document.cookie` throw, and a page that touches them
 * dies before drawing anything (a blank frame): give it in-memory stand-ins.
 * It also tells us the page started (so a load the browser refused can be
 * retried) and passes on its errors, as plain text.
 */
const SHIM = `<script>(function(){
function mem(){var d={};return{getItem:function(k){k=String(k);return Object.prototype.hasOwnProperty.call(d,k)?d[k]:null},setItem:function(k,v){d[String(k)]=String(v)},removeItem:function(k){delete d[String(k)]},clear:function(){d={}},key:function(i){var k=Object.keys(d)[i];return k===undefined?null:k},get length(){return Object.keys(d).length}}}
["localStorage","sessionStorage"].forEach(function(n){try{void window[n].length}catch(e){try{Object.defineProperty(window,n,{value:mem(),configurable:true})}catch(_){}}});
try{void document.cookie}catch(e){try{Object.defineProperty(document,"cookie",{get:function(){return""},set:function(){},configurable:true})}catch(_){}}
function post(m){try{parent.postMessage(m,"*")}catch(_){}}
window.addEventListener("error",function(e){post({agentesHtml:"error",message:String(e&&e.message||"").slice(0,300)})});
post({agentesHtml:"ready"});
})();</script>`;

/** The page with the shim first: after `<head>`, else after the doctype (a script before it would switch to quirks mode), else at the top. */
export function withShim(html: string): string {
  const head = /<head(\s[^>]*)?>/i.exec(html);
  const at = head ? head.index + head[0].length : (/^\s*<!doctype[^>]*>/i.exec(html)?.[0].length ?? 0);
  return html.slice(0, at) + SHIM + html.slice(at);
}

type Load = "blob" | "data" | "failed";

export function HtmlFrame({
  html,
  title,
  className,
  thumbnail = false,
}: {
  html: string;
  title: string;
  className?: string;
  /** A small non-interactive picture of the page (message cards): no notes, out of the tab order. */
  thumbnail?: boolean;
}) {
  const { t } = useTranslation();
  const frame = useRef<HTMLIFrameElement>(null);
  const [load, setLoad] = useState<Load>("blob");
  const [url, setUrl] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new page starts over from a blob URL
  useEffect(() => {
    setLoad("blob");
  }, [html]);

  useEffect(() => {
    setReady(false);
    setError(null);
    const page = withShim(html);
    if (load === "failed") return;
    if (load === "data" || typeof URL.createObjectURL !== "function") {
      setUrl(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
      return;
    }
    const next = URL.createObjectURL(new Blob([page], { type: "text/html" }));
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [html, load]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const m = e.data as { agentesHtml?: unknown; message?: unknown } | null;
      if (m?.agentesHtml === "ready") setReady(true);
      else if (m?.agentesHtml === "error" && typeof m.message === "string") setError(m.message.slice(0, 300));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Some browsers refuse a blob page in a sandboxed frame: try a data URL, then say so.
  useEffect(() => {
    if (ready || load === "failed" || !url) return;
    const timer = setTimeout(() => setLoad(load === "blob" ? "data" : "failed"), READY_MS);
    return () => clearTimeout(timer);
  }, [ready, load, url]);

  const iframe =
    url && load !== "failed" ? (
      <iframe
        ref={frame}
        className={className ?? "artifact-html"}
        src={url}
        title={title}
        sandbox={HTML_SANDBOX}
        referrerPolicy="no-referrer"
        tabIndex={thumbnail ? -1 : undefined}
        aria-hidden={thumbnail || undefined}
      />
    ) : null;
  if (thumbnail) return iframe;
  return (
    <>
      {iframe}
      {load === "failed" && <p className="small muted">{t("artifacts.htmlFailed")}</p>}
      {error && load !== "failed" && <p className="small muted">{t("artifacts.htmlError", { message: error })}</p>}
    </>
  );
}
