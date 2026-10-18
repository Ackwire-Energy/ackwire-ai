import { useAgents, useMachines, useSandboxSettings } from "@agenteschat/client";
import { can } from "@agenteschat/client/lib/permissions";
import { Button, Chip, ComputerPortrait, Icon } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { AgentComputersCard, CloudComputerCard } from "@/components/AgentComputer";
import { DownloadMacButton, MachinesSection } from "@/components/Machines";
import { useOrg } from "@/components/org-context";

/**
 * Configurações → Computadores (telas/Computadores.html): one section for the
 * two places agents work. The two kinds side by side, the cloud computer's
 * settings (admins), your own computers, and which computer each agent uses.
 */
export function ComputersSection() {
  const { org } = useOrg();
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
    <Chip icon="agent" lead={<span className="ac-num">{n}</span>}>
      {t("computers.kinds.agentsUse", { count: n })}
    </Chip>
  );
  return (
    <section className="computers-kinds" aria-label={t("computers.kinds.label")}>
      <div className="computers-kind">
        <div className="computers-kind__pic">
          <ComputerPortrait kind="cloud" state={cloudOff ? "offline" : "online"} size={96} />
        </div>
        <h3 className="computers-kind__title">{t("computers.kinds.cloud.title")}</h3>
        <ul className="computers-kind__points">
          {POINTS.map((p) => (
            <li key={p}>
              <Icon name="check" size={14} />
              {t(`computers.kinds.cloud.${p}`)}
            </li>
          ))}
        </ul>
        <div className="computers-kind__foot">
          {agents.data && count(total - mine)}
          <span className="computers-kind__grow" />
          {admin && (
            <Button asChild size="sm" variant="ghost">
              <a href="#nuvem">
                {t("computers.kinds.cloud.adjust")}
                <Icon name="chevronDown" />
              </a>
            </Button>
          )}
        </div>
      </div>
      <div className="computers-kind">
        <div className="computers-kind__pic">
          <ComputerPortrait kind="mac" state={list.length > 0 ? "online" : "offline"} size={96} />
        </div>
        <h3 className="computers-kind__title">{t("computers.kinds.mine.title")}</h3>
        <ul className="computers-kind__points">
          {POINTS.map((p) => (
            <li key={p}>
              <Icon name="check" size={14} />
              {t(`computers.kinds.mine.${p}`)}
            </li>
          ))}
        </ul>
        <div className="computers-kind__foot">
          {list.length > 0 ? (
            <>
              <Chip icon="check">
                <span className="ac-num">{list.length}</span>
                {t("computers.kinds.mine.connected", { count: list.length })}
              </Chip>
              {agents.data && count(mine)}
            </>
          ) : (
            machines.isSuccess && <Chip icon="dash">{t("computers.kinds.mine.none")}</Chip>
          )}
          <span className="computers-kind__grow" />
          <DownloadMacButton primary={machines.isSuccess && list.length === 0} />
        </div>
      </div>
    </section>
  );
}
