import type {
  Agent,
  AgentBrain,
  AgentSetup,
  BrainEffortSetting,
  BrainKind,
  BrainOption,
  CommandApproval,
  Machine,
  MachineAccount,
} from "@agenteschat/client";
import {
  BROWSER_TOOL_SCOPE,
  DESKTOP_TOOL_SCOPE,
  keys,
  profilesApply,
  profilesOfAgent,
  useAgentBrain,
  useAgentBrowserSettings,
  useAgentScopes,
  useAgents,
  useAiAccounts,
  useAiStatus,
  useApi,
  useBrowserProfileMutations,
  useBrowserProfiles,
  useComputer,
  useCredentials,
  useMachines,
  useModels,
  usePlatformKey,
  useSetComputerTarget,
  useSettings,
  useSetupPreview,
  useUpdateAgent,
  useUpdateAgentBrowserSettings,
} from "@agenteschat/client";
import { saveLevels } from "@agenteschat/client/lib/access-levels";
import {
  autonomyName,
  autonomyWords,
  changes,
  setupOutcome,
  setupResultLine,
  sortedResults,
  takers,
} from "@agenteschat/client/lib/agent-setup";
import {
  accountChoices,
  ownSignInListed,
  ownSignInName,
  ownSignInReady,
  signInPlan,
} from "@agenteschat/client/lib/ai-accounts";
import { brainLine, thinksWith } from "@agenteschat/client/lib/brain";
import {
  type Advanced,
  advancedDefaults,
  advancedParts,
  advancedSummary,
  isAdvancedDefault,
  isClaudeAlias,
} from "@agenteschat/client/lib/brain-advanced";
import { setupPortrait, WORKSPACE_COMPUTER_KIND } from "@agenteschat/client/lib/computer";
import { type ContextLimit, contextChoices, contextSize, isContextLimit } from "@agenteschat/client/lib/context-limits";
import { firstName, lowerFirst } from "@agenteschat/client/lib/format";
import {
  allowsInApp,
  commandInReason,
  computerKind,
  computerState,
  toolOffReason,
  toolOnCommand,
} from "@agenteschat/client/lib/machines";
import {
  type AiChoice,
  aiChoiceOf,
  aiStateOf,
  kindOf,
  planLabel,
  planMark,
  planOfAccount,
} from "@agenteschat/client/lib/no-ai";
import { can as canDo } from "@agenteschat/client/lib/permissions";
import {
  type BrainModelChoice,
  brainModelChoice,
  brainModelChoices,
  isPlanId,
  PLAN_IDS,
  planModel as planModelOf,
  planOf,
} from "@agenteschat/client/lib/plans";
import { AUTO, apiProviderOf, isAuto, modelChoices, providerLabel } from "@agenteschat/client/lib/providers";
import { cleanSite, SITE } from "@agenteschat/client/lib/sites";
import {
  BrainLogo,
  BrainPortrait,
  Button,
  Checkbox,
  ComputerPortrait,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogSearchList,
  EffortPixels,
  Icon,
  type IconName,
  InfoHint,
  Input,
  LogoMark,
  OptionList,
  PlanMeter,
  ProviderLogo,
  planState,
  Segmented,
  Select,
  type SelectOption,
  SettingNote,
  Switch,
} from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { NO_COMPUTER, useNoComputer } from "@/components/AgentComputer";
import {
  modelOptions as apiModelOptions,
  DEFAULT_KEY,
  keyOptions,
  ModelSelect,
  pickerValue,
} from "@/components/AgentFields";
import { AddAccount, OpenPage } from "@/components/ai/AddAccountFlow";
import { accountOption } from "@/components/ai/ConnectAiSteps";
import { PlanReplies, PlanRepliesOf } from "@/components/ai/PlanReplies";
import { useConnectAi } from "@/components/ConnectAi";
import { LoadingLine } from "@/components/Loading";
import { CommandBlock } from "@/components/Machines";
import { useOrg } from "@/components/org-context";
import {
  OpenPrefsButton,
  ReconnectThisMacButton,
  ThisMacButton,
  useAgentsHere,
  useIsThisMac,
  useThisMac,
} from "@/components/ThisMac";
import { useComputerEdition } from "@/components/WorkspaceComputer";
import { useDirectory } from "@/hooks/useDirectory";
import { inDesktopApp } from "@/lib/desktop";
import { limitOffers, planMeterText, planWord } from "@/lib/plan-usage";
import { useToast } from "@/lib/toast";
import { useAgentEdit } from "./context";
import "@/components/browser/browser.css";

/*
 * What the agent works with, under its name: where
 * it works, who thinks and the browser, each opening its dialog. A choice brings what it depends on
 * along (Claude Code moves the agent to a computer that has it) and says so
 * before; "Usar" saves at once, in the right order (computer, then brain).
 */

export type WorkDialog = "brain" | "computer" | "browser";

/** The browser as the sentence says it: off, waiting for its computer, or on (any site / some). */
type BrowserWord = "off" | "waiting" | "any" | "only";

/** Shared reads: who thinks, where, and the browser (members don't load the private parts). */
function useWork() {
  const { org } = useOrg();
  const { agent, viewer } = useAgentEdit();
  const owner = viewer !== "member";
  const brain = useAgentBrain(org.id, agent.id, owner);
  const computer = useComputer(org.id, agent.id, owner);
  const browser = useAgentBrowserSettings(org.id, agent.id, owner);
  const scopes = useAgentScopes(org.id, agent.id);
  const machines = useMachines(org.id, owner);
  const granted = (scopes.data ?? []).some((s) => s.connectionId === null && s.scope === BROWSER_TOOL_SCOPE);
  const target = computer.data?.target;
  const machineId = target?.kind === "machine" ? target.machineId : NO_COMPUTER;
  const browserWord: BrowserWord = !granted
    ? "off"
    : !browser.data?.available
      ? "waiting"
      : (browser.data.allowedDomains ?? []).length > 0
        ? "only"
        : "any";
  return { brain, computer, browser, scopes, machines, granted, machineId, target, browserWord };
}

/** A cell of "Como trabalha" (and the memory's counts): its icon, what it is, the value; a button for who may change it. */
export function Cell({
  icon,
  label,
  value,
  more,
  sub,
  muted,
  openLabel,
  onOpen,
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  more?: string | null;
  sub?: string | null;
  muted?: boolean;
  openLabel?: string;
  onOpen?: () => void;
}) {
  const body = (
    <>
      <span className="agp-cell__key">{icon}</span>
      <span className="agp-cell__text">
        <small>{label}</small>
        <span className="agp-cell__value" data-muted={muted || undefined}>
          {value}
          {more && <span className="agp-cell__more"> · {more}</span>}
        </span>
        {sub && <span className="agp-cell__sub">{sub}</span>}
      </span>
    </>
  );
  if (!onOpen) return <div className="agp-cell agp-cell--ro">{body}</div>;
  return (
    <button type="button" className="agp-cell" aria-haspopup="dialog" aria-label={openLabel} onClick={onOpen}>
      {body}
      <Icon name="chevronDown" size={14} className="agp-cell__chev" />
    </button>
  );
}

/**
 * Como trabalha: where it works, who thinks (with the effort) and the browser
 * side by side, each opening its dialog; the numbers in the footer. Where comes first: who thinks depends on it.
 */
export function WorkCard({ onOpen, footer }: { onOpen: (dialog: WorkDialog) => void; footer?: ReactNode }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const { agent, viewer, saved, can, g } = useAgentEdit();
  const noComputer = useNoComputer();
  const edition = useComputerEdition(org.id);
  const models = useModels();
  const work = useWork();
  const connect = useConnectAi();
  const aiStatus = useAiStatus(org.id);
  // With no AI it thinks with nothing, whatever it is set to: the cell says so, as the badge by its name does.
  const noAi = aiStateOf(aiStatus.data, agent.id) === "no_ai";
  const view = work.brain.data;
  const kind: BrainKind = view?.brain ?? agent.brain?.kind ?? "model";
  // What pays: the API key, or the plan of the account it thinks with (the agent list's until its view loads).
  const ai: AiChoice = view
    ? aiChoiceOf(view)
    : kind === "model"
      ? "key"
      : planOfAccount({ kind, provider: agent.brain?.provider ?? null });
  const keyProvider = apiProviderOf(saved.model, models.data?.models ?? []);
  const orgModel = isAuto(saved.model)
    ? t("brain.auto.label")
    : (models.data?.models.find((m) => m.id === saved.model)?.label ?? saved.model);
  const shownPlanModel = view ? view.effectiveModel : (agent.brain?.model ?? null);
  const plan = isPlanId(ai) ? planOf(ai) : undefined;
  const effectiveChoice = view?.effectiveModel ? brainModelChoice(kind, plan, view.effectiveModel) : null;
  const planModel = isAuto(shownPlanModel)
    ? t("brain.auto.label")
    : view
      ? (brainModelChoices(plan, view.options.find((o) => o.kind === kind)?.models ?? []).find(
          (c) => c.value === effectiveChoice,
        )?.label ?? view.effectiveModel)
      : shownPlanModel;
  // The account by its name only where its plan has more than one there (Claude's and ChatGPT's count the computer's
  // own sign-in), else the plan's name.
  const planAccounts = view?.accountsSupported ? view.accounts.filter((a) => planOfAccount(a) === ai) : [];
  const accountWord =
    ai === "key" || planAccounts.length + (isPlanId(ai) ? 0 : 1) < 2
      ? null
      : view?.account
        ? (planAccounts.find((a) => a.id === view.account)?.label ?? null)
        : ownSignInName(t, view?.ownSignIn === true && view.canUsePlans, view?.computer?.name ?? "");
  // Near or at its plan's limit: said where the account is.
  const usage =
    !view || (kind !== "claude_code" && kind !== "codex")
      ? null
      : view.account
        ? view.accounts.find((a) => a.id === view.account)?.usage
        : view.ownUsage[kind];
  const sub =
    ai === "key"
      ? t("brain.foot.api")
      : [accountWord ?? planLabel(t, ai), planWord(t, i18n.language, usage)].filter(Boolean).join(" · ");
  const effort =
    kind !== "model" && view
      ? t("agentPage.work.cell.effort", {
          level: t(
            `agentPage.work.brain.efforts.${isAuto(view.effort) ? AUTO : shownEffort(view.effort)}`,
          ).toLowerCase(),
        })
      : null;
  const target = work.target;
  const machine = target?.kind === "machine" ? target : null;
  // Read once the server says where it works: "no computer" never shows while that loads.
  const choice = target && !machine ? noComputer.choice(true) : null;
  // No computer yet where the workspace's own is on its way: it works there once it's ready.
  const waiting = choice === "workspace" ? noComputer.setup : null;
  const member = viewer === "member";
  const reason = work.browser.data?.reason;
  const machineRow = machine ? work.machines.data?.find((m) => m.id === machine.machineId) : undefined;
  // Only a switch that is off has a step there: `not_reported` and `not_installed` are on, `outdated` has none.
  const steps = !member && work.browserWord === "waiting" && machine && reason === "switched_off";
  const desktopGranted = (work.scopes.data ?? []).some(
    (s) => s.connectionId === null && s.scope === DESKTOP_TOOL_SCOPE,
  );
  return (
    <div className="agp-work">
      <section className="agp-workcard" aria-label={t("agentPage.work.cell.label", g)}>
        <div className="agp-cells">
          {/* The Cloud's agents all work on the workspace's own computer, whose state the page's computer entry says:
              nothing to pick, so no cell. */}
          {!member && edition === "selfhost" && (
            <Cell
              icon={<Icon name={choice === "none" ? "dash" : "computer"} size={16} />}
              label={choice === "none" ? t("computer.target.label") : t("agentPage.work.cell.computer")}
              value={machine ? machine.name : choice ? noComputer.label(choice) : null}
              sub={waiting ? t(waiting.chipKey) : choice === "none" ? t("computer.target.noneText") : null}
              openLabel={t("agentPage.work.open.computer", g)}
              onOpen={can("machine") ? () => onOpen("computer") : undefined}
            />
          )}
          {noAi ? (
            <Cell
              icon={<Icon name="plug" size={16} />}
              label={t("agentPage.work.cell.brain")}
              value={t("noAi.chip")}
              sub={t("connectAi.title.any")}
              muted
              openLabel={t("connectAi.title.any")}
              onOpen={connect ? () => connect.open({ agentId: agent.id }) : undefined}
            />
          ) : (
            <Cell
              icon={
                ai !== "key" ? (
                  <ProviderLogo id={planMark(ai)} size="sm" />
                ) : keyProvider ? (
                  <ProviderLogo id={keyProvider} size="sm" />
                ) : (
                  <Icon name="brainAgent" size={16} />
                )
              }
              label={t("agentPage.work.cell.brain")}
              value={ai === "key" ? orgModel : planModel}
              more={ai === "key" ? null : effort}
              sub={sub}
              openLabel={t("agentPage.work.open.brain")}
              onOpen={can("brain") || can("model") ? () => onOpen("brain") : undefined}
            />
          )}
          {!member && (
            <Cell
              icon={<Icon name={work.browserWord === "off" ? "block" : "globe"} size={16} />}
              label={t("agentPage.work.cell.browser")}
              value={t(`agentPage.work.browser.${work.browserWord}`)}
              muted={work.browserWord === "off"}
              openLabel={t("agentPage.work.open.browser")}
              onOpen={() => onOpen("browser")}
            />
          )}
        </div>
        {footer && <div className="agp-workcard__foot">{footer}</div>}
      </section>
      {machine && !machine.online && kind !== "model" && (
        <SettingNote icon="pause">
          {edition === "cloud"
            ? t("agentPage.work.offlineCloud", { ...g, computer: machine.name })
            : t("agentPage.work.offline", { ...g, computer: machine.name })}
          <ThisMacReconnect machineId={machine.machineId} />
        </SettingNote>
      )}
      {steps && <BrowserSteps computer={machine.name} machineId={machine.machineId} />}
      {!member && desktopGranted && machineRow && <DesktopUseNote machine={machineRow} />}
    </div>
  );
}

/**
 * The agent may use apps on its desktop, and its Linux computer says what that still lacks there (ADR 0062):
 * the computer's own words, with the command in them to copy. Mac and Windows computers never have it, which
 * their own page says.
 */
function DesktopUseNote({ machine: m }: { machine: Machine }) {
  const { t } = useTranslation();
  const { g } = useAgentEdit();
  const use = m.desktopUse;
  if (m.os !== "linux" || !use || use.available || !use.reason) return null;
  const command = commandInReason(use.reason);
  return (
    <div className="brw-note ac-iconline">
      <Icon name="computer" size={16} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "block" }}>{t("desktop.use.agent", { ...g, computer: m.name })}</span>
        <span className="small muted">{use.reason}</span>
        {command && <CommandBlock command={command} />}
      </div>
    </div>
  );
}

/** In agentes for Mac, when the offline computer is this very Mac: "Reconectar" right there (ADR 0036). */
function ThisMacReconnect({ machineId }: { machineId: string }) {
  const { org } = useOrg();
  const here = useIsThisMac(org.id, machineId);
  return here ? (
    <span style={{ display: "block", marginTop: 8 }}>
      <ReconnectThisMacButton orgId={org.id} />
    </span>
  ) : null;
}

/**
 * What turns the computer's browser on, there; the page notices by itself. The app's three clicks, drawn small; on a
 * Linux computer, which may be a server without the app, the command too. In agentes for Mac on this very Mac: one
 * button to Preferences → Ferramentas instead (ADR 0036). Nothing once its switch is on, or on the workspace's own
 * computer, which nobody here reaches.
 */
export function BrowserSteps({ computer, machineId }: { computer: string; machineId?: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const here = useIsThisMac(org.id, machineId ?? "");
  const row = useMachines(org.id).data?.find((m) => m.id === machineId);
  if (row?.kind === "managed" || row?.access?.tools.browser) return null;
  if (here) {
    return (
      <section className="brw-steps" aria-label={t("machines.thisMac.browserTitle")}>
        <div className="brw-steps__head">
          <Icon name="computer" size={16} />
          <b>{t("machines.thisMac.browserTitle")}</b>
          <span className="brw-steps__wait">{t("agentPage.work.steps.waiting")}</span>
        </div>
        <div className="row" style={{ gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <span className="small muted" style={{ flex: 1, minWidth: 200 }}>
            {t("machines.thisMac.browserText")}
          </span>
          <OpenPrefsButton tab="tools">{t("machines.thisMac.openTools")}</OpenPrefsButton>
        </div>
      </section>
    );
  }
  const step = (n: number, shot: ReactNode, text: string) => (
    <div className="brw-step">
      <div className="brw-step__shot" aria-hidden="true">
        {shot}
      </div>
      <p>
        <i>{n}</i>
        {text}
      </p>
    </div>
  );
  const bar = (hit?: boolean) => (
    <div className="brw-mbar">
      <span />
      <span />
      <span className="brw-mbar__me" data-hit={hit || undefined}>
        <LogoMark size={12} />
      </span>
      <b>14:32</b>
    </div>
  );
  return (
    <section className="brw-steps" aria-label={t("agentPage.work.steps.title", { computer })}>
      <div className="brw-steps__head">
        <Icon name="computer" size={16} />
        <b>{t("agentPage.work.steps.title", { computer })}</b>
        <span className="brw-steps__wait">{t("agentPage.work.steps.waiting")}</span>
      </div>
      {row && !allowsInApp(row.os) ? (
        <div className="stack-4" style={{ gap: 6 }}>
          <span className="small">{t("browser.machine.offHelp")}</span>
          <span className="small muted">{t("machines.access.grantTerminal")}</span>
          <CommandBlock command={toolOnCommand(row, "browser")} />
        </div>
      ) : (
        <div className="brw-steps__grid">
          {step(1, bar(true), t("agentPage.work.steps.one"))}
          {step(
            2,
            <>
              {bar()}
              <div className="brw-mmenu">
                <span>{t("agentPage.work.steps.menuOpen")}</span>
                <hr />
                <span data-hl>{t("agentPage.work.steps.menuPrefs")}</span>
                <span>{t("agentPage.work.steps.menuPause")}</span>
                <hr />
                <span>{t("agentPage.work.steps.menuQuit")}</span>
              </div>
            </>,
            t("agentPage.work.steps.two"),
          )}
          {step(
            3,
            <div className="brw-mwin">
              <div className="brw-mwin__bar">{t("agentPage.work.steps.tools")}</div>
              <div className="brw-mwin__row">
                Claude Code <i data-on />
              </div>
              <div className="brw-mwin__row">
                {t("agentPage.work.steps.commands")} <i data-on />
              </div>
              <div className="brw-mwin__row" data-hl>
                {t("agentPage.work.computer.browser")} <i data-flip />
              </div>
            </div>,
            t("agentPage.work.steps.three"),
          )}
        </div>
      )}
      <p className="brw-steps__done ac-iconline">
        <Icon name="check" size={14} />
        {t("agentPage.work.steps.done")}
      </p>
    </section>
  );
}

/** The dialog that is open, if any. */
export function WorkDialogs({ open, onClose }: { open: WorkDialog | null; onClose: () => void }) {
  if (open === "brain") return <BrainDialog onClose={onClose} />;
  if (open === "computer") return <ComputerDialog onClose={onClose} />;
  if (open === "browser") return <BrowserDialog onClose={onClose} />;
  return null;
}

/** After a save: what depends on the computer, the brain and the browser refetches. */
function useRefresh() {
  const { org } = useOrg();
  const { agent } = useAgentEdit();
  const qc = useQueryClient();
  return () => {
    for (const key of [
      keys.agentBrain(org.id, agent.id),
      keys.aiStatus(org.id),
      keys.computer(org.id, agent.id),
      keys.agentBrowser(org.id, agent.id),
      keys.scopes(org.id, agent.id),
      keys.agentAccess(org.id, agent.id),
      keys.agents(org.id),
      keys.machines(org.id),
      // What it thinks with now is what new agents start with.
      keys.newAgentSetup(org.id),
    ])
      void qc.invalidateQueries({ queryKey: key });
  };
}

/** The computers this person may give the agent (the server checks again). */
function usePickable() {
  const { me } = useOrg();
  const { viewer } = useAgentEdit();
  const work = useWork();
  return (work.machines.data ?? []).filter(
    (m) => viewer === "admin" || m.pairedBy?.id === me.user.id || m.id === work.machineId,
  );
}

/** Where a computer brain would run: here if it can, else the first computer that has it (on ones first). */
type BrainMachine = { machineId: string; name: string; online: boolean; options: BrainOption[] };
function homeFor(kind: BrainKind, current: string, machines: BrainMachine[]) {
  const has = (m: BrainMachine) => m.options.some((o) => o.kind === kind && o.available);
  const here = machines.find((m) => m.machineId === current);
  if (here && has(here)) return here;
  return machines.filter(has).sort((a, b) => Number(b.online) - Number(a.online))[0] ?? null;
}

function Footer({
  note,
  disabled,
  busy,
  primary,
  onClose,
  onUse,
}: {
  note?: ReactNode;
  disabled: boolean;
  busy: boolean;
  primary: string;
  onClose: () => void;
  onUse: () => void;
}) {
  const { t } = useTranslation();
  return (
    <DialogFooter note={note}>
      <Button onClick={onClose}>{t("common.cancel")}</Button>
      <Button variant="primary" disabled={disabled} loading={busy} onClick={onUse}>
        {primary}
      </Button>
    </DialogFooter>
  );
}

// ── Quem pensa ──────────────────────────────────────────────────────────────

/*
 * The brains as a list; the chosen one opens into one card with its settings
 * full width under a hairline, each with a small label above it: the model one
 * click away, the effort as a pixel ramp, the account on that computer
 * (ADR 0041, only its owner), and at the card's foot a switch for answering
 * through the API while the computer is off.
 */

/**
 * Select values that aren't an account id: the computer's own sign-in, "Adicionar conta", and before a login's id
 * a sign-in of this agent's own to that login's account ("Also used by Ada").
 */
const HERE = "__computer";
const ADD = "__add";
const ALSO = "__also:";
/**
 * The effort's four levels. Automático is the model's choice, not a level: an automatic model picks the
 * effort too, and the ramp goes away.
 */
const EFFORTS = ["low", "medium", "high", "max"] as const;
type ShownEffort = (typeof EFFORTS)[number];
/** A stored `xhigh` shows as Alto, no effort (or an automatic one) as Médio (the default). */
const shownEffort = (e: BrainEffortSetting | null): ShownEffort =>
  e === "xhigh" ? "high" : e === null || isAuto(e) ? "medium" : e;

function BrainDialog({ onClose }: { onClose: () => void }) {
  const work = useWork();
  // The choices start from what is saved: the form mounts once it is loaded.
  if (!work.brain.data || !work.computer.data) return null;
  return <BrainForm view={work.brain.data} onClose={onClose} />;
}

/**
 * A switch's label on one line, its ⓘ right after it: outside the label, so pressing the ⓘ never flips the switch,
 * and the switch is described by it (`<id>-hint`). The hint reads the same whether the switch is on or off.
 */
function SwitchLabel({ htmlFor, label, hint }: { htmlFor: string; label: string; hint: string }) {
  const { t } = useTranslation();
  return (
    <span className="agp-brainoff ac-hintline">
      <label htmlFor={htmlFor}>
        <b>{label}</b>
      </label>
      <InfoHint name={t("common.about", { label })} id={`${htmlFor}-hint`}>
        {hint}
      </InfoHint>
    </span>
  );
}

/** A setting of the opened brain: a small label above its control (the label is the control's name too). */
function BrainField({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className="agp-brainfield">
      {label && (
        <span className="agp-brainfield__label" aria-hidden="true">
          {label}
        </span>
      )}
      {children}
    </div>
  );
}

function BrainForm({ view, onClose }: { view: AgentBrain; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const edition = useComputerEdition(org.id);
  const api = useApi();
  const toast = useToast();
  const refresh = useRefresh();
  const { agent, g, saved, can, draft, ownerFirst } = useAgentEdit();
  const work = useWork();
  const models = useModels();
  const credentials = useCredentials(org.id, canDo(org, "manage_credentials"));
  const platform = usePlatformKey(org.id);
  const settings = useSettings(org.id);
  // Answering through the API needs a key: the workspace's own, or the server's.
  const apiKey = useAiStatus(org.id).data?.apiKey !== false;
  const update = useUpdateAgent(org.id, agent.id);
  const setTarget = useSetComputerTarget(org.id);
  const connect = useConnectAi();
  // The card is what pays (the API key, or a plan: Claude's, ChatGPT's, a coding plan's); its brain follows from it.
  const savedCard = aiChoiceOf(view);
  const [card, setCard] = useState<AiChoice>(savedCard);
  const kind: BrainKind = card === "key" ? "model" : kindOf(card);
  const [planModel, setPlanModel] = useState<string | null>(view.effectiveModel);
  const [fallback, setFallback] = useState(view.fallback);
  const [model, setModel] = useState(saved.model);
  const [key, setKey] = useState(saved.key ?? DEFAULT_KEY);
  const [account, setAccount] = useState<string | null>(view.account);
  const [effort, setEffort] = useState<ShownEffort>(shownEffort(view.effort));
  const savedContext = isContextLimit(view.contextTokens) ? view.contextTokens : null;
  const [contextTokens, setContextTokens] = useState<ContextLimit | null>(savedContext);
  // "Configuração avançada" open: what it edits, put on the form by "Pronto" (nothing saves before "Usar").
  const [adv, setAdv] = useState<Advanced | null>(null);
  const [copying, setCopying] = useState(false);
  // "Levar a autonomia" off: the others keep their own.
  const [withAutonomy, setWithAutonomy] = useState(true);
  const hasOthers = (useAgents(org.id).data ?? []).some((a) => a.id !== agent.id);
  const qc = useQueryClient();
  // Adding an account: any, or (an account) one more login of it for this agent.
  const [adding, setAdding] = useState<boolean | MachineAccount>(false);
  // Accounts that arrived while the dialog was open (saved with the rest on "Usar").
  const [added, setAdded] = useState<MachineAccount[]>([]);
  const [arrived, setArrived] = useState<MachineAccount | null>(null);
  const [signInBegun, setSignInBegun] = useState(false);
  const [busy, setBusy] = useState(false);
  // "Atende outras pessoas" (ADR 0059 §5): moved onto a plan, the agent answers only its owner until they turn it on.
  const [share, setShare] = useState<{ kind: BrainKind; onlyOwner: boolean } | null>(null);
  const offId = useId();
  // Opening it is looking at the plans: their usage is looked up again (it comes back as `machine.updated`).
  useEffect(() => {
    void api.machines.refreshAccountUsage(org.id).catch(() => undefined);
  }, [api, org.id]);
  const meterText = planMeterText(t, i18n.language);
  // A brain switched off in this very Mac's Ferramentas (agentes for Mac): one click to turn it on (ADR 0036).
  const toolOffHere =
    useIsThisMac(org.id, view.computer?.machineId ?? "") && view.options.some((o) => o.reason === "tool_off");
  const machines = view.machines;
  // A coding plan thinks through Claude Code on the agent's computer, where its key is: it never moves.
  const homeOf = (c: AiChoice) => {
    if (c === "key") return null;
    if (!isPlanId(c)) return homeFor(kindOf(c), work.machineId, machines);
    const here = machines.find((m) => m.machineId === work.machineId);
    return here?.options.some((o) => o.kind === "claude_code" && o.available) ? here : null;
  };
  // While a sign-in is under way on the agent's computer, no brain there reads as offline: the sign-in's block says
  // how it stands (Reconnecting while that computer is away a moment).
  const away = (c: AiChoice) => {
    const where = homeOf(c);
    return !where?.online && !(signInBegun && where?.machineId === view.computer?.machineId);
  };
  const home = homeOf(card);
  const moves = home && home.machineId !== work.machineId ? home : null;
  const option = (home?.options ?? view.options).find((o) => o.kind === kind);
  // Accounts live on the agent's computer: none when the brain moves elsewhere or the app there is old.
  const accountKind = kind === "claude_code" || kind === "codex" ? kind : null;
  const accountsOn = accountKind !== null && view.accountsSupported && view.computer !== null && !moves;
  const computerName = view.computer?.name ?? "";
  // What a sign-in just reported wins over the last fetch (an account signed in again shows active at once).
  const allAccounts = [
    ...view.accounts.map((v) => added.find((a) => a.id === v.id) ?? v),
    ...added.filter((a) => !view.accounts.some((v) => v.id === a.id)),
  ];
  // Each person picks among their own accounts of the card's plan; someone else's shows only while it is this agent's.
  const accounts = allAccounts.filter((a) => planOfAccount(a) === card && (a.mine || a.id === view.account));
  const current = accounts.find((a) => a.id === account) ?? null;
  // The computers' rows: whether each one's own sign-ins are there, and their plan (a seat has its own words).
  const ai = useAiAccounts(org.id, view.canUsePlans);
  const rowOf = (machineId: string | undefined) => ai.data?.computers.find((c) => c.machineId === machineId);
  const row = rowOf(home?.machineId ?? view.computer?.machineId);
  // The computer's own sign-in is Claude's or ChatGPT's: a coding plan signs in with its key.
  const ownListed = accountKind !== null && !isPlanId(card) && ownSignInListed(view, row, accountKind);
  // The API key, Claude's and ChatGPT's plans, then each coding plan with an account there that is the viewer's or
  // that the agent thinks with.
  const cards: AiChoice[] = [
    "key",
    "claude",
    "chatgpt",
    ...PLAN_IDS.filter(
      (p) => p === savedCard || allAccounts.some((a) => a.provider === p && (a.mine || a.id === view.account)),
    ),
  ];
  // Another plan on the same program is another account, which only the agent's owner picks (the server keeps the
  // account otherwise): anyone else moves it only onto another program or the API.
  const ownersOnly = (c: AiChoice) => !view.canUsePlans && c !== "key" && c !== savedCard && kindOf(c) === view.brain;
  /**
   * Another card starts on what can think for the agent on its computer with that plan: that computer's own sign-in
   * where it's ready (Claude's and ChatGPT's), else one of the viewer's accounts of that plan that thinks for nobody or
   * for all of their agents there. With neither and no account of that plan there at all, its sign-in opens at once,
   * once the computer's row says its own sign-in isn't there.
   */
  const firstAccount = (c: AiChoice) => {
    const where = homeOf(c);
    const none = { account: null, signIn: false };
    if (c === "key" || !view.canUsePlans || !view.accountsSupported || !view.computer) return none;
    if (!where || where.machineId !== work.machineId) return none;
    if (!isPlanId(c) && ownSignInReady(view, rowOf(view.computer.machineId), kindOf(c))) return none;
    const theirs = allAccounts.filter((a) => a.mine && planOfAccount(a) === c);
    const free = theirs.find((a) => a.status === "active" && (a.usedBy.length === 0 || a.shared === true));
    if (free) return { account: free.id, signIn: false };
    const known = !view.ownSignIn || ai.data !== undefined;
    return { account: null, signIn: known && theirs.length === 0 && view.canManageAccounts };
  };
  const choose = (c: AiChoice) => {
    setCard(c);
    setArrived(null);
    // The account belongs to a plan: another card starts on what can think there.
    const first = c === savedCard ? { account: view.account, signIn: false } : firstAccount(c);
    setAccount(first.account);
    setAdding(first.signIn);
    if (c === "key") return;
    const opt = homeOf(c)?.options.find((o) => o.kind === kindOf(c));
    // Another plan has other models: it starts on its own default, and an agent on "Automático" (new agents start
    // there) stays automatic.
    const auto = card === "key" ? isAuto(view.effort) : isAuto(planModel);
    setPlanModel(c === savedCard ? view.effectiveModel : auto ? AUTO : (opt?.defaultModel ?? null));
  };
  // The card's plan names its models, whichever of its accounts thinks: on a coding plan, any of them.
  const plan = isPlanId(card) ? planOf(card) : undefined;
  const modelOptions = brainModelChoices(plan, option?.models ?? []);
  const autoMark = (
    <span className="newag__ib">
      <Icon name="bulb" size={16} />
    </span>
  );
  // The chosen account's plan usage; the computer's own sign-in's only where it can think for this agent.
  const usage = accountKind
    ? account === null
      ? ownListed && view.ownSignIn
        ? view.ownUsage[accountKind]
        : undefined
      : current?.usage
    : undefined;
  const limited = usage ? planState(usage).state === "limited" : false;
  const offers =
    limited && accountKind && view.canUsePlans ? limitOffers(accounts, accountKind, account).slice(0, 2) : [];
  // Signing in to it again is its owner's.
  const signedOut = current?.status === "signed_out" && current.mine;
  const accountChanged = accountsOn && account !== view.account;
  // A login made for one agent thinks for one: picking another agent's takes it from that one ("Mover para cá"). One
  // made for all of its owner's agents there thinks for this one too.
  const moving = accountChanged && current?.shared !== true && current?.usedBy.some((n) => n !== agent.name) === true;
  // An automatic model picks the effort too; a fixed one takes the ramp's level.
  const effortToSave: BrainEffortSetting = isAuto(planModel) ? AUTO : effort;
  const savedEffort: BrainEffortSetting = isAuto(view.effort) ? AUTO : shownEffort(view.effort);
  const effortChanged = kind !== "model" && effortToSave !== savedEffort;
  const savedOnlyOwner = kind === view.brain ? view.onlyOwner : true;
  const onlyOwner = share?.kind === kind ? share.onlyOwner : savedOnlyOwner;
  const shareChanged = kind !== "model" && onlyOwner !== savedOnlyOwner;
  const all = models.data?.models ?? [];
  // The context limits worth offering with the model chosen: under its window ("Automático": any of its line).
  const contextOptions = contextChoices(
    kind === "model"
      ? isAuto(model)
        ? undefined
        : all.find((m) => m.id === model)
      : isAuto(planModel)
        ? undefined
        : plan
          ? { modelId: planModelOf(plan, planModel).id }
          : option?.models.find((m) => m.value === (planModel ?? option?.defaultModel)),
  );
  // A limit past the model's window reads as its window: "Automático" (the server takes the smaller one too).
  const shownContext = contextTokens !== null && contextOptions.includes(contextTokens) ? contextTokens : null;
  const contextChanged = contextTokens !== savedContext;
  const unchanged =
    card === savedCard &&
    fallback === view.fallback &&
    !accountChanged &&
    !effortChanged &&
    !shareChanged &&
    !contextChanged &&
    (kind === "model"
      ? model === saved.model && key === (saved.key ?? DEFAULT_KEY)
      : planModel === view.effectiveModel);
  // A plan chosen now thinks with something there: the computer's own sign-in or an account of that plan.
  const needsAccount = card !== savedCard && accountsOn && view.canUsePlans && account === null && !ownListed;
  const modelList = apiModelOptions(
    t,
    i18n.language,
    modelChoices(all, credentials.data ?? [], platform.data ?? false),
  );
  const modelName = (value: string | null) =>
    isAuto(value)
      ? t("brain.auto.label")
      : (modelOptions.find((c) => c.value === brainModelChoice(kind, plan, value ?? ""))?.label ?? value ?? "");
  // What thinks, as every place says it: the API's model, or the model by the plan that pays for it.
  const brainName =
    card === "key"
      ? isAuto(model)
        ? t("brain.auto.label")
        : (all.find((m) => m.id === model)?.label ?? model)
      : thinksWith(t, card, modelName(planModel));
  /** This agent's choice, in the right order: its computer, then who thinks. */
  const saveThis = async () => {
    if (kind === "model") {
      if (view.brain !== "model" || contextChanged) {
        await api.agents.setBrain(org.id, agent.id, {
          brain: "model",
          fallback,
          ...(contextChanged ? { contextTokens } : {}),
        });
      }
      if (model !== saved.model || key !== (saved.key ?? DEFAULT_KEY)) {
        await update.mutateAsync({
          ...(model !== saved.model ? { model } : {}),
          ...(key !== (saved.key ?? DEFAULT_KEY) ? { credentialId: key === DEFAULT_KEY ? null : key } : {}),
        });
      }
      return;
    }
    if (moves) await setTarget.mutateAsync({ agentId: agent.id, machineId: moves.machineId });
    return api.agents.setBrain(org.id, agent.id, {
      brain: kind,
      model: planModel === option?.defaultModel ? null : planModel,
      fallback,
      ...(effortChanged ? { effort: effortToSave } : {}),
      ...(accountChanged && view.canUsePlans ? { account, ...(moving ? { moveAccount: true } : {}) } : {}),
      ...(shareChanged ? { onlyOwner } : {}),
      ...(contextChanged ? { contextTokens } : {}),
    });
  };
  const use = async () => {
    setBusy(true);
    try {
      const result = await saveThis();
      refresh();
      const same =
        !effortChanged &&
        !contextChanged &&
        card === savedCard &&
        fallback === view.fallback &&
        planModel === view.effectiveModel;
      const onlyAccount = accountChanged && !shareChanged && same;
      const onlyShare = shareChanged && !accountChanged && same;
      // Onto a plan it answers only its owner from now on (ADR 0059 §5): said, since it stops answering whoever it
      // answered before, with that owner's name to anyone else.
      const owner =
        kind !== "model" && kind !== view.brain && onlyOwner && !view.onlyOwner
          ? view.canUsePlans
            ? t("common.you")
            : ownerFirst
          : null;
      if (kind === "model" && view.brain !== "model" && view.onlyOwner) {
        // Off the plan it still answers only its owner: one click lets back in whoever it answered before.
        // "Só algumas pessoas ou papéis" with nobody picked has no one to let back in: no action.
        const people = (agent.audience?.userIds?.length ?? 0) + (agent.audience?.roleIds?.length ?? 0);
        toast.show(
          t("aiAccounts.share.backOnApi", g),
          "info",
          agent.audience?.mode === "people" && people === 0
            ? undefined
            : {
                label: people ? t("aiAccounts.share.letPeople", g) : t("aiAccounts.share.letEveryone", g),
                run: () =>
                  void api.agents
                    .setBrain(org.id, agent.id, { onlyOwner: false })
                    .then(refresh, () => toast.show(t("agentPage.work.failed"), "error")),
              },
        );
      } else if (onlyShare && !onlyOwner && result?.onlyOwner) {
        toast.show(t("aiAccounts.share.pickPeople", g), "info");
      } else
        toast.show(
          onlyShare
            ? t(onlyOwner ? "aiAccounts.share.savedOwner" : "aiAccounts.share.savedEveryone", g)
            : onlyAccount
              ? account === null
                ? // Chosen only where it is its owner's: the computer's own sign-in, the account their agents share.
                  t("aiAccounts.done.savedAgent", {
                    agent: agent.name,
                    label: lowerFirst(t("connectAi.own.shared"), i18n.language),
                  })
                : t("agentPage.work.saved.account", { ...g, account: current?.label ?? "" })
              : moves
                ? t(owner ? "agentPage.work.saved.brainMovedOwner" : "agentPage.work.saved.brainMoved", {
                    ...g,
                    brain: brainName,
                    computer: moves.name,
                    owner,
                  })
                : t(owner ? "agentPage.work.saved.brainOwner" : "agentPage.work.saved.brain", {
                    ...g,
                    brain: brainName,
                    owner,
                  }),
        );
      onClose();
    } catch {
      toast.show(t("agentPage.work.failed"), "error");
      refresh();
    } finally {
      setBusy(false);
    }
  };
  // "Usar em outros agentes" (ADR 0094): this choice and its saved Autonomia as a value, each agent taking it by its
  // own rules.
  const carried = withAutonomy ? view.autonomy : undefined;
  const autonomy = carried ? { autonomy: carried } : {};
  const setup: AgentSetup | null =
    kind === "model"
      ? {
          brain: "model",
          model,
          // Only admins see and change the key: anyone else's leaves each agent's own.
          ...(can("key") ? { key: key === DEFAULT_KEY ? null : key } : {}),
          contextTokens: shownContext,
          ...autonomy,
        }
      : home
        ? {
            brain: kind,
            machineId: home.machineId,
            account: accountsOn ? account : null,
            model: planModel === option?.defaultModel ? null : planModel,
            effort: effortToSave,
            contextTokens: shownContext,
            fallback,
            onlyOwner,
            ...autonomy,
          }
        : null;
  const setupText = [
    brainName,
    ...advancedParts(t, i18n.language, {
      kind,
      autoModel: isAuto(kind === "model" ? model : planModel),
      apiKey,
      now: { effort, contextTokens: shownContext, onlyOwner, fallback },
    }),
    ...(carried ? [autonomyWords(t, carried)] : []),
  ].join(" · ");
  const copyTo = async (agentIds: string[]) => {
    if (!setup) return;
    setBusy(true);
    try {
      if (!unchanged) await saveThis();
      const results = await api.agents.applySetup(org.id, { setup, agentIds });
      refresh();
      for (const id of agentIds) void qc.invalidateQueries({ queryKey: keys.agentBrain(org.id, id) });
      // Nova missão starts from each agent's Autonomia.
      void qc.invalidateQueries({ queryKey: [...keys.missions(org.id), "eligible"] });
      const { done, autonomyOnly, missed } = setupOutcome(results, agentIds.length);
      if (done > 0) toast.show(t("agentPage.work.brain.copy.done", { count: done, setup: setupText }));
      if (autonomyOnly > 0) toast.show(t("agentPage.work.brain.copy.autonomyOnly", { count: autonomyOnly }));
      if (missed > 0) toast.show(t("agentPage.work.brain.copy.missed", { count: missed }), "error");
      onClose();
    } catch {
      toast.show(t("agentPage.work.failed"), "error");
      refresh();
    } finally {
      setBusy(false);
    }
  };
  const side = (c: AiChoice) => {
    if (c === "key") return null;
    const where = homeOf(c);
    // A coding plan's card stays on the agent's computer, where its key is: no other computer could have it.
    if (!where)
      return isPlanId(c) ? null : (
        <>
          <Icon name="block" size={14} />
          {t("agentPage.work.brain.none")}
        </>
      );
    if (away(c))
      return (
        <>
          <Icon name="alert" size={14} />
          {edition === "cloud"
            ? t("agentPage.work.brain.offCloud", { computer: where.name })
            : t("agentPage.work.brain.off", { computer: where.name })}
        </>
      );
    // Where the agent already works goes without saying: only a move changes something.
    if (where.machineId === work.machineId) return null;
    return (
      <>
        <Icon name="computer" size={14} />
        {t("agentPage.work.brain.moves", { computer: where.name })}
      </>
    );
  };
  const reason = (c: AiChoice) => {
    if (c === "key") return null;
    const k = kindOf(c);
    const o = view.options.find((x) => x.kind === k);
    if (!o?.reason) return null;
    // The Cloud's agent without a computer yet gets the workspace's own: the plan signs in there once it's ready.
    if (o.reason === "no_computer" && edition === "cloud")
      return t("brain.reasons.no_computerCloud", { computer: t("computerSetup.title", { org: org.name }) });
    // The card names the plan: the line names the program on the computer that can't run it.
    const program = t(`brain.card.${k}`);
    if (o.reason === "tool_off") {
      const off = toolOffReason(
        work.machines.data?.find((m) => m.id === view.computer?.machineId),
        k,
      );
      return t(off.key, { computer: view.computer?.name ?? "", command: off.command, program });
    }
    return t(`brain.reasons.${o.reason}`, { computer: view.computer?.name ?? "", program });
  };
  const whereName = home?.name ?? "";
  const keyChoices = keyOptions(
    t,
    credentials.data ?? [],
    settings.data?.defaultCredentialId ?? null,
    apiProviderOf(model, all),
  );
  const accountIcon = accountKind ? <BrainLogo kind={accountKind} size="sm" /> : null;
  const shownModel = brainModelChoice(kind, plan, planModel ?? option?.defaultModel ?? "");
  const accountOptions: SelectOption[] = [
    ...(ownListed
      ? [
          {
            value: HERE,
            label: ownSignInName(t, view.ownSignIn && view.canUsePlans, computerName),
            leading: accountIcon,
          },
        ]
      : []),
    // One option per account: the login of it this agent has, one for all of its owner's agents, or a free one.
    // Else, where its plan allows a login per agent, one more for this agent ("Also used by Ada"); else another
    // agent's, moved here.
    ...accountChoices(accounts, [account, view.account]).map((c) => ({
      value: c.also ? `${ALSO}${c.login.id}` : c.login.id,
      ...accountOption(t, i18n.language, c, agent.name),
    })),
    {
      value: ADD,
      // A coding plan's key that was refused gets a new key; a sign-in that ended signs in again.
      label: signedOut
        ? t(isPlanId(card) ? "aiAccounts.page.newKey" : "agentPage.work.brain.signInAgain")
        : t("agentPage.work.brain.addAccount"),
      leading: (
        <span className="newag__ib">
          <Icon name="plus" size={16} />
        </span>
      ),
    },
  ];
  const shownAccounts = view.canManageAccounts ? accountOptions : accountOptions.filter((o) => o.value !== ADD);
  // On someone else's computer only whoever connected it adds a sign-in: with nothing of the owner's there, the account
  // says so in place of an empty list.
  const lockedHere = view.canUsePlans && shownAccounts.length === 0;
  const pairer = work.machines.data?.find((m) => m.id === view.computer?.machineId)?.pairedBy?.name.split(" ")[0];
  // The account says why only when it must: signed out, only the agent's owner changes it, or only whoever connected
  // the computer adds one there.
  const accountNote = signedOut
    ? t(isPlanId(card) ? "aiAccounts.page.keyRefused" : "agentPage.work.brain.accountSignedOut")
    : !view.canUsePlans && ownerFirst
      ? t("agentPage.work.brain.accountLocked", { name: ownerFirst })
      : lockedHere
        ? t("connectAi.accountsLocked", { name: pairer ?? "", computer: computerName })
        : null;
  const accountField = accountsOn && accountKind && (
    <BrainField label={t("agentPage.work.brain.account")}>
      {!lockedHere && (
        <Select
          className="agp-brainsel"
          aria-label={t("agentPage.work.brain.account")}
          // Nothing chosen yet, where the computer's own sign-in can't think: it starts at "Adicionar conta".
          value={account ?? (ownListed ? HERE : "")}
          placeholder={view.canManageAccounts ? t("agentPage.work.brain.addAccount") : undefined}
          disabled={!view.canUsePlans}
          onValueChange={(v) => {
            if (v === ADD) return setAdding(true);
            const also = v.startsWith(ALSO) ? accounts.find((a) => `${ALSO}${a.id}` === v) : undefined;
            if (also) return setAdding(also);
            setArrived(null);
            setAccount(v === HERE ? null : v);
          }}
          options={shownAccounts}
          renderValue={pickerValue}
        />
      )}
      {accountNote && <SettingNote icon={signedOut ? "alert" : "lock"}>{accountNote}</SettingNote>}
      {usage && <PlanMeter usage={usage} text={meterText} />}
      {limited && view.canUsePlans && (offers.length > 0 || view.canManageAccounts) && (
        <div className="agp-planoffer">
          {offers.map(({ account: a, used }) => (
            <Button
              key={a.id}
              size="sm"
              onClick={() => {
                setArrived(null);
                setAccount(a.id);
              }}
            >
              {used === null
                ? t("aiAccounts.usage.offer.useUnknown", { label: a.label })
                : t("aiAccounts.usage.offer.use", { label: a.label, pct: used })}
            </Button>
          ))}
          {view.canManageAccounts && (
            <Button size="sm" variant="ghost" onClick={() => setAdding(true)}>
              {t("aiAccounts.usage.offer.connect")}
            </Button>
          )}
        </div>
      )}
      {arrived && (
        <SettingNote icon="check" live>
          {t("agentPage.work.brain.add.done", { account: arrived.label, computer: computerName })}
        </SettingNote>
      )}
    </BrainField>
  );
  const also = typeof adding === "object" ? adding : undefined;
  // A sign-in for one more login of the account picked (`also`), else for this agent's own signed-out one again.
  const again = !also && signedOut ? current : null;
  const signingIn = also ?? again;
  // The model as a picker like the account's: Automático first, each model with its line. Claude's own models say what
  // each is for ("O mais capaz…"), a plan's what it's sold as, and what it needs from the plan's account behind its ⓘ;
  // several makers' models are grouped by maker, each beside its logo, the others beside their plan's. An alias the
  // plan leaves out runs its main model: shown as that one (`shownModel`).
  const apiProvider = apiProviderOf(model, all);
  const planLogo =
    card !== "key" ? (
      <ProviderLogo id={planMark(card)} size="sm" />
    ) : apiProvider ? (
      <ProviderLogo id={apiProvider} size="sm" />
    ) : null;
  const modelLine = (m: BrainModelChoice) =>
    !plan && kind === "claude_code" && isClaudeAlias(m.value)
      ? t(`agentPage.work.brain.modelLine.${m.value}`)
      : m.tag && t(`brain.modelTag.${m.tag}`);
  const planModelOptionsShown: SelectOption[] = [
    { value: AUTO, label: t("brain.auto.label"), description: t("brain.auto.hint"), leading: autoMark },
    ...modelOptions.map((m) => {
      const line = modelLine(m);
      return {
        value: m.value,
        label: m.label,
        ...(line ? { description: line } : {}),
        ...(m.needs ? { hint: t(`brain.modelNeeds.${m.needs}`) } : {}),
        ...(m.maker
          ? { group: providerLabel(m.maker), leading: <ProviderLogo id={m.maker} size="sm" /> }
          : { leading: planLogo }),
      };
    }),
  ];
  // Once chosen, what a model needs from its plan's account is the note under it, with where to give it.
  const chosenModel = modelOptions.find((m) => m.value === shownModel);
  const modelHow = chosenModel?.needs && plan && (
    <SettingNote icon="info" live>
      {t(`brain.modelHow.${chosenModel.needs}`)}
      <span style={{ display: "block", marginTop: 8 }}>
        <OpenPage href={plan.site}>{t("aiAccounts.add.openKeys", { site: new URL(plan.site).host })}</OpenPage>
      </span>
    </SettingNote>
  );
  // "Configuração avançada" says only what differs from the defaults (`ADVANCED_DEFAULTS`).
  const advancedNow: Advanced = { effort, contextTokens: shownContext, onlyOwner, fallback };
  const advancedLine = advancedSummary(t, i18n.language, {
    kind,
    autoModel: isAuto(planModel),
    apiKey,
    now: advancedNow,
  });
  const advancedRow = (
    <AdvancedRow
      line={advancedLine}
      onOpen={() => setAdv(advancedNow)}
      label={t("agentPage.work.brain.advanced.title")}
    />
  );
  // Once it can be saved and thinks with something: a plan just picked needs its account first.
  const thinksWithNothing = accountsOn && account === null && !ownListed;
  const copyRow = setup && hasOthers && !needsAccount && !thinksWithNothing && adding === false && (
    <AdvancedRow
      icon="copy"
      line={t("agentPage.work.brain.copy.rowLine")}
      onOpen={() => setCopying(true)}
      label={t("agentPage.work.brain.copy.row")}
    />
  );
  // Under the plan's card, labeled like the API key's: the model, then the account of that plan that pays for it.
  const planRows = (
    <>
      <BrainField label={t("agentPage.work.brain.planModel")}>
        <Select
          className="agp-brainsel"
          aria-label={t("agentPage.work.brain.planModel")}
          value={shownModel}
          onValueChange={setPlanModel}
          renderValue={pickerValue}
          options={planModelOptionsShown}
        />
        {modelHow}
      </BrainField>
      {accountField}
      {advancedRow}
      {copyRow}
    </>
  );
  const orgRows = can("model") ? (
    <>
      <BrainField label={t("agentPage.work.brain.planModel")}>
        <ModelSelect
          className="agp-brainsel"
          aria-label={t("agentPage.work.brain.planModel")}
          value={model}
          onChange={setModel}
          options={[
            // "Automático" first: each task gets its model and effort, from the line of the agent's key.
            {
              value: AUTO,
              label: t("brain.auto.label"),
              description: t("brain.auto.hint"),
              leading: autoMark,
            },
            // The model it has stays a choice when its list is out of reach (OpenRouter's) or no longer has it.
            ...(isAuto(model) || modelList.some((o) => o.value === model) ? [] : [{ value: model, label: model }]),
            ...modelList,
          ]}
        />
      </BrainField>
      <BrainField label={t("agentPage.work.brain.keyLabel")}>
        <Select
          className="agp-brainsel"
          aria-label={t("agentPage.work.brain.keyLabel")}
          value={key}
          onValueChange={setKey}
          placeholder={t("newAgent.noKeys")}
          renderValue={pickerValue}
          options={keyChoices}
        />
      </BrainField>
      {advancedRow}
      {copyRow}
    </>
  ) : (
    <SettingNote icon="lock">{t("agentPage.lock.admins")}</SettingNote>
  );
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("brain.title")}
      description={t("agentPage.work.brain.sub", g)}
      closeLabel={t("common.close")}
      width={560}
      className="agp-wdlg"
    >
      <DialogBody>
        <OptionList
          attached
          aria-label={t("brain.title")}
          value={card}
          onValueChange={choose}
          disabled={!can("brain")}
          options={cards.map((c) => {
            const where = homeOf(c);
            const off = c !== "key" && away(c);
            return {
              value: c,
              // Each plan by its maker's mark; the API key by its model's maker, or the agent itself when none is known.
              leading:
                c === "key" ? (
                  apiProvider ? (
                    <ProviderLogo id={apiProvider} />
                  ) : (
                    <BrainPortrait kind="agent" state={card === c ? "working" : "idle"} agent={draft.look} />
                  )
                ) : (
                  <ProviderLogo id={planMark(c)} off={off} />
                ),
              title: c === "key" ? t("agentPage.work.brain.model") : planLabel(t, c),
              tag: c === "chatgpt" ? t("brain.testing") : undefined,
              description:
                c === "key"
                  ? t("agentPage.work.brain.modelText", g)
                  : !where
                    ? reason(c)
                    : !view.canUsePlans && ownerFirst
                      ? ownersOnly(c)
                        ? t("agentPage.work.brain.accountLocked", { name: ownerFirst })
                        : t("agentPage.work.brain.planTextOf", { plan: planLabel(t, c), owner: ownerFirst })
                      : t("agentPage.work.brain.planText", { plan: planLabel(t, c) }),
              side: side(c),
              disabled: c !== "key" && (!where || ownersOnly(c)),
              children:
                c === "key" ? (
                  orgRows
                ) : adding && accountKind && view.computer ? (
                  <AddAccount
                    machineId={view.computer.machineId}
                    kind={accountKind}
                    computer={computerName}
                    again={again?.id}
                    {...(isPlanId(card) ? { provider: card } : {})}
                    email={signingIn?.email}
                    local={view.ownSignIn}
                    onBack={() => setAdding(false)}
                    onAdded={(a) => {
                      setAdded((list) => [...list.filter((x) => x.id !== a.id), a]);
                      setAccount(a.id);
                      setArrived(a);
                      setAdding(false);
                    }}
                    onUse={(a) => {
                      setArrived(null);
                      setAccount(a.id);
                      setAdding(false);
                    }}
                    onSigningIn={setSignInBegun}
                  />
                ) : (
                  planRows
                ),
            };
          })}
        />
        {toolOffHere && (
          <SettingNote icon="settings">
            {t("machines.thisMac.toolsOff")}
            <span style={{ display: "block", marginTop: 8 }}>
              <OpenPrefsButton tab="tools">{t("machines.thisMac.openTools")}</OpenPrefsButton>
            </span>
          </SettingNote>
        )}
        {/* Another plan, as the "Sem IA" cell offers it: Connect an AI, for this agent (its owner's choice). */}
        {view.canUsePlans && connect && (
          <span>
            <Button
              size="sm"
              variant="ghost"
              icon="plus"
              onClick={() => {
                onClose();
                connect.open({ agentId: agent.id });
              }}
            >
              {t("agentPage.work.brain.connectPlan")}
            </Button>
          </span>
        )}
      </DialogBody>
      <Footer
        disabled={unchanged || needsAccount || adding !== false || (kind !== "model" && !home)}
        busy={busy}
        primary={t("agentPage.work.use")}
        onClose={onClose}
        onUse={() => void use()}
      />
      {adv && (
        <Dialog
          open
          onOpenChange={(o) => !o && setAdv(null)}
          title={t("agentPage.work.brain.advanced.title")}
          description={t("agentPage.work.brain.advanced.sub", { brain: brainName })}
          closeLabel={t("common.close")}
          width={480}
          className="agp-wdlg"
        >
          <DialogBody>
            <section className="agp-advgroup">
              <h3 className="agp-advgroup__title">{t("agentPage.work.brain.advanced.think")}</h3>
              {kind !== "model" && !isAuto(planModel) && (
                <EffortPixels
                  label={t("agentPage.work.brain.effort")}
                  value={adv.effort}
                  onValueChange={(e) => setAdv({ ...adv, effort: e })}
                  color={draft.look.color}
                  steps={EFFORTS.map((e) => ({ value: e, label: t(`agentPage.work.brain.efforts.${e}`) }))}
                  hint={(e) => t(`agentPage.work.brain.effortText.${e}`)}
                />
              )}
              <ContextField
                value={adv.contextTokens}
                options={contextOptions}
                onChange={(n) => setAdv({ ...adv, contextTokens: n })}
              />
            </section>
            {kind !== "model" && (
              <section className="agp-advgroup">
                <h3 className="agp-advgroup__title">{t("agentPage.work.brain.advanced.answers")}</h3>
                {agent.ownerUserId &&
                  accountKind &&
                  (view.canUsePlans ? (
                    <PlanReplies
                      agent={agent.name}
                      on={!adv.onlyOwner}
                      onChange={(on) => setAdv({ ...adv, onlyOwner: !on })}
                      brain={accountKind}
                      plan={signInPlan({ account, accounts }, row, accountKind)}
                      coding={plan}
                    />
                  ) : (
                    <PlanRepliesOf on={!adv.onlyOwner} owner={ownerFirst ?? ""} agentName={agent.name} />
                  ))}
                {apiKey && (
                  <div className="agp-advswitch">
                    <SwitchLabel
                      htmlFor={offId}
                      label={t("agentPage.work.brain.fallbackTitle", { computer: whereName })}
                      hint={t("agentPage.work.brain.fallbackHint", g)}
                    />
                    <Switch
                      id={offId}
                      aria-describedby={`${offId}-hint`}
                      checked={adv.fallback}
                      onCheckedChange={(on) => setAdv({ ...adv, fallback: on })}
                    />
                  </div>
                )}
              </section>
            )}
          </DialogBody>
          <DialogFooter
            note={
              <Button
                size="sm"
                variant="ghost"
                disabled={isAdvancedDefault(kind, adv)}
                onClick={() => setAdv(advancedDefaults(kind, adv))}
              >
                {t("agentPage.work.brain.advanced.defaults")}
              </Button>
            }
          >
            <Button onClick={() => setAdv(null)}>{t("common.cancel")}</Button>
            <Button
              variant="primary"
              onClick={() => {
                setEffort(adv.effort);
                setContextTokens(adv.contextTokens);
                setFallback(adv.fallback);
                if (adv.onlyOwner !== onlyOwner) setShare({ kind, onlyOwner: adv.onlyOwner });
                setAdv(null);
              }}
            >
              {t("agentPage.work.brain.advanced.done")}
            </Button>
          </DialogFooter>
        </Dialog>
      )}
      {copying && setup && (
        <SetupCopyDialog
          setup={setup}
          setupText={setupText}
          autonomy={view.autonomy}
          withAutonomy={withAutonomy}
          onWithAutonomy={setWithAutonomy}
          busy={busy}
          onClose={() => setCopying(false)}
          onUse={(agentIds) => void copyTo(agentIds)}
        />
      )}
    </Dialog>
  );
}

/**
 * "Usar em outros agentes" (ADR 0094): every other agent with what the setup would do to it (the server's preview),
 * those that can take it first, "Todos" on top for all of them, and "Levar a autonomia" over them, which leaves each
 * agent's own when off. "Usar" saves this agent's choice and theirs.
 */
function SetupCopyDialog({
  setup,
  setupText,
  autonomy,
  withAutonomy,
  onWithAutonomy,
  busy,
  onClose,
  onUse,
}: {
  setup: AgentSetup;
  setupText: string;
  /** This agent's saved Autonomia. */
  autonomy: CommandApproval | undefined;
  withAutonomy: boolean;
  onWithAutonomy: (on: boolean) => void;
  busy: boolean;
  onClose: () => void;
  onUse: (agentIds: string[]) => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const { agent } = useAgentEdit();
  const agents = useAgents(org.id);
  const models = useModels();
  const dir = useDirectory(org.id);
  const others = (agents.data ?? []).filter((a) => a.id !== agent.id);
  // This agent first, as "Usar" saves it before the others: a sign-in made for one agent is its own then.
  const preview = useSetupPreview(org.id, setup, [agent.id, ...others.map((a) => a.id)]);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();
  const results = sortedResults((preview.data ?? []).filter((r) => r.agentId !== agent.id));
  const can = takers(results);
  const chosen = can.filter((id) => picked.has(id));
  const byId = new Map(others.map((a) => [a.id, a]));
  const shown = results.filter((r) => !query || byId.get(r.agentId)?.name.toLowerCase().includes(query));
  const nowOf = (a: Agent) =>
    a.brain && a.brain.kind !== "model"
      ? brainLine(t, a.brain, "").text
      : isAuto(a.model)
        ? t("brain.auto.label")
        : (models.data?.models.find((m) => m.id === a.model)?.label ?? a.model);
  const ownerOf = (a: Agent) => {
    const name = a.ownerUserId ? dir.memberById.get(a.ownerUserId)?.name : undefined;
    return name ? firstName(name) : undefined;
  };
  const toggle = (id: string, on: boolean) =>
    setPicked((p) => {
      const next = new Set(p);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("agentPage.work.brain.copy.title")}
      description={t("agentPage.work.brain.copy.sub", { setup: setupText })}
      closeLabel={t("common.close")}
      className="agp-copydialog"
    >
      {autonomy && (
        <div className="ac-dialog__tools">
          <label htmlFor="setup-autonomy" className="agp-copydialog__all">
            <span className="scope-row__text">
              <b>{t("agentPage.work.brain.copy.withAutonomy")}</b>
              <span className="small muted">
                {t("agentPage.work.brain.copy.withAutonomyLine", { value: autonomyName(t, autonomy) })}
              </span>
            </span>
            <Switch id="setup-autonomy" checked={withAutonomy} disabled={busy} onCheckedChange={onWithAutonomy} />
          </label>
        </div>
      )}
      {preview.data && (
        <div className="ac-dialog__tools">
          <label htmlFor="setup-all" className="agp-copydialog__all" data-off={can.length === 0 || undefined}>
            <Checkbox
              id="setup-all"
              checked={can.length > 0 && chosen.length === can.length}
              disabled={can.length === 0}
              onCheckedChange={(on) => setPicked(new Set(on ? can : []))}
            />
            <span className="scope-row__text">
              <b>{t("agentPage.work.brain.copy.all")}</b>
              <span className="small muted">
                {can.length === 0
                  ? t("agentPage.work.brain.copy.none")
                  : t("agentPage.work.brain.copy.allLine", { count: can.length })}
              </span>
            </span>
          </label>
        </div>
      )}
      {preview.isPending ? (
        <div className="ac-dialog__body">
          <LoadingLine width={220} />
        </div>
      ) : preview.isError ? (
        <p className="ac-dialog__empty">{t("agentPage.work.failed")}</p>
      ) : (
        <DialogSearchList
          query={q}
          onQueryChange={setQ}
          search={others.length > 8}
          searchLabel={t("agentPage.work.brain.copy.search")}
          searchPlaceholder={t("agentPage.work.brain.copy.search")}
          listLabel={t("agentPage.work.brain.copy.title")}
          isEmpty={shown.length === 0}
          emptyText={t("agentPage.work.brain.copy.noMatch", { q })}
        >
          {shown.map((r) => {
            const a = byId.get(r.agentId);
            if (!a) return null;
            const id = `setup-${a.id}`;
            const off = !changes(r);
            return (
              <label key={a.id} htmlFor={id} className="scope-row" data-off={off || undefined}>
                <Checkbox
                  id={id}
                  checked={!off && picked.has(a.id)}
                  disabled={off}
                  onCheckedChange={(on) => toggle(a.id, on)}
                />
                <AgentAvatar agentId={a.id} name={a.name} size="sm" />
                <span className="scope-row__text">
                  <span>{a.name}</span>
                  <span className="small muted">{setupResultLine(t, r, { now: nowOf(a), owner: ownerOf(a) })}</span>
                </span>
              </label>
            );
          })}
        </DialogSearchList>
      )}
      <DialogFooter bar>
        <Button variant="ghost" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button variant="primary" disabled={chosen.length === 0} loading={busy} onClick={() => onUse(chosen)}>
          {chosen.length === 0
            ? t("agentPage.work.brain.copy.pick")
            : t("agentPage.work.brain.copy.use", { count: chosen.length })}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/**
 * "Configuração avançada" and "Usar em outros agentes": shaped like the pickers above them, a chevron that opens a
 * step instead of a list.
 */
function AdvancedRow({
  label,
  line,
  icon = "settings",
  onOpen,
}: {
  label: string;
  line: string;
  icon?: IconName;
  onOpen: () => void;
}) {
  return (
    <div className="ac-select agp-brainsel agp-advrow">
      <button type="button" className="ac-select__trigger" onClick={onOpen}>
        <span className="ac-select__value">
          {pickerValue({
            value: "advanced",
            label,
            description: line,
            leading: (
              <span className="newag__ib">
                <Icon name={icon} size={16} />
              </span>
            ),
          })}
        </span>
        <Icon name="chevronRight" size={16} className="agp-advrow__chev" />
      </button>
    </div>
  );
}

/** The context limit: Automático, then the sizes under the model's window, with what the chosen one means. */
function ContextField({
  value,
  options,
  onChange,
}: {
  value: ContextLimit | null;
  options: readonly ContextLimit[];
  onChange: (value: ContextLimit | null) => void;
}) {
  const { t } = useTranslation();
  const label = t("agentPage.work.brain.context");
  const shown = value !== null && options.includes(value) ? value : null;
  return (
    <div className="agp-brainfield">
      <span className="ac-effort__head">
        <span>{label}</span>
        <span className="ac-effort__hint">{t(`agentPage.work.brain.contextText.${shown ?? "auto"}`)}</span>
      </span>
      <Segmented
        className="agp-brainseg"
        label={label}
        value={shown === null ? AUTO : String(shown)}
        onValueChange={(v) => onChange(v === AUTO ? null : (options.find((n) => String(n) === v) ?? null))}
        options={[
          { value: AUTO, label: t("brain.auto.label") },
          ...options.map((n) => ({ value: String(n), label: contextSize(n) })),
        ]}
      />
    </div>
  );
}

// ── Onde trabalha ───────────────────────────────────────────────────────────

function ComputerDialog({ onClose }: { onClose: () => void }) {
  const work = useWork();
  if (!work.computer.data || !work.machines.data) return null;
  return <ComputerForm onClose={onClose} />;
}

function ComputerForm({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const toast = useToast();
  const refresh = useRefresh();
  const { agent, g } = useAgentEdit();
  const work = useWork();
  const pickable = usePickable();
  const setTarget = useSetComputerTarget(org.id);
  const noComputer = useNoComputer();
  const listed = noComputer.pending ? pickable.filter((m) => m.kind !== "managed") : pickable;
  const none = noComputer.choice(work.machineId === NO_COMPUTER);
  // The workspace's own computer on its way stands in for no computer: what it will be (every brain, the
  // browser) and when.
  const workspace = none === "workspace" ? noComputer.setup : null;
  const [choice, setChoice] = useState(work.machineId);
  // In the desktop app, this computer not yet in the organization (where agents may work on it): connect it
  // from here and pick it (ADR 0036).
  const thisMac = useThisMac(org.id);
  const agentsHere = useAgentsHere();
  const thisMacFree = agentsHere && canDo(org, "pair_computers") && thisMac.isSuccess && !thisMac.data;
  const [busy, setBusy] = useState(false);
  const view = work.brain.data;
  const brain = view?.brain ?? "model";
  const optionsOf = (id: string) => view?.machines.find((m) => m.machineId === id)?.options ?? [];
  const has = (id: string, k: BrainKind) => optionsOf(id).some((o) => o.kind === k && o.available);
  const browserOf = (m: Machine | undefined) =>
    !m ? "none" : m.access?.tools.browser && m.browser?.available ? "ready" : m.browser ? "pending" : "none";
  const offers = (m: Machine) => {
    const list = [
      ...(has(m.id, "claude_code") ? [t("brain.card.claude_code")] : []),
      ...(has(m.id, "codex") ? [t("brain.card.codex")] : []),
      ...(browserOf(m) === "ready"
        ? [t("agentPage.work.computer.browser")]
        : browserOf(m) === "pending"
          ? [t("agentPage.work.computer.browserPending")]
          : []),
    ];
    return list.length ? list.join(" · ") : t("agentPage.work.computer.onlyModel");
  };
  const also = (id: string) => {
    if (id === work.machineId) return [];
    if (id === NO_COMPUTER && workspace) return [t("computerSetup.agentWaiting", g)];
    const m = pickable.find((x) => x.id === id);
    return [
      ...(brain !== "model" && !has(id, brain)
        ? [t("agentPage.work.computer.alsoBrain", { brain: t(`brain.card.${brain}`) })]
        : []),
      ...(m && !m.online ? [t("agentPage.work.computer.alsoOffline", g)] : []),
    ];
  };
  const status = (m: Machine) =>
    m.online ? t("agentPage.work.computer.online") : t("agentPage.work.computer.offline");
  const chosen = pickable.find((m) => m.id === choice);
  const use = async () => {
    setBusy(true);
    try {
      await setTarget.mutateAsync({ agentId: agent.id, machineId: choice === NO_COMPUTER ? null : choice });
      // What the new computer can't do goes back to the organization's model (said before, in the dialog).
      if (brain !== "model" && (choice === NO_COMPUTER ? !workspace : !has(choice, brain)))
        await api.agents.setBrain(org.id, agent.id, { brain: "model" });
      refresh();
      toast.show(
        chosen || workspace
          ? t("agentPage.work.saved.computer", { ...g, computer: chosen ? chosen.name : noComputer.label("workspace") })
          : t("agentPage.work.saved.none", g),
      );
      onClose();
    } catch {
      toast.show(t("agentPage.work.failed"), "error");
      refresh();
    } finally {
      setBusy(false);
    }
  };
  const note = (id: string) =>
    also(id).length > 0 ? (
      <div className="stack-4" style={{ gap: 6 }}>
        {also(id).map((a) => (
          <SettingNote key={a} icon="alert" live>
            {a}
          </SettingNote>
        ))}
      </div>
    ) : undefined;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("agentPage.work.computer.title", g)}
      description={t("agentPage.work.computer.sub", g)}
      closeLabel={t("common.close")}
      width={640}
      className="agp-wdlg"
    >
      <DialogBody>
        <OptionList
          aria-label={t("agentPage.work.computer.title", g)}
          value={choice}
          onValueChange={setChoice}
          options={[
            ...(none
              ? [
                  {
                    value: NO_COMPUTER,
                    // Portraits are as wide as their drawings: one column keeps the titles in line.
                    leading: (
                      <span className="machine-row__pic">
                        {none === "none" ? (
                          <Icon name="dash" size={20} />
                        ) : (
                          <ComputerPortrait
                            kind={WORKSPACE_COMPUTER_KIND}
                            state={workspace ? setupPortrait(workspace, false) : "online"}
                          />
                        )}
                      </span>
                    ),
                    title: noComputer.label(none),
                    description: workspace ? t(workspace.textKey) : t("computer.target.noneText"),
                    children: note(NO_COMPUTER),
                  },
                ]
              : []),
            ...listed.map((m) => ({
              value: m.id,
              leading: (
                <span className="machine-row__pic">
                  <ComputerPortrait kind={computerKind(m.os)} state={computerState(m)} />
                </span>
              ),
              title: m.name,
              description: `${status(m)} · ${offers(m)}`,
              children: note(m.id),
            })),
          ]}
        />
      </DialogBody>
      <Footer
        note={
          thisMacFree ? (
            <ThisMacButton orgId={org.id} canPair folders={false} onConnected={setChoice} />
          ) : (
            <Link
              to="/org/$orgId/settings/$section"
              params={{ orgId: org.id, section: "computers" }}
              className="small agp-wdlg__link"
            >
              <Icon name="plus" size={14} />
              {t("agentPage.work.computer.connect")}
            </Link>
          )
        }
        disabled={choice === work.machineId}
        busy={busy}
        primary={
          chosen
            ? t("agentPage.work.computer.useMachine", { computer: chosen.name })
            : workspace
              ? t("agentPage.work.computer.useMachine", { computer: noComputer.label("workspace") })
              : t("agentPage.work.use")
        }
        onClose={onClose}
        onUse={() => void use()}
      />
    </Dialog>
  );
}

// ── Navegador ───────────────────────────────────────────────────────────────

/** The agent's own browser in its profile choice (ADR 0110): any value that isn't a profile's id. */
const OWN_BROWSER = "own";

function BrowserDialog({ onClose }: { onClose: () => void }) {
  const work = useWork();
  if (!work.browser.data || !work.scopes.data || !work.computer.data || !work.machines.data) return null;
  return <BrowserForm onClose={onClose} />;
}

function BrowserForm({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const edition = useComputerEdition(org.id);
  const api = useApi();
  const toast = useToast();
  const refresh = useRefresh();
  const { agent, g, viewer } = useAgentEdit();
  const work = useWork();
  const pickable = usePickable();
  const setTarget = useSetComputerTarget(org.id);
  const saveSites = useUpdateAgentBrowserSettings(org.id, agent.id);
  const profileActions = useBrowserProfileMutations(org.id);
  const profiles = useBrowserProfiles(org.id);
  const dir = useDirectory(org.id);
  const mine = profilesOfAgent(profiles.data, agent.id);
  const savedProfile = work.browser.data?.profileId ?? null;
  const [profile, setProfile] = useState<string>(savedProfile ?? OWN_BROWSER);
  const profileId = profile === OWN_BROWSER ? null : profile;
  const admin = viewer === "admin";
  const domains = work.browser.data?.allowedDomains ?? [];
  const [mode, setMode] = useState<"any" | "only" | "off">(
    work.granted ? (domains.length > 0 ? "only" : "any") : "off",
  );
  const [sites, setSites] = useState(domains);
  const [typed, setTyped] = useState("");
  const [bad, setBad] = useState(false);
  const [busy, setBusy] = useState(false);
  // With no computer the browser needs a connected one: the first with the browser ready, else any.
  const ready = (m: Machine) => Boolean(m.access?.tools.browser && m.browser?.available);
  const moveTo =
    mode !== "off" && work.machineId === NO_COMPUTER
      ? (pickable.find((m) => ready(m) && m.online) ?? pickable.find(ready) ?? pickable[0] ?? null)
      : null;
  const add = () => {
    const site = cleanSite(typed);
    if (!site) return;
    if (!SITE.test(site)) return setBad(true);
    setTyped("");
    setBad(false);
    if (!sites.includes(site)) setSites([...sites, site]);
  };
  const on = mode !== "off";
  const sitesNow = mode === "only" ? sites : [];
  const unchanged =
    on === work.granted &&
    (!on || (JSON.stringify(sitesNow) === JSON.stringify(domains) && profileId === savedProfile));
  const noComputer = on && work.machineId === NO_COMPUTER && !moveTo;
  // Profiles only where they exist: its browser's computer is single mode, or it already has one (on such a computer).
  const browserMachineId = moveTo?.id ?? work.browser.data?.machine?.id ?? work.machineId;
  const withProfiles = mine.length > 0 || profilesApply(work.machines.data?.find((m) => m.id === browserMachineId));
  // On the Cloud the agent's browser comes with the workspace's computer: it can be turned on while that one is prepared.
  const blocked = noComputer && edition !== "cloud";
  const use = async () => {
    setBusy(true);
    try {
      if (moveTo) await setTarget.mutateAsync({ agentId: agent.id, machineId: moveTo.id });
      if (admin && on !== work.granted) {
        await saveLevels(api, org.id, agent.id, { "area:browser": on ? "write" : "none" });
      }
      if (on && JSON.stringify(sitesNow) !== JSON.stringify(domains))
        await saveSites.mutateAsync(sitesNow.length ? sitesNow : null);
      if (on && profileId !== savedProfile)
        await profileActions.setDefault.mutateAsync({ agentId: agent.id, profileId });
      refresh();
      const where = moveTo ?? pickable.find((m) => m.id === work.machineId);
      toast.show(
        !on
          ? t("agentPage.work.saved.browserOff", g)
          : on === work.granted
            ? t("agentPage.work.saved.sites")
            : where && !ready(where)
              ? t("agentPage.work.saved.browserWaiting", { computer: where.name })
              : t("agentPage.work.saved.browserOn", g),
      );
      onClose();
    } catch {
      toast.show(t("agentPage.work.failed"), "error");
      refresh();
    } finally {
      setBusy(false);
    }
  };
  const lead = (icon: IconName) => (
    <span className="agp-wdlg__key">
      <Icon name={icon} size={20} />
    </span>
  );
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("agentPage.work.browserDialog.title", g)}
      description={t("agentPage.work.browserDialog.sub")}
      closeLabel={t("common.close")}
      width={720}
      className="agp-wdlg"
    >
      <DialogBody>
        <div className="stack-4" style={{ gap: 14 }}>
          <OptionList
            aria-label={t("agentPage.work.browserDialog.title", g)}
            layout="cards"
            value={mode}
            onValueChange={(v) => (admin || v !== "off" ? setMode(v) : undefined)}
            options={[
              {
                value: "any",
                leading: lead("globe"),
                title: t("agentPage.work.browserDialog.any"),
                description: t("agentPage.work.browserDialog.anyText"),
                disabled: !admin && !work.granted,
              },
              {
                value: "only",
                leading: lead("lock"),
                title: t("agentPage.work.browserDialog.only"),
                description: t("agentPage.work.browserDialog.onlyText"),
                disabled: !admin && !work.granted,
              },
              {
                value: "off",
                leading: lead("block"),
                title: t("agentPage.work.browserDialog.off"),
                description: t("agentPage.work.browserDialog.offText"),
                disabled: !admin,
              },
            ]}
          />
          {mode === "only" && (
            <div className="brw-sites">
              {sites.map((d) => (
                <span key={d} className="brw-site">
                  <Icon name="globe" size={14} />
                  {d}
                  <button
                    type="button"
                    aria-label={t("browser.agent.removeSite", { site: d })}
                    onClick={() => setSites(sites.filter((x) => x !== d))}
                  >
                    <Icon name="close" size={14} />
                  </button>
                </span>
              ))}
              <Input
                className="brw-sites__add"
                value={typed}
                placeholder={`${t("browser.agent.addSite")} · ${t("browser.agent.addSiteHint")}`}
                aria-label={t("browser.agent.addSite")}
                onChange={(e) => {
                  setTyped(e.target.value);
                  setBad(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    add();
                  }
                }}
                onBlur={add}
              />
            </div>
          )}
          {bad && <SettingNote icon="alert">{t("browser.agent.badSite")}</SettingNote>}
          {!admin && <SettingNote icon="lock">{t("agentPage.work.browserDialog.admins")}</SettingNote>}
          {moveTo && (
            <SettingNote icon="arrowRight" live>
              {t("agentPage.work.browserDialog.moves", { ...g, computer: moveTo.name })}
            </SettingNote>
          )}
          {noComputer && (
            <SettingNote icon="alert">
              {edition === "cloud"
                ? t("agentPage.work.browserDialog.noComputerCloud", {
                    computer: t("computerSetup.title", { org: org.name }),
                  })
                : t("agentPage.work.browserDialog.noComputer")}
            </SettingNote>
          )}
          {blocked && inDesktopApp() && (
            <ThisMacButton orgId={org.id} canPair={canDo(org, "pair_computers")} folders={false} />
          )}
          {on && (moveTo ? !ready(moveTo) : work.browser.data?.reason === "switched_off") && (
            <BrowserSteps
              computer={moveTo?.name ?? work.browser.data?.machine?.name ?? ""}
              machineId={moveTo?.id ?? work.browser.data?.machine?.id}
            />
          )}
          {on && !withProfiles && <SettingNote icon="lock">{t("browser.agent.signedIn", g)}</SettingNote>}
          {on && withProfiles && (
            <div className="ac-field">
              <span className="ac-field__label" id="agent-browser-profile">
                {t("browser.profiles.agentChoice", g)}
              </span>
              <OptionList
                aria-labelledby="agent-browser-profile"
                value={profile}
                onValueChange={setProfile}
                options={[
                  {
                    value: OWN_BROWSER,
                    leading: lead("person"),
                    title: t("browser.profiles.own", g),
                    description: t("browser.profiles.ownText", g),
                    ...(savedProfile === null ? { tag: t("browser.profiles.default") } : {}),
                  },
                  ...mine.map((p) => {
                    const holder = p.holder?.type === "agent" ? dir.agentById.get(p.holder.agentId)?.name : undefined;
                    return {
                      value: p.id,
                      leading: lead("globe"),
                      title: p.name,
                      description: p.holder
                        ? t("browser.profiles.inUsePerson", {
                            name:
                              holder ??
                              (p.holder.type === "person" ? dir.memberById.get(p.holder.userId)?.name : "") ??
                              "",
                          })
                        : t("browser.profiles.free"),
                      ...(savedProfile === p.id ? { tag: t("browser.profiles.default") } : {}),
                    };
                  }),
                ]}
              />
              {!canDo(org, "manage_connectors") && (
                <div className="row">
                  <Button
                    size="sm"
                    icon="plus"
                    loading={profileActions.request.isPending}
                    onClick={() =>
                      profileActions.request.mutate(agent.id, {
                        onSuccess: () => toast.show(t("browser.profiles.asked")),
                        onError: () => toast.show(t("browser.profiles.failed"), "error"),
                      })
                    }
                  >
                    {t("browser.profiles.askMore")}
                  </Button>
                  <span className="small muted">{t("browser.profiles.askHelp", g)}</span>
                </div>
              )}
            </div>
          )}
        </div>
      </DialogBody>
      <Footer
        disabled={unchanged || blocked}
        busy={busy}
        primary={t("agentPage.work.use")}
        onClose={onClose}
        onUse={() => void use()}
      />
    </Dialog>
  );
}
