import {
  AttentionNote,
  Avatar,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogSearchList,
  EmptyState,
  Field,
  Input,
  Menu,
  MenuItem,
  Meter,
  Select,
  Textarea,
} from "@agenteschat/ui";
import { Link, useNavigate } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useAgentAccess,
  useAgentDetail,
  useAgentScopes,
  useAgentSkills,
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
import { AudienceChip, AudienceRow } from "@/components/AgentAudience";
import { AgentComputerRow } from "@/components/AgentComputer";
import { EditDialog } from "@/components/EditDialog";
import { LoadingLine, LoadingPage } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { ManageSkillsDialog } from "@/components/Skills";
import { useAreaLabel } from "@/hooks/useAreaLabel";
import { useDirectory } from "@/hooks/useDirectory";
import { useScopeGroups } from "@/hooks/useScopeGroups";
import { type AccessModel, countTools, modelFrom, resolve, toInput, treeFromAccess } from "@/lib/access";
import { formatInt, formatMonth, formatTokensShort, formatUsd, joinNames, whenAt } from "@/lib/format";
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
  if (dir.loading) {
    return (
      <div className="page page--mid">
        <LoadingPage rows={6} />
      </div>
    );
  }
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
  const settings = useSettings(org.id);
  const access = useAgentAccess(org.id, agent.id);
  const skills = useAgentSkills(org.id, agent.id);
  const memory = useMemory(org.id, agent.id);
  const proposals = useProposals(org.id);
  const editable = can(org.role, "manage_agents");
  const g = agentGrammar(t, agent.name);
  const owner = agent.ownerUserId ? dir.memberById.get(agent.ownerUserId) : undefined;
  const modelLabel = models.data?.models.find((m) => m.id === agent.model)?.label ?? agent.model;
  // "Abrir no #canal": the first of the agent's channels you're in.
  const home = detail.data?.channels
    .map((ac) => channels.data?.find((c) => c.id === ac.id && c.isMember))
    .find((c) => c !== undefined);
  const month = formatMonth(i18n.language, new Date());
  const [dialog, setDialog] = useState<
    null | "runs" | "budget" | "perms" | "instructions" | "knowledge" | "model" | "owner" | "skills"
  >(null);
  const close = () => setDialog(null);
  const navigate = useNavigate();

  const spent = detail.data?.spentThisMonthUsd ?? 0;
  const tokens = detail.data?.tokensThisMonth ?? 0;
  const runs = detail.data?.runsThisMonth ?? 0;
  const credentialId = detail.data?.credentialId ?? null;
  const keyLabel =
    credentialId && credentialId !== settings.data?.defaultCredentialId
      ? t("agent.ownKey")
      : agent.hasCredential
        ? t("agent.withOrgKey", { org: org.name })
        : t("agent.withPlatformKey");
  const tools = access.data ? countTools(resolve(treeFromAccess(access.data), modelFrom(access.data))) : null;
  const enabledSkills = (skills.data ?? []).filter((x) => x.enabled);
  const active = (memory.data ?? []).filter((m) => !m.archived);
  const facts = active.filter((m) => m.kind === "fact" || m.kind === "decision").length;
  const lessons = active.filter((m) => m.kind === "lesson" || m.kind === "preference").length;
  const pending = (proposals.data ?? []).filter((p) => p.agentId === agent.id && p.status === "pending");
  const who = pending[0] ? (pending[0].decider.type === "user" ? pending[0].decider.name : t("roles.adminLower")) : "";
  const edit = (section: string, open: typeof dialog) =>
    editable ? (
      <Button size="sm" aria-label={t("agent.editSection", { section })} onClick={() => setDialog(open)}>
        {t("agent.edit")}
      </Button>
    ) : null;

  return (
    <div className="page page--mid agent-page">
      <header className="agent-head">
        <Avatar kind="agent" size="lg" name={agent.name} initials={dir.agentInitials(agent.id)} />
        <div className="agent-head__text">
          <h1 className="page-title">{agent.name}</h1>
          <span className="agent-head__meta">
            {agent.role && <span>{agent.role}</span>}
            <Chip icon="agent">{modelLabel}</Chip>
            <AudienceChip agent={agent} />
            <span className="muted">{owner ? t("agent.ownerLine", { name: owner.name }) : t("agent.noOwnerLine")}</span>
          </span>
        </div>
        <div className="row agent-head__actions">
          <Button asChild variant="primary">
            <Link to="/org/$orgId/dm/agent/$agentId" params={{ orgId: org.id, agentId: agent.id }}>
              {t("agent.chat")}
            </Link>
          </Button>
          <Menu
            align="end"
            label={t("agent.moreActions")}
            trigger={<Button variant="ghost" iconOnly icon="more" aria-label={t("agent.moreActions")} />}
          >
            {home && (
              <MenuItem
                icon="channel"
                onSelect={() =>
                  void navigate({ to: "/org/$orgId/c/$channelId", params: { orgId: org.id, channelId: home.id } })
                }
              >
                {t("agent.openIn", { channel: home.name })}
              </MenuItem>
            )}
            <MenuItem icon="waiting" onSelect={() => setDialog("runs")}>
              {t("agent.viewRuns")}
            </MenuItem>
            <MenuItem
              icon="info"
              onSelect={() =>
                void navigate({
                  to: "/org/$orgId/agents/$agentId/memory",
                  params: { orgId: org.id, agentId: agent.id },
                })
              }
            >
              {t("agent.viewMemory")}
            </MenuItem>
          </Menu>
        </div>
      </header>
      {!editable && <p className="page__note">{t("agent.readOnly", g)}</p>}

      <div className="summary-list">
        <SummaryRow
          id="sec-instr"
          title={t("agent.howWorks", g)}
          action={edit(t("agent.instructions"), "instructions")}
        >
          {agent.instructions.trim() ? (
            <p className="summary-row__preview">{agent.instructions}</p>
          ) : (
            <p className="muted">{t("agent.noInstructions", g)}</p>
          )}
          <span className="small muted">{t("agent.instructionsHelp", { org: org.name })}</span>
        </SummaryRow>

        <SummaryRow id="sec-mem" title={t("agent.memoryTitle", g)} action={edit(t("agent.knowledge"), "knowledge")}>
          {memory.isLoading ? (
            <LoadingLine width={260} />
          ) : (
            <span>
              {t("agent.memorySummary", {
                facts: t("agent.memoryFacts", { count: facts }),
                lessons: t("agent.memoryLessons", { count: lessons }),
              })}
              {pending.length > 0 && t("agent.memoryProposals", { count: pending.length, who })}
            </span>
          )}
        </SummaryRow>

        <SummaryRow id="sec-model" title={t("agent.modelAndKey")} action={edit(t("agent.modelAndKey"), "model")}>
          <span>
            {modelLabel} · {keyLabel}
          </span>
        </SummaryRow>

        <SummaryRow id="sec-owner" title={t("newAgent.owner")} action={edit(t("newAgent.owner"), "owner")}>
          <span>{owner ? owner.name : t("newAgent.noOwnerOption")}</span>
          <span className="small muted">{owner ? t("newAgent.ownerHelp") : t("newAgent.noOwnerHelp")}</span>
        </SummaryRow>

        <AudienceRow agent={agent} />

        <SummaryRow
          id="sec-perm"
          title={t("agent.permissionsTitle", g)}
          action={
            editable ? (
              <Button size="sm" aria-label={t("agent.editPermissions")} onClick={() => setDialog("perms")}>
                {t("agent.edit")}
              </Button>
            ) : null
          }
        >
          {access.isLoading ? (
            <LoadingLine width={160} />
          ) : tools ? (
            <span>
              {access.data?.all
                ? t("agent.toolsAll", { on: tools.on, total: tools.total })
                : t("agent.toolsCount", { on: tools.on, total: tools.total })}
            </span>
          ) : (
            <ScopeSummary agent={agent} />
          )}
        </SummaryRow>

        <SummaryRow id="sec-skills" title={t("skills.agentTitle")} action={edit(t("skills.agentTitle"), "skills")}>
          {skills.isLoading ? (
            <LoadingLine width={200} />
          ) : skills.isError ? (
            <span className="muted">{t("skills.unavailable")}</span>
          ) : enabledSkills.length > 0 ? (
            <span>
              {t("agent.skillsCount", { count: enabledSkills.length })}:{" "}
              {joinNames(
                enabledSkills.map((x) => x.name),
                t("newAgent.and"),
              )}
            </span>
          ) : (
            <span className="muted">{t("skills.agentEmpty", { name: agent.name })}</span>
          )}
        </SummaryRow>

        <AgentComputerRow agent={agent} editable={editable} />

        <SummaryRow
          id="sec-budget"
          title={t("agent.budgetTitle", { month })}
          action={
            <div className="row" style={{ gap: 4 }}>
              <Button size="sm" variant="ghost" onClick={() => setDialog("runs")}>
                {t("agent.viewRuns")}
              </Button>
              {editable && (
                <Button size="sm" onClick={() => setDialog("budget")}>
                  {t("agent.adjustBudget")}
                </Button>
              )}
            </div>
          }
        >
          {detail.isLoading ? (
            <LoadingLine width={220} />
          ) : detail.isError ? (
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
        </SummaryRow>
      </div>

      <InstructionsDialog open={dialog === "instructions"} onClose={close} agent={agent} />
      <KnowledgeDialog open={dialog === "knowledge"} onClose={close} agent={agent} />
      <ModelKeyDialog open={dialog === "model"} onClose={close} agent={agent} />
      <OwnerDialog open={dialog === "owner"} onClose={close} agent={agent} />
      <ManageSkillsDialog agentId={agent.id} agentName={agent.name} open={dialog === "skills"} onClose={close} />
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

/** A section of the profile: title, a read-only summary, and one action. */
function SummaryRow({
  id,
  title,
  action,
  children,
}: {
  id: string;
  title: string;
  action: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="summary-row">
      <div className="summary-row__text">
        <h2 id={id} className="summary-row__title">
          {title}
        </h2>
        <div className="summary-row__body">{children}</div>
      </div>
      {action && <div className="summary-row__action">{action}</div>}
    </section>
  );
}

/** Before the access API: what is granted per scope group. */
function ScopeSummary({ agent }: { agent: Agent }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const groups = useScopeGroups(org.id);
  const grants = useAgentScopes(org.id, agent.id);
  const summary = groups && grants.data ? scopeSummary(groups, grants.data, t("agent.noPermission")) : null;
  if (!summary) return null;
  return (
    <span>
      {summary.connectors > 0
        ? t("agent.permissionsSummary", { ...summary, count: summary.connectors, org: org.name })
        : t("agent.permissionsSummaryBuiltin", { ...summary, org: org.name })}
    </span>
  );
}

function InstructionsDialog({ open, onClose, agent }: { open: boolean; onClose: () => void; agent: Agent }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const update = useUpdateAgent(org.id, agent.id);
  const g = agentGrammar(t, agent.name);
  const [text, setText] = useState(agent.instructions);
  useEffect(() => {
    if (open) setText(agent.instructions);
  }, [open, agent.instructions]);
  return (
    <EditDialog
      open={open}
      onClose={onClose}
      title={t("agent.howWorks", g)}
      description={t("agent.instructionsHelp", { org: org.name })}
      dirty={text !== agent.instructions}
      saving={update.isPending}
      width={760}
      onSave={() =>
        update.mutate(
          { instructions: text },
          {
            onSuccess: () => {
              toast.show(t("agent.savedToast", g));
              onClose();
            },
          },
        )
      }
    >
      <Field label={t("agent.instructions")} id="instr">
        <Textarea rows={16} value={text} onChange={(e) => setText(e.target.value)} />
      </Field>
    </EditDialog>
  );
}

function ModelKeyDialog({ open, onClose, agent }: { open: boolean; onClose: () => void; agent: Agent }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const update = useUpdateAgent(org.id, agent.id);
  const detail = useAgentDetail(org.id, agent.id);
  const models = useModels();
  const credentials = useCredentials(org.id, can(org.role, "manage_credentials"));
  const settings = useSettings(org.id);
  const platform = usePlatformKey(org.id);
  const g = agentGrammar(t, agent.name);
  const savedKey = (() => {
    const id = detail.data?.credentialId ?? null;
    return id && id !== settings.data?.defaultCredentialId ? id : DEFAULT_KEY;
  })();
  const [model, setModel] = useState(agent.model);
  const [key, setKey] = useState(savedKey);
  useEffect(() => {
    if (!open) return;
    setModel(agent.model);
    setKey(savedKey);
  }, [open, agent.model, savedKey]);
  const dirty = model !== agent.model || key !== savedKey;
  return (
    <EditDialog
      open={open}
      onClose={onClose}
      title={t("agent.modelAndKey")}
      dirty={dirty}
      saving={update.isPending}
      onSave={() => {
        const patch: { model?: string; credentialId?: string | null } = {};
        if (model !== agent.model) patch.model = model;
        if (key !== savedKey) patch.credentialId = key === DEFAULT_KEY ? null : key;
        update.mutate(patch, {
          onSuccess: () => {
            toast.show(t("agent.savedToast", g));
            onClose();
          },
        });
      }}
    >
      <Field label={t("newAgent.model")} id={`model-${agent.id}`}>
        <Select
          value={model}
          onValueChange={setModel}
          options={modelOptions(
            t,
            i18n.language,
            models.data?.models ?? [],
            credentials.data ?? [],
            platform.data ?? false,
          )}
        />
      </Field>
      <Field label={t("newAgent.key")} id={`key-${agent.id}`}>
        <Select
          value={key}
          onValueChange={setKey}
          options={keyOptions(t, credentials.data ?? [], settings.data?.defaultCredentialId ?? null)}
        />
      </Field>
    </EditDialog>
  );
}

/** "Responsável": a member or "Sem responsável" (admins then get alerts and approve). */
function OwnerDialog({ open, onClose, agent }: { open: boolean; onClose: () => void; agent: Agent }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const dir = useDirectory(org.id);
  const update = useUpdateAgent(org.id, agent.id);
  const g = agentGrammar(t, agent.name);
  const saved = agent.ownerUserId ?? NO_OWNER;
  const [value, setValue] = useState(saved);
  useEffect(() => {
    if (open) setValue(saved);
  }, [open, saved]);
  const options = [
    ...dir.members.map((m) => ({ value: m.userId, label: m.name, description: t(`roles.${m.role}`) })),
    { value: NO_OWNER, label: t("newAgent.noOwnerOption") },
  ];
  return (
    <EditDialog
      open={open}
      onClose={onClose}
      title={t("newAgent.owner")}
      dirty={value !== saved}
      saving={update.isPending}
      width={480}
      onSave={() =>
        update.mutate(
          { ownerUserId: value === NO_OWNER ? null : value },
          {
            onSuccess: () => {
              toast.show(t("agent.savedToast", g));
              onClose();
            },
          },
        )
      }
    >
      <Field
        label={t("newAgent.owner")}
        id={`owner-${agent.id}`}
        help={value === NO_OWNER ? t("newAgent.noOwnerHelp") : t("newAgent.ownerHelp")}
      >
        <Select value={value} onValueChange={setValue} options={options} />
      </Field>
    </EditDialog>
  );
}

/** "Conhecimento": what the agent knows, with search; editing happens on the memory page. */
function KnowledgeDialog({ open, onClose, agent }: { open: boolean; onClose: () => void; agent: Agent }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const memory = useMemory(org.id, agent.id);
  const proposals = useProposals(org.id);
  const g = agentGrammar(t, agent.name);
  const [q, setQ] = useState("");
  const items = (memory.data ?? []).filter((m) => !m.archived);
  const shown = q.trim() ? items.filter((m) => m.text.toLowerCase().includes(q.trim().toLowerCase())) : items;
  const pending = (proposals.data ?? []).filter((p) => p.agentId === agent.id && p.status === "pending");
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t("agent.memoryTitle", g)}
      closeLabel={t("common.close")}
    >
      <DialogSearchList
        query={q}
        onQueryChange={setQ}
        searchLabel={t("agent.knowledgeSearch")}
        searchPlaceholder={t("agent.knowledgeSearch")}
        isEmpty={shown.length === 0}
        emptyText={items.length === 0 ? t("agent.knowledgeEmpty", g) : t("agent.knowledgeNoResults", { q })}
      >
        {shown.map((m) => (
          <div key={m.id} className="ac-list__row">
            <span className="list-col">
              <span>{m.text}</span>
              <span className="small muted">
                {t(`memory.kinds.${m.kind}`)} · {m.source}
              </span>
            </span>
          </div>
        ))}
      </DialogSearchList>
      <DialogFooter bar>
        {pending.length > 0 && (
          <Button asChild>
            <Link to="/org/$orgId/proposals" params={{ orgId: org.id }} search={{ agent: agent.id }}>
              {t("agent.viewProposal", { count: pending.length })}
            </Link>
          </Button>
        )}
        <Button asChild variant="primary">
          <Link to="/org/$orgId/agents/$agentId/memory" params={{ orgId: org.id, agentId: agent.id }}>
            {t("agent.editMemory")}
          </Link>
        </Button>
      </DialogFooter>
    </Dialog>
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
          <Button type="submit" variant="primary" disabled={update.isPending} loading={update.isPending}>
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
export function PermissionsDialog({
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
  const areaLabel = useAreaLabel();
  const tree = useMemo(() => (access ? treeFromAccess(access, areaLabel) : null), [access, areaLabel]);
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
          loading={save.isPending}
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
