import type { ControlAgent, ControlStatus } from "@agenteschat/adapters/runner-control";
import {
  type AgentState,
  Avatar,
  Chip,
  ComputerPortrait,
  type ComputerState,
  CountChip,
  type Expression,
  Icon,
  type IconName,
  normalizeAppearance,
} from "@agenteschat/ui";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * An organization's tile: its logo when it has one (a `data:` URL from the runner), otherwise its
 * first letter on ink, with the agent symbol's cut corner either way.
 */
export function OrgTile({
  name,
  logo,
  size = "md",
}: {
  name: string;
  logo?: string | null;
  size?: "sm" | "md" | "lg";
}) {
  const [broken, setBroken] = useState<string | null>(null);
  if (logo && broken !== logo) {
    return (
      <img
        className="dk-org dk-org--logo"
        data-size={size}
        src={logo}
        alt=""
        aria-hidden="true"
        draggable={false}
        onError={() => setBroken(logo)}
      />
    );
  }
  return (
    <span className="dk-org" data-size={size} aria-hidden="true">
      {(name.trim()[0] ?? "?").toUpperCase()}
    </span>
  );
}

/** An agent drawn by the shared engine, from the look the server sends with the agents frame. */
export function AgentFace({
  agent,
  size = "sm",
  state,
  expression,
}: {
  agent: { name: string; look?: ControlAgent["look"] };
  size?: "xs" | "sm" | "md" | "lg";
  state?: AgentState;
  expression?: Expression;
}) {
  return (
    <Avatar
      kind="agent"
      name={agent.name}
      size={size}
      appearance={normalizeAppearance(agent.look)}
      state={state}
      expression={expression}
    />
  );
}

/** The app's own mark (the sky agent). */
export function BrandFace({ size = "sm", state }: { size?: "xs" | "sm" | "md" | "lg" | "xl"; state?: AgentState }) {
  return <Avatar kind="agent" name="agentes" size={size} appearance={{ color: "sky" }} state={state} />;
}

/** This Mac's portrait: the screen lit, dimmed (paused) or dark (offline). */
export function MacPortrait({ state, size = 48 }: { state: ComputerState; size?: 48 | 96 | 144 }) {
  return <ComputerPortrait kind="mac" state={state} size={size} />;
}

/** A number with − and + (custom, never a native input). */
export function Stepper({
  value,
  min,
  max,
  onChange,
  label,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  label: string;
}) {
  const { t } = useTranslation();
  return (
    // biome-ignore lint/a11y/useSemanticElements: a custom stepper, labelled as a group
    <span className="dk-stepper" role="group" aria-label={label}>
      <button
        type="button"
        aria-label={t("desktop.common.less")}
        disabled={value <= min}
        onClick={() => onChange(Math.max(min, value - 1))}
      >
        <Icon name="dash" size={14} />
      </button>
      <output className="ac-num">{value}</output>
      <button
        type="button"
        aria-label={t("desktop.common.more")}
        disabled={value >= max}
        onClick={() => onChange(Math.min(max, value + 1))}
      >
        <Icon name="plus" size={14} />
      </button>
    </span>
  );
}

/** A raised note at the top of the popover (paused, offline, update, a request). */
export function Banner({
  icon,
  lead,
  title,
  children,
  actions,
  shimmer,
}: {
  icon?: IconName;
  /** In place of the icon (a pixel orbit, an agent). */
  lead?: ReactNode;
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  shimmer?: boolean;
}) {
  return (
    <div className="dk-banner">
      <div className="dk-banner__head">
        <span className="dk-logo dk-logo--soft">{lead ?? (icon ? <Icon name={icon} size={16} /> : null)}</span>
        <span className="dk-banner__text">
          <b className={shimmer ? "dk-shimmer" : undefined}>{title}</b>
          {children && <small>{children}</small>}
        </span>
      </div>
      {actions && <div className="dk-banner__acts">{actions}</div>}
    </div>
  );
}

/** A row of the popover's menu. */
export function MenuRow({
  icon,
  children,
  onClick,
  trailing,
  danger,
  expanded,
}: {
  icon: IconName;
  children: ReactNode;
  onClick: () => void;
  trailing?: ReactNode;
  danger?: boolean;
  expanded?: boolean;
}) {
  return (
    <button
      type="button"
      className="dk-mi"
      data-danger={danger || undefined}
      aria-expanded={expanded}
      onClick={onClick}
    >
      <Icon name={icon} size={16} />
      <span className="dk-mi__label">{children}</span>
      {trailing && <span className="dk-mi__end">{trailing}</span>}
    </button>
  );
}

/** A quiet count in Doto ("Agora 3"). */
export const Count = ({ n }: { n: number }) => (n > 0 ? <CountChip size="sm">{n}</CountChip> : null);

/** How an organization's connection reads, as a chip with an icon (never a colored dot). */
export function ConnectionChip({ status, running }: { status: ControlStatus | null; running: boolean }) {
  const { t } = useTranslation();
  if (!running || !status) return <Chip icon="spinner">{t("desktop.status.starting")}</Chip>;
  if (status.paused.paused) return <Chip icon="pause">{t("desktop.status.paused")}</Chip>;
  switch (status.connection) {
    case "online":
      return (
        <Chip icon="check" tone="done">
          {t("desktop.status.connected")}
        </Chip>
      );
    case "connecting":
      return <Chip icon="spinner">{t("desktop.status.connecting")}</Chip>;
    case "refused":
      return (
        <Chip icon="alert" tone="waiting">
          {t("desktop.status.refused")}
        </Chip>
      );
    case "outdated":
      return (
        <Chip icon="download" tone="waiting">
          {t("desktop.status.outdated")}
        </Chip>
      );
    default:
      return (
        <Chip icon="cloud" tone="waiting">
          {t("desktop.status.offline")}
        </Chip>
      );
  }
}
