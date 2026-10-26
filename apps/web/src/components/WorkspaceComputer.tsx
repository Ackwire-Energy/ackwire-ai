import type { Machine } from "@agenteschat/client";
import { useAgents, useComputerSetup, useMachines } from "@agenteschat/client";
import {
  agentsWaitingForComputer,
  computerEdition,
  computerName,
  etaLine,
  etaTickMs,
  promisesEmail,
  SETUP_STEPS,
  type SetupView,
  setupEta,
  setupNoticeKey,
  setupPending,
  setupPortrait,
  setupView,
  WORKSPACE_COMPUTER_KIND,
} from "@agenteschat/client/lib/computer";
import { joinNames, lowerFirst } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import {
  Button,
  Card,
  Chip,
  ComputerIcon,
  ComputerPortrait,
  Icon,
  type IconName,
  ProviderLogo,
  Spinner,
  Steps,
} from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { useNow } from "@/hooks/useNow";
import { STORAGE_KEYS, storage } from "@/lib/storage";

/**
 * The workspace's own computer (ADR 0056 §10), where a provisioner prepares one for each workspace: how far it
 * is and the time left, live from `machine.provisioning`. Words only a person needs: no system, address,
 * provider or tool list.
 */

/** Which words the computers get here (`computerEdition`); null while the server hasn't said. */
export function useComputerEdition(orgId: string) {
  return computerEdition(useComputerSetup(orgId).data);
}

/** This workspace's computer on its way, or null where people connect their own (`pair`). */
export function useSetupView(orgId: string): SetupView | null {
  const q = useComputerSetup(orgId);
  return setupView(q.data, q.dataUpdatedAt);
}

/** Who reads the wait: owners hear of the email, at their address; a workspace on hold hears of neither. */
export interface WaitReader {
  owner: boolean;
  email: string;
  held: boolean;
}

/** The person reading, in a workspace's pages. */
export function useWaitReader(): WaitReader {
  const { org, me } = useOrg();
  return { owner: org.role === "owner", email: me.user.email, held: org.standing?.state === "hold" };
}

/**
 * The time left now, repainted every 15 s (every 5 s under a minute), and whether "we'll email you" holds.
 * A workspace on hold shows neither: its hold banner speaks, and its provisioner waits too.
 */
export function useSetupWait(view: SetupView | null, held: boolean) {
  const live = view && setupPending(view) && !held ? view : null;
  const now = useNow((at) => (live ? etaTickMs(setupEta(live, at)) : false));
  return live ? { eta: setupEta(live, now), email: promisesEmail(live, now), now } : { eta: null, email: false, now };
}

const PHASE_ICON: Record<SetupView["phase"], IconName> = {
  preparing: "spinner",
  waiting: "waiting",
  problem: "alert",
  ready: "check",
};

/** While it's on its way: the four steps as bars ("Passo 2 de 4 · Iniciando"), or why it waits, in one line. */
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
    <p className="setup-progress setup-progress--line ac-iconline" role="status">
      {view.phase === "preparing" ? <Spinner /> : <Icon name={PHASE_ICON[view.phase]} size={16} />}
      <span>{t(view.textKey)}</span>
    </p>
  );
}

/**
 * The wait in words, under the steps: the time left, then who hears when it's ready. Only owners get the
 * email, so only they are told so (`promisesEmail`); everyone else is told it shows here.
 */
export function SetupWaitLines({ view, reader }: { view: SetupView; reader: WaitReader }) {
  const { t } = useTranslation();
  const { eta, email } = useSetupWait(view, reader.held);
  if (!setupPending(view) || reader.held) return null;
  const emailed = email && reader.owner;
  return (
    <>
      {eta && (
        <p className="setup-eta" aria-live="polite">
          {etaLine(t, eta)}
        </p>
      )}
      <p className="setup-line ac-iconline">
        <Icon name={emailed ? "mail" : "bell"} size={14} />
        <span>{emailed ? t("computerSetup.email.you", { email: reader.email }) : t("computerSetup.email.here")}</span>
      </p>
    </>
  );
}

/** "4 CPUs · 8 GB de memória · 100 GB de disco" (once the provisioner said) and "Um usuário para cada agente". */
export function SetupFacts({ view }: { view: SetupView }) {
  const { t } = useTranslation();
  return (
    <ul className="setup-facts">
      {view.specs && (
        <li className="ac-iconline">
          <Icon name="computer" size={14} />
          {t("computerSetup.specs", view.specs)}
        </li>
      )}
      <li className="ac-iconline">
        <Icon name="members" size={14} />
        {t("computerSetup.users")}
      </li>
    </ul>
  );
}

/** Claude Code and Codex come ready on it: each agent signs in there with a plan. */
export function SetupPlans() {
  const { t } = useTranslation();
  return (
    <p className="setup-line ac-iconline">
      <ProviderLogo id="claude_code" size="xs" />
      <span>{t("computerSetup.plans")}</span>
    </p>
  );
}

/**
 * The preparing screen's parts, the same in the onboarding and the computer dialog: the steps, the time left,
 * who hears when it's ready, the agent that waits for it (in its dialog), the plans and the size.
 */
export function SetupWait({ view, reader, agentName }: { view: SetupView; reader: WaitReader; agentName?: string }) {
  const { t } = useTranslation();
  return (
    <div className="setup-wait">
      <SetupProgress view={view} />
      <SetupWaitLines view={view} reader={reader} />
      {agentName && view.phase !== "ready" && (
        <p className="setup-line ac-iconline">
          <Icon name="clock" size={14} />
          <span>{t("computerSetup.agentWaiting", agentGrammar(t, agentName))}</span>
        </p>
      )}
      <SetupPlans />
      <SetupFacts view={view} />
    </div>
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
export const managedOf = (machines: Machine[] | undefined) => machines?.find((m) => m.kind === "managed");

/**
 * Configurações → Computadores where the workspace gets its own computer: its card, with no hostname, system or
 * address, and no Remove. On its way: the steps, the time left, or why it waits; ready: online or not. Always
 * its size and one user per agent, and the agents on it.
 */
export function WorkspaceComputerCard({ view }: { view: SetupView }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const reader = useWaitReader();
  const machine = managedOf(useMachines(org.id).data);
  const title = computerName(t, org.name, machine);
  return (
    <Card aria-labelledby="sec-workspace-computer" className="setup-card" data-phase={view.phase}>
      <div className="computers-card__head">
        <ComputerPortrait
          kind={WORKSPACE_COMPUTER_KIND}
          state={setupPortrait(view, machine?.online ?? false)}
          size={96}
        />
        <span className="computers-card__title">
          <h2 id="sec-workspace-computer" className="ac-card__title">
            {machine ? (
              <Link
                to="/org/$orgId/settings/computers/$machineId"
                params={{ orgId: org.id, machineId: machine.id }}
                className="machine-row__name"
              >
                {title}
              </Link>
            ) : (
              title
            )}
          </h2>
          <span className="row" style={{ gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <SetupChip view={view} machine={machine} />
          </span>
        </span>
      </div>
      {view.phase !== "ready" && <SetupProgress view={view} />}
      <SetupWaitLines view={view} reader={reader} />
      <SetupFacts view={view} />
      {machine && machine.agents.length > 0 && (
        <span className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span className="row" style={{ gap: 4 }}>
            {machine.agents.slice(0, 8).map((a) => (
              <AgentAvatar key={a.id} agentId={a.id} size="sm" name={a.name} />
            ))}
          </span>
          <span className="small muted">
            {t("machines.usedBy", {
              names: joinNames(
                machine.agents.map((a) => a.name),
                t("newAgent.and"),
              ),
            })}
          </span>
        </span>
      )}
    </Card>
  );
}

/**
 * "Preparando o computador da Acme": the notice at the top of the work area while the workspace's own computer
 * is on its way: the step, the time left and the agents that wait for it ("Passo 3 de 4 · Instalando os
 * programas · faltam uns 6 min · Ada e Theo esperam por ele"). Everyone sees it; closed, it stays closed until
 * the state (or the step) changes.
 */
export function ComputerSetupNotice() {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const view = useSetupView(org.id);
  const pending = setupPending(view);
  const agents = useAgents(org.id);
  const machines = useMachines(org.id, pending);
  const { eta } = useSetupWait(view, org.standing?.state === "hold");
  const [hidden, setHidden] = useState(() => storage.get(STORAGE_KEYS.setupNoticeHidden));
  if (!pending) return null;
  const key = setupNoticeKey(org.id, view);
  if (hidden === key) return null;
  const waiting = agentsWaitingForComputer(agents.data ?? [], machines.data ?? []);
  const line = [
    view.step
      ? t("computerSetup.stepOf", { n: view.stepNumber, total: SETUP_STEPS.length, step: t(view.textKey) })
      : t(view.textKey),
    eta ? lowerFirst(etaLine(t, eta), i18n.language) : null,
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
        <ComputerIcon kind={WORKSPACE_COMPUTER_KIND} size={20} className="outage__icon" />
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
