import { Dialog as RDialog } from "radix-ui";
import { type ReactNode, useRef } from "react";
import { cx } from "../cx";
import { Icon } from "../icons/Icon";
import { Button } from "./Button";
import { CountChip } from "./Chip";

export interface DetailsDialogPageLink {
  /** "Abrir em página própria". */
  label: string;
  /**
   * Draws the link (the app's router link): it gets the class, the label as
   * `aria-label`/`title`, and the icon as children. Without it, `onOpen`.
   */
  render?: (props: { className: string; "aria-label": string; title: string; children: ReactNode }) => ReactNode;
  onOpen?: () => void;
}

export interface DetailsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Accessible name and the heading. */
  title: ReactNode;
  /** Above the title, on the bar with the buttons: "#6", "Rotina", a kind chip. */
  eyebrow?: ReactNode;
  /** Before the title (a kind icon, an avatar). */
  icon?: ReactNode;
  /** Under the title: where, who, when. */
  subtitle?: ReactNode;
  /** Header buttons before "abrir em página própria" and close ("Baixar", "Editar"). */
  actions?: ReactNode;
  /** "Abrir em página própria": the item's own page. */
  page?: DetailsDialogPageLink;
  closeLabel: string;
  /**
   * 720 (reading width, the default), 960 (diffs; an item laid out as its own page) or `xl`, most of the window with a
   * margin all round (a file, a page or a picture to look at).
   */
  size?: "md" | "lg" | "xl";
  /** Always the full height: tabs or sections that change inside never make it grow or shrink. */
  fill?: boolean;
  /**
   * The content draws the heading itself (an item laid out as its own page, its title edited in place): the title
   * stays the dialog's name, hidden from sight, and the header keeps only its bar.
   */
  titleHidden?: boolean;
  /** A fixed bar at the bottom (primary actions). */
  footer?: ReactNode;
  /**
   * A column on the right, the dialog's full height, beside the details (a task's conversation): the dialog widens
   * for it. On a narrow window it takes the whole dialog.
   */
  side?: ReactNode;
  children: ReactNode;
  className?: string;
  /**
   * Escape, before the dialog closes: `preventDefault()` keeps it open (an
   * inner step to back out of first, like a reason being typed).
   */
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
}

/**
 * The one way an item's details open (issues, Drive, routines, threads,
 * missions, skills, files): a centered modal at a comfortable reading width
 * with its own scroll, a header (eyebrow, "abrir em página própria", close)
 * and the scrim. Radix Dialog: focus trap, Esc, focus returns to what opened
 * it, `aria-modal`. On a phone it is a full-screen sheet. The page keeps the
 * open item in its URL (the caller's search param).
 */
export function DetailsDialog({
  open,
  onOpenChange,
  title,
  eyebrow,
  icon,
  subtitle,
  actions,
  page,
  closeLabel,
  size = "md",
  fill = false,
  titleHidden = false,
  footer,
  side,
  children,
  className,
  onEscapeKeyDown,
}: DetailsDialogProps) {
  // Controlled: no Radix Trigger to return focus to, so remember it.
  const wasOpen = useRef(false);
  const returnTo = useRef<HTMLElement | null>(null);
  if (open && !wasOpen.current && typeof document !== "undefined") {
    returnTo.current = document.activeElement as HTMLElement | null;
  }
  wasOpen.current = open;
  const inline = !eyebrow && !titleHidden;
  const heading = titleHidden ? (
    <RDialog.Title className="ac-visually-hidden">{title}</RDialog.Title>
  ) : (
    <div className="ac-details__heading">
      {icon && <span className="ac-details__icon">{icon}</span>}
      <div className="ac-details__titles">
        <RDialog.Title className="ac-details__title">{title}</RDialog.Title>
        {subtitle && <div className="ac-details__subtitle">{subtitle}</div>}
      </div>
    </div>
  );
  const pageIcon = <Icon name="external" size={16} />;
  const pageClass = "ac-btn ac-btn--ghost ac-btn--sm ac-btn--icon";
  const main = (
    <>
      <div className="ac-details__head">
        {/* With no eyebrow, the heading takes the bar's empty start, beside the buttons, instead of a row of its own. */}
        <div className={cx("ac-details__bar", inline && "ac-details__bar--titled")}>
          {inline ? heading : <span className="ac-details__eyebrow">{eyebrow}</span>}
          <div className="ac-details__actions ac-acts">
            {actions}
            {page &&
              (page.render ? (
                page.render({
                  className: pageClass,
                  "aria-label": page.label,
                  title: page.label,
                  children: pageIcon,
                })
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  icon="external"
                  aria-label={page.label}
                  title={page.label}
                  onClick={page.onOpen}
                />
              ))}
            {/* With a side column, its own close is the one at the top right (Esc and the scrim still close). */}
            {!side && (
              <RDialog.Close asChild>
                <Button variant="ghost" size="sm" iconOnly icon="close" aria-label={closeLabel} title={closeLabel} />
              </RDialog.Close>
            )}
          </div>
        </div>
        {!inline && heading}
      </div>
      <div className="ac-details__body">{children}</div>
      {footer && <div className="ac-details__foot">{footer}</div>}
    </>
  );
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="ac-dialog__scrim" />
        <RDialog.Content
          className={cx(
            "ac-details",
            size !== "md" && `ac-details--${size}`,
            fill && "ac-details--fill",
            side ? "ac-details--side" : undefined,
            className,
          )}
          aria-describedby={undefined}
          onEscapeKeyDown={onEscapeKeyDown}
          onCloseAutoFocus={(e) => {
            const target = returnTo.current;
            if (target?.isConnected) {
              e.preventDefault();
              target.focus();
            }
          }}
        >
          {side ? (
            <>
              <div className="ac-details__main">{main}</div>
              <div className="ac-details__side">{side}</div>
            </>
          ) : (
            main
          )}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

/**
 * A block of a details dialog ("Origem", "Pessoas", "Versões"): an eyebrow
 * title (with an optional count and actions on its right) over the content,
 * one divider above with room on both sides. Every details dialog uses it,
 * so the sections line up the same way everywhere.
 */
export function DetailsSection({
  title,
  count,
  actions,
  label,
  className,
  children,
}: {
  title?: ReactNode;
  count?: number;
  actions?: ReactNode;
  /** Accessible name of the region (the title is used when it is a string). */
  label?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={cx("ac-details__section", className)}
      aria-label={label ?? (typeof title === "string" ? title : undefined)}
    >
      {title && (
        <h3 className="ac-details__section-title">
          <span>{title}</span>
          {count !== undefined && <CountChip size="sm">{count}</CountChip>}
          {actions && <span className="ac-details__section-actions">{actions}</span>}
        </h3>
      )}
      {children}
    </section>
  );
}
