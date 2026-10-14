import { Dialog as RDialog } from "radix-ui";
import { type ReactNode, useRef } from "react";
import { cx } from "../cx";
import { Button } from "./Button";

export interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Accessible name (also shown as the heading). */
  title: ReactNode;
  /** Before the title, e.g. a kind icon. */
  icon?: ReactNode;
  /** Under the title: who, where, when. */
  subtitle?: ReactNode;
  /** Header buttons before "Fechar" ("Baixar", "Copiar link"). */
  actions?: ReactNode;
  closeLabel: string;
  children: ReactNode;
  className?: string;
}

/**
 * Full-height side panel (Radix Dialog: focus trap, Esc, focus returns).
 * Used by the artifact viewer. Full screen on narrow viewports.
 */
export function Sheet({
  open,
  onOpenChange,
  title,
  icon,
  subtitle,
  actions,
  closeLabel,
  children,
  className,
}: SheetProps) {
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
          className={cx("ac-sheet", className)}
          aria-describedby={undefined}
          onCloseAutoFocus={(e) => {
            const target = returnTo.current;
            if (target?.isConnected) {
              e.preventDefault();
              target.focus();
            }
          }}
        >
          <div className="ac-sheet__head">
            {icon && <span className="ac-sheet__icon">{icon}</span>}
            <div className="ac-sheet__heading">
              <RDialog.Title className="ac-sheet__title">{title}</RDialog.Title>
              {subtitle && <span className="ac-sheet__subtitle">{subtitle}</span>}
            </div>
            <div className="ac-sheet__actions">
              {actions}
              <RDialog.Close asChild>
                <Button variant="ghost" size="sm" iconOnly icon="close" aria-label={closeLabel} />
              </RDialog.Close>
            </div>
          </div>
          <div className="ac-sheet__body">{children}</div>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}
