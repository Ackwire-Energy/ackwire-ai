import type { AgentBrain, BrainKind, BrainOption, Machine } from "@agenteschat/client";
import {
  BROWSER_TOOL_SCOPE,
  keys,
  useAgentBrain,
  useAgentBrowserSettings,
  useAgentScopes,
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
import { engineOfBrain } from "@agenteschat/client/lib/brain";
import { computerKind, computerState } from "@agenteschat/client/lib/machines";
import { can as canDo } from "@agenteschat/client/lib/permissions";
import { modelChoices } from "@agenteschat/client/lib/providers";
import {
  BrainPortrait,
  Button,
  Chip,
  ComputerPortrait,
  Dialog,
  DialogBody,
  DialogFooter,
  Icon,
  type IconName,
  Input,
  LogoMark,
  OptionList,
  SettingNote,
} from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { CLOUD } from "@/components/AgentComputer";
import { DEFAULT_KEY, KeySelect, keyOptions, ModelCards } from "@/components/AgentFields";
import { cleanSite, SITE } from "@/components/browser/sites";
import { useOrg } from "@/components/org-context";
import { useToast } from "@/lib/toast";
import { useAgentEdit } from "./context";
import "@/components/browser/browser.css";

/*
 * telas/PerfilAgente.html: what the agent works with, said as one sentence
 * under its name ("Pensa com [Claude Code · Opus] no [Mac mini] e [navega em
 * sites]."). Each word opens its dialog. A choice brings what it depends on
 * along (Claude Code moves the agent to a computer that has it) and says so
 * before; "Usar" saves at once, in the right order (computer, then brain).
 */

export type WorkDialog = "brain" | "computer" | "browser";

const BRAIN_ICON: Record<BrainKind, IconName> = {
  model: "brainAgent",
  claude_code: "brainClaudeCode",
  codex: "brainCodex",
};

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
  const machineId = target?.kind === "machine" ? target.machineId : CLOUD;
  const browserWord: BrowserWord = !granted
    ? "off"
    : !browser.data?.available
      ? "waiting"
      : (browser.data.allowedDomains ?? []).length > 0
        ? "only"
        : "any";
  return { brain, computer, browser, scopes, machines, granted, machineId, target, browserWord };
}

/** A word of the sentence: a button for who may change it, plain words for everyone else. */
function Word({
  icon,
  muted,
  children,
  label,
  onOpen,
}: {
  icon: IconName;
  muted?: boolean;
  children: ReactNode;
  label: string;
  onOpen?: () => void;
}) {
  if (!onOpen) return <span className="agp-word agp-word--ro">{children}</span>;
  return (
    <button
      type="button"
      className="agp-word"
      data-muted={muted || undefined}
      aria-haspopup="dialog"
      aria-label={label}
      onClick={onOpen}
    >
      <Icon name={icon} size={16} />
      <span className="agp-word__text">{children}</span>
      <Icon name="chevronDown" size={14} className="agp-word__chev" />
    </button>
  );
}

/** The sentence under the agent's name, and the steps on its computer while the browser waits. */
export function WorkSentence({ onOpen }: { onOpen: (dialog: WorkDialog) => void }) {
  const { t } = useTranslation();
  const { agent, viewer, saved, can, g } = useAgentEdit();
  const models = useModels();
  const work = useWork();
  const view = work.brain.data;
  const kind: BrainKind = view?.brain ?? agent.brain?.kind ?? "model";
  const orgModel = models.data?.models.find((m) => m.id === saved.model)?.label ?? saved.model;
  const planModel = view
    ? (view.options.find((o) => o.kind === kind)?.models.find((m) => m.value === view.effectiveModel)?.label ??
      view.effectiveModel)
    : (agent.brain?.model ?? null);
  const brainWords =
    kind === "model" ? (
      <>
        {t("agentPage.work.orgModel")} <span className="agp-word__more">· {orgModel}</span>
      </>
    ) : (
      <>
        {t(`brain.card.${kind}`)}
        {planModel && <span className="agp-word__more"> · {planModel}</span>}
      </>
    );
  const target = work.target;
  const machine = target?.kind === "machine" ? target : null;
  const member = viewer === "member";
  const components = {
    brain: (
      <Word
        icon={BRAIN_ICON[kind]}
        label={t("agentPage.work.open.brain")}
        onOpen={can("brain") || can("model") ? () => onOpen("brain") : undefined}
      >
        {brainWords}
      </Word>
    ),
    computer: (
      <Word
        icon={machine ? "computer" : "cloud"}
        label={t("agentPage.work.open.computer")}
        onOpen={can("machine") ? () => onOpen("computer") : undefined}
      >
        {machine ? machine.name : t("agentPage.work.cloud")}
      </Word>
    ),
    browser: (
      <Word
        icon={work.browserWord === "off" ? "block" : "globe"}
        muted={work.browserWord === "off"}
        label={t("agentPage.work.open.browser")}
        onOpen={member ? undefined : () => onOpen("browser")}
      >
        {t(`agentPage.work.browser.${work.browserWord}`)}
      </Word>
    ),
    end: <span className="agp-work__end" />,
  };
  const reason = work.browser.data?.reason;
  const steps =
    !member && work.browserWord === "waiting" && machine && (reason === "switched_off" || reason === "not_reported");
  return (
    <div className="agp-work">
      <p className="agp-work__sentence">
        {member ? (
          <Trans i18nKey="agentPage.work.sentenceMember" components={components} />
        ) : (
          <Trans
            i18nKey={machine ? "agentPage.work.sentenceMachine" : "agentPage.work.sentenceCloud"}
            components={components}
          />
        )}
      </p>
      {machine && !machine.online && kind !== "model" && (
        <SettingNote icon="pause">{t("agentPage.work.offline", { ...g, computer: machine.name })}</SettingNote>
      )}
      {steps && <BrowserSteps computer={machine.name} />}
    </div>
  );
}

/** The three clicks on the computer that turn its browser on, drawn small; the page notices by itself. */
export function BrowserSteps({ computer }: { computer: string }) {
  const { t } = useTranslation();
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
      <p className="brw-steps__done">
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

function BrainDialog({ onClose }: { onClose: () => void }) {
  const work = useWork();
  // The choices start from what is saved: the form mounts once it is loaded.
  if (!work.brain.data || !work.computer.data) return null;
  return <BrainForm view={work.brain.data} onClose={onClose} />;
}

function BrainForm({ view, onClose }: { view: AgentBrain; onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const toast = useToast();
  const refresh = useRefresh();
  const { agent, g, saved, can, draft } = useAgentEdit();
  const work = useWork();
  const models = useModels();
  const credentials = useCredentials(org.id, canDo(org.role, "manage_credentials"));
  const platform = usePlatformKey(org.id);
  const settings = useSettings(org.id);
  const update = useUpdateAgent(org.id, agent.id);
  const setTarget = useSetComputerTarget(org.id);
  const [kind, setKind] = useState<BrainKind>(view.brain);
  const [planModel, setPlanModel] = useState<string | null>(view.effectiveModel);
  const [fallback, setFallback] = useState(view.fallback);
  const [model, setModel] = useState(saved.model);
  const [key, setKey] = useState(saved.key ?? DEFAULT_KEY);
  const [busy, setBusy] = useState(false);
  const machines = view.machines;
  const homeOf = (k: BrainKind) => (k === "model" ? null : homeFor(k, work.machineId, machines));
  const home = homeOf(kind);
  const moves = home && home.machineId !== work.machineId ? home : null;
  const option = (home?.options ?? view.options).find((o) => o.kind === kind);
  const choose = (k: BrainKind) => {
    setKind(k);
    if (k === "model") return;
    const opt = homeOf(k)?.options.find((o) => o.kind === k);
    setPlanModel(k === view.brain ? view.effectiveModel : (opt?.defaultModel ?? null));
  };
  // A plan brain not saved yet: the person confirms the warning with the button itself.
  const planKind = kind !== "model" && kind !== view.brain ? kind : null;
  const plan = planKind !== null;
  const unchanged =
    kind === view.brain &&
    fallback === view.fallback &&
    (kind === "model"
      ? model === saved.model && key === (saved.key ?? DEFAULT_KEY)
      : planModel === view.effectiveModel);
  const all = models.data?.models ?? [];
  const choices = modelChoices(all, credentials.data ?? [], platform.data ?? false);
  const brainName = (k: BrainKind) =>
    k === "model"
      ? (all.find((m) => m.id === model)?.label ?? model)
      : `${t(`brain.card.${k}`)} · ${option?.models.find((m) => m.value === planModel)?.label ?? planModel ?? ""}`;
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
          ...(plan ? { acceptPlanTerms: true } : {}),
        });
      }
      refresh();
      toast.show(
        moves
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
  const foot = (k: BrainKind) => {
    if (k === "model") return <Chip icon="wallet">{t("agentPage.work.brain.paid")}</Chip>;
    const where = homeOf(k);
    if (!where) return <Chip icon="block">{t("agentPage.work.brain.none")}</Chip>;
    if (!where.online) return <Chip icon="alert">{t("agentPage.work.brain.off", { computer: where.name })}</Chip>;
    return (
      <Chip icon="computer">
        {where.machineId === work.machineId
          ? t("agentPage.work.brain.on", { computer: where.name })
          : t("agentPage.work.brain.moves", { computer: where.name })}
      </Chip>
    );
  };
  const reason = (k: BrainKind) => {
    const o = view.options.find((x) => x.kind === k);
    return o?.reason ? t(`brain.reasons.${o.reason}`, { computer: view.computer?.name ?? "" }) : null;
  };
  const whereName = home?.name ?? "";
  const keyChoices = keyOptions(t, credentials.data ?? [], settings.data?.defaultCredentialId ?? null);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("brain.title")}
      description={t("agentPage.work.brain.sub")}
      closeLabel={t("common.close")}
      width={760}
      className="agp-wdlg"
    >
      <DialogBody>
        <OptionList
          aria-label={t("brain.title")}
          layout="cards"
          value={kind}
          onValueChange={choose}
          disabled={!can("brain")}
          options={(["model", "claude_code", "codex"] as const).map((k) => {
            const where = homeOf(k);
            const off = k !== "model" && !where?.online;
            return {
              value: k,
              leading: (
                <BrainPortrait
                  kind={engineOfBrain(k)}
                  state={off ? "off" : kind === k ? "working" : "idle"}
                  agent={draft.look}
                />
              ),
              title: k === "model" ? t("agentPage.work.brain.model") : t(`brain.card.${k}`),
              tag: k === "codex" ? t("brain.testing") : undefined,
              description: k !== "model" && !where ? reason(k) : t(`agentPage.work.brain.${k}Text`),
              foot: foot(k),
              disabled: k !== "model" && !where,
              children:
                k === "model" ? (
                  can("model") ? (
                    <div className="stack-4" style={{ gap: 12 }}>
                      <ModelCards choices={choices} value={model} money onChange={setModel} />
                      <KeySelect value={key} onChange={setKey} options={keyChoices} />
                    </div>
                  ) : (
                    <SettingNote icon="lock">{t("agentPage.lock.admins")}</SettingNote>
                  )
                ) : (
                  <div className="stack-4" style={{ gap: 14 }}>
                    <span className="newag__label">
                      {t("agentPage.work.brain.planModel")}{" "}
                      <span className="newag__opt-label">{t("agentPage.work.brain.planModelHint")}</span>
                    </span>
                    <OptionList
                      aria-label={t("agentPage.work.brain.planModel")}
                      layout="tiles"
                      value={planModel ?? option?.defaultModel ?? ""}
                      onValueChange={setPlanModel}
                      options={(option?.models ?? []).map((m) => ({
                        value: m.value,
                        title: m.label,
                        tag: m.recommended ? t("brain.recommended") : undefined,
                      }))}
                    />
                    <span className="newag__label">{t("agentPage.work.brain.whenOff", { computer: whereName })}</span>
                    <OptionList
                      aria-label={t("agentPage.work.brain.whenOff", { computer: whereName })}
                      layout="tiles"
                      value={fallback ? "on" : "off"}
                      onValueChange={(v) => setFallback(v === "on")}
                      options={[
                        {
                          value: "on",
                          leading: <BrainPortrait kind="agent" agent={draft.look} />,
                          title: t("agentPage.work.brain.fallbackOn"),
                          description: t("agentPage.work.brain.fallbackOnText"),
                        },
                        {
                          value: "off",
                          leading: <ComputerPortrait kind="mac" state="offline" />,
                          title: t("agentPage.work.brain.fallbackOff", { computer: whereName }),
                          description: t("agentPage.work.brain.fallbackOffText"),
                        },
                      ]}
                    />
                  </div>
                ),
            };
          })}
        />
      </DialogBody>
      <Footer
        note={
          planKind ? (
            <span className="agp-wdlg__note">
              <Icon name="alert" size={14} />
              <span>
                <Trans i18nKey={`agentPage.work.planNote.${planKind}`} components={{ b: <b /> }} />
              </span>
            </span>
          ) : (
            <span className="agp-wdlg__note">
              <Trans
                i18nKey={moves ? "agentPage.work.brain.previewMoved" : "agentPage.work.brain.preview"}
                values={{ brain: brainName(kind), computer: moves?.name ?? "" }}
                components={{ b: <b /> }}
              />
            </span>
          )
        }
        disabled={unchanged || (kind !== "model" && !home)}
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
  const [choice, setChoice] = useState(work.machineId);
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
    const m = pickable.find((x) => x.id === id);
    return [
      ...(brain !== "model" && !has(id, brain)
        ? [t("agentPage.work.computer.alsoBrain", { brain: t(`brain.card.${brain}`) })]
        : []),
      ...(work.granted && id === CLOUD ? [t("agentPage.work.computer.alsoBrowser")] : []),
      ...(m && !m.online ? [t("agentPage.work.computer.alsoOffline", g)] : []),
    ];
  };
  const status = (m: Machine) =>
    m.online ? t("agentPage.work.computer.online") : t("agentPage.work.computer.offline");
  const chosen = pickable.find((m) => m.id === choice);
  const use = async () => {
    setBusy(true);
    try {
      await setTarget.mutateAsync({ agentId: agent.id, machineId: choice === CLOUD ? null : choice });
      // What the new computer can't do goes back to the organization's model (said before, in the dialog).
      if (brain !== "model" && (choice === CLOUD || !has(choice, brain)))
        await api.agents.setBrain(org.id, agent.id, { brain: "model" });
      refresh();
      toast.show(
        chosen
          ? t("agentPage.work.saved.computer", { ...g, computer: chosen.name })
          : t("agentPage.work.saved.cloud", g),
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
      description={t("agentPage.work.computer.sub")}
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
            {
              value: CLOUD,
              leading: <ComputerPortrait kind="cloud" state="online" />,
              title: t("computer.target.cloud"),
              description: t("agentPage.work.computer.cloudText"),
              children: note(CLOUD),
            },
            ...pickable.map((m) => ({
              value: m.id,
              leading: <ComputerPortrait kind={computerKind(m.os)} state={computerState(m)} />,
              title: m.name,
              description: `${status(m)} · ${offers(m)}`,
              children: note(m.id),
            })),
          ]}
        />
      </DialogBody>
      <Footer
        note={
          <Link
            to="/org/$orgId/settings/$section"
            params={{ orgId: org.id, section: "computers" }}
            className="small agp-wdlg__link"
          >
            <Icon name="plus" size={14} />
            {t("agentPage.work.computer.connect")}
          </Link>
        }
        disabled={choice === work.machineId}
        busy={busy}
        primary={
          chosen
            ? t("agentPage.work.computer.useMachine", { computer: chosen.name })
            : t("agentPage.work.computer.useCloud")
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
  // On the cloud the browser needs a connected computer: the first with the browser ready, else any.
  const ready = (m: Machine) => Boolean(m.access?.tools.browser && m.browser?.available);
  const moveTo =
    mode !== "off" && work.machineId === CLOUD
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
  const noComputer = on && work.machineId === CLOUD && !moveTo;
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
                children: (
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
                      placeholder={t("browser.agent.addSite")}
                      aria-label={t("browser.agent.addSite")}
                      title={t("browser.agent.addSiteHint")}
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
                ),
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
          {bad && <SettingNote icon="alert">{t("browser.agent.badSite")}</SettingNote>}
          {!admin && <SettingNote icon="lock">{t("agentPage.work.browserDialog.admins")}</SettingNote>}
          {moveTo && (
            <SettingNote icon="arrowRight" live>
              {t("agentPage.work.browserDialog.moves", { ...g, computer: moveTo.name })}
            </SettingNote>
          )}
          {noComputer && <SettingNote icon="alert">{t("agentPage.work.browserDialog.noComputer")}</SettingNote>}
          {on && (moveTo ? !ready(moveTo) : !work.browser.data?.available && work.browser.data?.machine) && (
            <BrowserSteps computer={moveTo?.name ?? work.browser.data?.machine?.name ?? ""} />
          )}
          {on && <SettingNote icon="lock">{t("browser.agent.signedIn", g)}</SettingNote>}
        </div>
      </DialogBody>
      <Footer
        disabled={unchanged || noComputer}
        busy={busy}
        primary={t("agentPage.work.use")}
        onClose={onClose}
        onUse={() => void use()}
      />
    </Dialog>
  );
}
