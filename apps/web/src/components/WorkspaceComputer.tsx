import type { Machine } from "@agenteschat/client";
import { useAgents, useComputerSetup, useMachines } from "@agenteschat/client";
import {
  agentsWaitingForComputer,
  managedTitle,
  SETUP_STEPS,
  type SetupView,
  setupNoticeKey,
  setupPending,
  setupPortrait,
  setupView,
} from "@agenteschat/client/lib/computer";
import { joinNames } from "@agenteschat/client/lib/format";
import {
  Button,
  Card,
  Chip,
  ComputerIcon,
  ComputerPortrait,
  Icon,
  type IconName,
  Spinner,
  Steps,
} from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { STORAGE_KEYS, storage } from "@/lib/storage";

/**
 * The workspace's own computer (ADR 0056 §10), where a provisioner prepares one for each workspace: how far it
 * is, live from `machine.provisioning`. Words only a person needs: no system, address, provider or tool list.
 */

/** This workspace's computer on its way, or null where people connect their own (`pair`). */
export function useSetupView(orgId: string, pollMs: number | false = false): SetupView | null {
  return setupView(useComputerSetup(orgId, true, pollMs).data);
}

const PHASE_ICON: Record<SetupView["phase"], IconName> = {
  preparing: "spinner",
  waiting: "waiting",
  problem: "alert",
  ready: "check",
};

/** While it's on its way: the four steps as bars ("Passo 2 de 4 · Ligando"), or why it waits, in one line. */
export function SetupProgress({ view }: { view: SetupView }) {
  const { t } = useTranslation();
  if (view.step) {
    return (
      <div className="setup-progress" role="status">
        <Steps
          current={view.stepNumber}
          total={SETUP_STEPS.length}
          label={t("computerSetup.stepOf", { n: view.stepNumber, total: SETUP_STEPS.length, step: t(view.textKey) })}
        />
      </div>
    );
  }
  return (
    <p className="setup-progress setup-progress--line" role="status">
      {view.phase === "preparing" ? <Spinner /> : <Icon name={PHASE_ICON[view.phase]} size={16} />}
      <span>{t(view.textKey)}</span>
    </p>
  );
}

/** "4 CPUs · 8 GB de memória · 100 GB de disco" (once the provisioner said) and "Um usuário para cada agente". */
export function SetupFacts({ view }: { view: SetupView }) {
  const { t } = useTranslation();
  return (
    <ul className="setup-facts">
      {view.specs && (
        <li>
          <Icon name="computer" size={14} />
          {t("computerSetup.specs", view.specs)}
        </li>
      )}
      <li>
        <Icon name="members" size={14} />
        {t("computerSetup.users")}
      </li>
    </ul>
  );
}

/** The chip beside its name: online or not once ready (like any computer's), else where it is ("Sendo preparado"). */
function SetupChip({ view, machine }: { view: SetupView; machine: Machine | undefined }) {
  const { t } = useTranslation();
  if (view.phase !== "ready") return <Chip icon={PHASE_ICON[view.phase]}>{t(view.chipKey)}</Chip>;
  const online = machine?.online ?? false;
  return (
    <Chip icon={online ? "check" : "dash"} className="machine-chip">
      {online ? t("machines.online") : t("machines.offline")}
    </Chip>
  );
}

/** The workspace's computer row of the list, once the provisioner made it. */
const managedOf = (machines: Machine[] | undefined) => machines?.find((m) => m.kind === "managed");

/**
 * Configurações → Computadores where the workspace gets its own computer: its card, with no hostname, system or
 * address, and no Remove. On its way: the steps, or why it waits; ready: online or not. Always its size and
 * one user per agent, and the agents on it.
 */
export function WorkspaceComputerCard({ view }: { view: SetupView }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const machine = managedOf(useMachines(org.id).data);
  const title = managedTitle(t, machine?.name, org.name);
  return (
    <Card aria-labelledby="sec-workspace-computer" className="setup-card" data-phase={view.phase}>
      <div className="computers-card__head">
        <ComputerPortrait kind="cloud" state={setupPortrait(view, machine?.online ?? false)} size={96} />
        <span className="computers-card__title">
          <h2 id="sec-workspace-computer" className="ac-card__title">
            {machine ? (
              <Link to="/org/$orgId/settings/computers/$machineId" params={{ orgId: org.id, machineId: machine.id }}>
                {title}
              </Link>
            ) : (
              title
            )}
          </h2>
          <span className="row" style={{ gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <SetupChip view={view} machine={machine} />
          </span>
          <span className="small muted">{t("computerSetup.lead")}</span>
        </span>
      </div>
      {view.phase !== "ready" && <SetupProgress view={view} />}
      <SetupFacts view={view} />
      {machine && machine.agents.length > 0 && (
        <span
          className="row"
          style={{ gap: 4 }}
          title={t("machines.usedBy", {
            names: joinNames(
              machine.agents.map((a) => a.name),
              t("newAgent.and"),
            ),
          })}
        >
          {machine.agents.slice(0, 8).map((a) => (
            <AgentAvatar key={a.id} agentId={a.id} size="sm" name={a.name} />
          ))}
        </span>
      )}
    </Card>
  );
}

/**
 * "Preparando o computador da Acme": the notice at the top of the work area while the workspace's own computer
 * is on its way, with the agents that wait for it. Everyone sees it; closed, it stays closed until the state
 * (or the step) changes.
 */
export function ComputerSetupNotice() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const view = useSetupView(org.id);
  const pending = setupPending(view);
  const agents = useAgents(org.id);
  const machines = useMachines(org.id, pending);
  const [hidden, setHidden] = useState(() => storage.get(STORAGE_KEYS.setupNoticeHidden));
  if (!pending) return null;
  const key = setupNoticeKey(org.id, view);
  if (hidden === key) return null;
  const waiting = agentsWaitingForComputer(agents.data ?? [], machines.data ?? []);
  const line = [
    t(view.textKey),
    waiting.length > 0
      ? t("computerSetup.notice.waits", {
          count: waiting.length,
          names: joinNames(
            waiting.map((a) => a.name),
            t("newAgent.and"),
          ),
        })
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <section className="outages" aria-label={t("computerSetup.notice.label")}>
      <div className="outage setup-notice" role="status" data-phase={view.phase}>
        <ComputerIcon kind="cloud" size={20} className="outage__icon" />
        <span className="outage__text">
          <b>{t("computerSetup.notice.title", { org: org.name })}</b>
          <span>{line}</span>
        </span>
        <span className="outage__crew">
          {waiting.slice(0, 4).map((a) => (
            <AgentAvatar key={a.id} agentId={a.id} name={a.name} size="sm" state="idle" labelled />
          ))}
        </span>
        <span className="outage__acts">
          <Button asChild variant="ghost" size="sm">
            <Link to="/org/$orgId/settings/$section" params={{ orgId: org.id, section: "computers" }}>
              {t("computerSetup.notice.see")}
            </Link>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            icon="close"
            aria-label={t("computerSetup.notice.hide")}
            onClick={() => {
              storage.set(STORAGE_KEYS.setupNoticeHidden, key);
              setHidden(key);
            }}
          />
        </span>
      </div>
    </section>
  );
}
