import { type AgentState, Avatar, CountBadge, cx, Icon, type IconName, Kbd } from "@agenteschat/ui";
import { type ReactNode, useRef } from "react";
import { useTranslation } from "react-i18next";
import { SidebarOrgSky } from "@/components/Sky";
import { CAST, type CastKey, type ChannelKey, ORGS, type OrgKey, PEOPLE } from "../cast";
import { LpAvatar } from "../LpAvatar";
import { OrgLogo } from "./OrgLogo";

type Tool = "notifications" | "approvals" | "threads" | "issues" | "wiki" | "drive" | "more";
const TOOL_ICON: Record<Tool, IconName> = {
  notifications: "bell",
  approvals: "waiting",
  threads: "thread",
  issues: "issues",
  wiki: "book",
  drive: "drive",
  more: "more",
};
const ALL_TOOLS: Tool[] = ["notifications", "approvals", "threads", "issues", "wiki", "drive", "more"];

export interface MockSidebarProps {
  org: OrgKey;
  channels: { key: ChannelKey; unread?: number }[];
  /** The open channel (highlighted). */
  active?: ChannelKey;
  /** Channels become buttons (the demo switches scenarios through them). */
  onChannel?: (key: ChannelKey) => void;
  agents: CastKey[];
  /** Live states of the agents ("trabalhando" instead of the role while not idle). */
  states?: Partial<Record<CastKey, AgentState>>;
  /** Which tools show above the channels (the hero shows none: it has no room). */
  tools?: Tool[];
  notifications?: number;
  approvals?: number;
  /** "Equipe" and the direct messages under the agents. */
  tail?: boolean;
  label: string;
  className?: string;
}

/**
 * The app's sidebar, drawn with its own classes (`.sidebar__*` from
 * layout.css) and sample data, so the landing page shows the product as it
 * is. It never scrolls: each use picks what fits.
 */
export function MockSidebar({
  org,
  channels,
  active,
  onChannel,
  agents,
  states = {},
  tools = ALL_TOOLS,
  notifications = 2,
  approvals = 0,
  tail = false,
  label,
  className,
}: MockSidebarProps) {
  const { t } = useTranslation();
  const orgRef = useRef<HTMLDivElement>(null);
  const company = ORGS[org];
  const count = (tool: Tool) => (tool === "notifications" ? notifications : tool === "approvals" ? approvals : 0);
  return (
    <aside className={cx("sidebar lp-mock-side", className)} aria-label={label}>
      <div className="sidebar__top">
        <div className="sidebar__org" ref={orgRef}>
          <SidebarOrgSky calm={() => [orgRef.current?.querySelector(".sidebar__org-text") ?? null]} />
          <span className="sidebar__org-button">
            <OrgLogo org={org} className="sidebar__org-mark" />
            <span className="sidebar__org-text">
              <span className="sidebar__org-name">{company.name}</span>
              <span className="sidebar__org-meta">
                {t("shell.summary", { count: company.people, people: company.people, agents: company.agents })}
              </span>
            </span>
            <Icon name="chevronDown" size={16} />
          </span>
        </div>
        <div className="sidebar__jump-row">
          <span className="sidebar__jump">
            <Icon name="search" />
            <span className="sidebar__item-label">{t("palette.jump")}</span>
            <Kbd>⌘</Kbd>
            <Kbd>K</Kbd>
          </span>
        </div>
      </div>

      <div className="sidebar__scroll">
        {tools.length > 0 && (
          <>
            <div className="sidebar__group sidebar__tools">
              {tools.map((tool) => (
                <span key={tool} className="sidebar__item">
                  <Icon name={TOOL_ICON[tool]} />
                  <span className="sidebar__item-label">{t(`shell.${tool}`)}</span>
                  {tool === "more" && <Icon name="chevronRight" size={16} className="sidebar__more-chevron" />}
                  {count(tool) > 0 && <CountBadge>{count(tool)}</CountBadge>}
                </span>
              ))}
            </div>
            <span className="sidebar__divider" aria-hidden="true" />
          </>
        )}

        <Section label={t("shell.channels")}>
          {channels.map(({ key, unread }) => {
            const inner = (
              <>
                <Icon name="channel" className="sidebar__channel-icon" />
                <span className="sidebar__item-label">{t(`landing.channel.${key}`)}</span>
                {unread ? <span className="sidebar__unread">{unread}</span> : null}
              </>
            );
            const status = key === active ? "active" : undefined;
            return onChannel ? (
              <button
                key={key}
                type="button"
                className="sidebar__item"
                data-status={status}
                aria-current={status ? "true" : undefined}
                onClick={() => onChannel(key)}
              >
                {inner}
              </button>
            ) : (
              <span key={key} className="sidebar__item" data-status={status}>
                {inner}
              </span>
            );
          })}
        </Section>

        <Section label={t("shell.agents")}>
          {agents.map((key) => {
            const state = states[key] ?? "idle";
            const busy = state !== "idle";
            return (
              <span key={key} className="sidebar__item" data-busy={busy}>
                <LpAvatar look={CAST[key].look} size="sm" state={state} name={CAST[key].name} />
                <span className="sidebar__item-label">{CAST[key].name}</span>
                {busy ? (
                  <span className="sidebar__item-meta sidebar__busy">
                    {t(state === "writing" ? "sky.busy.writing" : "sky.busy.thinking")}
                  </span>
                ) : (
                  <span className="sidebar__item-meta">{t(`landing.role.${CAST[key].role}`)}</span>
                )}
              </span>
            );
          })}
          {tail && (
            <span className="sidebar__item">
              <Icon name="agent" />
              <span className="sidebar__item-label">{t("shell.team")}</span>
            </span>
          )}
        </Section>

        {tail && (
          <Section label={t("shell.directMessages")}>
            <span className="sidebar__item">
              <Avatar name={PEOPLE.camila.name} initials={PEOPLE.camila.initials} size="sm" />
              <span className="sidebar__item-label">{PEOPLE.camila.short}</span>
            </span>
          </Section>
        )}
      </div>

      <div className="sidebar__foot">
        <span className="ac-btn ac-btn--block ac-btn--cut sidebar__create">
          <Icon name="plus" />
          <span className="sidebar__item-label">{t("shell.createAgent")}</span>
        </span>
        <div className="sidebar__me">
          <span className="sidebar__user">
            <Avatar name={PEOPLE.rafael.name} initials={PEOPLE.rafael.initials} size="sm" />
            <span className="sidebar__user-text">
              <span className="sidebar__user-name">{PEOPLE.rafael.short}</span>
              <span className="sidebar__usage" data-level="ok" aria-hidden="true">
                <span className="sidebar__usage-track">
                  <span className="sidebar__usage-bar" style={{ width: "63%" }} />
                </span>
                <span className="sidebar__usage-value">63%</span>
              </span>
            </span>
          </span>
        </div>
      </div>
    </aside>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="sidebar__group sidebar__section" data-open="true">
      <div className="sidebar__section-head">
        <span className="sidebar__section-toggle">
          <Icon name="chevronDown" size={14} className="sidebar__section-chevron" />
          <span className="sidebar__label">{label}</span>
        </span>
      </div>
      <div className="sidebar__section-body">{children}</div>
    </div>
  );
}
