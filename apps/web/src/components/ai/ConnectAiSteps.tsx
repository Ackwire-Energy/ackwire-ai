import type { MachineAccount } from "@agenteschat/client";
import { keys, useAgentBrain, useAiAccounts, useApi, useComputerSetup, useMachines } from "@agenteschat/client";
import { planWordOf, signInPlan } from "@agenteschat/client/lib/ai-accounts";
import { answersOthers, audienceOf } from "@agenteschat/client/lib/audience";
import {
  computerEdition,
  computerName,
  etaLine,
  setupView,
  statusRestatesChip,
} from "@agenteschat/client/lib/computer";
import { holdText } from "@agenteschat/client/lib/errors";
import { joinNames, lowerFirst } from "@agenteschat/client/lib/format";
import { agentGrammar, providerGrammar } from "@agenteschat/client/lib/grammar";
import { toolOffReason } from "@agenteschat/client/lib/machines";
import {
  type AiChoice,
  ALL_AGENTS,
  KEY_MARKS,
  kindOf,
  ownSignInFor,
  PLAN_CHOICES,
  type PlanChoice,
  type PlanGate,
  planGate,
  planLabel,
  planMark,
  planTitle,
} from "@agenteschat/client/lib/no-ai";
import { isPlanId, planOf } from "@agenteschat/client/lib/plans";
import { keyLooksValid, keyStepHint, PROVIDERS, type ProviderId, providerOf } from "@agenteschat/client/lib/providers";
import {
  type AgentAppearance,
  AvatarStack,
  Button,
  Card,
  Icon,
  InfoHint,
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
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { KeyMismatch } from "@/components/ProviderKey";
import { managedOf, SetupProgress, useSetupWait, useWaitReader } from "@/components/WorkspaceComputer";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";
import { AddAccount, OpenPage, Step, StepTitle } from "./AddAccountFlow";
import { PlanReplies } from "./PlanReplies";

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
  // Once ready, the workspace's computer is every agent's: a view from before that still has none is asked again
  // now with the accounts (a coding plan reads that computer's row there), not at their next poll. Until both
  // answers are in, every plan reads as ready with its sign-in loading, as the rest of the page says ready.
  const behind = edition === "cloud" && setup?.phase === "ready" && view !== undefined && !view.computer;
  const [asking, setAsking] = useState(false);
  const { refetch: brainAgain } = brain;
  const { refetch: accountsAgain } = ai;
  useEffect(() => {
    if (!behind) return;
    setAsking(true);
    void Promise.allSettled([brainAgain(), accountsAgain()]).then(() => setAsking(false));
  }, [behind, brainAgain, accountsAgain]);
  const catching = behind || asking;
  // A panel here waited for that computer: once it's ready, it says so whenever it shows again (another plan, another
  // step and back).
  const [waited, setWaited] = useState(false);
  const markWaited = useCallback(() => setWaited(true), []);
  const gateOf = (choice: PlanChoice): PlanGate =>
    catching
      ? { state: "ready" }
      : planGate({
          choice,
          edition,
          setup,
          // A coding plan also needs to know whether that computer takes a plan's key, and Claude on a computer the
          // person connected whether its own sign-in is there (`ownSignInFor`).
          brain: view && (ai.data || !(isPlanId(choice) || (choice === "claude" && view.ownSignIn))) ? view : undefined,
          computer: row,
        });
  // A poll that fails once keeps the last view: a sign-in in progress goes on.
  return { gateOf, view, row, failed: brain.isError && !view, edition, waited, markWaited, catching };
}

export type PlanGates = ReturnType<typeof usePlanGates>;

/**
 * The six plans as tiles (one dims where it can't sign in; it still opens its panel), then the API key row, with the
 * chosen option's `panel` right under it: nothing comes between an option and its steps.
 */
export function AiPicker({
  choice,
  onPick,
  dims,
  panel,
}: {
  choice: AiChoice;
  onPick: (choice: AiChoice) => void;
  dims?: (choice: PlanChoice) => boolean;
  panel: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <>
      {/* biome-ignore lint/a11y/useSemanticElements: pressable cards, not a native fieldset */}
      <div className="grid-options grid-options--plans" role="group" aria-label={t("onboarding.keyStep.title")}>
        {PLAN_CHOICES.map((c) => (
          <OptionCard key={c} pressed={choice === c} onClick={() => onPick(c)}>
            <ProviderLogo id={planMark(c)} size="sm" off={dims?.(c)} />
            <span className="ac-option__title">{planLabel(t, c)}</span>
          </OptionCard>
        ))}
        {choice !== "key" && panel}
        <p className="ai-picker__or">{t("connectAi.orPayGo")}</p>
        <OptionCard pressed={choice === "key"} onClick={() => onPick("key")} className="ai-picker__key ac-iconline">
          <ProviderStack ids={KEY_MARKS} />
          <span className="ac-option__text">
            <span className="ac-option__title">{t("connectAi.key.title")}</span>
            <span className="ac-option__desc">{t("connectAi.key.makers")}</span>
          </span>
        </OptionCard>
      </div>
      {choice === "key" && panel}
    </>
  );
}

/**
 * A panel's head: the option's mark, its name with what it covers under it (the name's capitals at the mark's top),
 * and (aside) for whom.
 */
function PanelHead({ lead, title, sub, aside }: { lead: ReactNode; title: string; sub: string; aside?: ReactNode }) {
  return (
    <div className="ai-panel__head ac-faceline">
      {lead}
      <span className="ai-panel__title">
        <b className="ac-captop">{title}</b>
        <span>{sub}</span>
      </span>
      {aside}
    </div>
  );
}

/** An agent a plan may think for, as the "For" select and the who row draw it. */
export interface PlanAgent {
  id: string;
  name: string;
  appearance?: AgentAppearance;
  initials?: string;
}

/** An agent of "All agents"; `done`: it already thinks with this plan. */
export type PlanSetAgent = PlanAgent & { done?: boolean };

export interface PlanPanelProps {
  choice: PlanChoice;
  gates: PlanGates;
  /** The viewer's agents a plan may think for, in the order offered; the select shows with more than one. */
  agents: PlanAgent[];
  /** "All agents" for this plan (`allAgents`): none where it signs in once per account. */
  all: PlanSetAgent[];
  /** An agent's id, or `ALL_AGENTS` (`defaultTarget`). */
  target: string | undefined;
  onTarget: (target: string) => void;
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
  /**
   * The setup's rail beside the panel says where the computer is: a line that would only say it again stays out, as
   * `SetupProgress`'s `said`.
   */
  said?: boolean;
  /** "Responde a todos" kept by the caller, which saves the computer's own sign-in for every agent itself (the setup). */
  replies?: { on: boolean; onChange: (on: boolean) => void };
  /** "Usar uma chave de API agora": the API key row. */
  onKey: () => void;
  /** Self-host with no computer for the agent: where one is connected. */
  onComputer: () => void;
  /** These agents think with the plan now: the account they signed in (null: the computer's own sign-in). */
  onDone: (agentIds: string[], account: MachineAccount | null) => void;
  /**
   * One agent thinks with the account it signed in, the others of "All agents" maybe still to go: kept by a caller
   * that knows only what `onDone` says (the setup), so the panel shown again (another tile and back) goes on from the
   * next agent, never signing this one in twice.
   */
  onAssigned?: (agentId: string, account: MachineAccount) => void;
  /**
   * A key or a code went to the computer, or an agent is being moved onto the plan: whom the panel is for, and whose
   * computer it reads, must hold from here, though the agents it moves get an AI meanwhile.
   */
  onStart?: () => void;
}

/** A plan's panel: what it covers and for whom, its steps or what they wait for, then who the agents answer. */
export function PlanPanel(props: PlanPanelProps) {
  const { t } = useTranslation();
  const { choice, gates, agents, all, target, onTarget, own, locked } = props;
  const title = planTitle(t, choice);
  // The computer's own sign-in covers every agent: no agent to choose then.
  const everyAgent =
    own?.chosen === true && ownSignInFor(choice, gates.view, gates.row) && gates.gateOf(choice).state === "ready";
  const forWhom: PlanSetAgent[] = target === ALL_AGENTS ? all : agents.filter((a) => a.id === target);
  const [agent] = forWhom;
  return (
    <Card as="section" className="ai-panel ai-panel--plan" aria-label={title}>
      <PanelHead
        lead={<ProviderLogo id={planMark(choice)} size="sm" />}
        title={title}
        sub={t(`connectAi.plan.${choice}.tiers`)}
        aside={
          agents.length > 1 &&
          forWhom.length > 0 &&
          !everyAgent && <ForSelect agents={agents} all={all} target={target} onTarget={onTarget} />
        }
      />
      {locked ? (
        <SettingNote icon="lock">{locked}</SettingNote>
      ) : agent ? (
        <PlanSteps key={target} {...props} forWhom={forWhom} agent={agent} everyAgent={everyAgent} />
      ) : (
        <Spinner />
      )}
    </Card>
  );
}

/** "For [All agents ▾]": every agent of "All agents" first, with their faces and names, then each agent. */
function ForSelect({ agents, all, target, onTarget }: Pick<PlanPanelProps, "agents" | "all" | "target" | "onTarget">) {
  const { t } = useTranslation();
  const face = (a: PlanAgent) => (
    <AgentAvatar key={a.id} name={a.name} initials={a.initials} appearance={a.appearance} size="xs" />
  );
  return (
    <span className="ai-panel__agent">
      <span aria-hidden="true">{t("connectAi.for")}</span>
      <Select
        size="sm"
        align="end"
        aria-label={t("connectAi.agentAria")}
        value={target}
        onValueChange={onTarget}
        options={[
          ...(all.length > 1
            ? [
                {
                  value: ALL_AGENTS,
                  label: t("connectAi.all"),
                  description: joinNames(
                    all.map((a) => a.name),
                    t("newAgent.and"),
                  ),
                  leading: <AvatarStack>{all.slice(0, 3).map(face)}</AvatarStack>,
                },
              ]
            : []),
          ...agents.map((a) => ({ value: a.id, label: a.name, leading: face(a) })),
        ]}
      />
    </span>
  );
}

/** The computer's own sign-in as a brain view says it: no account. */
const OWN_SIGN_IN = { account: null, accounts: [] } as const;

function PlanSteps({
  choice,
  gates,
  forWhom,
  agent,
  everyAgent,
  target,
  own,
  hostConnecting,
  justReady,
  said = false,
  replies,
  onKey,
  onComputer,
  onDone,
  onAssigned,
  onStart,
}: PlanPanelProps & {
  forWhom: PlanSetAgent[];
  /** The agent it's for, or the first of "All agents". */
  agent: PlanSetAgent;
  everyAgent: boolean;
}) {
  const { t, i18n } = useTranslation();
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
  const everyone = target === ALL_AGENTS;
  // The agents it moved onto the plan (the login each thinks with), one being moved, one whose move failed.
  const [assigned, setAssigned] = useState<Record<string, MachineAccount>>({});
  // Whom it signs in for, in order: of "All agents", those that weren't on this plan before it moved them.
  const todo = everyone ? forWhom.filter((a) => !a.done || assigned[a.id]) : forWhom;
  const [saving, setSaving] = useState(0);
  const [failed, setFailed] = useState<{ agentId: string; account: MachineAccount } | null>(null);
  const [sent, setSent] = useState(false);
  // Of "All agents", those whose login ended without signing in: none runs for them until the key goes again.
  const [missed, setMissed] = useState<string[]>([]);
  const [other, setOther] = useState(false);
  const [ownSaved, setOwnSaved] = useState(false);
  // A sign-in begun here keeps its steps while its computer is offline: they say Reconnecting, and it goes on.
  const [signingIn, setSigningIn] = useState(false);
  const dir = useDirectory(org.id);
  // "Responde a todos" (ADR 0059 §5) for whom the panel is: an agent already on this brain shows its own and changes
  // it at once, one moved onto it starts on its owner alone unless this is on (the move says so).
  const onBrain = (id: string) => ownSaved || id in assigned || dir.agentById.get(id)?.brain?.kind === kind;
  const repliesNow = (id: string) => {
    const row = dir.agentById.get(id);
    return row !== undefined && answersOthers(audienceOf(row), row.ownerUserId);
  };
  const [ownReplies, setOwnReplies] = useState(() => forWhom.every((a) => onBrain(a.id) && repliesNow(a.id)));
  const replyAll = replies?.on ?? ownReplies;
  const setReplies = replies?.onChange ?? setOwnReplies;
  const [replying, setReplying] = useState(false);
  const toEveryone = replyAll ? { onlyOwner: false } : {};
  // It turns ready while the person watches, or they came because it did: said in place, and again on a way back.
  const waited = gates.waited || justReady === true;
  const { markWaited } = gates;
  useEffect(() => {
    if (gate.state === "preparing") markWaited();
  }, [gate.state, markWaited]);
  const preparing = gate.state === "preparing" ? gate.view : null;
  const { eta, email } = useSetupWait(preparing, reader.held);

  const computer =
    edition === "cloud" ? computerName(t, org.name, managedOf(machines.data)) : (view?.computer?.name ?? "");
  const refresh = (agentIds: string[]) => {
    for (const key of [
      ...agentIds.map((id) => keys.agentBrain(org.id, id)),
      keys.agents(org.id),
      keys.machines(org.id),
      keys.aiAccounts(org.id),
      keys.aiStatus(org.id),
    ])
      void qc.invalidateQueries({ queryKey: key });
  };
  // A sign-in ended: its agent thinks with that account right away (no confirming click).
  const assign = async (agentId: string, a: MachineAccount) => {
    onStart?.();
    setFailed(null);
    setSaving((n) => n + 1);
    try {
      await api.agents.setBrain(org.id, agentId, { brain: a.kind, account: a.id, ...toEveryone });
      setAssigned((x) => ({ ...x, [agentId]: a }));
      onAssigned?.(agentId, a);
      refresh([agentId]);
    } catch {
      setFailed({ agentId, account: a });
    } finally {
      setSaving((n) => n - 1);
    }
  };
  const saveOwn = async () => {
    try {
      for (const a of todo) await api.agents.setBrain(org.id, a.id, { brain: kind, account: null, ...toEveryone });
      setOwnSaved(true);
      refresh(todo.map((a) => a.id));
      onDone(
        todo.map((a) => a.id),
        null,
      );
    } catch {
      toast.show(t("agentPage.work.failed"), "error");
    }
  };
  const account = Object.values(assigned)[0];
  const allDone = todo.length > 0 && todo.every((a) => assigned[a.id]);
  const told = useRef(false);
  useEffect(() => {
    if (!allDone || told.current) return;
    told.current = true;
    onDone(
      todo.map((a) => a.id),
      account ?? null,
    );
  }, [allDone, todo, account, onDone]);

  const replyToEveryone = async (on: boolean) => {
    setReplies(on);
    const now = forWhom.filter((a) => onBrain(a.id)).map((a) => a.id);
    if (now.length === 0) return;
    setReplying(true);
    try {
      for (const id of now) await api.agents.setBrain(org.id, id, { onlyOwner: !on });
      refresh(now);
    } catch {
      setReplies(!on);
      toast.show(t("agentPage.work.failed"), "error");
    } finally {
      setReplying(false);
    }
  };

  const ready = gate.state === "ready";
  const brand = planLabel(t, choice);
  const current = view?.accounts.find(
    (a) => a.id === view.account && a.kind === kind && (coding ? a.provider === choice : !a.provider),
  );
  // The sign-in in play: one just made, the computer's own chosen here, or what the agent already thinks with.
  const signIn = own?.chosen || ownSaved ? OWN_SIGN_IN : view?.brain === kind ? view : undefined;
  // Who the agents reply to, once for the plan, as its foot: its icon says it, its switch changes it.
  const foot = (
    <div className="ac-card__foot ac-iconline ai-panel__replies">
      <Icon name={replyAll ? "audienceEveryone" : "audienceOwner"} size={14} />
      <PlanReplies
        all={everyone || everyAgent}
        on={replyAll}
        onChange={(on) => void replyToEveryone(on)}
        brain={kind}
        plan={account?.plan ?? (signIn ? signInPlan(signIn, gates.row, kind) : null)}
        maker={planOf(choice)?.maker}
        disabled={replying}
      />
    </div>
  );

  if (gates.failed) return <SettingNote icon="alert">{t("common.loadFailed")}</SettingNote>;
  // Done, or nothing to do: every agent of "All agents" already thought with this plan.
  if (allDone || (everyone && todo.length === 0)) {
    return (
      <>
        <SettingNote icon="check" live>
          {everyone
            ? t("connectAi.doneAll", {
                names: joinNames(
                  forWhom.map((a) => a.name),
                  t("newAgent.and"),
                ),
                label: account?.label ?? brand,
              })
            : t("aiAccounts.done.savedAgent", { agent: agent.name, label: account?.label ?? "" })}
        </SettingNote>
        {foot}
      </>
    );
  }
  if (ownSaved) {
    const label = lowerFirst(t("connectAi.own.shared"), i18n.language);
    return (
      <>
        <SettingNote icon="check" live>
          {everyone
            ? t("connectAi.doneAll", {
                names: joinNames(
                  todo.map((a) => a.name),
                  t("newAgent.and"),
                ),
                label,
              })
            : t("aiAccounts.done.savedAgent", { agent: agent.name, label })}
        </SettingNote>
        {foot}
      </>
    );
  }
  const retry = failed && (
    <div className="ai-panel__row">
      <SettingNote icon="alert" live>
        {t("connectAi.assignFailed", {
          label: failed.account.label,
          agent: forWhom.find((a) => a.id === failed.agentId)?.name ?? "",
        })}
      </SettingNote>
      <Button size="sm" icon="refresh" onClick={() => void assign(failed.agentId, failed.account)}>
        {t("common.retry")}
      </Button>
    </div>
  );
  // One agent: its sign-in gives way to the move and what came of it.
  if (!everyone && (saving > 0 || failed))
    return saving > 0 ? (
      <Spinner />
    ) : (
      <>
        {retry}
        {foot}
      </>
    );

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
    // The computer's wait in one well: how far it is and the time left, or why it waits (not where the rail beside it
    // already says so), then when the step under it turns on, said once (the owner's email line says it for them). A
    // hold decides when anything runs there: it speaks alone. The well's lines start on the panel's text edge, so none
    // leads with an icon.
    wait = (hold || preparing) && (
      <div className="ai-panel__wait">
        {hold ? (
          <p className="setup-line" role="status">
            {hold}
          </p>
        ) : (
          <>
            {preparing?.step ? (
              <SetupProgress view={preparing} />
            ) : (
              preparing &&
              !(said && statusRestatesChip(preparing)) && (
                <p className="setup-line" role="status">
                  {t(preparing.textKey)}
                </p>
              )
            )}
            {eta && (
              <p className="setup-eta" aria-live="polite">
                {etaLine(t, eta)}
              </p>
            )}
            <p className="setup-line">
              {t(
                email && reader.owner
                  ? "connectAi.wait.email"
                  : coding
                    ? "connectAi.wait.key"
                    : "connectAi.wait.signIn",
              )}
            </p>
          </>
        )}
      </div>
    );
  } else if (gate.state === "offline" && !signingIn) {
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
    const off = toolOffReason(
      machines.data?.find((m) => m.id === view?.computer?.machineId),
      kind,
    );
    wait = (
      <>
        <SettingNote icon="alert">
          {edition === "cloud"
            ? t(`aiAccounts.connect.needsCloud.${kind}`, { computer })
            : gate.reason === "keys"
              ? t("aiAccounts.connect.needs.keys")
              : gate.reason === "tool_off"
                ? t(off.key, { computer, command: off.command })
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
  const steps = ready || gate.state === "preparing" || (gate.state === "offline" && (hostConnecting || signingIn));
  const ownable = ready && ownSignInFor(choice, view, gates.row);
  // The shared sign-in's plan, where the computer says it ("Claude Max").
  const ownPlan = planWordOf(gates.row?.own?.[kind]?.plan ?? null);
  const otherChosen = own ? !own.chosen : other;
  const signedOut = !everyone && current?.status === "signed_out" ? current : undefined;
  // One sign-in per agent, in turn: the agent signing in now, and the account the first one signed in as.
  const turn = everyone && !coding ? todo.find((a) => !assigned[a.id]) : undefined;
  const sameAs = Object.values(assigned).find((a) => a.email)?.email ?? undefined;
  const stateOf = (a: PlanSetAgent) =>
    a.done || assigned[a.id] ? "done" : !missed.includes(a.id) && (coding ? sent : a.id === turn?.id) ? "now" : "next";
  return (
    <>
      {wait}
      {ready &&
        waited &&
        (said ? (
          // The rail says it to the eye, and a screen reader still hears the sign-in come on.
          <p className="ac-visually-hidden" role="status">
            {t("connectAi.wait.ready")}
          </p>
        ) : (
          // A group of its own over a hairline, so it never reads as part of the account choice under it.
          <SettingNote icon="check" live className="ai-panel__ready">
            {t("connectAi.wait.ready")}
          </SettingNote>
        ))}
      {everyone && steps && (
        <ul className="ai-panel__who" aria-label={t("connectAi.agentAria")}>
          {forWhom.map((a) => {
            const state = stateOf(a);
            return (
              <li key={a.id} data-state={state}>
                <AgentAvatar name={a.name} initials={a.initials} appearance={a.appearance} size="xs" />
                <span>{a.name}</span>
                {state === "done" ? (
                  <Icon name="check" size={14} label={t("connectAi.who.state.done")} />
                ) : state === "now" ? (
                  <Icon name="spinner" size={14} label={t("connectAi.who.state.now")} />
                ) : (
                  <span className="ac-visually-hidden">{t("connectAi.who.state.next")}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {everyone && !coding && steps && (
        <p className="ai-panel__each">
          <span className="ac-hintline">
            <span>{t("connectAi.each")}</span>
            <InfoHint name={t("common.about", { label: t("connectAi.each") })}>{t("connectAi.eachHint")}</InfoHint>
          </span>
        </p>
      )}
      {retry}
      {ownable && (
        // Who shares the sign-in: the computer's own, which any of its pairer's agents there thinks with, or a sign-in
        // for this agent alone, each agent's own for All agents (ADR 0059 §2). Small columns: indented to the panel's
        // text column, the two still fit side by side in the setup's column.
        // biome-ignore lint/a11y/useSemanticElements: pressable cards, not a native fieldset
        <div className="grid-options grid-options--sm" role="group" aria-label={planTitle(t, choice)}>
          <OptionCard pressed={own?.chosen ?? false} onClick={() => (own ? own.onChoose(true) : void saveOwn())}>
            <span className="ac-option__text">
              <span className="ac-option__title">{t("connectAi.own.shared")}</span>
              {ownPlan && <span className="ac-option__desc">{`${brand} ${ownPlan}`}</span>}
            </span>
          </OptionCard>
          <OptionCard pressed={otherChosen} onClick={() => (own ? own.onChoose(false) : setOther(true))}>
            <span className="ac-option__text">
              <span className="ac-option__title">
                {everyone ? t("connectAi.own.each") : t("connectAi.own.one", agentGrammar(t, agent.name))}
              </span>
            </span>
          </OptionCard>
        </div>
      )}
      {steps && (!ownable || otherChosen) && (
        <AddAccount
          key={turn?.id}
          machineId={view?.computer?.machineId ?? ""}
          kind={kind}
          // The Cloud's one computer goes unnamed in the account choice: the sign-in is about the account, not where.
          computer={edition === "cloud" ? t("connectAi.theComputer") : computer}
          {...(coding ? { provider: choice } : {})}
          again={signedOut?.id}
          email={turn && sameAs ? sameAs : signedOut?.email}
          local={view?.ownSignIn}
          ready={ready}
          loading={gates.catching}
          {...(turn ? { signInLabel: t("connectAi.signInFor", agentGrammar(t, turn.name)) } : {})}
          {...(everyone && coding ? { fanOut: todo.map((a) => ({ id: a.id })) } : {})}
          onSent={() => {
            setSent(true);
            setMissed([]);
            onStart?.();
          }}
          onFailed={(id) => setMissed((m) => [...m, id])}
          onAdded={(a, id) => void assign(id ?? turn?.id ?? agent.id, a)}
          onUse={(a) => void assign(turn?.id ?? agent.id, a)}
          onSigningIn={setSigningIn}
        />
      )}
      {(steps || ownable) && foot}
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
  const hint = maker && keyStepHint(maker);
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
                <StepTitle title={t("connectAi.key.create", providerGrammar(t, keyOf))} hint={hint && t(hint)} />
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
                    <Button variant="primary" loading={saving} disabled={!valid} onClick={onSave}>
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
              <SettingNote icon="agent">{t("connectAi.key.forAll")}</SettingNote>
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

/** The setup, once a plan is in and some agent still has no AI: who thinks with what, and one key for the others. */
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
      )}
    </Card>
  );
}
