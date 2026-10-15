import {
  AttentionNote,
  Avatar,
  Button,
  Card,
  Checkbox,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogSearchList,
  EmptyState,
  Field,
  Icon,
  Input,
  Meter,
  Select,
  Textarea,
} from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { useEffect, useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import {
  useAgentAccess,
  useAgentDetail,
  useAgentScopes,
  useChannels,
  useCredentials,
  useMemory,
  useModels,
  usePlatformKey,
  useProposals,
  useRuns,
  useSetAgentAccess,
  useSetAgentScopes,
  useSettings,
  useUpdateAgent,
} from "@/api/queries";
import type { Agent, AgentAccess } from "@/api/types";
import { AccessTree } from "@/components/AccessTree";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { useScopeGroups } from "@/hooks/useScopeGroups";
import { type AccessModel, modelFrom, toInput, treeFromAccess } from "@/lib/access";
import { formatInt, formatMonth, formatTokensShort, formatUsd, whenAt } from "@/lib/format";
import { agentGrammar } from "@/lib/grammar";
import { can } from "@/lib/permissions";
import { scopeSummary, searchGroups, toggleGrant } from "@/lib/scopes";
import { parseAmount } from "@/lib/text";
import { useToast } from "@/lib/toast";
import { DEFAULT_KEY, keyOptions, modelOptions, NO_OWNER } from "./NewAgentPage";

/** Validates the budget dialog: a positive number ("40", "40,5"). */
export function budgetError(t: TFunction, value: string) {
  const n = parseAmount(value);
  return n > 0 ? null : t("agent.budgetInvalid");
}

/** telas/Agente.dc.html — instructions, budget, permissions and what the agent knows. */
export function AgentPage({ agentId }: { agentId: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const agent = dir.agentById.get(agentId);
  if (dir.loading) return <div className="page" aria-busy="true" />;
  if (!agent) {
    return (
      <div className="page page--mid">
        <EmptyState icon="agent">{t("agent.notFound")}</EmptyState>
      </div>
    );
  }
  return <AgentProfile key={agent.id} agent={agent} />;
}

function AgentProfile({ agent }: { agent: Agent }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const models = useModels();
  const detail = useAgentDetail(org.id, agent.id);
  const channels = useChannels(org.id);
  const update = useUpdateAgent(org.id, agent.id);
  const editable = can(org.role, "manage_agents");
  const g = agentGrammar(t, agent.name);
  const owner = agent.ownerUserId ? dir.memberById.get(agent.ownerUserId) : undefined;
  const modelLabel = models.data?.models.find((m) => m.id === agent.model)?.label ?? agent.model;
  // "Abrir no #canal": the first of the agent's channels you're in.
  const home = detail.data?.channels
    .map((ac) => channels.data?.find((c) => c.id === ac.id && c.isMember))
    .find((c) => c !== undefined);
  const month = formatMonth(i18n.language, new Date());

  const [instructions, setInstructions] = useState(agent.instructions);
  const [saved, setSaved] = useState(false);
  const [dialog, setDialog] = useState<null | "runs" | "budget" | "perms">(null);
  useEffect(() => setInstructions(agent.instructions), [agent.instructions]);

  const spent = detail.data?.spentThisMonthUsd ?? 0;
  const tokens = detail.data?.tokensThisMonth ?? 0;
  const runs = detail.data?.runsThisMonth ?? 0;
  const key = agent.hasCredential ? t("agent.withOrgKey", { org: org.name }) : t("agent.withPlatformKey");

  return (
    <div className="page page--wide">
      <header className="page__header page__header--row">
        <Avatar kind="agent" size="lg" name={agent.name} initials={dir.agentInitials(agent.id)} />
        <div className="page__header-text">
          <h1 className="page-title">{agent.name}</h1>
          <span className="muted">
            {owner ? (
              <Trans
                i18nKey="agent.subtitle"
                values={{ role: agent.role || `@${agent.handle}`, owner: owner.name, model: modelLabel, key }}
                components={{ b: <b style={{ color: "var(--ink)" }} /> }}
              />
            ) : (
              t("agent.subtitleNoOwner", { role: agent.role || `@${agent.handle}`, model: modelLabel, key })
            )}
          </span>
        </div>
        <div className="row">
          {home && (
            <Button asChild>
              <Link to="/org/$orgId/c/$channelId" params={{ orgId: org.id, channelId: home.id }}>
                {t("agent.openIn", { channel: home.name })}
              </Link>
            </Button>
          )}
          {editable && (
            <Button
              variant="primary"
              disabled={update.isPending || instructions === agent.instructions}
              onClick={() => update.mutate({ instructions }, { onSuccess: () => setSaved(true) })}
            >
              {saved && instructions === agent.instructions ? t("agent.saved") : t("agent.saveChanges")}
            </Button>
          )}
        </div>
      </header>
      {!editable && <p className="page__note">{t("agent.readOnly", g)}</p>}

      <div className="cards-2">
        <Card aria-labelledby="sec-instr">
          <h2 id="sec-instr" className="ac-card__title">
            {t("agent.instructions")}
          </h2>
          <Field label={t("agent.howWorks", g)} id="instr" help={t("agent.instructionsHelp", { org: org.name })}>
            <Textarea
              rows={6}
              value={instructions}
              readOnly={!editable}
              onChange={(e) => {
                setInstructions(e.target.value);
                setSaved(false);
              }}
            />
          </Field>
          <OwnerField agent={agent} editable={editable} />
          <ModelAndKeyFields agent={agent} editable={editable} />
        </Card>

        <Card aria-labelledby="sec-budget">
          <h2 id="sec-budget" className="ac-card__title">
            {t("agent.budgetTitle", { month })}
          </h2>
          {detail.isError ? (
            <span className="small muted">{t("agent.usageHidden")}</span>
          ) : (
            <>
              <div className="budget-figure">
                <span className="budget-figure__value">{formatUsd(t, i18n.language, spent)}</span>
                <span className="muted">
                  {agent.monthlyBudgetUsd === null
                    ? t("agent.noBudget")
                    : t("agent.budgetOf", { amount: formatUsd(t, i18n.language, agent.monthlyBudgetUsd) })}
                </span>
              </div>
              {agent.monthlyBudgetUsd !== null && (
                <Meter value={spent} max={agent.monthlyBudgetUsd} label={t("agent.budgetUsed")} />
              )}
              <span className="small muted">
                {owner
                  ? t("agent.budgetStats", {
                      runs: t("agent.runsCount", { count: runs }),
                      tokens: t("agent.tokensCount", { tokens: formatTokensShort(t, i18n.language, tokens) }),
                      owner: t("agent.toOwner", { owner: owner.name, to: agentGrammar(t, owner.name).to }),
                    })
                  : t("agent.budgetStatsNoOwner", {
                      runs: t("agent.runsCount", { count: runs }),
                      tokens: t("agent.tokensCount", { tokens: formatTokensShort(t, i18n.language, tokens) }),
                    })}
              </span>
            </>
          )}
          <div className="row">
            <Button size="sm" onClick={() => setDialog("runs")}>
              {t("agent.viewRuns")}
            </Button>
            {editable && (
              <Button size="sm" onClick={() => setDialog("budget")}>
                {t("agent.adjustBudget")}
              </Button>
            )}
          </div>
        </Card>
      </div>

      <PermissionsSection agent={agent} editable={editable} onEdit={() => setDialog("perms")} />
      <MemorySection agent={agent} />

      <RunsDialog
        open={dialog === "runs"}
        onOpenChange={(o) => setDialog(o ? "runs" : null)}
        agent={agent}
        totalRuns={runs}
      />
      <BudgetDialog
        open={dialog === "budget"}
        onOpenChange={(o) => setDialog(o ? "budget" : null)}
        agent={agent}
        ownerName={owner?.name}
      />
      <PermissionsDialog open={dialog === "perms"} onOpenChange={(o) => setDialog(o ? "perms" : null)} agent={agent} />
    </div>
  );
}

/** Built-in scopes + the scopes of the organization's connections. */
/** "Responsável" on the profile: a member or "Sem responsável" (admins then get alerts and approve). */
function OwnerField({ agent, editable }: { agent: Agent; editable: boolean }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const update = useUpdateAgent(org.id, agent.id);
  const value = agent.ownerUserId ?? NO_OWNER;
  const options = [
    ...dir.members.map((m) => ({ value: m.userId, label: m.name, description: t(`roles.${m.role}`) })),
    { value: NO_OWNER, label: t("newAgent.noOwnerOption") },
  ];
  return (
    <Field
      label={t("newAgent.owner")}
      id={`owner-${agent.id}`}
      help={value === NO_OWNER ? t("newAgent.noOwnerHelp") : t("newAgent.ownerHelp")}
    >
      <Select
        value={value}
        onValueChange={(v) => update.mutate({ ownerUserId: v === NO_OWNER ? null : v })}
        options={options}
        disabled={!editable || update.isPending}
      />
    </Field>
  );
}

/** Model (grouped by provider; no key = disabled) and key (workspace default or another stored key). */
function ModelAndKeyFields({ agent, editable }: { agent: Agent; editable: boolean }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const update = useUpdateAgent(org.id, agent.id);
  const detail = useAgentDetail(org.id, agent.id);
  const models = useModels();
  const credentials = useCredentials(org.id, can(org.role, "manage_credentials"));
  const settings = useSettings(org.id);
  const platform = usePlatformKey(org.id);
  const credentialId = detail.data?.credentialId ?? null;
  return (
    <div className="grid-fields">
      <Field label={t("newAgent.model")} id={`model-${agent.id}`}>
        <Select
          value={agent.model}
          onValueChange={(model) => update.mutate({ model })}
          options={modelOptions(
            t,
            i18n.language,
            models.data?.models ?? [],
            credentials.data ?? [],
            platform.data ?? false,
          )}
          disabled={!editable || update.isPending}
        />
      </Field>
      <Field label={t("newAgent.key")} id={`key-${agent.id}`}>
        <Select
          value={credentialId && credentialId !== settings.data?.defaultCredentialId ? credentialId : DEFAULT_KEY}
          onValueChange={(v) => update.mutate({ credentialId: v === DEFAULT_KEY ? null : v })}
          options={keyOptions(t, credentials.data ?? [], settings.data?.defaultCredentialId ?? null)}
          disabled={!editable || update.isPending}
        />
      </Field>
    </div>
  );
}

function PermissionsSection({ agent, editable, onEdit }: { agent: Agent; editable: boolean; onEdit: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const groups = useScopeGroups(org.id);
  const grants = useAgentScopes(org.id, agent.id);
  const g = agentGrammar(t, agent.name);
  const summary = groups && grants.data ? scopeSummary(groups, grants.data, t("agent.noPermission")) : null;
  return (
    <Card aria-labelledby="sec-perm">
      <div className="row" style={{ alignItems: "flex-start", gap: 12 }}>
        <div className="stack-4" style={{ flex: "1 1 280px", gap: 2 }}>
          <h2 id="sec-perm" className="ac-card__title">
            {t("agent.permissionsTitle", g)}
          </h2>
          {summary && (
            <span className="small muted">
              {summary.connectors > 0
                ? t("agent.permissionsSummary", { ...summary, count: summary.connectors, org: org.name })
                : t("agent.permissionsSummaryBuiltin", { ...summary, org: org.name })}
            </span>
          )}
        </div>
        <div className="row">
          {can(org.role, "manage_agents") && summary?.connectors === 0 && (
            <Button asChild size="sm" variant="ghost">
              <Link to="/org/$orgId/settings" params={{ orgId: org.id }}>
                {t("agent.connectHint")}
              </Link>
            </Button>
          )}
          {editable && summary && (
            <Button size="sm" onClick={onEdit}>
              {t("agent.editPermissions")}
            </Button>
          )}
        </div>
      </div>
      {summary && (
        <div>
          {summary.rows.map((r) => (
            <div key={r.id} className="connector-row">
              <span className="connector-row__name">{r.name}</span>
              <span className="connector-row__granted">{r.granted}</span>
              {r.gated.length > 0 && (
                <AttentionNote>{t("agent.asksApproval", { scopes: r.gated.join(", ") })}</AttentionNote>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function MemorySection({ agent }: { agent: Agent }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const memory = useMemory(org.id, agent.id);
  const proposals = useProposals(org.id);
  const g = agentGrammar(t, agent.name);
  const active = (memory.data ?? []).filter((m) => !m.archived);
  const facts = active.filter((m) => m.kind === "fact" || m.kind === "decision").length;
  const lessons = active.filter((m) => m.kind === "lesson" || m.kind === "preference").length;
  const pending = (proposals.data ?? []).filter((p) => p.agentId === agent.id && p.status === "pending");
  const who = pending[0] ? (pending[0].decider.type === "user" ? pending[0].decider.name : t("roles.adminLower")) : "";
  return (
    <Card
      aria-labelledby="sec-mem"
      className="row"
      style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center" }}
    >
      <div className="stack-4" style={{ flex: "1 1 320px", gap: 2 }}>
        <h2 id="sec-mem" className="ac-card__title">
          {t("agent.memoryTitle", g)}
        </h2>
        <span className="small muted">
          {t("agent.memorySummary", {
            facts: t("agent.memoryFacts", { count: facts }),
            lessons: t("agent.memoryLessons", { count: lessons }),
          })}
          {pending.length > 0 && t("agent.memoryProposals", { count: pending.length, who })}
        </span>
      </div>
      <div className="row">
        <Button asChild size="sm">
          <Link to="/org/$orgId/agents/$agentId/memory" params={{ orgId: org.id, agentId: agent.id }}>
            {t("agent.viewMemory")}
          </Link>
        </Button>
        {pending.length > 0 && (
          <Button asChild size="sm">
            <Link to="/org/$orgId/proposals" params={{ orgId: org.id }} search={{ agent: agent.id }}>
              <Icon name="waiting" size={16} style={{ color: "var(--attention)" }} />
              {t("agent.viewProposal", { count: pending.length })}
            </Link>
          </Button>
        )}
      </div>
    </Card>
  );
}

function RunsDialog({
  open,
  onOpenChange,
  agent,
  totalRuns,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agent: Agent;
  totalRuns: number;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const runs = useRuns(org.id, agent.id, open);
  const channels = useChannels(org.id);
  const [q, setQ] = useState("");
  const g = agentGrammar(t, agent.name);
  const needle = q.trim().toLowerCase();
  const where = (channelId: string) => {
    const name = channels.data?.find((c) => c.id === channelId)?.name;
    return name ? `#${name}` : "";
  };
  const list = runs.data ?? [];
  const shown = list.filter((r) => !needle || `${r.what} ${where(r.channelId)}`.toLowerCase().includes(needle));
  const total = Math.max(totalRuns, list.length);
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t("agent.runsTitle", g)} closeLabel={t("common.close")}>
      <DialogSearchList
        query={q}
        onQueryChange={setQ}
        searchLabel={t("agent.runsSearch")}
        searchPlaceholder={t("agent.runsPlaceholder")}
        isEmpty={runs.isSuccess && shown.length === 0}
        emptyText={list.length === 0 ? t("agent.runsNone") : t("agent.runsEmpty", { q })}
      >
        {shown.map((r) => (
          <div key={r.id} className="run-row">
            <span className="run-row__when">{whenAt(t, i18n.language, r.createdAt)}</span>
            <span className="run-row__what">
              <span>{r.what || t("agent.runNoText")}</span>
              <span className="small muted">
                {[
                  where(r.channelId),
                  t("agent.runTokens", { tokens: formatInt(i18n.language, r.inputTokens + r.outputTokens) }),
                ]
                  .filter(Boolean)
                  .join(" · ")}
                {r.status === "failed" && ` · ${t("agent.runFailed")}`}
                {r.status === "waiting_approval" && ` · ${t("channel.waitingApproval")}`}
              </span>
            </span>
            <span className="small">{formatUsd(t, i18n.language, r.costUsd)}</span>
          </div>
        ))}
      </DialogSearchList>
      <DialogFooter
        bar
        note={t("agent.runsShowing", { shown: shown.length, total, month: formatMonth(i18n.language, new Date()) })}
      />
    </Dialog>
  );
}

function BudgetDialog({
  open,
  onOpenChange,
  agent,
  ownerName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agent: Agent;
  ownerName: string | undefined;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const update = useUpdateAgent(org.id, agent.id);
  const g = agentGrammar(t, agent.name);
  const initial =
    agent.monthlyBudgetUsd === null ? "" : new Intl.NumberFormat(i18n.language).format(agent.monthlyBudgetUsd);
  const [value, setValue] = useState(initial);
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (open) {
      setValue(initial);
      setTouched(false);
    }
  }, [open, initial]);
  const error = touched ? budgetError(t, value) : null;
  const save = () => {
    setTouched(true);
    if (budgetError(t, value)) return;
    update.mutate({ monthlyBudgetUsd: parseAmount(value) }, { onSuccess: () => onOpenChange(false) });
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("agent.budgetDialog")}
      closeLabel={t("common.close")}
      width={440}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <DialogBody>
          <Field
            label={t("agent.monthlyLimit")}
            id="bud-v"
            error={error}
            help={t("agent.budgetHelp", {
              ...g,
              ownerNote: ownerName ? t("agent.budgetOwnerNote", { owner: ownerName }) : "",
            })}
          >
            <Input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button type="submit" variant="primary" disabled={update.isPending}>
            {t("agent.saveLimit")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/**
 * "Editar permissões": the tool tree (`…/agents/{id}/access`). Until the
 * backend has it (404), the older per-scope list.
 */
function PermissionsDialog({
  open,
  onOpenChange,
  agent,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agent: Agent;
}) {
  const { org } = useOrg();
  const access = useAgentAccess(org.id, agent.id, open);
  if (access.isError && (access.error as { status?: number }).status === 404) {
    return <ScopePermissionsDialog open={open} onOpenChange={onOpenChange} agent={agent} />;
  }
  return <AccessDialog open={open} onOpenChange={onOpenChange} agent={agent} access={access.data} />;
}

function AccessDialog({
  open,
  onOpenChange,
  agent,
  access,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agent: Agent;
  access: AgentAccess | undefined;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const save = useSetAgentAccess(org.id);
  const g = agentGrammar(t, agent.name);
  const [model, setModel] = useState<AccessModel | null>(null);
  const tree = useMemo(() => (access ? treeFromAccess(access) : null), [access]);
  // Start from the server's state each time the dialog opens.
  useEffect(() => {
    if (open && access) setModel(modelFrom(access));
    if (!open) setModel(null);
  }, [open, access]);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("agent.permissionsDialog", g)}
      closeLabel={t("common.close")}
      width={640}
    >
      <DialogBody>
        {tree && model ? (
          <AccessTree tree={tree} model={model} onChange={setModel} />
        ) : (
          <p className="small muted">{t("common.loading")}</p>
        )}
      </DialogBody>
      <DialogFooter bar note={t("agent.permFooter")}>
        <Button onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
        <Button
          variant="primary"
          disabled={!model || !tree || save.isPending}
          onClick={() => {
            if (!model || !tree) return;
            save.mutate(
              { agentId: agent.id, input: toInput(model, tree) },
              {
                onSuccess: () => {
                  toast.show(t("access.saved", g));
                  onOpenChange(false);
                },
              },
            );
          }}
        >
          {t("access.save")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function ScopePermissionsDialog({
  open,
  onOpenChange,
  agent,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agent: Agent;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const groups = useScopeGroups(org.id) ?? [];
  const grants = useAgentScopes(org.id, agent.id);
  const set = useSetAgentScopes(org.id, agent.id);
  const [q, setQ] = useState("");
  const g = agentGrammar(t, agent.name);
  const granted = useMemo(
    () => new Set((grants.data ?? []).map((x) => `${x.connectionId ?? ""}|${x.scope}`)),
    [grants.data],
  );
  const shown = searchGroups(groups, q);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("agent.permissionsDialog", g)}
      closeLabel={t("common.close")}
    >
      <DialogSearchList
        query={q}
        onQueryChange={setQ}
        searchLabel={t("agent.permSearch")}
        searchPlaceholder={t("agent.permPlaceholder")}
        isEmpty={shown.length === 0}
        emptyText={t("agent.permEmpty", { q })}
      >
        {shown.map((group) => (
          <div key={group.id} className="scope-group">
            <span className="ac-eyebrow scope-group__label">
              {group.name} · {group.note}
            </span>
            {group.scopes.map((s) => {
              const id = `scope-${s.key.replace(/[^a-zA-Z0-9]/g, "-")}`;
              return (
                <label key={s.key} htmlFor={id} className="scope-row">
                  <Checkbox
                    id={id}
                    checked={granted.has(s.key)}
                    disabled={set.isPending}
                    onCheckedChange={(on) => set.mutate(toggleGrant(grants.data ?? [], s.grant, on))}
                  />
                  <span className="scope-row__text">
                    <span>{s.label}</span>
                    <span className="small muted">{s.description}</span>
                  </span>
                  {s.sensitive && <AttentionNote>{t("agent.asksApprovalShort")}</AttentionNote>}
                </label>
              );
            })}
          </div>
        ))}
      </DialogSearchList>
      <DialogFooter bar note={t("agent.permFooter")}>
        <Button variant="primary" onClick={() => onOpenChange(false)}>
          {t("agent.done")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
