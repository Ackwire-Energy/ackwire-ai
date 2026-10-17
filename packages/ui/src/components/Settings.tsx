import { type ReactNode, useId } from "react";
import { cx } from "../cx";
import { Icon, type IconName } from "../icons/Icon";

/**
 * Settings in a dialog (telas/MissaoConfig.html): sections with a title and
 * one line, rows with a control on the right, quiet notes under a list, a
 * grouped list with hairline rows, and "Mais opções" folded by default. One
 * rhythm (8/12/16/24), body 14px, meta 13px, few boxes.
 */

export function SettingsSection({
  title,
  description,
  className,
  children,
}: {
  title?: ReactNode;
  description?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section className={cx("ac-setsec", className)} aria-labelledby={title ? id : undefined}>
      {(title || description) && (
        <div className="ac-setsec__head">
          {title && (
            <h3 className="ac-setsec__title" id={id}>
              {title}
            </h3>
          )}
          {description && <p className="ac-setsec__desc">{description}</p>}
        </div>
      )}
      {children}
    </section>
  );
}

/** A quiet line with an icon under a list (an example, a rule that always holds, a count, a lock reason). */
export function SettingNote({
  icon,
  quiet,
  live,
  children,
}: {
  icon: IconName;
  /** Fainter (a count). */
  quiet?: boolean;
  /** It changes with the choice above (announced politely, fades in). */
  live?: boolean;
  children: ReactNode;
}) {
  return (
    <p
      className={cx("ac-setnote", quiet && "ac-setnote--quiet", live && "ac-setnote--live")}
      aria-live={live ? "polite" : undefined}
    >
      <Icon name={icon} size={14} />
      <span>{children}</span>
    </p>
  );
}

/** A setting without a box: a title and one line on the left, its control (a switch, a button) on the right. */
export function SettingRow({
  title,
  description,
  htmlFor,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** The control's id: the title becomes its label. */
  htmlFor?: string;
  children?: ReactNode;
}) {
  return (
    <div className="ac-setrow">
      <span className="ac-setrow__text">
        {htmlFor ? (
          <label className="ac-setrow__title" htmlFor={htmlFor}>
            {title}
          </label>
        ) : (
          <b className="ac-setrow__title">{title}</b>
        )}
        {description && <small className="ac-setrow__desc">{description}</small>}
      </span>
      {children && <span className="ac-setrow__end">{children}</span>}
    </div>
  );
}

/** "Mais opções": a toggle that shows the advanced sections. */
export function SettingsMore({
  title,
  description,
  open,
  onOpenChange,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section className="ac-setsec ac-setmore">
      <button
        type="button"
        className="ac-setmore__toggle"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => onOpenChange(!open)}
      >
        <span className="ac-setmore__text">
          <b className="ac-setmore__title">{title}</b>
          {description && <small className="ac-setmore__desc">{description}</small>}
        </span>
        <Icon name="chevronDown" size={16} className="ac-setmore__chev" />
      </button>
      <div className="ac-setmore__body" id={id} hidden={!open}>
        {open && children}
      </div>
    </section>
  );
}
