import {
  Button,
  Card,
  Checkbox,
  Chip,
  Dialog,
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
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useAgents,
  useComputer,
  useComputerAction,
  useMachines,
  useSandboxSettings,
  useSaveSandboxSettings,
  useSetComputerTarget,
} from "@/api/queries";
import type { Agent, AgentComputer, ComputerTarget, SandboxNetwork, SandboxSettings } from "@/api/types";
import { AgentAvatar } from "@/components/AgentAvatar";
import { LoadingCards, LoadingLine } from "@/components/Loading";
import { MachineChip } from "@/components/Machines";
import { useOrg } from "@/components/org-context";
import {
  busyDisplay,
  busyView,
  type ComputerAction,
  type ComputerDisplay,
  POLL_MS,
  READY_FLASH_MS,
  reached,
} from "@/lib/computer";
import { errorText } from "@/lib/errors";
import { formatUsd, relativeTime } from "@/lib/format";
import { agentGrammar } from "@/lib/grammar";
import { can } from "@/lib/permissions";
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

/** "1,2 GB · US$ 0,84 este mês · usado há 2 h". */
function ComputerFacts({ pc }: { pc: AgentComputer }) {
  const { t, i18n } = useTranslation();
  if (pc.status === "none") return <span className="muted">{t("computer.none")}</span>;
  return (
    <span className="small muted tabular">
      {t("computer.facts", {
        disk: new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 }).format(pc.diskUsedGib),
        cost: formatUsd(t, i18n.language, pc.costMonthUsd),
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
        <Icon name="computer" size={16} />
        <span className="computer-machine__name">{target.name}</span>
        <MachineChip online={target.online} />
      </span>
      <span className="small muted">{target.online ? t("computer.machineHint") : t("computer.machineOffline")}</span>
    </span>
  );
}

const CLOUD = "cloud";

/**
 * "Computador: Nuvem | <máquina>". Admins pick any machine; the agent's
 * owner, the ones they paired (the server checks again). Offline machines
 * stay selectable, marked.
 */
function ComputerTargetSelect({ agent, target, admin }: { agent: Agent; target: ComputerTarget; admin: boolean }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const toast = useToast();
  const machines = useMachines(org.id);
  const set = useSetComputerTarget(org.id);
  const [error, setError] = useState<string | null>(null);
  const current = target.kind === "machine" ? target.machineId : CLOUD;
  const list = (machines.data ?? []).filter((m) => admin || m.pairedBy?.id === me.user.id || m.id === current);
  if (machines.isLoading) return <LoadingLine width={200} />;
  if (list.length === 0 && target.kind === "cloud") {
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
    <span className="stack-4" style={{ gap: 4 }}>
      <span className="row computer-target" style={{ gap: 8, alignItems: "center" }}>
        <span className="small muted">{t("computer.target.label")}</span>
        <Select
          size="sm"
          aria-label={t("computer.target.label")}
          value={current}
          options={options}
          disabled={set.isPending}
          onValueChange={(value) => {
            if (value === current) return;
            setError(null);
            const machine = list.find((m) => m.id === value);
            set.mutate(
              { agentId: agent.id, machineId: value === CLOUD ? null : value },
              {
                onSuccess: () =>
                  toast.show(
                    machine
                      ? t("computer.target.switchedMachine", { name: agent.name, machine: machine.name })
                      : t("computer.target.switchedCloud", { name: agent.name }),
                  ),
                onError: (e) => setError(errorText(t, e)),
              },
            );
          }}
        />
      </span>
      {error && (
        <p className="computer-error small" role="alert">
          <Icon name="alert" size={16} />
          <span>{error}</span>
        </p>
      )}
    </span>
  );
}

/** Agent profile: "PC do Theo" with status, disk, cost and last use. Hidden when the server has no sandbox. */
export function AgentComputerRow({ agent, editable }: { agent: Agent; editable: boolean }) {
  const { t } = useTranslation();
  const { me } = useOrg();
  const life = useComputerLifecycle(agent);
  const { pc } = life;
  const g = agentGrammar(t, agent.name);
  // Choosing the computer: admins, or the agent's owner (with machines they paired).
  const canTarget = editable || (agent.ownerUserId != null && agent.ownerUserId === me.user.id);
  if (pc.isLoading) {
    return (
      <section aria-labelledby="sec-pc" className="summary-row">
        <div className="summary-row__text">
          <h2 id="sec-pc" className="summary-row__title">
            {t("computer.title", g)}
          </h2>
          <div className="summary-row__body">
            <LoadingLine width={240} />
          </div>
        </div>
      </section>
    );
  }
  if (pc.isError || !pc.data) return null;
  const target = targetOf(pc.data);
  const selector = canTarget ? <ComputerTargetSelect agent={agent} target={target} admin={editable} /> : null;
  // A connected machine: no start/stop/delete, network or cost; its owner turns it on.
  if (target.kind === "machine") {
    return (
      <section aria-labelledby="sec-pc" className="summary-row">
        <div className="summary-row__text">
          <h2 id="sec-pc" className="summary-row__title">
            {t("computer.title", g)}
          </h2>
          <div className="summary-row__body stack-4" style={{ gap: 8 }}>
            <MachineTargetView target={target} />
            <ComputerError life={life} />
            {selector}
          </div>
        </div>
      </section>
    );
  }
  if (!life.display) return null;
  // No PC yet (and nothing running): explain it and offer to create it.
  const empty = pc.data.status === "none" && !life.busy;
  return (
    <section aria-labelledby="sec-pc" className="summary-row">
      <div className="summary-row__text">
        <h2 id="sec-pc" className="summary-row__title">
          {t("computer.title", g)}
        </h2>
        <div className="summary-row__body">
          {empty ? (
            <span className="muted">{t("computer.emptyText", g)}</span>
          ) : (
            <span className="row" style={{ gap: 8, alignItems: "center" }}>
              <ComputerChip status={life.display} />
              {life.busy ? <ComputerProgress life={life} /> : <ComputerFacts pc={pc.data} />}
              {!life.busy && life.ready && <ComputerProgress life={life} />}
            </span>
          )}
          <ComputerError life={life} />
          {pc.data.network === "provider-default" && (
            <span className="small muted">{t("sandbox.providerDefault")}</span>
          )}
          {selector}
        </div>
      </div>
      {editable && (
        <div className="summary-row__action">
          {empty ? (
            <Button size="sm" variant="primary" onClick={() => life.run("start")}>
              {t("computer.create", g)}
            </Button>
          ) : (
            <ComputerMenu agent={agent} life={life} />
          )}
        </div>
      )}
    </section>
  );
}

function ComputerListRow({ agent }: { agent: Agent }) {
  const { t } = useTranslation();
  const life = useComputerLifecycle(agent);
  const { pc } = life;
  const target = targetOf(pc.data);
  if (target.kind === "machine") {
    return (
      <div className="ac-list__row computer-row">
        <AgentAvatar agentId={agent.id} size="sm" name={agent.name} />
        <span className="list-col" style={{ flex: "1 1 220px" }}>
          <span style={{ fontWeight: 600 }}>{agent.name}</span>
          <span className="small muted">{t("computer.onMachine", { machine: target.name })}</span>
        </span>
        <MachineChip online={target.online} />
      </div>
    );
  }
  return (
    <div className="ac-list__row computer-row">
      <AgentAvatar agentId={agent.id} size="sm" name={agent.name} />
      <span className="list-col" style={{ flex: "1 1 220px" }}>
        <span style={{ fontWeight: 600 }}>{agent.name}</span>
        {pc.isLoading && <LoadingLine width={200} />}
        {pc.data && (life.busy || life.ready ? <ComputerProgress life={life} /> : <ComputerFacts pc={pc.data} />)}
        {pc.isError && <span className="small muted">{t("common.loadFailed")}</span>}
        <ComputerError life={life} />
      </span>
      {life.display && <ComputerChip status={life.display} />}
      {pc.data && <ComputerMenu agent={agent} life={life} />}
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

/** Configurações → Sandbox (admins): on/off, the internet allowlist, limits, approval; and every agent's PC. */
export function SandboxSection() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const admin = can(org.role, "configure");
  const settings = useSandboxSettings(org.id, admin);
  const save = useSaveSandboxSettings(org.id);
  const agents = useAgents(org.id);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [domain, setDomain] = useState("");
  const [domainError, setDomainError] = useState<string | null>(null);
  useEffect(() => {
    if (settings.data) setDraft(draftOf(settings.data));
  }, [settings.data]);
  if (!admin) return null;
  if (settings.isError) {
    return (
      <Card aria-labelledby="sec-sandbox">
        <h2 id="sec-sandbox" className="ac-card__title">
          {t("sandbox.title")}
        </h2>
        <p className="small muted">{t("sandbox.unavailable")}</p>
      </Card>
    );
  }
  const s = settings.data;
  if (!s || !draft) {
    return settings.isLoading ? (
      <Card aria-labelledby="sec-sandbox">
        <h2 id="sec-sandbox" className="ac-card__title">
          {t("sandbox.title")}
        </h2>
        <LoadingCards count={3} />
      </Card>
    ) : null;
  }
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
    <>
      <Card aria-labelledby="sec-sandbox">
        <div className="stack-4" style={{ gap: 2 }}>
          <h2 id="sec-sandbox" className="ac-card__title">
            {t("sandbox.title")}
          </h2>
          <span className="small muted">{t("sandbox.subtitle")}</span>
        </div>
        {!s.available && <p className="small muted">{t("sandbox.notConfigured")}</p>}
        <form
          className="stack-4"
          style={{ gap: 16 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (!dirty || !timeoutOk || !minutesOk || !networkOk) return;
            const networkChanged =
              draft.network !== networkOf(s) || draft.allowDomains.join() !== s.allowDomains.join();
            save.mutate(draft, {
              onSuccess: (saved) => {
                toast.show(
                  networkChanged
                    ? t(saved.networkApply === "live" ? "sandbox.appliedNow" : "sandbox.appliedNext")
                    : t("sandbox.saved"),
                );
              },
            });
          }}
        >
          <span className="row" style={{ gap: 10, alignItems: "center" }}>
            <Switch
              id="sb-enabled"
              checked={draft.enabled}
              disabled={!s.available}
              onCheckedChange={(on) => setDraft({ ...draft, enabled: on })}
            />
            <label htmlFor="sb-enabled" style={{ fontWeight: 600 }}>
              {t("sandbox.enabled")}
            </label>
          </span>
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
          <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
            {dirty && <span className="small muted">{t("edit.unsaved")}</span>}
            <Button type="button" disabled={!dirty} onClick={() => setDraft(draftOf(s))}>
              {t("edit.discard")}
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={!dirty || !timeoutOk || !minutesOk || !networkOk || save.isPending}
              loading={save.isPending}
            >
              {t("common.save")}
            </Button>
          </div>
        </form>
      </Card>
      <Card aria-labelledby="sec-pcs">
        <h2 id="sec-pcs" className="ac-card__title">
          {t("computer.listTitle")}
        </h2>
        {(agents.data ?? []).length === 0 ? (
          <p className="small muted">{t("computer.listEmpty")}</p>
        ) : (
          <List aria-label={t("computer.listTitle")}>
            {(agents.data ?? []).map((a) => (
              <ComputerListRow key={a.id} agent={a} />
            ))}
          </List>
        )}
      </Card>
    </>
  );
}
