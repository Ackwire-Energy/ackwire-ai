import { type CSSProperties, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { CodeBlock } from "@/components/CodeBlock";
import { useDarkTheme } from "@/lib/grow";

/** Source → SVG markup in the page's theme. Swappable for tests (the real one needs a browser layout engine). */
export type MermaidRenderer = (id: string, source: string, dark: boolean) => Promise<string>;

let counter = 0;
let queue: Promise<unknown> = Promise.resolve();
const realRenderer: MermaidRenderer = (id, source, dark) => {
  // One at a time: mermaid reads its settings when its own queue reaches a drawing, not when render() is called,
  // so the theme set for this one must not reach another still waiting.
  const run = queue.then(async () => {
    // Loaded on first use: Mermaid is large and most screens never need it.
    const { default: mermaid } = await import("mermaid");
    mermaid.initialize({
      startOnLoad: false,
      // The text comes from people and agents: labels stay text, nothing is clickable, and a `%%{init}%%` in the
      // diagram can't turn HTML labels back on (mermaid drops `secure` keys from a diagram's own settings).
      securityLevel: "strict",
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      secure: [...(mermaid.mermaidAPI.defaultConfig.secure ?? []), "htmlLabels"],
      // A diagram that doesn't parse rejects, instead of drawing mermaid's error graphic and leaving it in <body>.
      suppressErrorRendering: true,
      theme: dark ? "dark" : "neutral",
      // The <img> can't use the page's web fonts, and mermaid sizes each box for the font it measured with.
      fontFamily: "system-ui, sans-serif",
    });
    const { svg } = await mermaid.render(id, source);
    return svg;
  });
  queue = run.catch(() => {});
  return run;
};
let renderer: MermaidRenderer = realRenderer;

/** A diagram drawn: its image URL and its own width in CSS pixels (null when its SVG doesn't say). */
type Drawing = { src: string; width: number | null };

/**
 * Diagrams already drawn, by theme and source: drawn again (the streamed answer giving way to the message, a page
 * opened again) they show at once.
 */
const drawn = new Map<string, Drawing>();

export function setMermaidRenderer(next: MermaidRenderer | null) {
  renderer = next ?? realRenderer;
  drawn.clear();
}

/** The diagram in the page's theme: undefined while it's drawn, null when it doesn't parse. */
function useMermaid(source: string): Drawing | null | undefined {
  const dark = useDarkTheme();
  const key = `${dark ? "dark" : "light"}\n${source}`;
  const [state, setState] = useState<{ key: string; drawing?: Drawing | null }>(() => ({
    key,
    drawing: drawn.get(key),
  }));
  useEffect(() => {
    const hit = drawn.get(key);
    if (hit) {
      setState((s) => (s.key === key && s.drawing === hit ? s : { key, drawing: hit }));
      return;
    }
    let live = true;
    renderer(`mmd-${++counter}`, source, dark).then(
      (svg) => {
        // Its own size, not its box's width (mermaid's "100%"): a small diagram isn't blown up to fill the box.
        const size = svg.match(/viewBox="[^"]*?([\d.]+) ([\d.]+)"/);
        const own = size ? svg.replace('width="100%"', `width="${size[1]}" height="${size[2]}"`) : svg;
        const drawing = {
          src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(own)}`,
          width: size ? Number(size[1]) : null,
        };
        drawn.set(key, drawing);
        // ponytail: the last 100 drawn, oldest out first; move a hit to the end (least recently used) if pages
        // ever show more diagrams than that.
        for (const old of drawn.keys()) {
          if (drawn.size <= 100) break;
          drawn.delete(old);
        }
        if (live) setState({ key, drawing });
      },
      () => {
        if (live) setState({ key, drawing: null });
      },
    );
    return () => {
      live = false;
    };
  }, [key, source, dark]);
  return state.key === key ? state.drawing : undefined;
}

/**
 * A Mermaid diagram drawn as an image: the SVG goes into an `<img>` (data
 * URL), never into our DOM, so nothing in it can run. If drawing fails, the
 * source is shown as code.
 */
export function MermaidDiagram({ source, label, compact }: { source: string; label: string; compact?: boolean }) {
  const { t } = useTranslation();
  const drawing = useMermaid(source);
  if (drawing === null) {
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
      {drawing ? (
        <img src={drawing.src} alt={label} />
      ) : (
        <span className="small muted" role="status">
          {t("artifacts.rendering")}
        </span>
      )}
    </div>
  );
}

/**
 * A ```mermaid block in a message or page: its code card shows the diagram ("Código" flips to the source, copy is
 * always there). Until it's drawn, or when it doesn't parse, the card shows the code like any other block.
 */
export function MermaidOrCode({ text }: { text: string }) {
  const { t } = useTranslation();
  const drawing = useMermaid(text);
  return (
    <CodeBlock
      lang="mermaid"
      text={text}
      preview={
        drawing ? (
          <img
            src={drawing.src}
            alt={t("artifacts.kind.diagram")}
            style={drawing.width ? ({ "--w": `${drawing.width}px` } as CSSProperties) : undefined}
          />
        ) : undefined
      }
    />
  );
}
