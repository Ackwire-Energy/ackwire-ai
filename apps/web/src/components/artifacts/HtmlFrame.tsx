import { useEffect, useState } from "react";

/**
 * Agent-made HTML, isolated: a blob URL in an iframe sandboxed with
 * `allow-scripts` only. Without `allow-same-origin` the page gets an opaque
 * origin: no cookies, storage or DOM of ours. Never inlined into our DOM.
 */
export const HTML_SANDBOX = "allow-scripts";

export function HtmlFrame({ html, title, className }: { html: string; title: string; className?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (typeof URL.createObjectURL !== "function") {
      setUrl(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      return;
    }
    const next = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [html]);
  if (!url) return null;
  return (
    <iframe
      className={className ?? "artifact-html"}
      src={url}
      title={title}
      sandbox={HTML_SANDBOX}
      referrerPolicy="no-referrer"
      loading="lazy"
    />
  );
}
