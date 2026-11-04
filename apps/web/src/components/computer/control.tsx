import { Button, isApple, onScreenKeyboard, Textarea } from "@agenteschat/ui";
import {
  type ClipboardEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { aimsAtScreen } from "@/lib/keys";
import { useDialogHead } from "./head";

/** What the stage takes while watching (`useAskControl`): none of it otherwise. */
export interface AskStage {
  tabIndex?: number;
  onPointerDownCapture?: (e: PointerEvent<HTMLElement>) => void;
  onPointerUp?: (e: PointerEvent<HTMLElement>) => void;
  onPointerCancel?: () => void;
  onKeyDown?: (e: KeyboardEvent<HTMLElement>) => void;
  onPaste?: (e: ClipboardEvent<HTMLElement>) => void;
}

/** A finger that moves farther than this between down and up scrolled, it didn't tap. */
const TAP_SLOP_PX = 12;

/** What on the stage keeps its own keys and clicks: the question's buttons, a field. */
const OWN_INPUT = 'button,a,input,textarea,select,[contenteditable="true"],[role="button"],[role="textbox"]';

/**
 * Watching the agent's screen or page in the computer dialog: a click, a tap, a key or a paste on it asks "Quer
 * assumir o controle?" and sends nothing there. The question stays through more clicks and keys, so the person
 * knows they aren't in control; only Cancelar, Esc or taking control close it, and the next try asks again. Keys
 * count only with the focus on the stage (a click on it puts it there), and shortcuts stay the browser's
 * (`aimsAtScreen`). `offer`: watching, live, and nothing else in the way.
 */
export function useAskControl(offer: boolean) {
  const head = useDialogHead();
  const [asking, setAsking] = useState(false);
  const tapAt = useRef<{ x: number; y: number } | null>(null);
  const cancel = useCallback(() => setAsking(false), []);
  useEffect(() => {
    if (!offer) setAsking(false);
  }, [offer]);
  const open = asking && offer;
  const setAsk = head?.setAsk;
  useEffect(() => {
    if (!open) return;
    setAsk?.(cancel);
    return () => setAsk?.(null);
  }, [open, setAsk, cancel]);
  const own = (target: EventTarget) => target instanceof Element && target.closest(OWN_INPUT) !== null;
  const stage: AskStage = offer
    ? {
        tabIndex: 0,
        onPointerDownCapture: (e: PointerEvent<HTMLElement>) => {
          if (own(e.target)) return;
          if (e.pointerType === "touch") {
            tapAt.current = { x: e.clientX, y: e.clientY };
            return;
          }
          if (e.button !== 0) return;
          e.currentTarget.focus({ preventScroll: true });
          setAsking(true);
        },
        onPointerUp: (e: PointerEvent<HTMLElement>) => {
          const at = tapAt.current;
          tapAt.current = null;
          if (e.pointerType === "touch" && at && Math.hypot(e.clientX - at.x, e.clientY - at.y) < TAP_SLOP_PX)
            setAsking(true);
        },
        onPointerCancel: () => {
          tapAt.current = null;
        },
        onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
          if (own(e.target) || !aimsAtScreen(e.nativeEvent, isApple())) return;
          e.preventDefault();
          setAsking(true);
        },
        onPaste: (e: ClipboardEvent<HTMLElement>) => {
          if (own(e.target)) return;
          e.preventDefault();
          setAsking(true);
        },
      }
    : {};
  return { asking: open, cancel, stage };
}

/** The question's buttons: take control (when this person may), and Cancelar beside it (Fechar when it only says so). */
export function AskActions({ take, onCancel }: { take?: ReactNode; onCancel: () => void }) {
  const { t } = useTranslation();
  return (
    <span className="brw-dim__acts">
      {take}
      <Button size="sm" variant="ghost" onClick={onCancel}>
        {take ? t("common.cancel") : t("common.close")}
      </Button>
    </span>
  );
}

/**
 * Pronto or Devolver, under the screen or the page: one quiet row, the button focused (Enter hands back), and "Deixar
 * um recado" for a word to the agent, which it reads as the person's own. The note opens by itself where the request
 * asked the person something (`handoffWantsWords`). Open, it is one line that grows as it wraps (`.brw-ac__note`);
 * Enter hands back as in the chat, while Shift+Enter, an input method's Enter and a phone's return key add a line.
 */
export function HandBackFoot({
  title,
  label,
  grammar,
  note,
  onNote,
  noteFirst,
  pending,
  onBack,
  onCancel,
}: {
  title: string;
  label: string;
  grammar: { name: string; context?: string };
  /** Absent: no note (a shared profile goes back to its agents, not to one). */
  note?: string;
  onNote?: (note: string) => void;
  /** The note open from the start. */
  noteFirst: boolean;
  pending: boolean;
  onBack: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [writing, setWriting] = useState(noteFirst && note !== undefined);
  const noted = writing && note !== undefined;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Esc anywhere in the row goes back to control
    <div
      className="brw-ac__foot brw-ac__fail brw-ac__back"
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel();
      }}
    >
      {noted && (
        <>
          <b>{title}</b>
          <Textarea
            rows={1}
            autoGrow
            className="brw-ac__note"
            autoFocus
            value={note}
            onChange={(e) => onNote?.(e.target.value)}
            placeholder={t("browser.inCard.backPlaceholder", grammar)}
            aria-label={t("browser.inCard.backLabel", grammar)}
            maxLength={1000}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing || onScreenKeyboard()) return;
              e.preventDefault();
              onBack();
            }}
          />
        </>
      )}
      <div className="brw-ac__row">
        {!noted && <b>{title}</b>}
        {!noted && note !== undefined && (
          <button type="button" className="ac-link ac-link--muted brw-ac__add" onClick={() => setWriting(true)}>
            {t("browser.inCard.addNote")}
          </button>
        )}
        <span className="brw-grow" />
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t("browser.live.back")}
        </Button>
        <Button size="sm" variant="primary" icon="check" autoFocus={!noted} loading={pending} onClick={onBack}>
          {label}
        </Button>
      </div>
    </div>
  );
}
