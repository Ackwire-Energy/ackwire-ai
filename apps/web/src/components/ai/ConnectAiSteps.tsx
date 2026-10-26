import type { MachineAccount } from "@agenteschat/client";
import { keys, useAgentBrain, useAiAccounts, useApi, useComputerSetup, useMachines } from "@agenteschat/client";
import { computerEdition, computerName, setupView } from "@agenteschat/client/lib/computer";
import { holdText } from "@agenteschat/client/lib/errors";
import { joinNames } from "@agenteschat/client/lib/format";
import { agentGrammar, providerGrammar } from "@agenteschat/client/lib/grammar";
import {
  type AiChoice,
  KEY_MARKS,
  kindOf,
  PLAN_CHOICES,
  type PlanChoice,
  type PlanGate,
  planGate,
  planLabel,
  planMark,
  planTitle,
} from "@agenteschat/client/lib/no-ai";
import { isPlanId } from "@agenteschat/client/lib/plans";
import { keyLooksValid, PROVIDERS, type ProviderId, providerOf } from "@agenteschat/client/lib/providers";
import {
  type AgentAppearance,
  Button,
  Card,
  Icon,
  Input,
  LogoMark,
  OptionCard,
  ProviderLogo,
  ProviderStack,
  Select,
  SettingNote,
  Spinner,
} from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { KeyMismatch } from "@/components/ProviderKey";
import { managedOf, SetupProgress, SetupWaitLines, useWaitReader } from "@/components/WorkspaceComputer";
import { useToast } from "@/lib/toast";
import { AddAccount, OpenPage, Step, StepTitle } from "./AddAccountFlow";

/*
 * One picker wherever an AI is connected (the setup's AI step, Connect an AI, Settings › AI accounts): the six
 * plans first, by their makers' marks, then one API key row; the chosen option's panel right under it. A plan
 * signs in on the agent's computer (ADR 0059): while the workspace's computer is on its way, its panel waits in
 * place and turns on by itself, with what needs no computer (a maker's page, a key to paste) on meanwhile.
 */

/**
 * What each plan can do now for one agent (`planGate`), from its brain view, its computer's accounts row and the
 * workspace's setup. `poll`: asked again this often where no event keeps them current (the setup opens no socket).
 */
export function usePlanGates(orgId: string, agentId: string | undefined, poll: number | false = false) {
  const brain = useAgentBrain(orgId, agentId ?? "", agentId !== undefined, poll);
  const ai = useAiAccounts(orgId, agentId !== undefined, poll);
  const setupQ = useComputerSetup(orgId);
  const edition = computerEdition(setupQ.data);
  const setup = setupView(setupQ.data, setupQ.dataUpdatedAt);
  const view = brain.data;
  const row = ai.data?.computers.find((c) => c.machineId === view?.computer?.machineId);
  const gateOf = (choice: PlanChoice): PlanGate =>
    planGate({
      choice,
      edition,
      setup,
      // A coding plan also needs to know whether that computer takes a plan's key.
      brain: view && (ai.data || !isPlanId(choice)) ? view : undefined,
      computer: row,
    });
  // A poll that fails once keeps the last view: a sign-in in progress goes on.
  return { gateOf, view, failed: brain.isError && !view, edition };
}

export type PlanGates = ReturnType<typeof usePlanGates>;

/** The six plans as tiles (one dims where it can't sign in; it still opens its panel), then the API key row. */
export function AiPicker({
  choice,
  onPick,
  dims,
}: {
  choice: AiChoice;
  onPick: (choice: AiChoice) => void;
  dims?: (choice: PlanChoice) => boolean;
}) {
  const { t } = useTranslation();
  return (
    // biome-ignore lint/a11y/useSemanticElements: pressable cards, not a native fieldset
    <div className="grid-options grid-options--plans" role="group" aria-label={t("onboarding.keyStep.title")}>
      {PLAN_CHOICES.map((c) => (
        <OptionCard key={c} pressed={choice === c} onClick={() => onPick(c)}>
          <ProviderLogo id={planMark(c)} size="sm" off={dims?.(c)} />
          <span className="ac-option__title">{planLabel(t, c)}</span>
        </OptionCard>
      ))}
      <p className="ai-picker__or">{t("connectAi.orPayGo")}</p>
      <OptionCard pressed={choice === "key"} onClick={() => onPick("key")} className="ai-picker__key ac-iconline">
        <ProviderStack ids={KEY_MARKS} />
        <span className="ac-option__text">
          <span className="ac-option__title">{t("connectAi.key.title")}</span>
          <span className="ac-option__desc">{t("connectAi.key.makers")}</span>
        </span>
      </OptionCard>
    </div>
  );
}

/** A panel's head: the option's lead on its name's line, what it covers, and (aside) for which agent. */
function PanelHead({ lead, title, sub, aside }: { lead: ReactNode; title: string; sub: string; aside?: ReactNode }) {
  return (
    <div className="ai-panel__head ac-iconline">
      {lead}
      <span className="ai-panel__title">
        <b>{title}</b>
        <span>{sub}</span>
      </span>
      {aside}
    </div>
  );
}

export interface PlanPanelProps {
  choice: PlanChoice;
  gates: PlanGates;
  /** The viewer's agents a plan may think for, in the order offered; the select shows with more than one. */
  agents: { id: string; name: string }[];
  agentId: string | undefined;
  onAgent: (id: string) => void;
  /** Why this person connects no plan here (an agent of someone else's, no agent of their own): nothing else shows. */
  locked?: ReactNode;
  /**
   * The setup on a computer the person connected: its own sign-in thinks for every agent, chosen or not (saved by
   * the caller). Elsewhere, choosing it saves it for the agent at once.
   */
  own?: { chosen: boolean; onChoose: (own: boolean) => void };
  /** This server's own computer, picked a step before and not connected yet. */
  hostConnecting?: boolean;
  /** The person came because the computer just got ready (its email, its notification): said first, once it is. */
  justReady?: boolean;
  /** "Usar uma chave de API agora": the API key row. */
  onKey: () => void;
  /** Self-host with no computer for the agent: where one is connected. */
  onComputer: () => void;
  /** The agent thinks with the plan now: the account it signed in (null: the computer's own sign-in). */
  onDone: (agentId: string, account: MachineAccount | null) => void;
}

/** A plan's panel: what it covers and for which agent, then its steps, or what they wait for. */
export function PlanPanel(props: PlanPanelProps) {
  const { t } = useTranslation();
  const { choice, gates, agents, agentId, onAgent, own, locked } = props;
  const title = planTitle(t, choice);
  // The computer's own sign-in covers every agent: no agent to choose then.
  const everyAgent =
    own?.chosen && !isPlanId(choice) && gates.view?.ownSignIn && gates.gateOf(choice).state === "ready";
  const agent = agents.find((a) => a.id === agentId);
  return (
    <Card as="section" className="ai-panel" aria-label={title}>
      <PanelHead
        lead={<ProviderLogo id={planMark(choice)} size="sm" />}
        title={title}
        sub={t(`connectAi.plan.${choice}.tiers`)}
        aside={
          agents.length > 1 &&
          agent &&
          !everyAgent && (
            <span className="ai-panel__agent">
              <span aria-hidden="true">{t("connectAi.agent")}</span>
              <Select
                size="sm"
                aria-label={t("connectAi.agent")}
                value={agent.id}
                onValueChange={onAgent}
                options={agents.map((a) => ({ value: a.id, label: a.name }))}
              />
            </span>
          )
        }
      />
      {locked ? (
        <SettingNote icon="lock">{locked}</SettingNote>
      ) : agent ? (
        <PlanSteps key={agent.id} {...props} agentId={agent.id} agentName={agent.name} />
      ) : (
        <Spinner />
      )}
    </Card>
  );
}

function PlanSteps({
  choice,
  gates,
  agentId,
  agentName,
  own,
  hostConnecting,
  justReady,
  onKey,
  onComputer,
  onDone,
}: PlanPanelProps & { agentId: string; agentName: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const reader = useWaitReader();
  const { view, edition } = gates;
  const gate = gates.gateOf(choice);
  const machines = useMachines(org.id, edition !== null);
  const kind = kindOf(choice);
  const coding = isPlanId(choice);
  const [account, setAccount] = useState<MachineAccount | null>(null);
  const [assigned, setAssigned] = useState<"saving" | "failed" | "done">("saving");
  const [other, setOther] = useState(false);
  const [ownSaved, setOwnSaved] = useState(false);
  // It turns ready while the person watches, or they came because it did: said once, in place.
  const [waited, setWaited] = useState(gate.state === "preparing" || justReady === true);
  useEffect(() => {
    if (gate.state === "preparing") setWaited(true);
  }, [gate.state]);

  const computer =
    edition === "cloud" ? computerName(t, org.name, managedOf(machines.data)) : (view?.computer?.name ?? "");
  const refresh = () => {
    for (const key of [
      keys.agentBrain(org.id, agentId),
      keys.agents(org.id),
      keys.machines(org.id),
      keys.aiAccounts(org.id),
      keys.aiStatus(org.id),
    ])
      void qc.invalidateQueries({ queryKey: key });
  };
  // The sign-in ended: the agent thinks with that account right away (no confirming click).
  const assign = async (a: MachineAccount) => {
    setAccount(a);
    setAssigned("saving");
    try {
      await api.agents.setBrain(org.id, agentId, { brain: a.kind, account: a.id });
      setAssigned("done");
      refresh();
      onDone(agentId, a);
    } catch {
      setAssigned("failed");
    }
  };
  const saveOwn = async () => {
    try {
      await api.agents.setBrain(org.id, agentId, { brain: kind, account: null });
      setOwnSaved(true);
      refresh();
      onDone(agentId, null);
    } catch {
      toast.show(t("agentPage.work.failed"), "error");
    }
  };

  if (gates.failed) return <SettingNote icon="alert">{t("common.loadFailed")}</SettingNote>;
  if (account) {
    if (assigned === "saving") return <Spinner />;
    return assigned === "done" ? (
      <SettingNote icon="check" live>
        {t("aiAccounts.done.savedAgent", { agent: agentName, label: account.label })}
      </SettingNote>
    ) : (
      <div className="ai-panel__row">
        <SettingNote icon="alert" live>
          {t("connectAi.assignFailed", { label: account.label, agent: agentName })}
        </SettingNote>
        <Button size="sm" icon="refresh" onClick={() => void assign(account)}>
          {t("common.retry")}
        </Button>
      </div>
    );
  }
  if (ownSaved) {
    return (
      <SettingNote icon="check" live>
        {t("agentPage.work.saved.accountHere", { name: agentName, computer })}
      </SettingNote>
    );
  }

  const ready = gate.state === "ready";
  const useKey = (
    <span>
      <Button size="sm" onClick={onKey}>
        {t("connectAi.wait.useKey")}
      </Button>
    </span>
  );
  const line = (lead: ReactNode, text: string) => (
    <p className="setup-line ac-iconline" role="status">
      {lead}
      <span>{text}</span>
    </p>
  );
  const hold = holdText(t, org.standing);
  let wait: ReactNode = null;
  if (gate.state === "loading") wait = <Spinner />;
  else if (gate.state === "preparing") {
    const setup = gate.view;
    const later = t(coding ? "connectAi.wait.key" : "connectAi.wait.signIn");
    // A hold decides when anything runs there: it speaks alone.
    wait = hold ? (
      line(<Icon name="pause" size={14} />, hold)
    ) : (
      <div className="setup-wait">
        {setup && <SetupProgress view={setup} />}
        {setup && <SetupWaitLines view={setup} reader={reader} bell={false} />}
        {line(setup ? <Icon name="clock" size={14} /> : <Spinner size={14} />, later)}
        {(setup?.phase === "waiting" || setup?.phase === "problem") && useKey}
      </div>
    );
  } else if (gate.state === "offline") {
    wait = hostConnecting ? (
      line(<Spinner size={14} />, t("connectAi.wait.connecting"))
    ) : (
      <>
        <SettingNote icon="alert">
          {edition === "cloud"
            ? t("aiAccounts.connect.needsCloud.online", { computer })
            : t("brain.offline", { computer })}
        </SettingNote>
        {useKey}
      </>
    );
  } else if (gate.state === "missing") {
    wait = (
      <>
        <SettingNote icon="computer">{t("aiAccounts.connect.noComputer")}</SettingNote>
        <span>
          <Button size="sm" variant="primary" onClick={onComputer}>
            {t("aiAccounts.connect.addComputer")}
          </Button>
        </span>
      </>
    );
  } else if (gate.state === "unsupported") {
    wait = (
      <>
        <SettingNote icon="alert">
          {edition === "cloud"
            ? t(`aiAccounts.connect.needsCloud.${kind}`, { computer })
            : gate.reason === "keys"
              ? t("aiAccounts.connect.needs.keys")
              : t(`brain.reasons.${gate.reason}`, { computer })}
        </SettingNote>
        {useKey}
      </>
    );
  } else if (gate.state === "locked") {
    const pairer = machines.data?.find((m) => m.id === view?.computer?.machineId)?.pairedBy?.name.split(" ")[0];
    wait = (
      <SettingNote icon="lock">
        {gate.who === "computer"
          ? t("connectAi.accountsLocked", { name: pairer ?? "", computer })
          : t("noAi.lockedAdmins")}
      </SettingNote>
    );
  }

  // The steps stay in view while they wait (their computer actions off); a reason alone otherwise.
  const steps = ready || gate.state === "preparing" || (gate.state === "offline" && hostConnecting);
  const ownable = ready && !coding && view?.ownSignIn === true;
  const otherChosen = own ? !own.chosen : other;
  const brand = planLabel(t, choice);
  const current = view?.accounts.find(
    (a) => a.id === view.account && a.kind === kind && (coding ? a.provider === choice : !a.provider),
  );
  const signedOut = current?.status === "signed_out" ? current : undefined;
  return (
    <>
      {wait}
      {ready && waited && (
        <SettingNote icon="check" live>
          {t("connectAi.wait.ready", { computer })}
        </SettingNote>
      )}
      {ownable && (
        <>
          {/* biome-ignore lint/a11y/useSemanticElements: pressable cards, not a native fieldset */}
          <div className="grid-options" role="group" aria-label={planTitle(t, choice)}>
            <OptionCard pressed={own?.chosen ?? false} onClick={() => (own ? own.onChoose(true) : void saveOwn())}>
              <span className="ac-option__text">
                <span className="ac-option__title">{t("connectAi.own.this", { brand, computer })}</span>
                <span className="ac-option__desc">{t("connectAi.own.thisText")}</span>
              </span>
            </OptionCard>
            <OptionCard pressed={otherChosen} onClick={() => (own ? own.onChoose(false) : setOther(true))}>
              <span className="ac-option__text">
                <span className="ac-option__title">{t("connectAi.own.other", { brand })}</span>
              </span>
            </OptionCard>
          </div>
          {/* With another account, its steps say it once, for its one agent. */}
          {!otherChosen && <SettingNote icon="lock">{t("connectAi.own.note")}</SettingNote>}
        </>
      )}
      {steps && (!ownable || otherChosen) && (
        <AddAccount
          machineId={view?.computer?.machineId ?? ""}
          kind={kind}
          computer={computer}
          {...(isPlanId(choice) ? { provider: choice } : {})}
          again={signedOut?.id}
          email={signedOut?.email}
          askEmail={view?.ownSignIn || view?.accounts.some((a) => a.mine && a.kind === kind && !a.provider)}
          local={view?.ownSignIn}
          ready={ready}
          note={!coding && <SettingNote icon="lock">{t("connectAi.onlyYou", agentGrammar(t, agentName))}</SettingNote>}
          onAdded={(a) => void assign(a)}
        />
      )}
    </>
  );
}

/** The API key being added: its maker (or the agentes.chat key, where the server offers one) and the key. */
export interface KeyDraft {
  provider: ProviderId | "platform";
  apiKey: string;
}

/**
 * The API key: who charges for it (a maker's key only: the agentes.chat key isn't paid to a provider; the row just
 * chosen already names the panel), its maker by its mark, where that maker's keys are made, then the key, pasted
 * here. `onSave`: saved right here (the dialog); else the caller saves it with its own button (the setup).
 */
export function KeyPanel({
  draft,
  onDraft,
  platform,
  locked,
  saved,
  saving,
  onSave,
}: {
  draft: KeyDraft;
  onDraft: (draft: KeyDraft) => void;
  /** The server has a key of its own to offer. */
  platform?: boolean;
  /** Only an admin adds an API key. */
  locked?: boolean;
  saved?: boolean;
  saving?: boolean;
  onSave?: () => void;
}) {
  const { t } = useTranslation();
  const fieldId = useId();
  const [touched, setTouched] = useState(false);
  const { provider, apiKey } = draft;
  const keyOf = provider === "platform" ? null : provider;
  const maker = keyOf ? providerOf(keyOf) : undefined;
  const valid = keyOf === null || keyLooksValid(keyOf, apiKey);
  const wrong = touched && apiKey.trim().length > 0 && !valid;
  const site = maker ? new URL(`https://${maker.site}`) : null;
  const pick = (next: ProviderId | "platform") => onDraft({ provider: next, apiKey });
  return (
    <Card as="section" className="ai-panel" aria-label={t("connectAi.key.title")}>
      {keyOf && (
        <p className="small muted" style={{ margin: 0 }}>
          {t("connectAi.key.sub")}
        </p>
      )}
      {locked ? (
        <SettingNote icon="lock">{t("connectAi.keyLocked")}</SettingNote>
      ) : saved ? (
        <SettingNote icon="check" live>
          {t("connectAi.key.saved")}
        </SettingNote>
      ) : (
        <>
          {/* biome-ignore lint/a11y/useSemanticElements: pressable cards, not a native fieldset */}
          <div className="grid-options grid-options--plans" role="group" aria-label={t("settings.provider")}>
            {PROVIDERS.map((p) => (
              <OptionCard key={p.id} pressed={provider === p.id} onClick={() => pick(p.id)}>
                <ProviderLogo id={p.id} size="sm" />
                <span className="ac-option__title">{p.label}</span>
              </OptionCard>
            ))}
            {platform && (
              <OptionCard pressed={provider === "platform"} onClick={() => pick("platform")} className="ai-key__ours">
                <span className="ac-brand ac-brand--sm ac-brand--mono" aria-hidden="true">
                  <LogoMark />
                </span>
                <span className="ac-option__title">{t("connectAi.key.platform")}</span>
              </OptionCard>
            )}
          </div>
          {keyOf && maker && site ? (
            <>
              <Step
                n={1}
                side={
                  <OpenPage href={site.href} primary={!apiKey}>
                    {t("aiAccounts.add.openKeys", { site: site.host })}
                  </OpenPage>
                }
              >
                <StepTitle
                  title={t("connectAi.key.create", providerGrammar(t, keyOf))}
                  hint={maker.plans ? t("connectAi.key.notPlan") : undefined}
                />
              </Step>
              <Step n={2}>
                <label htmlFor={fieldId}>
                  <b>{t("connectAi.key.paste")}</b>
                </label>
                <span className="agp-addacct__paste">
                  <Input
                    id={fieldId}
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={maker.placeholder}
                    value={apiKey}
                    invalid={wrong}
                    onChange={(e) => onDraft({ provider, apiKey: e.target.value })}
                    onBlur={() => setTouched(true)}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter" || !onSave) return;
                      e.preventDefault();
                      setTouched(true);
                      if (valid) onSave();
                    }}
                  />
                  {onSave && (
                    <Button size="sm" variant="primary" loading={saving} disabled={!valid} onClick={onSave}>
                      {t("settings.saveKey")}
                    </Button>
                  )}
                </span>
                {wrong && (
                  <div className="ac-field__error" role="alert">
                    <KeyMismatch provider={keyOf} apiKey={apiKey} onPick={pick} />
                  </div>
                )}
              </Step>
              <SettingNote icon="info">{t("connectAi.key.forAll")}</SettingNote>
            </>
          ) : (
            <p className="small muted">{t("onboarding.platformKeyDesc")}</p>
          )}
        </>
      )}
    </Card>
  );
}

/** One agent of the team and what it thinks with: an account's name, "API key · Claude", or nothing yet. */
export interface WhoRow {
  id: string;
  name: string;
  appearance?: AgentAppearance;
  initials?: string;
  thinks: { label: string; mark: string } | null;
}

/** The setup, once a plan is in and there are several agents: who thinks with what, and one key for the others. */
export function WhoThinks({ rows, onKey }: { rows: WhoRow[]; onKey: () => void }) {
  const { t } = useTranslation();
  const missing = rows.filter((r) => !r.thinks);
  return (
    <Card as="section" className="ai-who" aria-labelledby="ai-who-title">
      <h2 id="ai-who-title" className="ac-card__title">
        {t("onboarding.brain.title")}
      </h2>
      <ul className="ai-who__list">
        {rows.map((r) => (
          <li key={r.id} className="ai-who__row">
            <AgentAvatar name={r.name} initials={r.initials} appearance={r.appearance} size="sm" />
            <span className="ai-who__name">{r.name}</span>
            <span className="ai-who__thinks ac-iconline">
              {r.thinks ? <ProviderLogo id={r.thinks.mark} size="xs" /> : <Icon name="plug" size={14} />}
              <span>{r.thinks ? r.thinks.label : t("noAi.chip")}</span>
            </span>
          </li>
        ))}
      </ul>
      {missing.length > 0 && (
        <>
          <p className="small muted">{t("connectAi.who.line")}</p>
          <span>
            <Button size="sm" onClick={onKey}>
              <ProviderStack ids={KEY_MARKS.slice(0, 2)} />
              {t("connectAi.who.keyFor", {
                names: joinNames(
                  missing.map((r) => r.name),
                  t("newAgent.and"),
                ),
              })}
            </Button>
          </span>
        </>
      )}
    </Card>
  );
}
