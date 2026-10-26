import { Dialog as RDialog } from "radix-ui";
import { type CSSProperties, type ReactNode, useEffect, useRef } from "react";
import { cx } from "../cx";
import { Button } from "./Button";
import { SearchField } from "./Toolbar";

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  /** Optional sentence under the title (also the accessible description). */
  description?: ReactNode;
  /** Accessible name of the close button, e.g. "Fechar". */
  closeLabel: string;
  /** 440 (short forms) or 600 (lists, the default). */
  width?: number;
  children: ReactNode;
  className?: string;
  /** Esc pressed: call `preventDefault()` to keep the dialog open (e.g. close an inner pane first). */
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
  /** Before the title (an avatar). */
  leading?: ReactNode;
  /** A live line under the title (`aria-live`): what the dialog shows now. */
  subtitle?: ReactNode;
  /** The head's own actions, before the close button. */
  actions?: ReactNode;
}

/**
 * Modal dialog (Radix Dialog: focus trap, Esc, focus returns to the trigger,
 * portal, `aria-modal`). Our visuals: radius-lg, overlay shadow, scrim.
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  closeLabel,
  width = 600,
  children,
  className,
  onEscapeKeyDown,
  leading,
  subtitle,
  actions,
}: DialogProps) {
  // Controlled dialogs have no Radix Trigger to return focus to, so remember
  // what had focus when it opened and give focus back on close.
  const wasOpen = useRef(false);
  const returnTo = useRef<HTMLElement | null>(null);
  if (open && !wasOpen.current && typeof document !== "undefined") {
    returnTo.current = document.activeElement as HTMLElement | null;
  }
  wasOpen.current = open;
  // Toasts float over the dialog: pressing one isn't pressing outside it, which would close it. Read as the press
  // starts, since a toast's own button can remove the toast before Radix looks, at the click.
  const onToast = useRef(false);
  useEffect(() => {
    if (!open) return;
    const pressed = (e: PointerEvent) => {
      onToast.current = e.target instanceof Element && e.target.closest(".ac-toasts") !== null;
    };
    document.addEventListener("pointerdown", pressed, true);
    return () => document.removeEventListener("pointerdown", pressed, true);
  }, [open]);
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="ac-dialog__scrim" />
        <RDialog.Content
          className={cx("ac-dialog", className)}
          style={{ "--ac-dialog-width": `${width}px` } as CSSProperties}
          onEscapeKeyDown={onEscapeKeyDown}
          onPointerDownOutside={(e) => {
            if (onToast.current) e.preventDefault();
          }}
          onCloseAutoFocus={(e) => {
            const target = returnTo.current;
            if (target?.isConnected) {
              e.preventDefault();
              target.focus();
            }
          }}
          // Without a description, tell Radix there is none (it warns otherwise).
          {...(description ? {} : { "aria-describedby": undefined })}
        >
          <div className="ac-dialog__head">
            {leading}
            {subtitle === undefined ? (
              <RDialog.Title className="ac-dialog__title">{title}</RDialog.Title>
            ) : (
              <span className="ac-dialog__titles">
                <RDialog.Title className="ac-dialog__title">{title}</RDialog.Title>
                <span className="ac-dialog__sub" aria-live="polite">
                  {subtitle}
                </span>
              </span>
            )}
            {actions}
            <RDialog.Close asChild>
              <Button variant="ghost" size="sm" iconOnly icon="close" aria-label={closeLabel} />
            </RDialog.Close>
          </div>
          {description && <RDialog.Description className="ac-dialog__desc">{description}</RDialog.Description>}
          {children}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

export function DialogBody({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cx("ac-dialog__body", className)} {...rest} />;
}

export function DialogFooter({
  note,
  bar,
  className,
  children,
}: {
  note?: ReactNode;
  /** Footer separated by a line (lists). */
  bar?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div className={cx("ac-dialog__foot", bar && "ac-dialog__foot--bar", className)}>
      {note !== undefined && <span className="ac-dialog__foot-note">{note}</span>}
      {children}
    </div>
  );
}

export interface DialogSearchListProps {
  query: string;
  onQueryChange: (query: string) => void;
  searchLabel: string;
  searchPlaceholder?: string;
  /** Shown instead of the list when nothing matches. */
  emptyText: ReactNode;
  isEmpty: boolean;
  children: ReactNode;
  listLabel?: string;
  /** False hides the search field (a short list doesn't need one). */
  search?: boolean;
}

/** The searchable-list variant: search box on top, scrolling list, empty message. */
export function DialogSearchList({
  query,
  onQueryChange,
  searchLabel,
  searchPlaceholder,
  emptyText,
  isEmpty,
  children,
  listLabel,
  search = true,
}: DialogSearchListProps) {
  return (
    <>
      {search && (
        <div className="ac-dialog__tools">
          <SearchField
            size="sm"
            aria-label={searchLabel}
            placeholder={searchPlaceholder}
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
          />
        </div>
      )}
      {/* biome-ignore lint/a11y/useSemanticElements: a scroll region, not a fieldset */}
      <div className="ac-dialog__list" role="region" aria-label={listLabel}>
        {isEmpty ? <p className="ac-dialog__empty">{emptyText}</p> : children}
      </div>
    </>
  );
}
