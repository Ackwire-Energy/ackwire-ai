import { useAgents, useComputerSetup, useMachines, useSandboxSettings } from "@agenteschat/client";
import { setupView } from "@agenteschat/client/lib/computer";
import { can } from "@agenteschat/client/lib/permissions";
import { Button, ComputerPortrait, Icon, Popover, ProviderLogo } from "@agenteschat/ui";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AgentComputersCard, CloudComputerCard } from "@/components/AgentComputer";
import { LoadingCards } from "@/components/Loading";
import { DownloadMacButton, MachinesSection } from "@/components/Machines";
import { useOrg } from "@/components/org-context";
import { WorkspaceComputerCard } from "@/components/WorkspaceComputer";

/**
 * Configurações → Computadores: one section for the
 * two places agents work. The two kinds side by side, the cloud computer's
 * settings (admins), your own computers, and which computer each agent uses.
 * Where the workspace gets its own computer (ADR 0056 §10), its card takes the cloud's place.
 */
export function ComputersSection() {
  const { org } = useOrg();
  const setup = useComputerSetup(org.id);
  const view = setupView(setup.data);
  // Not the cloud's cards for a moment before the workspace's own computer.
  if (setup.isLoading) return <LoadingCards count={2} />;
  if (view) {
    return (
      <>
        <WorkspaceComputerCard view={view} />
        <MachinesSection />
        <AgentComputersCard />
      </>
    );
  }
  return (
    <>
      <ComputerKinds />
      {can(org.role, "configure") && <CloudComputerCard />}
      <MachinesSection />
      <AgentComputersCard />
    </>
  );
}

const POINTS = ["point1", "point2", "point3"] as const;

/** "Na nuvem" and "No seu computador": what each is, how many agents use it, and the way to set it up. */
function ComputerKinds() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const admin = can(org.role, "configure");
  const agents = useAgents(org.id);
  const machines = useMachines(org.id);
  const settings = useSandboxSettings(org.id, admin);
  const list = machines.data ?? [];
  // Each computer says which agents use it; every other agent is on the cloud.
  const onMine = new Set(list.flatMap((m) => m.agents.map((a) => a.id)));
  const total = agents.data?.length ?? 0;
  const mine = (agents.data ?? []).filter((a) => onMine.has(a.id)).length;
  const cloudOff = settings.data ? !settings.data.enabled || !settings.data.available : false;
  const count = (n: number) => (
    <li>
      <Icon name="agent" size={14} />
      <b className="ac-num">{n}</b> {t("computers.kinds.agentsUse", { count: n })}
    </li>
  );
  return (
    <section className="computers-kinds" aria-label={t("computers.kinds.label")}>
      <div className="computers-kind">
        <div className="computers-kind__pic">
          <ComputerPortrait kind="cloud" state={cloudOff ? "offline" : "online"} size={96} />
        </div>
        <div className="computers-kind__head">
          <h3 className="computers-kind__title">{t("computers.kinds.cloud.title")}</h3>
          {agents.data && <KindInfo where={t("computers.kinds.cloud.title")}>{count(total - mine)}</KindInfo>}
        </div>
        <ul className="computers-kind__points">
          {POINTS.map((p) => (
            <li key={p}>
              <Icon name="check" size={14} />
              {t(`computers.kinds.cloud.${p}`)}
            </li>
          ))}
        </ul>
        <div className="computers-kind__foot">
          {admin && (
            <Button asChild size="sm">
              <a href="#nuvem">
                <Icon name="settings" />
                {t("computers.kinds.cloud.adjust")}
              </a>
            </Button>
          )}
        </div>
      </div>
      <div className="computers-kind">
        <div className="computers-kind__pic">
          <ComputerPortrait kind="mac" state={list.length > 0 ? "online" : "offline"} size={96} />
        </div>
        <div className="computers-kind__head">
          <h3 className="computers-kind__title">{t("computers.kinds.mine.title")}</h3>
          {machines.isSuccess && (
            <KindInfo where={t("computers.kinds.mine.title")}>
              {list.length > 0 ? (
                <>
                  <li>
                    <Icon name="check" size={14} />
                    <b className="ac-num">{list.length}</b>{" "}
                    {t("computers.kinds.mine.connected", { count: list.length })}
                  </li>
                  {agents.data && count(mine)}
                </>
              ) : (
                <li>
                  <Icon name="dash" size={14} />
                  {t("computers.kinds.mine.none")}
                </li>
              )}
            </KindInfo>
          )}
        </div>
        <ul className="computers-kind__points">
          {POINTS.map((p) => (
            <li key={p}>
              {/* The point that names Claude Code carries its mark. */}
              {p === "point3" ? <ProviderLogo id="claude_code" size="xs" /> : <Icon name="check" size={14} />}
              {t(`computers.kinds.mine.${p}`)}
            </li>
          ))}
        </ul>
        <div className="computers-kind__foot">
          <DownloadMacButton primary={machines.isSuccess && list.length === 0} />
        </div>
      </div>
    </section>
  );
}

/** The ⓘ beside a kind's title: how many computers and agents use it (no chips on the card). */
function KindInfo({ where, children }: { where: string; children: ReactNode }) {
  const { t } = useTranslation();
  const label = t("computers.kinds.details", { where });
  return (
    <Popover
      label={label}
      side="bottom"
      align="start"
      trigger={<Button size="sm" variant="ghost" iconOnly icon="info" aria-label={label} title={label} />}
    >
      <ul className="computers-kind__info">{children}</ul>
    </Popover>
  );
}
