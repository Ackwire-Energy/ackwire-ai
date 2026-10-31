import { type CSSProperties, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CodeBlock } from "@/components/CodeBlock";
import { useDarkTheme } from "@/lib/grow";
import { type Drawing, drawWithMermaid, MERMAID_MAX_TEXT, svgDrawing } from "@/lib/mermaid";

/** Source → SVG markup in the page's theme. Swappable for tests (the real one needs a browser layout engine). */
export type MermaidRenderer = (id: string, source: string, dark: boolean) => Promise<string>;

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
 * The diagram in the page's theme: undefined until it's drawn, null when it can't be (it doesn't parse, or it's longer
 * than mermaid draws). While another source or theme is being drawn, the block keeps what it showed last.
 */
function useMermaid(source: string): Drawing | null | undefined {
  const dark = useDarkTheme();
  const key = `${dark ? "dark" : "light"}\n${source}`;
  const drawable = source.length <= MERMAID_MAX_TEXT;
  const [last, setLast] = useState<Drawing | null | undefined>(() => drawn.get(key));
  const asked = useRef<string | undefined>(undefined);
  useEffect(() => {
    // A source being edited (the wiki's side-by-side preview) is drawn once the typing stops. Noted before the early
    // returns: a block that mounts with its drawing already made still waits on the first edit.
    const wait = asked.current === undefined || asked.current === key ? 0 : 300;
    asked.current = key;
    if (!drawable) return;
    const hit = drawn.get(key);
    if (hit) {
      setLast(hit);
      return;
    }
    let live = true;
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
