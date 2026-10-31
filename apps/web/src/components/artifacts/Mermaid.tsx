import { type CSSProperties, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CodeBlock } from "@/components/CodeBlock";
import { useDarkTheme } from "@/lib/grow";
import { type Drawing, mermaidDrawable, svgDrawing } from "@/lib/mermaid";

/** Source → SVG markup in the page's theme. Swappable for tests (the real one needs a browser layout engine). */
export type MermaidRenderer = (id: string, source: string, dark: boolean) => Promise<string>;

/**
 * The real mermaid. It draws in the page, so it's only handed sources `mermaidDrawable` accepts (useMermaid checks
 * first). A drawing still unfinished after `timeout` ms fails, and the block shows its code.
 */
export async function drawWithMermaid(id: string, source: string, dark: boolean, timeout = 10_000) {
  const draw = async () => {
    // Loaded on first use: Mermaid is large and most screens never need it.
    const { default: mermaid } = await import("mermaid");
    mermaid.initialize({
      startOnLoad: false,
      // The text comes from people and agents: labels stay text and nothing is clickable. A diagram's own settings
      // (`%%{init}%%`, front matter) never get this far, and if one did, mermaid drops its `secure` keys: HTML
      // labels, the sanitizer's settings and everything that reaches the page's CSS.
      securityLevel: "strict",
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      secure: [
        ...(mermaid.mermaidAPI.defaultConfig.secure ?? []),
        "htmlLabels",
        "dompurifyConfig",
        "themeCSS",
        "themeVariables",
        "fontFamily",
        "altFontFamily",
        "fontSize",
      ],
      // A diagram that doesn't parse rejects, instead of drawing mermaid's error graphic and leaving it in <body>.
      suppressErrorRendering: true,
      theme: dark ? "dark" : "neutral",
      // The <img> can't use the page's web fonts, and mermaid sizes each box for the font it measured with.
      fontFamily: "system-ui, sans-serif",
      // A gantt takes the width of the box it's drawn in, here <body>: a fixed one fits a card instead of the window.
      gantt: { useWidth: 720 },
    });
    // Not mermaid.render: that waits its turn in mermaid's own queue, where one drawing that never finishes holds
    // back every later one. useMermaid already draws one at a time.
    const { svg } = await mermaid.mermaidAPI.render(id, source);
    return svg;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      draw(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Mermaid didn't finish drawing")), timeout);
      }),
    ]);
  } catch (error) {
    // Mermaid draws in a <div id="d{id}"> at the end of <body> and removes it only once done or on a parse error.
    document.getElementById(`d${id}`)?.remove();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

let renderer: MermaidRenderer = drawWithMermaid;
let counter = 0;
/** One drawing at a time: mermaid keeps its settings (the theme) in one global, read while it draws. */
let queue: Promise<void> = Promise.resolve();

/**
 * Diagrams already drawn, by theme and source: drawn again (the streamed answer giving way to the message, a page
 * opened again) they show at once.
 */
const drawn = new Map<string, Drawing>();

export function setMermaidRenderer(next: MermaidRenderer | null) {
  renderer = next ?? drawWithMermaid;
  drawn.clear();
}

/**
 * The diagram in the page's theme: undefined until it's drawn, null when it can't be (it doesn't parse, or it would
 * load something). While another source or theme is being drawn, the block keeps what it showed last.
 */
function useMermaid(source: string): Drawing | null | undefined {
  const dark = useDarkTheme();
  const key = `${dark ? "dark" : "light"}\n${source}`;
  const drawable = mermaidDrawable(source);
  const [last, setLast] = useState<Drawing | null | undefined>(() => drawn.get(key));
  const asked = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!drawable) return;
    const hit = drawn.get(key);
    if (hit) {
      setLast(hit);
      return;
    }
    let live = true;
    // A source being edited (the wiki's side-by-side preview) is drawn once the typing stops.
    const wait = asked.current === undefined || asked.current === key ? 0 : 300;
    asked.current = key;
    const timer = setTimeout(() => {
      queue = queue.then(async () => {
        // Checked when its turn comes: the block may be gone, or another one may have drawn the same diagram.
        if (!live) return;
        const ready = drawn.get(key);
        if (ready) {
          setLast(ready);
          return;
        }
        try {
          const drawing = svgDrawing(await renderer(`mmd-${++counter}`, source, dark));
          drawn.set(key, drawing);
          // ponytail: the last 100 drawn, oldest out first; move a hit to the end (least recently used) if pages
          // ever show more diagrams than that.
          for (const old of drawn.keys()) {
            if (drawn.size <= 100) break;
            drawn.delete(old);
          }
          if (live) setLast(drawing);
        } catch {
          if (live) setLast(null);
        }
      });
    }, wait);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [key, source, dark, drawable]);
  return drawable ? (drawn.get(key) ?? last) : null;
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
        <img src={drawing.src} alt={drawing.title ?? label} aria-description={drawing.description} />
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
 * always there). Until it's drawn, or when it can't be, the card shows the code like any other block.
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
            alt={drawing.title ?? t("artifacts.kind.diagram")}
            aria-description={drawing.description}
            style={drawing.width ? ({ "--w": `${drawing.width}px` } as CSSProperties) : undefined}
          />
        ) : undefined
      }
    />
  );
}
