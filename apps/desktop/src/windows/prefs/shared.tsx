import type { ReactNode } from "react";

/** A tab's heading: title in Funnel Display, one line under it, an action on the right. */
export function PrefHead({ title, lead, action }: { title: string; lead: ReactNode; action?: ReactNode }) {
  return (
    <div className="dk-phead">
      <div>
        <h2>{title}</h2>
        <p className="dk-lead">{lead}</p>
      </div>
      {action}
    </div>
  );
}

/** The small uppercase title over a card. */
export const CardTitle = ({ children }: { children: ReactNode }) => <h3 className="dk-ctitle">{children}</h3>;

/** A neutral card of rows (never tinted by state). */
export const PrefCard = ({ children, padded }: { children: ReactNode; padded?: boolean }) => (
  <div className="dk-card" data-padded={padded || undefined}>
    {children}
  </div>
);

/** One row: optional lead, a title with one line under it, the control at the end. */
export function PrefRow({
  lead,
  title,
  desc,
  end,
  htmlFor,
  top,
  under,
}: {
  lead?: ReactNode;
  title: ReactNode;
  desc?: ReactNode;
  end?: ReactNode;
  /** The control's id: the title becomes its label. */
  htmlFor?: string;
  top?: boolean;
  /** A full-width line under the row (a warning). */
  under?: ReactNode;
}) {
  return (
    <div className="dk-crow" data-top={top || undefined}>
      {lead}
      <span className="dk-crow__text">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="dk-crow__title">
            {title}
          </label>
        ) : (
          <b className="dk-crow__title">{title}</b>
        )}
        {desc && <small>{desc}</small>}
      </span>
      {end && <span className="dk-crow__end">{end}</span>}
      {under && <div className="dk-crow__under">{under}</div>}
    </div>
  );
}
