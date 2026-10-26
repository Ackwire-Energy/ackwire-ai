import { Popover as RPopover } from "radix-ui";
import { type PointerEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Icon } from "../icons/Icon";

/** The app's own tooltip delay (`.ac-msg__tip`): a pointer resting this long on the ⓘ opens the hint. */
const OPEN_MS = 250;
/** Long enough for the pointer to cross from the ⓘ onto the bubble. */
const CLOSE_MS = 150;

/**
 * Whether the last input was a key rather than a press. Focus that a key brings opens a hint; focus that a press
 * brings opens nothing, since the press's own click decides, so one click never opens and closes it at once. A key
 * held with ⌘, Ctrl or Alt is a shortcut, not a move.
 */
let lastInputKey = false;
let tracking = false;
function trackLastInput() {
  if (tracking) return;
  tracking = true;
  document.addEventListener(
    "keydown",
    (e) => {
      if (!e.metaKey && !e.ctrlKey && !e.altKey) lastInputKey = true;
    },
    true,
  );
  document.addEventListener(
    "pointerdown",
    () => {
      lastInputKey = false;
    },
    true,
  );
}

/** Why the hint is open: a resting pointer, keyboard focus, or a press that pinned it. */
type Why = "hover" | "focus" | "pin" | null;

export interface InfoHintProps {
  /** The ⓘ's accessible name, translated: `t("common.about", { label })` → "About Time zone". */
  name: string;
  /** The hint: plain sentences only (no links, buttons or lists). */
  children: ReactNode;
  /** The id of the always-present description, for a control's `aria-describedby` (default: generated). */
  id?: string;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
}

/**
 * An ⓘ beside a label with the setting's explanation in a bubble. A mouse or pen resting on it opens it, keyboard
 * focus opens it at once, and a click, a tap, Enter or Space pins it open (a second one closes it); Escape or a
 * press elsewhere closes it. Its text is always in the page, hidden, so the ⓘ (and the control, through `id`) is
 * described by it while the bubble is closed. Put the label and the ⓘ in one `.ac-hintline`.
 */
export function InfoHint({ name, children, id, side = "top", align = "center" }: InfoHintProps) {
  const generated = useId();
  const hintId = id ?? `hint${generated.replace(/[^\w-]/g, "")}`;
  const [why, setWhy] = useState<Why>(null);
  const anchor = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    trackLastInput();
    return () => clearTimeout(timer.current);
  }, []);
  const after = (ms: number, next: (why: Why) => Why) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setWhy(next), ms);
  };
  // Mouse and pen only: a touch opens it with its tap.
  const enter = (e: PointerEvent) => {
    if (e.pointerType !== "touch") after(OPEN_MS, (w) => w ?? "hover");
  };
  const leave = (e: PointerEvent) => {
    if (e.pointerType !== "touch") after(CLOSE_MS, (w) => (w === "hover" ? null : w));
  };
  // A press on the ⓘ is decided by its own click, not taken for a press outside the bubble.
  const onAnchor = (e: Event) => {
    if (e.target instanceof Node && anchor.current?.contains(e.target)) e.preventDefault();
  };
  return (
    <RPopover.Root
      open={why !== null}
      onOpenChange={(open) => {
        if (open) return;
        clearTimeout(timer.current);
        setWhy(null);
      }}
    >
      <RPopover.Anchor asChild>
        <button
          ref={anchor}
          type="button"
          className="ac-hint"
          aria-label={name}
          aria-describedby={hintId}
          data-state={why ? "open" : "closed"}
          onPointerEnter={enter}
          onPointerLeave={leave}
          onFocus={() => {
            if (!lastInputKey) return;
            clearTimeout(timer.current);
            setWhy((w) => (w === "pin" ? w : "focus"));
          }}
          onBlur={() => setWhy((w) => (w === "focus" ? null : w))}
          onClick={() => {
            clearTimeout(timer.current);
            setWhy((w) => (w === "pin" ? null : "pin"));
          }}
        >
          <Icon name="info" size={14} />
        </button>
      </RPopover.Anchor>
      <span id={hintId} hidden>
        {children}
      </span>
      <RPopover.Portal>
        <RPopover.Content
          role="tooltip"
          className="ac-hint__bubble ac-glass"
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={8}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          onPointerDownOutside={onAnchor}
          onFocusOutside={onAnchor}
          onPointerEnter={enter}
          onPointerLeave={leave}
        >
          {children}
        </RPopover.Content>
      </RPopover.Portal>
    </RPopover.Root>
  );
}
