import {
  Avatar,
  Button,
  Card,
  Checkbox,
  Chip,
  Dialog,
  DialogFooter,
  Field,
  type IconName,
  Input,
  List,
  Menu,
  MenuItem,
  Switch,
  Token,
  TokenList,
} from "@agenteschat/ui";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAgents, useComputer, useComputerAction, useSandboxSettings, useSaveSandboxSettings } from "@/api/queries";
import type { Agent, AgentComputer, SandboxSettings } from "@/api/types";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { formatUsd, relativeTime } from "@/lib/format";
import { agentGrammar } from "@/lib/grammar";
import { can } from "@/lib/permissions";
import { useToast } from "@/lib/toast";

const STATUS_ICON: Record<AgentComputer["status"], IconName> = {
  running: "check",
  stopped: "waiting",
  archived: "drive",
  none: "dash",
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

export function ComputerChip({ status }: { status: AgentComputer["status"] }) {
  const { t } = useTranslation();
  return <Chip icon={STATUS_ICON[status]}>{t(`computer.status.${status}`)}</Chip>;
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

/** "…": Ligar, Desligar, Apagar (asks first: it deletes every file). */
function ComputerMenu({ agent, pc }: { agent: Agent; pc: AgentComputer }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const action = useComputerAction(org.id);
  const [confirm, setConfirm] = useState(false);
  const g = agentGrammar(t, agent.name);
  return (
    <>
      <Menu
        align="end"
        label={t("computer.actions", g)}
        trigger={<Button size="sm" variant="ghost" iconOnly icon="more" aria-label={t("computer.actions", g)} />}
      >
        {pc.status !== "running" && (
          <MenuItem icon="check" onSelect={() => action.mutate({ agentId: agent.id, action: "start" })}>
            {t("computer.start")}
          </MenuItem>
        )}
        {pc.status === "running" && (
          <MenuItem icon="waiting" onSelect={() => action.mutate({ agentId: agent.id, action: "stop" })}>
            {t("computer.stop")}
          </MenuItem>
        )}
        {pc.status !== "none" && (
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
            disabled={action.isPending}
            onClick={() =>
              action.mutate(
                { agentId: agent.id, action: "remove" },
                {
                  onSuccess: () => {
                    setConfirm(false);
                    toast.show(t("computer.removed", g));
                  },
                },
              )
            }
          >
            {t("computer.remove")}
          </Button>
        </DialogFooter>
      </Dialog>
    </>
  );
}

/** Agent profile: "PC do Theo" with status, disk, cost and last use. Hidden when the server has no sandbox. */
export function AgentComputerRow({ agent, editable }: { agent: Agent; editable: boolean }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const pc = useComputer(org.id, agent.id);
  const g = agentGrammar(t, agent.name);
  if (pc.isError || !pc.data) return null;
  return (
    <section aria-labelledby="sec-pc" className="summary-row">
      <div className="summary-row__text">
        <h2 id="sec-pc" className="summary-row__title">
          {t("computer.title", g)}
        </h2>
        <div className="summary-row__body">
          <span className="row" style={{ gap: 8, alignItems: "center" }}>
            <ComputerChip status={pc.data.status} />
            <ComputerFacts pc={pc.data} />
          </span>
          {pc.data.network === "provider-default" && (
            <span className="small muted">{t("sandbox.providerDefault")}</span>
          )}
        </div>
      </div>
      {editable && (
        <div className="summary-row__action">
          <ComputerMenu agent={agent} pc={pc.data} />
        </div>
      )}
    </section>
  );
}

function ComputerListRow({ agent }: { agent: Agent }) {
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const pc = useComputer(org.id, agent.id);
  return (
    <div className="ac-list__row computer-row">
      <Avatar kind="agent" size="sm" name={agent.name} initials={dir.agentInitials(agent.id)} />
      <span className="list-col" style={{ flex: "1 1 220px" }}>
        <span style={{ fontWeight: 600 }}>{agent.name}</span>
        {pc.data && <ComputerFacts pc={pc.data} />}
      </span>
      {pc.data && <ComputerChip status={pc.data.status} />}
      {pc.data && <ComputerMenu agent={agent} pc={pc.data} />}
    </div>
  );
}

type Draft = Pick<
  SandboxSettings,
  "enabled" | "allowDomains" | "execTimeoutSeconds" | "dailyMinutes" | "requireApproval"
>;
const draftOf = (s: SandboxSettings): Draft => ({
  enabled: s.enabled,
  allowDomains: s.allowDomains,
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
  if (!s || !draft) return null;
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(s));
  const timeoutOk = draft.execTimeoutSeconds >= 5 && draft.execTimeoutSeconds <= s.maxTimeoutSeconds;
  const minutesOk = draft.dailyMinutes >= 0 && draft.dailyMinutes <= 1440;
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
            if (!dirty || !timeoutOk || !minutesOk) return;
            save.mutate(draft, { onSuccess: () => toast.show(t("sandbox.saved")) });
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
            ) : (
              <span className="small">{t("sandbox.noInternet")}</span>
            )}
            <div className="row" style={{ gap: 8, alignItems: "flex-start" }}>
              <Field
                label={t("sandbox.addDomain")}
                id="sb-domain"
                error={domainError ?? undefined}
                style={{ flex: "1 1 240px" }}
              >
                <Input
                  value={domain}
                  placeholder="api.exemplo.com ou *.exemplo.com"
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
            <Button type="submit" variant="primary" disabled={!dirty || !timeoutOk || !minutesOk || save.isPending}>
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
