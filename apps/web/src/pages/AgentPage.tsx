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
  Textarea,
} from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { useEffect, useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import {
  useAgentChannels,
  useChannels,
  useMemory,
  useModels,
  usePermissions,
  useProposals,
  useRuns,
  useSetPermissions,
  useUpdateAgent,
  useUsage,
} from "@/api/queries";
import type { Agent, AgentPermissions } from "@/api/types";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { formatInt, formatMonth, formatTokensShort, formatUsd, whenAt } from "@/lib/format";
import { agentGrammar } from "@/lib/grammar";
import { can } from "@/lib/permissions";
import { parseAmount } from "@/lib/text";

/** "ler código e issues, abrir e comentar PRs" per connector, plus the approval-gated scopes. */
export function permissionRows(perms: AgentPermissions, none: string) {
  const granted = new Set(perms.granted);
  return perms.connectors.map((c) => {
    const on = c.scopes.filter((s) => !s.requiresApproval && granted.has(s.id)).map((s) => s.label.toLowerCase());
    const gated = c.scopes.filter((s) => s.requiresApproval).map((s) => s.label.toLowerCase());
    return { id: c.id, name: c.name, granted: on.length ? on.join(", ") : none, gated };
  });
}

export function permissionCounts(perms: AgentPermissions) {
  const granted = new Set(perms.granted);
  const all = perms.connectors.flatMap((c) => c.scopes);
  return { total: all.length, granted: all.filter((s) => s.requiresApproval || granted.has(s.id)).length };
}

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
  const usage = useUsage(org.id);
  const channels = useChannels(org.id);
  const update = useUpdateAgent(org.id, agent.id);
  const editable = can(org.role, "manage_agents");
  const g = agentGrammar(t, agent.name);
  const owner = agent.ownerUserId ? dir.memberById.get(agent.ownerUserId) : undefined;
  const modelLabel = models.data?.models.find((m) => m.id === agent.model)?.label ?? agent.model;
  const mine = channels.data?.filter((c) => c.isMember) ?? [];
  const memberships = useAgentChannels(
    org.id,
    mine.map((c) => c.id),
  );
  const home = mine.find((_c, i) => memberships[i]?.data?.some((m) => m.type === "agent" && m.id === agent.id));
  const month = formatMonth(i18n.language, new Date());

  const [instructions, setInstructions] = useState(agent.instructions);
  const [saved, setSaved] = useState(false);
  const [dialog, setDialog] = useState<null | "runs" | "budget" | "perms">(null);
  useEffect(() => setInstructions(agent.instructions), [agent.instructions]);

  const u = usage.data?.find((x) => x.agentId === agent.id);
  const spent = u?.costUsd ?? 0;
  const tokens = (u?.inputTokens ?? 0) + (u?.outputTokens ?? 0);
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
        </Card>

        <Card aria-labelledby="sec-budget">
          <h2 id="sec-budget" className="ac-card__title">
            {t("agent.budgetTitle", { month })}
          </h2>
          {usage.data === null ? (
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
                      runs: t("agent.runsCount", { count: u?.calls ?? 0 }),
                      tokens: t("agent.tokensCount", { tokens: formatTokensShort(t, i18n.language, tokens) }),
                      owner: t("agent.toOwner", { owner: owner.name, to: agentGrammar(t, owner.name).to }),
                    })
                  : t("agent.budgetStatsNoOwner", {
                      runs: t("agent.runsCount", { count: u?.calls ?? 0 }),
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
        totalCalls={u?.calls}
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

function PermissionsSection({ agent, editable, onEdit }: { agent: Agent; editable: boolean; onEdit: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const perms = usePermissions(org.id, agent.id);
  const g = agentGrammar(t, agent.name);
  const rows = perms.data ? permissionRows(perms.data, t("agent.noPermission")) : [];
  const counts = perms.data ? permissionCounts(perms.data) : { total: 0, granted: 0 };
  const connectors = perms.data?.connectors.length ?? 0;
  return (
    <Card aria-labelledby="sec-perm">
      <div className="row" style={{ alignItems: "flex-start", gap: 12 }}>
        <div className="stack-4" style={{ flex: "1 1 280px", gap: 2 }}>
          <h2 id="sec-perm" className="ac-card__title">
            {t("agent.permissionsTitle", g)}
          </h2>
          <span className="small muted">
            {connectors > 0
              ? t("agent.permissionsSummary", { ...counts, connectors, org: org.name })
              : t("agent.permissionsNone", { org: org.name })}
          </span>
        </div>
        {editable && connectors > 0 && (
          <Button size="sm" onClick={onEdit}>
            {t("agent.editPermissions")}
          </Button>
        )}
      </div>
      {rows.length > 0 && (
        <div>
          {rows.map((r) => (
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
  totalCalls,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agent: Agent;
  totalCalls: number | undefined;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const runs = useRuns(org.id, agent.id, open);
  const [q, setQ] = useState("");
  const g = agentGrammar(t, agent.name);
  const needle = q.trim().toLowerCase();
  const list = runs.data?.runs ?? [];
  const shown = list.filter((r) => !needle || `${r.summary} ${r.where}`.toLowerCase().includes(needle));
  const total = Math.max(totalCalls ?? 0, runs.data?.total ?? 0);
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t("agent.runsTitle", g)} closeLabel={t("common.close")}>
      <DialogSearchList
        query={q}
        onQueryChange={setQ}
        searchLabel={t("agent.runsSearch")}
        searchPlaceholder={t("agent.runsPlaceholder")}
        isEmpty={shown.length === 0}
        emptyText={list.length === 0 ? t("agent.runsNone") : t("agent.runsEmpty", { q })}
      >
        {shown.map((r) => (
          <div key={r.id} className="run-row">
            <span className="run-row__when">{whenAt(t, i18n.language, r.at)}</span>
            <span className="run-row__what">
              <span>{r.summary}</span>
              <span className="small muted">
                {r.where} · {t("agent.runTokens", { tokens: formatInt(i18n.language, r.tokens) })}
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

function PermissionsDialog({
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
  const perms = usePermissions(org.id, agent.id);
  const set = useSetPermissions(org.id, agent.id);
  const [q, setQ] = useState("");
  const g = agentGrammar(t, agent.name);
  const granted = useMemo(() => new Set(perms.data?.granted ?? []), [perms.data]);
  const needle = q.trim().toLowerCase();
  const groups = (perms.data?.connectors ?? [])
    .map((c) => ({
      ...c,
      scopes: c.scopes.filter((s) => !needle || `${c.name} ${s.label} ${s.description}`.toLowerCase().includes(needle)),
    }))
    .filter((c) => c.scopes.length > 0);
  const toggle = (scopeId: string, on: boolean) => {
    const next = new Set(granted);
    if (on) next.add(scopeId);
    else next.delete(scopeId);
    set.mutate([...next]);
  };
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
        isEmpty={groups.length === 0}
        emptyText={t("agent.permEmpty", { q })}
      >
        {groups.map((c) => (
          <div key={c.id} className="scope-group">
            <span className="ac-eyebrow scope-group__label">
              {c.name} · {c.note}
            </span>
            {c.scopes.map((s) => {
              const id = `scope-${c.id}-${s.id}`;
              return (
                <label key={s.id} htmlFor={id} className="scope-row">
                  <Checkbox
                    id={id}
                    checked={s.requiresApproval ? true : granted.has(s.id)}
                    disabled={s.requiresApproval}
                    onCheckedChange={(on) => toggle(s.id, on)}
                  />
                  <span className="scope-row__text">
                    <span>{s.label}</span>
                    <span className="small muted">{s.description}</span>
                  </span>
                  {s.requiresApproval && <AttentionNote>{t("agent.asksApprovalShort")}</AttentionNote>}
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
