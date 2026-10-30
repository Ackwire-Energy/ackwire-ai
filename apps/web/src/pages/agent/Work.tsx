import type {
  AgentBrain,
  BrainEffortSetting,
  BrainKind,
  BrainOption,
  Machine,
  MachineAccount,
} from "@agenteschat/client";
import {
  BROWSER_TOOL_SCOPE,
  DESKTOP_TOOL_SCOPE,
  keys,
  useAgentBrain,
  useAgentBrowserSettings,
  useAgentScopes,
  useAiAccounts,
  useAiStatus,
  useApi,
  useComputer,
  useCredentials,
  useMachines,
  useModels,
  usePlatformKey,
  useSetComputerTarget,
  useSettings,
  useUpdateAgent,
  useUpdateAgentBrowserSettings,
} from "@agenteschat/client";
import { saveLevels } from "@agenteschat/client/lib/access-levels";
import { accountChoices, ownSignInName, signInPlan } from "@agenteschat/client/lib/ai-accounts";
import { setupPortrait, WORKSPACE_COMPUTER_KIND } from "@agenteschat/client/lib/computer";
import { joinNames, lowerFirst } from "@agenteschat/client/lib/format";
import { providerGrammar } from "@agenteschat/client/lib/grammar";
import {
  allowsInApp,
  commandInReason,
  computerKind,
  computerState,
  toolOffReason,
  toolOnCommand,
} from "@agenteschat/client/lib/machines";
import { aiStateOf } from "@agenteschat/client/lib/no-ai";
import { can as canDo } from "@agenteschat/client/lib/permissions";
import {
  accountPlan,
  isPlanId,
  planAliases,
  planModel as planModelOf,
  planModelOptions,
  planName,
  planOf,
} from "@agenteschat/client/lib/plans";
import { AUTO, isAuto, modelChoices, providerLabel } from "@agenteschat/client/lib/providers";
import { cleanSite, SITE } from "@agenteschat/client/lib/sites";
import {
  BrainLogo,
  BrainPortrait,
  Button,
  ComputerPortrait,
  Dialog,
  DialogBody,
  DialogFooter,
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
import { Trans, useTranslation } from "react-i18next";
import { NO_COMPUTER, useNoComputer } from "@/components/AgentComputer";
import { DEFAULT_KEY, keyOptions, modelDescription, pickerValue } from "@/components/AgentFields";
import { AddAccount } from "@/components/ai/AddAccountFlow";
import { PlanReplies, PlanRepliesOf } from "@/components/ai/PlanReplies";
import { useConnectAi } from "@/components/ConnectAi";
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
  const orgModel = isAuto(saved.model)
    ? t("brain.auto.label")
    : (models.data?.models.find((m) => m.id === saved.model)?.label ?? saved.model);
  const shownPlanModel = view ? view.effectiveModel : (agent.brain?.model ?? null);
  // A coding plan's account: its maker's model thinks (under Claude Code's alias).
  const thinkingAccount = view?.account ? view.accounts.find((a) => a.id === view.account) : undefined;
  const plan =
    kind === "claude_code" ? (view ? accountPlan(thinkingAccount) : planOf(agent.brain?.provider)) : undefined;
  const planModel = isAuto(shownPlanModel)
    ? t("brain.auto.label")
    : view
      ? plan
        ? planModelOf(plan, view.effectiveModel).label
        : (view.options.find((o) => o.kind === kind)?.models.find((m) => m.value === view.effectiveModel)?.label ??
          view.effectiveModel)
      : shownPlanModel;
  // The account only when the computer has more than one of that kind.
  const kindAccounts = view?.accountsSupported ? view.accounts.filter((a) => a.kind === kind) : [];
  const accountWord =
    kind === "model" || kindAccounts.length === 0
      ? null
      : view?.account
        ? (kindAccounts.find((a) => a.id === view.account)?.label ?? null)
        : ownSignInName(t, view?.ownSignIn === true && view.canUsePlans, view?.computer?.name ?? "");
  // Near or at its plan's limit: said where the account is.
  const usage =
    !view || (kind !== "claude_code" && kind !== "codex")
      ? null
      : view.account
        ? view.accounts.find((a) => a.id === view.account)?.usage
        : view.ownUsage[kind];
  const sub = [accountWord, planWord(t, i18n.language, usage)].filter(Boolean).join(" · ") || null;
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
          {!member && (
            <Cell
              icon={<Icon name={choice === "none" ? "dash" : "computer"} size={16} />}
              label={choice === "none" ? t("computer.target.label") : t("agentPage.work.cell.computer")}
              value={machine ? machine.name : choice ? noComputer.label(choice) : null}
              sub={waiting ? t(waiting.chipKey) : choice === "none" ? t("computer.target.noneText") : null}
              openLabel={t("agentPage.work.open.computer", g)}
              // The Cloud's agents all work on the workspace's own computer: nothing to pick.
              onOpen={can("machine") && edition === "selfhost" ? () => onOpen("computer") : undefined}
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
                kind === "model" ? (
                  <Icon name="brainAgent" size={16} />
                ) : plan ? (
                  <ProviderLogo id={(view ? thinkingAccount?.provider : agent.brain?.provider) ?? kind} size="sm" />
                ) : (
                  <BrainLogo kind={kind} size="sm" />
                )
              }
              label={t("agentPage.work.cell.brain")}
              value={kind === "model" ? orgModel : t(`brain.card.${kind}`)}
              more={kind === "model" ? null : [planModel, effort].filter(Boolean).join(" · ") || null}
              sub={kind === "model" ? t("agentPage.work.orgModel") : sub}
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
  const credentials = useCredentials(org.id, canDo(org.role, "manage_credentials"));
  const platform = usePlatformKey(org.id);
  const settings = useSettings(org.id);
  // Answering through the API needs a key: the workspace's own, or the server's.
  const apiKey = useAiStatus(org.id).data?.apiKey !== false;
  const update = useUpdateAgent(org.id, agent.id);
  const setTarget = useSetComputerTarget(org.id);
  const [kind, setKind] = useState<BrainKind>(view.brain);
  const [planModel, setPlanModel] = useState<string | null>(view.effectiveModel);
  const [fallback, setFallback] = useState(view.fallback);
  const [model, setModel] = useState(saved.model);
  const [key, setKey] = useState(saved.key ?? DEFAULT_KEY);
  const [account, setAccount] = useState<string | null>(view.account);
  const [effort, setEffort] = useState<ShownEffort>(shownEffort(view.effort));
  // Adding an account: any, or (an account) one more login of it for this agent.
  const [adding, setAdding] = useState<boolean | MachineAccount>(false);
  // Accounts that arrived while the dialog was open (saved with the rest on "Usar").
  const [added, setAdded] = useState<MachineAccount[]>([]);
  const [arrived, setArrived] = useState<MachineAccount | null>(null);
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
  const homeOf = (k: BrainKind) => (k === "model" ? null : homeFor(k, work.machineId, machines));
  const home = homeOf(kind);
  const moves = home && home.machineId !== work.machineId ? home : null;
  const option = (home?.options ?? view.options).find((o) => o.kind === kind);
  const choose = (k: BrainKind) => {
    setKind(k);
    setAdding(false);
    setArrived(null);
    // The account belongs to a brain kind: another kind starts on the computer's own.
    setAccount(k === view.brain ? view.account : null);
    if (k === "model") return;
    const opt = homeOf(k)?.options.find((o) => o.kind === k);
    // An agent on "Automático" (new agents start there) stays automatic on another brain.
    setPlanModel(k === view.brain ? view.effectiveModel : isAuto(view.effort) ? AUTO : (opt?.defaultModel ?? null));
  };
  // Accounts live on the agent's computer: none when the brain moves elsewhere or the app there is old.
  const accountKind = kind === "claude_code" || kind === "codex" ? kind : null;
  const accountsOn = accountKind !== null && view.accountsSupported && view.computer !== null && !moves;
  const computerName = view.computer?.name ?? "";
  // What a sign-in just reported wins over the last fetch (an account signed in again shows active at once).
  // Each person picks among their own accounts; someone else's shows only while it is this agent's.
  const accounts = [
    ...view.accounts.map((v) => added.find((a) => a.id === v.id) ?? v),
    ...added.filter((a) => !view.accounts.some((v) => v.id === a.id)),
  ].filter((a) => a.kind === accountKind && (a.mine || a.id === view.account));
  const current = accounts.find((a) => a.id === account) ?? null;
  // The row of the computer it thinks on, where its own sign-in's plan is (a seat has its own words).
  const thinksOn = home?.machineId ?? view.computer?.machineId;
  const row = useAiAccounts(org.id, view.canUsePlans && accountKind !== null).data?.computers.find(
    (c) => c.machineId === thinksOn,
  );
  // On a coding plan Claude Code keeps its aliases, each running the plan's model.
  const plan = accountKind === "claude_code" ? accountPlan(current) : undefined;
  // The chosen account's plan usage; the computer's own sign-in's only where it can think for this agent.
  const usage = accountKind
    ? account === null
      ? view.ownSignIn
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
  // One account thinks for one agent: picking another agent's takes it from that one ("Mover para cá").
  const moving = accountChanged && current?.usedBy.some((n) => n !== agent.name) === true;
  // An automatic model picks the effort too; a fixed one takes the ramp's level.
  const effortToSave: BrainEffortSetting = isAuto(planModel) ? AUTO : effort;
  const savedEffort: BrainEffortSetting = isAuto(view.effort) ? AUTO : shownEffort(view.effort);
  const effortChanged = kind !== "model" && effortToSave !== savedEffort;
  const savedOnlyOwner = kind === view.brain ? view.onlyOwner : true;
  const onlyOwner = share?.kind === kind ? share.onlyOwner : savedOnlyOwner;
  const shareChanged = kind !== "model" && onlyOwner !== savedOnlyOwner;
  // A plan brain not saved yet: the button says whose plan it is.
  const planKind = kind !== "model" && kind !== view.brain ? kind : null;
  const unchanged =
    kind === view.brain &&
    fallback === view.fallback &&
    !accountChanged &&
    !effortChanged &&
    !shareChanged &&
    (kind === "model"
      ? model === saved.model && key === (saved.key ?? DEFAULT_KEY)
      : planModel === view.effectiveModel);
  const all = models.data?.models ?? [];
  const choices = modelChoices(all, credentials.data ?? [], platform.data ?? false);
  const modelName = (value: string | null) =>
    isAuto(value)
      ? t("brain.auto.label")
      : plan
        ? planModelOf(plan, value).label
        : (option?.models.find((m) => m.value === value)?.label ?? value ?? "");
  const brainName = (k: BrainKind) =>
    k === "model"
      ? isAuto(model)
        ? t("brain.auto.label")
        : (all.find((m) => m.id === model)?.label ?? model)
      : `${t(`brain.card.${k}`)} · ${modelName(planModel)}`;
  const use = async () => {
    setBusy(true);
    try {
      if (kind === "model") {
        if (view.brain !== "model") await api.agents.setBrain(org.id, agent.id, { brain: "model", fallback });
        if (model !== saved.model || key !== (saved.key ?? DEFAULT_KEY)) {
          await update.mutateAsync({
            ...(model !== saved.model ? { model } : {}),
            ...(key !== (saved.key ?? DEFAULT_KEY) ? { credentialId: key === DEFAULT_KEY ? null : key } : {}),
          });
        }
      } else {
        if (moves) await setTarget.mutateAsync({ agentId: agent.id, machineId: moves.machineId });
        await api.agents.setBrain(org.id, agent.id, {
          brain: kind,
          model: planModel === option?.defaultModel ? null : planModel,
          fallback,
          ...(effortChanged ? { effort: effortToSave } : {}),
          ...(accountChanged && view.canUsePlans ? { account, ...(moving ? { moveAccount: true } : {}) } : {}),
          ...(shareChanged ? { onlyOwner } : {}),
        });
      }
      refresh();
      const same =
        !effortChanged && kind === view.brain && fallback === view.fallback && planModel === view.effectiveModel;
      const onlyAccount = accountChanged && !shareChanged && same;
      const onlyShare = shareChanged && !accountChanged && same;
      if (kind === "model" && view.brain !== "model" && view.onlyOwner) {
        // Off the plan it still answers only its owner: one click lets back in whoever it answered before.
        toast.show(t("aiAccounts.share.backOnApi", g), "info", {
          label: agent.audience?.userIds?.length
            ? t("aiAccounts.share.letPeople", g)
            : t("aiAccounts.share.letEveryone", g),
          run: () =>
            void api.agents
              .setBrain(org.id, agent.id, { onlyOwner: false })
              .then(refresh, () => toast.show(t("agentPage.work.failed"), "error")),
        });
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
                ? t("agentPage.work.saved.brainMoved", { ...g, brain: brainName(kind), computer: moves.name })
                : t("agentPage.work.saved.brain", { ...g, brain: brainName(kind) }),
        );
      onClose();
    } catch {
      toast.show(t("agentPage.work.failed"), "error");
      refresh();
    } finally {
      setBusy(false);
    }
  };
  const side = (k: BrainKind) => {
    if (k === "model") return null;
    const where = homeOf(k);
    if (!where)
      return (
        <>
          <Icon name="block" size={14} />
          {t("agentPage.work.brain.none")}
        </>
      );
    if (!where.online)
      return (
        <>
          <Icon name="alert" size={14} />
          {edition === "cloud"
            ? t("agentPage.work.brain.offCloud", { computer: where.name })
            : t("agentPage.work.brain.off", { computer: where.name })}
        </>
      );
    return (
      <>
        <Icon name="computer" size={14} />
        {where.machineId === work.machineId
          ? t("agentPage.work.brain.on", { computer: where.name })
          : t("agentPage.work.brain.moves", { computer: where.name })}
      </>
    );
  };
  const reason = (k: BrainKind) => {
    const o = view.options.find((x) => x.kind === k);
    if (!o?.reason) return null;
    // The Cloud's agent without a computer yet gets the workspace's own: the plan signs in there once it's ready.
    if (o.reason === "no_computer" && edition === "cloud")
      return t("brain.reasons.no_computerCloud", { computer: t("computerSetup.title", { org: org.name }) });
    if (o.reason === "tool_off" && k !== "model") {
      const off = toolOffReason(
        work.machines.data?.find((m) => m.id === view.computer?.machineId),
        k,
      );
      return t(off.key, { computer: view.computer?.name ?? "", command: off.command });
    }
    return t(`brain.reasons.${o.reason}`, { computer: view.computer?.name ?? "" });
  };
  const whereName = home?.name ?? "";
  const keyChoices = keyOptions(t, credentials.data ?? [], settings.data?.defaultCredentialId ?? null);
  const accountIcon = accountKind ? <BrainLogo kind={accountKind} size="sm" /> : null;
  const shownModel = planModel ?? option?.defaultModel ?? "";
  const accountOptions: SelectOption[] = [
    {
      value: HERE,
      label: ownSignInName(t, view.ownSignIn && view.canUsePlans, computerName),
      // The computer's own sign-in thinks only for agents of whoever connected it (ADR 0059 §3).
      disabled: !view.ownSignIn && view.account !== null,
      ...(view.ownSignIn ? {} : { description: t("aiAccounts.share.hereNotYours", { computer: computerName }) }),
      leading: accountIcon,
    },
    // One option per account: the login of it this agent has, or a free one. Else, where its plan allows a login
    // per agent, one more for this agent ("Also used by Ada"); else another agent's, moved here.
    ...accountChoices(accounts, [account, view.account]).map(({ login: a, usedBy, also }) => {
      // One login thinks for one agent.
      const others = a.usedBy.filter((n) => n !== agent.name).join(", ");
      const about = !a.mine
        ? t("agentPage.work.brain.accountOf", { name: a.ownerName?.split(" ")[0] ?? "" })
        : also
          ? t("agentPage.work.brain.accountAlso", { agents: joinNames(usedBy, t("newAgent.and")) })
          : a.status === "signed_out"
            ? t("agentPage.work.brain.accountSignedOut")
            : others
              ? t("agentPage.work.brain.accountMove", { agents: others })
              : a.keyHint
                ? t("aiAccounts.page.keyEnds", { hint: a.keyHint })
                : a.email;
      return {
        value: also ? `${ALSO}${a.id}` : a.id,
        label: a.plan ? `${a.label} · ${planName(a.plan)}` : a.label,
        disabled: !a.mine,
        description: [about, planWord(t, i18n.language, a.usage)].filter(Boolean).join(" · ") || undefined,
        leading: a.provider ? <ProviderLogo id={a.provider} size="sm" /> : accountIcon,
      };
    }),
    {
      value: ADD,
      label: signedOut ? t("agentPage.work.brain.signInAgain") : t("agentPage.work.brain.addAccount"),
      leading: (
        <span className="newag__ib">
          <Icon name="plus" size={16} />
        </span>
      ),
    },
  ];
  // The account says why only when it must: signed out, or only the agent's owner changes it.
  const accountNote = signedOut
    ? t("agentPage.work.brain.accountSignedOut")
    : !view.canUsePlans && ownerFirst
      ? t("agentPage.work.brain.accountLocked", { name: ownerFirst })
      : null;
  const accountField = accountsOn && accountKind && (
    <BrainField>
      <Select
        className="agp-brainsel"
        aria-label={t(`agentPage.work.brain.account.${accountKind}`)}
        value={account ?? HERE}
        disabled={!view.canUsePlans}
        onValueChange={(v) => {
          if (v === ADD) return setAdding(true);
          const also = v.startsWith(ALSO) ? accounts.find((a) => `${ALSO}${a.id}` === v) : undefined;
          if (also) return setAdding(also);
          setArrived(null);
          setAccount(v === HERE ? null : v);
        }}
        options={view.canManageAccounts ? accountOptions : accountOptions.filter((o) => o.value !== ADD)}
        renderValue={pickerValue}
      />
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
  const planRows = (
    <>
      <BrainField label={t("agentPage.work.brain.planModel")}>
        <Segmented
          className="agp-brainseg"
          label={t("agentPage.work.brain.planModel")}
          // An alias the plan leaves out runs its main model: shown as that one.
          value={
            plan && !isAuto(shownModel) && !planAliases(plan).some((a) => a === shownModel) ? "sonnet" : shownModel
          }
          onValueChange={setPlanModel}
          options={[
            { value: AUTO, label: t("brain.auto.label") },
            ...(plan
              ? planModelOptions(plan)
              : (option?.models ?? []).map((m) => ({ value: m.value, label: m.label }))),
          ]}
        />
        {isAuto(planModel) && (
          <SettingNote icon="bulb" live>
            {t("brain.auto.hint")}
          </SettingNote>
        )}
      </BrainField>
      {!isAuto(planModel) && (
        <EffortPixels
          label={t("agentPage.work.brain.effort")}
          value={effort}
          onValueChange={setEffort}
          color={draft.look.color}
          steps={EFFORTS.map((e) => ({ value: e, label: t(`agentPage.work.brain.efforts.${e}`) }))}
          hint={(e) => t(`agentPage.work.brain.effortText.${e}`)}
        />
      )}
      {accountField}
      {agent.ownerUserId &&
        accountKind &&
        (view.canUsePlans ? (
          <PlanReplies
            agent={agent.name}
            on={!onlyOwner}
            onChange={(on) => setShare({ kind, onlyOwner: !on })}
            brain={accountKind}
            plan={signInPlan({ account, accounts }, row, accountKind)}
            coding={plan}
          />
        ) : (
          <PlanRepliesOf on={!onlyOwner} owner={ownerFirst ?? ""} agentName={agent.name} />
        ))}
      {apiKey && (
        <div className="ac-optcard__foot">
          <SwitchLabel
            htmlFor={offId}
            label={t("agentPage.work.brain.fallbackTitle", { computer: whereName })}
            hint={t("agentPage.work.brain.fallbackHint", g)}
          />
          <Switch id={offId} aria-describedby={`${offId}-hint`} checked={fallback} onCheckedChange={setFallback} />
        </div>
      )}
    </>
  );
  const orgRows = can("model") ? (
    <>
      <BrainField label={t("agentPage.work.brain.planModel")}>
        <Select
          className="agp-brainsel"
          aria-label={t("agentPage.work.brain.planModel")}
          value={model}
          onValueChange={setModel}
          renderValue={pickerValue}
          options={[
            // "Automático" first: each task gets its model and effort, from the line of the agent's key.
            {
              value: AUTO,
              label: t("brain.auto.label"),
              description: t("brain.auto.hint"),
              leading: (
                <span className="newag__ib">
                  <Icon name="bulb" size={16} />
                </span>
              ),
            },
            ...choices.flatMap(([provider, list]) =>
              list.map(({ model: m, available }) => ({
                value: m.id,
                label: m.label,
                group: providerLabel(provider),
                disabled: !available,
                leading: <ProviderLogo id={provider} size="sm" />,
                description: available
                  ? modelDescription(t, i18n.language, m)
                  : t("newAgent.modelNeedsKey", providerGrammar(t, provider)),
              })),
            ),
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
    </>
  ) : (
    <SettingNote icon="lock">{t("agentPage.lock.admins")}</SettingNote>
  );
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("brain.title")}
      description={t("agentPage.work.brain.sub")}
      closeLabel={t("common.close")}
      width={560}
      className="agp-wdlg"
    >
      <DialogBody>
        <OptionList
          attached
          aria-label={t("brain.title")}
          value={kind}
          onValueChange={choose}
          disabled={!can("brain")}
          options={(["model", "claude_code", "codex"] as const).map((k) => {
            const where = homeOf(k);
            const off = k !== "model" && !where?.online;
            return {
              value: k,
              // The computer brains by their makers' marks; thinking through the organization, the agent itself.
              leading:
                k === "model" ? (
                  <BrainPortrait kind="agent" state={kind === k ? "working" : "idle"} agent={draft.look} />
                ) : (
                  <BrainLogo kind={k} off={off} />
                ),
              title: k === "model" ? t("agentPage.work.brain.model") : t(`brain.card.${k}`),
              tag: k === "codex" ? t("brain.testing") : undefined,
              description: k !== "model" && !where ? reason(k) : t(`agentPage.work.brain.${k}Text`, g),
              side: side(k),
              disabled: k !== "model" && !where,
              children:
                k === "model" ? (
                  orgRows
                ) : adding && accountKind && view.computer ? (
                  <AddAccount
                    machineId={view.computer.machineId}
                    kind={accountKind}
                    computer={computerName}
                    again={again?.id}
                    {...(isPlanId(signingIn?.provider) ? { provider: signingIn.provider } : {})}
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
      </DialogBody>
      <Footer
        note={
          <span className="agp-wdlg__note">
            <Trans
              i18nKey={moves ? "agentPage.work.brain.previewMoved" : "agentPage.work.brain.preview"}
              values={{ brain: brainName(kind), computer: moves?.name ?? "" }}
              components={{ b: <b /> }}
            />
          </span>
        }
        disabled={unchanged || adding !== false || (kind !== "model" && !home)}
        busy={busy}
        primary={planKind ? t(`agentPage.work.usePlan.${planKind}`) : t("agentPage.work.use")}
        onClose={onClose}
        onUse={() => void use()}
      />
    </Dialog>
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
  const thisMacFree = agentsHere && canDo(org.role, "post") && thisMac.isSuccess && !thisMac.data;
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
  const unchanged = on === work.granted && (!on || JSON.stringify(sitesNow) === JSON.stringify(domains));
  const noComputer = on && work.machineId === NO_COMPUTER && !moveTo;
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
            <ThisMacButton orgId={org.id} canPair={canDo(org.role, "post")} folders={false} />
          )}
          {on && (moveTo ? !ready(moveTo) : work.browser.data?.reason === "switched_off") && (
            <BrowserSteps
              computer={moveTo?.name ?? work.browser.data?.machine?.name ?? ""}
              machineId={moveTo?.id ?? work.browser.data?.machine?.id}
            />
          )}
          {on && <SettingNote icon="lock">{t("browser.agent.signedIn", g)}</SettingNote>}
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
