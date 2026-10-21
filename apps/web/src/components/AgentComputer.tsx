import type {
  Agent,
  AgentComputer,
  ComputerTarget,
  Machine,
  SandboxNetwork,
  SandboxSettings,
} from "@agenteschat/client";
import {
  useAgents,
  useComputer,
  useComputerAction,
  useMachines,
  useSandboxSettings,
  useSaveSandboxSettings,
  useSetComputerTarget,
} from "@agenteschat/client";
import {
  busyDisplay,
  busyView,
  type ComputerAction,
  type ComputerDisplay,
  POLL_MS,
  READY_FLASH_MS,
  reached,
} from "@agenteschat/client/lib/computer";
import { errorText } from "@agenteschat/client/lib/errors";
import { relativeTime } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { computerKind, computerState, folderName, foldersOfAgent } from "@agenteschat/client/lib/machines";
import { can } from "@agenteschat/client/lib/permissions";
import {
  Button,
  Card,
  Checkbox,
  Chip,
  ComputerIcon,
  ComputerPortrait,
  Dialog,
  DialogBody,
  DialogFooter,
  Field,
  Icon,
  type IconName,
  Input,
  List,
  Menu,
  MenuItem,
  RadioCard,
  RadioGroup,
  Select,
  type SelectOption,
  Switch,
  Token,
  TokenList,
} from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { LoadingCards, LoadingLine } from "@/components/Loading";
import { MachineChip } from "@/components/Machines";
import { useOrg } from "@/components/org-context";
import { useToast } from "@/lib/toast";

const STATUS_ICON: Record<ComputerDisplay, IconName> = {
  running: "check",
  stopped: "waiting",
  archived: "drive",
  none: "dash",
  starting: "spinner",
  stopping: "spinner",
  removing: "spinner",
};

/** Presets for the allowlist. */
export const DOMAIN_PRESETS: { id: "python" | "node"; domains: string[] }[] = [
  { id: "python", domains: ["pypi.org", "files.pythonhosted.org"] },
  { id: "node", domains: ["registry.npmjs.org"] },
];
export const MAX_DOMAINS = 100;

/** `example.com` or `*.example.com`. */
export const isDomain = (v: string) =>
  /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(v.trim()) && v.trim().length <= 253;

export function ComputerChip({ status }: { status: ComputerDisplay }) {
  const { t } = useTranslation();
  const busy = status === "starting" || status === "stopping" || status === "removing";
  return (
    // `key`: a new status fades in (no motion when reduced).
    <Chip
      key={status}
      icon={STATUS_ICON[status]}
      className={busy ? "computer-chip computer-chip--busy" : "computer-chip"}
      aria-live="polite"
    >
      {t(`computer.status.${status}`)}
    </Chip>
  );
}

/** "1,2 GB · usado há 2 h" (its cost counts in the agent's budget; admins see money in Usage). */
function ComputerFacts({ pc }: { pc: AgentComputer }) {
  const { t, i18n } = useTranslation();
  if (pc.status === "none") return <span className="muted">{t("computer.none")}</span>;
  return (
    <span className="small muted tabular">
      {t("computer.facts", {
        disk: new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 }).format(pc.diskUsedGib),
        when: pc.lastUsedAt ? relativeTime(t, i18n.language, pc.lastUsedAt) : t("computer.never"),
      })}
    </span>
  );
}

/** Ticks once a second while `active` (the elapsed seconds and the steps). */
function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

interface Busy {
  action: ComputerAction;
  since: number;
  fresh: boolean;
}

/**
 * Start / stop / delete with instant feedback: the chip changes at once,
 * `GET …/computer` is polled every 2 s until the server (or the
 * `agent.computer` event) says it's done, then a toast. Errors stay inline
 * with "Tentar de novo".
 */
function useComputerLifecycle(agent: Agent) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const mutation = useComputerAction(org.id);
  const [busy, setBusy] = useState<Busy | null>(null);
  const [error, setError] = useState<{ action: ComputerAction; message: string } | null>(null);
  const [ready, setReady] = useState(false);
  const pc = useComputer(org.id, agent.id, true, busy ? POLL_MS : false);
  const now = useNow(busy !== null);
  const g = agentGrammar(t, agent.name);
  const view = busy ? busyView(busy.action, busy.since, now, busy.fresh) : null;

  const status = pc.data?.status;
  useEffect(() => {
    if (!busy || !reached(busy.action, status)) return;
    setBusy(null);
    toast.show(t(`computer.done.${busy.action}`, g));
    if (busy.action === "start") setReady(true);
  }, [busy, status, toast, t, g]);
  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(() => setReady(false), READY_FLASH_MS);
    return () => clearTimeout(timer);
  }, [ready]);
  useEffect(() => {
    if (busy && view?.tooLong) {
      setError({ action: busy.action, message: t("computer.tooLong") });
      setBusy(null);
    }
  }, [busy, view?.tooLong, t]);

  const run = (action: ComputerAction) => {
    setError(null);
    setReady(false);
    setBusy({ action, since: Date.now(), fresh: pc.data?.status === "none" });
    mutation.mutate(
      { agentId: agent.id, action },
      {
        onError: (e) => {
          setBusy(null);
          setError({ action, message: e instanceof Error && e.message ? errorText(t, e) : t("common.loadFailed") });
        },
      },
    );
  };
  const display: ComputerDisplay | undefined = busy ? busyDisplay[busy.action] : status;
  return { pc, busy, view, ready, error, run, display };
}
type Lifecycle = ReturnType<typeof useComputerLifecycle>;

/** "Criando a máquina · 5 s" while starting; "Pronto" for a moment after. */
function ComputerProgress({ life }: { life: Lifecycle }) {
  const { t } = useTranslation();
  const step = life.ready ? "ready" : life.view?.step;
  if (!step && life.view?.elapsed == null) return null;
  return (
    <span className="computer-progress small muted" role="status">
      {step && <span>{t(`computer.step.${step}`)}</span>}
      {life.view?.elapsed != null && (
        <span className="tabular">{t("computer.elapsed", { seconds: life.view.elapsed })}</span>
      )}
    </span>
  );
}

function ComputerError({ life }: { life: Lifecycle }) {
  const { t } = useTranslation();
  const { error } = life;
  if (!error) return null;
  return (
    <p className="computer-error small" role="alert">
      <Icon name="alert" size={16} />
      <span>{t(`computer.failed.${error.action}`, { reason: error.message })}</span>
      <Button size="sm" variant="ghost" onClick={() => life.run(error.action)}>
        {t("computer.retry")}
      </Button>
    </p>
  );
}

/** "…": Ligar, Desligar, Apagar (asks first: it deletes every file). */
function ComputerMenu({ agent, life }: { agent: Agent; life: Lifecycle }) {
  const { t } = useTranslation();
  const [confirm, setConfirm] = useState(false);
  const g = agentGrammar(t, agent.name);
  const status = life.pc.data?.status;
  if (!status) return null;
  return (
    <>
      <Menu
        align="end"
        label={t("computer.actions", g)}
        trigger={
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            icon="more"
            aria-label={t("computer.actions", g)}
            disabled={life.busy !== null}
          />
        }
      >
        {status !== "running" && (
          <MenuItem icon="check" onSelect={() => life.run("start")}>
            {t("computer.start")}
          </MenuItem>
        )}
        {status === "running" && (
          <MenuItem icon="waiting" onSelect={() => life.run("stop")}>
            {t("computer.stop")}
          </MenuItem>
        )}
        {status !== "none" && (
          <MenuItem icon="block" danger onSelect={() => setConfirm(true)}>
            {t("computer.remove")}
          </MenuItem>
        )}
      </Menu>
      <Dialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t("computer.removeTitle", g)}
        description={t("computer.removeText", g)}
        closeLabel={t("common.close")}
        width={440}
      >
        <DialogFooter>
          <Button onClick={() => setConfirm(false)}>{t("common.cancel")}</Button>
          <Button
            variant="danger"
            onClick={() => {
              setConfirm(false);
              life.run("remove");
            }}
          >
            {t("computer.remove")}
          </Button>
        </DialogFooter>
      </Dialog>
    </>
  );
}

/** The computer an agent uses; older servers don't say: the cloud one. */
export const targetOf = (pc: AgentComputer | undefined): ComputerTarget => pc?.target ?? { kind: "cloud" };

/** "Na máquina Servidor do escritório · Online": a connected computer is turned on by its owner. */
function MachineTargetView({ target }: { target: Extract<ComputerTarget, { kind: "machine" }> }) {
  const { t } = useTranslation();
  return (
    <span className="stack-4" style={{ gap: 4 }}>
      <span className="row" style={{ gap: 8, alignItems: "center" }}>
        <span className="computer-machine__name">{target.name}</span>
        <MachineChip online={target.online} />
      </span>
      <span className="small muted">{target.online ? t("computer.machineHint") : t("computer.machineOffline")}</span>
    </span>
  );
}

export const CLOUD = "cloud";

/**
 * "Computador: Nuvem | <máquina>". Admins pick any machine; the agent's
 * owner, the ones they paired (the server checks again). Offline machines
 * stay selectable, marked. The choice is a draft: the page saves it.
 */
function ComputerTargetSelect({
  target,
  value,
  onChange,
  admin,
}: {
  target: ComputerTarget;
  value: string;
  onChange: (value: string) => void;
  admin: boolean;
}) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const machines = useMachines(org.id);
  const current = target.kind === "machine" ? target.machineId : CLOUD;
  const list = (machines.data ?? []).filter(
    (m) => admin || m.pairedBy?.id === me.user.id || m.id === current || m.id === value,
  );
  if (machines.isLoading) return <LoadingLine width={200} />;
  if (list.length === 0 && target.kind === "cloud" && value === CLOUD) {
    return (
      <Link
        to="/org/$orgId/settings/$section"
        params={{ orgId: org.id, section: "computers" }}
        className="small computer-target__connect"
      >
        {t("computer.target.connectHint")}
      </Link>
    );
  }
  const options: SelectOption[] = [
    { value: CLOUD, label: t("computer.target.cloud"), description: t("computer.target.cloudText") },
    ...list.map((m) => ({
      value: m.id,
      label: m.online ? m.name : t("computer.target.offlineName", { name: m.name }),
      description: m.online ? t("machines.online") : t("computer.target.offlineText"),
    })),
  ];
  // The current machine may not be in the list yet (just paired, list loading).
  if (target.kind === "machine" && !options.some((o) => o.value === target.machineId)) {
    options.push({ value: target.machineId, label: target.name });
  }
  return (
    <Select
      className="newag__sel"
      aria-label={t("computer.target.label")}
      value={value}
      options={options.map((o) => ({
        ...o,
        leading: (
          <span className="newag__ib">
            <ComputerIcon
              kind={o.value === CLOUD ? "cloud" : computerKind(list.find((m) => m.id === o.value)?.os)}
              size={16}
            />
          </span>
        ),
      }))}
      onValueChange={onChange}
      renderValue={(o) => (
        <span className="newag__sel-value">
          {o.leading}
          <span className="newag__sel-text">
            <b>{o.label}</b>
            {o.description && <span>{o.description}</span>}
          </span>
        </span>
      )}
    />
  );
}

/**
 * The computer the agent uses, as its portrait: the
 * cloud computer (lit while running or starting) or the connected machine,
 * its kind and pause from the computers list.
 */
function TargetPortrait({ target, display }: { target: ComputerTarget; display: ComputerDisplay | null | undefined }) {
  const { org } = useOrg();
  const machines = useMachines(org.id);
  if (target.kind === "cloud") {
    const on = display === "running" || display === "starting" || display === "stopping";
    return <ComputerPortrait className="agp-pc__logo" kind="cloud" state={on ? "online" : "offline"} />;
  }
  const m = machines.data?.find((x) => x.id === target.machineId);
  return (
    <ComputerPortrait
      className="agp-pc__logo"
      kind={computerKind(m?.os)}
      state={m ? computerState(m) : target.online ? "online" : "offline"}
    />
  );
}

/**
 * Configurações › Computador: the agent's PC (status, disk, last use; start,
 * stop and delete for admins) and where it runs. `onMachine` = can choose.
 */
export function AgentComputerPanel({
  agent,
  admin,
  machine,
  onMachine,
  machineNote,
}: {
  agent: Agent;
  admin: boolean;
  /** The chosen computer (a draft): `"cloud"` or a machine id. */
  machine: string;
  onMachine?: (value: string) => void;
  /** Under the picker ("Antes: …"). */
  machineNote?: ReactNode;
}) {
  const { t } = useTranslation();
  const life = useComputerLifecycle(agent);
  const { pc } = life;
  const g = agentGrammar(t, agent.name);
  if (pc.isLoading) return <LoadingLine width={240} />;
  if (pc.isError || !pc.data) return <p className="small muted">{t("agentPage.computer.unavailable")}</p>;
  const target = targetOf(pc.data);
  const empty = pc.data.status === "none" && !life.busy;
  return (
    <div className="agp-pc">
      <div className="agp-pc__now">
        <TargetPortrait target={target} display={life.display} />
        <span className="agp-pc__text">
          {target.kind === "machine" ? (
            <MachineTargetView target={target} />
          ) : empty ? (
            <span className="muted">{t("computer.emptyText", g)}</span>
          ) : (
            life.display && (
              <span className="row" style={{ gap: 8, alignItems: "center" }}>
                <ComputerChip status={life.display} />
                {life.busy ? <ComputerProgress life={life} /> : <ComputerFacts pc={pc.data} />}
                {!life.busy && life.ready && <ComputerProgress life={life} />}
              </span>
            )
          )}
          {target.kind === "cloud" && pc.data.network === "provider-default" && (
            <span className="small muted">{t("sandbox.providerDefault")}</span>
          )}
        </span>
        {admin && target.kind === "cloud" && (
          <span className="agp-pc__act">
            {empty ? (
              <Button size="sm" variant="primary" onClick={() => life.run("start")}>
                {t("computer.create", g)}
              </Button>
            ) : (
              <ComputerMenu agent={agent} life={life} />
            )}
          </span>
        )}
      </div>
      <ComputerError life={life} />
      <div className="stack-4" style={{ gap: 6 }}>
        <span className="newag__label">{t("computer.target.label")}</span>
        {onMachine ? (
          <ComputerTargetSelect target={target} value={machine} onChange={onMachine} admin={admin} />
        ) : (
          <span className="agp-ro">{target.kind === "machine" ? target.name : t("computer.target.cloud")}</span>
        )}
        {machineNote}
        {onMachine && (
          <span className="small muted">
            {admin ? t("agentPage.computer.adminsPick") : t("agentPage.computer.ownerPicks")}
          </span>
        )}
      </div>
      {target.kind === "machine" && <AgentMachineFolders agentId={agent.id} machineId={target.machineId} />}
    </div>
  );
}

/**
 * "Pastas no computador": the folders of
 * its computer this agent may use beyond its own, as the machine reported them.
 * Read-only here: granting happens on the computer.
 */
function AgentMachineFolders({ agentId, machineId }: { agentId: string; machineId: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const machines = useMachines(org.id);
  const m = machines.data?.find((x) => x.id === machineId);
  if (!m) return null;
  const folders = foldersOfAgent(m.access, agentId);
  return (
    <div className="stack-4" style={{ gap: 6 }} data-agent-folders>
      <span className="newag__label">{t("agentPage.computer.folders")}</span>
      {!m.access ? (
        <span className="small muted">
          {m.canManage
            ? t("agentPage.computer.foldersUnknown", { machine: m.name })
            : t("agentPage.computer.foldersHidden", { machine: m.name })}
        </span>
      ) : folders.length === 0 ? (
        <span className="small muted">{t("agentPage.computer.foldersOwn", { machine: m.name })}</span>
      ) : (
        <>
          <span className="small muted">{t("agentPage.computer.foldersMore", { machine: m.name })}</span>
          <ul className="agent-folders">
            {folders.map((f) => (
              <li key={f.path}>
                <Icon name="drive" size={14} />
                <span className="machine-folder__name">{folderName(f.path)}</span>
                <code>{f.path}</code>
              </li>
            ))}
          </ul>
        </>
      )}
      <span className="small muted">{t("agentPage.computer.foldersHint")}</span>
    </div>
  );
}

type Draft = Pick<
  SandboxSettings,
  "enabled" | "allowDomains" | "execTimeoutSeconds" | "dailyMinutes" | "requireApproval"
> & { network: SandboxNetwork };
/** The mode, also for older servers that only send the list. */
export const networkOf = (s: Pick<SandboxSettings, "network" | "allowDomains">): SandboxNetwork =>
  s.network ?? (s.allowDomains.length > 0 ? "allowlist" : "blocked");
const NETWORKS: SandboxNetwork[] = ["blocked", "allowlist", "open"];
const draftOf = (s: SandboxSettings): Draft => ({
  enabled: s.enabled,
  allowDomains: s.allowDomains,
  network: networkOf(s),
  execTimeoutSeconds: s.execTimeoutSeconds,
  dailyMinutes: s.dailyMinutes,
  requireApproval: s.requireApproval,
});

/**
 * Configurações → Computadores, "Computador na nuvem" (admins):
 * the card holds the on/off switch (saved at once) and a one-line summary;
 * internet, limits and approval are set in a dialog ("Ajustar"). They apply only
 * to the cloud computer; the person's own computers follow what is allowed on them.
 */
export function CloudComputerCard() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const admin = can(org.role, "configure");
  const settings = useSandboxSettings(org.id, admin);
  const save = useSaveSandboxSettings(org.id);
  const [editing, setEditing] = useState(false);
  if (!admin) return null;
  const s = settings.data;
  const head = (actions?: ReactNode, summary?: ReactNode) => (
    <div className="computers-card__head">
      <ComputerPortrait kind="cloud" state={s && !s.enabled ? "offline" : "online"} />
      <span className="computers-card__title">
        <h2 id="sec-cloud" className="ac-card__title">
          {t("computers.cloud.cardTitle")}
        </h2>
        <span className="small muted">{summary ?? t("computers.cloud.cardText")}</span>
      </span>
      {actions}
    </div>
  );
  if (settings.isError) {
    return (
      <Card aria-labelledby="sec-cloud" id="nuvem">
        {head()}
        <p className="small muted">{t("sandbox.unavailable")}</p>
      </Card>
    );
  }
  if (!s) {
    return settings.isLoading ? (
      <Card aria-labelledby="sec-cloud" id="nuvem">
        {head()}
        <LoadingCards count={1} />
      </Card>
    ) : null;
  }
  const summary = !s.enabled
    ? t("sandbox.enabledHelp")
    : [
        t("computers.cloud.summary", { network: t(`sandbox.network.${networkOf(s)}`), minutes: s.dailyMinutes }),
        ...(s.requireApproval ? [t("computers.cloud.summaryApproval")] : []),
      ].join(" · ");
  const actions = (
    <span className="row" style={{ gap: 10, alignItems: "center" }}>
      <Button size="sm" icon="settings" disabled={!s.available} onClick={() => setEditing(true)}>
        {t("computers.cloud.adjust")}
      </Button>
      <Switch
        checked={s.enabled}
        disabled={!s.available || save.isPending}
        aria-label={t("sandbox.enabled")}
        onCheckedChange={(on) =>
          save.mutate({ ...draftOf(s), enabled: on }, { onSuccess: () => toast.show(t("sandbox.saved")) })
        }
      />
    </span>
  );
  return (
    <Card aria-labelledby="sec-cloud" id="nuvem">
      {head(actions, summary)}
      {!s.available && <p className="small muted">{t("sandbox.notConfigured")}</p>}
      <CloudComputerDialog open={editing} settings={s} onClose={() => setEditing(false)} />
    </Card>
  );
}

/** "Ajustar": internet, usage time and approval of the cloud computer. */
function CloudComputerDialog({
  open,
  settings: s,
  onClose,
}: {
  open: boolean;
  settings: SandboxSettings;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const save = useSaveSandboxSettings(org.id);
  const [draft, setDraft] = useState<Draft>(() => draftOf(s));
  const [domain, setDomain] = useState("");
  const [domainError, setDomainError] = useState<string | null>(null);
  // Every opening starts from what is saved.
  useEffect(() => {
    if (!open) return;
    setDraft(draftOf(s));
    setDomain("");
    setDomainError(null);
  }, [open, s]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(s));
  const timeoutOk = draft.execTimeoutSeconds >= 5 && draft.execTimeoutSeconds <= s.maxTimeoutSeconds;
  const minutesOk = draft.dailyMinutes >= 0 && draft.dailyMinutes <= 1440;
  const networkOk = draft.network !== "allowlist" || draft.allowDomains.length > 0;
  const add = (list: string[]) => {
    const next = [...new Set([...draft.allowDomains, ...list.map((d) => d.trim().toLowerCase())])];
    if (next.length > MAX_DOMAINS) {
      setDomainError(t("sandbox.tooMany", { max: MAX_DOMAINS }));
      return false;
    }
    setDraft({ ...draft, allowDomains: next });
    return true;
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t("computers.cloud.cardTitle")}
      description={t("computers.cloud.cardText")}
      closeLabel={t("common.close")}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!dirty) return onClose();
          if (!timeoutOk || !minutesOk || !networkOk) return;
          const networkChanged = draft.network !== networkOf(s) || draft.allowDomains.join() !== s.allowDomains.join();
          save.mutate(draft, {
            onSuccess: (saved) => {
              toast.show(
                networkChanged
                  ? t(saved.networkApply === "live" ? "sandbox.appliedNow" : "sandbox.appliedNext")
                  : t("sandbox.saved"),
              );
              onClose();
            },
          });
        }}
      >
        <DialogBody className="stack-4" style={{ gap: 16 }}>
          <div className="stack-4" style={{ gap: 8 }}>
            <span className="ac-field__label">{t("sandbox.internet")}</span>
            <span className="small muted">{t("sandbox.internetHelp")}</span>
            <RadioGroup
              value={draft.network}
              onValueChange={(v) => setDraft({ ...draft, network: v as SandboxNetwork })}
              aria-label={t("sandbox.internet")}
              className="stack-4"
              style={{ gap: 8 }}
            >
              {NETWORKS.map((n) => (
                <RadioCard
                  key={n}
                  value={n}
                  id={`sb-net-${n}`}
                  checked={draft.network === n}
                  title={t(`sandbox.network.${n}`)}
                  description={t(`sandbox.networkText.${n}`)}
                />
              ))}
            </RadioGroup>
            {draft.network === "open" && (
              <p className="sandbox-warning small" role="note">
                <Icon name="alert" size={16} />
                {t("sandbox.openWarning")}
              </p>
            )}
          </div>
          {draft.network === "allowlist" && (
            <div className="stack-4" style={{ gap: 8 }}>
              {!networkOk && (
                <span className="small" style={{ color: "var(--danger)" }}>
                  {t("sandbox.needDomain")}
                </span>
              )}
              {draft.allowDomains.length > 0 ? (
                <TokenList label={t("sandbox.internet")}>
                  {draft.allowDomains.map((d) => (
                    <li key={d}>
                      <Token
                        removeLabel={t("common.removeName", { name: d })}
                        onRemove={() => setDraft({ ...draft, allowDomains: draft.allowDomains.filter((x) => x !== d) })}
                      >
                        <code>{d}</code>
                      </Token>
                    </li>
                  ))}
                </TokenList>
              ) : null}
              <div className="row" style={{ gap: 8, alignItems: "flex-start" }}>
                <Field
                  label={t("sandbox.addDomain")}
                  id="sb-domain"
                  error={domainError ?? undefined}
                  style={{ flex: "1 1 240px" }}
                >
                  <Input
                    value={domain}
                    placeholder={t("sandbox.domainPlaceholder")}
                    onChange={(e) => {
                      setDomain(e.target.value);
                      setDomainError(null);
                    }}
                  />
                </Field>
                <Button
                  type="button"
                  style={{ marginTop: 24 }}
                  onClick={() => {
                    if (!isDomain(domain)) {
                      setDomainError(t("sandbox.domainInvalid"));
                      return;
                    }
                    if (add([domain])) setDomain("");
                  }}
                >
                  {t("sandbox.add")}
                </Button>
              </div>
              <div className="row" style={{ gap: 8 }}>
                {DOMAIN_PRESETS.map((p) => (
                  <Button key={p.id} type="button" size="sm" icon="plus" onClick={() => add(p.domains)}>
                    {t(`sandbox.preset.${p.id}`)}
                  </Button>
                ))}
              </div>
            </div>
          )}
          <div className="grid-fields">
            <Field
              label={t("sandbox.dailyMinutes")}
              id="sb-minutes"
              help={t("sandbox.dailyMinutesHelp")}
              error={minutesOk ? undefined : t("sandbox.minutesInvalid")}
            >
              <Input
                inputMode="numeric"
                value={String(draft.dailyMinutes)}
                onChange={(e) => setDraft({ ...draft, dailyMinutes: Number(e.target.value.replace(/\D/g, "") || 0) })}
              />
            </Field>
            <Field
              label={t("sandbox.timeout")}
              id="sb-timeout"
              help={t("sandbox.timeoutHelp", { max: s.maxTimeoutSeconds })}
              error={timeoutOk ? undefined : t("sandbox.timeoutInvalid", { max: s.maxTimeoutSeconds })}
            >
              <Input
                inputMode="numeric"
                value={String(draft.execTimeoutSeconds)}
                onChange={(e) =>
                  setDraft({ ...draft, execTimeoutSeconds: Number(e.target.value.replace(/\D/g, "") || 0) })
                }
              />
            </Field>
          </div>
          <span className="row" style={{ gap: 8, alignItems: "center" }}>
            <Checkbox
              id="sb-approval"
              checked={draft.requireApproval}
              onCheckedChange={(on) => setDraft({ ...draft, requireApproval: on })}
            />
            <label htmlFor="sb-approval">{t("sandbox.requireApproval")}</label>
          </span>
          <p className="computers-note small" role="note">
            <Icon name="info" size={16} />
            <span>{t("computers.cloud.note")}</span>
          </p>
        </DialogBody>
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={!timeoutOk || !minutesOk || !networkOk || save.isPending}
            loading={save.isPending}
          >
            {t("common.save")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/**
 * "Qual computador cada agente usa": every agent and
 * its computer, changed here at once. The current one comes from the computers
 * list (each says which agents use it); no computer there means the cloud.
 * Admins pick any computer; an agent's owner, the ones they connected (the
 * server checks again). Admins also start, stop and delete a cloud computer.
 */
export function AgentComputersCard() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const admin = can(org.role, "configure");
  const agents = useAgents(org.id);
  const machines = useMachines(org.id);
  const list = agents.data ?? [];
  return (
    <Card aria-labelledby="sec-agent-computers">
      <div className="stack-4" style={{ gap: 2 }}>
        <h2 id="sec-agent-computers" className="ac-card__title">
          {t("computers.agents.title")}
        </h2>
        <span className="small muted">{t("computers.agents.text")}</span>
      </div>
      {agents.isLoading || machines.isLoading ? (
        <LoadingLine width={240} />
      ) : list.length === 0 ? (
        <p className="small muted">{t("computers.agents.empty")}</p>
      ) : (
        <List aria-label={t("computers.agents.title")}>
          {list.map((a) => (
            <AgentComputerRow key={a.id} agent={a} admin={admin} machines={machines.data ?? []} />
          ))}
        </List>
      )}
    </Card>
  );
}

function AgentComputerRow({ agent, admin, machines }: { agent: Agent; admin: boolean; machines: Machine[] }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const toast = useToast();
  const setTarget = useSetComputerTarget(org.id);
  const current = machines.find((m) => m.agents.some((a) => a.id === agent.id));
  const value = current?.id ?? CLOUD;
  const choices = machines.filter((m) => admin || m.pairedBy?.id === me.user.id || m.id === value);
  const canPick = (admin || agent.ownerUserId === me.user.id) && choices.length > 0;
  const kindOf = (id: string) => (id === CLOUD ? "cloud" : computerKind(machines.find((m) => m.id === id)?.os));
  const nameOf = (id: string) =>
    id === CLOUD ? t("computer.target.cloud") : (machines.find((m) => m.id === id)?.name ?? id);
  const options: SelectOption[] = [
    { value: CLOUD, label: t("computer.target.cloud"), description: t("computers.agents.ready") },
    ...choices.map((m) => ({
      value: m.id,
      label: m.name,
      description: t(`computers.agents.state.${computerState(m)}`),
    })),
  ].map((o) => ({ ...o, leading: <ComputerIcon kind={kindOf(o.value)} size={16} /> }));
  return (
    <div className="ac-list__row computers-agent">
      <AgentAvatar agentId={agent.id} size="sm" name={agent.name} />
      <span className="list-col computers-agent__main">
        <span style={{ fontWeight: 600 }}>{agent.name}</span>
        {admin && value === CLOUD && <CloudStatus agent={agent} />}
      </span>
      {canPick ? (
        <Select
          size="sm"
          className="computers-agent__pick"
          aria-label={t("computers.agents.pick", { name: agent.name })}
          value={value}
          options={options}
          disabled={setTarget.isPending}
          onValueChange={(v) => {
            if (v === value) return;
            setTarget.mutate(
              { agentId: agent.id, machineId: v === CLOUD ? null : v },
              {
                onSuccess: () => toast.show(t("computers.agents.saved", { name: agent.name, computer: nameOf(v) })),
                onError: (e) => toast.show(errorText(t, e), "error"),
              },
            );
          }}
          renderValue={(o) => (
            <span className="computers-agent__value">
              {o.leading}
              {o.label}
            </span>
          )}
        />
      ) : (
        <span className="computers-agent__value computers-agent__value--ro">
          <ComputerIcon kind={kindOf(value)} size={16} />
          {nameOf(value)}
        </span>
      )}
    </div>
  );
}

/** An agent's cloud computer for admins: its state and Ligar / Desligar / Apagar in "…". */
function CloudStatus({ agent }: { agent: Agent }) {
  const life = useComputerLifecycle(agent);
  return (
    <span className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      {life.display && <ComputerChip status={life.display} />}
      {(life.busy || life.ready) && <ComputerProgress life={life} />}
      <ComputerError life={life} />
      <ComputerMenu agent={agent} life={life} />
    </span>
  );
}
