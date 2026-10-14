import { Dialog as RDialog } from "radix-ui";
import { type CSSProperties, type ReactNode, useRef } from "react";
import { cx } from "../cx";
import { Button } from "./Button";
import { SearchInput } from "./Field";

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
}: DialogProps) {
  // Controlled dialogs have no Radix Trigger to return focus to, so remember
  // what had focus when it opened and give focus back on close.
  const wasOpen = useRef(false);
  const returnTo = useRef<HTMLElement | null>(null);
  if (open && !wasOpen.current && typeof document !== "undefined") {
    returnTo.current = document.activeElement as HTMLElement | null;
  }
  wasOpen.current = open;
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="ac-dialog__scrim" />
        <RDialog.Content
          className={cx("ac-dialog", className)}
          style={{ "--ac-dialog-width": `${width}px` } as CSSProperties}
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
            <RDialog.Title className="ac-dialog__title">{title}</RDialog.Title>
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
}: DialogSearchListProps) {
  return (
    <>
      <div className="ac-dialog__tools">
        <SearchInput
          aria-label={searchLabel}
          placeholder={searchPlaceholder}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
        />
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: a scroll region, not a fieldset */}
      <div className="ac-dialog__list" role="region" aria-label={listLabel}>
        {isEmpty ? <p className="ac-dialog__empty">{emptyText}</p> : children}
      </div>
    </>
  );
}
