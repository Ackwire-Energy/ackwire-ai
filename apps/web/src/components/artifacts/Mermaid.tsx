import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

/** Source → SVG markup. Swappable for tests (the real one needs a browser layout engine). */
export type MermaidRenderer = (id: string, source: string) => Promise<string>;

let counter = 0;
const realRenderer: MermaidRenderer = async (id, source) => {
  // Loaded on first use: Mermaid is large and most screens never need it.
  const { default: mermaid } = await import("mermaid");
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "neutral",
    flowchart: { htmlLabels: false },
    fontFamily: "Onest Variable, Onest, sans-serif",
  });
  const { svg } = await mermaid.render(id, source);
  return svg;
};
let renderer: MermaidRenderer = realRenderer;

export function setMermaidRenderer(next: MermaidRenderer | null) {
  renderer = next ?? realRenderer;
}

/**
 * A Mermaid diagram drawn as an image: the SVG goes into an `<img>` (data
 * URL), never into our DOM, so nothing in it can run. If drawing fails, the
 * source is shown as code.
 */
export function MermaidDiagram({ source, label, compact }: { source: string; label: string; compact?: boolean }) {
  const { t } = useTranslation();
  const [state, setState] = useState<{ src: string; for: string } | { error: true; for: string } | null>(null);
  useEffect(() => {
    let live = true;
    renderer(`mmd-${++counter}`, source)
      .then((svg) => {
        if (live) setState({ src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, for: source });
      })
      .catch(() => {
        if (live) setState({ error: true, for: source });
      });
    return () => {
      live = false;
    };
  }, [source]);
  const current = state?.for === source ? state : null;
  if (current && "error" in current) {
    return (
      <div className="artifact-diagram artifact-diagram--failed">
        {!compact && <p className="small muted">{t("artifacts.diagramFailed")}</p>}
        <pre className="md__code">
          <code>{source}</code>
        </pre>
      </div>
    );
  }
  return (
    <div className={compact ? "artifact-diagram artifact-diagram--compact" : "artifact-diagram"}>
      {current ? (
        <img src={current.src} alt={label} />
      ) : (
        <span className="small muted" role="status">
          {t("artifacts.rendering")}
        </span>
      )}
    </div>
  );
}
