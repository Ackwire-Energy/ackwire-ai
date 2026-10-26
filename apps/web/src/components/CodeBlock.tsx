import { type CodeToken, codeLabel, highlightCode } from "@agenteschat/client/lib/code";
import { Button, Dialog, DialogBody } from "@agenteschat/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * Fenced code in a message or document (telas/Polimento.html, A · Cartão): the language on top, copy
 * (the icon turns into "Copiado" for a moment) and full screen. Full screen grows out of the card itself
 * into a dialog with line numbers and an optional wrap; Esc closes. Colors from the shared highlighter
 * (`@agenteschat/client/lib/code`, the phone app uses the same one).
 */
export function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const { t } = useTranslation();
  const lines = useMemo(() => highlightCode(text, lang), [text, lang]);
  const label = codeLabel(lang) || t("common.code");
  const [open, setOpen] = useState(false);
  const [wrap, setWrap] = useState(false);
  const card = useRef<HTMLDivElement>(null);
  const from = useRef<DOMRect | null>(null);

  // Grows out of the card: the dialog starts on the card's box and settles in the middle.
  useEffect(() => {
    const start = from.current;
    if (!open || !start) return;
    from.current = null;
    if (matchMedia("(prefers-reduced-motion: reduce), (max-width: 640px)").matches) return;
    const frame = requestAnimationFrame(() => {
      const dialog = document.querySelector<HTMLElement>(".code-viewer");
      if (!dialog) return;
      const end = dialog.getBoundingClientRect();
      if (!end.width || !end.height) return;
      const x = start.left - innerWidth / 2;
      const y = start.top - innerHeight / 2;
      dialog.animate(
        [
          { transformOrigin: "0 0", transform: `translate(${x}px, ${y}px) scale(${start.width / end.width}, ${start.height / end.height})` },
          { transformOrigin: "0 0", transform: "translate(-50%, -50%)" },
        ],
        { duration: 420, easing: "cubic-bezier(0.32, 0.72, 0, 1)" },
      );
      for (const part of Array.from(dialog.children))
        part.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay: 140, easing: "ease-out", fill: "backwards" });
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const expand = () => {
    from.current = card.current?.getBoundingClientRect() ?? null;
    setOpen(true);
  };

  return (
    <div className="code-card" ref={card}>
      <div className="code-card__top">
        <span className="code-card__lang">{label}</span>
        <CopyCode text={text} />
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          icon="expand"
          aria-label={t("common.fullScreen")}
          title={t("common.fullScreen")}
          onClick={expand}
        />
      </div>
      <pre className="code-card__code">
        <code>
          <CodeLines lines={lines} />
        </code>
      </pre>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={label}
        closeLabel={t("common.close")}
        width={920}
        className="code-viewer"
        actions={
          <>
            <Button variant="ghost" size="sm" aria-pressed={wrap} onClick={() => setWrap((w) => !w)}>
              {t("common.wrapLines")}
            </Button>
            <CopyCode text={text} />
          </>
        }
      >
        <DialogBody className="code-viewer__body">
          <pre className="code-viewer__code" data-wrap={wrap}>
            <code>
              <CodeLines lines={lines} numbered />
            </code>
          </pre>
        </DialogBody>
      </Dialog>
    </div>
  );
}

function CodeLines({ lines, numbered = false }: { lines: CodeToken[][]; numbered?: boolean }) {
  return lines.map((line, i) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: the lines of one block, in order
    <span key={i} className={numbered ? "code-line code-line--numbered" : "code-line"}>
      {line.map((tok, j) =>
        tok.kind === "plain" ? (
          tok.text
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: the tokens of one line, in order
          <span key={j} className={`code-tok code-tok--${tok.kind}`}>
            {tok.text}
          </span>
        ),
      )}
      {"\n"}
    </span>
  ));
}

/** Copy, then "Copiado" with a check for a moment. */
function CopyCode({ text }: { text: string }) {
  const { t } = useTranslation();
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = () => {
    navigator.clipboard.writeText(text).then(
      () => {
        setDone(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setDone(false), 1400);
      },
      () => {},
    );
  };
  return (
    <Button
      variant="ghost"
      size="sm"
      icon={done ? "check" : "copy"}
      className="code-card__copy"
      data-done={done}
      aria-label={done ? t("common.copied") : t("common.copy")}
      title={t("common.copy")}
      onClick={copy}
    >
      <span className="code-card__copied" aria-hidden="true">
        {t("common.copied")}
      </span>
    </Button>
  );
}
